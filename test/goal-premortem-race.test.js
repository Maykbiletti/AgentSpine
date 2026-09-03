import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claimGatewayWork, completeGatewayRun, loadGatewayRuntime } from "../src/lib/gateway-runtime.js";
import { closedPremortemForGoal, deliveryPremortemPath, finalizeReadOnlyPremortemForGoal,
  inspectDeliveryPremortems, preparePremortemRequirement, recordDeliveryPremortem,
  recordPremortemWrite, verifyPremortemStop } from "../src/lib/delivery-premortem.js";
import { inspectPremortemLaneIndexes, premortemScopeDigest } from "../src/lib/delivery-premortem-index.js";
import { premortemLaneDigest } from "../src/lib/delivery-premortem-binding.js";
import { reviewGoalPremortem } from "../src/lib/gateway-premortem.js";
import { assignPremortemPlan as assignPlan, premortemGoalBinding as binding,
  PREMORTEM_ITEMS, premortemGoalFixture as fixture } from "./goal-premortem-fixture.js";

async function claimPlan(root, agentId, goalId, workerId) {
  await assignPlan(root, agentId, goalId);
  const claim = await claimGatewayWork({ root, workerId, executionMode: "read-only",
    now: "2032-02-01T00:00:02.000Z" });
  assert.equal(claim.item.status, "leased");
  const loaded = await loadGatewayRuntime(root);
  claim.item.planDefinitionsDigest = loaded.policy.goals
    .find((goal) => goal.goalId === goalId).plan.definitionsDigest;
  return claim;
}

async function completeReadOnly(root, claim, workerId) {
  return completeGatewayRun({ root, queueId: claim.item.queueId, workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { completed: true, readOnly: true }, now: "2032-02-01T00:00:03.000Z" });
}

async function fenceBeforePolicyWrite(root, claim) {
  const { policy } = await loadGatewayRuntime(root);
  const goal = policy.goals.find((item) => item.goalId === claim.item.goalId);
  const step = goal.plan.steps.find((item) => item.stepId === claim.item.goalStepId);
  return reviewGoalPremortem({ root, goal, step, item: claim.item, checkpoint: null,
    completedAt: "2032-02-01T00:00:03.000Z", host: "codex", readOnly: true });
}

function highGoalLane(item, label) {
  for (let index = 0; index < 1024; index += 1) {
    const candidate = binding(item, `${label}:${index}`);
    if (premortemLaneDigest(candidate).startsWith("f")) return candidate;
  }
  throw new Error(`could not derive a high deterministic lane for ${label}`);
}

function fillerLane(template, index) {
  return { host: template.host, sessionId: `session:bounded-filler:${index}`,
    projectId: template.projectId, entityId: template.entityId,
    groupId: template.groupId, taskId: null };
}

test("a no-lane read-only completion fences delayed writes", async (t) => {
  const { root, agentId } = await fixture(t);
  const workerId = "worker:read-only-no-lane-race";
  const claim = await claimPlan(root, agentId, "goal:read-only-no-lane-race", workerId);
  const completed = await completeReadOnly(root, claim, workerId);
  assert.equal(completed.item.status, "completed", JSON.stringify(completed));
  const delayed = await preparePremortemRequirement({ root,
    binding: binding(claim.item, "session:delayed-no-lane") });
  assert.equal(delayed.status, "finalized");
  assert.equal(delayed.blocked, true);
});

test("a prepared read-only completion removes its lane and fences delayed writes", async (t) => {
  const { root, agentId } = await fixture(t);
  const workerId = "worker:read-only-prepared-race";
  const claim = await claimPlan(root, agentId, "goal:read-only-prepared-race", workerId);
  const loaded = await loadGatewayRuntime(root);
  const bound = binding({ ...claim.item,
    planDefinitionsDigest: loaded.policy.goals[0].plan.definitionsDigest }, "session:prepared-read-only");
  assert.equal((await preparePremortemRequirement({ root, binding: bound })).status, "required");
  const completed = await completeReadOnly(root, claim, workerId);
  assert.equal(completed.item.status, "completed", JSON.stringify(completed));
  const delayed = await preparePremortemRequirement({ root,
    binding: binding(claim.item, "session:delayed-prepared") });
  assert.equal(delayed.status, "finalized");
  assert.equal(delayed.blocked, true);
});

test("a no-lane read-only fence survives a crash before the policy write", async (t) => {
  const { root, agentId } = await fixture(t);
  const workerId = "worker:read-only-no-lane-retry";
  const claim = await claimPlan(root, agentId, "goal:read-only-no-lane-retry", workerId);
  assert.equal((await fenceBeforePolicyWrite(root, claim)).status, "read-only");
  const retried = await completeReadOnly(root, claim, workerId);
  assert.equal(retried.item.status, "completed", JSON.stringify(retried));
  assert.equal(retried.premortemReview.status, "read-only");
});

test("a prepared read-only fence survives a crash before the policy write", async (t) => {
  const { root, agentId } = await fixture(t);
  const workerId = "worker:read-only-prepared-retry";
  const claim = await claimPlan(root, agentId, "goal:read-only-prepared-retry", workerId);
  const { policy } = await loadGatewayRuntime(root);
  const bound = binding({ ...claim.item,
    planDefinitionsDigest: policy.goals[0].plan.definitionsDigest }, "session:prepared-retry");
  assert.equal((await preparePremortemRequirement({ root, binding: bound })).status, "required");
  assert.equal((await fenceBeforePolicyWrite(root, claim)).status, "read-only");
  const retried = await completeReadOnly(root, claim, workerId);
  assert.equal(retried.item.status, "completed", JSON.stringify(retried));
  assert.equal(retried.premortemReview.status, "read-only");
});

test("a written orphan appearing after an unavailable snapshot blocks read-only finalization", async (t) => {
  const { root, agentId } = await fixture(t);
  const claim = await claimPlan(root, agentId, "goal:read-only-orphan-race",
    "worker:read-only-orphan-race");
  const expected = binding(claim.item, "session:written-orphan");
  const absent = await closedPremortemForGoal({ root, goalId: expected.goalId,
    goalStepId: expected.goalStepId, queueId: expected.queueId,
    gatewayAttempt: expected.gatewayAttempt });
  assert.equal(absent.status, "unavailable");
  const prepared = await preparePremortemRequirement({ root, binding: expected });
  await recordDeliveryPremortem({ root, requirementId: prepared.requirementId,
    items: PREMORTEM_ITEMS });
  await recordPremortemWrite({ root, binding: expected,
    input: { tool_use_id: "write:orphan-race" }, success: true });
  const statePath = await deliveryPremortemPath({ root, binding: expected });
  const indexed = await inspectPremortemLaneIndexes(dirname(statePath));
  const pointerPath = indexed.paths.find((path) => !path.endsWith("finalized.json"));
  await unlink(pointerPath);
  const fenced = await finalizeReadOnlyPremortemForGoal({ root,
    goalId: expected.goalId, goalStepId: expected.goalStepId, queueId: expected.queueId,
    gatewayAttempt: expected.gatewayAttempt, dispositionDigest: "e".repeat(64),
    context: expected, bindingSummaryDigests: [] });
  assert.equal(fenced.status, "mismatch");
  assert.equal(fenced.blocked, true);
});

test("stale scope recovery fences before a delayed writer can publish", async (t) => {
  const { root, agentId } = await fixture(t);
  const claim = await claimPlan(root, agentId, "goal:stale-scope-fence", "worker:stale-scope-fence");
  const delayed = binding(claim.item, "session:delayed-stale-scope");
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: delayed }));
  const scope = premortemScopeDigest(delayed.goalId, delayed.goalStepId,
    delayed.queueId, delayed.gatewayAttempt);
  const indexRoot = join(dirname(stateDirectory), "delivery-premortem-index");
  const lockPath = join(indexRoot, `${scope}.lock`);
  await mkdir(indexRoot, { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({ schema: "agentspine.owned-file-lock/v1",
    token: "synthetic-delayed-writer", acquiredAt: "2032-02-01T00:00:02.000Z",
    leaseMs: 15000, authority: "state-coordination-only" })}\n`);
  const staleAt = new Date(Date.now() - 60000);
  await utimes(lockPath, staleAt, staleAt);

  const fenced = await finalizeReadOnlyPremortemForGoal({ root, goalId: delayed.goalId,
    goalStepId: delayed.goalStepId, queueId: delayed.queueId, gatewayAttempt: delayed.gatewayAttempt,
    dispositionDigest: "f".repeat(64), context: delayed, bindingSummaryDigests: [] });
  assert.equal(fenced.status, "mismatch");
  assert.equal(fenced.blocked, true);
  const beforeWriterResumes = await closedPremortemForGoal({ root, goalId: delayed.goalId,
    goalStepId: delayed.goalStepId, queueId: delayed.queueId, gatewayAttempt: delayed.gatewayAttempt });
  assert.equal(beforeWriterResumes.status, "mismatch");
  assert.equal(beforeWriterResumes.blocked, true);
  const delayedWriter = await preparePremortemRequirement({ root, binding: delayed });
  assert.equal(delayedWriter.status, "finalized");
  assert.equal(delayedWriter.blocked, true);
});

test("a truncated state scan cannot close a visible lane while a same-scope writer is hidden", async (t) => {
  const { root, agentId } = await fixture(t);
  const claim = await claimPlan(root, agentId, "goal:bounded-hidden-writer",
    "worker:bounded-hidden-writer");
  const hidden = highGoalLane(claim.item, "session:hidden-writer");
  const visible = highGoalLane(claim.item, "session:visible-writer");
  const hiddenDigest = premortemLaneDigest(hidden);
  const visibleDigest = premortemLaneDigest(visible);
  const cutoff = [hiddenDigest, visibleDigest].sort()[0];
  let fillers = 0;
  for (let index = 0; fillers < 256; index += 1) {
    assert.ok(index < 4096, "the deterministic filler search stays bounded");
    const candidate = fillerLane(hidden, index);
    if (premortemLaneDigest(candidate) >= cutoff) continue;
    const prepared = await preparePremortemRequirement({ root, binding: candidate });
    assert.equal(prepared.status, "required");
    fillers += 1;
  }

  const hiddenPrepared = await preparePremortemRequirement({ root, binding: hidden });
  const hiddenArtifact = await recordDeliveryPremortem({ root,
    requirementId: hiddenPrepared.requirementId, items: PREMORTEM_ITEMS });
  assert.equal((await recordPremortemWrite({ root, binding: hidden,
    input: { tool_use_id: "write:hidden-bounded-orphan" }, success: true })).status, "write-recorded");
  assert.equal(hiddenArtifact.status, "recorded");
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: hidden }));
  const hiddenPointer = (await inspectPremortemLaneIndexes(stateDirectory)).paths
    .find((path) => path.endsWith(`${hiddenDigest}.json`));
  assert.ok(hiddenPointer, "the hidden writer starts with a bound pointer");
  await unlink(hiddenPointer);

  const visiblePrepared = await preparePremortemRequirement({ root, binding: visible });
  const visibleArtifact = await recordDeliveryPremortem({ root,
    requirementId: visiblePrepared.requirementId, items: PREMORTEM_ITEMS });
  const visibleWrite = await recordPremortemWrite({ root, binding: visible,
    input: { tool_use_id: "write:visible-bounded-lane" }, success: true });
  const closure = [
    `Premortem closure sha256 ${visibleArtifact.digest}`,
    `Premortem latest write sha256 ${visibleWrite.writeDigest}`,
    ...visibleArtifact.artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — synthetic ${item.category} check passed`)
  ].join("\n");
  assert.equal((await verifyPremortemStop({ root, binding: visible, message: closure })).status, "closed");

  const scanned = await inspectDeliveryPremortems(root);
  assert.equal(scanned.truncations.length, 1);
  assert.equal(scanned.states.some((state) => state.laneDigest === hiddenDigest), false);
  assert.equal(scanned.states.some((state) => state.laneDigest === visibleDigest), false);
  const result = await closedPremortemForGoal({ root, goalId: hidden.goalId,
    goalStepId: hidden.goalStepId, queueId: hidden.queueId,
    gatewayAttempt: hidden.gatewayAttempt });
  assert.equal(result.status, "degraded");
  assert.equal(result.blocked, false);
  const indexed = await inspectPremortemLaneIndexes(stateDirectory);
  assert.equal(indexed.finalizations.length, 0, "uncertain scope evidence cannot finalize the visible lane");
  assert.equal(indexed.pointers.some((pointer) => pointer.laneDigest === visibleDigest), true);
});
