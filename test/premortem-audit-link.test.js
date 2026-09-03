import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runAudit } from "../src/lib/audit.js";
import { deliveryPremortemPath } from "../src/lib/delivery-premortem.js";
import { inspectPremortemLaneIndexes } from "../src/lib/delivery-premortem-index.js";
import { writeGatewayJson } from "../src/lib/gateway-premortem.js";
import { inspectGatewayRuntime, loadGatewayRuntime } from "../src/lib/gateway-runtime.js";
import { runWorkerTick } from "../src/worker.js";
import {
  assignPremortemPlan,
  closeGoalPremortem,
  premortemGoalBinding,
  premortemGoalFixture
} from "./goal-premortem-fixture.js";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function sourceAttachmentMaterial(value) {
  return { schema: "agentspine.goal-premortem-attachment/v1",
    goalId: value.goalId, goalStepId: value.goalStepId, queueId: value.queueId,
    gatewayAttempt: value.gatewayAttempt, planDefinitionsDigest: value.planDefinitionsDigest,
    laneDigest: value.bindingDigest, sessionDigest: value.sessionDigest, host: value.host,
    projectId: value.projectId, entityId: value.entityId, groupId: value.groupId,
    taskId: value.taskId, lastWriteDigest: value.lastWriteDigest,
    premortemText: value.premortemText, premortemDigest: value.premortemDigest,
    checkResults: value.checkResults, closureDigest: value.closureDigest,
    authority: value.authority };
}

function resealSiblingAttachments(step) {
  const replacement = step.deliveryCheckpoint.lastWriteDigest.startsWith("f")
    ? "e".repeat(64) : "f".repeat(64);
  for (const value of [step.deliveryCheckpoint, step.outcomeReceipt]) {
    value.lastWriteDigest = replacement;
    value.sourceAttachmentDigest = digest(sourceAttachmentMaterial(value));
  }
  delete step.deliveryCheckpoint.digest;
  step.deliveryCheckpoint.digest = digest(step.deliveryCheckpoint);
  step.outcomeReceipt.deliveryCheckpointDigest = step.deliveryCheckpoint.digest;
  delete step.outcomeReceipt.digest;
  step.outcomeReceipt.digest = digest(step.outcomeReceipt);
}

test("audit cross-links sealed goal siblings to the authoritative scope finalization", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  const source = await readFile(join(root, "AGENTS.md"), "utf8");
  await assignPremortemPlan(root, agentId, "goal:audit-source-link");
  let bound;
  const completed = await runWorkerTick({ root, workerId: "worker:audit-source-link",
    now: "2032-02-01T00:00:02.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => {
      bound = premortemGoalBinding(item, "session:audit-source-link");
      await closeGoalPremortem(root, bound, ":audit-source-link");
      return { checkpoint: { verified: true }, completed: true };
    } });
  assert.equal(completed.status, "completed", JSON.stringify(completed));

  const healthy = await runAudit(root);
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.premortemDiagnostics.index.crossReferenceErrors, []);
  const statePath = await deliveryPremortemPath({ root, binding: bound });
  const indexes = await inspectPremortemLaneIndexes(dirname(statePath));
  assert.equal(indexes.finalizations.length, 1);
  const loaded = await loadGatewayRuntime(root);
  const step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(step.deliveryCheckpoint.sourceAttachmentDigest,
    indexes.finalizations[0].attachmentDigest);

  resealSiblingAttachments(step);
  await writeGatewayJson(loaded.gatewayPolicyPath, loaded.policy);
  const acceptedSibling = await inspectGatewayRuntime(root);
  assert.equal(acceptedSibling.errors.length, 0,
    "the independently resealed checkpoint/outcome pair remains structurally valid");
  const tampered = await runAudit(root);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.gates.find((gate) => gate.id === 8).ok, false);
  assert.equal(tampered.premortemDiagnostics.index.crossReferenceErrors.some((finding) =>
    finding.reason === "completed goal premortem source attachment does not match scope finalization"), true);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});
