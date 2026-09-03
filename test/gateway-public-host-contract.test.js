import test from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claimGatewayWork, completeGatewayRun, failGatewayRun, gatewayContext, loadGatewayRuntime,
  markGatewayHostStarted, reconcileGateway, runAudit
} from "../src/index.js";
import { withGatewayStateLock, writeGatewayStateJson } from "../src/lib/gateway-state-transaction.js";
import { assignPremortemPlan, premortemGoalFixture } from "./goal-premortem-fixture.js";

async function blockExpiredClaim(root, at = "2032-02-01T00:02:03.000Z") {
  await reconcileGateway({ root, now: at });
  return loadGatewayRuntime(root);
}

test("public host-effect claim records its reservation and never replays a marked host effect", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:public-host-effect");
  const claim = await claimGatewayWork({ root, workerId: "worker:public-host-effect",
    now: "2032-02-01T00:00:02.000Z" });
  assert.equal(claim.item.lease.executionMode, "host-effect");
  assert.equal(claim.item.lease.effectMayStartAt, "2032-02-01T00:00:02.000Z");

  await markGatewayHostStarted({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
    claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    now: "2032-02-01T00:00:02.100Z" });
  const effectPath = join(root, "synthetic-public-host-effect.log");
  await appendFile(effectPath, "effect\n");

  const recovered = await blockExpiredClaim(root);
  assert.equal(recovered.runtime.queue[0].status, "blocked");
  assert.equal(recovered.runtime.queue[0].lease, null);
  assert.equal(recovered.policy.goals[0].status, "blocked");
  assert.equal(recovered.runtime.health.host, "failed");
  const failedContext = await gatewayContext({ root });
  assert.match(failedContext.healthFindings.join(","), /host-not-healthy/);
  assert.match(failedContext.healthFindings.join(","), /host-outcome-ambiguous/);
  assert.equal(recovered.runtime.receipts.filter((receipt) => receipt.kind === "host-outcome-ambiguous").length, 1);
  assert.equal((await claimGatewayWork({ root, workerId: "worker:must-not-replay",
    now: "2032-02-01T00:02:04.000Z" })).item, null);

  const audit = await runAudit(root);
  assert.equal(audit.gates.find((gate) => gate.id === 8).ok, false);

  const resumed = await assignPremortemPlan(root, agentId, "goal:public-host-effect",
    "2032-02-01T00:03:00.000Z");
  assert.equal(resumed.resumed, true);
  const readOnlyRecovery = await claimGatewayWork({ root, workerId: "worker:owner-reviewed-read-only",
    executionMode: "read-only", now: "2032-02-01T00:03:01.000Z" });
  await completeGatewayRun({ root, queueId: readOnlyRecovery.item.queueId,
    workerId: readOnlyRecovery.item.lease.workerId, claimedAt: readOnlyRecovery.item.lease.claimedAt,
    attempt: readOnlyRecovery.item.attempts, result: { readOnly: true }, now: "2032-02-01T00:03:02.000Z" });
  const stillFailed = await loadGatewayRuntime(root);
  assert.equal(stillFailed.runtime.health.host, "failed");
  assert.equal((await gatewayContext({ root })).healthFindings.includes("host-not-healthy"), true);

  const recovery = await claimGatewayWork({ root, workerId: "worker:owner-reviewed-recovery",
    now: "2032-02-01T00:04:03.000Z" });
  await markGatewayHostStarted({ root, queueId: recovery.item.queueId, workerId: recovery.item.lease.workerId,
    claimedAt: recovery.item.lease.claimedAt, attempt: recovery.item.attempts,
    now: "2032-02-01T00:04:03.100Z" });
  await completeGatewayRun({ root, queueId: recovery.item.queueId, workerId: recovery.item.lease.workerId,
    claimedAt: recovery.item.lease.claimedAt, attempt: recovery.item.attempts,
    result: { checkpoint: { ownerReviewedRecovery: true } }, now: "2032-02-01T00:04:04.000Z" });
  const healthy = await loadGatewayRuntime(root);
  assert.equal(healthy.runtime.health.host, "healthy");
  const healthyContext = await gatewayContext({ root });
  assert.equal(healthyContext.healthFindings.includes("host-not-healthy"), false);
  assert.equal(healthyContext.healthFindings.includes("host-outcome-ambiguous"), false);
  assert.equal(healthy.runtime.receipts.filter((receipt) => receipt.kind === "host-outcome-ambiguous").length, 1);
});

test("unmarked current and legacy public leases become explicit manual-review blocks on restart", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:public-unmarked");
  const unmarked = await claimGatewayWork({ root, workerId: "worker:public-unmarked",
    now: "2032-02-01T00:00:02.000Z" });
  assert.equal(unmarked.item.lease.hostStartedAt, undefined);
  assert.equal(unmarked.item.lease.effectMayStartAt, "2032-02-01T00:00:02.000Z");
  const currentRecovered = await blockExpiredClaim(root);
  assert.equal(currentRecovered.runtime.queue[0].status, "blocked");
  assert.equal(currentRecovered.runtime.receipts.at(-1).kind, "host-outcome-ambiguous");
  assert.equal(currentRecovered.runtime.receipts.at(-1).details.hostStartedAt, null);
  assert.equal(currentRecovered.runtime.receipts.at(-1).details.executionMode, "host-effect");

  await assignPremortemPlan(root, agentId, "goal:public-legacy-unmarked", "2032-02-01T00:03:00.000Z");
  const legacy = await claimGatewayWork({ root, workerId: "worker:public-legacy",
    now: "2032-02-01T00:03:01.000Z" });
  const paths = await loadGatewayRuntime(root);
  const runtime = structuredClone(paths.runtime);
  delete runtime.queue.find((item) => item.queueId === legacy.item.queueId).lease.executionMode;
  delete runtime.queue.find((item) => item.queueId === legacy.item.queueId).lease.effectMayStartAt;
  await withGatewayStateLock(paths, () => writeGatewayStateJson(paths.gatewayRuntimePath, runtime));

  const legacyRecovered = await blockExpiredClaim(root, "2032-02-01T00:05:02.000Z");
  const legacyItem = legacyRecovered.runtime.queue.find((item) => item.queueId === legacy.item.queueId);
  const legacyReceipt = legacyRecovered.runtime.receipts.filter((receipt) => receipt.objectId === legacy.item.queueId).at(-1);
  assert.equal(legacyItem.status, "blocked");
  assert.equal(legacyReceipt.kind, "host-outcome-ambiguous");
  assert.equal(legacyReceipt.details.executionMode, "legacy-unknown");
});

test("a public host-effect failure is ambiguous instead of a retry", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:public-host-failure");
  const claim = await claimGatewayWork({ root, workerId: "worker:public-host-failure",
    now: "2032-02-01T00:00:02.000Z" });
  const failed = await failGatewayRun({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
    claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    error: "synthetic host failure", now: "2032-02-01T00:00:03.000Z" });
  assert.equal(failed.item.status, "blocked");
  assert.equal(failed.receipt.kind, "host-outcome-ambiguous");
  assert.equal((await loadGatewayRuntime(root)).runtime.health.host, "failed");
  assert.equal((await claimGatewayWork({ root, workerId: "worker:must-not-retry",
    now: "2032-02-01T00:00:04.000Z" })).item, null);
});

test("a public host-effect completion requires its durable host-start mark", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:public-host-start-required");
  const claim = await claimGatewayWork({ root, workerId: "worker:public-host-start-required",
    now: "2032-02-01T00:00:02.000Z" });
  const completion = { root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
    claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { checkpoint: { syntheticHostEffect: true } }, now: "2032-02-01T00:00:02.100Z" };
  await assert.rejects(completeGatewayRun(completion), /requires markGatewayHostStarted/i);
  assert.equal((await loadGatewayRuntime(root)).runtime.queue[0].status, "leased");
  await markGatewayHostStarted({ ...completion, now: "2032-02-01T00:00:02.200Z" });
  const completed = await completeGatewayRun({ ...completion, now: "2032-02-01T00:00:02.300Z" });
  assert.equal(completed.item.status, "completed");
});

test("only an explicit read-only public lease can use no-effect expiry recovery", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:public-read-only");
  const claim = await claimGatewayWork({ root, workerId: "worker:public-read-only",
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  assert.equal(claim.item.lease.executionMode, "read-only");
  assert.equal(claim.item.lease.effectMayStartAt, undefined);
  await assert.rejects(completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, result: { readOnly: true }, now: "2032-02-01T00:00:02.050Z" }),
  /claimedAt and attempt/i);
  await assert.rejects(failGatewayRun({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, error: "missing generation", now: "2032-02-01T00:00:02.050Z" }),
  /claimedAt and attempt/i);
  await assert.rejects(completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: {}, now: "2032-02-01T00:00:02.100Z" }), /read-only gateway lease/i);

  const expired = await blockExpiredClaim(root);
  assert.equal(expired.runtime.queue[0].status, "pending");
  assert.equal(expired.runtime.receipts.some((receipt) => receipt.kind === "host-outcome-ambiguous"), false);
  const retried = await claimGatewayWork({ root, workerId: "worker:public-read-only",
    executionMode: "read-only", now: "2032-02-01T00:02:04.000Z" });
  await assert.rejects(completeGatewayRun({ root, queueId: retried.item.queueId,
    workerId: retried.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { readOnly: true }, now: "2032-02-01T00:02:04.100Z" }), /exact active queue lease/i);
  await assert.rejects(failGatewayRun({ root, queueId: retried.item.queueId,
    workerId: retried.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    error: "stale synthetic result", now: "2032-02-01T00:02:04.100Z" }), /exact active queue lease/i);
  const completed = await completeGatewayRun({ root, queueId: retried.item.queueId,
    workerId: retried.item.lease.workerId, claimedAt: retried.item.lease.claimedAt, attempt: retried.item.attempts,
    result: { readOnly: true }, now: "2032-02-01T00:02:05.000Z" });
  assert.equal(completed.item.status, "completed");
});
