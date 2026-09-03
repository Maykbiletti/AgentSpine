import test from "node:test";
import assert from "node:assert/strict";
import { rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { claimGatewayWork, completeGatewayRun, loadGatewayRuntime } from "../src/lib/gateway-runtime.js";
import { closedPremortemForGoal, deliveryPremortemPath, inspectDeliveryPremortems, preparePremortemRequirement,
  recordDeliveryPremortem, recordPremortemWrite, recordPremortemWriteIntent,
  verifyPremortemStop } from "../src/lib/delivery-premortem.js";
import { inspectPremortemLaneIndexes, removePremortemLaneIndex } from "../src/lib/delivery-premortem-index.js";
import { withOwnedFileLock } from "../src/lib/owned-file-lock.js";
import { assignPremortemPlan as assignPlan, premortemGoalBinding as binding,
  PREMORTEM_ITEMS, premortemGoalFixture as fixture } from "./goal-premortem-fixture.js";

test("more than 64 sequential read-only host sessions leave no lane and complete once", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:read-only-session-cleanup");
  const workerId = "worker:read-only-session-cleanup";
  const claim = await claimGatewayWork({ root, workerId,
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  claim.item.planDefinitionsDigest = loaded.policy.goals[0].plan.definitionsDigest;
  let stateDirectory;
  for (let index = 0; index < 65; index += 1) {
    const bound = binding(claim.item, `session:read-only:${index}`);
    const prepared = await preparePremortemRequirement({ root, binding: bound });
    assert.equal(prepared.status, "required", JSON.stringify(prepared));
    stateDirectory ||= dirname(await deliveryPremortemPath({ root, binding: bound }));
    const concurrentStops = await Promise.all([
      verifyPremortemStop({ root, binding: bound, message: "Synthetic read-only answer." }),
      verifyPremortemStop({ root, binding: bound, message: "Synthetic repeated read-only answer." })
    ]);
    assert.deepEqual(concurrentStops.map((result) => result.status).sort(), ["no-write", "read-only"]);
    if (index === 0) {
      const delayedWrite = await recordPremortemWriteIntent({ root, binding: bound,
        input: { tool_use_id: "write:after-read-only-stop" } });
      assert.equal(delayedWrite.status, "missing");
      assert.equal(delayedWrite.blocked, true);
    }
  }
  const states = await inspectDeliveryPremortems(root);
  const indexes = await inspectPremortemLaneIndexes(stateDirectory);
  assert.equal(states.states.length, 0);
  assert.equal(states.errors.length, 0);
  assert.equal(states.truncations.length, 0);
  assert.equal(indexes.pointers.length, 0);
  assert.equal(indexes.errors.length, 0);

  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId, workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { completed: true, readOnly: true }, now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "completed", JSON.stringify(completed));
  assert.equal(completed.premortemReview.status, "read-only");
  const late = await preparePremortemRequirement({ root,
    binding: binding(claim.item, "session:read-only:late") });
  assert.equal(late.status, "finalized");
  assert.equal(late.blocked, true);
});

test("read-only completion cleans 65 prepared lanes left by crashed sessions", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:read-only-crashed-sessions");
  const workerId = "worker:read-only-crashed-sessions";
  const claim = await claimGatewayWork({ root, workerId,
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  claim.item.planDefinitionsDigest = loaded.policy.goals[0].plan.definitionsDigest;
  let stateDirectory;
  for (let index = 0; index < 65; index += 1) {
    const bound = binding(claim.item, `session:crashed-read-only:${index}`);
    const prepared = await preparePremortemRequirement({ root, binding: bound });
    assert.equal(prepared.status, "required", JSON.stringify(prepared));
    stateDirectory ||= dirname(prepared.path);
  }
  assert.equal((await inspectDeliveryPremortems(root)).states.length, 65);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId, workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { completed: true, readOnly: true }, now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "completed", JSON.stringify(completed));
  assert.equal(completed.premortemReview.status, "read-only");
  assert.equal((await inspectDeliveryPremortems(root)).states.length, 0);
  const indexes = await inspectPremortemLaneIndexes(stateDirectory);
  assert.equal(indexes.pointers.length, 0);
  assert.equal(indexes.errors.length, 0);
});

test("capacity cleanup preserves a written lane and blocks read-only completion", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:read-only-capacity-written");
  const workerId = "worker:read-only-capacity-written";
  const claim = await claimGatewayWork({ root, workerId,
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  claim.item.planDefinitionsDigest = loaded.policy.goals[0].plan.definitionsDigest;
  const writer = binding(claim.item, "session:capacity-writer");
  const prepared = await preparePremortemRequirement({ root, binding: writer });
  await recordDeliveryPremortem({ root, requirementId: prepared.requirementId,
    items: PREMORTEM_ITEMS });
  await recordPremortemWrite({ root, binding: writer,
    input: { tool_use_id: "write:capacity-writer" } });
  for (let index = 0; index < 64; index += 1) {
    await preparePremortemRequirement({ root,
      binding: binding(claim.item, `session:capacity-reader:${index}`) });
  }
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId, workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { completed: true, readOnly: true }, now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "missing");
  const states = (await inspectDeliveryPremortems(root)).states;
  assert.equal(states.length, 1);
  assert.equal(states[0].firstWrite !== null, true);
});

test("goal lookup cannot resurrect a read-only lane from a cleanup snapshot", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:read-only-cleanup-race");
  const claim = await claimGatewayWork({ root, workerId: "worker:read-only-cleanup-race",
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  claim.item.planDefinitionsDigest = loaded.policy.goals[0].plan.definitionsDigest;
  const bound = binding(claim.item, "session:read-only-cleanup-race");
  const prepared = await preparePremortemRequirement({ root, binding: bound });
  const statePath = await deliveryPremortemPath({ root, binding: bound });
  const [state] = (await inspectDeliveryPremortems(root)).states;
  let releaseCleanup;
  let signalPointerRemoved;
  const pointerRemoved = new Promise((resolve) => { signalPointerRemoved = resolve; });
  const release = new Promise((resolve) => { releaseCleanup = resolve; });
  const cleanup = withOwnedFileLock(`${statePath}.lock`, async ({ assertOwned }) =>
    removePremortemLaneIndex({ statePath, state, commit: async ({ assertOwned: assertIndexOwned }) => {
      await assertOwned();
      await assertIndexOwned();
      signalPointerRemoved();
      await release;
      await unlink(statePath);
    } }));
  await pointerRemoved;
  const lookup = closedPremortemForGoal({ root, goalId: bound.goalId,
    goalStepId: bound.goalStepId, queueId: bound.queueId, gatewayAttempt: bound.gatewayAttempt });
  await nextTurn();
  releaseCleanup();
  assert.equal((await cleanup).status, "removed");
  assert.equal((await lookup).status, "unavailable");
  assert.equal((await inspectDeliveryPremortems(root)).states.length, 0);
  const indexes = await inspectPremortemLaneIndexes(dirname(prepared.path));
  assert.equal(indexes.pointers.length, 0);
  assert.equal(indexes.errors.length, 0);
});

test("read-only Stop cleans an orphan whose index scope directory disappeared", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:read-only-missing-index");
  const claim = await claimGatewayWork({ root, workerId: "worker:read-only-missing-index",
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  claim.item.planDefinitionsDigest = loaded.policy.goals[0].plan.definitionsDigest;
  const bound = binding(claim.item, "session:read-only-missing-index");
  const prepared = await preparePremortemRequirement({ root, binding: bound });
  const before = await inspectPremortemLaneIndexes(dirname(prepared.path));
  await rm(before.directories[0], { recursive: true });
  const stopped = await verifyPremortemStop({ root, binding: bound,
    message: "Synthetic read-only answer." });
  assert.equal(stopped.status, "read-only", JSON.stringify(stopped));
  assert.equal((await inspectDeliveryPremortems(root)).states.length, 0);
  assert.equal((await inspectPremortemLaneIndexes(dirname(prepared.path))).pointers.length, 0);
});
