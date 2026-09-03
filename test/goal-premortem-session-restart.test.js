import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runHook } from "../src/hook.js";
import {
  inspectDeliveryPremortems, preparePremortemRequirement, recordDeliveryPremortem,
  recordPremortemWrite
} from "../src/lib/delivery-premortem.js";
import { premortemScopeDigest } from "../src/lib/delivery-premortem-index.js";
import { claimGatewayWork, loadGatewayRuntime, reconcileGateway } from "../src/lib/gateway-runtime.js";
import {
  assignPremortemPlan as assignPlan,
  PREMORTEM_ITEMS as ITEMS, premortemGoalBinding as binding,
  premortemGoalFixture as fixture
} from "./goal-premortem-fixture.js";

function preWrite(root, agentId, item, sessionId, planDefinitionsDigest, toolUseId) {
  return { hook_event_name: "PreToolUse", host: "codex", cwd: root, session_id: sessionId,
    tool_name: "Write", tool_use_id: toolUseId,
    tool_input: { file_path: "synthetic.js", content: "" },
    agent_spine_scope: { entity_id: agentId, group_id: "group:premortem",
      project_id: "project:premortem", goal_id: item.goalId, goal_step_id: item.goalStepId,
      queue_id: item.queueId, gateway_attempt: item.attempts,
      plan_definitions_digest: planDefinitionsDigest } };
}

test("a restarted writer session blocks an ambiguous host effect instead of replaying it", async (t) => {
  const { root, agentId } = await fixture(t, "codex");
  await assignPlan(root, agentId, "goal:session-restart");
  const first = await claimGatewayWork({ root, workerId: "worker:session:one",
    leaseSeconds: 15, executionMode: "host-effect", now: "2032-02-01T00:00:02.000Z" });
  assert.equal(first.item.attempts, 1);
  const initial = await loadGatewayRuntime(root);
  const planDefinitionsDigest = initial.policy.goals[0].plan.definitionsDigest;
  const firstSession = binding({ ...first.item, planDefinitionsDigest }, "session:restart:one");
  const firstPrepared = await preparePremortemRequirement({ root, binding: firstSession });
  await recordDeliveryPremortem({ root, requirementId: firstPrepared.requirementId, items: ITEMS });
  assert.equal((await recordPremortemWrite({ root, binding: firstSession,
    input: { tool_use_id: "write:restart:one" }, phase: "intent" })).status, "write-recorded");

  const prematureSession = binding({ ...first.item, planDefinitionsDigest }, "session:restart:two");
  const prematurePrepared = await preparePremortemRequirement({ root, binding: prematureSession });
  assert.equal((await recordDeliveryPremortem({ root,
    requirementId: prematurePrepared.requirementId, items: ITEMS })).status, "recorded");
  const blockedHook = await runHook(preWrite(root, agentId, first.item,
    prematureSession.sessionId, planDefinitionsDigest, "write:restart:premature"));
  const blocked = blockedHook.premortem;
  assert.equal(blocked.status, "mismatch");
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /different host session.*gateway attempt 1.*reclaim/is);
  const beforeRecovery = await inspectDeliveryPremortems(root);
  assert.equal(beforeRecovery.states.find((state) =>
    state.binding.sessionId === prematureSession.sessionId).firstWrite, null);

  await reconcileGateway({ root, now: "2032-02-01T00:00:18.000Z" });
  const final = await loadGatewayRuntime(root);
  const queue = final.runtime.queue.find((item) => item.queueId === first.item.queueId);
  const step = final.policy.goals[0].plan.steps[0];
  assert.equal(queue.status, "blocked");
  assert.equal(queue.lease, null);
  assert.match(queue.lastError, /manual owner review/i);
  assert.equal(final.runtime.health.host, "failed");
  assert.equal(final.policy.goals[0].status, "blocked");
  assert.equal(step.status, "blocked");
  const ambiguity = final.runtime.receipts.find((receipt) =>
    receipt.kind === "host-outcome-ambiguous" && receipt.objectId === first.item.queueId);
  assert.equal(ambiguity.details.executionMode, "host-effect");
  assert.equal(ambiguity.details.effectMayStartAt, first.item.lease.effectMayStartAt);
  const replay = await claimGatewayWork({ root, workerId: "worker:session:two",
    leaseSeconds: 15, executionMode: "host-effect", now: "2032-02-01T00:00:19.000Z" });
  assert.equal(replay.item, null);
  const retained = await inspectDeliveryPremortems(root);
  assert.equal(retained.states.find((state) => state.binding.sessionId === firstSession.sessionId).firstWrite !== null, true);
});

test("concurrent sessions admit one writer in an exact goal attempt", async (t) => {
  const { root, agentId } = await fixture(t, "codex");
  await assignPlan(root, agentId, "goal:session-race");
  const claim = await claimGatewayWork({ root, workerId: "worker:session:race",
    leaseSeconds: 15, executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const planDefinitionsDigest = loaded.policy.goals[0].plan.definitionsDigest;
  const lanes = ["one", "two"].map((suffix) =>
    binding({ ...claim.item, planDefinitionsDigest }, `session:race:${suffix}`));
  await Promise.all(lanes.map(async (lane) => {
    const prepared = await preparePremortemRequirement({ root, binding: lane });
    const recorded = await recordDeliveryPremortem({ root,
      requirementId: prepared.requirementId, items: ITEMS });
    assert.equal(recorded.status, "recorded");
  }));
  const writes = await Promise.all(lanes.map((lane, index) => recordPremortemWrite({
    root, binding: lane, input: { tool_use_id: `write:race:${index}` }, phase: "intent"
  })));
  assert.equal(writes.filter((result) => result.status === "write-recorded").length, 1);
  const denied = writes.find((result) => result.status === "mismatch");
  assert.equal(denied.blocked, true);
  assert.match(denied.reason, /different host session.*reclaim/is);
  assert.equal((await inspectDeliveryPremortems(root)).states.filter((state) => state.firstWrite).length, 1);
});

test("uncertain session index parsing fails open and is reported as degraded", async (t) => {
  const { root, agentId } = await fixture(t, "codex");
  await assignPlan(root, agentId, "goal:session-uncertain");
  const claim = await claimGatewayWork({ root, workerId: "worker:session:uncertain",
    leaseSeconds: 15, executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const planDefinitionsDigest = loaded.policy.goals[0].plan.definitionsDigest;
  const firstSession = binding({ ...claim.item, planDefinitionsDigest }, "session:uncertain:one");
  const firstPrepared = await preparePremortemRequirement({ root, binding: firstSession });
  await recordDeliveryPremortem({ root, requirementId: firstPrepared.requirementId, items: ITEMS });
  await recordPremortemWrite({ root, binding: firstSession,
    input: { tool_use_id: "write:uncertain:one" }, phase: "intent" });
  const otherSession = binding({ ...claim.item, planDefinitionsDigest }, "session:uncertain:two");
  const otherPrepared = await preparePremortemRequirement({ root, binding: otherSession });
  await recordDeliveryPremortem({ root, requirementId: otherPrepared.requirementId, items: ITEMS });
  const scope = premortemScopeDigest(claim.item.goalId, claim.item.goalStepId,
    claim.item.queueId, claim.item.attempts);
  const pointer = join(dirname(dirname(firstPrepared.path)), "delivery-premortem-index",
    scope, `${firstPrepared.laneDigest}.json`);
  await writeFile(pointer, "{not-json\n", "utf8");
  const allowed = await runHook(preWrite(root, agentId, claim.item,
    otherSession.sessionId, planDefinitionsDigest, "write:uncertain:two"));
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.writeIntent, "degraded");
});
