import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertEntity } from "../src/lib/graph.js";
import { applyPersonaRoster } from "../src/lib/persona-runtime.js";
import {
  preparePremortemRequirement, recordDeliveryPremortem, recordPremortemWrite, verifyPremortemStop
} from "../src/lib/delivery-premortem.js";
import { assignGoal, setGatewayControl } from "../src/lib/gateway-runtime.js";

export const PREMORTEM_ITEMS = [
  { category: "baseline-environment", failure: "this delivery fails because the baseline changed",
    checkId: "baseline", check: "Compare the exact synthetic baseline digest." },
  { category: "contract-tests", failure: "this delivery fails because the contract regressed",
    checkId: "tests", check: "Run the synthetic contract test." },
  { category: "delivery-path", failure: "this delivery fails because the output path is wrong",
    checkId: "path", check: "Verify the bounded delivery path." }
];

export async function premortemGoalFixture(t, host = "codex") {
  const root = await mkdtemp(join(tmpdir(), "agentspine-goal-premortem-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-goal-premortem-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
  });
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n");
  await upsertEntity({ root, id: "project:premortem", kind: "project", privacy: "shared" });
  await upsertEntity({ root, id: "group:premortem", kind: "group", privacy: "shared" });
  const roster = await applyPersonaRoster({ root, bindings: [{
    id: "persona-binding:premortem", authenticator: "host-manifest", issuer: "host:local",
    tenantId: "tenant:premortem", host, profileId: `profile:${host}`,
    subjectId: "subject:premortem", kind: "agent", displayName: "Synthetic Agent",
    sourceBinding: `.${host}/agents/synthetic.md`, groupId: "group:premortem"
  }], confirmation: "local-owner-confirmed", now: "2032-02-01T00:00:00.000Z" });
  await setGatewayControl({ root, enabled: true, killSwitch: false,
    confirmation: "local-owner-confirmed", now: "2032-02-01T00:00:00.100Z" });
  return { root, agentId: roster.runtime.personas[0].personaId };
}

export async function assignPremortemPlan(root, agentId, goalId, now = "2032-02-01T00:00:01.000Z") {
  return assignGoal({ root, goalId, agentId, ownerSubjectId: "subject:owner",
    projectId: "project:premortem", groupId: "group:premortem",
    successCriterion: "The synthetic delivery is verified.", steps: [{
      stepId: "step:deliver", title: "Deliver the synthetic artifact.",
      successCriterion: "The exact synthetic check passes.", dependsOn: []
    }], confirmation: "local-owner-confirmed", now });
}

export function premortemGoalBinding(item, sessionId = "session:premortem") {
  return {
    host: item.host || "codex", sessionId, projectId: item.projectId,
    entityId: item.agentId, groupId: item.groupId, taskId: null,
    goalId: item.goalId, goalStepId: item.goalStepId, queueId: item.queueId,
    gatewayAttempt: item.attempts,
    planDefinitionsDigest: item.goal?.plan?.definitionsDigest || item.planDefinitionsDigest
  };
}

export async function closeGoalPremortem(root, bound, suffix = "", items = PREMORTEM_ITEMS, result = null) {
  const prepared = await preparePremortemRequirement({ root, binding: bound,
    now: "2032-02-01T00:00:02.000Z" });
  const recorded = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId,
    items, now: "2032-02-01T00:00:02.100Z" });
  const written = await recordPremortemWrite({ root, binding: bound, input: { tool_use_id: `write${suffix}` },
    success: true, now: "2032-02-01T00:00:02.200Z" });
  const message = [
    `Premortem closure sha256 ${recorded.digest}`,
    `Premortem latest write sha256 ${written.writeDigest}`,
    ...recorded.artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — ${result || `synthetic ${item.category} check passed`}`)
  ].join("\n");
  const closed = await verifyPremortemStop({ root, binding: bound, message,
    now: "2032-02-01T00:00:02.300Z" });
  assert.equal(closed.status, "closed", JSON.stringify(closed));
  return closed;
}
