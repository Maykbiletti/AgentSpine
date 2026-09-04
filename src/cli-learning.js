import { addLearningEvidence, beginLearningRevalidation, configureLearning, deleteLearning, evaluateLearning, learningContext, learningOutcomeStatus, loadLearning, proposeLearning, purgeStaleLearningApplications, purgeStaleLearningMeasurements, recordLearningMeasurement, recordLearningOutcome, registerLearningEvaluation, registerLearningEvaluator, renewLearningValidation, revokeLearningEvaluator, reviewLearning, revokeLearningApplication, revokeLearningDelivery, revokeLearningEvaluation, revokeLearningEvidence, revokeLearningMeasurement, revokeLearningOutcome, revokeLearningTrialFailure, revokeLearningValidation, revokeLearningEvidenceSourceAttestation, rollbackLearning } from "./lib/learning.js";
import { booleanFlag, evaluatorRootsFlag, hasLearningScope, learningScope, output } from "./cli-common.js";

export const learningCommands = new Set([
  "learn-propose",
  "learn-evidence",
  "learn-evidence-revoke",
  "learn-review",
  "learn-context",
  "learn-evaluate",
  "learn-evaluator-register",
  "learn-evaluator-revoke",
  "learn-evaluation",
  "learn-revalidation-start",
  "learn-revalidate",
  "learn-measurement",
  "learn-measurement-revoke",
  "learn-evaluation-revoke",
  "learn-evidence-source-attestation-revoke",
  "learn-validation-revoke",
  "learn-trial-failure-revoke",
  "learn-application-revoke",
  "learn-delivery-revoke",
  "learn-outcome-revoke",
  "learn-outcome",
  "learn-status",
  "learn-delivery-purge",
  "learn-measurement-purge",
  "learn-rollback",
  "learn-delete",
  "learn-config"
]);

export async function runLearningCommand({ command, flags, positional, json }) {
  if (command === "learn-propose") {
    return output(await proposeLearning({
      root: flags.root || process.cwd(), id: positional[0], kind: flags.kind,
      claim: flags.claim, subjectId: flags.subject || null, privacy: flags.privacy || "private",
      groupId: flags.group || null, supersedesId: flags.supersedes || null,
      scope: hasLearningScope(flags) ? learningScope(flags) : null,
      evidence: {
        id: flags["evidence-id"], type: flags["evidence-type"] || "user-statement",
        summary: flags.evidence, sourceDocument: flags.source || null,
        confidence: Number(flags.confidence ?? 0.5), observedAt: flags.at
      }
    }), json);
  }

  if (command === "learn-evidence") {
    return output(await addLearningEvidence({
      root: flags.root || process.cwd(), id: positional[0],
      evidence: {
        id: flags["evidence-id"], type: flags.type || "interaction", summary: flags.summary,
        sourceDocument: flags.source || null, confidence: Number(flags.confidence ?? 0.5), observedAt: flags.at
      }
    }), json);
  }

  if (command === "learn-evidence-revoke") {
    return output(await revokeLearningEvidence({
      root: flags.root || process.cwd(), learningId: positional[0], evidenceId: flags["evidence-id"],
      reasonCode: flags["reason-code"], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-evidence"])
        ? "local-evidence-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-review") {
    return output(await reviewLearning({
      root: flags.root || process.cwd(), id: positional[0], decision: flags.decision,
      reason: flags.reason, confirmedByUser: booleanFlag(flags["confirmed-by-user"])
    }), json);
  }

  if (command === "learn-context") {
    return output(await learningContext({
      root: positional[0] || process.cwd(), includePrivate: booleanFlag(flags["include-private"]),
      groupId: flags.group || null,
      scope: hasLearningScope(flags) ? learningScope(flags) : null,
      kinds: flags.kind ? String(flags.kind).split(",").filter(Boolean) : null,
      subjectIds: flags.subject ? String(flags.subject).split(",").filter(Boolean) : null,
      maxItems: flags["max-items"] === undefined ? null : Number(flags["max-items"])
    }), json);
  }

  if (command === "learn-evaluate") {
    return output(await evaluateLearning({ root: positional[0] || process.cwd() }), json);
  }

  if (command === "learn-evaluator-register") {
    return output(await registerLearningEvaluator({
      root: flags.root || process.cwd(), id: positional[0], principalDigest: flags["principal-digest"],
      confirmLocalEvaluator: booleanFlag(flags["confirm-local-evaluator"])
    }), json);
  }

  if (command === "learn-evaluator-revoke") {
    return output(await revokeLearningEvaluator({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason,
      confirmLocalEvaluator: booleanFlag(flags["confirm-local-evaluator"])
    }), json);
  }

  if (command === "learn-evaluation") {
    return output(await registerLearningEvaluation({
      root: flags.root || process.cwd(), id: positional[0], learningId: flags.learning,
      scope: learningScope(flags), metric: { name: flags.metric, direction: flags.direction },
      benchmark: {
        taskDigest: flags["task-digest"], datasetDigest: flags["dataset-digest"],
        protocolDigest: flags["protocol-digest"], minCases: Number(flags["min-cases"])
      },
      evaluatorIds: String(flags.evaluators || "").split(",").filter(Boolean),
      evaluatorRoots: evaluatorRootsFlag(flags["evaluator-roots"]),
      expiresAt: flags["expires-at"] || null,
      retryTrialFailureId: flags["retry-trial-failure"] || null,
      confirmLocalTrialRetry: booleanFlag(flags["confirm-local-trial-retry"]),
      confirmLocalEvidenceSources: booleanFlag(flags["confirm-local-evidence-sources"]),
      confirmLocalEvaluation: booleanFlag(flags["confirm-local-evaluation"])
    }), json);
  }

  if (command === "learn-revalidation-start") {
    return output(await beginLearningRevalidation({
      root: flags.root || process.cwd(), learningId: positional[0],
      confirmLocalValidation: booleanFlag(flags["confirm-local-validation"])
    }), json);
  }

  if (command === "learn-revalidate") {
    const measurements = String(flags.measurements || "").split(",").filter(Boolean);
    const applications = String(flags.applications || "").split(",").filter(Boolean);
    const deliveries = String(flags.deliveries || "").split(",").filter(Boolean);
    if (!measurements.length || measurements.length !== applications.length || measurements.length !== deliveries.length) {
      throw new Error("revalidation requires equally sized measurement, application, and delivery lists");
    }
    return output(await renewLearningValidation({
      root: flags.root || process.cwd(), learningId: positional[0],
      evidence: measurements.map((measurementId, index) => ({ measurementId,
        applicationId: applications[index], deliveryId: deliveries[index] })),
      confirmLocalValidation: booleanFlag(flags["confirm-local-validation"])
    }), json);
  }

  if (command === "learn-measurement") {
    return output(await recordLearningMeasurement({
      root: flags.root || process.cwd(), id: positional[0], learningId: flags.learning,
      evaluationId: flags.evaluation, phase: flags.phase, scope: learningScope(flags),
      metric: {
        name: flags.metric, direction: flags.direction, value: Number(flags.value),
        blockingDefects: Number(flags["blocking-defects"] ?? 0)
      },
      measurement: {
        kind: flags.measurement || "objective", evaluatorId: flags.evaluator,
        runId: flags.run, sourceDigest: flags["source-digest"]
      },
      coverage: { datasetDigest: flags["dataset-digest"], caseCount: Number(flags["case-count"]) },
      measuredAt: flags.at,
      confirmLocalMeasurement: booleanFlag(flags["confirm-local-measurement"])
    }), json);
  }

  if (command === "learn-measurement-revoke") {
    return output(await revokeLearningMeasurement({
      root: flags.root || process.cwd(), measurementId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-measurement-revocation"])
        ? "local-measurement-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-evaluation-revoke") {
    return output(await revokeLearningEvaluation({
      root: flags.root || process.cwd(), evaluationId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-evaluation-revocation"])
        ? "local-evaluation-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-evidence-source-attestation-revoke") {
    return output(await revokeLearningEvidenceSourceAttestation({
      root: flags.root || process.cwd(), evaluationId: positional[0], evidenceDigest: flags["evidence-digest"],
      reasonCode: flags["reason-code"], reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-evidence-source-attestation-revocation"])
        ? "local-evidence-source-attestation-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-validation-revoke") {
    return output(await revokeLearningValidation({
      root: flags.root || process.cwd(), validationLeaseId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-validation-revocation"])
        ? "local-validation-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-trial-failure-revoke") {
    return output(await revokeLearningTrialFailure({
      root: flags.root || process.cwd(), trialFailureId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-trial-failure-revocation"])
        ? "local-trial-failure-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-application-revoke") {
    return output(await revokeLearningApplication({
      root: flags.root || process.cwd(), applicationId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-application-revocation"])
        ? "local-application-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-delivery-revoke") {
    return output(await revokeLearningDelivery({
      root: flags.root || process.cwd(), deliveryId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-delivery-revocation"])
        ? "local-delivery-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-outcome-revoke") {
    return output(await revokeLearningOutcome({
      root: flags.root || process.cwd(), outcomeId: positional[0], reasonCode: flags["reason-code"],
      reason: flags.reason,
      confirmation: booleanFlag(flags["confirm-local-outcome-revocation"])
        ? "local-outcome-revocation-confirmed" : null
    }), json);
  }

  if (command === "learn-outcome") {
    const lineage = flags["measurement-receipt"] || null;
    return output(await recordLearningOutcome({
      root: flags.root || process.cwd(), learningId: positional[0], id: flags.id,
      evaluationId: flags.evaluation, measurementReceiptId: lineage,
      applicationId: flags.application || null, deliveryId: flags.delivery || null,
      ...(lineage ? {} : { phase: flags.phase, scope: learningScope(flags), metric: {
        name: flags.metric, direction: flags.direction, value: Number(flags.value),
        blockingDefects: Number(flags["blocking-defects"] ?? 0)
      },
      measurement: {
        kind: flags.measurement || "objective", evaluatorId: flags.evaluator,
        sourceDigest: flags["source-digest"] || null
      },
      coverage: {
        datasetDigest: flags["dataset-digest"],
        caseCount: Number(flags["case-count"])
      },
      measuredAt: flags.at })
    }), json);
  }

  if (command === "learn-status") {
    return output(await learningOutcomeStatus({
      root: positional[0] || process.cwd(), scope: hasLearningScope(flags) ? learningScope(flags) : null
    }), json);
  }

  if (command === "learn-delivery-purge") {
    return output(await purgeStaleLearningApplications({
      root: positional[0] || process.cwd(),
      confirmation: booleanFlag(flags["confirm-local-purge"]) ? "local-user-purge-confirmed" : null
    }), json);
  }

  if (command === "learn-measurement-purge") {
    return output(await purgeStaleLearningMeasurements({
      root: positional[0] || process.cwd(),
      confirmation: booleanFlag(flags["confirm-local-purge"]) ? "local-user-purge-confirmed" : null
    }), json);
  }

  if (command === "learn-rollback") {
    return output(await rollbackLearning({
      root: flags.root || process.cwd(), id: positional[0], reason: flags.reason
    }), json);
  }

  if (command === "learn-delete") {
    return output(await deleteLearning({ root: flags.root || process.cwd(), id: positional[0] }), json);
  }

  if (command === "learn-config") {
    const root = positional[0] || process.cwd();
    const config = {};
    if (flags["auto-promote"] !== undefined) config.autoPromote = booleanFlag(flags["auto-promote"]);
    if (flags["min-confidence"] !== undefined) config.minConfidence = Number(flags["min-confidence"]);
    if (flags["min-evidence"] !== undefined) config.minEvidence = Number(flags["min-evidence"]);
    if (flags["max-items"] !== undefined) config.maxContextItems = Number(flags["max-items"]);
    if (flags["min-outcomes"] !== undefined) config.minOutcomeReceipts = Number(flags["min-outcomes"]);
    if (flags["min-improvement"] !== undefined) config.minImprovement = Number(flags["min-improvement"]);
    if (flags["regression-tolerance"] !== undefined) config.regressionTolerance = Number(flags["regression-tolerance"]);
    if (flags["outcome-max-age-days"] !== undefined) config.outcomeMaxAgeDays = Number(flags["outcome-max-age-days"]);
    if (flags["canary-receipts"] !== undefined) config.canaryReceipts = Number(flags["canary-receipts"]);
    if (flags["canary-ttl-days"] !== undefined) config.canaryTtlDays = Number(flags["canary-ttl-days"]);
    if (flags["initial-trial-outcome-timeout-minutes"] !== undefined) {
      config.initialTrialOutcomeTimeoutMinutes = Number(flags["initial-trial-outcome-timeout-minutes"]);
    }
    if (!Object.keys(config).length) return output((await loadLearning(root)).learning.config, json);
    return output(await configureLearning({ root, config }), json);
  }
}
