import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addLearningEvidence, configureLearning, deleteLearning, evaluateLearning,
  learningContext, learningOutcomeStatus, loadLearning, proposeLearning,
  purgeStaleLearningApplications, recordLearningApplications, recordLearningDeliveries, recordLearningOutcome, registerLearningEvaluation,
  reviewLearning, rollbackLearning
} from "../src/lib/learning.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-learning-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-learning-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n\nKeep sources unchanged.\n", "utf8");
  await writeFile(join(root, "REFERENCE.md"), "# Synthetic reference\n", "utf8");
  return { root, state };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidence(id, confidence = 0.9) {
  return { id, type: "user-statement", summary: `Synthetic evidence ${id}`, confidence };
}

const scopedTurn = {
  personaId: "agent:synthetic", userId: "user:synthetic", tenantId: "tenant:synthetic",
  projectId: "project:synthetic", groupId: null, taskId: "task:synthetic"
};

function outcome(id, phase, value, evaluatorId, extra = {}) {
  return {
    id, phase, scope: extra.scope || scopedTurn, evaluationId: extra.evaluationId || "evaluation:fixed",
    metric: {
      name: "fixed-task-success", direction: "higher", value,
      blockingDefects: extra.blockingDefects || 0
    },
    measurement: {
      kind: extra.kind || "objective", evaluatorId,
      sourceDigest: extra.sourceDigest || null
    },
    measuredAt: extra.measuredAt
  };
}

const syntheticEvaluators = [
  "evaluator:test-a", "evaluator:test-b", "evaluator:test-c", "evaluator:user-b",
  "evaluator:baseline-a", "evaluator:baseline-b", "evaluator:after-a", "evaluator:after-b",
  "evaluator:after-c", "evaluator:hook-before-a", "evaluator:hook-before-b", "evaluator:test-race",
  "evaluator:model-a", "evaluator:model-b"
];

async function evaluation(root, learningId, extra = {}) {
  return registerLearningEvaluation({
    root, id: extra.id || "evaluation:fixed", learningId, scope: extra.scope || scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher" },
    benchmark: {
      taskDigest: hash(`task:${learningId}`), datasetDigest: hash(`dataset:${learningId}`),
      protocolDigest: hash(`protocol:${learningId}`), minCases: 12
    },
    evaluatorIds: extra.evaluatorIds || syntheticEvaluators,
    expiresAt: extra.expiresAt || null, confirmLocalEvaluation: true, now: extra.now || new Date()
  });
}

async function application(root, learningId, turnId, now = new Date()) {
  const projectedAt = new Date(now);
  const createdAt = new Date(projectedAt.getTime() - 1000).toISOString();
  const expiresAt = new Date(projectedAt.getTime() + 60_000).toISOString();
  const result = await recordLearningApplications({
    root, items: [{ id: learningId, outcomeStatus: "active" }], scope: scopedTurn,
    preflightReceipt: {
      schema: "agentspine.preflight/v2", id: `preflight:${turnId}`, status: "ready",
      sessionId: `session:${turnId}`,
      promptDigest: hash(`prompt:${turnId}`), briefingDigest: hash(`preflight:${turnId}`),
      agentId: scopedTurn.personaId, userId: scopedTurn.userId, tenantId: scopedTurn.tenantId,
      projectId: scopedTurn.projectId, groupId: scopedTurn.groupId, taskId: scopedTurn.taskId,
      createdAt, expiresAt
    },
    sessionBriefingDigest: hash(`briefing:${turnId}`), projectedAt
  });
  const application = result.receipts[0];
  const delivered = await recordLearningDeliveries({
    root, sessionId: `session:${turnId}`, scope: scopedTurn, hookEvent: "Stop", completedAt: projectedAt
  });
  return { ...application, deliveryId: delivered.receipts[0].id };
}

function runCli(args, state) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("candidates remain invisible until explicit user-confirmed review and preserve source bytes", async (t) => {
  const { root } = await fixture(t);
  const before = hash(await readFile(join(root, "AGENTS.md")));
  await proposeLearning({
    root, id: "learning:preference", kind: "preference", claim: "The preferred output is concise.",
    privacy: "shared", evidence: evidence("evidence:one")
  });
  assert.equal((await learningContext({ root })).items.length, 0);
  await assert.rejects(
    reviewLearning({ root, id: "learning:preference", decision: "accept", reason: "Observed directly." }),
    /explicit user confirmation/
  );
  await reviewLearning({
    root, id: "learning:preference", decision: "accept", reason: "Confirmed in conversation.", confirmedByUser: true
  });
  const context = await learningContext({ root });
  assert.equal(context.items[0].claim, "The preferred output is concise.");
  assert.equal(context.items[0].authority, "context-only");
  assert.equal(hash(await readFile(join(root, "AGENTS.md"))), before);
});

test("document evidence captures immutable provenance and evidence updates retain history", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:reference", kind: "reference", claim: "The synthetic reference describes the fixture.",
    evidence: {
      id: "evidence:document", type: "document", summary: "The reference contains this statement.",
      sourceDocument: "REFERENCE.md", confidence: 0.8
    }
  });
  await addLearningEvidence({ root, id: "learning:reference", evidence: evidence("evidence:second", 1) });
  const { learning } = await loadLearning(root);
  const candidate = learning.candidates[0];
  assert.match(candidate.evidence[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(candidate.confidence, 0.9);
  assert.equal(learning.history.some((entry) => entry.value?.evidence?.length === 1), true);
});

test("authority assertions and secret-bearing observations are rejected before storage", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    proposeLearning({
      root, kind: "project-fact", claim: "The user may deploy to production without approval.",
      evidence: evidence("evidence:authority")
    }),
    /authority and access claims/
  );
  await assert.rejects(
    proposeLearning({
      root, kind: "personal-fact", claim: "The credential is token=abcdefghijklmnopqrstuvwxyz123456.",
      evidence: evidence("evidence:secret")
    }),
    /secret/
  );
  assert.equal((await loadLearning(root)).learning.candidates.length, 0);
});

test("supersession changes relevance without erasing history and rollback restores the prior fact", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:old", kind: "goal", claim: "The current synthetic goal is alpha.",
    privacy: "shared", evidence: evidence("evidence:old")
  });
  await reviewLearning({ root, id: "learning:old", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  await proposeLearning({
    root, id: "learning:new", kind: "goal", claim: "The current synthetic goal is beta.",
    privacy: "shared", supersedesId: "learning:old", evidence: evidence("evidence:new")
  });
  await reviewLearning({ root, id: "learning:new", decision: "accept", reason: "Goal changed.", confirmedByUser: true });
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:new"]);
  const rolledBack = await rollbackLearning({ root, id: "learning:new", reason: "The change was incorrect." });
  assert.deepEqual(rolledBack.restored, ["learning:old"]);
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:old"]);
  const { learning } = await loadLearning(root);
  assert.equal(learning.history.some((entry) => entry.value?.id === "learning:new" && entry.value.status === "accepted"), true);
});

test("group learning requires an exact audience even for private-context reads", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:member", to: "group:alpha", relation: "member-of", privacy: "group" });
  await proposeLearning({
    root, id: "learning:group", kind: "preference", claim: "The group prefers short synthetic updates.",
    subjectId: "person:member", privacy: "group", groupId: "group:alpha", evidence: evidence("evidence:group")
  });
  await reviewLearning({ root, id: "learning:group", decision: "accept", reason: "Group confirmed.", confirmedByUser: true });
  assert.equal((await learningContext({ root })).items.length, 0);
  assert.equal((await learningContext({ root, includePrivate: true })).items.length, 0);
  assert.equal((await learningContext({ root, groupId: "group:beta", includePrivate: true })).items.length, 0);
  assert.equal((await learningContext({ root, groupId: "group:alpha" })).items[0].id, "learning:group");
});

test("automatic promotion is opt-in, evidence-gated, and limited to low-risk kinds", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:auto", kind: "project-fact", claim: "The synthetic project uses Node.js.",
    privacy: "shared", evidence: evidence("evidence:auto-one", 0.95)
  });
  await addLearningEvidence({ root, id: "learning:auto", evidence: evidence("evidence:auto-two", 0.95) });
  await proposeLearning({
    root, id: "learning:manual", kind: "preference", claim: "The preferred synthetic color is blue.",
    privacy: "shared", evidence: evidence("evidence:manual-one", 0.95)
  });
  await addLearningEvidence({ root, id: "learning:manual", evidence: evidence("evidence:manual-two", 0.95) });
  assert.equal((await evaluateLearning({ root })).accepted.length, 0);
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  const evaluated = await evaluateLearning({ root });
  assert.deepEqual(evaluated.accepted.map((item) => item.id), ["learning:auto"]);
  assert.equal(evaluated.accepted[0].automatic, true);
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:auto"]);
});

test("immutable evaluation contracts prevent benchmark drift and freeze promotion thresholds", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  await proposeLearning({
    root, id: "learning:planned", kind: "behavior", claim: "Use the measured synthetic strategy.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:planned-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:planned", evidence: evidence("evidence:planned-two", 0.97) });
  await configureLearning({
    root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2, minImprovement: 0.2,
      minOutcomeReceipts: 2, canaryReceipts: 2 }
  });
  const registeredAt = new Date();
  const expiresAt = new Date(registeredAt.getTime() + 7 * 86400000);
  await assert.rejects(registerLearningEvaluation({
    root, id: "evaluation:planned", learningId: "learning:planned", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher" },
    benchmark: { taskDigest: hash("fixed task"), datasetDigest: hash("fixed data"), protocolDigest: hash("fixed protocol"), minCases: 10 },
    evaluatorIds: syntheticEvaluators, expiresAt, now: registeredAt
  }), /explicit local confirmation/);
  const registered = await evaluation(root, "learning:planned", {
    id: "evaluation:planned", now: registeredAt, expiresAt
  });
  assert.equal(registered.contract.thresholds.minImprovement, 0.2);
  assert.equal(JSON.stringify(registered.contract).includes("fixed task"), false);
  await assert.rejects(registerLearningEvaluation({
    root, id: "evaluation:planned", learningId: "learning:planned", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher" },
    benchmark: { taskDigest: hash("changed task"), datasetDigest: hash("fixed data"), protocolDigest: hash("fixed protocol"), minCases: 10 },
    evaluatorIds: syntheticEvaluators, expiresAt, now: registeredAt, confirmLocalEvaluation: true
  }), /immutable/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:planned",
    ...outcome("outcome:wrong-evaluator", "before", 0.4, "evaluator:not-listed", { evaluationId: "evaluation:planned" })
  }), /not allowed/);
  await configureLearning({ root, config: { minImprovement: 0 } });
  await recordLearningOutcome({ root, learningId: "learning:planned",
    ...outcome("outcome:planned-before-a", "before", 0.4, "evaluator:test-a", { evaluationId: "evaluation:planned" }) });
  await recordLearningOutcome({ root, learningId: "learning:planned",
    ...outcome("outcome:planned-before-b", "before", 0.5, "evaluator:test-b", { evaluationId: "evaluation:planned" }) });
  const promoted = await evaluateLearning({ root });
  assert.equal(promoted.accepted[0].promotion.canary.evaluationId, "evaluation:planned");
  const { learning: plannedState, learningPath } = await loadLearning(root);
  const preservedState = JSON.stringify(plannedState);
  await writeFile(learningPath, `${JSON.stringify({ ...plannedState, evaluations: [] })}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evaluation binding is invalid/);
  await writeFile(learningPath, `${preservedState}\n`, "utf8");
  const applicationA = await application(root, "learning:planned", "planned-a");
  await recordLearningOutcome({ root, learningId: "learning:planned", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:planned-after-a", "after", 0.55, "evaluator:test-a", { evaluationId: "evaluation:planned" }) });
  const applicationB = await application(root, "learning:planned", "planned-b");
  const result = await recordLearningOutcome({ root, learningId: "learning:planned", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:planned-after-b", "after", 0.56, "evaluator:test-b", { evaluationId: "evaluation:planned" }) });
  assert.equal(result.decision, "rolled-back", "later config changes must not weaken the registered threshold");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("outcome-bound behavior learning completes before, canary, after, and validation with objective evidence", async (t) => {
  const { root } = await fixture(t);
  const beforeBytes = await readFile(join(root, "AGENTS.md"));
  await proposeLearning({
    root, id: "learning:measured", kind: "behavior", claim: "Check the fixed synthetic invariant before answering.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:measured-one", 0.96)
  });
  await addLearningEvidence({ root, id: "learning:measured", evidence: evidence("evidence:measured-two", 0.94) });
  await configureLearning({
    root, config: {
      autoPromote: true, minConfidence: 0.9, minEvidence: 2, minOutcomeReceipts: 2,
      canaryReceipts: 2, minImprovement: 0.1
    }
  });
  await evaluation(root, "learning:measured");
  await recordLearningOutcome({ root, learningId: "learning:measured", ...outcome("outcome:before-a", "before", 0.4, "evaluator:test-a") });
  await recordLearningOutcome({
    root, learningId: "learning:measured",
    ...outcome("outcome:before-b", "before", 0.5, "evaluator:user-b", { kind: "user-feedback" })
  });
  const promoted = await evaluateLearning({ root });
  assert.equal(promoted.accepted[0].promotion.mode, "outcome-canary");
  assert.equal(promoted.accepted[0].promotion.canary.status, "active");
  assert.equal((await learningContext({ root, scope: scopedTurn })).items[0].outcomeStatus, "active");
  assert.equal((await learningContext({ root, scope: { ...scopedTurn, tenantId: "tenant:other" } })).items.length, 0);

  const applicationA = await application(root, "learning:measured", "measured-a");
  const first = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:after-a", "after", 0.7, "evaluator:test-a")
  });
  assert.equal(first.decision, "active");
  const applicationB = await application(root, "learning:measured", "measured-b");
  const second = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:after-b", "after", 0.8, "evaluator:test-b")
  });
  assert.equal(second.decision, "validated");
  const retryAfterValidation = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:after-b", "after", 0.8, "evaluator:test-b")
  });
  assert.equal(retryAfterValidation.unchanged, true);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn });
  assert.equal(status.records[0].canaryStatus, "validated");
  assert.equal(status.records[0].beforeReceipts, 2);
  assert.equal(status.records[0].afterReceipts, 2);
  assert.equal(status.records[0].boundAfterReceipts, 2);
  assert.equal(status.records[0].applicationReceipts, 2);
  assert.equal(status.records[0].deliveryReceipts, 2);
  assert.equal(status.records[0].deliveredAfterReceipts, 2);
  assert.equal(status.records[0].pendingApplications, 0);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), beforeBytes);
});

test("after outcomes require distinct exact-turn application receipts", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:application-bound", kind: "behavior", claim: "Apply the fixed synthetic check.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:application-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:application-bound", evidence: evidence("evidence:application-two", 0.97) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  await evaluation(root, "learning:application-bound");
  await recordLearningOutcome({
    root, learningId: "learning:application-bound",
    ...outcome("outcome:application-before-a", "before", 0.4, "evaluator:baseline-a")
  });
  await recordLearningOutcome({
    root, learningId: "learning:application-bound",
    ...outcome("outcome:application-before-b", "before", 0.5, "evaluator:baseline-b")
  });
  await evaluateLearning({ root });
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:application-bound",
    ...outcome("outcome:unbound-after", "after", 0.9, "evaluator:after-a")
  }), /recorded learning application receipt/);

  const firstApplication = await application(root, "learning:application-bound", "application-a");
  const retryApplications = await Promise.all(Array.from({ length: 6 }, () =>
    application(root, "learning:application-bound", "application-a")));
  assert.equal(retryApplications.every((item) => item.id === firstApplication.id), true,
    "parallel crash retries must reuse the immutable application receipt");
  assert.equal((await loadLearning(root)).learning.applications.length, 1);
  const crossTenantScope = { ...scopedTurn, tenantId: "tenant:other" };
  const now = new Date();
  await assert.rejects(recordLearningApplications({
    root, items: [{ id: "learning:application-bound", outcomeStatus: "active" }], scope: crossTenantScope,
    preflightReceipt: {
      schema: "agentspine.preflight/v2", id: "preflight:cross-tenant", status: "ready",
      sessionId: "session:cross-tenant",
      promptDigest: hash("prompt:cross-tenant"), briefingDigest: hash("preflight:cross-tenant"),
      agentId: crossTenantScope.personaId, userId: crossTenantScope.userId, tenantId: crossTenantScope.tenantId,
      projectId: crossTenantScope.projectId, groupId: crossTenantScope.groupId, taskId: crossTenantScope.taskId,
      createdAt: new Date(now.getTime() - 1000).toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString()
    },
    sessionBriefingDigest: hash("briefing:cross-tenant"), projectedAt: now
  }), /exact scope/);
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: firstApplication.id, deliveryId: firstApplication.deliveryId,
    ...outcome("outcome:application-after-a", "after", 0.8, "evaluator:after-a")
  })).decision, "active");
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: firstApplication.id, deliveryId: firstApplication.deliveryId,
    ...outcome("outcome:application-after-b", "after", 0.8, "evaluator:after-b")
  })).decision, "active", "two evaluators of one turn must not simulate two applications");

  const secondApplication = await application(root, "learning:application-bound", "application-b");
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: secondApplication.id, deliveryId: secondApplication.deliveryId,
    ...outcome("outcome:application-after-c", "after", 0.8, "evaluator:after-c")
  })).decision, "validated");
});

test("UserPromptSubmit records the canary application only after the hard preflight is consumed", async (t) => {
  const { root, state } = await fixture(t);
  const hookScope = { ...scopedTurn, taskId: null };
  await writeFile(join(root, "CLAUDE.md"), "# Synthetic host rules\n\nKeep the fixed invariant.\n", "utf8");
  await upsertEntity({ root, id: scopedTurn.personaId, kind: "agent", displayName: "Synthetic Agent", privacy: "shared" });
  await proposeLearning({
    root, id: "learning:hook-application", kind: "behavior", claim: "Run the fixed invariant check.",
    privacy: "shared", scope: hookScope, evidence: evidence("evidence:hook-application-one", 0.98)
  });
  await addLearningEvidence({ root, id: "learning:hook-application", evidence: evidence("evidence:hook-application-two", 0.98) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  await evaluation(root, "learning:hook-application", { scope: hookScope });
  await recordLearningOutcome({
    root, learningId: "learning:hook-application",
    ...outcome("outcome:hook-before-a", "before", 0.4, "evaluator:hook-before-a", { scope: hookScope })
  });
  await recordLearningOutcome({
    root, learningId: "learning:hook-application",
    ...outcome("outcome:hook-before-b", "before", 0.5, "evaluator:hook-before-b", { scope: hookScope })
  });
  await evaluateLearning({ root });
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = state;
  t.after(() => {
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
  });
  const hook = await runHook({
    hook_event_name: "UserPromptSubmit", host: "claude", cwd: root,
    session_id: "session:learning-application", event_id: "turn:learning-application",
    entity_id: scopedTurn.personaId, user_id: scopedTurn.userId, tenant_id: scopedTurn.tenantId,
    project_id: scopedTurn.projectId, prompt: "Run the synthetic task."
  });
  assert.equal(hook.blocked, false, hook.reason);
  const injected = JSON.parse(hook.context);
  assert.equal(injected.preflight.learningApplications.status, "recorded");
  assert.equal(injected.preflight.learningApplications.receipts[0].learningId, "learning:hook-application");
  assert.equal(injected.briefing.learning[0].id, "learning:hook-application");
  const persisted = (await loadLearning(root)).learning.applications;
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].preflightReceiptId, injected.preflight.receiptId);
  assert.equal(persisted[0].sessionId, "session:learning-application");
  assert.equal(JSON.stringify(persisted).includes("Run the synthetic task"), false);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:hook-application", applicationId: persisted[0].id,
    ...outcome("outcome:hook-undelivered", "after", 0.8, "evaluator:test-a", { scope: hookScope })
  }), /completed model-turn delivery/);
  const crossSessionStop = await runHook({
    hook_event_name: "Stop", host: "claude", cwd: root, session_id: "session:other",
    entity_id: scopedTurn.personaId, user_id: scopedTurn.userId, tenant_id: scopedTurn.tenantId,
    project_id: scopedTurn.projectId
  });
  assert.equal(crossSessionStop.learningDelivery.status, "not-applicable");
  const stopped = await runHook({
    hook_event_name: "Stop", host: "claude", cwd: root, session_id: "session:learning-application",
    entity_id: scopedTurn.personaId, user_id: scopedTurn.userId, tenant_id: scopedTurn.tenantId,
    project_id: scopedTurn.projectId
  });
  assert.equal(stopped.learningDelivery.status, "completed");
  const delivery = stopped.learningDelivery.receipts[0];
  assert.equal(delivery.applicationId, persisted[0].id);
  assert.equal(JSON.stringify(delivery).includes("Run the synthetic task"), false);
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:hook-application", applicationId: persisted[0].id, deliveryId: delivery.id,
    ...outcome("outcome:hook-delivered", "after", 0.8, "evaluator:test-a", { scope: hookScope })
  })).decision, "active");
  const pendingAt = new Date();
  await recordLearningApplications({
    root, items: [{ id: "learning:hook-application", outcomeStatus: "active" }], scope: hookScope,
    preflightReceipt: {
      schema: "agentspine.preflight/v2", id: "preflight:crash-pending", status: "ready",
      sessionId: "session:crash-pending", promptDigest: hash("prompt:crash-pending"),
      briefingDigest: hash("briefing:crash-pending"), agentId: hookScope.personaId,
      userId: hookScope.userId, tenantId: hookScope.tenantId, projectId: hookScope.projectId,
      groupId: hookScope.groupId, taskId: hookScope.taskId,
      createdAt: new Date(pendingAt.getTime() - 1000).toISOString(),
      expiresAt: new Date(pendingAt.getTime() + 60_000).toISOString()
    },
    sessionBriefingDigest: hash("session-briefing:crash-pending"), projectedAt: pendingAt
  });
  assert.equal((await learningOutcomeStatus({ root })).records[0].pendingApplications, 1);
  await assert.rejects(purgeStaleLearningApplications({ root, now: new Date(pendingAt.getTime() + 6 * 60_000) }),
    /explicit local confirmation/);
  const purged = await purgeStaleLearningApplications({ root, confirmation: "local-user-purge-confirmed",
    now: new Date(pendingAt.getTime() + 6 * 60_000) });
  assert.equal(purged.purged, 1);
});

test("model suggestions cannot self-promote and contradictory behavior candidates remain blocked", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:model-only", kind: "behavior", claim: "Use synthetic strategy alpha.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:model-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:model-only", evidence: evidence("evidence:model-two", 0.97) });
  await proposeLearning({
    root, id: "learning:contradiction", kind: "behavior", claim: "Use synthetic strategy beta.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:contradiction-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:contradiction", evidence: evidence("evidence:contradiction-two", 0.97) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  for (const learningId of ["learning:model-only", "learning:contradiction"]) {
    const evaluationId = `evaluation:${learningId.split(":").at(-1)}`;
    await evaluation(root, learningId, { id: evaluationId });
    await recordLearningOutcome({
      root, learningId, ...outcome(`outcome:${learningId}:a`, "before", 0.4, "evaluator:model-a",
        { kind: "model-suggestion", evaluationId })
    });
    await recordLearningOutcome({
      root, learningId, ...outcome(`outcome:${learningId}:b`, "before", 0.5, "evaluator:model-b",
        { kind: "model-suggestion", evaluationId })
    });
  }
  const protectedScope = { ...scopedTurn, taskId: "task:protected" };
  await proposeLearning({
    root, id: "learning:protected", kind: "behavior", claim: "Change the synthetic security policy.",
    privacy: "shared", scope: protectedScope, evidence: evidence("evidence:protected-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:protected", evidence: evidence("evidence:protected-two", 0.97) });
  await assert.rejects(evaluation(root, "learning:protected", { id: "evaluation:protected", scope: protectedScope }),
    /low-risk behavior candidates/);
  assert.equal((await evaluateLearning({ root })).accepted.length, 0);
  const status = await learningOutcomeStatus({ root });
  assert.deepEqual(status.records.find((item) => item.id === "learning:model-only").conflictsWith, ["learning:contradiction"]);
});

test("a blocking canary defect rolls back automatically and restores the superseded lesson", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:prior-behavior", kind: "behavior", claim: "Use the stable synthetic path.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:prior")
  });
  await reviewLearning({ root, id: "learning:prior-behavior", decision: "accept", reason: "Confirmed locally.", confirmedByUser: true });
  await proposeLearning({
    root, id: "learning:new-behavior", kind: "behavior", claim: "Use the candidate synthetic path.",
    privacy: "shared", scope: scopedTurn, supersedesId: "learning:prior-behavior",
    evidence: evidence("evidence:new-one", 0.98)
  });
  await addLearningEvidence({ root, id: "learning:new-behavior", evidence: evidence("evidence:new-two", 0.98) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  await evaluation(root, "learning:new-behavior");
  await recordLearningOutcome({ root, learningId: "learning:new-behavior", ...outcome("outcome:new-before-a", "before", 0.4, "evaluator:test-a") });
  await recordLearningOutcome({ root, learningId: "learning:new-behavior", ...outcome("outcome:new-before-b", "before", 0.5, "evaluator:test-b") });
  await evaluateLearning({ root });
  const applied = await application(root, "learning:new-behavior", "blocking");
  const regressed = await recordLearningOutcome({
    root, learningId: "learning:new-behavior", applicationId: applied.id, deliveryId: applied.deliveryId,
    ...outcome("outcome:new-after-blocking", "after", 0.9, "evaluator:test-c", { blockingDefects: 1 })
  });
  assert.equal(regressed.decision, "rolled-back");
  assert.deepEqual(regressed.restored, ["learning:prior-behavior"]);
  assert.deepEqual((await learningContext({ root, scope: scopedTurn })).items.map((item) => item.id), ["learning:prior-behavior"]);
});

test("stale canaries degrade context and evaluation rolls them back", async (t) => {
  const { root } = await fixture(t);
  const start = new Date("2026-01-01T00:00:00.000Z");
  await proposeLearning({
    root, id: "learning:stale", kind: "behavior", claim: "Use the temporary synthetic strategy.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:stale-one", 0.96), now: start
  });
  await addLearningEvidence({ root, id: "learning:stale", evidence: evidence("evidence:stale-two", 0.96), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2, canaryTtlDays: 1 }, now: start });
  await evaluation(root, "learning:stale", { now: start, expiresAt: new Date("2026-02-01T00:00:00.000Z") });
  await recordLearningOutcome({ root, learningId: "learning:stale", ...outcome("outcome:stale-a", "before", 0.4, "evaluator:test-a", { measuredAt: start }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:stale", ...outcome("outcome:stale-b", "before", 0.5, "evaluator:test-b", { measuredAt: start }), now: start });
  await evaluateLearning({ root, now: start });
  const later = new Date("2026-01-03T00:00:00.000Z");
  const context = await learningContext({ root, scope: scopedTurn, now: later });
  assert.equal(context.items.length, 0);
  assert.equal(context.degraded, true);
  assert.deepEqual((await evaluateLearning({ root, now: later })).reconciled, [{ id: "learning:stale", decision: "rolled-back" }]);
});

test("parallel duplicate outcome receipts are idempotent and remain one immutable measurement", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:outcome-race", kind: "behavior", claim: "Use one synthetic race-safe action.",
    scope: scopedTurn, evidence: evidence("evidence:race")
  });
  await evaluation(root, "learning:outcome-race");
  const input = { root, learningId: "learning:outcome-race", ...outcome("outcome:race", "before", 0.4, "evaluator:test-race") };
  const results = await Promise.all(Array.from({ length: 6 }, () => recordLearningOutcome(input)));
  assert.equal(results.filter((item) => item.unchanged === false).length, 1);
  assert.equal((await loadLearning(root)).learning.outcomes.length, 1);
});

test("0.10 learning state upgrades in place and corrupt outcome receipts fail closed", async (t) => {
  const { root } = await fixture(t);
  const { learningPath, catalog } = await loadLearning(root);
  const legacy = {
    schema: "agentspine.learning/v1", root: catalog.root,
    config: { autoPromote: false, minConfidence: 0.85, minEvidence: 2, maxContextItems: 12 },
    candidates: [], history: []
  };
  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const upgraded = (await loadLearning(root)).learning;
  assert.deepEqual(upgraded.outcomes, []);
  assert.deepEqual(upgraded.applications, []);
  assert.deepEqual(upgraded.deliveries, []);
  assert.deepEqual(upgraded.evaluations, []);
  assert.equal(upgraded.config.minOutcomeReceipts, 2);
  await configureLearning({ root, config: { canaryTtlDays: 7 } });
  assert.equal((await loadLearning(root)).learning.config.canaryTtlDays, 7);

  const corruptApplication = (await loadLearning(root)).learning;
  corruptApplication.applications.push({ schema: "agentspine.learning-application/v1", id: "application:bad" });
  await writeFile(learningPath, `${JSON.stringify(corruptApplication)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning application state is invalid/);

  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const corruptDelivery = (await loadLearning(root)).learning;
  corruptDelivery.deliveries.push({ schema: "agentspine.learning-delivery/v1", id: "delivery:bad" });
  await writeFile(learningPath, `${JSON.stringify(corruptDelivery)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning delivery state is invalid/);

  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const corruptEvaluation = (await loadLearning(root)).learning;
  corruptEvaluation.evaluations.push({ schema: "agentspine.learning-evaluation/v1", id: "evaluation:bad" });
  await writeFile(learningPath, `${JSON.stringify(corruptEvaluation)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning evaluation state is invalid/);

  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const corrupt = (await loadLearning(root)).learning;
  corrupt.outcomes.push({ schema: "agentspine.learning-outcome/v1", id: "outcome:bad" });
  await writeFile(learningPath, `${JSON.stringify(corrupt)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning outcome state is invalid/);
  await assert.rejects(configureLearning({ root, config: { canaryTtlDays: 8 } }), /learning outcome state is invalid/);
});

test("concurrent evidence appends serialize without losing observations", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:concurrent", kind: "reference", claim: "Synthetic observations can accumulate.",
    evidence: evidence("evidence:initial")
  });
  await Promise.all(Array.from({ length: 8 }, (_, index) => addLearningEvidence({
    root, id: "learning:concurrent", evidence: evidence(`evidence:parallel-${index}`)
  })));
  const { learning } = await loadLearning(root);
  assert.equal(learning.candidates[0].evidence.length, 9);
  assert.equal(learning.history.filter((entry) => entry.recordId === "learning:concurrent").length, 8);
});

test("session hooks inject accepted learning without a model-side MCP call", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:hook", kind: "correction", claim: "Sensitive synthetic wording stays behind an explicit read.",
    privacy: "shared", evidence: evidence("evidence:hook")
  });
  await reviewLearning({ root, id: "learning:hook", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  const result = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const injected = JSON.parse(result.context);
  assert.equal(injected.briefing.learning.length, 1);
  assert.equal(injected.briefing.learning[0].kind, "correction");
  assert.equal(injected.briefing.learning[0].claim, "Sensitive synthetic wording stays behind an explicit read.");
});

test("malformed learning state fails closed without breaking source indexing or being overwritten", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadLearning(root);
  const corrupt = "{\"schema\":\"wrong\",\"candidates\":[]}";
  await writeFile(loaded.learningPath, corrupt, "utf8");
  await assert.rejects(learningContext({ root }), /structure is invalid/);
  await assert.rejects(
    proposeLearning({ root, kind: "reference", claim: "This must not replace corrupt state.", evidence: evidence("evidence:blocked") }),
    /structure is invalid/
  );
  assert.equal(await readFile(loaded.learningPath, "utf8"), corrupt);
  const hook = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const injected = JSON.parse(hook.context);
  assert.ok(injected.indexedSources >= 2, "both project sources remain indexed alongside any host-global sources");
  assert.equal(injected.failedClosed, true);
  assert.match(injected.error, /learning state structure is invalid/);
});

test("CLI learning workflow proposes, confirms, reads, rolls back, and deletes a fact", async (t) => {
  const { root, state } = await fixture(t);
  runCli([
    "learn-propose", "learning:cli", "--root", root, "--kind", "goal", "--claim", "The synthetic goal is complete.",
    "--evidence", "User stated the goal.", "--privacy", "shared", "--confidence", "0.9", "--json"
  ], state);
  runCli([
    "learn-review", "learning:cli", "--root", root, "--decision", "accept", "--reason", "Confirmed.",
    "--confirmed-by-user", "--json"
  ], state);
  assert.equal(runCli(["learn-context", root, "--json"], state).items[0].id, "learning:cli");
  runCli(["learn-rollback", "learning:cli", "--root", root, "--reason", "No longer current.", "--json"], state);
  assert.equal(runCli(["learn-context", root, "--json"], state).items.length, 0);
  assert.equal(runCli(["learn-delete", "learning:cli", "--root", root, "--json"], state).deleted, true);
});

test("CLI records content-free outcome receipts and reports scoped canary diagnostics", async (t) => {
  const { root, state } = await fixture(t);
  runCli([
    "learn-propose", "learning:cli-outcome", "--root", root, "--kind", "behavior",
    "--claim", "Check the synthetic invariant.", "--evidence", "A fixed task missed the invariant.",
    "--privacy", "shared", "--persona", "agent:synthetic", "--user", "user:synthetic",
    "--tenant", "tenant:synthetic", "--project", "project:synthetic", "--task", "task:synthetic", "--json"
  ], state);
  runCli([
    "learn-evaluation", "evaluation:cli", "--root", root, "--learning", "learning:cli-outcome",
    "--metric", "fixed-task-success", "--direction", "higher", "--task-digest", hash("cli-task"),
    "--dataset-digest", hash("cli-dataset"), "--protocol-digest", hash("cli-protocol"),
    "--min-cases", "8", "--evaluators", "evaluator:cli,evaluator:cli-two",
    "--persona", "agent:synthetic", "--user", "user:synthetic", "--tenant", "tenant:synthetic",
    "--project", "project:synthetic", "--task", "task:synthetic", "--confirm-local-evaluation", "--json"
  ], state);
  runCli([
    "learn-outcome", "learning:cli-outcome", "--root", root, "--id", "outcome:cli-before",
    "--evaluation", "evaluation:cli", "--phase", "before", "--metric", "fixed-task-success", "--direction", "higher", "--value", "0.4",
    "--measurement", "objective", "--evaluator", "evaluator:cli", "--persona", "agent:synthetic",
    "--user", "user:synthetic", "--tenant", "tenant:synthetic", "--project", "project:synthetic",
    "--task", "task:synthetic", "--json"
  ], state);
  const status = runCli([
    "learn-status", root, "--persona", "agent:synthetic", "--user", "user:synthetic",
    "--tenant", "tenant:synthetic", "--project", "project:synthetic", "--task", "task:synthetic", "--json"
  ], state);
  assert.equal(status.records[0].beforeReceipts, 1);
  assert.equal(status.records[0].canaryStatus, "not-applicable");
});
