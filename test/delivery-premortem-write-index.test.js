import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../src/lib/audit.js";
import {
  closedPremortemForGoal,
  deliveryPremortemPath,
  inspectDeliveryPremortems,
  preparePremortemRequirement,
  recordDeliveryPremortem,
  recordPremortemWrite,
  verifyPremortemStop
} from "../src/lib/delivery-premortem.js";
import {
  premortemLaneDigest,
  premortemWriteIdentity
} from "../src/lib/delivery-premortem-binding.js";
import {
  premortemSha256,
  premortemTime,
  sealPremortem
} from "../src/lib/delivery-premortem-codec.js";
import {
  appendPremortemWriteIndex,
  deliveryPremortemWriteNodePath,
  inspectPremortemWriteIndexes,
  inspectPremortemWriteProof
} from "../src/lib/delivery-premortem-write-ledger.js";
import { withOwnedFileLock } from "../src/lib/owned-file-lock.js";

const ITEMS = [
  {
    category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the exact synthetic baseline."
  },
  {
    category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regressed",
    check: "Run the exact synthetic contract test."
  },
  {
    category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact moved",
    check: "Verify the exact synthetic delivery path."
  }
];

async function fixture(t, suffix, goal = false) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-write-index-project-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "agentspine-write-index-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRoot, { recursive: true, force: true })
    ]);
  });
  await writeFile(join(root, "AGENTS.md"), "# Synthetic write-index rules\n", "utf8");
  const binding = {
    host: "codex",
    sessionId: `session:write-index-${suffix}`,
    projectId: "project:write-index",
    entityId: "agent:write-index",
    ...(goal ? { goalId: "goal:write-index", goalStepId: "step:write-index",
      queueId: `queue:${suffix}`, gatewayAttempt: 1,
      planDefinitionsDigest: "a".repeat(64) } : {})
  };
  const requirement = await preparePremortemRequirement({ root, binding });
  const recorded = await recordDeliveryPremortem({
    root,
    requirementId: requirement.requirementId,
    items: ITEMS
  });
  assert.equal(recorded.status, "recorded");
  return { root, binding, requirement, artifact: recorded.artifact };
}

function closure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — verified ${item.category}`)].join("\n");
}

test("the write index has no 64-write delivery cap and fences delayed replay", async (t) => {
  const { root, binding } = await fixture(t, "rotation");
  const firstInput = {
    tool_use_id: "write:index-0",
    tool_input: { file_path: "synthetic.js", content: "version 0" }
  };
  const first = await recordPremortemWrite({
    root,
    binding,
    input: firstInput,
    phase: "intent"
  });
  assert.equal(first.status, "write-recorded");

  for (let index = 1; index < 320; index += 1) {
    const result = await recordPremortemWrite({
      root,
      binding,
      input: {
        tool_use_id: `write:index-${index}`,
        tool_input: { file_path: "synthetic.js", content: `version ${index}` }
      },
      phase: "intent"
    });
    assert.equal(result.status, "write-recorded", JSON.stringify(result));
  }

  const [state] = (await inspectDeliveryPremortems(root)).states;
  assert.equal(state.writeLedger.length, 64);
  assert.equal(state.writeLedger.some((entry) => entry.idDigest === state.firstWrite.idDigest), false);
  assert.match(state.writeIndexRoot, /^[a-f0-9]{64}$/);
  const statePath = await deliveryPremortemPath({ root, binding });
  const proof = await inspectPremortemWriteProof({
    statePath,
    laneDigest: state.laneDigest,
    rootDigest: state.writeIndexRoot,
    idDigest: state.firstWrite.idDigest
  });
  assert.equal(proof.paths.length > 1, true, "the test must exercise a branch/prefix split");

  await t.test("the exact unique-node inspection limit is not truncated", async () => {
    const completeIndex = await inspectPremortemWriteIndexes({
      statePath,
      state,
      maxNodes: 4_096
    });
    assert.equal(completeIndex.truncations.length, 0);
    assert.equal(completeIndex.nodes.some((node) => node.kind === "branch"), true);
    const exactIndex = await inspectPremortemWriteIndexes({
      statePath,
      state,
      maxNodes: completeIndex.nodes.length
    });
    assert.equal(exactIndex.nodes.length, completeIndex.nodes.length);
    assert.deepEqual(exactIndex.truncations, [],
      "duplicate queue entries must not report truncation at the exact unique-node limit");
  });

  const duplicate = await recordPremortemWrite({
    root,
    binding,
    input: firstInput,
    phase: "intent"
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.writeDigest, first.writeDigest);

  const newWrite = await recordPremortemWrite({
    root,
    binding,
    input: {
      tool_use_id: "write:index-320",
      tool_input: { file_path: "synthetic.js", content: "version 320" }
    },
    phase: "intent"
  });
  assert.equal(newWrite.status, "write-recorded");

  const changed = await recordPremortemWrite({
    root,
    binding,
    input: {
      tool_use_id: firstInput.tool_use_id,
      tool_input: { file_path: "synthetic.js", content: "changed delayed replay" }
    },
    phase: "intent"
  });
  assert.equal(changed.status, "conflict");
  assert.equal(changed.blocked, true);
  assert.equal(changed.reason, "A repeated write receipt has different tool input.");
});

test("an orphan node written before the state-root commit is safely adopted", async (t) => {
  const { root, binding, requirement } = await fixture(t, "orphan-before-state");
  const input = {
    tool_use_id: "write:orphan-before-state",
    tool_input: { file_path: "synthetic.js", content: "orphan candidate" }
  };
  const now = new Date("2037-01-01T00:00:00.000Z");
  const statePath = await deliveryPremortemPath({ root, binding });
  const laneDigest = premortemLaneDigest(binding);
  const identity = premortemWriteIdentity(input, "intent");
  const boundWrite = sealPremortem({
    ...identity,
    laneDigest,
    requirementId: requirement.requirementId,
    recordedAt: premortemTime(now)
  });

  const orphan = await withOwnedFileLock(`${statePath}.lock`, ({ assertOwned }) =>
    appendPremortemWriteIndex({
      statePath,
      laneDigest,
      rootDigest: null,
      write: boundWrite,
      assertOwned
    }));
  assert.match(orphan.rootDigest, /^[a-f0-9]{64}$/);
  assert.equal((await inspectDeliveryPremortems(root)).states[0].writeIndexRoot, null);
  await readFile(deliveryPremortemWriteNodePath(statePath, laneDigest, orphan.rootDigest), "utf8");

  const recovered = await recordPremortemWrite({
    root,
    binding,
    input,
    phase: "intent",
    now
  });
  assert.equal(recovered.status, "write-recorded");
  assert.equal((await inspectDeliveryPremortems(root)).states[0].writeIndexRoot, orphan.rootDigest);
});

test("a missing referenced write-index node blocks use and fails audit", async (t) => {
  const { root, binding } = await fixture(t, "missing-node");
  const input = {
    tool_use_id: "write:missing-node",
    tool_input: { file_path: "synthetic.js" }
  };
  await recordPremortemWrite({ root, binding, input, phase: "intent" });
  const statePath = await deliveryPremortemPath({ root, binding });
  const [state] = (await inspectDeliveryPremortems(root)).states;
  const nodePath = deliveryPremortemWriteNodePath(
    statePath,
    state.laneDigest,
    state.writeIndexRoot
  );
  await unlink(nodePath);

  const replay = await recordPremortemWrite({ root, binding, input, phase: "intent" });
  assert.equal(replay.status, "mismatch");
  assert.equal(replay.blocked, true);
  assert.match(replay.reason, /references a missing node/);
  const audited = await runAudit(root);
  assert.equal(audited.ok, false);
  assert.equal(audited.premortemDiagnostics.errors.some((error) =>
    /references a missing node/.test(error.reason)), true);
});

test("a tampered referenced write-index node blocks use and fails audit", async (t) => {
  const { root, binding } = await fixture(t, "tampered-node");
  const input = {
    tool_use_id: "write:tampered-node",
    tool_input: { file_path: "synthetic.js" }
  };
  await recordPremortemWrite({ root, binding, input, phase: "intent" });
  const statePath = await deliveryPremortemPath({ root, binding });
  const [state] = (await inspectDeliveryPremortems(root)).states;
  const nodePath = deliveryPremortemWriteNodePath(
    statePath,
    state.laneDigest,
    state.writeIndexRoot
  );
  const node = JSON.parse(await readFile(nodePath, "utf8"));
  node.entries[0].inputDigest = "f".repeat(64);
  const material = { ...node };
  delete material.digest;
  node.digest = premortemSha256(material);
  await writeFile(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");

  const replay = await recordPremortemWrite({ root, binding, input, phase: "intent" });
  assert.equal(replay.status, "mismatch");
  assert.equal(replay.blocked, true);
  assert.match(replay.reason, /failed integrity validation/);
  const audited = await runAudit(root);
  assert.equal(audited.ok, false);
  assert.equal(audited.premortemDiagnostics.errors.some((error) =>
    /failed integrity validation/.test(error.reason)), true);
});

test("deleting an old split descendant cannot turn a replay into a new write", async (t) => {
  const { root, binding } = await fixture(t, "old-descendant");
  for (let index = 0; index < 260; index += 1) {
    const result = await recordPremortemWrite({ root, binding, phase: "intent",
      input: { tool_use_id: `write:old-descendant-${index}` } });
    assert.equal(result.status, "write-recorded");
  }
  const statePath = await deliveryPremortemPath({ root, binding });
  const [state] = (await inspectDeliveryPremortems(root)).states;
  const target = premortemWriteIdentity({ tool_use_id: "write:old-descendant-1" }, "intent");
  assert.equal(state.writeLedger.some((entry) => entry.idDigest === target.idDigest), false);
  const proof = await inspectPremortemWriteProof({ statePath, laneDigest: state.laneDigest,
    rootDigest: state.writeIndexRoot, idDigest: target.idDigest });
  assert.ok(proof.paths.length > 1);
  const stateBytes = await readFile(statePath, "utf8");
  await unlink(proof.paths.at(-1));
  const replay = await recordPremortemWrite({ root, binding, phase: "intent",
    input: { tool_use_id: "write:old-descendant-1", tool_input: { path: "changed.js" } } });
  assert.equal(replay.status, "mismatch");
  assert.equal(replay.blocked, true);
  assert.equal(await readFile(statePath, "utf8"), stateBytes);
  const audited = await runAudit(root);
  assert.equal(audited.ok, false);
  assert.equal(audited.premortemDiagnostics.writeIndex.errors.some((error) =>
    error.path === proof.paths.at(-1)), true);
});

test("Stop fails open only for parser uncertainty, not a missing referenced root", async (t) => {
  const setup = await fixture(t, "stop-boundary");
  const write = await recordPremortemWrite({ root: setup.root, binding: setup.binding,
    input: { tool_use_id: "write:stop-boundary" }, phase: "intent" });
  const statePath = await deliveryPremortemPath(setup);
  const [state] = (await inspectDeliveryPremortems(setup.root)).states;
  const rootPath = deliveryPremortemWriteNodePath(statePath, state.laneDigest, state.writeIndexRoot);
  const original = await readFile(rootPath, "utf8");
  await writeFile(rootPath, "{not json\n");
  const degraded = await verifyPremortemStop({ root: setup.root, binding: setup.binding,
    message: closure(setup.artifact, write.writeDigest) });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.blocked, false);
  await writeFile(rootPath, original);
  await unlink(rootPath);
  const mismatch = await verifyPremortemStop({ root: setup.root, binding: setup.binding,
    message: closure(setup.artifact, write.writeDigest) });
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.blocked, true);
});

test("goal consumption rechecks the latest write index", async (t) => {
  const setup = await fixture(t, "goal-consumption", true);
  const write = await recordPremortemWrite({ root: setup.root, binding: setup.binding,
    input: { tool_use_id: "write:goal-consumption" }, phase: "intent" });
  assert.equal((await verifyPremortemStop({ root: setup.root, binding: setup.binding,
    message: closure(setup.artifact, write.writeDigest) })).status, "closed");
  const statePath = await deliveryPremortemPath(setup);
  const [state] = (await inspectDeliveryPremortems(setup.root)).states;
  await unlink(deliveryPremortemWriteNodePath(statePath, state.laneDigest, state.writeIndexRoot));
  const result = await closedPremortemForGoal({ root: setup.root, goalId: setup.binding.goalId,
    goalStepId: setup.binding.goalStepId, queueId: setup.binding.queueId,
    gatewayAttempt: setup.binding.gatewayAttempt });
  assert.equal(result.status, "mismatch");
  assert.equal(result.blocked, true);
});

test("the lane lock makes concurrent duplicate writes exactly-once", async (t) => {
  const { root, binding } = await fixture(t, "concurrent");
  const input = {
    tool_use_id: "write:concurrent",
    tool_input: { file_path: "synthetic.js", content: "same" }
  };
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    recordPremortemWrite({ root, binding, input, phase: "intent" })));
  assert.equal(results.filter((result) => result.status === "write-recorded").length, 1);
  assert.equal(results.filter((result) => result.status === "duplicate").length, 7);
  assert.equal(new Set(results.map((result) => result.writeDigest)).size, 1);
});
