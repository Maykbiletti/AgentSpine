import {
  ID_RE, DIGEST_RE, REGISTRY_BOUND_EVALUATIONS, DEADLINE_BOUND_EVALUATIONS, VALIDATION_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  exactScope, digest, learningTargetForCandidate, revokedEvidence, revokedMeasurementForCandidate, activeEvaluationBinding,
  revokedEvaluation
} from "./learning-scope-targets.js";
import {
  revokedEvaluationForCandidate, storedValidationLeaseStructure
} from "./learning-validation-contracts.js";
import {
  revokedEvidenceSourceAttestation, revokedEvidenceSourceAttestationForCandidate
} from "./learning-measurement-contracts.js";
import {
  revokedApplicationForCandidate, revokedDeliveryForCandidate, revokedOutcomeForCandidate
} from "./learning-delivery-contracts.js";

export function validationLeaseRecords(state) {
  return [...state.validationLeases, ...state.history
    .filter((entry) => entry.kind === "learning-validation")
    .map((entry) => entry.value)
    .filter(Boolean)];
}

export function validationLeaseRecord(state, id, leaseDigest = null) {
  return validationLeaseRecords(state).find((lease) => lease.id === id
    && (leaseDigest === null || lease.digest === leaseDigest)) || null;
}

export function validationLeaseChain(state, candidate) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (!canary?.validationLeaseId || !canary.validationLeaseDigest) return [];
  const chain = [];
  const seen = new Set();
  let lease = validationLeaseRecord(state, canary.validationLeaseId, canary.validationLeaseDigest);
  while (lease && !seen.has(lease.id)) {
    seen.add(lease.id);
    chain.push(lease);
    lease = lease.schema === "agentspine.learning-validation/v1" ? null
      : validationLeaseRecord(state, lease.predecessorValidation.id, lease.predecessorValidation.digest);
  }
  return chain;
}

export function validationRevocationPayload({ id, learningId, evaluationId, evaluationDigest,
  evaluatorBindingDigest, validationLeaseId, validationLeaseDigest, targetDigest, scopeDigest,
  reasonCode, reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-validation-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    evaluatorBindingDigest,
    validationLeaseId,
    validationLeaseDigest,
    targetDigest,
    scopeDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedValidationRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = validationRevocationPayload(receipt);
  return receipt.schema === "agentspine.learning-validation-revocation/v1"
    && Object.keys(receipt).length === 15
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId",
      "evaluationDigest", "evaluatorBindingDigest", "validationLeaseId", "validationLeaseDigest",
      "targetDigest", "scopeDigest", "reasonCode", "reasonDigest", "revokedAt", "authority", "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.evaluationDigest || "")
    && DIGEST_RE.test(receipt.evaluatorBindingDigest || "")
    && ID_RE.test(receipt.validationLeaseId || "") && DIGEST_RE.test(receipt.validationLeaseDigest || "")
    && DIGEST_RE.test(receipt.targetDigest || "") && DIGEST_RE.test(receipt.scopeDigest || "")
    && VALIDATION_REVOCATION_REASONS.has(receipt.reasonCode)
    && DIGEST_RE.test(receipt.reasonDigest || "") && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function validationRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId
    && entry.digest === receipt.evaluationDigest);
  const binding = state.evaluationBindings.find((entry) => entry.evaluationId === receipt.evaluationId
    && entry.evaluationDigest === receipt.evaluationDigest);
  const lease = validationLeaseRecord(state, receipt.validationLeaseId, receipt.validationLeaseDigest);
  return Boolean(candidate && evaluation && binding && lease && storedValidationLeaseStructure(lease)
    && evaluation.learningId === candidate.id && lease.learningId === candidate.id
    && lease.evaluationId === evaluation.id && lease.evaluationDigest === evaluation.digest
    && lease.evaluatorRegistryBindingDigest === binding.digest
    && receipt.evaluatorBindingDigest === binding.digest
    && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && digest(lease.scope) === receipt.scopeDigest && exactScope(lease.scope, evaluation.scope));
}

export function revokedValidation(state, validationLeaseId) {
  return state.validationRevocations.find((receipt) => receipt.validationLeaseId === validationLeaseId) || null;
}

export function revokedValidationForCandidate(state, candidate) {
  const chain = validationLeaseChain(state, candidate);
  if (!chain.length) return null;
  return state.validationRevocations.find((receipt) => receipt.learningId === candidate.id
    && chain.some((lease) => lease.id === receipt.validationLeaseId
      && lease.digest === receipt.validationLeaseDigest)) || null;
}

export function validationLeaseState(state, candidate, timestamp) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (candidate?.status !== "accepted" || canary?.status !== "validated") {
    return { status: "not-applicable", lease: null, evaluation: null };
  }
  const evaluation = state.evaluations.find((entry) => entry.id === canary.evaluationId
    && entry.learningId === candidate.id && entry.digest === canary.evaluationDigest) || null;
  if (!evaluation) return { status: "missing-evaluation", lease: null, evaluation: null };
  if (revokedEvaluation(state, evaluation.id)) {
    return { status: "revoked-evaluation", lease: null, evaluation };
  }
  if (revokedEvidenceSourceAttestation(state, evaluation.id)) {
    return { status: "revoked-evidence-source-attestation", lease: null, evaluation };
  }
  if (!REGISTRY_BOUND_EVALUATIONS.has(evaluation.schema)) {
    return new Date(canary.expiresAt).getTime() < new Date(timestamp).getTime()
      ? { status: "expired", lease: null, evaluation }
      : { status: "legacy", lease: null, evaluation };
  }
  const lease = state.validationLeases.find((entry) => entry.id === canary.validationLeaseId
    && entry.digest === canary.validationLeaseDigest && entry.learningId === candidate.id
    && entry.evaluationId === evaluation.id && entry.evaluationDigest === evaluation.digest) || null;
  if (!lease) return { status: "missing", lease: null, evaluation };
  if (revokedValidationForCandidate(state, candidate)) {
    return { status: "revoked-validation", lease, evaluation };
  }
  const binding = activeEvaluationBinding(state, evaluation);
  if (!binding || binding.digest !== lease.evaluatorRegistryBindingDigest) {
    return { status: "revoked", lease, evaluation };
  }
  if (new Date(lease.expiresAt).getTime() <= new Date(timestamp).getTime()
    || lease.expiresAt !== canary.expiresAt) return { status: "expired", lease, evaluation };
  return { status: "active", lease, evaluation };
}

export function initialTrialTimeout(state, candidate, timestamp) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  const evaluation = state.evaluations.find((entry) => entry.id === canary?.evaluationId
    && entry.digest === canary?.evaluationDigest && entry.learningId === candidate?.id);
  if (!DEADLINE_BOUND_EVALUATIONS.has(evaluation?.schema)) return null;
  const applications = state.applications.filter((entry) => entry.schema === "agentspine.learning-application/v7"
    && entry.learningId === candidate.id && entry.initialAdmission.evaluationId === evaluation.id
    && entry.initialAdmission.evaluationDigest === evaluation.digest)
    .sort((a, b) => a.initialAdmission.slot - b.initialAdmission.slot);
  for (const application of applications) {
    const delivery = state.deliveries.find((entry) => entry.applicationId === application.id);
    if (!delivery && new Date(timestamp).getTime() > new Date(application.deliveryExpiresAt).getTime()) {
      return { evaluation, application, failure: "delivery-timeout", deadline: application.deliveryExpiresAt };
    }
    const outcome = state.outcomes.find((entry) => entry.applicationId === application.id
      && entry.evaluationId === evaluation.id && entry.phase === "after");
    if (delivery && !outcome && new Date(timestamp).getTime() > new Date(application.outcomeExpiresAt).getTime()) {
      return { evaluation, application, failure: "outcome-timeout", deadline: application.outcomeExpiresAt };
    }
  }
  return null;
}

export function canaryValidity(state, candidate, timestamp) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  const evidenceRevocation = revokedEvidence(state, candidate);
  if (candidate?.status === "accepted" && evidenceRevocation) {
    return { status: "revoked-evidence", canary, evaluation: null, lease: null, evidenceRevocation };
  }
  const evaluationRevocation = revokedEvaluationForCandidate(state, candidate);
  if (candidate?.status === "accepted" && evaluationRevocation) {
    return { status: "revoked-evaluation", canary, evaluation: null, lease: null, evaluationRevocation };
  }
  const evidenceSourceAttestationRevocation = revokedEvidenceSourceAttestationForCandidate(state, candidate);
  if (candidate?.status === "accepted" && evidenceSourceAttestationRevocation) {
    return { status: "revoked-evidence-source-attestation", canary, evaluation: null, lease: null,
      evidenceSourceAttestationRevocation };
  }
  const validationRevocation = revokedValidationForCandidate(state, candidate);
  if (candidate?.status === "accepted" && validationRevocation) {
    return { status: "revoked-validation", canary, evaluation: null, lease: null, validationRevocation };
  }
  const measurementRevocation = revokedMeasurementForCandidate(state, candidate);
  if (candidate?.status === "accepted" && measurementRevocation) {
    return { status: "revoked-measurement", canary, evaluation: null, lease: null, measurementRevocation };
  }
  const applicationRevocation = revokedApplicationForCandidate(state, candidate);
  if (candidate?.status === "accepted" && applicationRevocation) {
    return { status: "revoked-application", canary, evaluation: null, lease: null, applicationRevocation };
  }
  const deliveryRevocation = revokedDeliveryForCandidate(state, candidate);
  if (candidate?.status === "accepted" && deliveryRevocation) {
    return { status: "revoked-delivery", canary, evaluation: null, lease: null, deliveryRevocation };
  }
  const outcomeRevocation = revokedOutcomeForCandidate(state, candidate);
  if (candidate?.status === "accepted" && outcomeRevocation) {
    return { status: "revoked-outcome", canary, evaluation: null, lease: null, outcomeRevocation };
  }
  if (candidate?.status !== "accepted" || !["active", "validated"].includes(canary?.status)) {
    return { status: "not-applicable", canary, evaluation: null, lease: null };
  }
  if (new Date(canary.expiresAt).getTime() <= new Date(timestamp).getTime()) {
    return { status: canary.status === "validated" ? "stale-validated" : "stale-active",
      canary, evaluation: null, lease: null };
  }
  const evaluation = state.evaluations.find((entry) => entry.id === canary.evaluationId
    && entry.learningId === candidate.id && entry.digest === canary.evaluationDigest) || null;
  if (!evaluation || new Date(evaluation.expiresAt).getTime() <= new Date(timestamp).getTime()) {
    return { status: canary.status === "validated" ? "stale-validated" : "stale-active",
      canary, evaluation, lease: null };
  }
  if (REGISTRY_BOUND_EVALUATIONS.has(evaluation.schema)
    && !activeEvaluationBinding(state, evaluation)) {
    return { status: canary.status === "validated" ? "revoked-validated" : "revoked-active",
      canary, evaluation, lease: null };
  }
  const failedTrial = initialTrialTimeout(state, candidate, timestamp);
  if (failedTrial) return { status: "failed-initial-trial", canary, evaluation, lease: null, failedTrial };
  if (canary.status === "validated"
    && REGISTRY_BOUND_EVALUATIONS.has(evaluation.schema)) {
    const validation = validationLeaseState(state, candidate, timestamp);
    if (validation.status !== "active") return { ...validation, status: validation.status === "missing"
      ? "unproven-validated" : `${validation.status}-validated`, canary };
    return { status: "current-validated", canary, evaluation, lease: validation.lease };
  }
  return { status: canary.status === "validated" ? "legacy-validated" : "current-active",
    canary, evaluation, lease: null };
}
