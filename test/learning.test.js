import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addLearningEvidence, beginLearningRevalidation, configureLearning, deleteLearning, evaluateLearning,
  learningContext, learningOutcomeStatus, loadLearning, proposeLearning,
  purgeStaleLearningApplications, purgeStaleLearningMeasurements, recordLearningApplications, recordLearningDeliveries,
  recordLearningMeasurement, recordLearningOutcome as commitLearningOutcome, registerLearningEvaluation,
  registerLearningEvaluator, renewLearningValidation, revokeLearningEvaluator, reviewLearning, rollbackLearning
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
const syntheticDatasetDigest = hash("synthetic fixed benchmark dataset");

function outcome(id, phase, value, evaluatorId, extra = {}) {
  return {
    id, phase, scope: extra.scope || scopedTurn, evaluationId: extra.evaluationId || "evaluation:fixed",
    metric: {
      name: "fixed-task-success", direction: "higher", value,
      blockingDefects: extra.blockingDefects || 0
    },
    measurement: {
      kind: extra.kind || "objective", evaluatorId,
      sourceDigest: Object.hasOwn(extra, "sourceDigest") ? extra.sourceDigest : hash(`measurement:${id}`)
    },
    coverage: {
      datasetDigest: extra.datasetDigest || syntheticDatasetDigest,
      caseCount: extra.caseCount ?? 12
    },
    measuredAt: extra.measuredAt
  };
}

async function recordLearningOutcome(input) {
  const { learning } = await loadLearning(input.root);
  const evaluation = learning.evaluations.find((item) => item.id === input.evaluationId);
  if (!["agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation?.schema)) {
    return commitLearningOutcome(input);
  }
  const measurementId = `measurement:${input.id}`;
  let measurementReceipt = learning.measurements.find((item) => item.id === measurementId);
  if (!measurementReceipt) {
    measurementReceipt = (await recordLearningMeasurement({
      root: input.root, id: measurementId, learningId: input.learningId, evaluationId: input.evaluationId,
      phase: input.phase, scope: input.scope, metric: input.metric,
      measurement: { ...input.measurement, runId: `run:${input.id}` }, coverage: input.coverage,
      measuredAt: input.measuredAt, confirmLocalMeasurement: true, now: input.now
    })).receipt;
  }
  return commitLearningOutcome({
    root: input.root, id: input.id, learningId: input.learningId, evaluationId: input.evaluationId,
    measurementReceiptId: measurementReceipt.id, applicationId: input.applicationId,
    deliveryId: input.deliveryId, now: input.now
  });
}

const syntheticEvaluators = [
  "evaluator:test-a", "evaluator:test-b", "evaluator:test-c", "evaluator:user-b",
  "evaluator:baseline-a", "evaluator:baseline-b", "evaluator:after-a", "evaluator:after-b",
  "evaluator:after-c", "evaluator:hook-before-a", "evaluator:hook-before-b", "evaluator:test-race",
  "evaluator:model-a", "evaluator:model-b"
];

function evaluatorRoots(evaluatorIds = syntheticEvaluators) {
  return evaluatorIds.map((evaluatorId) => ({ evaluatorId, principalDigest: hash(`evaluator-root:${evaluatorId}`) }));
}

async function evaluation(root, learningId, extra = {}) {
  const ids = extra.evaluatorIds || syntheticEvaluators;
  const roots = new Map((extra.evaluatorRoots || evaluatorRoots(ids))
    .map((entry) => [entry.evaluatorId, entry.principalDigest]));
  for (const evaluatorId of ids) {
    await registerLearningEvaluator({ root, id: evaluatorId, principalDigest: roots.get(evaluatorId),
      confirmLocalEvaluator: true, now: extra.now || new Date() });
  }
  return registerLearningEvaluation({
    root, id: extra.id || "evaluation:fixed", learningId, scope: extra.scope || scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher" },
    benchmark: {
      taskDigest: hash(`task:${learningId}`), datasetDigest: syntheticDatasetDigest,
      protocolDigest: hash(`protocol:${learningId}`), minCases: 12
    },
    evaluatorIds: ids,
    evaluatorRoots: [...roots].map(([evaluatorId, principalDigest]) => ({ evaluatorId, principalDigest })),
    expiresAt: extra.expiresAt || null, confirmLocalEvaluation: true, now: extra.now || new Date()
  });
}

async function application(root, learningId, turnId, now = new Date(), outcomeStatus = "active") {
  const projectedAt = new Date(now);
  const createdAt = new Date(projectedAt.getTime() - 1000).toISOString();
  const expiresAt = new Date(projectedAt.getTime() + 60_000).toISOString();
  const result = await recordLearningApplications({
    root, items: [{ id: learningId, outcomeStatus }], scope: scopedTurn,
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
  assert.ok(application, JSON.stringify(result));
  assert.ok(new Date(projectedAt).getTime() <= new Date(application.deliveryExpiresAt).getTime(), JSON.stringify(application));
  const delivered = await recordLearningDeliveries({
    root, sessionId: `session:${turnId}`, scope: scopedTurn, hookEvent: "Stop", completedAt: projectedAt
  });
  assert.ok(delivered.receipts[0], JSON.stringify(delivered));
  return { ...application, deliveryId: delivered.receipts[0].id };
}

async function establishValidatedLearning(root, {
  learningId, evaluationId, start, expiresAt, supersedesId = null
}) {
  const suffix = learningId.split(":").at(-1);
  await proposeLearning({
    root, id: learningId, kind: "behavior", claim: `Use validated synthetic strategy ${suffix}.`,
    privacy: "shared", scope: scopedTurn, supersedesId,
    evidence: evidence(`evidence:${suffix}-one`, 0.97), now: start
  });
  await addLearningEvidence({ root, id: learningId,
    evidence: evidence(`evidence:${suffix}-two`, 0.97), now: start });
  await configureLearning({ root, config: {
    autoPromote: true, minConfidence: 0.9, minEvidence: 2, minOutcomeReceipts: 2,
    canaryReceipts: 2, minImprovement: 0.1, canaryTtlDays: 30
  }, now: start });
  await evaluation(root, learningId, {
    id: evaluationId, evaluatorIds: ["evaluator:test-a", "evaluator:test-b"], now: start, expiresAt
  });
  await recordLearningOutcome({ root, learningId,
    ...outcome(`outcome:${suffix}-before-a`, "before", 0.4, "evaluator:test-a", { evaluationId, measuredAt: start }),
    now: start });
  await recordLearningOutcome({ root, learningId,
    ...outcome(`outcome:${suffix}-before-b`, "before", 0.5, "evaluator:test-b", { evaluationId, measuredAt: start }),
    now: start });
  await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  const firstApplication = await application(root, learningId, `${suffix}-a`, new Date(start.getTime() + 2000));
  await recordLearningOutcome({ root, learningId, applicationId: firstApplication.id,
    deliveryId: firstApplication.deliveryId,
    ...outcome(`outcome:${suffix}-after-a`, "after", 0.8, "evaluator:test-a", {
      evaluationId, measuredAt: new Date(start.getTime() + 2000)
    }), now: new Date(start.getTime() + 2000) });
  const secondApplication = await application(root, learningId, `${suffix}-b`, new Date(start.getTime() + 3000));
  return recordLearningOutcome({ root, learningId, applicationId: secondApplication.id,
    deliveryId: secondApplication.deliveryId,
    ...outcome(`outcome:${suffix}-after-b`, "after", 0.9, "evaluator:test-b", {
      evaluationId, measuredAt: new Date(start.getTime() + 3000)
    }), now: new Date(start.getTime() + 3000) });
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
    evaluatorIds: syntheticEvaluators, evaluatorRoots: evaluatorRoots(), expiresAt, now: registeredAt
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
    evaluatorIds: syntheticEvaluators, evaluatorRoots: evaluatorRoots(), expiresAt, now: registeredAt, confirmLocalEvaluation: true
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
  await assert.rejects(loadLearning(root), /binding.*invalid/);
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

test("case-bound outcomes reject cherry-picked subsets and dataset drift", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  await proposeLearning({
    root, id: "learning:coverage", kind: "behavior", claim: "Use the fixed synthetic coverage strategy.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:coverage-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:coverage", evidence: evidence("evidence:coverage-two", 0.97) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  const registered = await evaluation(root, "learning:coverage");
  assert.equal(registered.contract.schema, "agentspine.learning-evaluation/v7");
  assert.deepEqual(registered.contract.pairing, {
    mode: "same-evaluator", maxOutcomesPerEvaluatorPerPhase: 1,
    matchMeasurementKind: true, matchCaseCount: true, authority: "context-only"
  });

  await assert.rejects(commitLearningOutcome({
    root, id: "outcome:missing-measurement", learningId: "learning:coverage",
    evaluationId: "evaluation:fixed"
  }), /immutable measurement receipt/);

  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:provenance-missing", "before", 0.4, "evaluator:test-a", { sourceDigest: null })
  }), /sourceDigest/);

  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-missing", "before", 0.4, "evaluator:test-a"), coverage: null
  }), /caseCount/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-small", "before", 0.4, "evaluator:test-a", { caseCount: 11 })
  }), /at least 12 cases/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-drift", "before", 0.4, "evaluator:test-a", { datasetDigest: hash("other dataset") })
  }), /dataset does not match/);

  await recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-before-a", "before", 0.4, "evaluator:test-a") });
  await assert.rejects(recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-before-a-overweight", "before", 0.1, "evaluator:test-a")
  }), /exactly one outcome per evaluator and phase/,
  "one evaluator cannot overweight the baseline with repeated runs");
  await assert.rejects(recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-replay", "before", 0.5, "evaluator:test-b", {
      sourceDigest: hash("measurement:outcome:coverage-before-a")
    })
  }), /source provenance cannot be reused/);
  const firstMeasurement = (await loadLearning(root)).learning.measurements
    .find((item) => item.id === "measurement:outcome:coverage-before-a");
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:run-replay", learningId: "learning:coverage", evaluationId: "evaluation:fixed",
    phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: {
      kind: "objective", evaluatorId: "evaluator:test-a", runId: firstMeasurement.measurement.runId,
      sourceDigest: hash("different-source-for-same-run")
    },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, confirmLocalMeasurement: true
  }), /evaluator run cannot be replayed/);
  await assert.rejects(commitLearningOutcome({
    root, id: "outcome:metric-tamper", learningId: "learning:coverage", evaluationId: "evaluation:fixed",
    measurementReceiptId: firstMeasurement.id,
    metric: { name: "fixed-task-success", direction: "higher", value: 1, blockingDefects: 0 }
  }), /metric conflicts/);
  await recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-before-b", "before", 0.5, "evaluator:test-b") });
  const promoted = await evaluateLearning({ root });
  assert.equal(promoted.accepted[0].promotion.canary.coverage.minCases, 12);
  assert.equal(promoted.accepted[0].promotion.canary.coverage.datasetDigest, syntheticDatasetDigest);

  const applied = await application(root, "learning:coverage", "coverage-a");
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage", applicationId: applied.id, deliveryId: applied.deliveryId,
    ...outcome("outcome:coverage-after-small", "after", 0.8, "evaluator:test-a", { caseCount: 1 })
  }), /at least 12 cases/);
  const recorded = await recordLearningOutcome({
    root, learningId: "learning:coverage", applicationId: applied.id, deliveryId: applied.deliveryId,
    ...outcome("outcome:coverage-after-valid", "after", 0.8, "evaluator:test-a")
  });
  assert.equal(recorded.receipt.schema, "agentspine.learning-outcome/v9");
  assert.deepEqual(recorded.receipt.coverage, {
    datasetDigest: syntheticDatasetDigest, caseCount: 12, authority: "context-only"
  });
  assert.equal(JSON.stringify(recorded.receipt).includes("fixed synthetic coverage strategy"), false);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);

  const stored = await loadLearning(root);
  const original = stored.learning.outcomes.find((item) => item.id === "outcome:coverage-before-a");
  const { digest: _storedDigest, ...replayedPayload } = { ...original, id: "outcome:coverage-corrupt-replay" };
  stored.learning.outcomes.push({ ...replayedPayload, digest: hash(JSON.stringify(replayedPayload)) });
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /(paired evaluator outcome is duplicated|outcome measurement binding is invalid or replayed)/);
});

test("measurement lineage blocks cross-contract reuse and purges only stale unconsumed runs", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2026-01-01T00:00:00.000Z");
  for (const suffix of ["one", "two"]) {
    await proposeLearning({
      root, id: `learning:lineage-${suffix}`, kind: "behavior", claim: `Use synthetic strategy ${suffix}.`,
      scope: scopedTurn, evidence: evidence(`evidence:lineage-${suffix}`), now: start
    });
    await evaluation(root, `learning:lineage-${suffix}`, {
      id: `evaluation:lineage-${suffix}`, now: start,
      expiresAt: "2026-01-10T00:00:00.000Z"
    });
  }
  const sharedSource = hash("one immutable provider run manifest");
  await recordLearningMeasurement({
    root, id: "measurement:lineage-one", learningId: "learning:lineage-one", evaluationId: "evaluation:lineage-one",
    phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.4, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a", runId: "run:lineage-one", sourceDigest: sharedSource },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start
  });
  const validState = await loadLearning(root);
  const originalMeasurement = validState.learning.measurements[0];
  const { digest: _originalDigest, ...injectedPayload } = originalMeasurement;
  const injectedMeasurement = {
    ...injectedPayload,
    id: "measurement:lineage-injected",
    measurement: { ...injectedPayload.measurement, runId: "run:lineage-injected" }
  };
  validState.learning.measurements.push({
    ...injectedMeasurement,
    digest: hash(JSON.stringify(injectedMeasurement))
  });
  const originalLineage = validState.learning.measurementLineage[0];
  const { digest: _lineageDigest, ...injectedLineagePayload } = originalLineage;
  const injectedLineage = {
    ...injectedLineagePayload,
    measurementReceiptId: "measurement:lineage-injected",
    runDigest: hash(JSON.stringify(["evaluator:test-a", "run:lineage-injected"]))
  };
  validState.learning.measurementLineage.push({
    ...injectedLineage,
    digest: hash(JSON.stringify(injectedLineage))
  });
  await writeFile(validState.learningPath, `${JSON.stringify(validState.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /measurement lineage is replayed/);
  validState.learning.measurements.pop();
  validState.learning.measurementLineage.pop();
  await writeFile(validState.learningPath, `${JSON.stringify(validState.learning)}\n`, "utf8");
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:lineage-two", learningId: "learning:lineage-two", evaluationId: "evaluation:lineage-two",
    phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-b", runId: "run:lineage-two", sourceDigest: sharedSource },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start
  }), /cannot be reused across evaluation contracts/);
  await assert.rejects(purgeStaleLearningMeasurements({ root }), /explicit local confirmation/);
  const purged = await purgeStaleLearningMeasurements({
    root, confirmation: "local-user-purge-confirmed", now: new Date("2026-03-01T00:00:00.000Z")
  });
  assert.deepEqual(purged.measurementReceiptIds, ["measurement:lineage-one"]);
  const purgedState = (await loadLearning(root)).learning;
  assert.equal(purgedState.measurements.length, 0);
  assert.equal(purgedState.measurementLineage.length, 1, "content-free replay tombstones survive receipt purge");
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:lineage-reuse-after-purge", learningId: "learning:lineage-two",
    evaluationId: "evaluation:lineage-two", phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-b", runId: "run:lineage-after-purge", sourceDigest: sharedSource },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start
  }), /cannot be reused across evaluation contracts/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("evaluator roots prevent alias independence and bind measurements fail closed", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2026-01-01T00:00:00.000Z");
  const sharedRoot = hash("one synthetic evaluator principal");
  for (const suffix of ["primary", "alias"]) {
    await proposeLearning({
      root, id: `learning:root-${suffix}`, kind: "behavior", claim: `Use root-bound strategy ${suffix}.`,
      scope: scopedTurn, evidence: evidence(`evidence:root-${suffix}`), now: start
    });
  }
  await assert.rejects(registerLearningEvaluator({
    root, id: "evaluator:root-a", principalDigest: sharedRoot, now: start
  }), /explicit local confirmation/);
  await registerLearningEvaluator({
    root, id: "evaluator:root-a", principalDigest: sharedRoot, confirmLocalEvaluator: true, now: start
  });
  await assert.rejects(registerLearningEvaluator({
    root, id: "evaluator:root-alias", principalDigest: sharedRoot, confirmLocalEvaluator: true, now: start
  }), /IDs and principal roots are immutable/);
  const primary = await evaluation(root, "learning:root-primary", {
    id: "evaluation:root-primary", evaluatorIds: ["evaluator:root-a", "evaluator:root-b"],
    evaluatorRoots: [
      { evaluatorId: "evaluator:root-a", principalDigest: sharedRoot },
      { evaluatorId: "evaluator:root-b", principalDigest: hash("second synthetic evaluator principal") }
    ], now: start, expiresAt: "2026-01-10T00:00:00.000Z"
  });
  assert.equal(primary.contract.schema, "agentspine.learning-evaluation/v7");
  assert.equal(primary.binding.schema, "agentspine.learning-evaluator-binding/v1");
  assert.equal(primary.binding.evaluationDigest, primary.contract.digest);
  assert.deepEqual(primary.contract.evaluatorRoots[0], {
    evaluatorId: "evaluator:root-a", principalDigest: sharedRoot, authority: "context-only"
  });
  const first = await recordLearningMeasurement({
    root, id: "measurement:root-primary", learningId: "learning:root-primary",
    evaluationId: "evaluation:root-primary", phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.4, blockingDefects: 0 },
    measurement: {
      kind: "objective", evaluatorId: "evaluator:root-a", runId: "run:shared-root",
      sourceDigest: hash("root-primary-source")
    },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: start, confirmLocalMeasurement: true, now: start
  });
  assert.equal(first.receipt.schema, "agentspine.learning-measurement/v2");
  assert.equal(first.receipt.measurement.evaluatorRootDigest, sharedRoot);
  assert.equal(first.lineage.schema, "agentspine.learning-measurement-lineage/v2");
  assert.equal(first.lineage.evaluatorRootDigest, sharedRoot);
  assert.equal(first.lineage.rootRunDigest, hash(JSON.stringify([sharedRoot, "run:shared-root"])));
  const committed = await commitLearningOutcome({
    root, id: "outcome:root-primary", learningId: "learning:root-primary",
    evaluationId: "evaluation:root-primary", measurementReceiptId: first.receipt.id
  });
  assert.equal(committed.receipt.schema, "agentspine.learning-outcome/v9");
  assert.equal(committed.receipt.measurement.evaluatorRootDigest, sharedRoot);
  await revokeLearningEvaluator({ root, id: "evaluator:root-a", reason: "Synthetic evaluator retired.",
    confirmLocalEvaluator: true, now: new Date("2026-01-01T00:00:01.000Z") });
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:root-after-revoke", learningId: "learning:root-primary",
    evaluationId: "evaluation:root-primary", phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: {
      kind: "objective", evaluatorId: "evaluator:root-b", runId: "run:after-revoke",
      sourceDigest: hash("root-after-revoke-source")
    },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: start, confirmLocalMeasurement: true, now: start
  }), /registry binding is missing, changed, or revoked/);

  const stored = await loadLearning(root);
  const contract = stored.learning.evaluations.find((item) => item.id === "evaluation:root-primary");
  const { digest: _contractDigest, ...contractPayload } = contract;
  const tamperedPayload = {
    ...contractPayload,
    evaluatorRoots: contractPayload.evaluatorRoots.map((item) => item.evaluatorId === "evaluator:root-a"
      ? { ...item, principalDigest: hash("tampered root") } : item)
  };
  stored.learning.evaluations = stored.learning.evaluations.map((item) => item.id === contract.id
    ? { ...tamperedPayload, digest: hash(JSON.stringify(tamperedPayload)) } : item);
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evaluator binding state is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("local evaluator revocation removes canary context and forces automatic rollback", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2032-01-01T00:00:00.000Z");
  await proposeLearning({
    root, id: "learning:revoked-evaluator", kind: "behavior", claim: "Use the registry-bound synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:registry-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:revoked-evaluator",
    evidence: evidence("evidence:registry-two", 0.97), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2,
    minOutcomeReceipts: 2, canaryReceipts: 2 }, now: start });
  await evaluation(root, "learning:revoked-evaluator", {
    id: "evaluation:revoked-evaluator", evaluatorIds: ["evaluator:registry-a", "evaluator:registry-b"],
    now: start, expiresAt: "2032-01-10T00:00:00.000Z"
  });
  await recordLearningOutcome({ root, learningId: "learning:revoked-evaluator",
    ...outcome("outcome:registry-before-a", "before", 0.4, "evaluator:registry-a", {
      evaluationId: "evaluation:revoked-evaluator", measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:revoked-evaluator",
    ...outcome("outcome:registry-before-b", "before", 0.5, "evaluator:registry-b", {
      evaluationId: "evaluation:revoked-evaluator", measuredAt: start
    }), now: start });
  const promotedAt = new Date("2032-01-01T00:00:01.000Z");
  const promoted = await evaluateLearning({ root, now: promotedAt });
  assert.equal(promoted.accepted[0].promotion.canary.status, "active");
  await revokeLearningEvaluator({ root, id: "evaluator:registry-a", reason: "Synthetic root retired.",
    confirmLocalEvaluator: true, now: new Date("2032-01-01T00:00:02.000Z") });
  const context = await learningContext({ root, scope: scopedTurn, now: new Date("2032-01-01T00:00:03.000Z") });
  assert.equal(context.items.length, 0, "revoked evaluator evidence must not remain in preflight context");
  assert.equal(context.degraded, true);
  assert.deepEqual(context.diagnostics, ["revoked-evaluator-canary:learning:revoked-evaluator"]);
  const reconciled = await evaluateLearning({ root, now: new Date("2032-01-01T00:00:03.000Z") });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:revoked-evaluator", decision: "rolled-back" }]);
  const status = await learningOutcomeStatus({ root });
  assert.deepEqual(status.evaluatorRegistry, {
    active: 1, revoked: 1, bindings: 1, validationLeases: 0, authority: "context-only"
  });
  assert.equal(status.records[0].inactiveEvaluatorRegistryContracts, 1);
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
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:after-drifted-evaluator", "after", 0.9, "evaluator:test-b")
  }), /same evaluator as a frozen before measurement/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:after-drifted-kind", "after", 0.9, "evaluator:user-b")
  }), /measurement kind and case count/);
  const first = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:after-a", "after", 0.7, "evaluator:test-a")
  });
  assert.equal(first.decision, "active");
  const applicationB = await application(root, "learning:measured", "measured-b");
  const second = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:after-b", "after", 0.8, "evaluator:user-b", { kind: "user-feedback" })
  });
  assert.equal(second.decision, "validated");
  assert.ok(Math.abs(second.candidate.promotion.canary.improvement - 0.3) < 1e-12,
    "paired deltas, not a driftable aggregate cohort, prove improvement");
  assert.match(second.candidate.promotion.canary.validationLeaseId, /^validation:/);
  const validatedState = await loadLearning(root);
  const validationLease = validatedState.learning.validationLeases[0];
  assert.equal(validationLease.schema, "agentspine.learning-validation/v1");
  assert.equal(validationLease.learningId, "learning:measured");
  assert.equal(validationLease.evaluatorRegistryBindingDigest,
    validatedState.learning.evaluationBindings.find((item) => item.evaluationId === "evaluation:fixed").digest);
  assert.deepEqual(validationLease.beforeOutcomes.map((item) => item.id), ["outcome:before-a", "outcome:before-b"]);
  assert.deepEqual(validationLease.afterOutcomes.map((item) => item.id), ["outcome:after-a", "outcome:after-b"]);
  assert.equal(JSON.stringify(validationLease).includes("Check the fixed synthetic invariant"), false,
    "validation proof must remain content-free");
  const retryAfterValidation = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:after-b", "after", 0.8, "evaluator:user-b", { kind: "user-feedback" })
  });
  assert.equal(retryAfterValidation.unchanged, true);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn });
  assert.equal(status.records[0].canaryStatus, "validated");
  assert.equal(status.records[0].validationLeaseStatus, "current-validated");
  assert.equal(status.evaluatorRegistry.validationLeases, 1);
  assert.equal(status.records[0].beforeReceipts, 2);
  assert.equal(status.records[0].afterReceipts, 2);
  assert.equal(status.records[0].boundAfterReceipts, 2);
  assert.equal(status.records[0].applicationReceipts, 2);
  assert.equal(status.records[0].deliveryReceipts, 2);
  assert.equal(status.records[0].deliveredAfterReceipts, 2);
  assert.equal(status.records[0].pairedOutcomeReceipts, 4);
  assert.equal(status.records[0].pairedEvaluatorPairs, 2);
  assert.equal(status.records[0].pendingApplications, 0);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), beforeBytes);
});

test("validated learning renews only from fresh independent delivered-turn evidence", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2032-04-01T00:00:00.000Z");
  await establishValidatedLearning(root, {
    learningId: "learning:renewed", evaluationId: "evaluation:renewed", start,
    expiresAt: "2032-06-01T00:00:00.000Z"
  });
  const original = (await loadLearning(root)).learning.validationLeases[0];
  const renewalStarted = new Date("2032-04-20T00:00:00.000Z");
  await beginLearningRevalidation({ root, learningId: "learning:renewed",
    confirmLocalValidation: true, now: renewalStarted });
  const projected = await learningContext({ root, scope: scopedTurn, now: renewalStarted });
  assert.equal(projected.items[0].outcomeStatus, "revalidating");

  const evidenceBindings = [];
  for (const [suffix, evaluatorId, value, kind] of [
    ["a", "evaluator:test-a", 0.82, "objective"],
    ["b", "evaluator:test-b", 0.88, "objective"]
  ]) {
    const at = new Date(renewalStarted.getTime() + (suffix === "a" ? 1000 : 2000));
    const delivered = await application(root, "learning:renewed", `renewed-refresh-${suffix}`, at, "revalidating");
    const measurement = (await recordLearningMeasurement({
      root, id: `measurement:renewed-${suffix}`, learningId: "learning:renewed",
      evaluationId: "evaluation:renewed", phase: "after", scope: scopedTurn,
      metric: { name: "fixed-task-success", direction: "higher", value, blockingDefects: 0 },
      measurement: { kind, evaluatorId, runId: `run:renewed-${suffix}`,
        sourceDigest: hash(`renewed-source-${suffix}`) },
      coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
      measuredAt: new Date(at.getTime() + 1), confirmLocalMeasurement: true, now: new Date(at.getTime() + 1)
    })).receipt;
    evidenceBindings.push({ measurementId: measurement.id, applicationId: delivered.id,
      deliveryId: delivered.deliveryId });
  }
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => renewLearningValidation({
    root, learningId: "learning:renewed", evidence: evidenceBindings,
    confirmLocalValidation: true, now: new Date("2032-04-20T00:00:04.000Z")
  })));
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1,
    "parallel renewal must replace evidence exactly once");
  const renewedResult = attempts.find((item) => item.status === "fulfilled").value;
  assert.equal(renewedResult.decision, "renewed");
  assert.equal(renewedResult.lease.schema, "agentspine.learning-validation/v2");
  assert.equal(renewedResult.lease.predecessorValidation.digest, original.digest);
  assert.equal(renewedResult.lease.renewalEvidence.length, 2);
  assert.ok(new Date(renewedResult.lease.expiresAt) > new Date(original.expiresAt));
  assert.equal(JSON.stringify(renewedResult.lease).includes("Use validated synthetic strategy"), false);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.validationLeases.length, 1);
  assert.equal(stored.learning.validationLeases[0].schema, "agentspine.learning-validation/v2");
  assert.equal(stored.learning.history.filter((item) => item.kind === "learning-validation"
    && item.value?.id === original.id).length, 1);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn,
    now: new Date("2032-04-20T00:00:05.000Z") });
  assert.equal(status.records[0].validationLeaseSchema, "agentspine.learning-validation/v2");
  assert.equal(status.records[0].consumedMeasurementReceipts, 6,
    "original outcomes and renewal measurements remain independently accounted");
  assert.equal(status.records[0].revalidationStatus, "not-applicable");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
  const tampered = await loadLearning(root);
  tampered.learning.validationLeases[0].renewalEvidence[0].measurementDigest = hash("tampered-renewal");
  await writeFile(tampered.learningPath, `${JSON.stringify(tampered.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /validation lease state is invalid|validation lease binding is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("one blocking defect defeats positive revalidation averages and restores a superseded lesson", async (t) => {
  const { root } = await fixture(t);
  const start = new Date("2032-07-01T00:00:00.000Z");
  await proposeLearning({ root, id: "learning:renewal-prior", kind: "behavior",
    claim: "Use the prior synthetic strategy.", privacy: "shared", scope: scopedTurn,
    evidence: evidence("evidence:renewal-prior"), now: start });
  await reviewLearning({ root, id: "learning:renewal-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await establishValidatedLearning(root, {
    learningId: "learning:renewal-block", evaluationId: "evaluation:renewal-block", start,
    expiresAt: "2032-09-01T00:00:00.000Z", supersedesId: "learning:renewal-prior"
  });
  const renewalStarted = new Date("2032-07-20T00:00:00.000Z");
  await beginLearningRevalidation({ root, learningId: "learning:renewal-block",
    confirmLocalValidation: true, now: renewalStarted });
  const evidenceBindings = [];
  for (const [suffix, evaluatorId, blockingDefects] of [["a", "evaluator:test-a", 0], ["b", "evaluator:test-b", 1]]) {
    const at = new Date(renewalStarted.getTime() + (suffix === "a" ? 1000 : 2000));
    const delivered = await application(root, "learning:renewal-block", `renewal-block-refresh-${suffix}`, at, "revalidating");
    const measurement = (await recordLearningMeasurement({
      root, id: `measurement:renewal-block-${suffix}`, learningId: "learning:renewal-block",
      evaluationId: "evaluation:renewal-block", phase: "after", scope: scopedTurn,
      metric: { name: "fixed-task-success", direction: "higher", value: 1, blockingDefects },
      measurement: { kind: "objective", evaluatorId, runId: `run:renewal-block-${suffix}`,
        sourceDigest: hash(`renewal-block-source-${suffix}`) },
      coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
      measuredAt: new Date(at.getTime() + 1), confirmLocalMeasurement: true, now: new Date(at.getTime() + 1)
    })).receipt;
    evidenceBindings.push({ measurementId: measurement.id, applicationId: delivered.id, deliveryId: delivered.deliveryId });
  }
  const result = await renewLearningValidation({ root, learningId: "learning:renewal-block",
    evidence: evidenceBindings, confirmLocalValidation: true,
    now: new Date("2032-07-20T00:00:04.000Z") });
  assert.equal(result.decision, "rolled-back");
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date("2032-07-20T00:00:05.000Z") })).items.map((item) => item.id), ["learning:renewal-prior"]);
});

test("validated evidence leases expire before context and roll back atomically under parallel reconciliation", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2033-01-01T00:00:00.000Z");
  await proposeLearning({
    root, id: "learning:lease-prior", kind: "behavior", claim: "Use stable synthetic strategy prior.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:lease-prior"), now: start
  });
  await reviewLearning({ root, id: "learning:lease-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  const validated = await establishValidatedLearning(root, {
    learningId: "learning:lease-expiry", evaluationId: "evaluation:lease-expiry", start,
    expiresAt: "2033-01-10T00:00:00.000Z", supersedesId: "learning:lease-prior"
  });
  assert.equal(validated.decision, "validated");
  const currentContext = await learningContext({ root, scope: scopedTurn,
    now: new Date("2033-01-02T00:00:00.000Z") });
  assert.deepEqual(currentContext.items.map((item) => item.id), ["learning:lease-expiry"], JSON.stringify(currentContext));

  const expiredAt = new Date("2033-01-10T00:00:00.000Z");
  const staleContext = await learningContext({ root, scope: scopedTurn, now: expiredAt });
  assert.equal(staleContext.degraded, true);
  assert.equal(staleContext.items.length, 0, "expired validated evidence must be absent before the next model turn");
  assert.deepEqual(staleContext.diagnostics, ["stale-validated-learning:learning:lease-expiry"]);
  const reconciliations = await Promise.all(Array.from({ length: 6 }, () => evaluateLearning({ root, now: expiredAt })));
  assert.equal(reconciliations.flatMap((item) => item.reconciled)
    .filter((item) => item.id === "learning:lease-expiry" && item.decision === "rolled-back").length, 1);
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date("2033-01-10T00:00:01.000Z") })).items.map((item) => item.id), ["learning:lease-prior"]);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.validationLeases.length, 0);
  assert.equal(stored.learning.history.filter((item) => item.kind === "learning-validation").length, 1,
    "expired proof remains immutable rollback history, not active context state");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("validated learning is removed when its evaluator root is revoked", async (t) => {
  const { root } = await fixture(t);
  const start = new Date("2034-01-01T00:00:00.000Z");
  const validated = await establishValidatedLearning(root, {
    learningId: "learning:lease-revoked", evaluationId: "evaluation:lease-revoked", start,
    expiresAt: "2034-02-01T00:00:00.000Z"
  });
  assert.equal(validated.decision, "validated");
  await revokeLearningEvaluator({ root, id: "evaluator:test-a", reason: "Synthetic evaluator retired.",
    confirmLocalEvaluator: true, now: new Date("2034-01-01T00:00:04.000Z") });
  const context = await learningContext({ root, scope: scopedTurn, now: new Date("2034-01-01T00:00:05.000Z") });
  assert.equal(context.items.length, 0);
  assert.deepEqual(context.diagnostics, ["revoked-evaluator-validated-learning:learning:lease-revoked"]);
  const reconciled = await evaluateLearning({ root, now: new Date("2034-01-01T00:00:05.000Z") });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:lease-revoked", decision: "rolled-back" }]);
  assert.equal((await learningOutcomeStatus({ root })).records[0].status, "rolled-back");
});

test("a forged validated state without its immutable lease is withheld and rolled back", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2035-01-01T00:00:00.000Z");
  await establishValidatedLearning(root, {
    learningId: "learning:lease-missing", evaluationId: "evaluation:lease-missing", start,
    expiresAt: "2035-02-01T00:00:00.000Z"
  });
  const stored = await loadLearning(root);
  stored.learning.validationLeases = [];
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  const context = await learningContext({ root, scope: scopedTurn, now: new Date("2035-01-01T00:00:05.000Z") });
  assert.equal(context.items.length, 0);
  assert.deepEqual(context.diagnostics, ["missing-validation-lease:learning:lease-missing"]);
  const status = await learningOutcomeStatus({ root, now: new Date("2035-01-01T00:00:05.000Z") });
  assert.equal(status.records[0].canaryStatus, "unproven");
  const reconciled = await evaluateLearning({ root, now: new Date("2035-01-01T00:00:05.000Z") });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:lease-missing", decision: "rolled-back" }]);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
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
    ...outcome("outcome:unbound-after", "after", 0.9, "evaluator:baseline-a")
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
    ...outcome("outcome:application-after-a", "after", 0.8, "evaluator:baseline-a")
  })).decision, "active");
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: firstApplication.id, deliveryId: firstApplication.deliveryId,
    ...outcome("outcome:application-after-b-same-turn", "after", 0.8, "evaluator:baseline-b")
  }), /distinct completed turn/, "two evaluators of one turn must not simulate two applications");

  const secondApplication = await application(root, "learning:application-bound", "application-b");
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: secondApplication.id, deliveryId: secondApplication.deliveryId,
    ...outcome("outcome:application-after-b", "after", 0.8, "evaluator:baseline-b")
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
    ...outcome("outcome:hook-undelivered", "after", 0.8, "evaluator:hook-before-a", { scope: hookScope })
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
    ...outcome("outcome:hook-delivered", "after", 0.8, "evaluator:hook-before-a", { scope: hookScope })
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
    ...outcome("outcome:new-after-blocking", "after", 0.9, "evaluator:test-a", { blockingDefects: 1 })
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

test("0.14 through 0.19 evaluation contracts remain readable while new contracts require registered evaluator roots", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:legacy-contract", kind: "behavior", claim: "Use the legacy synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:legacy-contract")
  });
  await evaluation(root, "learning:legacy-contract");
  const { learning, learningPath } = await loadLearning(root);
  const { digest: _digest, pairing: _pairing, evaluatorRoots: _roots, ...currentPayload } = learning.evaluations[0];
  const v1Payload = { ...currentPayload, schema: "agentspine.learning-evaluation/v1" };
  learning.evaluations[0] = { ...v1Payload, digest: hash(JSON.stringify(v1Payload)) };
  learning.evaluationBindings = learning.evaluationBindings.filter((entry) => entry.evaluationId !== "evaluation:fixed");
  await writeFile(learningPath, `${JSON.stringify(learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations[0].schema, "agentspine.learning-evaluation/v1");
  const legacyReceipt = await recordLearningOutcome({
    root, learningId: "learning:legacy-contract",
    ...outcome("outcome:legacy-contract", "before", 0.4, "evaluator:test-a"), coverage: null
  });
  assert.equal(legacyReceipt.receipt.schema, "agentspine.learning-outcome/v4");

  await proposeLearning({
    root, id: "learning:coverage-contract", kind: "behavior", claim: "Use the 0.15 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:coverage-contract")
  });
  await evaluation(root, "learning:coverage-contract", { id: "evaluation:coverage-contract" });
  const coverageState = await loadLearning(root);
  const current = coverageState.learning.evaluations.find((item) => item.id === "evaluation:coverage-contract");
  const { digest: _coverageDigest, pairing: _coveragePairing, evaluatorRoots: _coverageRoots, ...v3Payload } = current;
  const v2Payload = { ...v3Payload, schema: "agentspine.learning-evaluation/v2" };
  coverageState.learning.evaluations = coverageState.learning.evaluations.map((item) => item.id === current.id
    ? { ...v2Payload, digest: hash(JSON.stringify(v2Payload)) } : item);
  coverageState.learning.evaluationBindings = coverageState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== current.id);
  await writeFile(coverageState.learningPath, `${JSON.stringify(coverageState.learning)}\n`, "utf8");
  const coverageReceipt = await recordLearningOutcome({
    root, learningId: "learning:coverage-contract",
    ...outcome("outcome:coverage-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:coverage-contract", sourceDigest: null
    })
  });
  assert.equal(coverageReceipt.receipt.schema, "agentspine.learning-outcome/v5");

  await proposeLearning({
    root, id: "learning:provenance-contract", kind: "behavior", claim: "Use the 0.16 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:provenance-contract")
  });
  await evaluation(root, "learning:provenance-contract", { id: "evaluation:provenance-contract" });
  const provenanceState = await loadLearning(root);
  const lineageContract = provenanceState.learning.evaluations.find((item) => item.id === "evaluation:provenance-contract");
  const { digest: _lineageDigest, pairing: _lineagePairing, evaluatorRoots: _lineageRoots, ...v4Payload } = lineageContract;
  const v3ContractPayload = { ...v4Payload, schema: "agentspine.learning-evaluation/v3" };
  provenanceState.learning.evaluations = provenanceState.learning.evaluations.map((item) => item.id === lineageContract.id
    ? { ...v3ContractPayload, digest: hash(JSON.stringify(v3ContractPayload)) } : item);
  provenanceState.learning.evaluationBindings = provenanceState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== lineageContract.id);
  await writeFile(provenanceState.learningPath, `${JSON.stringify(provenanceState.learning)}\n`, "utf8");
  const provenanceReceipt = await recordLearningOutcome({
    root, learningId: "learning:provenance-contract",
    ...outcome("outcome:provenance-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:provenance-contract"
    })
  });
  assert.equal(provenanceReceipt.receipt.schema, "agentspine.learning-outcome/v6");

  await proposeLearning({
    root, id: "learning:lineage-contract", kind: "behavior", claim: "Use the 0.17 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:lineage-contract")
  });
  await evaluation(root, "learning:lineage-contract", { id: "evaluation:lineage-contract" });
  const pairedState = await loadLearning(root);
  const pairedContract = pairedState.learning.evaluations.find((item) => item.id === "evaluation:lineage-contract");
  const { digest: _pairedDigest, pairing: _pairedConfig, evaluatorRoots: _pairedRoots, ...v4ContractPayload } = pairedContract;
  const compatibleV4Payload = { ...v4ContractPayload, schema: "agentspine.learning-evaluation/v4" };
  pairedState.learning.evaluations = pairedState.learning.evaluations.map((item) => item.id === pairedContract.id
    ? { ...compatibleV4Payload, digest: hash(JSON.stringify(compatibleV4Payload)) } : item);
  pairedState.learning.evaluationBindings = pairedState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== pairedContract.id);
  await writeFile(pairedState.learningPath, `${JSON.stringify(pairedState.learning)}\n`, "utf8");
  const lineageReceipt = await recordLearningOutcome({
    root, learningId: "learning:lineage-contract",
    ...outcome("outcome:lineage-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:lineage-contract"
    })
  });
  assert.equal(lineageReceipt.receipt.schema, "agentspine.learning-outcome/v7");

  await proposeLearning({
    root, id: "learning:paired-contract", kind: "behavior", claim: "Use the 0.18 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:paired-contract")
  });
  await evaluation(root, "learning:paired-contract", { id: "evaluation:paired-contract" });
  const legacyPairedState = await loadLearning(root);
  const currentPaired = legacyPairedState.learning.evaluations.find((item) => item.id === "evaluation:paired-contract");
  const { digest: _currentPairedDigest, evaluatorRoots: _currentPairedRoots, ...v5ContractPayload } = currentPaired;
  const compatibleV5Payload = { ...v5ContractPayload, schema: "agentspine.learning-evaluation/v5" };
  legacyPairedState.learning.evaluations = legacyPairedState.learning.evaluations.map((item) => item.id === currentPaired.id
    ? { ...compatibleV5Payload, digest: hash(JSON.stringify(compatibleV5Payload)) } : item);
  legacyPairedState.learning.evaluationBindings = legacyPairedState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== currentPaired.id);
  await writeFile(legacyPairedState.learningPath, `${JSON.stringify(legacyPairedState.learning)}\n`, "utf8");
  const pairedReceipt = await recordLearningOutcome({
    root, learningId: "learning:paired-contract",
    ...outcome("outcome:paired-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:paired-contract"
    })
  });
  assert.equal(pairedReceipt.receipt.schema, "agentspine.learning-outcome/v8");
  const pairedMeasurement = (await loadLearning(root)).learning.measurements
    .find((item) => item.id === "measurement:outcome:paired-contract");
  assert.equal(pairedMeasurement.schema, "agentspine.learning-measurement/v1");

  await proposeLearning({
    root, id: "learning:root-contract", kind: "behavior", claim: "Use the 0.19 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:root-contract")
  });
  await evaluation(root, "learning:root-contract", { id: "evaluation:root-contract" });
  const legacyRootState = await loadLearning(root);
  const currentRoot = legacyRootState.learning.evaluations.find((item) => item.id === "evaluation:root-contract");
  const { digest: _currentRootDigest, ...v6ContractPayload } = currentRoot;
  const compatibleV6Payload = { ...v6ContractPayload, schema: "agentspine.learning-evaluation/v6" };
  legacyRootState.learning.evaluations = legacyRootState.learning.evaluations.map((item) => item.id === currentRoot.id
    ? { ...compatibleV6Payload, digest: hash(JSON.stringify(compatibleV6Payload)) } : item);
  legacyRootState.learning.evaluationBindings = legacyRootState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== currentRoot.id);
  await writeFile(legacyRootState.learningPath, `${JSON.stringify(legacyRootState.learning)}\n`, "utf8");
  const rootReceipt = await recordLearningOutcome({
    root, learningId: "learning:root-contract",
    ...outcome("outcome:root-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:root-contract"
    })
  });
  assert.equal(rootReceipt.receipt.schema, "agentspine.learning-outcome/v9");
  const rootMeasurement = (await loadLearning(root)).learning.measurements
    .find((item) => item.id === "measurement:outcome:root-contract");
  assert.equal(rootMeasurement.schema, "agentspine.learning-measurement/v2");
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
  assert.deepEqual(upgraded.measurements, []);
  assert.deepEqual(upgraded.measurementLineage, []);
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
  runCli(["learn-evaluator-register", "evaluator:cli", "--root", root,
    "--principal-digest", hash("root:cli"), "--confirm-local-evaluator", "--json"], state);
  runCli(["learn-evaluator-register", "evaluator:cli-two", "--root", root,
    "--principal-digest", hash("root:cli-two"), "--confirm-local-evaluator", "--json"], state);
  runCli([
    "learn-evaluation", "evaluation:cli", "--root", root, "--learning", "learning:cli-outcome",
    "--metric", "fixed-task-success", "--direction", "higher", "--task-digest", hash("cli-task"),
    "--dataset-digest", hash("cli-dataset"), "--protocol-digest", hash("cli-protocol"),
    "--min-cases", "8", "--evaluators", "evaluator:cli,evaluator:cli-two",
    "--evaluator-roots", `evaluator:cli=${hash("root:cli")},evaluator:cli-two=${hash("root:cli-two")}`,
    "--persona", "agent:synthetic", "--user", "user:synthetic", "--tenant", "tenant:synthetic",
    "--project", "project:synthetic", "--task", "task:synthetic", "--confirm-local-evaluation", "--json"
  ], state);
  runCli([
    "learn-measurement", "measurement:cli-before", "--root", root, "--learning", "learning:cli-outcome",
    "--evaluation", "evaluation:cli", "--phase", "before", "--metric", "fixed-task-success", "--direction", "higher", "--value", "0.4",
    "--measurement", "objective", "--evaluator", "evaluator:cli", "--run", "run:cli-before", "--source-digest", hash("cli-source"),
    "--dataset-digest", hash("cli-dataset"), "--case-count", "8",
    "--persona", "agent:synthetic",
    "--user", "user:synthetic", "--tenant", "tenant:synthetic", "--project", "project:synthetic",
    "--task", "task:synthetic", "--confirm-local-measurement", "--json"
  ], state);
  runCli([
    "learn-outcome", "learning:cli-outcome", "--root", root, "--id", "outcome:cli-before",
    "--evaluation", "evaluation:cli", "--measurement-receipt", "measurement:cli-before", "--json"
  ], state);
  const status = runCli([
    "learn-status", root, "--persona", "agent:synthetic", "--user", "user:synthetic",
    "--tenant", "tenant:synthetic", "--project", "project:synthetic", "--task", "task:synthetic", "--json"
  ], state);
  assert.equal(status.records[0].beforeReceipts, 1);
  assert.equal(status.records[0].coverageBoundReceipts, 1);
  assert.equal(status.records[0].legacyCoverageReceipts, 0);
  assert.equal(status.records[0].provenanceBoundReceipts, 1);
  assert.equal(status.records[0].legacyProvenanceReceipts, 0);
  assert.equal(status.records[0].lineageBoundReceipts, 1);
  assert.equal(status.records[0].pairedOutcomeReceipts, 1);
  assert.equal(status.records[0].pairedEvaluatorPairs, 0);
  assert.equal(status.records[0].evaluatorRootBoundReceipts, 1);
  assert.equal(status.records[0].independentEvaluatorRoots, 1);
  assert.equal(status.records[0].evaluatorRegistryContracts, 1);
  assert.equal(status.records[0].inactiveEvaluatorRegistryContracts, 0);
  assert.deepEqual(status.evaluatorRegistry, {
    active: 2, revoked: 0, bindings: 1, validationLeases: 0, authority: "context-only"
  });
  assert.equal(status.records[0].measurementReceipts, 1);
  assert.equal(status.records[0].measurementLineageReceipts, 1);
  assert.equal(status.records[0].consumedMeasurementReceipts, 1);
  assert.equal(status.records[0].canaryStatus, "not-applicable");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.pairedOutcomeReceipts, 1);
  assert.equal(doctor.learningOutcomes.pairedEvaluatorPairs, 0);
  assert.equal(doctor.learningOutcomes.evaluatorRootBoundReceipts, 1);
  assert.equal(doctor.learningOutcomes.independentEvaluatorRoots, 1);
  assert.equal(doctor.learningOutcomes.activeEvaluatorRoots, 2);
  assert.equal(doctor.learningOutcomes.revokedEvaluatorRoots, 0);
  assert.equal(doctor.learningOutcomes.evaluatorRegistryBindings, 1);
  assert.equal(doctor.learningOutcomes.evaluatorRegistryContracts, 1);
  assert.equal(doctor.learningOutcomes.inactiveEvaluatorRegistryContracts, 0);
});
