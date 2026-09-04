import { createHash, randomUUID } from "node:crypto";
import {
  OUTCOME_PHASES, MEASUREMENT_KINDS, METRIC_DIRECTIONS, SCOPE_FIELDS, ID_RE, DIGEST_RE,
  EVIDENCE_REVOCATION_REASONS, MEASUREMENT_REVOCATION_REASONS, EVALUATION_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  outcomePayload
} from "./learning-outcome-contracts.js";

export function validConfig(config) {
  return typeof config?.autoPromote === "boolean"
    && Number.isFinite(config.minConfidence) && config.minConfidence >= 0.5 && config.minConfidence <= 1
    && Number.isInteger(config.minEvidence) && config.minEvidence >= 1 && config.minEvidence <= 10
    && Number.isInteger(config.maxContextItems) && config.maxContextItems >= 1 && config.maxContextItems <= 50
    && Number.isInteger(config.minOutcomeReceipts) && config.minOutcomeReceipts >= 2 && config.minOutcomeReceipts <= 10
    && Number.isFinite(config.minImprovement) && config.minImprovement >= 0 && config.minImprovement <= 1
    && Number.isFinite(config.regressionTolerance) && config.regressionTolerance >= 0 && config.regressionTolerance <= 1
    && Number.isInteger(config.outcomeMaxAgeDays) && config.outcomeMaxAgeDays >= 1 && config.outcomeMaxAgeDays <= 365
    && Number.isInteger(config.canaryReceipts) && config.canaryReceipts >= 1 && config.canaryReceipts <= 10
    && Number.isInteger(config.canaryTtlDays) && config.canaryTtlDays >= 1 && config.canaryTtlDays <= 90
    && Number.isInteger(config.initialTrialOutcomeTimeoutMinutes)
    && config.initialTrialOutcomeTimeoutMinutes >= 5 && config.initialTrialOutcomeTimeoutMinutes <= 10080;
}

export function normalizeStoredScope(scope, subjectId = null, groupId = null) {
  const source = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
  const normalized = {};
  for (const field of SCOPE_FIELDS) normalized[field] = source[field] ?? null;
  if (normalized.groupId === null && groupId) normalized.groupId = groupId;
  return normalized;
}

export function normalizeScope(scope, subjectId = null, groupId = null) {
  const normalized = normalizeStoredScope(scope, subjectId, groupId);
  for (const [field, value] of Object.entries(normalized)) {
    if (value !== null && !ID_RE.test(value)) throw new Error(`scope.${field} must be a stable, whitespace-free identifier`);
  }
  return normalized;
}

export function scopeKey(scope) {
  return JSON.stringify(SCOPE_FIELDS.map((field) => scope?.[field] ?? null));
}

export function scopeContains(candidateScope, runtimeScope) {
  return SCOPE_FIELDS.every((field) => candidateScope?.[field] === null || candidateScope?.[field] === runtimeScope?.[field]);
}

export function exactScope(left, right) {
  return scopeKey(left) === scopeKey(right);
}

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function learningTargetRevisionPayload(candidate) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    claim: candidate.claim,
    subjectId: candidate.subjectId,
    privacy: candidate.privacy,
    groupId: candidate.groupId,
    scope: candidate.scope,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    supersedesId: candidate.supersedesId,
    requiresLocalReview: candidate.requiresLocalReview,
    authority: "context-only"
  };
}

export function learningTargetPayload({ learningId, revisionDigest, claimDigest, evidenceDigest, scopeDigest }) {
  return {
    schema: "agentspine.learning-target/v1",
    learningId,
    revisionDigest,
    claimDigest,
    evidenceDigest,
    scopeDigest,
    authority: "context-only"
  };
}

export function learningTargetForCandidate(candidate) {
  const payload = learningTargetPayload({
    learningId: candidate.id,
    revisionDigest: digest(learningTargetRevisionPayload(candidate)),
    claimDigest: digest(candidate.claim),
    evidenceDigest: digest(candidate.evidence),
    scopeDigest: digest(candidate.scope)
  });
  return { ...payload, digest: digest(payload) };
}

export function storedLearningTargetStructure(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  const payload = learningTargetPayload(target);
  return target.schema === "agentspine.learning-target/v1" && ID_RE.test(target.learningId || "")
    && Object.keys(target).length === 8
    && Object.keys(target).every((field) => ["schema", "learningId", "revisionDigest", "claimDigest",
      "evidenceDigest", "scopeDigest", "authority", "digest"].includes(field))
    && [target.revisionDigest, target.claimDigest, target.evidenceDigest, target.scopeDigest]
      .every((value) => DIGEST_RE.test(value || ""))
    && target.authority === "context-only" && target.digest === digest(payload);
}

export function learningTargetMatchesCandidate(target, candidate) {
  return Boolean(candidate) && storedLearningTargetStructure(target)
    && target.digest === learningTargetForCandidate(candidate).digest;
}

export function evidenceRevocationPayload({ id, learningId, evidenceId, evidenceDigest, targetDigest, reasonCode,
  reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-evidence-revocation/v1",
    id,
    learningId,
    evidenceId,
    evidenceDigest,
    targetDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedEvidenceRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = evidenceRevocationPayload(receipt);
  return receipt.schema === "agentspine.learning-evidence-revocation/v1"
    && Object.keys(receipt).length === 11
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evidenceId", "evidenceDigest",
      "targetDigest", "reasonCode", "reasonDigest", "revokedAt", "authority", "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "") && ID_RE.test(receipt.evidenceId || "")
    && DIGEST_RE.test(receipt.evidenceDigest || "") && DIGEST_RE.test(receipt.targetDigest || "")
    && EVIDENCE_REVOCATION_REASONS.has(receipt.reasonCode) && DIGEST_RE.test(receipt.reasonDigest || "")
    && Number.isFinite(new Date(receipt.revokedAt).getTime()) && receipt.authority === "context-only"
    && receipt.digest === digest(payload);
}

export function evidenceRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evidence = candidate?.evidence.find((entry) => entry.id === receipt.evidenceId);
  return Boolean(candidate && evidence && digest(evidence) === receipt.evidenceDigest
    && learningTargetForCandidate(candidate).digest === receipt.targetDigest);
}

export function revokedEvidence(state, candidate) {
  return state.evidenceRevocations.find((receipt) => receipt.learningId === candidate?.id) || null;
}

export function storedOutcomeStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = outcomePayload(receipt);
  const legacy = receipt.schema === "agentspine.learning-outcome/v1";
  const bound = receipt.schema === "agentspine.learning-outcome/v2";
  const planned = receipt.schema === "agentspine.learning-outcome/v3";
  const delivered = receipt.schema === "agentspine.learning-outcome/v4";
  const covered = receipt.schema === "agentspine.learning-outcome/v5";
  const provenanceBound = receipt.schema === "agentspine.learning-outcome/v6";
  const lineageBound = receipt.schema === "agentspine.learning-outcome/v7";
  const paired = receipt.schema === "agentspine.learning-outcome/v8";
  const rootBound = receipt.schema === "agentspine.learning-outcome/v9";
  return (legacy || bound || planned || delivered || covered || provenanceBound || lineageBound || paired || rootBound) && ID_RE.test(receipt.id || "")
    && ID_RE.test(receipt.learningId || "") && OUTCOME_PHASES.has(receipt.phase)
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && typeof receipt.metric?.name === "string" && receipt.metric.name.length > 0
    && METRIC_DIRECTIONS.has(receipt.metric?.direction)
    && Number.isFinite(receipt.metric?.value) && receipt.metric.value >= 0 && receipt.metric.value <= 1
    && Number.isInteger(receipt.metric?.blockingDefects) && receipt.metric.blockingDefects >= 0
    && MEASUREMENT_KINDS.has(receipt.measurement?.kind) && ID_RE.test(receipt.measurement?.evaluatorId || "")
    && (receipt.measurement?.sourceDigest === null || DIGEST_RE.test(receipt.measurement?.sourceDigest || ""))
    && (legacy ? receipt.applicationId === undefined : (receipt.phase === "before"
      ? receipt.applicationId === null : ID_RE.test(receipt.applicationId || "")))
    && (!(planned || delivered || covered || provenanceBound || lineageBound || paired || rootBound) || ID_RE.test(receipt.evaluationId || ""))
    && (!(delivered || covered || provenanceBound || lineageBound || paired || rootBound) || (receipt.phase === "before" ? receipt.deliveryId === null : ID_RE.test(receipt.deliveryId || "")))
    && (!(covered || provenanceBound || lineageBound || paired || rootBound) || (DIGEST_RE.test(receipt.coverage?.datasetDigest || "")
      && Number.isInteger(receipt.coverage?.caseCount) && receipt.coverage.caseCount >= 1
      && receipt.coverage.caseCount <= 1000000 && receipt.coverage?.authority === "context-only"))
    && (!(provenanceBound || lineageBound || paired || rootBound) || DIGEST_RE.test(receipt.measurement?.sourceDigest || ""))
    && (!(lineageBound || paired || rootBound) || (ID_RE.test(receipt.measurementReceiptId || "") && DIGEST_RE.test(receipt.measurementReceiptDigest || "")
      && ID_RE.test(receipt.measurement?.runId || "")))
    && (!rootBound || DIGEST_RE.test(receipt.measurement?.evaluatorRootDigest || ""))
    && receipt.authority === "context-only" && receipt.measurement?.authority === "context-only"
    && Number.isFinite(new Date(receipt.measuredAt).getTime()) && receipt.digest === digest(payload);
}

export function measurementPayload({ id, learningId, evaluationId, phase, scope, metric, measurement, coverage, measuredAt,
  schema = "agentspine.learning-measurement/v1" }) {
  return {
    schema, id, learningId, evaluationId, phase, scope,
    metric, measurement, coverage, measuredAt, authority: "context-only"
  };
}

export function storedMeasurementStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = measurementPayload(receipt);
  return ["agentspine.learning-measurement/v1", "agentspine.learning-measurement/v2"].includes(receipt.schema)
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "") && ID_RE.test(receipt.evaluationId || "")
    && OUTCOME_PHASES.has(receipt.phase)
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && typeof receipt.metric?.name === "string" && receipt.metric.name.length > 0
    && METRIC_DIRECTIONS.has(receipt.metric?.direction)
    && Number.isFinite(receipt.metric?.value) && receipt.metric.value >= 0 && receipt.metric.value <= 1
    && Number.isInteger(receipt.metric?.blockingDefects) && receipt.metric.blockingDefects >= 0
    && MEASUREMENT_KINDS.has(receipt.measurement?.kind) && ID_RE.test(receipt.measurement?.evaluatorId || "")
    && ID_RE.test(receipt.measurement?.runId || "") && DIGEST_RE.test(receipt.measurement?.sourceDigest || "")
    && (receipt.schema !== "agentspine.learning-measurement/v2"
      || DIGEST_RE.test(receipt.measurement?.evaluatorRootDigest || ""))
    && receipt.measurement?.authority === "context-only"
    && DIGEST_RE.test(receipt.coverage?.datasetDigest || "")
    && Number.isInteger(receipt.coverage?.caseCount) && receipt.coverage.caseCount >= 1
    && receipt.coverage.caseCount <= 1000000 && receipt.coverage?.authority === "context-only"
    && Number.isFinite(new Date(receipt.measuredAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function measurementRevocationPayload({ id, learningId, evaluationId, evaluationDigest, measurementId,
  measurementDigest, outcomeId, outcomeDigest, targetDigest, reasonCode, reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-measurement-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    measurementId,
    measurementDigest,
    outcomeId,
    outcomeDigest,
    targetDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedMeasurementRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = measurementRevocationPayload(receipt);
  return receipt.schema === "agentspine.learning-measurement-revocation/v1"
    && Object.keys(receipt).length === 15
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId", "evaluationDigest",
      "measurementId", "measurementDigest", "outcomeId", "outcomeDigest", "targetDigest", "reasonCode",
      "reasonDigest", "revokedAt", "authority", "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.evaluationDigest || "")
    && ID_RE.test(receipt.measurementId || "") && DIGEST_RE.test(receipt.measurementDigest || "")
    && ((receipt.outcomeId === null && receipt.outcomeDigest === null)
      || (ID_RE.test(receipt.outcomeId || "") && DIGEST_RE.test(receipt.outcomeDigest || "")))
    && DIGEST_RE.test(receipt.targetDigest || "") && MEASUREMENT_REVOCATION_REASONS.has(receipt.reasonCode)
    && DIGEST_RE.test(receipt.reasonDigest || "") && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function measurementRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId);
  const measurement = state.measurements.find((entry) => entry.id === receipt.measurementId);
  const outcome = receipt.outcomeId === null ? null : state.outcomes.find((entry) => entry.id === receipt.outcomeId);
  return Boolean(candidate && evaluation && measurement
    && evaluation.digest === receipt.evaluationDigest && evaluation.learningId === candidate.id
    && measurement.digest === receipt.measurementDigest && measurement.learningId === candidate.id
    && measurement.evaluationId === evaluation.id && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && (receipt.outcomeId === null
      ? !state.outcomes.some((entry) => entry.measurementReceiptId === measurement.id)
      : outcome?.digest === receipt.outcomeDigest && outcome.learningId === candidate.id
        && outcome.evaluationId === evaluation.id && outcome.measurementReceiptId === measurement.id));
}

export function revokedMeasurement(state, measurementId) {
  return state.measurementRevocations.find((receipt) => receipt.measurementId === measurementId) || null;
}

export function revokedMeasurementForCandidate(state, candidate) {
  const revocations = state.measurementRevocations.filter((receipt) => receipt.learningId === candidate?.id);
  if (!revocations.length) return null;
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (!canary?.evaluationId) return revocations[0];
  const lease = state.validationLeases.find((entry) => entry.learningId === candidate.id
    && entry.id === canary.validationLeaseId);
  const referencedMeasurements = new Set((lease?.renewalEvidence || []).map((entry) => entry.measurementId));
  const referencedOutcomes = new Set([
    ...(canary.beforeReceipts || []),
    ...(canary.afterReceipts || []),
    ...(lease?.beforeOutcomes || []).map((entry) => entry.id),
    ...(lease?.afterOutcomes || []).map((entry) => entry.id),
    ...(lease?.baselineOutcomes || []).map((entry) => entry.id)
  ]);
  return revocations.find((receipt) => receipt.learningId === candidate.id
    && receipt.evaluationId === canary.evaluationId
    && (referencedMeasurements.has(receipt.measurementId)
      || (receipt.outcomeId !== null && (referencedOutcomes.has(receipt.outcomeId)
        || canary.status === "active")))) || null;
}

export function measurementRunDigest(evaluatorId, runId) {
  return digest([evaluatorId, runId]);
}

export function evaluatorRootRunDigest(evaluatorRootDigest, runId) {
  return digest([evaluatorRootDigest, runId]);
}

export function evaluatorRecordPayload({ id, principalDigest, status, registeredAt, revokedAt, reason }) {
  return {
    schema: "agentspine.learning-evaluator/v1",
    id,
    principalDigest,
    status,
    registeredAt,
    revokedAt,
    reason,
    confirmation: "local-owner",
    authority: "context-only"
  };
}

export function storedEvaluatorRecordStructure(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const payload = evaluatorRecordPayload(record);
  return record.schema === "agentspine.learning-evaluator/v1" && ID_RE.test(record.id || "")
    && DIGEST_RE.test(record.principalDigest || "") && ["active", "revoked"].includes(record.status)
    && Number.isFinite(new Date(record.registeredAt).getTime())
    && (record.status === "active"
      ? record.revokedAt === null && record.reason === null
      : Number.isFinite(new Date(record.revokedAt).getTime()) && typeof record.reason === "string" && record.reason.length > 0)
    && record.confirmation === "local-owner" && record.authority === "context-only"
    && record.digest === digest(payload);
}

export function evaluationBindingPayload({ evaluationId, evaluationDigest, evaluators, boundAt }) {
  return {
    schema: "agentspine.learning-evaluator-binding/v1",
    evaluationId,
    evaluationDigest,
    evaluators,
    boundAt,
    authority: "context-only"
  };
}

export function storedEvaluationBindingStructure(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const payload = evaluationBindingPayload(binding);
  return binding.schema === "agentspine.learning-evaluator-binding/v1"
    && ID_RE.test(binding.evaluationId || "") && DIGEST_RE.test(binding.evaluationDigest || "")
    && Array.isArray(binding.evaluators) && binding.evaluators.length >= 2
    && binding.evaluators.every((entry) => ID_RE.test(entry?.evaluatorId || "")
      && DIGEST_RE.test(entry?.principalDigest || "") && DIGEST_RE.test(entry?.registryDigest || "")
      && entry?.authority === "context-only")
    && new Set(binding.evaluators.map((entry) => entry.evaluatorId)).size === binding.evaluators.length
    && new Set(binding.evaluators.map((entry) => entry.principalDigest)).size === binding.evaluators.length
    && Number.isFinite(new Date(binding.boundAt).getTime()) && binding.authority === "context-only"
    && binding.digest === digest(payload);
}

export function activeEvaluatorRecord(state, evaluatorId, principalDigest = null) {
  return state.evaluatorRegistry.find((record) => record.id === evaluatorId && record.status === "active"
    && (principalDigest === null || record.principalDigest === principalDigest)) || null;
}

export function activeEvaluationBinding(state, contract) {
  const binding = state.evaluationBindings.find((entry) => entry.evaluationId === contract?.id
    && entry.evaluationDigest === contract?.digest);
  if (!binding) return null;
  return binding.evaluators.every((entry) => {
    const record = activeEvaluatorRecord(state, entry.evaluatorId, entry.principalDigest);
    return record?.digest === entry.registryDigest;
  }) ? binding : null;
}

export function evaluationRevocationPayload({ id, learningId, evaluationId, evaluationDigest,
  evaluatorBindingDigest, targetDigest, reasonCode, reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-evaluation-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    evaluatorBindingDigest,
    targetDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedEvaluationRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = evaluationRevocationPayload(receipt);
  return receipt.schema === "agentspine.learning-evaluation-revocation/v1"
    && Object.keys(receipt).length === 12
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId",
      "evaluationDigest", "evaluatorBindingDigest", "targetDigest", "reasonCode", "reasonDigest",
      "revokedAt", "authority", "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.evaluationDigest || "")
    && (receipt.evaluatorBindingDigest === null || DIGEST_RE.test(receipt.evaluatorBindingDigest || ""))
    && DIGEST_RE.test(receipt.targetDigest || "")
    && EVALUATION_REVOCATION_REASONS.has(receipt.reasonCode)
    && DIGEST_RE.test(receipt.reasonDigest || "") && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function evaluationRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId);
  const binding = state.evaluationBindings.find((entry) => entry.evaluationId === receipt.evaluationId
    && entry.evaluationDigest === receipt.evaluationDigest) || null;
  return Boolean(candidate && evaluation && evaluation.learningId === candidate.id
    && evaluation.digest === receipt.evaluationDigest
    && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && (binding?.digest || null) === receipt.evaluatorBindingDigest);
}

export function revokedEvaluation(state, evaluationId) {
  return state.evaluationRevocations.find((receipt) => receipt.evaluationId === evaluationId) || null;
}
