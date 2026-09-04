import { createHash, randomUUID } from "node:crypto";
import {
  PAIRED_EVALUATIONS, ROOT_BOUND_EVALUATIONS, REGISTRY_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS
} from "./learning-schema.js";
import {
  exactScope, digest, revokedMeasurementForCandidate, activeEvaluationBinding
} from "./learning-scope-targets.js";
import {
  revokedEvaluationForCandidate, validationOutcomeReferences, validationLeasePayload
} from "./learning-validation-contracts.js";
import {
  revokedValidationForCandidate, validationLeaseState, initialTrialTimeout
} from "./learning-validation-runtime.js";
import {
  revokedEvidenceSourceAttestationForCandidate
} from "./learning-measurement-contracts.js";
import {
  revokedApplicationForCandidate, revokedOutcomeForCandidate
} from "./learning-delivery-contracts.js";
import {
  preserve
} from "./learning-storage.js";
import {
  outcomeFresh
} from "./learning-applications.js";
import {
  outcomeMatchesContract, outcomeMatchesInitialTrial, improvement, rollbackCandidate, recordInitialTrialFailure, recordTrialRetryExhaustion
} from "./learning-reconciliation.js";

export function reconcileCanary(state, candidate, timestamp) {
  const canary = candidate.promotion?.canary;
  if (candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
    || !["active", "validated"].includes(canary?.status)) {
    return { candidate, decision: "unchanged", restored: [] };
  }
  const evaluationRevocation = revokedEvaluationForCandidate(state, candidate);
  if (evaluationRevocation) {
    const result = rollbackCandidate(state, candidate, "learning evaluation contract was explicitly revoked",
      timestamp, "automatic-evaluation-revocation");
    return { ...result, decision: "rolled-back", evaluationRevocation };
  }
  const evidenceSourceAttestationRevocation = revokedEvidenceSourceAttestationForCandidate(state, candidate);
  if (evidenceSourceAttestationRevocation) {
    const result = rollbackCandidate(state, candidate, "learning evidence source attestation was explicitly revoked",
      timestamp, "automatic-evidence-source-attestation-revocation");
    return { ...result, decision: "rolled-back", evidenceSourceAttestationRevocation };
  }
  const validationRevocation = revokedValidationForCandidate(state, candidate);
  if (validationRevocation) {
    const result = rollbackCandidate(state, candidate, "learning validation decision was explicitly revoked",
      timestamp, "automatic-validation-revocation");
    return { ...result, decision: "rolled-back", validationRevocation };
  }
  const measurementRevocation = revokedMeasurementForCandidate(state, candidate);
  if (measurementRevocation) {
    const result = rollbackCandidate(state, candidate, "learning measurement evidence was explicitly revoked",
      timestamp, "automatic-measurement-revocation");
    return { ...result, decision: "rolled-back", measurementRevocation };
  }
  const applicationRevocation = revokedApplicationForCandidate(state, candidate);
  if (applicationRevocation) {
    const result = rollbackCandidate(state, candidate, "learning application evidence was explicitly revoked",
      timestamp, "automatic-application-revocation");
    return { ...result, decision: "rolled-back", applicationRevocation };
  }
  const outcomeRevocation = revokedOutcomeForCandidate(state, candidate);
  if (outcomeRevocation) {
    const result = rollbackCandidate(state, candidate, "learning outcome evidence was explicitly revoked",
      timestamp, "automatic-outcome-revocation");
    return { ...result, decision: "rolled-back", outcomeRevocation };
  }
  if (new Date(canary.expiresAt).getTime() <= new Date(timestamp).getTime()) {
    const result = rollbackCandidate(state, candidate, canary.status === "validated"
      ? "validated learning evidence lease expired" : "outcome canary expired before validation", timestamp,
    canary.status === "validated" ? "automatic-validation-stale" : "automatic-stale");
    return { ...result, decision: "rolled-back" };
  }
  const evaluation = canary.evaluationId
    ? state.evaluations.find((contract) => contract.id === canary.evaluationId && contract.learningId === candidate.id)
    : null;
  if (canary.evaluationId && (!evaluation || evaluation.digest !== canary.evaluationDigest
    || new Date(evaluation.expiresAt).getTime() <= new Date(timestamp).getTime())) {
    const result = rollbackCandidate(state, candidate, "outcome evaluation contract is missing, changed, or stale", timestamp, "automatic-stale");
    return { ...result, decision: "rolled-back" };
  }
  if (REGISTRY_BOUND_EVALUATIONS.has(evaluation?.schema)
    && !activeEvaluationBinding(state, evaluation)) {
    const result = rollbackCandidate(state, candidate, "outcome evaluator registry binding was revoked or changed", timestamp, "automatic-evaluator-revocation");
    return { ...result, decision: "rolled-back" };
  }
  const failedTrial = initialTrialTimeout(state, candidate, timestamp);
  if (failedTrial) {
    const failureReceipt = recordInitialTrialFailure(state, failedTrial, timestamp);
    const result = rollbackCandidate(state, candidate,
      failedTrial.failure === "delivery-timeout"
        ? "initial Canary trial missed its immutable model-turn delivery deadline"
        : "initial Canary trial missed its immutable measured-outcome deadline",
      timestamp, "automatic-incomplete-trial", failureReceipt);
    const retryExhaustionReceipt = recordTrialRetryExhaustion(state, failureReceipt);
    return { ...result, decision: "rolled-back", failureReceipt, retryExhaustionReceipt };
  }
  if (canary.status === "validated") {
    const validation = validationLeaseState(state, candidate, timestamp);
    if (REGISTRY_BOUND_EVALUATIONS.has(evaluation?.schema)
      && validation.status !== "active") {
      const result = rollbackCandidate(state, candidate,
        validation.status === "missing" ? "validated learning is missing its immutable evidence lease"
          : "validated learning evidence lease is no longer current",
        timestamp, validation.status === "missing" ? "automatic-validation-unproven" : "automatic-validation-stale");
      return { ...result, decision: "rolled-back" };
    }
    return { candidate, decision: "unchanged", restored: [] };
  }
  const planned = Boolean(evaluation);
  const receipts = state.outcomes.filter((item) => (planned
    ? outcomeMatchesContract(item, evaluation)
    : item.schema === "agentspine.learning-outcome/v2")
    && item.learningId === candidate.id && item.phase === "after"
    && (!planned || item.evaluationId === evaluation.id)
    && exactScope(item.scope, canary.scope) && item.metric.name === canary.metric.name
    && item.metric.direction === canary.metric.direction && outcomeFresh(item, evaluation, state.config, timestamp)
    && outcomeMatchesInitialTrial(state, item, evaluation)
    && state.applications.some((application) => application.id === item.applicationId
      && application.learningId === candidate.id && exactScope(application.scope, canary.scope)));
  if (receipts.some((item) => item.metric.blockingDefects > 0)) {
    const result = rollbackCandidate(state, candidate, "outcome canary recorded a blocking defect", timestamp, "automatic-regression");
    return { ...result, decision: "rolled-back" };
  }
  const paired = PAIRED_EVALUATIONS.has(evaluation?.schema);
  const rootBound = ROOT_BOUND_EVALUATIONS.has(evaluation?.schema);
  const beforeByEvaluator = paired ? new Map((canary.beforeReceipts || [])
    .map((id) => state.outcomes.find((item) => item.id === id))
    .filter((item) => item?.schema === (rootBound ? "agentspine.learning-outcome/v9" : "agentspine.learning-outcome/v8"))
    .map((item) => [rootBound ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId, item])) : new Map();
  const eligible = receipts.filter((item) => item.measurement.kind !== "model-suggestion"
    && (!paired || beforeByEvaluator.has(rootBound ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId)));
  if (INITIAL_TRIAL_EVALUATIONS.has(evaluation?.schema)) eligible.sort((a, b) =>
    evaluation.initialTrials.after.findIndex((trial) => trial.evaluatorId === a.measurement.evaluatorId)
    - evaluation.initialTrials.after.findIndex((trial) => trial.evaluatorId === b.measurement.evaluatorId));
  const independentEvaluators = new Set(eligible.map((item) => rootBound
    ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId)).size;
  const independentApplications = new Set(eligible.map((item) => item.applicationId)).size;
  const deltas = eligible.map((item) => improvement(canary.metric.direction,
    paired ? beforeByEvaluator.get(rootBound ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId).metric.value : canary.baseline,
    item.metric.value));
  const thresholds = planned ? evaluation.thresholds : {
    regressionTolerance: state.config.regressionTolerance,
    afterReceipts: state.config.canaryReceipts,
    minImprovement: state.config.minImprovement
  };
  if (deltas.some((value) => value < -thresholds.regressionTolerance)) {
    const result = rollbackCandidate(state, candidate, "outcome canary regressed against its baseline", timestamp, "automatic-regression");
    return { ...result, decision: "rolled-back" };
  }
  if (independentEvaluators < thresholds.afterReceipts || independentApplications < thresholds.afterReceipts
    || !eligible.some((item) => item.measurement.kind === "objective")) {
    return { candidate, decision: "active", restored: [] };
  }
  const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  if (average < thresholds.minImprovement) {
    const result = rollbackCandidate(state, candidate, "outcome canary did not meet the minimum measured improvement", timestamp, "automatic-no-improvement");
    return { ...result, decision: "rolled-back" };
  }
  preserve(state, "learning-candidate", candidate, timestamp);
  let validationLease = null;
  if (REGISTRY_BOUND_EVALUATIONS.has(evaluation?.schema)) {
    const binding = activeEvaluationBinding(state, evaluation);
    if (!binding) {
      const result = rollbackCandidate(state, candidate, "outcome evaluator registry binding was revoked or changed",
        timestamp, "automatic-evaluator-revocation");
      return { ...result, decision: "rolled-back" };
    }
    const beforeOutcomes = (canary.beforeReceipts || []).map((id) => state.outcomes.find((item) => item.id === id));
    if (beforeOutcomes.some((item) => !item)) {
      const result = rollbackCandidate(state, candidate, "validated learning baseline evidence is missing",
        timestamp, "automatic-validation-unproven");
      return { ...result, decision: "rolled-back" };
    }
    const payload = validationLeasePayload({
      id: `validation:${randomUUID()}`,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      evaluatorRegistryBindingDigest: binding.digest,
      scope: canary.scope,
      metric: canary.metric,
      beforeOutcomes: validationOutcomeReferences(beforeOutcomes),
      afterOutcomes: validationOutcomeReferences(eligible),
      improvement: average,
      validatedAt: timestamp,
      expiresAt: canary.expiresAt
    });
    validationLease = { ...payload, digest: digest(payload) };
    state.validationLeases.push(validationLease);
    state.validationLeases.sort((a, b) => a.id.localeCompare(b.id));
  }
  const validated = {
    ...candidate,
    promotion: {
      ...candidate.promotion,
      canary: {
        ...canary,
        status: "validated",
        validatedAt: timestamp,
        afterReceipts: eligible.map((item) => item.id),
        improvement: average,
        ...(validationLease ? {
          validationLeaseId: validationLease.id,
          validationLeaseDigest: validationLease.digest
        } : {})
      }
    },
    updatedAt: timestamp,
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? validated : entry);
  return { candidate: validated, decision: "validated", restored: [] };
}
