import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  inspectDeliveryPremortems, preparePremortemRequirement, recordDeliveryPremortem,
  recordPremortemWrite, recordPremortemWriteIntent
} from "../src/lib/delivery-premortem.js";
import {
  claimGatewayWork, completeGatewayRun, loadGatewayRuntime, markGatewayHostStarted
} from "../src/lib/gateway-runtime.js";
import { GOAL_PREMORTEM_CONTRACT, planDefinitionMaterial, validGoalPremortemAttachments,
  validPlanPremortemContract } from "../src/lib/gateway-premortem.js";
import { premortemBinding } from "../src/lib/hook-premortem.js";
import { runWorkerTick } from "../src/worker.js";
import { assignPremortemPlan as assignPlan, closeGoalPremortem as closePremortem,
  PREMORTEM_ITEMS as ITEMS, premortemGoalBinding as binding,
  premortemGoalFixture as fixture } from "./goal-premortem-fixture.js";
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}
async function markHost(root, claim, now = "2032-02-01T00:00:02.500Z") {
  return markGatewayHostStarted({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
    claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, now });
}
function resealGoalAttachments(step) {
  for (const value of [step.deliveryCheckpoint, step.outcomeReceipt]) {
    value.sourceAttachmentDigest = digest({ schema: "agentspine.goal-premortem-attachment/v1",
      goalId: value.goalId, goalStepId: value.goalStepId, queueId: value.queueId,
      gatewayAttempt: value.gatewayAttempt, planDefinitionsDigest: value.planDefinitionsDigest,
      laneDigest: value.bindingDigest, sessionDigest: value.sessionDigest, host: value.host,
      projectId: value.projectId, entityId: value.entityId, groupId: value.groupId,
      taskId: value.taskId, lastWriteDigest: value.lastWriteDigest,
      premortemText: value.premortemText, premortemDigest: value.premortemDigest,
      checkResults: value.checkResults, closureDigest: value.closureDigest, authority: value.authority });
  }
  delete step.deliveryCheckpoint.digest;
  step.deliveryCheckpoint.digest = digest(step.deliveryCheckpoint);
  step.outcomeReceipt.deliveryCheckpointDigest = step.deliveryCheckpoint.digest;
  delete step.outcomeReceipt.digest;
  step.outcomeReceipt.digest = digest(step.outcomeReceipt);
  return step;
}
test("goal completion attaches the exact closed premortem without changing the caller checkpoint", async (t) => {
  const { root, agentId } = await fixture(t, "claude");
  await assignPlan(root, agentId, "goal:premortem-success");
  const callerCheckpoint = { nested: { exact: true }, order: [3, 1, 2] };
  let observedEnvironment, observedBinding;
  const result = await runWorkerTick({ root, workerId: "worker:premortem-success",
    now: "2032-02-01T00:00:02.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => {
      observedEnvironment = item.hostEnvironment;
      observedBinding = premortemBinding({ session_id: "session:premortem" }, {
        host: item.host, projectId: item.projectId, entityId: item.agentId,
        groupId: item.groupId, currentTaskId: "task:unrelated-host-state",
        goalId: item.goalId, goalStepId: item.goalStepId, queueId: item.queueId,
        gatewayAttempt: item.attempts, planDefinitionsDigest: item.goal.plan.definitionsDigest
      });
      await closePremortem(root, observedBinding);
      return { checkpoint: callerCheckpoint, completed: true };
    } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const staleWrite = await recordPremortemWriteIntent({ root, binding: observedBinding,
    input: { tool_use_id: "write:after-consume" } });
  assert.equal(staleWrite.status, "finalized");
  assert.equal(staleWrite.blocked, true);
  const competing = await preparePremortemRequirement({ root,
    binding: { ...observedBinding, sessionId: "session:after-finalization" } });
  assert.equal(competing.status, "finalized");
  assert.equal(competing.blocked, true);
  assert.equal((await inspectDeliveryPremortems(root, { includeHistory: false })).states.length, 1);
  assert.equal(observedEnvironment.AGENTSPINE_HOST, "claude");
  assert.equal(observedEnvironment.AGENTSPINE_GATEWAY_QUEUE_ID.startsWith("gateway-queue:"), true);
  assert.equal(observedEnvironment.AGENTSPINE_GATEWAY_ATTEMPT, "1");
  assert.equal(observedEnvironment.AGENTSPINE_GOAL_ID, "goal:premortem-success");
  assert.equal(observedEnvironment.AGENTSPINE_GOAL_STEP_ID, "step:deliver");
  assert.match(observedEnvironment.AGENTSPINE_PLAN_DEFINITIONS_DIGEST, /^[a-f0-9]{64}$/);
  const { policy } = await loadGatewayRuntime(root);
  const step = policy.goals[0].plan.steps[0];
  assert.equal(step.premortemContractVersion, 1);
  assert.equal(policy.goals[0].plan.premortemContract, GOAL_PREMORTEM_CONTRACT);
  assert.equal(validPlanPremortemContract(policy.goals[0].plan, 1), true);
  assert.equal(policy.goals[0].plan.definitionsDigest, createHash("sha256")
    .update(JSON.stringify(planDefinitionMaterial(policy.goals[0].plan.steps))).digest("hex"));
  assert.equal(policy.goals[0].plan.definitionsDigest,
    observedEnvironment.AGENTSPINE_PLAN_DEFINITIONS_DIGEST);
  assert.deepEqual(step.checkpoint, callerCheckpoint);
  assert.equal(step.deliveryCheckpoint.premortemText.split("\n").length, 3);
  assert.deepEqual(step.deliveryCheckpoint.checkResults.map((item) => item.status), ["PASS", "PASS", "PASS"]);
  assert.equal(step.outcomeReceipt.deliveryCheckpointDigest, step.deliveryCheckpoint.digest);
  assert.equal(step.outcomeReceipt.premortemDigest, step.deliveryCheckpoint.premortemDigest);
  assert.equal(step.deliveryCheckpoint.planDefinitionsDigest,
    observedEnvironment.AGENTSPINE_PLAN_DEFINITIONS_DIGEST);
  assert.match(step.deliveryCheckpoint.sessionDigest, /^[a-f0-9]{64}$/);
  assert.match(step.deliveryCheckpoint.bindingDigest, /^[a-f0-9]{64}$/);
  assert.match(step.deliveryCheckpoint.lastWriteDigest, /^[a-f0-9]{64}$/);
  assert.equal(step.deliveryCheckpoint.gatewayAttempt, 1);
  assert.equal(step.deliveryCheckpoint.taskId, null,
    "mutable host task discovery is not persisted in the goal premortem lane");
  assert.equal(step.outcomeReceipt.lastWriteDigest, step.deliveryCheckpoint.lastWriteDigest);
  assert.equal(JSON.stringify(step.deliveryCheckpoint).includes("session:premortem"), false);
});
test("a closed premortem with mismatching plan and persona bindings blocks normal completion", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-mismatch");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-mismatch",
    now: "2032-02-01T00:00:02.000Z" });
  const wrongBinding = { ...binding({ ...claim.item, planDefinitionsDigest: "0".repeat(64) }),
    entityId: "agent:foreign", groupId: "group:foreign" };
  await closePremortem(root, wrongBinding, ":mismatch");
  await markHost(root, claim);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-mismatch", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { checkpoint: { done: true }, completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "mismatch");
  const after = await loadGatewayRuntime(root);
  assert.equal(after.policy.goals[0].status, "blocked");
  assert.equal(after.policy.goals[0].plan.steps[0].deliveryCheckpoint, undefined);
});
test("an exact queue with a recorded write but no closure blocks completion", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-unclosed");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-unclosed",
    now: "2032-02-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const bound = binding({ ...claim.item, planDefinitionsDigest: loaded.policy.goals[0].plan.definitionsDigest });
  const prepared = await preparePremortemRequirement({ root, binding: bound });
  await recordDeliveryPremortem({ root, requirementId: prepared.requirementId, items: ITEMS });
  await recordPremortemWrite({ root, binding: bound, input: { tool_use_id: "write:unclosed" }, success: true });
  await markHost(root, claim);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-unclosed", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { checkpoint: { done: true }, completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "missing");
});
test("a rejected registration after closure preserves goal completion", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-conflict");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-conflict",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  const closed = await closePremortem(root, binding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }), ":conflict");
  const changed = ITEMS.map(({ category, failure, check }) => ({ category, failure, check }));
  changed[0].check = "Compare a conflicting synthetic baseline digest.";
  const conflict = await recordDeliveryPremortem({ root, requirementId: closed.requirementId,
    items: changed });
  assert.equal(conflict.status, "conflict");
  await markHost(root, claim);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-conflict", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { checkpoint: { done: true }, completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "completed");
  assert.equal(completed.premortemReview.status, "closed");
});
test("a closed written lane cannot be relabelled read-only", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-false-read");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-false-read",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  await closePremortem(root, binding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }), ":false-read");
  await markHost(root, claim);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-false-read", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { completed: true, readOnly: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "mismatch");
});
test("sealed goal premortem siblings fail closed on tampering", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-tamper");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-tamper",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  const bound = binding({ ...claim.item, planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest });
  await closePremortem(root, bound, ":tamper");
  await markHost(root, claim);
  await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: "worker:premortem-tamper", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { checkpoint: { verified: true }, completed: true }, now: "2032-02-01T00:00:03.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const original = loaded.policy.goals[0].plan.steps[0];
  const jwt = structuredClone(original);
  const unsafeLine = "this delivery fails because eyJabcdefghijk.eyJabcdefghijk.abcdefghijk entered context Check: inspect it";
  jwt.deliveryCheckpoint.premortemText = jwt.outcomeReceipt.premortemText = [unsafeLine,
    ...jwt.deliveryCheckpoint.premortemText.split("\n").slice(1)].join("\n");
  resealGoalAttachments(jwt);
  assert.equal(validGoalPremortemAttachments(jwt, loaded.policy.goals[0], root,
    loaded.policy.goals[0].plan.definitionsDigest), false);
  const credential = structuredClone(original);
  credential.deliveryCheckpoint.checkResults[0].result = "token=abcdefghijklmnopqrstuvwxyz123456";
  credential.outcomeReceipt.checkResults[0].result = "token=abcdefghijklmnopqrstuvwxyz123456";
  resealGoalAttachments(credential);
  assert.equal(validGoalPremortemAttachments(credential, loaded.policy.goals[0], root,
    loaded.policy.goals[0].plan.definitionsDigest), false);
  assert.equal(validGoalPremortemAttachments(original, loaded.policy.goals[0], `${root}-foreign`,
    loaded.policy.goals[0].plan.definitionsDigest), false);
  const foreignGoal = { ...loaded.policy.goals[0], projectId: "project:foreign", groupId: "group:foreign" };
  assert.equal(validGoalPremortemAttachments(original, foreignGoal, root,
    loaded.policy.goals[0].plan.definitionsDigest), false);
  const injected = structuredClone(original);
  injected.deliveryCheckpoint.injectedSecret = injected.outcomeReceipt.injectedSecret = "password is synthetic-secret";
  resealGoalAttachments(injected);
  assert.equal(validGoalPremortemAttachments(injected, loaded.policy.goals[0], root,
    loaded.policy.goals[0].plan.definitionsDigest), false);
  const extendedCheck = structuredClone(original);
  extendedCheck.deliveryCheckpoint.checkResults[0].permission = true;
  extendedCheck.outcomeReceipt.checkResults[0].permission = true;
  resealGoalAttachments(extendedCheck);
  assert.equal(validGoalPremortemAttachments(extendedCheck, loaded.policy.goals[0], root,
    loaded.policy.goals[0].plan.definitionsDigest), false);
  loaded.policy.goals[0].plan.steps[0].outcomeReceipt.checkResults[0].result = "forged";
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});
test("a completed v1 step fails closed when both premortem siblings are deleted", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-delete");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-delete",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  await closePremortem(root, binding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }), ":delete");
  await markHost(root, claim);
  await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: "worker:premortem-delete", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { checkpoint: { verified: true }, completed: true }, now: "2032-02-01T00:00:03.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const downgraded = structuredClone(loaded.policy);
  delete downgraded.goals[0].plan.premortemContractVersion;
  delete downgraded.goals[0].plan.premortemContract;
  delete downgraded.goals[0].plan.steps[0].premortemContractVersion;
  delete downgraded.goals[0].plan.steps[0].deliveryCheckpoint;
  delete downgraded.goals[0].plan.steps[0].outcomeReceipt;
  downgraded.goals[0].plan.definitionsDigest = createHash("sha256")
    .update(JSON.stringify(planDefinitionMaterial(downgraded.goals[0].plan.steps))).digest("hex");
  delete downgraded.premortemContractRegistry;
  downgraded.schema = "agentspine.gateway-policy/v1";
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(downgraded, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
  delete loaded.policy.goals[0].plan.steps[0].deliveryCheckpoint;
  delete loaded.policy.goals[0].plan.steps[0].outcomeReceipt;
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});
test("an explicitly read-only v1 completion needs no premortem lane", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-no-hook");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-no-hook",
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-no-hook", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { completed: true, readOnly: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "completed");
  assert.equal(completed.premortemReview.status, "read-only");
  const loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].plan.steps[0].deliveryCheckpoint.status, "read-only");
  const lateRequirement = await preparePremortemRequirement({ root, binding: binding({ ...claim.item,
    planDefinitionsDigest: loaded.policy.goals[0].plan.definitionsDigest }, "session:late-write") });
  assert.equal(lateRequirement.status, "finalized");
  assert.equal(lateRequirement.blocked, true);
});
test("a v1 completion without a lane or read-only result blocks", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-no-hook-write");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-no-hook-write",
    now: "2032-02-01T00:00:02.000Z" });
  await markHost(root, claim);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-no-hook-write", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "missing");
});
test("a prepared read-only lane blocks completion when the explicit result is omitted", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-read-omitted");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-read-omitted",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  await preparePremortemRequirement({ root, binding: binding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }) });
  await markHost(root, claim);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-read-omitted", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "missing");
});
test("a v1 read-only goal step stores sealed nonblocking disposition siblings", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-legacy");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-read",
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  await preparePremortemRequirement({ root, binding: binding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }) });
  const progress = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-read", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { checkpoint: { inspected: true }, completed: true, readOnly: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(progress.item.status, "completed");
  const loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps[0].checkpoint, { inspected: true });
  const step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(step.premortemContractVersion, 1);
  assert.equal(step.deliveryCheckpoint.status, "read-only");
  assert.equal(step.deliveryCheckpoint.gatewayAttempt, 1);
  assert.equal(step.outcomeReceipt.status, "read-only");
  assert.equal(step.outcomeReceipt.deliveryCheckpointDigest, step.deliveryCheckpoint.digest);
  assert.equal(validGoalPremortemAttachments(step, loaded.policy.goals[0], `${root}-foreign`,
    loaded.policy.goals[0].plan.definitionsDigest), false);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "# Synthetic rules\n");
});

test("a foreign prepared read-only lane cannot satisfy the exact goal binding", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-read-foreign");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-read-foreign",
    executionMode: "read-only", now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  const foreign = { ...binding({ ...claim.item, planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }),
    host: "claude", projectId: "project:foreign", entityId: "agent:foreign",
    groupId: "group:foreign", planDefinitionsDigest: "0".repeat(64) };
  await preparePremortemRequirement({ root, binding: foreign });
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-read-foreign", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { completed: true, readOnly: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "mismatch");
});

test("an unreadable exact premortem index fails open with a sealed degraded disposition", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-degraded");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-degraded",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  const prepared = await preparePremortemRequirement({ root, binding: binding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }) });
  const indexRoot = join(dirname(dirname(prepared.path)), "delivery-premortem-index");
  const [scope] = await readdir(indexRoot);
  const [pointer] = await readdir(join(indexRoot, scope));
  await writeFile(join(indexRoot, scope, pointer), "{not-json\n");
  await markHost(root, claim);
  const progress = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-degraded", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { checkpoint: { inspected: true }, completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(progress.item.status, "completed");
  assert.equal(progress.premortemReview.status, "degraded");
  const loaded = await loadGatewayRuntime(root);
  const step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(step.deliveryCheckpoint.status, "degraded-fail-open");
  assert.equal(step.deliveryCheckpoint.gatewayAttempt, 1);
  assert.equal(step.outcomeReceipt.deliveryCheckpointDigest, step.deliveryCheckpoint.digest);
});

test("a well-formed tampered premortem pointer blocks goal completion", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-pointer-tamper");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-pointer-tamper",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  const prepared = await preparePremortemRequirement({ root, binding: binding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest }) });
  const indexRoot = join(dirname(dirname(prepared.path)), "delivery-premortem-index");
  const [scope] = await readdir(indexRoot);
  const [name] = await readdir(join(indexRoot, scope));
  const path = join(indexRoot, scope, name);
  const pointer = JSON.parse(await readFile(path, "utf8"));
  pointer.planDefinitionsDigest = "0".repeat(64);
  await writeFile(path, `${JSON.stringify(pointer, null, 2)}\n`);
  await markHost(root, claim);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-pointer-tamper", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  assert.equal(completed.item.status, "blocked");
  assert.equal(completed.premortemReview.status, "mismatch");
});

test("a host error after an open attempt blocks replay of that attempt", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-retry");
  const attempts = [];
  const first = await runWorkerTick({ root, workerId: "worker:premortem-retry:one",
    now: "2032-02-01T00:00:02.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => {
      attempts.push([item.attempts, item.hostEnvironment.AGENTSPINE_GATEWAY_ATTEMPT]);
      const bound = binding(item, "session:premortem-retry:one");
      const prepared = await preparePremortemRequirement({ root, binding: bound });
      await recordDeliveryPremortem({ root, requirementId: prepared.requirementId, items: ITEMS });
      await recordPremortemWrite({ root, binding: bound,
        input: { tool_use_id: "write:retry:one" }, success: true });
      throw new Error("synthetic crash after the first write");
    } });
  assert.equal(first.status, "blocked");
  const second = await runWorkerTick({ root, workerId: "worker:premortem-retry:two",
    now: "2032-02-01T00:00:08.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => {
      attempts.push([item.attempts, item.hostEnvironment.AGENTSPINE_GATEWAY_ATTEMPT]);
      await closePremortem(root, binding(item, "session:premortem-retry:two"), ":retry:two");
      return { checkpoint: { recovered: true }, completed: true };
    } });
  assert.equal(second.processed, false, JSON.stringify(second));
  assert.deepEqual(attempts, [[1, "1"]]);
  const loaded = await loadGatewayRuntime(root);
  const step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(step.status, "blocked");
  assert.equal(step.deliveryCheckpoint, undefined);
});

test("maximum valid premortem text boundaries remain accepted", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-boundary");
  const maximumItems = ITEMS.map((item) => ({ category: item.category,
    failure: "this delivery fails because ".padEnd(512, "x"), check: "C".repeat(512) }));
  const completed = await runWorkerTick({ root, workerId: "worker:premortem-boundary",
    now: "2032-02-01T00:00:02.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => {
      await closePremortem(root, binding(item, "session:premortem-boundary"), ":boundary", maximumItems);
      return { checkpoint: { boundary: true }, completed: true };
    } });
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const loaded = await loadGatewayRuntime(root);
  assert.deepEqual(loaded.policy.goals[0].plan.steps[0].deliveryCheckpoint.premortemText
    .split("\n").map((line) => line.length), [1032, 1032, 1032]);
});

test("credential- and JWT-shaped premortem context cannot reach goal persistence", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-sensitive");
  const unsafeItems = ITEMS.map(({ category, failure, check }) => ({ category, failure, check }));
  unsafeItems[0].failure = "this delivery fails because eyJabcdefghijk.eyJabcdefghijk.abcdefghijk entered context";
  const completed = await runWorkerTick({ root, workerId: "worker:premortem-secret",
    now: "2032-02-01T00:00:02.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => {
      const bound = binding(item, "session:premortem-secret");
      const prepared = await preparePremortemRequirement({ root, binding: bound });
      const rejected = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId,
        items: unsafeItems });
      assert.equal(rejected.status, "unsafe");
      await recordPremortemWrite({ root, binding: bound,
        input: { tool_use_id: "write:unsafe" }, success: true });
      return { checkpoint: { unsafe: false }, completed: true };
    } });
  assert.equal(completed.status, "blocked");
  const loaded = await loadGatewayRuntime(root);
  const step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(step.status, "blocked");
  assert.equal(step.deliveryCheckpoint, undefined);
  assert.equal(JSON.stringify(loaded.policy).includes("eyJabcdefghijk"), false);
});

test("a future-dated persisted pre-v1 goal resumes without changing its legacy definitions digest", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:premortem-pre-v1");
  const legacy = await loadGatewayRuntime(root);
  const goal = legacy.policy.goals[0];
  delete goal.plan.steps[0].premortemContractVersion;
  delete goal.plan.premortemContractVersion;
  delete goal.plan.premortemContract;
  delete legacy.policy.premortemContractRegistry;
  legacy.policy.schema = "agentspine.gateway-policy/v1";
  goal.createdAt = "2031-01-01T00:00:00.000Z";
  goal.plan.definitionsDigest = createHash("sha256")
    .update(JSON.stringify(planDefinitionMaterial(goal.plan.steps))).digest("hex");
  const definitionsDigest = goal.plan.definitionsDigest;
  await unlink(join(dirname(legacy.gatewayPolicyPath), "gateway-policy-provenance.json"));
  await writeFile(legacy.gatewayPolicyPath, `${JSON.stringify(legacy.policy, null, 2)}\n`);
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-pre-v1",
    now: "2032-02-01T00:00:02.000Z" });
  await markHost(root, claim);
  await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: "worker:premortem-pre-v1", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { checkpoint: { attempted: true }, blocked: true, blocker: "Synthetic retry required." },
    now: "2032-02-01T00:00:03.000Z" });
  const resumed = await assignPlan(root, agentId, "goal:premortem-pre-v1", "2032-02-01T00:00:04.000Z");
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.goal.plan.definitionsDigest, definitionsDigest);
  assert.equal(resumed.goal.plan.steps[0].premortemContractVersion, undefined);
});
