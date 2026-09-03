import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claimGatewayWork, completeGatewayRun, gatewayRuntimeFindings, loadGatewayRuntime,
  reconcileGateway
} from "../src/lib/gateway-runtime.js";
import { writeGatewayJson } from "../src/lib/gateway-premortem.js";
import { withOwnedFileLock } from "../src/lib/owned-file-lock.js";
import {
  inspectGatewayStateTransaction, withGatewayStateLock, withGatewayStateTestHook,
  writeGatewayStateJson, writeGatewayStatePair
} from "../src/lib/gateway-state-transaction.js";
import { assignPremortemPlan, premortemGoalFixture } from "./goal-premortem-fixture.js";

function controlHistory(policy, at) {
  return {
    kind: "control",
    at,
    value: { enabled: policy.enabled, killSwitch: policy.killSwitch },
    authority: "authenticated-goal-policy"
  };
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resealTransaction(transaction) {
  const material = { schema: transaction.schema, transactionId: transaction.transactionId,
    projectRootDigest: transaction.projectRootDigest, before: transaction.before, after: transaction.after,
    stages: transaction.stages, authority: transaction.authority };
  return { ...material, digest: digest(canonical(material)) };
}

async function preparedGoal(t, suffix) {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, `goal:gateway-transaction-${suffix}`);
  const claim = await claimGatewayWork({
    root,
    workerId: `worker:gateway-transaction-${suffix}`,
    executionMode: "read-only",
    now: "2032-02-01T00:00:02.000Z"
  });
  assert.ok(claim.item);
  return { root, claim, paths: await loadGatewayRuntime(root) };
}

test("a gateway writer that loses lock ownership cannot mutate state or unlink its successor", async (t) => {
  const { root } = await premortemGoalFixture(t);
  const loaded = await loadGatewayRuntime(root);
  const before = await readFile(loaded.gatewayPolicyPath, "utf8");
  const successorToken = randomUUID();
  const lockPath = join(loaded.directory, "gateway-runtime.lock");
  const stalePolicy = structuredClone(loaded.policy);
  stalePolicy.killSwitch = true;
  stalePolicy.history.push(controlHistory(stalePolicy, "2032-02-01T00:00:01.000Z"));
  stalePolicy.revision += 1;

  await assert.rejects(withGatewayStateLock(loaded, async () => {
    await unlink(lockPath);
    await writeFile(lockPath, `${JSON.stringify({
      schema: "agentspine.owned-file-lock/v1",
      token: successorToken,
      acquiredAt: "2032-02-01T00:00:01.100Z",
      leaseMs: 120000,
      authority: "state-coordination-only"
    })}\n`, { mode: 0o600 });
    await writeGatewayStateJson(loaded.gatewayPolicyPath, stalePolicy);
  }), /ownership was lost/i);

  assert.equal(await readFile(loaded.gatewayPolicyPath, "utf8"), before);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, successorToken);
  await unlink(lockPath);
  assert.equal((await loadGatewayRuntime(root)).policy.killSwitch, false);
});

test("expected-base CAS rejects a lock-bypassing concurrent gateway policy write", async (t) => {
  const { root } = await premortemGoalFixture(t);
  const loaded = await loadGatewayRuntime(root);
  const stalePolicy = structuredClone(loaded.policy);
  stalePolicy.enabled = false;
  stalePolicy.history.push(controlHistory(stalePolicy, "2032-02-01T00:00:01.000Z"));
  stalePolicy.revision += 1;
  const newerPolicy = structuredClone(loaded.policy);
  newerPolicy.killSwitch = true;
  newerPolicy.history.push(controlHistory(newerPolicy, "2032-02-01T00:00:01.100Z"));
  newerPolicy.revision += 1;

  await assert.rejects(withGatewayStateLock(loaded, async () => {
    await writeGatewayJson(loaded.gatewayPolicyPath, newerPolicy);
    await writeGatewayStateJson(loaded.gatewayPolicyPath, stalePolicy);
  }), /predecessor changed/i);

  const current = await loadGatewayRuntime(root);
  assert.equal(current.policy.killSwitch, true);
  assert.equal(current.policy.enabled, true);
});

test("atomic replacement rechecks ownership after predecessor verification", async (t) => {
  const { root } = await premortemGoalFixture(t);
  await reconcileGateway({ root, now: "2032-02-01T00:00:01.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const before = await readFile(loaded.gatewayRuntimePath, "utf8");
  const next = structuredClone(loaded.runtime);
  next.revision += 1;
  const lockPath = join(loaded.directory, "gateway-runtime.lock");
  const successorToken = randomUUID();
  let ownershipChecks = 0;

  await assert.rejects(withOwnedFileLock(lockPath, async ({ assertOwned }) => {
    await writeGatewayJson(loaded.gatewayRuntimePath, next, {
      expectedDigest: createHash("sha256").update(before).digest("hex"),
      assertOwned: async () => {
        ownershipChecks += 1;
        if (ownershipChecks === 2) {
          await unlink(lockPath);
          await writeFile(lockPath, `${JSON.stringify({
            schema: "agentspine.owned-file-lock/v1", token: successorToken,
            acquiredAt: "2032-02-01T00:00:01.100Z", leaseMs: 120000,
            authority: "state-coordination-only"
          })}\n`, { mode: 0o600 });
        }
        await assertOwned();
      }
    });
  }), /ownership was lost/i);

  assert.equal(ownershipChecks, 2);
  assert.equal(await readFile(loaded.gatewayRuntimePath, "utf8"), before);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, successorToken);
  await unlink(lockPath);
});

test("transaction journal replacement rechecks ownership after predecessor verification", async (t) => {
  const { root, claim, paths } = await preparedGoal(t, "journal-ownership-fence");
  const beforePolicy = await readFile(paths.gatewayPolicyPath, "utf8");
  const beforeRuntime = await readFile(paths.gatewayRuntimePath, "utf8");
  const lockPath = join(paths.directory, "gateway-runtime.lock");
  const successorToken = randomUUID();
  let fenced = false;
  const testHook = async (phase) => {
    if (phase !== "after-journal-predecessor-check" || fenced) return;
    fenced = true;
    await unlink(lockPath);
    await writeFile(lockPath, `${JSON.stringify({
      schema: "agentspine.owned-file-lock/v1", token: successorToken,
      acquiredAt: "2032-02-01T00:00:02.100Z", leaseMs: 120000,
      authority: "state-coordination-only"
    })}\n`, { mode: 0o600 });
  };

  await assert.rejects(withGatewayStateTestHook(testHook, () => completeGatewayRun({
    root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { completed: true, readOnly: true }, now: "2032-02-01T00:00:03.000Z"
  })), /ownership was lost/i);
  assert.equal(fenced, true);
  assert.equal(await readFile(paths.gatewayPolicyPath, "utf8"), beforePolicy);
  assert.equal(await readFile(paths.gatewayRuntimePath, "utf8"), beforeRuntime);
  assert.equal((await inspectGatewayStateTransaction(paths)).status, "none");
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, successorToken);
  await unlink(lockPath);
});

test("new gateway pairs require semantic validation before journaling", async (t) => {
  const { root } = await premortemGoalFixture(t);
  await reconcileGateway({ root, now: "2032-02-01T00:00:01.000Z" });
  const paths = await loadGatewayRuntime(root);
  const beforePolicy = await readFile(paths.gatewayPolicyPath, "utf8");
  const beforeRuntime = await readFile(paths.gatewayRuntimePath, "utf8");
  const invalidRuntime = structuredClone(paths.runtime);
  invalidRuntime.health.gateway = "forged";

  await assert.rejects(withGatewayStateLock(paths, () =>
    writeGatewayStatePair(paths.policy, invalidRuntime), {
    validatePair: (_policy, runtime) => {
      if (runtime.health.gateway === "forged") throw new Error("synthetic semantic rejection");
    }
  }), /synthetic semantic rejection/i);
  assert.equal((await inspectGatewayStateTransaction(paths)).status, "none");
  assert.equal(await readFile(paths.gatewayPolicyPath, "utf8"), beforePolicy);
  assert.equal(await readFile(paths.gatewayRuntimePath, "utf8"), beforeRuntime);
});

test("a leased lane must bind the exact queue lease generation", async (t) => {
  const { root, paths } = await preparedGoal(t, "lane-generation-binding");
  const runtime = structuredClone(paths.runtime);
  runtime.lanes[0].claimedAt = "2032-02-01T00:00:01.000Z";
  runtime.lanes[0].expiresAt = "2032-02-01T00:02:01.000Z";
  await withGatewayStateLock(paths, () => writeGatewayStateJson(paths.gatewayRuntimePath, runtime));
  await assert.rejects(loadGatewayRuntime(root), /lane-lease-binding/);
});

for (const corruption of [
  { name: "policy", key: "policy", expected: /gateway policy.*invalid/i,
    mutate: (value) => { value.goals[0].status = "forged"; } },
  { name: "queue", key: "runtime", expected: /gateway runtime.*invalid/i,
    mutate: (value) => { value.queue[0].attempts = -1; } },
  { name: "cross-pair queue binding", key: "runtime",
    expected: /orphan-goal-step/i,
    mutate: (value) => { value.queue[0].goalStepId = "step:forged"; } }
]) {
  test(`recovery rejects a fully resealed semantically invalid ${corruption.name} stage`, async (t) => {
    const suffix = corruption.name.replaceAll(" ", "-");
    const { root, claim, paths } = await preparedGoal(t, `invalid-${suffix}-stage`);
    const beforePolicy = await readFile(paths.gatewayPolicyPath, "utf8");
    const beforeRuntime = await readFile(paths.gatewayRuntimePath, "utf8");
    await assert.rejects(withGatewayStateTestHook((phase) => {
      if (phase === "after-prepare") throw new Error("synthetic prepared transaction");
    }, () => completeGatewayRun({
      root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
      result: { completed: true, readOnly: true }, now: "2032-02-01T00:00:03.000Z"
    })), /synthetic prepared transaction/i);

    const journalPath = join(paths.directory, "gateway-state-transaction.json");
    let transaction = JSON.parse(await readFile(journalPath, "utf8"));
    const stagePath = join(paths.directory, transaction.stages[corruption.key]);
    const stage = JSON.parse(await readFile(stagePath, "utf8"));
    corruption.mutate(stage);
    const content = `${JSON.stringify(stage, null, 2)}\n`;
    await writeFile(stagePath, content);
    transaction.after[corruption.key] = digest(content);
    transaction = resealTransaction(transaction);
    await writeFile(journalPath, `${JSON.stringify(transaction, null, 2)}\n`);
    assert.equal((await inspectGatewayStateTransaction(paths)).status, "prepared");

    await assert.rejects(loadGatewayRuntime(root), corruption.expected);
    assert.equal(await readFile(paths.gatewayPolicyPath, "utf8"), beforePolicy);
    assert.equal(await readFile(paths.gatewayRuntimePath, "utf8"), beforeRuntime);
    assert.equal((await inspectGatewayStateTransaction(paths)).status, "prepared");
  });
}

for (const scenario of [
  { name: "policy-first interruption", phase: "after-policy-install" },
  { name: "pair-installed interruption", phase: "after-runtime-install" },
  { name: "runtime-first interruption", phase: "after-prepare", runtimeFirst: true }
]) {
  test(`restart rolls ${scenario.name} forward without duplicating completed work`, async (t) => {
    const { root, claim, paths } = await preparedGoal(t, scenario.phase);
    const sourceBefore = await readFile(join(root, "AGENTS.md"), "utf8");
    let injected = false;
    const testHook = async (phase, details) => {
      if (phase !== scenario.phase || injected) return;
      injected = true;
      if (scenario.runtimeFirst) {
        const runtimeStagePath = join(details.paths.directory,
          `gateway-pair-${details.transactionId}-runtime.next.json`);
        const runtime = JSON.parse(await readFile(runtimeStagePath, "utf8"));
        await writeGatewayJson(details.paths.gatewayRuntimePath, runtime);
      }
      throw new Error(`synthetic crash ${scenario.name}`);
    };

    await assert.rejects(withGatewayStateTestHook(testHook, () => completeGatewayRun({
      root,
      queueId: claim.item.queueId,
      workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
      result: { completed: true, readOnly: true, checkpoint: { effectReceipt: "synthetic:effect:one" } },
      now: "2032-02-01T00:00:03.000Z"
    })), /synthetic crash/i);
    assert.equal(injected, true);

    assert.equal((await inspectGatewayStateTransaction(paths)).status, "prepared");
    let recovered = await loadGatewayRuntime(root);
    assert.equal((await inspectGatewayStateTransaction(recovered)).status, "none");
    assert.equal(recovered.policy.goals[0].status, "completed");
    assert.equal(recovered.policy.goals[0].plan.steps[0].status, "completed");
    const goalItems = recovered.runtime.queue.filter((item) => item.goalId === claim.item.goalId);
    assert.equal(goalItems.length, 1);
    assert.equal(goalItems[0].status, "completed");
    assert.equal(goalItems[0].lease, null);
    assert.equal(recovered.runtime.lanes.filter((lane) => lane.queueId === claim.item.queueId
      && lane.status === "completed").length, 1);
    assert.equal(recovered.runtime.receipts.filter((receipt) => receipt.kind === "run-terminal"
      && receipt.objectId === claim.item.queueId).length, 1);
    assert.deepEqual(gatewayRuntimeFindings(recovered.policy, recovered.runtime), []);

    await reconcileGateway({ root, now: "2032-02-01T00:00:04.000Z" });
    await reconcileGateway({ root, now: "2032-02-01T00:00:04.100Z" });
    recovered = await loadGatewayRuntime(root);
    assert.equal(recovered.runtime.queue.filter((item) => item.goalId === claim.item.goalId).length, 1);
    const duplicate = await claimGatewayWork({
      root,
      workerId: `worker:duplicate-${scenario.phase}`,
      now: "2032-02-01T00:00:05.000Z"
    });
    assert.equal(duplicate.item, null);
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), sourceBefore);
  });
}
