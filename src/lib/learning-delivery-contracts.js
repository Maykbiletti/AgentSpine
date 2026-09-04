import {
  SCOPE_FIELDS, ID_RE, DIGEST_RE, INITIAL_TRIAL_APPLICATIONS, DELIVERY_REVOCATION_REASONS, OUTCOME_REVOCATION_REASONS,
  APPLICATION_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  digest, learningTargetForCandidate
} from "./learning-scope-targets.js";

export function deliveryPayload({ id, applicationId, learningId, scope, sessionId, preflightReceiptId,
  hookEvent, completedAt }) {
  return {
    schema: "agentspine.learning-delivery/v1", id, applicationId, learningId, scope,
    sessionId, preflightReceiptId, hookEvent, completedAt, authority: "context-only"
  };
}

export function storedDeliveryStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = deliveryPayload(receipt);
  return receipt.schema === "agentspine.learning-delivery/v1" && ID_RE.test(receipt.id || "")
    && ID_RE.test(receipt.applicationId || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.sessionId || "") && ID_RE.test(receipt.preflightReceiptId || "")
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && ["Stop", "SubagentStop"].includes(receipt.hookEvent)
    && Number.isFinite(new Date(receipt.completedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function applicationRevocationPayload({ id, learningId, evaluationId, evaluationDigest, applicationId,
  applicationDigest, deliveryId, deliveryDigest, outcomeId, outcomeDigest, targetDigest, reasonCode,
  reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-application-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    applicationId,
    applicationDigest,
    deliveryId,
    deliveryDigest,
    outcomeId,
    outcomeDigest,
    targetDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedApplicationRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = applicationRevocationPayload(receipt);
  const nullablePair = (id, entryDigest) => (id === null && entryDigest === null)
    || (ID_RE.test(id || "") && DIGEST_RE.test(entryDigest || ""));
  return receipt.schema === "agentspine.learning-application-revocation/v1"
    && Object.keys(receipt).length === 17
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId", "evaluationDigest",
      "applicationId", "applicationDigest", "deliveryId", "deliveryDigest", "outcomeId", "outcomeDigest",
      "targetDigest", "reasonCode", "reasonDigest", "revokedAt", "authority", "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.evaluationDigest || "")
    && ID_RE.test(receipt.applicationId || "") && DIGEST_RE.test(receipt.applicationDigest || "")
    && nullablePair(receipt.deliveryId, receipt.deliveryDigest)
    && nullablePair(receipt.outcomeId, receipt.outcomeDigest)
    && DIGEST_RE.test(receipt.targetDigest || "") && APPLICATION_REVOCATION_REASONS.has(receipt.reasonCode)
    && DIGEST_RE.test(receipt.reasonDigest || "") && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function applicationRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId);
  const application = state.applications.find((entry) => entry.id === receipt.applicationId);
  const delivery = receipt.deliveryId === null ? null
    : state.deliveries.find((entry) => entry.id === receipt.deliveryId);
  const outcome = receipt.outcomeId === null ? null
    : state.outcomes.find((entry) => entry.id === receipt.outcomeId);
  return Boolean(candidate && evaluation && application
    && evaluation.learningId === candidate.id && evaluation.digest === receipt.evaluationDigest
    && application.learningId === candidate.id && application.digest === receipt.applicationDigest
    && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && (receipt.deliveryId === null
      ? !state.deliveries.some((entry) => entry.applicationId === application.id)
      : delivery?.digest === receipt.deliveryDigest && delivery.learningId === candidate.id
        && delivery.applicationId === application.id)
    && (receipt.outcomeId === null
      ? !state.outcomes.some((entry) => entry.applicationId === application.id)
      : outcome?.digest === receipt.outcomeDigest && outcome.learningId === candidate.id
        && outcome.evaluationId === evaluation.id && outcome.applicationId === application.id
        && outcome.deliveryId === delivery?.id));
}

export function revokedApplication(state, applicationId) {
  return state.applicationRevocations.find((receipt) => receipt.applicationId === applicationId) || null;
}

export function revokedApplicationForCandidate(state, candidate) {
  const revocations = state.applicationRevocations.filter((receipt) => receipt.learningId === candidate?.id);
  if (!revocations.length) return null;
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (!canary?.evaluationId) return revocations[0];
  const referencedOutcomes = referencedValidationOutcomeIds(state, candidate);
  const referencedApplications = new Set(state.outcomes.filter((entry) => referencedOutcomes.has(entry.id))
    .map((entry) => entry.applicationId).filter(Boolean));
  return revocations.find((receipt) => receipt.evaluationId === canary.evaluationId
    && (referencedApplications.has(receipt.applicationId)
      || (canary.status === "active" && state.applications.some((application) =>
        application.id === receipt.applicationId && INITIAL_TRIAL_APPLICATIONS.has(application.schema)
        && application.initialAdmission.evaluationId === canary.evaluationId
        && application.initialAdmission.evaluationDigest === canary.evaluationDigest))
      || (canary.status === "validated" && canary.revalidation?.status === "active"
        && state.applications.some((application) => application.id === receipt.applicationId
          && ["agentspine.learning-application/v3", "agentspine.learning-application/v4"].includes(application.schema)
          && application.revalidationAdmission.revalidationWindowId === canary.revalidation.id
          && application.revalidationAdmission.revalidationWindowDigest === canary.revalidation.digest)))) || null;
}

export function deliveryRevocationPayload({ id, learningId, evaluationId, evaluationDigest, applicationId,
  applicationDigest, deliveryId, deliveryDigest, outcomeId, outcomeDigest, targetDigest, reasonCode,
  reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-delivery-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    applicationId,
    applicationDigest,
    deliveryId,
    deliveryDigest,
    outcomeId,
    outcomeDigest,
    targetDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedDeliveryRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = deliveryRevocationPayload(receipt);
  return receipt.schema === "agentspine.learning-delivery-revocation/v1"
    && Object.keys(receipt).length === 17
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId", "evaluationDigest",
      "applicationId", "applicationDigest", "deliveryId", "deliveryDigest", "outcomeId", "outcomeDigest",
      "targetDigest", "reasonCode", "reasonDigest", "revokedAt", "authority", "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.evaluationDigest || "")
    && ID_RE.test(receipt.applicationId || "") && DIGEST_RE.test(receipt.applicationDigest || "")
    && ID_RE.test(receipt.deliveryId || "") && DIGEST_RE.test(receipt.deliveryDigest || "")
    && ((receipt.outcomeId === null && receipt.outcomeDigest === null)
      || (ID_RE.test(receipt.outcomeId || "") && DIGEST_RE.test(receipt.outcomeDigest || "")))
    && DIGEST_RE.test(receipt.targetDigest || "") && DELIVERY_REVOCATION_REASONS.has(receipt.reasonCode)
    && DIGEST_RE.test(receipt.reasonDigest || "") && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function deliveryRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId);
  const application = state.applications.find((entry) => entry.id === receipt.applicationId);
  const delivery = state.deliveries.find((entry) => entry.id === receipt.deliveryId);
  const outcome = receipt.outcomeId === null ? null : state.outcomes.find((entry) => entry.id === receipt.outcomeId);
  return Boolean(candidate && evaluation && application && delivery
    && evaluation.learningId === candidate.id && evaluation.digest === receipt.evaluationDigest
    && application.learningId === candidate.id && application.digest === receipt.applicationDigest
    && delivery.learningId === candidate.id && delivery.applicationId === application.id
    && delivery.digest === receipt.deliveryDigest && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && (receipt.outcomeId === null
      ? !state.outcomes.some((entry) => entry.deliveryId === delivery.id)
      : outcome?.digest === receipt.outcomeDigest && outcome.learningId === candidate.id
        && outcome.evaluationId === evaluation.id && outcome.applicationId === application.id
        && outcome.deliveryId === delivery.id));
}

export function revokedDelivery(state, deliveryId) {
  return state.deliveryRevocations.find((receipt) => receipt.deliveryId === deliveryId) || null;
}

export function revokedDeliveryForCandidate(state, candidate) {
  const revocations = state.deliveryRevocations.filter((receipt) => receipt.learningId === candidate?.id);
  if (!revocations.length) return null;
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (!canary?.evaluationId) return null;
  const lease = state.validationLeases.find((entry) => entry.learningId === candidate.id
    && entry.id === canary.validationLeaseId);
  const referencedDeliveries = new Set((lease?.renewalEvidence || []).map((entry) => entry.deliveryId));
  const referencedOutcomes = new Set([
    ...(canary.afterReceipts || []),
    ...(lease?.afterOutcomes || []).map((entry) => entry.id)
  ]);
  return revocations.find((receipt) => receipt.evaluationId === canary.evaluationId
    && (referencedDeliveries.has(receipt.deliveryId)
      || (receipt.outcomeId !== null && referencedOutcomes.has(receipt.outcomeId))
      || (canary.status === "active" && state.applications.some((application) =>
        application.id === receipt.applicationId && INITIAL_TRIAL_APPLICATIONS.has(application.schema)
        && application.initialAdmission.evaluationId === canary.evaluationId
        && application.initialAdmission.evaluationDigest === canary.evaluationDigest)))) || null;
}

export function outcomeRevocationPayload({ id, learningId, evaluationId, evaluationDigest, outcomeId, outcomeDigest,
  measurementId, measurementDigest, applicationId, applicationDigest, deliveryId, deliveryDigest,
  targetDigest, reasonCode, reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-outcome-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    outcomeId,
    outcomeDigest,
    measurementId,
    measurementDigest,
    applicationId,
    applicationDigest,
    deliveryId,
    deliveryDigest,
    targetDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedOutcomeRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = outcomeRevocationPayload(receipt);
  const nullablePair = (id, entryDigest) => (id === null && entryDigest === null)
    || (ID_RE.test(id || "") && DIGEST_RE.test(entryDigest || ""));
  return receipt.schema === "agentspine.learning-outcome-revocation/v1"
    && Object.keys(receipt).length === 19
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId", "evaluationDigest",
      "outcomeId", "outcomeDigest", "measurementId", "measurementDigest", "applicationId", "applicationDigest",
      "deliveryId", "deliveryDigest", "targetDigest", "reasonCode", "reasonDigest", "revokedAt", "authority",
      "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.evaluationDigest || "")
    && ID_RE.test(receipt.outcomeId || "") && DIGEST_RE.test(receipt.outcomeDigest || "")
    && nullablePair(receipt.measurementId, receipt.measurementDigest)
    && nullablePair(receipt.applicationId, receipt.applicationDigest)
    && nullablePair(receipt.deliveryId, receipt.deliveryDigest)
    && DIGEST_RE.test(receipt.targetDigest || "") && OUTCOME_REVOCATION_REASONS.has(receipt.reasonCode)
    && DIGEST_RE.test(receipt.reasonDigest || "") && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function outcomeRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId);
  const outcome = state.outcomes.find((entry) => entry.id === receipt.outcomeId);
  const measurement = receipt.measurementId === null ? null
    : state.measurements.find((entry) => entry.id === receipt.measurementId);
  const application = receipt.applicationId === null ? null
    : state.applications.find((entry) => entry.id === receipt.applicationId);
  const delivery = receipt.deliveryId === null ? null
    : state.deliveries.find((entry) => entry.id === receipt.deliveryId);
  return Boolean(candidate && evaluation && outcome
    && evaluation.learningId === candidate.id && evaluation.digest === receipt.evaluationDigest
    && outcome.learningId === candidate.id && outcome.evaluationId === evaluation.id
    && outcome.digest === receipt.outcomeDigest && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && (receipt.measurementId === null
      ? !outcome.measurementReceiptId
      : outcome.measurementReceiptId === measurement?.id && outcome.measurementReceiptDigest === measurement?.digest
        && measurement.digest === receipt.measurementDigest && measurement.learningId === candidate.id
        && measurement.evaluationId === evaluation.id)
    && (receipt.applicationId === null
      ? outcome.applicationId === null
      : outcome.applicationId === application?.id && application.digest === receipt.applicationDigest
        && application.learningId === candidate.id)
    && (receipt.deliveryId === null
      ? outcome.deliveryId === null
      : outcome.deliveryId === delivery?.id && delivery.digest === receipt.deliveryDigest
        && delivery.learningId === candidate.id && delivery.applicationId === application?.id));
}

export function revokedOutcome(state, outcomeId) {
  return state.outcomeRevocations.find((receipt) => receipt.outcomeId === outcomeId) || null;
}

export function referencedValidationOutcomeIds(state, candidate) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  const ids = new Set([...(canary?.beforeReceipts || []), ...(canary?.afterReceipts || [])]);
  let lease = state.validationLeases.find((entry) => entry.learningId === candidate?.id
    && entry.id === canary?.validationLeaseId);
  const visited = new Set();
  while (lease && !visited.has(lease.digest)) {
    visited.add(lease.digest);
    for (const reference of [...(lease.beforeOutcomes || []), ...(lease.afterOutcomes || []),
      ...(lease.baselineOutcomes || [])]) ids.add(reference.id);
    const predecessor = lease.predecessorValidation;
    lease = predecessor ? state.history.find((entry) => entry.kind === "learning-validation"
      && entry.value?.id === predecessor.id && entry.value?.digest === predecessor.digest)?.value : null;
  }
  return ids;
}

export function revokedOutcomeForCandidate(state, candidate) {
  const revocations = state.outcomeRevocations.filter((receipt) => receipt.learningId === candidate?.id);
  if (!revocations.length) return null;
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (!canary?.evaluationId) return revocations[0];
  const referenced = referencedValidationOutcomeIds(state, candidate);
  return revocations.find((receipt) => receipt.evaluationId === canary.evaluationId
    && (referenced.has(receipt.outcomeId) || canary.status === "active")) || null;
}
