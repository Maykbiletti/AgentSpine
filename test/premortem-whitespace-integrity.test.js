import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliveryPremortemPath, preparePremortemRequirement, recordDeliveryPremortem,
  recordPremortemWrite, verifyPremortemBeforeWrite, verifyPremortemStop
} from "../src/lib/delivery-premortem.js";
import { validGoalPremortemAttachments } from "../src/lib/gateway-premortem.js";
import { claimGatewayWork, completeGatewayRun, loadGatewayRuntime, markGatewayHostStarted } from "../src/lib/gateway-runtime.js";
import { assignPremortemPlan, closeGoalPremortem, premortemGoalBinding,
  premortemGoalFixture } from "./goal-premortem-fixture.js";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const digest = (value) => createHash("sha256")
  .update(typeof value === "string" ? value : canonical(value)).digest("hex");
function reseal(value, key = "digest") {
  delete value[key];
  value[key] = digest(value);
}
function items() {
  return [
    { category: "baseline-environment", failure: "this delivery fails because the baseline changed",
      check: "Compare the exact synthetic baseline digest." },
    { category: "contract-tests", failure: "this delivery fails because the contract regressed",
      check: "Run the focused synthetic contract test." },
    { category: "delivery-path", failure: "this delivery fails because the artifact is misplaced",
      check: "Verify the synthetic delivery path and digest." }
  ];
}
function closure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) => `- ${item.category} ${item.checkId}: PASS — synthetic result`)
  ].join("\n");
}

test("a resealed persisted closure rejects a whitespace-only check result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-premortem-whitespace-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "agentspine-premortem-whitespace-state-"));
  const prior = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  t.after(async () => {
    if (prior === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = prior;
    await Promise.all([rm(root, { recursive: true, force: true }),
      rm(stateRoot, { recursive: true, force: true })]);
  });
  const binding = { host: "codex", sessionId: "session:whitespace-state",
    projectId: "project:synthetic" };
  const requirement = await preparePremortemRequirement({ root, binding });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: items() });
  const written = await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:whitespace-state" } });
  assert.equal((await verifyPremortemStop({ root, binding,
    message: closure(recorded.artifact, written.writeDigest) })).status, "closed");
  const path = await deliveryPremortemPath({ root, binding });
  const state = JSON.parse(await readFile(path, "utf8"));
  state.closure.checks[0].result = " \t ";
  reseal(state.closure);
  reseal(state, "integrityDigest");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  const verified = await verifyPremortemBeforeWrite({ root, binding });
  assert.equal(verified.status, "mismatch");
  assert.equal(verified.blocked, true);
});

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
  reseal(step.deliveryCheckpoint);
  step.outcomeReceipt.deliveryCheckpointDigest = step.deliveryCheckpoint.digest;
  reseal(step.outcomeReceipt);
}

test("resealed goal checkpoint and outcome reject whitespace-only check results", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:premortem-whitespace");
  const claim = await claimGatewayWork({ root, workerId: "worker:premortem-whitespace",
    now: "2032-02-01T00:00:02.000Z" });
  const before = await loadGatewayRuntime(root);
  const binding = premortemGoalBinding({ ...claim.item,
    planDefinitionsDigest: before.policy.goals[0].plan.definitionsDigest });
  await closeGoalPremortem(root, binding, ":whitespace");
  await markGatewayHostStarted({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
    claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    now: "2032-02-01T00:00:02.500Z" });
  await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: "worker:premortem-whitespace", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, result: { completed: true },
    now: "2032-02-01T00:00:03.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const goal = loaded.policy.goals[0];
  const step = structuredClone(goal.plan.steps[0]);
  step.deliveryCheckpoint.checkResults[0].result = " \t ";
  step.outcomeReceipt.checkResults[0].result = " \t ";
  resealGoalAttachments(step);
  assert.equal(validGoalPremortemAttachments(step, goal, root,
    goal.plan.definitionsDigest), false);
});
