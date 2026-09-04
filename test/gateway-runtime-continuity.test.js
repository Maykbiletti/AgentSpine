import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignGoal, completeGatewayRun, gatewayContext, gatewayRuntimeFindings,
  loadGatewayRuntime, reconcileGateway, resolveGoalKnowledgeGap
} from "../src/lib/gateway-runtime.js";
import { claimReadOnlyGatewayWork } from "./gateway-claim-fixture.js";
import { persistLegacyGoalPolicy, writeLegacyGatewayPolicy } from "./legacy-goal-fixture.js";
import { runWorkerTick } from "../src/worker.js";
import { fixture } from "./gateway-runtime-fixture.js";

test("pre-team goal plans retain their lead-agent routing after upgrade", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:legacy-plan", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "The legacy synthetic gate passes.",
    steps: [{ stepId: "step:legacy", title: "Run legacy step.", successCriterion: "Legacy step passes.", dependsOn: [] }],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });
  await persistLegacyGoalPolicy(root, "goal:legacy-plan");
  const loaded = await loadGatewayRuntime(root);
  for (const step of loaded.policy.goals[0].plan.steps) {
    delete step.resources; delete step.execution; delete step.executionOutcomes; delete step.premortemContractVersion;
  }
  let definitions = loaded.policy.goals[0].plan.steps.map(({ stepId, agentId, title, successCriterion, dependsOn }) => ({
    stepId, agentId, title, successCriterion, dependsOn
  }));
  loaded.policy.goals[0].plan.definitionsDigest = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
  await writeLegacyGatewayPolicy(loaded.gatewayPolicyPath, loaded.policy);
  assert.deepEqual(gatewayRuntimeFindings((await loadGatewayRuntime(root)).policy, loaded.runtime), []);

  for (const step of loaded.policy.goals[0].plan.steps) delete step.agentId;
  definitions = loaded.policy.goals[0].plan.steps.map(({ stepId, title, successCriterion, dependsOn }) => ({
    stepId, title, successCriterion, dependsOn
  }));
  loaded.policy.goals[0].plan.definitionsDigest = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
  await writeLegacyGatewayPolicy(loaded.gatewayPolicyPath, loaded.policy);
  const upgraded = await loadGatewayRuntime(root);
  assert.deepEqual(gatewayRuntimeFindings(upgraded.policy, upgraded.runtime), []);
  const claim = await claimReadOnlyGatewayWork({ root, workerId: "worker:legacy", now: "2032-01-01T00:00:02.000Z" });
  assert.equal(claim.item.agentId, agentId);
  assert.equal(claim.item.goalStepId, "step:legacy");
});
test("goal plans reject dependency cycles, definition drift, and stale-step completion", async (t) => {
  const { root, agentId } = await fixture(t);
  const base = {
    root, agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "Synthetic plan remains bound.", confirmation: "local-owner-confirmed"
  };
  await assert.rejects(assignGoal({ ...base, goalId: "goal:cycle", steps: [
    { stepId: "step:a", title: "Step A.", successCriterion: "A passes.", dependsOn: ["step:b"] },
    { stepId: "step:b", title: "Step B.", successCriterion: "B passes.", dependsOn: ["step:a"] }
  ] }), /acyclic dependency graph/i);
  await assignGoal({ ...base, goalId: "goal:bound", steps: [
    { stepId: "step:first", title: "First bounded step.", successCriterion: "First passes.", dependsOn: [] },
    { stepId: "step:second", title: "Second bounded step.", successCriterion: "Second passes.", dependsOn: ["step:first"] }
  ], now: "2032-01-01T00:00:01.000Z" });
  const claim = await claimReadOnlyGatewayWork({ root, workerId: "worker:stale", now: "2032-01-01T00:00:02.000Z" });
  await persistLegacyGoalPolicy(root, "goal:bound");
  const loaded = await loadGatewayRuntime(root);
  const originalPolicy = structuredClone(loaded.policy);
  const goal = loaded.policy.goals[0];
  goal.plan.steps[0].status = "completed"; goal.plan.steps[0].completedAt = "2032-01-01T00:00:02.500Z";
  goal.plan.steps[0].completedByQueueId = claim.item.queueId;
  goal.plan.steps[1].status = "active"; goal.plan.steps[1].updatedAt = "2032-01-01T00:00:02.500Z";
  goal.plan.currentStepId = "step:second"; goal.nextSafeStep = goal.plan.steps[1].title; goal.updatedAt = "2032-01-01T00:00:02.500Z";
  await writeLegacyGatewayPolicy(loaded.gatewayPolicyPath, loaded.policy);
  await assert.rejects(completeGatewayRun({ root, queueId: claim.item.queueId, workerId: "worker:stale", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { completed: true, readOnly: true }, now: "2032-01-01T00:00:03.000Z" }), /not bound to the current active goal step/i);

  originalPolicy.goals[0].plan.steps[0].title = "Drifted definition.";
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(originalPolicy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});

test("an objective knowledge gap pauses one plan step, asks once, and resumes with bound owner context", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const steps = [{
    stepId: "step:regional-check", title: "Run the bounded regional check.",
    successCriterion: "The selected synthetic region passes the independent check.", dependsOn: []
  }];
  const assignment = {
    root, goalId: "goal:knowledge-gap", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The regional check uses explicitly resolved context.", steps,
    confirmation: "local-owner-confirmed"
  };
  await assignGoal({ ...assignment, now: "2032-01-01T00:00:01.000Z" });
  const paused = await runWorkerTick({ root, workerId: "worker:gap", now: "2032-01-01T00:00:02.000Z",
    hostRunner: async () => ({
      checkpoint: { inspected: true },
      knowledgeGap: {
        question: "Which synthetic region should the bounded check use?",
        reason: "The success criterion requires a region, but the plan and checkpoint contain none.",
        requiredEvidence: "owner-input"
      }
    }), adapter: { send: async () => ({ ok: true }) } });
  assert.equal(paused.status, "needs-clarification");
  assert.equal(paused.clarification.status, "open");
  assert.equal(paused.clarification.answer, null);

  await reconcileGateway({ root, now: "2032-01-01T00:00:02.250Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.500Z" });
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "blocked");
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 0);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "knowledge-gap-opened").length, 1);
  await assert.rejects(assignGoal({ ...assignment, now: "2032-01-01T00:00:02.750Z" }), /open knowledge gap/i);

  const resolutions = await Promise.all(Array.from({ length: 6 }, () => resolveGoalKnowledgeGap({
    root, goalId: "goal:knowledge-gap", gapId: paused.clarification.gapId,
    answer: "Use synthetic-region-west.", answerSource: "owner-input",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:03.000Z"
  })));
  assert.equal(resolutions.filter((item) => item.duplicate === false).length, 1);
  assert.equal(resolutions.filter((item) => item.duplicate === true).length, 5);
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending" && item.goalStepId === "step:regional-check").length, 1);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "knowledge-gap-resolved").length, 1);

  let observedGap = null;
  const resumed = await runWorkerTick({ root, workerId: "worker:gap-resumed", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async (item) => {
      observedGap = item.goalStep.knowledgeGaps[0];
      return { checkpoint: { regionChecked: true }, completed: true, readOnly: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(resumed.status, "completed");
  assert.equal(observedGap.answer, "Use synthetic-region-west.");
  assert.equal(observedGap.authority, "context-only");
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.deepEqual((await gatewayContext({ root, agentId: "agent:foreign" })).goals, []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);
});

test("objective questions require repository-first self-help and reject state tampering or repetition", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:observed-gap", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "A synthetic observation selects the bounded input.",
    steps: [{ stepId: "step:observe-input", title: "Select the observed input.",
      successCriterion: "The input is bound to an objective observation.", dependsOn: [] }],
    confirmation: "local-owner-confirmed"
  });
  const claim = await claimReadOnlyGatewayWork({ root, workerId: "worker:observed-gap" });
  const deferred = await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: "worker:observed-gap", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { readOnly: true, knowledgeGap: {
      question: "Which synthetic fixture produced the green observation?",
      reason: "The fixture identity is absent from the current objective result.",
      requiredEvidence: "objective-observation"
    } } });
  assert.equal(deferred.clarification, null);
  assert.equal(deferred.selfHelpRequired.requirement.authority, "context-only-research");

  const loaded = await loadGatewayRuntime(root);
  const original = structuredClone(loaded.policy);
  loaded.policy.goals[0].plan.steps[0].selfHelpRequirements[0].question = "Tampered question.";
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(original, null, 2)}\n`);

  const repeatedClaim = await claimReadOnlyGatewayWork({ root, workerId: "worker:repeated-gap" });
  const repeated = await completeGatewayRun({ root, queueId: repeatedClaim.item.queueId,
    workerId: "worker:repeated-gap", claimedAt: repeatedClaim.item.lease.claimedAt, attempt: repeatedClaim.item.attempts, result: { readOnly: true, knowledgeGap: {
      question: "Which synthetic fixture produced the green observation?",
      reason: "The fixture identity is absent from the current objective result.",
      requiredEvidence: "owner-input"
    } } });
  assert.equal(repeated.item.status, "blocked");
  const final = await loadGatewayRuntime(root);
  assert.equal(final.policy.goals[0].status, "blocked");
  assert.equal(final.policy.goals[0].plan.steps[0].knowledgeGaps.length, 0);
  assert.equal(final.runtime.receipts.filter((item) => item.kind === "self-help-requirement-regression").length, 1);
});

test("goal-assign CLI reads a bounded plan without changing its source bytes", async (t) => {
  const { root, agentId } = await fixture(t);
  const planPath = join(root, "synthetic-goal-plan.json");
  const planBytes = `${JSON.stringify({ steps: [
    { stepId: "step:cli-one", title: "Run the first CLI step.", successCriterion: "First CLI gate passes.", dependsOn: [] },
    { stepId: "step:cli-two", title: "Run the second CLI step.", successCriterion: "Second CLI gate passes.", dependsOn: ["step:cli-one"] }
  ] }, null, 2)}\n`;
  await writeFile(planPath, planBytes);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "goal-assign", "goal:cli-plan", "--root", root,
    "--agent", agentId, "--owner", "subject:owner", "--project", "project:alpha", "--group", "group:alpha",
    "--success", "Both CLI gates pass.", "--plan", planPath, "--confirm-local-goal", "--json"], {
    encoding: "utf8", env: process.env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).goal.plan.currentStepId, "step:cli-one");
  let observedStep = null;
  await runWorkerTick({ root, workerId: "worker:cli-plan", now: "2032-01-01T00:00:03.000Z",
    hostRunner: async (item) => {
      observedStep = item.goalStep;
      return { checkpoint: { cli: true }, completed: false };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(observedStep.stepId, "step:cli-one");
  assert.equal(observedStep.successCriterion, "First CLI gate passes.");
  assert.equal(await readFile(planPath, "utf8"), planBytes);
});

