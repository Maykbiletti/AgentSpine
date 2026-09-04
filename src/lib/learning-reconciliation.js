import { createHash, randomUUID } from "node:crypto";
import {
  ID_RE, DIGEST_RE, ROOT_BOUND_EVALUATIONS, REGISTRY_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS, TARGET_BOUND_EVALUATIONS,
  BOUNDED_TRIAL_RETRY_EVALUATIONS, BLOCKING_DEFECT_BOUND_EVALUATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS, TRIAL_FAILURE_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  exactScope, digest, learningTargetForCandidate, revokedMeasurement, activeEvaluationBinding, revokedEvaluation
} from "./learning-scope-targets.js";
import {
  revokedEvidenceSourceAttestation
} from "./learning-measurement-contracts.js";
import {
  trialFailurePayload, storedTrialFailureStructure, trialFailureMatchesState, trialFailureRevocationPayload
} from "./learning-evaluation-contracts.js";
import {
  revokedTrialFailure, trialRetryExhaustionPayload, trialRetryExhaustionMatchesState
} from "./learning-retry-contracts.js";
import {
  date, safeText, mutation, preserve
} from "./learning-storage.js";
import {
  outcomeFresh
} from "./learning-applications.js";

export function outcomeMatchesContract(receipt, contract) {
  if (ROOT_BOUND_EVALUATIONS.has(contract.schema)) {
    const root = contract.evaluatorRoots.find((item) => item.evaluatorId === receipt.measurement?.evaluatorId);
    return receipt.schema === "agentspine.learning-outcome/v9"
      && ID_RE.test(receipt.measurementReceiptId || "") && DIGEST_RE.test(receipt.measurementReceiptDigest || "")
      && DIGEST_RE.test(receipt.measurement?.sourceDigest || "")
      && root?.principalDigest === receipt.measurement?.evaluatorRootDigest
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases;
  }
  if (contract.schema === "agentspine.learning-evaluation/v5") {
    return receipt.schema === "agentspine.learning-outcome/v8"
      && ID_RE.test(receipt.measurementReceiptId || "") && DIGEST_RE.test(receipt.measurementReceiptDigest || "")
      && DIGEST_RE.test(receipt.measurement?.sourceDigest || "")
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases;
  }
  if (contract.schema === "agentspine.learning-evaluation/v4") {
    return receipt.schema === "agentspine.learning-outcome/v7"
      && ID_RE.test(receipt.measurementReceiptId || "") && DIGEST_RE.test(receipt.measurementReceiptDigest || "")
      && DIGEST_RE.test(receipt.measurement?.sourceDigest || "")
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases;
  }
  if (contract.schema === "agentspine.learning-evaluation/v3") {
    return receipt.schema === "agentspine.learning-outcome/v6"
      && DIGEST_RE.test(receipt.measurement?.sourceDigest || "")
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases;
  }
  if (contract.schema === "agentspine.learning-evaluation/v2") {
    return receipt.schema === "agentspine.learning-outcome/v5"
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases;
  }
  return ["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4"].includes(receipt.schema);
}

export function outcomeMatchesInitialTrial(state, receipt, contract) {
  if (!INITIAL_TRIAL_EVALUATIONS.has(contract?.schema)) return true;
  const trial = contract.initialTrials?.[receipt.phase]?.find((entry) =>
    entry.evaluatorId === receipt.measurement?.evaluatorId);
  const measurement = state.measurements.find((entry) => entry.id === receipt.measurementReceiptId
    && entry.digest === receipt.measurementReceiptDigest);
  if (!trial || !measurement || measurement.measurement.evaluatorRootDigest !== trial.evaluatorRootDigest
    || measurement.measurement.runId !== trial.runId || measurement.coverage.caseCount !== trial.caseCount) return false;
  if (receipt.phase !== "after") return true;
  const application = state.applications.find((entry) => entry.id === receipt.applicationId
    && INITIAL_TRIAL_APPLICATIONS.has(entry.schema)
    && entry.initialAdmission.evaluationId === contract.id
    && entry.initialAdmission.evaluationDigest === contract.digest
    && entry.initialAdmission.slot === trial.slot
    && entry.initialAdmission.trialDigest === trial.trialDigest
    && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
      || (TARGET_BOUND_APPLICATIONS.has(entry.schema)
        && entry.initialAdmission.targetDigest === contract.target.digest)));
  const delivery = application && state.deliveries.find((entry) => entry.id === receipt.deliveryId
    && entry.applicationId === application.id);
  return Boolean(application && delivery);
}

export function promotableReceipts(state, candidate, timestamp) {
  const contracts = state.evaluations.filter((contract) => contract.learningId === candidate.id
    && !revokedEvaluation(state, contract.id)
    && !revokedEvidenceSourceAttestation(state, contract.id)
    && new Date(contract.expiresAt).getTime() >= new Date(timestamp).getTime()
    && (!REGISTRY_BOUND_EVALUATIONS.has(contract.schema)
      || activeEvaluationBinding(state, contract)));
  const groups = contracts.map((contract) => {
    const receipts = state.outcomes.filter((item) => outcomeMatchesContract(item, contract)
      && item.learningId === candidate.id && item.evaluationId === contract.id && item.phase === "before"
      && exactScope(item.scope, contract.scope) && outcomeFresh(item, contract, state.config, timestamp)
      && !revokedMeasurement(state, item.measurementReceiptId)
      && item.measurement.kind !== "model-suggestion" && outcomeMatchesInitialTrial(state, item, contract));
    if (INITIAL_TRIAL_EVALUATIONS.has(contract.schema)) receipts.sort((a, b) =>
      contract.initialTrials.before.findIndex((trial) => trial.evaluatorId === a.measurement.evaluatorId)
      - contract.initialTrials.before.findIndex((trial) => trial.evaluatorId === b.measurement.evaluatorId));
    return { contract, receipts };
  }).filter(({ contract, receipts }) => receipts.some((item) => item.measurement.kind === "objective")
    && (!BLOCKING_DEFECT_BOUND_EVALUATIONS.has(contract.schema)
      || receipts.every((item) => item.metric.blockingDefects === 0))
    && new Set(receipts.map((item) => ROOT_BOUND_EVALUATIONS.has(contract.schema)
      ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId)).size >= contract.thresholds.beforeReceipts)
    .sort((a, b) => b.receipts.length - a.receipts.length || a.contract.id.localeCompare(b.contract.id));
  return groups[0] || null;
}

export function improvement(direction, baseline, value) {
  return direction === "higher" ? value - baseline : baseline - value;
}

export function rollbackCandidate(state, candidate, reason, timestamp, mode = "manual", trialFailure = null) {
  preserve(state, "learning-candidate", candidate, timestamp);
  const validationLeaseId = candidate.promotion?.mode === "outcome-canary"
    ? candidate.promotion.canary?.validationLeaseId : null;
  if (validationLeaseId) {
    const validationLease = state.validationLeases.find((entry) => entry.id === validationLeaseId);
    preserve(state, "learning-validation", validationLease, timestamp);
    state.validationLeases = state.validationLeases.filter((entry) => entry.id !== validationLeaseId);
  }
  const restored = [];
  for (const previousId of candidate.supersededIds || []) {
    const previous = state.candidates.find((entry) => entry.id === previousId);
    if (previous?.status === "superseded") {
      preserve(state, "learning-candidate", previous, timestamp);
      state.candidates = state.candidates.map((entry) => entry.id === previousId
        ? { ...entry, status: "accepted", updatedAt: timestamp, authority: "context-only" }
        : entry);
      restored.push(previousId);
    }
  }
  const rolledBack = {
    ...candidate,
    status: "rolled-back",
    ...(candidate.promotion?.mode === "outcome-canary" ? {
      promotion: { ...candidate.promotion, canary: { ...candidate.promotion.canary, revalidation: null } }
    } : {}),
    updatedAt: timestamp,
    rollback: {
      reason,
      mode,
      rolledBackAt: timestamp,
      ...(trialFailure ? { trialFailureId: trialFailure.id, trialFailureDigest: trialFailure.digest } : {}),
      authority: "context-only"
    },
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? rolledBack : entry);
  return { candidate: rolledBack, restored };
}

export function recordInitialTrialFailure(state, timeout, timestamp) {
  const { evaluation, application, failure, deadline } = timeout;
  const id = `trial-failure:${createHash("sha256").update(`${application.id}\0${failure}`).digest("hex").slice(0, 32)}`;
  const payload = trialFailurePayload({
    id,
    learningId: application.learningId,
    evaluationId: evaluation.id,
    evaluationDigest: evaluation.digest,
    applicationId: application.id,
    applicationDigest: application.digest,
    slot: application.initialAdmission.slot,
    trialDigest: application.initialAdmission.trialDigest,
    targetDigest: application.initialAdmission.targetDigest,
    completionPolicyDigest: application.completionPolicyDigest,
    failure,
    deadline,
    observedAt: timestamp
  });
  const receipt = { ...payload, digest: digest(payload) };
  const existing = state.trialFailures.find((entry) => entry.id === id);
  if (existing) {
    if (existing.applicationId !== application.id || existing.failure !== failure) {
      throw new Error("learning trial failure receipt IDs are immutable");
    }
    return existing;
  }
  state.trialFailures.push(receipt);
  state.trialFailures.sort((a, b) => a.id.localeCompare(b.id));
  return receipt;
}

export function recordTrialRetryExhaustion(state, failure) {
  const evaluation = state.evaluations.find((entry) => entry.id === failure.evaluationId
    && entry.digest === failure.evaluationDigest && entry.learningId === failure.learningId);
  if (!evaluation || !BOUNDED_TRIAL_RETRY_EVALUATIONS.has(evaluation.schema)) return null;
  const retry = evaluation.retry;
  const id = `trial-retry-exhaustion:${createHash("sha256")
    .update(`${retry.rootEvaluationId}\0${evaluation.id}\0${failure.id}`).digest("hex").slice(0, 32)}`;
  const payload = trialRetryExhaustionPayload({
    id,
    learningId: failure.learningId,
    rootEvaluationId: retry.rootEvaluationId,
    rootEvaluationDigest: retry.rootEvaluationDigest,
    correctiveEvaluationId: evaluation.id,
    correctiveEvaluationDigest: evaluation.digest,
    trialFailureId: failure.id,
    trialFailureDigest: failure.digest,
    targetDigest: evaluation.target.digest,
    scopeDigest: digest(evaluation.scope),
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    exhaustedAt: failure.observedAt
  });
  const receipt = { ...payload, digest: digest(payload) };
  const existing = state.trialRetryExhaustions.find((entry) => entry.id === id);
  if (existing) {
    if (existing.digest !== receipt.digest) throw new Error("learning trial retry exhaustion IDs are immutable");
    return existing;
  }
  if (!trialRetryExhaustionMatchesState(state, receipt)) {
    throw new Error("learning trial retry exhaustion binding is invalid");
  }
  state.trialRetryExhaustions.push(receipt);
  state.trialRetryExhaustions.sort((a, b) => a.id.localeCompare(b.id));
  return receipt;
}

export async function revokeLearningTrialFailure({
  root = process.cwd(), trialFailureId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-trial-failure-revocation-confirmed") {
    throw new Error("trial failure revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(trialFailureId || "")) throw new Error("trialFailureId must be a stable identifier");
  if (!TRIAL_FAILURE_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be clock-invalid, host-invalid, receipt-invalid, scope-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const failure = state.trialFailures.find((entry) => entry.id === trialFailureId);
    if (!failure || !storedTrialFailureStructure(failure) || !trialFailureMatchesState(state, failure)) {
      throw new Error(`unknown or non-current learning trial failure: ${trialFailureId}`);
    }
    const candidate = state.candidates.find((entry) => entry.id === failure.learningId);
    const evaluation = state.evaluations.find((entry) => entry.id === failure.evaluationId
      && entry.digest === failure.evaluationDigest);
    const binding = state.evaluationBindings.find((entry) => entry.evaluationId === failure.evaluationId
      && entry.evaluationDigest === failure.evaluationDigest);
    const application = state.applications.find((entry) => entry.id === failure.applicationId
      && entry.digest === failure.applicationDigest);
    if (!candidate || !evaluation || !binding || !application) {
      throw new Error("trial failure revocation requires its immutable candidate, contract, binding, and application");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const scopeDigest = digest(application.scope);
    const reasonDigest = digest(revokeReason);
    const existing = revokedTrialFailure(state, trialFailureId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.learningId !== candidate.id || existing.evaluationId !== evaluation.id
        || existing.evaluationDigest !== evaluation.digest || existing.evaluatorBindingDigest !== binding.digest
        || existing.applicationId !== application.id || existing.applicationDigest !== application.digest
        || existing.trialFailureDigest !== failure.digest || existing.targetDigest !== targetDigest
        || existing.scopeDigest !== scopeDigest) {
        throw new Error("learning trial failure revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, requiresFreshCandidate: true,
        authority: "context-only" };
    }
    const id = `trial-failure-revocation:${createHash("sha256")
      .update(`${failure.id}\0${failure.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = trialFailureRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      evaluatorBindingDigest: binding.digest,
      applicationId: application.id,
      applicationDigest: application.digest,
      trialFailureId: failure.id,
      trialFailureDigest: failure.digest,
      targetDigest,
      scopeDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.trialFailureRevocations.push(receipt);
    state.trialFailureRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, requiresFreshCandidate: true,
      authority: "context-only" };
  });
}
