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
  purgeLearningBySubject, purgeStaleLearningApplications, purgeStaleLearningMeasurements, recordLearningApplications, recordLearningDeliveries,
  recordLearningMeasurement, recordLearningOutcome as commitLearningOutcome, registerLearningEvaluation,
  registerLearningEvaluator, renewLearningValidation, revokeLearningEvaluator, revokeLearningEvidence,
  revokeLearningApplication, revokeLearningDelivery, revokeLearningEvaluation, revokeLearningMeasurement, revokeLearningOutcome, revokeLearningTrialFailure, revokeLearningValidation,
  revokeLearningEvidenceSourceAttestation,
  reviewLearning, rollbackLearning
} from "../src/lib/learning.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-learning-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-learning-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n\nKeep sources unchanged.\n", "utf8");
  await writeFile(join(root, "REFERENCE.md"), "# Synthetic reference\n", "utf8");
  return { root, state };
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function evidence(id, confidence = 0.9) {
  return { id, type: "user-statement", summary: `Synthetic evidence ${id}`, confidence };
}

export const scopedTurn = {
  personaId: "agent:synthetic", userId: "user:synthetic", tenantId: "tenant:synthetic",
  projectId: "project:synthetic", groupId: null, taskId: "task:synthetic"
};
export const syntheticDatasetDigest = hash("synthetic fixed benchmark dataset");

export function outcome(id, phase, value, evaluatorId, extra = {}) {
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

export async function recordLearningOutcome(input) {
  const { learning } = await loadLearning(input.root);
  const evaluation = learning.evaluations.find((item) => item.id === input.evaluationId);
  if (!["agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7", "agentspine.learning-evaluation/v8", "agentspine.learning-evaluation/v9", "agentspine.learning-evaluation/v10", "agentspine.learning-evaluation/v11", "agentspine.learning-evaluation/v12", "agentspine.learning-evaluation/v13", "agentspine.learning-evaluation/v14", "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v16", "agentspine.learning-evaluation/v17", "agentspine.learning-evaluation/v18", "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v20", "agentspine.learning-evaluation/v21", "agentspine.learning-evaluation/v22", "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24", "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26", "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28", "agentspine.learning-evaluation/v29"].includes(evaluation?.schema)) {
    return commitLearningOutcome(input);
  }
  const initialTrial = ["agentspine.learning-evaluation/v8", "agentspine.learning-evaluation/v9", "agentspine.learning-evaluation/v10", "agentspine.learning-evaluation/v11", "agentspine.learning-evaluation/v12", "agentspine.learning-evaluation/v13", "agentspine.learning-evaluation/v14", "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v16", "agentspine.learning-evaluation/v17", "agentspine.learning-evaluation/v18", "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v20", "agentspine.learning-evaluation/v21", "agentspine.learning-evaluation/v22", "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24", "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26", "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28", "agentspine.learning-evaluation/v29"].includes(evaluation.schema)
    ? evaluation.initialTrials?.[input.phase]?.find((entry) => entry.evaluatorId === input.measurement?.evaluatorId)
    : null;
  if (["agentspine.learning-evaluation/v8", "agentspine.learning-evaluation/v9", "agentspine.learning-evaluation/v10", "agentspine.learning-evaluation/v11", "agentspine.learning-evaluation/v12", "agentspine.learning-evaluation/v13", "agentspine.learning-evaluation/v14", "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v16", "agentspine.learning-evaluation/v17", "agentspine.learning-evaluation/v18", "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v20", "agentspine.learning-evaluation/v21", "agentspine.learning-evaluation/v22", "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24", "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26", "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28", "agentspine.learning-evaluation/v29"].includes(evaluation.schema) && !initialTrial) {
    return commitLearningOutcome(input);
  }
  const measurementId = `measurement:${input.id}`;
  let measurementReceipt = learning.measurements.find((item) => item.id === measurementId);
  if (!measurementReceipt) {
    measurementReceipt = (await recordLearningMeasurement({
      root: input.root, id: measurementId, learningId: input.learningId, evaluationId: input.evaluationId,
      phase: input.phase, scope: input.scope, metric: input.metric,
      measurement: { ...input.measurement, runId: initialTrial?.runId || `run:${input.id}` }, coverage: input.coverage,
      measuredAt: input.measuredAt, confirmLocalMeasurement: true, now: input.now
    })).receipt;
  }
  return commitLearningOutcome({
    root: input.root, id: input.id, learningId: input.learningId, evaluationId: input.evaluationId,
    measurementReceiptId: measurementReceipt.id, applicationId: input.applicationId,
    deliveryId: input.deliveryId, now: input.now
  });
}

export const syntheticEvaluators = [
  "evaluator:test-a", "evaluator:test-b", "evaluator:test-c", "evaluator:user-b",
  "evaluator:baseline-a", "evaluator:baseline-b", "evaluator:after-a", "evaluator:after-b",
  "evaluator:after-c", "evaluator:hook-before-a", "evaluator:hook-before-b", "evaluator:test-race",
  "evaluator:model-a", "evaluator:model-b"
];

export function evaluatorRoots(evaluatorIds = syntheticEvaluators) {
  return evaluatorIds.map((evaluatorId) => ({ evaluatorId, principalDigest: hash(`evaluator-root:${evaluatorId}`) }));
}

export async function evaluation(root, learningId, extra = {}) {
  const ids = extra.evaluatorIds || syntheticEvaluators;
  const roots = new Map((extra.evaluatorRoots || evaluatorRoots(ids))
    .map((entry) => [entry.evaluatorId, entry.principalDigest]));
  for (const evaluatorId of ids) {
    await registerLearningEvaluator({ root, id: evaluatorId, principalDigest: roots.get(evaluatorId),
      confirmLocalEvaluator: true, now: extra.now || new Date() });
  }
  return registerLearningEvaluation({
    root, id: extra.id || "evaluation:fixed", learningId, scope: extra.scope || scopedTurn,
    metric: extra.metric || { name: "fixed-task-success", direction: "higher" },
    benchmark: extra.benchmark || {
      taskDigest: hash(`task:${learningId}`), datasetDigest: syntheticDatasetDigest,
      protocolDigest: hash(`protocol:${learningId}`), minCases: 12
    },
    evaluatorIds: ids,
    evaluatorRoots: [...roots].map(([evaluatorId, principalDigest]) => ({ evaluatorId, principalDigest })),
    retryTrialFailureId: extra.retryTrialFailureId || null,
    confirmLocalTrialRetry: extra.confirmLocalTrialRetry || false,
    expiresAt: extra.expiresAt || null, confirmLocalEvaluation: true,
    confirmLocalEvidenceSources: extra.confirmLocalEvidenceSources ?? true,
    now: extra.now || new Date()
  });
}

export async function projectedApplication(root, learningId, turnId, now = new Date(), outcomeStatus = "active", scope = scopedTurn) {
  const projectedAt = new Date(now);
  const createdAt = new Date(projectedAt.getTime() - 1000).toISOString();
  const expiresAt = new Date(projectedAt.getTime() + 60_000).toISOString();
  const result = await recordLearningApplications({
    root, items: [{ id: learningId, outcomeStatus }], scope,
    preflightReceipt: {
      schema: "agentspine.preflight/v2", id: `preflight:${turnId}`, status: "ready",
      sessionId: `session:${turnId}`,
      promptDigest: hash(`prompt:${turnId}`), briefingDigest: hash(`preflight:${turnId}`),
      agentId: scope.personaId, userId: scope.userId, tenantId: scope.tenantId,
      projectId: scope.projectId, groupId: scope.groupId, taskId: scope.taskId,
      createdAt, expiresAt
    },
    sessionBriefingDigest: hash(`briefing:${turnId}`), projectedAt
  });
  const application = result.receipts[0];
  assert.ok(application, JSON.stringify(result));
  assert.ok(new Date(projectedAt).getTime() <= new Date(application.deliveryExpiresAt).getTime(), JSON.stringify(application));
  return application;
}

export async function application(root, learningId, turnId, now = new Date(), outcomeStatus = "active", scope = scopedTurn) {
  const projectedAt = new Date(now);
  const application = await projectedApplication(root, learningId, turnId, projectedAt, outcomeStatus, scope);
  const delivered = await recordLearningDeliveries({
    root, sessionId: `session:${turnId}`, scope, hookEvent: "Stop", completedAt: projectedAt
  });
  assert.ok(delivered.receipts[0], JSON.stringify(delivered));
  return { ...application, deliveryId: delivered.receipts[0].id };
}

export async function establishValidatedLearning(root, {
  learningId, evaluationId, start, expiresAt, supersedesId = null, subjectId = null,
  scope = scopedTurn, privacy = "shared", groupId = null
}) {
  const suffix = learningId.split(":").at(-1);
  await proposeLearning({
    root, id: learningId, kind: "behavior", claim: `Use validated synthetic strategy ${suffix}.`,
    privacy, groupId, scope, supersedesId, subjectId,
    evidence: evidence(`evidence:${suffix}-one`, 0.97), now: start
  });
  await addLearningEvidence({ root, id: learningId,
    evidence: evidence(`evidence:${suffix}-two`, 0.97), now: start });
  await configureLearning({ root, config: {
    autoPromote: true, minConfidence: 0.9, minEvidence: 2, minOutcomeReceipts: 2,
    canaryReceipts: 2, minImprovement: 0.1, canaryTtlDays: 30
  }, now: start });
  await evaluation(root, learningId, {
    id: evaluationId, evaluatorIds: ["evaluator:test-a", "evaluator:test-b"], scope, now: start, expiresAt
  });
  await recordLearningOutcome({ root, learningId,
    ...outcome(`outcome:${suffix}-before-a`, "before", 0.4, "evaluator:test-a", { evaluationId, measuredAt: start, scope }),
    now: start });
  await recordLearningOutcome({ root, learningId,
    ...outcome(`outcome:${suffix}-before-b`, "before", 0.5, "evaluator:test-b", { evaluationId, measuredAt: start, scope }),
    now: start });
  await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  const firstApplication = await application(root, learningId, `${suffix}-a`,
    new Date(start.getTime() + 2000), "active", scope);
  await recordLearningOutcome({ root, learningId, applicationId: firstApplication.id,
    deliveryId: firstApplication.deliveryId,
    ...outcome(`outcome:${suffix}-after-a`, "after", 0.8, "evaluator:test-a", {
      evaluationId, measuredAt: new Date(start.getTime() + 2000), scope
    }), now: new Date(start.getTime() + 2000) });
  const secondApplication = await application(root, learningId, `${suffix}-b`,
    new Date(start.getTime() + 3000), "active", scope);
  return recordLearningOutcome({ root, learningId, applicationId: secondApplication.id,
    deliveryId: secondApplication.deliveryId,
    ...outcome(`outcome:${suffix}-after-b`, "after", 0.9, "evaluator:test-b", {
      evaluationId, measuredAt: new Date(start.getTime() + 3000), scope
    }), now: new Date(start.getTime() + 3000) });
}

export function runCli(args, state) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

export {
  test, assert, readFile, writeFile, join, fileURLToPath, spawnSync,
  commitLearningOutcome,
  addLearningEvidence,
  beginLearningRevalidation, configureLearning, deleteLearning, evaluateLearning, learningContext, learningOutcomeStatus,
  loadLearning, proposeLearning, purgeLearningBySubject, purgeStaleLearningApplications, purgeStaleLearningMeasurements, recordLearningApplications,
  recordLearningDeliveries, recordLearningMeasurement, registerLearningEvaluation, registerLearningEvaluator, renewLearningValidation, revokeLearningEvaluator,
  revokeLearningEvidence, revokeLearningApplication, revokeLearningDelivery, revokeLearningEvaluation, revokeLearningMeasurement, revokeLearningOutcome,
  revokeLearningTrialFailure, revokeLearningValidation, revokeLearningEvidenceSourceAttestation, reviewLearning, rollbackLearning, linkEntities,
  upsertEntity, runHook
};
