import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, isTransientLockMetadataError } from "./filesystem-retry.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";

const KINDS = new Set(["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference", "behavior"]);
const EVIDENCE_TYPES = new Set(["user-statement", "document", "interaction", "test"]);
const PRIVACY = new Set(["private", "shared", "group"]);
const STATUSES = new Set(["candidate", "accepted", "rejected", "superseded", "rolled-back"]);
const AUTO_KINDS = new Set(["project-fact", "reference"]);
const OUTCOME_AUTO_KINDS = new Set(["behavior"]);
const CONTINUITY_AUTO_KINDS = new Set(["preference", "no-go", "correction", "project-fact", "reference"]);
const OUTCOME_PHASES = new Set(["before", "after"]);
const MEASUREMENT_KINDS = new Set(["objective", "user-feedback", "model-suggestion"]);
const METRIC_DIRECTIONS = new Set(["higher", "lower"]);
const SCOPE_FIELDS = ["personaId", "userId", "tenantId", "projectId", "groupId", "taskId"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const AUTHORITY_ASSERTION_RE = /\b(?:user|agent|person|they|he|she|i|ich|wir|nutzer|benutzer).{0,60}\b(?:may|can|is allowed|is authorized|has|have|darf|berechtigt|hat|haben).{0,50}\b(?:admin(?:istrator)?|permissions?|rights?|authorization|production access|deploy|billing|spending|policy exception|bypass|zugang|rechte|berechtigung|produktion|abrechnung|ausnahme|umgehen)\b/i;
const PROTECTED_LESSON_RE = /\b(?:security|safety|identity|authentication|authorization|permissions?|credentials?|secrets?|policy|production|deployment|payments?|billing|tool access|file access|network access|database access|sicherheit|identität|authentifizierung|berechtigungen?|zugang|richtlinie|produktion|zahlungen?)\b/i;

function defaults() {
  return {
    autoPromote: false,
    minConfidence: 0.85,
    minEvidence: 2,
    maxContextItems: 12,
    minOutcomeReceipts: 2,
    minImprovement: 0.05,
    regressionTolerance: 0,
    outcomeMaxAgeDays: 30,
    canaryReceipts: 2,
    canaryTtlDays: 14
  };
}

function emptyLearning(root) {
  return {
    schema: "agentspine.learning/v1",
    root,
    config: defaults(),
    candidates: [],
    outcomes: [],
    measurements: [],
    measurementLineage: [],
    applications: [],
    deliveries: [],
    evaluations: [],
    evaluatorRegistry: [],
    evaluationBindings: [],
    validationLeases: [],
    history: []
  };
}

function normalizeState(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "agentspine.learning/v1" || value.root !== root
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)
    || !Array.isArray(value.candidates) || !value.candidates.every((item) => item && typeof item === "object" && Array.isArray(item.evidence))
    || (value.outcomes !== undefined && (!Array.isArray(value.outcomes) || !value.outcomes.every((item) => item && typeof item === "object")))
    || (value.measurements !== undefined && (!Array.isArray(value.measurements) || !value.measurements.every((item) => item && typeof item === "object")))
    || (value.measurementLineage !== undefined && (!Array.isArray(value.measurementLineage) || !value.measurementLineage.every((item) => item && typeof item === "object")))
    || (value.applications !== undefined && (!Array.isArray(value.applications) || !value.applications.every((item) => item && typeof item === "object")))
    || (value.deliveries !== undefined && (!Array.isArray(value.deliveries) || !value.deliveries.every((item) => item && typeof item === "object")))
    || (value.evaluations !== undefined && (!Array.isArray(value.evaluations) || !value.evaluations.every((item) => item && typeof item === "object")))
    || (value.evaluatorRegistry !== undefined && (!Array.isArray(value.evaluatorRegistry) || !value.evaluatorRegistry.every((item) => item && typeof item === "object")))
    || (value.evaluationBindings !== undefined && (!Array.isArray(value.evaluationBindings) || !value.evaluationBindings.every((item) => item && typeof item === "object")))
    || (value.validationLeases !== undefined && (!Array.isArray(value.validationLeases) || !value.validationLeases.every((item) => item && typeof item === "object")))
    || !Array.isArray(value.history) || !value.history.every((item) => item && typeof item === "object")) {
    throw new Error("learning state structure is invalid; run the audit before learning");
  }
  const normalized = {
    ...value,
    config: { ...defaults(), ...value.config },
    candidates: value.candidates.map((candidate) => ({
      ...candidate,
      scope: normalizeStoredScope(candidate.scope, candidate.subjectId, candidate.groupId),
      requiresLocalReview: candidate.requiresLocalReview ?? PROTECTED_LESSON_RE.test(candidate.claim || "")
    })),
    outcomes: value.outcomes || [],
    measurements: value.measurements || [],
    measurementLineage: value.measurementLineage || [],
    applications: value.applications || [],
    deliveries: value.deliveries || [],
    evaluations: value.evaluations || [],
    evaluatorRegistry: value.evaluatorRegistry || [],
    evaluationBindings: value.evaluationBindings || [],
    validationLeases: value.validationLeases || []
  };
  if (normalized.outcomes.some((receipt) => !storedOutcomeStructure(receipt))) {
    throw new Error("learning outcome state is invalid; run the audit before learning");
  }
  if (normalized.measurements.some((receipt) => !storedMeasurementStructure(receipt))) {
    throw new Error("learning measurement state is invalid; run the audit before learning");
  }
  if (normalized.measurementLineage.some((receipt) => !storedMeasurementLineageStructure(receipt))) {
    throw new Error("learning measurement lineage state is invalid; run the audit before learning");
  }
  if (normalized.applications.some((receipt) => !storedApplicationStructure(receipt))) {
    throw new Error("learning application state is invalid; run the audit before learning");
  }
  if (normalized.deliveries.some((receipt) => !storedDeliveryStructure(receipt))) {
    throw new Error("learning delivery state is invalid; run the audit before learning");
  }
  if (normalized.evaluations.some((contract) => !storedEvaluationStructure(contract))) {
    throw new Error("learning evaluation state is invalid; run the audit before learning");
  }
  if (normalized.evaluatorRegistry.some((record) => !storedEvaluatorRecordStructure(record))) {
    throw new Error("learning evaluator registry is invalid; run the audit before learning");
  }
  if (new Set(normalized.evaluatorRegistry.map((record) => record.id)).size !== normalized.evaluatorRegistry.length
    || new Set(normalized.evaluatorRegistry.map((record) => record.principalDigest)).size !== normalized.evaluatorRegistry.length) {
    throw new Error("learning evaluator registry contains duplicate identities or roots; run the audit before learning");
  }
  if (normalized.evaluationBindings.some((binding) => !storedEvaluationBindingStructure(binding)
    || !normalized.evaluations.some((contract) => contract.id === binding.evaluationId
      && contract.digest === binding.evaluationDigest
      && contract.evaluatorRoots?.length === binding.evaluators.length
      && binding.evaluators.every((entry) => contract.evaluatorRoots.some((root) => root.evaluatorId === entry.evaluatorId
        && root.principalDigest === entry.principalDigest))))) {
    throw new Error("learning evaluator binding state is invalid; run the audit before learning");
  }
  if (new Set(normalized.evaluationBindings.map((binding) => binding.evaluationId)).size !== normalized.evaluationBindings.length) {
    throw new Error("learning evaluator binding is duplicated; run the audit before learning");
  }
  if (normalized.evaluations.some((contract) => contract.schema === "agentspine.learning-evaluation/v7"
    && !normalized.evaluationBindings.some((binding) => binding.evaluationId === contract.id
      && binding.evaluationDigest === contract.digest))) {
    throw new Error("learning evaluator binding is missing; run the audit before learning");
  }
  if (normalized.validationLeases.some((lease) => !storedValidationLeaseStructure(lease))) {
    throw new Error("learning validation lease state is invalid; run the audit before learning");
  }
  if (new Set(normalized.validationLeases.map((lease) => lease.id)).size !== normalized.validationLeases.length
    || new Set(normalized.validationLeases.map((lease) => lease.learningId)).size !== normalized.validationLeases.length) {
    throw new Error("learning validation lease is duplicated; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => {
    const candidate = normalized.candidates.find((item) => item.id === receipt.learningId);
    return !candidate || !scopeContains(candidate.scope, receipt.scope);
  })) throw new Error("learning outcome scope is invalid; run the audit before learning");
  if (normalized.applications.some((receipt) => {
    const candidate = normalized.candidates.find((item) => item.id === receipt.learningId);
    return !candidate || !scopeContains(candidate.scope, receipt.scope);
  })) throw new Error("learning application scope is invalid; run the audit before learning");
  if (normalized.deliveries.some((receipt) => {
    const application = normalized.applications.find((item) => item.id === receipt.applicationId);
    return !application || application.learningId !== receipt.learningId
      || application.schema !== "agentspine.learning-application/v2"
      || application.sessionId !== receipt.sessionId || application.preflightReceiptId !== receipt.preflightReceiptId
      || !exactScope(application.scope, receipt.scope)
      || new Date(receipt.completedAt).getTime() < new Date(application.projectedAt).getTime()
      || new Date(receipt.completedAt).getTime() > new Date(application.deliveryExpiresAt).getTime();
  })) throw new Error("learning delivery binding is invalid; run the audit before learning");
  if (normalized.evaluations.some((contract) => {
    const candidate = normalized.candidates.find((item) => item.id === contract.learningId);
    return !candidate || !scopeContains(candidate.scope, contract.scope);
  })) throw new Error("learning evaluation scope is invalid; run the audit before learning");
  if (normalized.measurements.some((receipt) => {
    const candidate = normalized.candidates.find((item) => item.id === receipt.learningId);
    const contract = normalized.evaluations.find((item) => item.id === receipt.evaluationId);
    const evaluatorRoot = ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract?.schema)
      ? contract.evaluatorRoots.find((root) => root.evaluatorId === receipt.measurement?.evaluatorId) : null;
    return !candidate || !contract || !["agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
      || contract.learningId !== receipt.learningId || !exactScope(contract.scope, receipt.scope)
      || contract.metric.name !== receipt.metric.name || contract.metric.direction !== receipt.metric.direction
      || !contract.evaluatorIds.includes(receipt.measurement.evaluatorId)
      || contract.benchmark.datasetDigest !== receipt.coverage.datasetDigest
      || (["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
        && (receipt.schema !== "agentspine.learning-measurement/v2"
          || evaluatorRoot?.principalDigest !== receipt.measurement?.evaluatorRootDigest))
      || receipt.coverage.caseCount < contract.benchmark.minCases
      || !scopeContains(candidate.scope, receipt.scope)
      || new Date(receipt.measuredAt).getTime() < new Date(contract.registeredAt).getTime()
      || new Date(receipt.measuredAt).getTime() > new Date(contract.expiresAt).getTime();
  })) throw new Error("learning measurement binding is invalid; run the audit before learning");
  const pairedOutcomeKeys = new Set();
  const pairedAfterApplications = new Set();
  for (const receipt of normalized.outcomes) {
    if (!["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)) continue;
    const evaluatorKey = receipt.schema === "agentspine.learning-outcome/v9"
      ? receipt.measurement.evaluatorRootDigest : receipt.measurement.evaluatorId;
    const key = `${receipt.evaluationId}\0${receipt.phase}\0${evaluatorKey}`;
    if (pairedOutcomeKeys.has(key)) {
      throw new Error("learning paired evaluator outcome is duplicated; run the audit before learning");
    }
    pairedOutcomeKeys.add(key);
    if (receipt.phase === "after") {
      const applicationKey = `${receipt.evaluationId}\0${receipt.applicationId}`;
      if (pairedAfterApplications.has(applicationKey)) {
        throw new Error("learning paired outcome turn is duplicated; run the audit before learning");
      }
      pairedAfterApplications.add(applicationKey);
    }
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v2", "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
    && receipt.phase === "after" && !normalized.applications.some((application) => application.id === receipt.applicationId
      && application.learningId === receipt.learningId && exactScope(application.scope, receipt.scope)
      && new Date(receipt.measuredAt).getTime() >= new Date(application.projectedAt).getTime()
      && new Date(receipt.measuredAt).getTime() <= new Date(application.expiresAt).getTime()))) {
    throw new Error("learning outcome application binding is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
    && !normalized.evaluations.some((contract) => contract.id === receipt.evaluationId
      && contract.learningId === receipt.learningId && exactScope(contract.scope, receipt.scope)
      && contract.metric.name === receipt.metric.name && contract.metric.direction === receipt.metric.direction
      && contract.evaluatorIds.includes(receipt.measurement.evaluatorId)
      && (receipt.schema !== "agentspine.learning-outcome/v9"
        || (["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
          && contract.evaluatorRoots.some((root) => root.evaluatorId === receipt.measurement.evaluatorId
            && root.principalDigest === receipt.measurement.evaluatorRootDigest)))
      && new Date(receipt.measuredAt).getTime() >= new Date(contract.registeredAt).getTime()
      && new Date(receipt.measuredAt).getTime() <= new Date(contract.expiresAt).getTime()))) {
    throw new Error("learning outcome evaluation binding is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
    && !normalized.evaluations.some((contract) => contract.id === receipt.evaluationId
      && ((receipt.schema === "agentspine.learning-outcome/v5" && contract.schema === "agentspine.learning-evaluation/v2")
        || (receipt.schema === "agentspine.learning-outcome/v6" && contract.schema === "agentspine.learning-evaluation/v3")
        || (receipt.schema === "agentspine.learning-outcome/v7" && contract.schema === "agentspine.learning-evaluation/v4")
        || (receipt.schema === "agentspine.learning-outcome/v8" && contract.schema === "agentspine.learning-evaluation/v5")
        || (receipt.schema === "agentspine.learning-outcome/v9" && ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)))
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases))) {
    throw new Error("learning outcome coverage binding is invalid; run the audit before learning");
  }
  const provenanceKeys = new Set();
  for (const receipt of normalized.outcomes) {
    if (receipt.schema !== "agentspine.learning-outcome/v6") continue;
    const key = `${receipt.evaluationId}\0${receipt.measurement?.sourceDigest || ""}`;
    if (!DIGEST_RE.test(receipt.measurement?.sourceDigest || "") || provenanceKeys.has(key)) {
      throw new Error("learning outcome provenance is missing or replayed; run the audit before learning");
    }
    provenanceKeys.add(key);
  }
  const measurementSources = new Set();
  const measurementRuns = new Set();
  const evaluatorRootRuns = new Set();
  const lineageIds = new Set();
  for (const lineage of normalized.measurementLineage) {
    if (measurementSources.has(lineage.sourceDigest) || measurementRuns.has(lineage.runDigest)
      || (lineage.schema === "agentspine.learning-measurement-lineage/v2" && evaluatorRootRuns.has(lineage.rootRunDigest))
      || lineageIds.has(lineage.measurementReceiptId)) {
      throw new Error("learning measurement lineage is replayed; run the audit before learning");
    }
    measurementSources.add(lineage.sourceDigest);
    measurementRuns.add(lineage.runDigest);
    if (lineage.schema === "agentspine.learning-measurement-lineage/v2") evaluatorRootRuns.add(lineage.rootRunDigest);
    lineageIds.add(lineage.measurementReceiptId);
  }
  if (normalized.measurements.some((receipt) => !normalized.measurementLineage.some((lineage) =>
    lineage.measurementReceiptId === receipt.id && lineage.learningId === receipt.learningId
    && lineage.evaluationId === receipt.evaluationId && lineage.sourceDigest === receipt.measurement.sourceDigest
    && lineage.runDigest === measurementRunDigest(receipt.measurement.evaluatorId, receipt.measurement.runId)
    && (receipt.schema !== "agentspine.learning-measurement/v2"
      || (lineage.schema === "agentspine.learning-measurement-lineage/v2"
        && lineage.evaluatorRootDigest === receipt.measurement.evaluatorRootDigest
        && lineage.rootRunDigest === evaluatorRootRunDigest(receipt.measurement.evaluatorRootDigest, receipt.measurement.runId)))
    && lineage.registeredAt === receipt.measuredAt))) {
    throw new Error("learning measurement lineage binding is invalid; run the audit before learning");
  }
  const consumedMeasurements = new Set();
  for (const receipt of normalized.outcomes) {
    if (!["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)) continue;
    const measurement = normalized.measurements.find((item) => item.id === receipt.measurementReceiptId);
    if (!measurement || measurement.digest !== receipt.measurementReceiptDigest
      || measurement.learningId !== receipt.learningId || measurement.evaluationId !== receipt.evaluationId
      || measurement.phase !== receipt.phase || !exactScope(measurement.scope, receipt.scope)
      || digest(measurement.metric) !== digest(receipt.metric) || digest(measurement.measurement) !== digest(receipt.measurement)
      || digest(measurement.coverage) !== digest(receipt.coverage) || measurement.measuredAt !== receipt.measuredAt
      || consumedMeasurements.has(measurement.id)) {
      throw new Error("learning outcome measurement binding is invalid or replayed; run the audit before learning");
    }
    consumedMeasurements.add(measurement.id);
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
    && receipt.phase === "after" && !normalized.outcomes.some((before) =>
      before.schema === receipt.schema && before.phase === "before"
      && before.learningId === receipt.learningId && before.evaluationId === receipt.evaluationId
      && before.measurement.evaluatorId === receipt.measurement.evaluatorId
      && (receipt.schema !== "agentspine.learning-outcome/v9"
        || before.measurement.evaluatorRootDigest === receipt.measurement.evaluatorRootDigest)
      && before.measurement.kind === receipt.measurement.kind
      && before.coverage.caseCount === receipt.coverage.caseCount
      && exactScope(before.scope, receipt.scope)))) {
    throw new Error("learning paired outcome evaluator binding is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
    && (receipt.phase === "after" ? !normalized.deliveries.some((delivery) => delivery.id === receipt.deliveryId
      && delivery.applicationId === receipt.applicationId && delivery.learningId === receipt.learningId
      && exactScope(delivery.scope, receipt.scope)
      && new Date(receipt.measuredAt).getTime() >= new Date(delivery.completedAt).getTime()) : receipt.deliveryId !== null))) {
    throw new Error("learning outcome delivery binding is invalid; run the audit before learning");
  }
  if (normalized.candidates.some((candidate) => candidate.status === "accepted"
    && candidate.promotion?.mode === "outcome-canary" && candidate.promotion.canary?.evaluationId
    && !normalized.evaluations.some((contract) => contract.id === candidate.promotion.canary.evaluationId
      && contract.learningId === candidate.id && contract.digest === candidate.promotion.canary.evaluationDigest
      && exactScope(contract.scope, candidate.promotion.canary.scope)))) {
    throw new Error("learning canary evaluation binding is invalid; run the audit before learning");
  }
  if (normalized.validationLeases.some((lease) => !validationLeaseMatchesState(normalized, lease))) {
    throw new Error("learning validation lease binding is invalid; run the audit before learning");
  }
  return normalized;
}

function validConfig(config) {
  return typeof config?.autoPromote === "boolean"
    && Number.isFinite(config.minConfidence) && config.minConfidence >= 0.5 && config.minConfidence <= 1
    && Number.isInteger(config.minEvidence) && config.minEvidence >= 1 && config.minEvidence <= 10
    && Number.isInteger(config.maxContextItems) && config.maxContextItems >= 1 && config.maxContextItems <= 50
    && Number.isInteger(config.minOutcomeReceipts) && config.minOutcomeReceipts >= 2 && config.minOutcomeReceipts <= 10
    && Number.isFinite(config.minImprovement) && config.minImprovement >= 0 && config.minImprovement <= 1
    && Number.isFinite(config.regressionTolerance) && config.regressionTolerance >= 0 && config.regressionTolerance <= 1
    && Number.isInteger(config.outcomeMaxAgeDays) && config.outcomeMaxAgeDays >= 1 && config.outcomeMaxAgeDays <= 365
    && Number.isInteger(config.canaryReceipts) && config.canaryReceipts >= 1 && config.canaryReceipts <= 10
    && Number.isInteger(config.canaryTtlDays) && config.canaryTtlDays >= 1 && config.canaryTtlDays <= 90;
}

function normalizeStoredScope(scope, subjectId = null, groupId = null) {
  const source = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
  const normalized = {};
  for (const field of SCOPE_FIELDS) normalized[field] = source[field] ?? null;
  if (normalized.groupId === null && groupId) normalized.groupId = groupId;
  return normalized;
}

function normalizeScope(scope, subjectId = null, groupId = null) {
  const normalized = normalizeStoredScope(scope, subjectId, groupId);
  for (const [field, value] of Object.entries(normalized)) {
    if (value !== null && !ID_RE.test(value)) throw new Error(`scope.${field} must be a stable, whitespace-free identifier`);
  }
  return normalized;
}

function scopeKey(scope) {
  return JSON.stringify(SCOPE_FIELDS.map((field) => scope?.[field] ?? null));
}

function scopeContains(candidateScope, runtimeScope) {
  return SCOPE_FIELDS.every((field) => candidateScope?.[field] === null || candidateScope?.[field] === runtimeScope?.[field]);
}

function exactScope(left, right) {
  return scopeKey(left) === scopeKey(right);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function storedOutcomeStructure(receipt) {
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

function measurementPayload({ id, learningId, evaluationId, phase, scope, metric, measurement, coverage, measuredAt,
  schema = "agentspine.learning-measurement/v1" }) {
  return {
    schema, id, learningId, evaluationId, phase, scope,
    metric, measurement, coverage, measuredAt, authority: "context-only"
  };
}

function storedMeasurementStructure(receipt) {
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

function measurementRunDigest(evaluatorId, runId) {
  return digest([evaluatorId, runId]);
}

function evaluatorRootRunDigest(evaluatorRootDigest, runId) {
  return digest([evaluatorRootDigest, runId]);
}

function evaluatorRecordPayload({ id, principalDigest, status, registeredAt, revokedAt, reason }) {
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

function storedEvaluatorRecordStructure(record) {
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

function evaluationBindingPayload({ evaluationId, evaluationDigest, evaluators, boundAt }) {
  return {
    schema: "agentspine.learning-evaluator-binding/v1",
    evaluationId,
    evaluationDigest,
    evaluators,
    boundAt,
    authority: "context-only"
  };
}

function storedEvaluationBindingStructure(binding) {
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

function activeEvaluatorRecord(state, evaluatorId, principalDigest = null) {
  return state.evaluatorRegistry.find((record) => record.id === evaluatorId && record.status === "active"
    && (principalDigest === null || record.principalDigest === principalDigest)) || null;
}

function activeEvaluationBinding(state, contract) {
  const binding = state.evaluationBindings.find((entry) => entry.evaluationId === contract?.id
    && entry.evaluationDigest === contract?.digest);
  if (!binding) return null;
  return binding.evaluators.every((entry) => {
    const record = activeEvaluatorRecord(state, entry.evaluatorId, entry.principalDigest);
    return record?.digest === entry.registryDigest;
  }) ? binding : null;
}

function validationOutcomeReferences(receipts) {
  return receipts.map((receipt) => ({ id: receipt.id, digest: receipt.digest, authority: "context-only" }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function validationLeasePayload({
  id, learningId, evaluationId, evaluationDigest, evaluatorRegistryBindingDigest,
  scope, metric, beforeOutcomes, afterOutcomes, baselineOutcomes, predecessorValidation,
  renewalEvidence, improvement, validatedAt, expiresAt,
  schema = "agentspine.learning-validation/v1"
}) {
  return {
    schema,
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    evaluatorRegistryBindingDigest,
    scope,
    metric,
    ...(schema === "agentspine.learning-validation/v1"
      ? { beforeOutcomes, afterOutcomes }
      : { baselineOutcomes, predecessorValidation, renewalEvidence }),
    improvement,
    validatedAt,
    expiresAt,
    authority: "context-only"
  };
}

function storedValidationLeaseStructure(lease) {
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) return false;
  const payload = validationLeasePayload(lease);
  const validReferences = (items) => Array.isArray(items) && items.length >= 2
    && items.every((entry) => ID_RE.test(entry?.id || "") && DIGEST_RE.test(entry?.digest || "")
      && entry?.authority === "context-only")
    && new Set(items.map((entry) => entry.id)).size === items.length;
  const validPredecessor = lease.predecessorValidation && ID_RE.test(lease.predecessorValidation.id || "")
    && DIGEST_RE.test(lease.predecessorValidation.digest || "")
    && lease.predecessorValidation.authority === "context-only";
  const validRenewalEvidence = Array.isArray(lease.renewalEvidence) && lease.renewalEvidence.length >= 2
    && lease.renewalEvidence.every((entry) => ID_RE.test(entry?.measurementId || "")
      && DIGEST_RE.test(entry?.measurementDigest || "") && ID_RE.test(entry?.applicationId || "")
      && DIGEST_RE.test(entry?.applicationDigest || "") && ID_RE.test(entry?.deliveryId || "")
      && DIGEST_RE.test(entry?.deliveryDigest || "") && DIGEST_RE.test(entry?.evaluatorRootDigest || "")
      && entry?.authority === "context-only")
    && new Set(lease.renewalEvidence.map((entry) => entry.measurementId)).size === lease.renewalEvidence.length
    && new Set(lease.renewalEvidence.map((entry) => entry.applicationId)).size === lease.renewalEvidence.length
    && new Set(lease.renewalEvidence.map((entry) => entry.deliveryId)).size === lease.renewalEvidence.length
    && new Set(lease.renewalEvidence.map((entry) => entry.evaluatorRootDigest)).size === lease.renewalEvidence.length;
  return ["agentspine.learning-validation/v1", "agentspine.learning-validation/v2"].includes(lease.schema)
    && ID_RE.test(lease.id || "")
    && ID_RE.test(lease.learningId || "") && ID_RE.test(lease.evaluationId || "")
    && DIGEST_RE.test(lease.evaluationDigest || "") && DIGEST_RE.test(lease.evaluatorRegistryBindingDigest || "")
    && lease.scope && SCOPE_FIELDS.every((field) => Object.hasOwn(lease.scope, field))
    && Object.keys(lease.scope).every((field) => SCOPE_FIELDS.includes(field))
    && Object.values(lease.scope).every((value) => value === null || ID_RE.test(value))
    && typeof lease.metric?.name === "string" && lease.metric.name.length > 0
    && METRIC_DIRECTIONS.has(lease.metric?.direction)
    && (lease.schema === "agentspine.learning-validation/v1"
      ? validReferences(lease.beforeOutcomes) && validReferences(lease.afterOutcomes)
      : validReferences(lease.baselineOutcomes) && validPredecessor && validRenewalEvidence)
    && Number.isFinite(lease.improvement) && lease.improvement >= -1 && lease.improvement <= 1
    && Number.isFinite(new Date(lease.validatedAt).getTime()) && Number.isFinite(new Date(lease.expiresAt).getTime())
    && new Date(lease.expiresAt).getTime() > new Date(lease.validatedAt).getTime()
    && lease.authority === "context-only" && lease.digest === digest(payload);
}

function validationLeaseMatchesState(state, lease) {
  const candidate = state.candidates.find((item) => item.id === lease.learningId);
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  const contract = state.evaluations.find((item) => item.id === lease.evaluationId);
  const binding = state.evaluationBindings.find((item) => item.evaluationId === lease.evaluationId);
  const referencesMatch = (references, phase) => references.every((reference) => state.outcomes.some((outcome) =>
    outcome.id === reference.id && outcome.digest === reference.digest && outcome.learningId === lease.learningId
    && outcome.evaluationId === lease.evaluationId && outcome.phase === phase && exactScope(outcome.scope, lease.scope)));
  const common = candidate && canary && canary.status === "validated"
    && canary.validationLeaseId === lease.id && canary.validationLeaseDigest === lease.digest
    && canary.validatedAt === lease.validatedAt && canary.expiresAt === lease.expiresAt
    && Math.abs(canary.improvement - lease.improvement) <= 1e-12
    && contract?.schema === "agentspine.learning-evaluation/v7" && contract.digest === lease.evaluationDigest
    && binding?.digest === lease.evaluatorRegistryBindingDigest
    && exactScope(contract.scope, lease.scope) && digest(contract.metric) === digest(lease.metric);
  const evidenceMatches = lease.schema === "agentspine.learning-validation/v1"
    ? lease.beforeOutcomes.length >= contract.thresholds.beforeReceipts
        && lease.afterOutcomes.length >= contract.thresholds.afterReceipts
        && referencesMatch(lease.beforeOutcomes, "before") && referencesMatch(lease.afterOutcomes, "after")
        && canary.beforeReceipts.length === lease.beforeOutcomes.length
        && lease.beforeOutcomes.every((reference) => canary.beforeReceipts.includes(reference.id))
        && canary.afterReceipts.length === lease.afterOutcomes.length
        && lease.afterOutcomes.every((reference) => canary.afterReceipts.includes(reference.id))
      : lease.baselineOutcomes.length >= contract.thresholds.beforeReceipts
        && referencesMatch(lease.baselineOutcomes, "before")
        && lease.renewalEvidence.length >= contract.thresholds.afterReceipts
        && state.history.some((entry) => entry.kind === "learning-validation"
          && entry.value?.id === lease.predecessorValidation.id
          && entry.value?.digest === lease.predecessorValidation.digest
          && storedValidationLeaseStructure(entry.value))
      && lease.renewalEvidence.every((evidence) => {
          const measurement = state.measurements.find((entry) => entry.id === evidence.measurementId
            && entry.digest === evidence.measurementDigest);
          const application = state.applications.find((entry) => entry.id === evidence.applicationId
            && entry.digest === evidence.applicationDigest);
          const delivery = state.deliveries.find((entry) => entry.id === evidence.deliveryId
            && entry.digest === evidence.deliveryDigest);
          return measurement?.phase === "after" && measurement.evaluationId === lease.evaluationId
            && measurement.measurement?.evaluatorRootDigest === evidence.evaluatorRootDigest
            && application?.learningId === lease.learningId && delivery?.applicationId === application.id
            && delivery.learningId === lease.learningId && exactScope(measurement.scope, lease.scope)
            && exactScope(application.scope, lease.scope) && exactScope(delivery.scope, lease.scope);
      });
  return Boolean(common && evidenceMatches);
}

function validationLeaseState(state, candidate, timestamp) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (candidate?.status !== "accepted" || canary?.status !== "validated") {
    return { status: "not-applicable", lease: null, evaluation: null };
  }
  const evaluation = state.evaluations.find((entry) => entry.id === canary.evaluationId
    && entry.learningId === candidate.id && entry.digest === canary.evaluationDigest) || null;
  if (!evaluation) return { status: "missing-evaluation", lease: null, evaluation: null };
  if (evaluation.schema !== "agentspine.learning-evaluation/v7") {
    return new Date(canary.expiresAt).getTime() < new Date(timestamp).getTime()
      ? { status: "expired", lease: null, evaluation }
      : { status: "legacy", lease: null, evaluation };
  }
  const lease = state.validationLeases.find((entry) => entry.id === canary.validationLeaseId
    && entry.digest === canary.validationLeaseDigest && entry.learningId === candidate.id
    && entry.evaluationId === evaluation.id && entry.evaluationDigest === evaluation.digest) || null;
  if (!lease) return { status: "missing", lease: null, evaluation };
  const binding = activeEvaluationBinding(state, evaluation);
  if (!binding || binding.digest !== lease.evaluatorRegistryBindingDigest) {
    return { status: "revoked", lease, evaluation };
  }
  if (new Date(lease.expiresAt).getTime() <= new Date(timestamp).getTime()
    || lease.expiresAt !== canary.expiresAt) return { status: "expired", lease, evaluation };
  return { status: "active", lease, evaluation };
}

function canaryValidity(state, candidate, timestamp) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
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
  if (evaluation.schema === "agentspine.learning-evaluation/v7" && !activeEvaluationBinding(state, evaluation)) {
    return { status: canary.status === "validated" ? "revoked-validated" : "revoked-active",
      canary, evaluation, lease: null };
  }
  if (canary.status === "validated" && evaluation.schema === "agentspine.learning-evaluation/v7") {
    const validation = validationLeaseState(state, candidate, timestamp);
    if (validation.status !== "active") return { ...validation, status: validation.status === "missing"
      ? "unproven-validated" : `${validation.status}-validated`, canary };
    return { status: "current-validated", canary, evaluation, lease: validation.lease };
  }
  return { status: canary.status === "validated" ? "legacy-validated" : "current-active",
    canary, evaluation, lease: null };
}

function measurementLineagePayload({ measurementReceiptId, learningId, evaluationId, sourceDigest, runDigest,
  evaluatorRootDigest, rootRunDigest, registeredAt,
  schema = "agentspine.learning-measurement-lineage/v1" }) {
  return {
    schema, measurementReceiptId, learningId, evaluationId,
    sourceDigest, runDigest,
    ...(schema === "agentspine.learning-measurement-lineage/v2" ? { evaluatorRootDigest, rootRunDigest } : {}),
    registeredAt, authority: "context-only"
  };
}

function storedMeasurementLineageStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = measurementLineagePayload(receipt);
  return ["agentspine.learning-measurement-lineage/v1", "agentspine.learning-measurement-lineage/v2"].includes(receipt.schema)
    && ID_RE.test(receipt.measurementReceiptId || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.sourceDigest || "")
    && DIGEST_RE.test(receipt.runDigest || "") && Number.isFinite(new Date(receipt.registeredAt).getTime())
    && (receipt.schema !== "agentspine.learning-measurement-lineage/v2"
      || (DIGEST_RE.test(receipt.evaluatorRootDigest || "") && DIGEST_RE.test(receipt.rootRunDigest || "")))
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

function evaluationPayload({ id, learningId, scope, metric, benchmark, evaluatorIds, evaluatorRoots, thresholds, pairing,
  registeredAt, expiresAt, schema = "agentspine.learning-evaluation/v1" }) {
  return {
    schema, id, learningId, scope, metric, benchmark,
    evaluatorIds,
    ...(["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(schema) ? { evaluatorRoots } : {}),
    thresholds,
    ...(["agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(schema) ? { pairing } : {}),
    registeredAt, expiresAt, authority: "context-only"
  };
}

function storedEvaluationStructure(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return false;
  const payload = evaluationPayload(contract);
  return ["agentspine.learning-evaluation/v1", "agentspine.learning-evaluation/v2", "agentspine.learning-evaluation/v3", "agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
    && ID_RE.test(contract.id || "") && ID_RE.test(contract.learningId || "")
    && SCOPE_FIELDS.every((field) => contract.scope?.[field] === null || ID_RE.test(contract.scope?.[field] || ""))
    && typeof contract.metric?.name === "string" && contract.metric.name.length > 0
    && METRIC_DIRECTIONS.has(contract.metric?.direction)
    && [contract.benchmark?.taskDigest, contract.benchmark?.datasetDigest, contract.benchmark?.protocolDigest]
      .every((value) => DIGEST_RE.test(value || ""))
    && Number.isInteger(contract.benchmark?.minCases) && contract.benchmark.minCases >= 1
    && Array.isArray(contract.evaluatorIds) && contract.evaluatorIds.length >= 2
    && new Set(contract.evaluatorIds).size === contract.evaluatorIds.length
    && contract.evaluatorIds.every((id) => ID_RE.test(id || ""))
    && Number.isFinite(contract.thresholds?.minImprovement) && contract.thresholds.minImprovement >= 0
    && contract.thresholds.minImprovement <= 1
    && Number.isFinite(contract.thresholds?.regressionTolerance) && contract.thresholds.regressionTolerance >= 0
    && contract.thresholds.regressionTolerance <= 1
    && Number.isInteger(contract.thresholds?.beforeReceipts) && contract.thresholds.beforeReceipts >= 2
    && Number.isInteger(contract.thresholds?.afterReceipts) && contract.thresholds.afterReceipts >= 1
    && (!["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
      || (Array.isArray(contract.evaluatorRoots)
        && contract.evaluatorRoots.length === contract.evaluatorIds.length
        && contract.evaluatorRoots.every((root) => ID_RE.test(root?.evaluatorId || "")
          && DIGEST_RE.test(root?.principalDigest || "") && root?.authority === "context-only")
        && new Set(contract.evaluatorRoots.map((root) => root.evaluatorId)).size === contract.evaluatorRoots.length
        && new Set(contract.evaluatorRoots.map((root) => root.principalDigest)).size === contract.evaluatorRoots.length
        && contract.evaluatorRoots.map((root) => root.evaluatorId).sort().join("\0") === [...contract.evaluatorIds].sort().join("\0")))
    && (!["agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
      || (contract.pairing?.mode === "same-evaluator"
        && contract.pairing?.maxOutcomesPerEvaluatorPerPhase === 1
        && contract.pairing?.matchMeasurementKind === true
        && contract.pairing?.matchCaseCount === true
        && contract.pairing?.authority === "context-only"))
    && Number.isFinite(new Date(contract.registeredAt).getTime())
    && Number.isFinite(new Date(contract.expiresAt).getTime())
    && new Date(contract.expiresAt).getTime() > new Date(contract.registeredAt).getTime()
    && contract.authority === "context-only" && contract.digest === digest(payload);
}

function applicationPayload({ id, learningId, scope, preflightReceiptId, promptDigest,
  preflightBriefingDigest, sessionBriefingDigest, sessionId, projectedAt, deliveryExpiresAt, expiresAt,
  schema = "agentspine.learning-application/v1" }) {
  return {
    schema, id, learningId, scope,
    preflightReceiptId, promptDigest, preflightBriefingDigest, sessionBriefingDigest,
    ...(schema === "agentspine.learning-application/v2" ? { sessionId, deliveryExpiresAt } : {}),
    projectedAt, expiresAt, authority: "context-only"
  };
}

function storedApplicationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = applicationPayload(receipt);
  const legacy = receipt.schema === "agentspine.learning-application/v1";
  const delivered = receipt.schema === "agentspine.learning-application/v2";
  return (legacy || delivered) && ID_RE.test(receipt.id || "")
    && ID_RE.test(receipt.learningId || "") && ID_RE.test(receipt.preflightReceiptId || "")
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && [receipt.promptDigest, receipt.preflightBriefingDigest, receipt.sessionBriefingDigest]
      .every((value) => /^[a-f0-9]{64}$/.test(value || ""))
    && Number.isFinite(new Date(receipt.projectedAt).getTime())
    && Number.isFinite(new Date(receipt.expiresAt).getTime())
    && new Date(receipt.expiresAt).getTime() >= new Date(receipt.projectedAt).getTime()
    && (!delivered || (ID_RE.test(receipt.sessionId || "")
      && Number.isFinite(new Date(receipt.deliveryExpiresAt).getTime())
      && new Date(receipt.deliveryExpiresAt).getTime() >= new Date(receipt.projectedAt).getTime()
      && new Date(receipt.deliveryExpiresAt).getTime() <= new Date(receipt.expiresAt).getTime()))
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

function deliveryPayload({ id, applicationId, learningId, scope, sessionId, preflightReceiptId,
  hookEvent, completedAt }) {
  return {
    schema: "agentspine.learning-delivery/v1", id, applicationId, learningId, scope,
    sessionId, preflightReceiptId, hookEvent, completedAt, authority: "context-only"
  };
}

function storedDeliveryStructure(receipt) {
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

function date(value, field = "date") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function number(value, field, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function integer(value, field, minimum, maximum) {
  const parsed = number(value, field, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function relativePath(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a project-relative path`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must be a project-relative path`);
  }
  return normalized;
}

function safeText(value, field, maximum) {
  if (!value || typeof value !== "string") throw new Error(`${field} is required`);
  const text = value.trim().slice(0, maximum);
  if (SECRET_RE.test(text)) throw new Error(`${field} appears to contain a secret and cannot enter learning state`);
  return text;
}

function assertSafeClaim(claim) {
  if (AUTHORITY_ASSERTION_RE.test(claim)) {
    throw new Error("authority and access claims cannot become learned context");
  }
}

function isGroupMember(graph, groupId, entityId) {
  if (!entityId || entityId === groupId) return true;
  return graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
    (edge.from === entityId && edge.to === groupId) || (edge.to === entityId && edge.from === groupId)
  ));
}

function validateScope(privacy, groupId, graph, subjectId) {
  if (!PRIVACY.has(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  if (subjectId !== null && !graph.entities.some((entity) => entity.id === subjectId)) throw new Error(`unknown subject entity: ${subjectId}`);
  if (privacy === "group") {
    if (!groupId) throw new Error("group privacy requires groupId");
    const group = graph.entities.find((entity) => entity.id === groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
    if (!isGroupMember(graph, groupId, subjectId)) throw new Error(`subject is not a visible member of group: ${groupId}`);
  } else if (groupId !== null && groupId !== undefined) {
    throw new Error("groupId is only valid with group privacy");
  }
}

async function readState(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("learning state exceeds the 5 MiB read limit");
    return normalizeState(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyLearning(root);
  }
}

export async function loadLearning(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const learningPath = join(directory, "learning.json");
  return { learning: await readState(learningPath, catalog.root), learningPath, catalog };
}

export async function inspectLearning(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const learningPath = join(directory, "learning.json");
  try {
    return { learning: await readState(learningPath, catalog.root), learningPath, catalog, error: null };
  } catch (error) {
    return { learning: emptyLearning(catalog.root), learningPath, catalog, error: error.message };
  }
}

async function saveState(state, path) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("learning state exceeds 5 MiB; reject or delete old candidates first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        const transientWindowsReplace = process.platform === "win32"
          && ["EACCES", "EBUSY", "EPERM"].includes(error.code);
        if (!transientWindowsReplace || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    });
    throw error;
  }
}

async function withLock(path, root, task) {
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lockPath);
      } catch (lockError) {
        if (!isTransientLockMetadataError(lockError)) throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("learning state is busy; retry shortly");
  try {
    const state = await readState(path, root);
    if (!validConfig(state.config)) throw new Error("learning configuration is invalid; run the audit before learning");
    const result = await task(state);
    await saveState(state, path);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function mutation(root, operation, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { learningPath } = await loadLearning(catalog.root, catalog);
  return withLock(learningPath, catalog.root, async (state) => operation(state, catalog, learningPath));
}

function preserve(state, kind, value, now) {
  if (!value) return;
  state.history.push({
    kind,
    recordId: value.id || "config",
    subjectId: value.subjectId || null,
    supersededAt: now,
    privacy: value.privacy || "private",
    value: { ...value, authority: "context-only" },
    authority: "context-only"
  });
}

function normalizeEvidence(input, catalog, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("evidence is required");
  const id = input.id || `evidence:${randomUUID()}`;
  if (!ID_RE.test(id)) throw new Error("evidence.id must be a stable, whitespace-free identifier");
  const type = input.type || "interaction";
  if (!EVIDENCE_TYPES.has(type)) throw new Error(`unsupported evidence type: ${type}`);
  const sourceDocument = relativePath(input.sourceDocument, "evidence.sourceDocument");
  let sourceSha256 = null;
  if (sourceDocument !== null) {
    const source = catalog.documents.find((document) => document.relativePath === sourceDocument);
    if (!source) throw new Error(`unknown evidence source document: ${sourceDocument}`);
    sourceSha256 = source.sha256;
  }
  if (type === "document" && !sourceDocument) throw new Error("document evidence requires sourceDocument");
  return {
    id,
    type,
    summary: safeText(input.summary, "evidence.summary", 500),
    sourceDocument,
    sourceSha256,
    confidence: number(input.confidence ?? 0.5, "evidence.confidence", 0, 1),
    observedAt: date(input.observedAt || now, "evidence.observedAt"),
    authority: "context-only"
  };
}

function evidenceConfidence(evidence) {
  if (!evidence.length) return 0;
  return evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length;
}

export async function proposeLearning({
  root = process.cwd(), id = `learning:${randomUUID()}`, kind, claim, subjectId = null,
  privacy = "private", groupId = null, scope = null, evidence, supersedesId = null, now = new Date(),
  catalog: providedCatalog = null
}) {
  if (!ID_RE.test(id)) throw new Error("id must be a stable, whitespace-free identifier");
  if (!KINDS.has(kind)) throw new Error(`unsupported learning kind: ${kind}`);
  claim = safeText(claim, "claim", 1000);
  assertSafeClaim(claim);
  const normalizedScope = normalizeScope(scope, subjectId, groupId);
  if (normalizedScope.groupId !== (groupId ?? null)) throw new Error("scope.groupId must match the privacy groupId");
  const timestamp = date(now, "now");
  return mutation(root, async (state, catalog, learningPath) => {
    if (state.candidates.some((candidate) => candidate.id === id)) {
      throw new Error("learning candidate IDs are immutable; add evidence or propose a superseding candidate");
    }
    const { graph } = await loadGraph(catalog.root, catalog);
    validateScope(privacy, groupId, graph, subjectId);
    const duplicate = state.candidates.find((candidate) => candidate.kind === kind
      && candidate.claim === claim && exactScope(candidate.scope, normalizedScope)
      && candidate.privacy === privacy && candidate.status !== "rejected" && candidate.status !== "rolled-back");
    if (duplicate) return { candidate: duplicate, learningPath, unchanged: true };
    const normalizedEvidence = normalizeEvidence(evidence, catalog, timestamp);
    const superseded = supersedesId ? state.candidates.find((candidate) => candidate.id === supersedesId) : null;
    if (supersedesId && (!superseded || superseded.status !== "accepted")) {
      throw new Error(`supersedesId must reference an accepted learning: ${supersedesId}`);
    }
    if (superseded && (superseded.kind !== kind || superseded.subjectId !== subjectId || superseded.privacy !== privacy
      || superseded.groupId !== groupId || !exactScope(superseded.scope, normalizedScope))) {
      throw new Error("a superseding candidate must keep kind, subject, and privacy scope");
    }
    const conflictsWith = state.candidates.filter((candidate) => candidate.kind === kind
      && candidate.claim !== claim && exactScope(candidate.scope, normalizedScope)
      && ["candidate", "accepted"].includes(candidate.status) && candidate.id !== supersedesId)
      .map((candidate) => candidate.id).sort();
    if (conflictsWith.length) {
      state.candidates = state.candidates.map((candidate) => conflictsWith.includes(candidate.id)
        ? { ...candidate, conflictsWith: [...new Set([...(candidate.conflictsWith || []), id])].sort(), updatedAt: timestamp }
        : candidate);
    }
    const candidate = {
      id,
      kind,
      claim,
      subjectId,
      privacy,
      groupId,
      scope: normalizedScope,
      status: "candidate",
      evidence: [normalizedEvidence],
      confidence: normalizedEvidence.confidence,
      supersedesId,
      supersededIds: [],
      conflictsWith,
      requiresLocalReview: PROTECTED_LESSON_RE.test(claim),
      automatic: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      acceptedAt: null,
      authority: "context-only"
    };
    state.candidates.push(candidate);
    state.candidates.sort((a, b) => a.id.localeCompare(b.id));
    return { candidate, learningPath };
  }, providedCatalog);
}

export async function addLearningEvidence({
  root = process.cwd(), id, evidence, now = new Date(), catalog: providedCatalog = null
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, catalog, learningPath) => {
    const previous = state.candidates.find((candidate) => candidate.id === id);
    if (!previous) throw new Error(`unknown learning candidate: ${id}`);
    if (previous.status !== "candidate") throw new Error("evidence can only be added to an unreviewed candidate");
    const item = normalizeEvidence(evidence, catalog, timestamp);
    if (previous.evidence.some((entry) => entry.id === item.id)) throw new Error(`duplicate evidence id: ${item.id}`);
    preserve(state, "learning-candidate", previous, timestamp);
    const candidate = {
      ...previous,
      evidence: [...previous.evidence, item],
      confidence: evidenceConfidence([...previous.evidence, item]),
      updatedAt: timestamp,
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === id ? candidate : entry);
    return { candidate, learningPath };
  }, providedCatalog);
}

function acceptCandidate(state, candidate, timestamp, automatic, promotion = null) {
  preserve(state, "learning-candidate", candidate, timestamp);
  const superseded = candidate.supersedesId
    ? state.candidates.find((entry) => entry.id === candidate.supersedesId && entry.status === "accepted")
    : null;
  if (candidate.supersedesId && !superseded) throw new Error("the learning being superseded is no longer active");
  if (superseded) {
    preserve(state, "learning-candidate", superseded, timestamp);
    state.candidates = state.candidates.map((entry) => entry.id === superseded.id
      ? { ...entry, status: "superseded", updatedAt: timestamp, authority: "context-only" }
      : entry);
  }
  const accepted = {
    ...candidate,
    status: "accepted",
    supersededIds: superseded ? [superseded.id] : [],
    automatic,
    promotion,
    acceptedAt: timestamp,
    updatedAt: timestamp,
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? accepted : entry);
  return accepted;
}

export async function reviewLearning({
  root = process.cwd(), id, decision, reason, confirmedByUser = false, now = new Date()
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  if (!new Set(["accept", "reject"]).has(decision)) throw new Error("decision must be accept or reject");
  const reviewReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`unknown learning candidate: ${id}`);
    if (candidate.status !== "candidate") throw new Error("only an unreviewed candidate can be reviewed");
    if (decision === "accept") {
      if (!confirmedByUser) throw new Error("acceptance requires explicit user confirmation");
      const accepted = acceptCandidate(state, candidate, timestamp, false, null);
      accepted.review = { decision, reason: reviewReason, confirmedByUser: true, reviewedAt: timestamp, authority: "context-only" };
      return { candidate: accepted, learningPath };
    }
    preserve(state, "learning-candidate", candidate, timestamp);
    const rejected = {
      ...candidate,
      status: "rejected",
      updatedAt: timestamp,
      review: { decision, reason: reviewReason, confirmedByUser: false, reviewedAt: timestamp, authority: "context-only" },
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === id ? rejected : entry);
    return { candidate: rejected, learningPath };
  });
}

function distinctEvidence(candidate) {
  return new Set(candidate.evidence.map((item) => item.sourceSha256 || item.sourceDocument || item.id)).size;
}

export async function registerLearningEvaluator({
  root = process.cwd(), id, principalDigest, confirmLocalEvaluator = false, now = new Date()
}) {
  if (!confirmLocalEvaluator) throw new Error("evaluator registration requires explicit local confirmation");
  if (!ID_RE.test(id || "")) throw new Error("evaluator id must be a stable identifier");
  if (!DIGEST_RE.test(principalDigest || "")) throw new Error("evaluator principalDigest must be SHA-256");
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const existing = state.evaluatorRegistry.find((record) => record.id === id || record.principalDigest === principalDigest);
    if (existing) {
      if (existing.id === id && existing.principalDigest === principalDigest && existing.status === "active") {
        return { evaluator: existing, learningPath, unchanged: true };
      }
      throw new Error("evaluator IDs and principal roots are immutable; register a new distinct evaluator instead");
    }
    const payload = evaluatorRecordPayload({ id, principalDigest, status: "active", registeredAt: timestamp,
      revokedAt: null, reason: null });
    const evaluator = { ...payload, digest: digest(payload) };
    state.evaluatorRegistry.push(evaluator);
    state.evaluatorRegistry.sort((a, b) => a.id.localeCompare(b.id));
    return { evaluator, learningPath, unchanged: false };
  });
}

export async function revokeLearningEvaluator({
  root = process.cwd(), id, reason, confirmLocalEvaluator = false, now = new Date()
}) {
  if (!confirmLocalEvaluator) throw new Error("evaluator revocation requires explicit local confirmation");
  if (!ID_RE.test(id || "")) throw new Error("evaluator id must be a stable identifier");
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const previous = state.evaluatorRegistry.find((record) => record.id === id);
    if (!previous) throw new Error(`unknown learning evaluator: ${id}`);
    if (previous.status !== "active") throw new Error("learning evaluator is already revoked");
    preserve(state, "learning-evaluator", previous, timestamp);
    const payload = evaluatorRecordPayload({ ...previous, status: "revoked", revokedAt: timestamp, reason: revokeReason });
    const evaluator = { ...payload, digest: digest(payload) };
    state.evaluatorRegistry = state.evaluatorRegistry.map((record) => record.id === id ? evaluator : record);
    return { evaluator, learningPath };
  });
}

export async function registerLearningEvaluation({
  root = process.cwd(), id = `evaluation:${randomUUID()}`, learningId, scope, metric, benchmark,
  evaluatorIds, evaluatorRoots, expiresAt = null, confirmLocalEvaluation = false, now = new Date()
}) {
  if (!confirmLocalEvaluation) throw new Error("evaluation registration requires explicit local confirmation");
  if (!ID_RE.test(id || "") || !ID_RE.test(learningId || "")) {
    throw new Error("evaluation id and learningId must be stable identifiers");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (!candidate) throw new Error(`unknown learning candidate: ${learningId}`);
    if (candidate.kind !== "behavior" || candidate.status !== "candidate" || candidate.requiresLocalReview) {
      throw new Error("evaluation contracts are limited to unreviewed, low-risk behavior candidates");
    }
    const normalizedScope = normalizeScope(scope);
    if (!scopeContains(candidate.scope, normalizedScope)) throw new Error("evaluation scope does not match the learning candidate");
    const name = safeText(metric?.name, "evaluation.metric.name", 120);
    const direction = metric?.direction;
    if (!METRIC_DIRECTIONS.has(direction)) throw new Error("evaluation.metric.direction must be higher or lower");
    const digests = {
      taskDigest: benchmark?.taskDigest,
      datasetDigest: benchmark?.datasetDigest,
      protocolDigest: benchmark?.protocolDigest
    };
    if (Object.entries(digests).some(([, value]) => !DIGEST_RE.test(value || ""))) {
      throw new Error("evaluation benchmark digests must be SHA-256 values");
    }
    const normalizedEvaluators = [...new Set((evaluatorIds || []).map((value) => String(value)))].sort();
    const requestedRoots = new Map((evaluatorRoots || []).map((root) => [String(root?.evaluatorId || ""),
      String(root?.principalDigest || "")]));
    const requiredEvaluators = Math.max(state.config.minOutcomeReceipts, state.config.canaryReceipts, 2);
    if (normalizedEvaluators.length < requiredEvaluators || normalizedEvaluators.some((value) => !ID_RE.test(value))) {
      throw new Error(`evaluation requires at least ${requiredEvaluators} distinct stable evaluator IDs`);
    }
    const registeredRoots = normalizedEvaluators.map((evaluatorId) => activeEvaluatorRecord(state, evaluatorId));
    if (registeredRoots.some((record) => !record)
      || new Set(registeredRoots.map((record) => record.principalDigest)).size !== registeredRoots.length) {
      throw new Error("evaluation requires every evaluator root to be active in the locally confirmed registry");
    }
    if (requestedRoots.size && (requestedRoots.size !== registeredRoots.length
      || registeredRoots.some((record) => requestedRoots.get(record.id) !== record.principalDigest))) {
      throw new Error("evaluation evaluator roots do not match the active local registry");
    }
    const normalizedRoots = registeredRoots.map((record) => ({
      evaluatorId: record.id, principalDigest: record.principalDigest, authority: "context-only"
    })).sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId));
    const expiry = date(expiresAt || new Date(new Date(timestamp).getTime()
      + state.config.outcomeMaxAgeDays * 86400000), "evaluation.expiresAt");
    if (new Date(expiry).getTime() <= new Date(timestamp).getTime()
      || new Date(expiry).getTime() > new Date(timestamp).getTime() + 365 * 86400000) {
      throw new Error("evaluation expiry must be in the future and no more than 365 days away");
    }
    const payload = evaluationPayload({
      schema: "agentspine.learning-evaluation/v7",
      id, learningId, scope: normalizedScope, metric: { name, direction },
      benchmark: { ...digests, minCases: integer(benchmark?.minCases, "evaluation.benchmark.minCases", 1, 1000000) },
      evaluatorIds: normalizedEvaluators,
      evaluatorRoots: normalizedRoots,
      thresholds: {
        minImprovement: state.config.minImprovement,
        regressionTolerance: state.config.regressionTolerance,
        beforeReceipts: state.config.minOutcomeReceipts,
        afterReceipts: state.config.canaryReceipts
      },
      pairing: {
        mode: "same-evaluator",
        maxOutcomesPerEvaluatorPerPhase: 1,
        matchMeasurementKind: true,
        matchCaseCount: true,
        authority: "context-only"
      },
      registeredAt: timestamp, expiresAt: expiry
    });
    const contract = { ...payload, digest: digest(payload) };
    const existing = state.evaluations.find((entry) => entry.id === id);
    if (existing) {
      if (existing.digest === contract.digest) {
        const binding = state.evaluationBindings.find((entry) => entry.evaluationId === existing.id) || null;
        return { contract: existing, binding, learningPath, unchanged: true };
      }
      throw new Error("evaluation contract IDs are immutable");
    }
    if (state.evaluations.some((entry) => entry.learningId === learningId
      && exactScope(entry.scope, normalizedScope) && new Date(entry.expiresAt).getTime() >= new Date(timestamp).getTime())) {
      throw new Error("an active evaluation contract already exists for this learning and exact scope");
    }
    state.evaluations.push(contract);
    state.evaluations.sort((a, b) => a.id.localeCompare(b.id));
    const bindingPayload = evaluationBindingPayload({
      evaluationId: contract.id,
      evaluationDigest: contract.digest,
      evaluators: registeredRoots.map((record) => ({ evaluatorId: record.id,
        principalDigest: record.principalDigest, registryDigest: record.digest, authority: "context-only" }))
        .sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId)),
      boundAt: timestamp
    });
    const binding = { ...bindingPayload, digest: digest(bindingPayload) };
    state.evaluationBindings.push(binding);
    state.evaluationBindings.sort((a, b) => a.evaluationId.localeCompare(b.evaluationId));
    return { contract, binding, learningPath, unchanged: false };
  });
}

export async function beginLearningRevalidation({
  root = process.cwd(), learningId, confirmLocalValidation = false, now = new Date()
}) {
  if (!confirmLocalValidation) throw new Error("revalidation requires explicit local confirmation");
  if (!ID_RE.test(learningId || "")) throw new Error("learningId is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    const validation = validationLeaseState(state, candidate, timestamp);
    if (validation.status !== "active" || validation.evaluation?.schema !== "agentspine.learning-evaluation/v7") {
      throw new Error("revalidation requires one current registry-bound validation lease");
    }
    const canary = candidate.promotion.canary;
    if (canary.revalidation?.status === "active"
      && new Date(canary.revalidation.expiresAt).getTime() > new Date(timestamp).getTime()) {
      return { candidate, revalidation: canary.revalidation, learningPath, unchanged: true };
    }
    const possibleExpiry = Math.min(new Date(validation.evaluation.expiresAt).getTime(),
      new Date(timestamp).getTime() + state.config.canaryTtlDays * 86400000);
    if (possibleExpiry <= new Date(validation.lease.expiresAt).getTime()) {
      throw new Error("revalidation cannot extend evidence within the current evaluation contract window");
    }
    const revalidation = {
      schema: "agentspine.learning-revalidation-window/v1",
      status: "active",
      startedAt: timestamp,
      expiresAt: validation.lease.expiresAt,
      predecessorValidationId: validation.lease.id,
      predecessorValidationDigest: validation.lease.digest,
      authority: "context-only"
    };
    preserve(state, "learning-candidate", candidate, timestamp);
    const updated = {
      ...candidate,
      promotion: { ...candidate.promotion, canary: { ...canary, revalidation } },
      updatedAt: timestamp,
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === learningId ? updated : entry);
    return { candidate: updated, revalidation, learningPath, unchanged: false };
  });
}

function validationEvidencePreviouslyUsed(state, measurementId, applicationId, deliveryId) {
  const leases = [
    ...state.validationLeases,
    ...state.history.filter((entry) => entry.kind === "learning-validation").map((entry) => entry.value)
  ];
  return leases.some((lease) => lease?.schema === "agentspine.learning-validation/v2"
    && lease.renewalEvidence?.some((entry) => entry.measurementId === measurementId
      || entry.applicationId === applicationId || entry.deliveryId === deliveryId));
}

export async function renewLearningValidation({
  root = process.cwd(), learningId, evidence, confirmLocalValidation = false, now = new Date()
}) {
  if (!confirmLocalValidation) throw new Error("validation renewal requires explicit local confirmation");
  if (!ID_RE.test(learningId || "") || !Array.isArray(evidence) || !evidence.length) {
    throw new Error("validation renewal requires a learningId and evidence bindings");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    const validation = validationLeaseState(state, candidate, timestamp);
    const revalidation = candidate?.promotion?.canary?.revalidation;
    if (validation.status !== "active" || validation.evaluation?.schema !== "agentspine.learning-evaluation/v7"
      || revalidation?.status !== "active" || revalidation.predecessorValidationId !== validation.lease.id
      || revalidation.predecessorValidationDigest !== validation.lease.digest
      || new Date(revalidation.expiresAt).getTime() < new Date(timestamp).getTime()) {
      throw new Error("validation renewal requires one current matching revalidation window");
    }
    const contract = validation.evaluation;
    const baselineReferences = validation.lease.schema === "agentspine.learning-validation/v1"
      ? validation.lease.beforeOutcomes : validation.lease.baselineOutcomes;
    const baselines = baselineReferences.map((reference) => state.outcomes.find((outcome) =>
      outcome.id === reference.id && outcome.digest === reference.digest));
    if (baselines.some((item) => !item)) throw new Error("validation renewal baseline evidence is missing");
    const baselineByRoot = new Map(baselines.map((item) => [item.measurement.evaluatorRootDigest, item]));
    const normalized = evidence.map((entry) => {
      const measurement = state.measurements.find((item) => item.id === entry?.measurementId);
      const application = state.applications.find((item) => item.id === entry?.applicationId);
      const delivery = state.deliveries.find((item) => item.id === entry?.deliveryId);
      if (!measurement || !application || !delivery) throw new Error("validation renewal evidence binding is missing");
      const baseline = baselineByRoot.get(measurement.measurement?.evaluatorRootDigest);
      if (measurement.phase !== "after" || measurement.learningId !== learningId
        || measurement.evaluationId !== contract.id || !exactScope(measurement.scope, contract.scope)
        || !baseline || measurement.measurement.kind === "model-suggestion"
        || measurement.measurement.kind !== baseline.measurement.kind
        || measurement.coverage.caseCount !== baseline.coverage.caseCount
        || new Date(measurement.measuredAt).getTime() < new Date(revalidation.startedAt).getTime()) {
        throw new Error("validation renewal measurement does not match the frozen baseline cohort");
      }
      if (application.learningId !== learningId || !exactScope(application.scope, contract.scope)
        || new Date(application.projectedAt).getTime() < new Date(revalidation.startedAt).getTime()
        || delivery.applicationId !== application.id || delivery.learningId !== learningId
        || !exactScope(delivery.scope, contract.scope)
        || new Date(measurement.measuredAt).getTime() < new Date(delivery.completedAt).getTime()
        || new Date(measurement.measuredAt).getTime() > new Date(application.expiresAt).getTime()) {
        throw new Error("validation renewal requires a distinct completed matching model turn");
      }
      if (validationEvidencePreviouslyUsed(state, measurement.id, application.id, delivery.id)) {
        throw new Error("validation renewal evidence cannot be replayed");
      }
      return { measurement, application, delivery, baseline };
    });
    const roots = new Set(normalized.map((item) => item.measurement.measurement.evaluatorRootDigest));
    const applications = new Set(normalized.map((item) => item.application.id));
    if (roots.size < contract.thresholds.afterReceipts || applications.size < contract.thresholds.afterReceipts
      || !normalized.some((item) => item.measurement.measurement.kind === "objective")) {
      throw new Error("validation renewal requires the frozen independent evidence threshold");
    }
    if (normalized.some((item) => item.measurement.metric.blockingDefects > 0)) {
      const rolledBack = rollbackCandidate(state, candidate, "validation renewal recorded a blocking defect",
        timestamp, "automatic-revalidation-regression");
      return { ...rolledBack, decision: "rolled-back", learningPath };
    }
    const deltas = normalized.map((item) => improvement(contract.metric.direction,
      item.baseline.metric.value, item.measurement.metric.value));
    if (deltas.some((value) => value < -contract.thresholds.regressionTolerance)) {
      const rolledBack = rollbackCandidate(state, candidate, "validation renewal regressed against its frozen baseline",
        timestamp, "automatic-revalidation-regression");
      return { ...rolledBack, decision: "rolled-back", learningPath };
    }
    const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    if (average < contract.thresholds.minImprovement) {
      const rolledBack = rollbackCandidate(state, candidate, "validation renewal did not meet the frozen minimum improvement",
        timestamp, "automatic-revalidation-no-improvement");
      return { ...rolledBack, decision: "rolled-back", learningPath };
    }
    const expiresAt = new Date(Math.min(new Date(contract.expiresAt).getTime(),
      new Date(timestamp).getTime() + state.config.canaryTtlDays * 86400000)).toISOString();
    if (new Date(expiresAt).getTime() <= new Date(validation.lease.expiresAt).getTime()) {
      throw new Error("validation renewal cannot extend the current evidence lease");
    }
    const payload = validationLeasePayload({
      schema: "agentspine.learning-validation/v2",
      id: `validation:${randomUUID()}`,
      learningId,
      evaluationId: contract.id,
      evaluationDigest: contract.digest,
      evaluatorRegistryBindingDigest: validation.lease.evaluatorRegistryBindingDigest,
      scope: contract.scope,
      metric: contract.metric,
      baselineOutcomes: baselineReferences,
      predecessorValidation: { id: validation.lease.id, digest: validation.lease.digest, authority: "context-only" },
      renewalEvidence: normalized.map(({ measurement, application, delivery }) => ({
        measurementId: measurement.id, measurementDigest: measurement.digest,
        applicationId: application.id, applicationDigest: application.digest,
        deliveryId: delivery.id, deliveryDigest: delivery.digest,
        evaluatorRootDigest: measurement.measurement.evaluatorRootDigest,
        authority: "context-only"
      })).sort((a, b) => a.evaluatorRootDigest.localeCompare(b.evaluatorRootDigest)),
      improvement: average,
      validatedAt: timestamp,
      expiresAt
    });
    const lease = { ...payload, digest: digest(payload) };
    preserve(state, "learning-validation", validation.lease, timestamp);
    state.validationLeases = state.validationLeases.filter((entry) => entry.learningId !== learningId);
    state.validationLeases.push(lease);
    state.validationLeases.sort((a, b) => a.id.localeCompare(b.id));
    preserve(state, "learning-candidate", candidate, timestamp);
    const renewed = {
      ...candidate,
      promotion: { ...candidate.promotion, canary: {
        ...candidate.promotion.canary,
        validatedAt: timestamp,
        expiresAt,
        improvement: average,
        validationLeaseId: lease.id,
        validationLeaseDigest: lease.digest,
        revalidation: null
      } },
      updatedAt: timestamp,
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === learningId ? renewed : entry);
    return { candidate: renewed, lease, decision: "renewed", learningPath };
  });
}

export async function recordLearningMeasurement({
  root = process.cwd(), id = `measurement:${randomUUID()}`, learningId, evaluationId, phase, scope, metric,
  measurement, coverage, measuredAt, confirmLocalMeasurement = false, now = new Date()
}) {
  if (!confirmLocalMeasurement) throw new Error("measurement registration requires explicit local confirmation");
  if (!ID_RE.test(id || "") || !ID_RE.test(learningId || "") || !ID_RE.test(evaluationId || "")) {
    throw new Error("measurement id, learningId and evaluationId must be stable identifiers");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    const existing = state.measurements.find((entry) => entry.id === id);
    if (!candidate || !evaluation || !["agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema)
      || evaluation.learningId !== learningId) {
      throw new Error("measurements require a matching lineage evaluation contract");
    }
    if (evaluation.schema === "agentspine.learning-evaluation/v7" && !activeEvaluationBinding(state, evaluation)) {
      throw new Error("measurement evaluator registry binding is missing, changed, or revoked");
    }
    const normalizedScope = normalizeScope(scope);
    if (!scopeContains(candidate.scope, normalizedScope) || !exactScope(evaluation.scope, normalizedScope)) {
      throw new Error("measurement scope does not match the evaluation contract");
    }
    if (!OUTCOME_PHASES.has(phase)) throw new Error("measurement phase must be before or after");
    if (phase === "before" && candidate.status !== "candidate") {
      throw new Error("before measurements require an unreviewed candidate");
    }
    const activeRevalidation = candidate?.promotion?.canary?.status === "validated"
      && candidate.promotion.canary.revalidation?.status === "active"
      && new Date(candidate.promotion.canary.revalidation.expiresAt).getTime() >= new Date(timestamp).getTime();
    if (phase === "after" && (candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
      || (!activeRevalidation && candidate.promotion?.canary?.status !== "active")
      || candidate.promotion.canary.evaluationId !== evaluationId)) {
      throw new Error("after measurements require the matching active outcome canary");
    }
    const name = safeText(metric?.name, "measurement.metric.name", 120);
    const direction = metric?.direction;
    if (name !== evaluation.metric.name || direction !== evaluation.metric.direction) {
      throw new Error("measurement metric does not match the evaluation contract");
    }
    const normalizedMetric = {
      name, direction,
      value: number(metric?.value, "measurement.metric.value", 0, 1),
      blockingDefects: integer(metric?.blockingDefects ?? 0, "measurement.metric.blockingDefects", 0, 1000)
    };
    const kind = measurement?.kind;
    const evaluatorId = measurement?.evaluatorId;
    const runId = measurement?.runId;
    const sourceDigest = measurement?.sourceDigest;
    if (!MEASUREMENT_KINDS.has(kind)) throw new Error("measurement kind is unsupported");
    if (!ID_RE.test(evaluatorId || "") || !evaluation.evaluatorIds.includes(evaluatorId)) {
      throw new Error("measurement evaluator is not allowed by the evaluation contract");
    }
    if (!ID_RE.test(runId || "")) throw new Error("measurement runId must be a stable identifier");
    if (!DIGEST_RE.test(sourceDigest || "")) throw new Error("measurement sourceDigest must be a SHA-256 digest");
    const evaluatorRoot = ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema)
      ? evaluation.evaluatorRoots.find((root) => root.evaluatorId === evaluatorId) : null;
    if (["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema) && !evaluatorRoot) {
      throw new Error("measurement evaluator root is not frozen by the evaluation contract");
    }
    const normalizedMeasurement = {
      kind, evaluatorId, runId, sourceDigest,
      ...(evaluatorRoot ? { evaluatorRootDigest: evaluatorRoot.principalDigest } : {}),
      authority: "context-only"
    };
    const normalizedCoverage = {
      datasetDigest: coverage?.datasetDigest,
      caseCount: integer(coverage?.caseCount, "measurement.coverage.caseCount", 1, 1000000),
      authority: "context-only"
    };
    if (normalizedCoverage.datasetDigest !== evaluation.benchmark.datasetDigest) {
      throw new Error("measurement coverage dataset does not match the evaluation contract");
    }
    if (normalizedCoverage.caseCount < evaluation.benchmark.minCases) {
      throw new Error(`measurement coverage requires at least ${evaluation.benchmark.minCases} cases`);
    }
    const observedAt = date(measuredAt || existing?.measuredAt || timestamp, "measurement.measuredAt");
    if (new Date(observedAt).getTime() < new Date(evaluation.registeredAt).getTime()
      || new Date(observedAt).getTime() > new Date(evaluation.expiresAt).getTime()
      || (!existing && new Date(observedAt).getTime() > new Date(timestamp).getTime())) {
      throw new Error("measurement is outside its evaluation contract window");
    }
    const payload = measurementPayload({
      schema: ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema)
        ? "agentspine.learning-measurement/v2" : "agentspine.learning-measurement/v1",
      id, learningId, evaluationId, phase, scope: normalizedScope,
      metric: normalizedMetric, measurement: normalizedMeasurement, coverage: normalizedCoverage, measuredAt: observedAt });
    const receipt = { ...payload, digest: digest(payload) };
    const lineagePayload = measurementLineagePayload({
      schema: evaluatorRoot ? "agentspine.learning-measurement-lineage/v2" : "agentspine.learning-measurement-lineage/v1",
      measurementReceiptId: id, learningId, evaluationId, sourceDigest,
      runDigest: measurementRunDigest(evaluatorId, runId),
      evaluatorRootDigest: evaluatorRoot?.principalDigest,
      rootRunDigest: evaluatorRoot ? evaluatorRootRunDigest(evaluatorRoot.principalDigest, runId) : undefined,
      registeredAt: observedAt
    });
    const lineage = { ...lineagePayload, digest: digest(lineagePayload) };
    if (existing) {
      const existingLineage = state.measurementLineage.find((entry) => entry.measurementReceiptId === id);
      if (existing.digest === receipt.digest && existingLineage?.digest === lineage.digest) {
        return { receipt: existing, lineage: existingLineage, learningPath, unchanged: true };
      }
      throw new Error("measurement receipt IDs are immutable");
    }
    if (["agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema) && phase === "after") {
      const beforeReceiptIds = new Set(candidate.promotion?.canary?.beforeReceipts || []);
      const pairedBefore = state.outcomes.find((entry) => beforeReceiptIds.has(entry.id)
        && ["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(entry.schema)
        && entry.measurement.evaluatorId === evaluatorId
        && (!evaluatorRoot || entry.measurement.evaluatorRootDigest === evaluatorRoot.principalDigest));
      if (!pairedBefore) throw new Error("after measurement requires the same evaluator as a frozen before measurement");
      if (pairedBefore.measurement.kind !== kind || pairedBefore.coverage.caseCount !== normalizedCoverage.caseCount) {
        throw new Error("after measurement must match the frozen evaluator's measurement kind and case count");
      }
    }
    if (state.measurementLineage.some((entry) => entry.measurementReceiptId === id)) {
      throw new Error("measurement receipt IDs are retained as immutable replay tombstones");
    }
    if (state.measurementLineage.some((entry) => entry.sourceDigest === sourceDigest)) {
      throw new Error("measurement source provenance cannot be reused across evaluation contracts");
    }
    if (state.measurementLineage.some((entry) => entry.runDigest === lineage.runDigest)) {
      throw new Error("measurement evaluator run cannot be replayed");
    }
    if (lineage.schema === "agentspine.learning-measurement-lineage/v2"
      && state.measurementLineage.some((entry) => entry.schema === "agentspine.learning-measurement-lineage/v2"
        && entry.rootRunDigest === lineage.rootRunDigest)) {
      throw new Error("measurement evaluator-root run cannot be replayed through an alias ID");
    }
    state.measurements.push(receipt);
    state.measurements.sort((a, b) => a.id.localeCompare(b.id));
    state.measurementLineage.push(lineage);
    state.measurementLineage.sort((a, b) => a.measurementReceiptId.localeCompare(b.measurementReceiptId));
    return { receipt, lineage, learningPath, unchanged: false };
  });
}

function outcomePayload({ schema = "agentspine.learning-outcome/v1", id, learningId, phase, scope, metric, measurement,
  applicationId, deliveryId, evaluationId, coverage, measurementReceiptId, measurementReceiptDigest, measuredAt }) {
  return {
    schema,
    id,
    learningId,
    phase,
    scope,
    metric,
    measurement,
    ...(["agentspine.learning-outcome/v2", "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(schema) ? { applicationId } : {}),
    ...(["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(schema) ? { evaluationId } : {}),
    ...(["agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(schema) ? { deliveryId } : {}),
    ...(["agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(schema) ? { coverage } : {}),
    ...(["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(schema) ? { measurementReceiptId, measurementReceiptDigest } : {}),
    measuredAt,
    authority: "context-only"
  };
}

function normalizeOutcome(input, candidate, timestamp, application = null, delivery = null, evaluation = null,
  measurementReceipt = null) {
  const id = input.id || `outcome:${randomUUID()}`;
  if (!ID_RE.test(id)) throw new Error("outcome.id must be a stable, whitespace-free identifier");
  const lineageRequired = ["agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation?.schema);
  if (lineageRequired && (!measurementReceipt || measurementReceipt.evaluationId !== evaluation.id
    || measurementReceipt.learningId !== candidate.id)) {
    throw new Error("outcomes require one matching immutable measurement receipt");
  }
  if (lineageRequired && input.phase !== undefined && input.phase !== measurementReceipt.phase) {
    throw new Error("outcome phase conflicts with its measurement receipt");
  }
  if (lineageRequired && input.scope !== undefined && !exactScope(normalizeScope(input.scope), measurementReceipt.scope)) {
    throw new Error("outcome scope conflicts with its measurement receipt");
  }
  if (lineageRequired && input.metric !== undefined && digest(input.metric) !== digest(measurementReceipt.metric)) {
    throw new Error("outcome metric conflicts with its measurement receipt");
  }
  if (lineageRequired && input.measurement !== undefined && digest(input.measurement) !== digest(measurementReceipt.measurement)) {
    throw new Error("outcome measurement conflicts with its measurement receipt");
  }
  if (lineageRequired && input.coverage !== undefined && input.coverage !== null
    && digest(input.coverage) !== digest(measurementReceipt.coverage)) {
    throw new Error("outcome coverage conflicts with its measurement receipt");
  }
  const phase = lineageRequired ? measurementReceipt.phase : input.phase;
  if (!OUTCOME_PHASES.has(phase)) throw new Error("outcome.phase must be before or after");
  const scope = lineageRequired ? measurementReceipt.scope : normalizeScope(input.scope);
  if (!scopeContains(candidate.scope, scope)) throw new Error("outcome scope does not match the learning candidate");
  if (!evaluation || evaluation.learningId !== candidate.id || !exactScope(evaluation.scope, scope)) {
    throw new Error("outcomes require a matching immutable evaluation contract");
  }
  const name = lineageRequired ? measurementReceipt.metric.name : safeText(input.metric?.name, "outcome.metric.name", 120);
  const direction = lineageRequired ? measurementReceipt.metric.direction : input.metric?.direction;
  if (!METRIC_DIRECTIONS.has(direction)) throw new Error("outcome.metric.direction must be higher or lower");
  if (name !== evaluation.metric.name || direction !== evaluation.metric.direction) {
    throw new Error("outcome metric does not match the evaluation contract");
  }
  const metric = lineageRequired ? measurementReceipt.metric : {
    name,
    direction,
    value: number(input.metric?.value, "outcome.metric.value", 0, 1),
    blockingDefects: integer(input.metric?.blockingDefects ?? 0, "outcome.metric.blockingDefects", 0, 1000)
  };
  const kind = lineageRequired ? measurementReceipt.measurement.kind : input.measurement?.kind;
  if (!MEASUREMENT_KINDS.has(kind)) throw new Error("outcome.measurement.kind is unsupported");
  const evaluatorId = lineageRequired ? measurementReceipt.measurement.evaluatorId : input.measurement?.evaluatorId;
  if (!ID_RE.test(evaluatorId || "")) throw new Error("outcome.measurement.evaluatorId is required");
  if (!evaluation.evaluatorIds.includes(evaluatorId)) throw new Error("outcome evaluator is not allowed by the evaluation contract");
  const evaluatorRoot = ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema)
    ? evaluation.evaluatorRoots.find((root) => root.evaluatorId === evaluatorId) : null;
  if (["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema)
    && (measurementReceipt.schema !== "agentspine.learning-measurement/v2"
      || evaluatorRoot?.principalDigest !== measurementReceipt.measurement.evaluatorRootDigest)) {
    throw new Error("outcome evaluator root does not match the frozen evaluation contract");
  }
  const sourceDigest = lineageRequired ? measurementReceipt.measurement.sourceDigest : input.measurement?.sourceDigest ?? null;
  if (sourceDigest !== null && !/^[a-f0-9]{64}$/.test(sourceDigest)) {
    throw new Error("outcome.measurement.sourceDigest must be a SHA-256 digest");
  }
  const measurement = lineageRequired ? measurementReceipt.measurement : { kind, evaluatorId, sourceDigest, authority: "context-only" };
  const provenanceRequired = evaluation.schema === "agentspine.learning-evaluation/v3";
  if (provenanceRequired && !DIGEST_RE.test(sourceDigest || "")) {
    throw new Error("outcome.measurement.sourceDigest is required by the evaluation contract");
  }
  const coverageRequired = ["agentspine.learning-evaluation/v2", "agentspine.learning-evaluation/v3", "agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema);
  const coverage = lineageRequired ? measurementReceipt.coverage : coverageRequired ? {
    datasetDigest: input.coverage?.datasetDigest,
    caseCount: integer(input.coverage?.caseCount, "outcome.coverage.caseCount", 1, 1000000),
    authority: "context-only"
  } : null;
  if (coverageRequired && coverage.datasetDigest !== evaluation.benchmark.datasetDigest) {
    throw new Error("outcome coverage dataset does not match the evaluation contract");
  }
  if (coverageRequired && coverage.caseCount < evaluation.benchmark.minCases) {
    throw new Error(`outcome coverage requires at least ${evaluation.benchmark.minCases} cases`);
  }
  const measuredAt = lineageRequired ? measurementReceipt.measuredAt : date(input.measuredAt || timestamp, "outcome.measuredAt");
  if (new Date(measuredAt).getTime() < new Date(evaluation.registeredAt).getTime()
    || new Date(measuredAt).getTime() > new Date(evaluation.expiresAt).getTime()) {
    throw new Error("outcome is outside its evaluation contract window");
  }
  const applicationId = phase === "after" ? input.applicationId : null;
  const deliveryId = phase === "after" ? input.deliveryId : null;
  if (phase === "after") {
    if (!ID_RE.test(applicationId || "") || !application) throw new Error("after outcomes require a recorded learning application receipt");
    if (application.learningId !== candidate.id || !exactScope(application.scope, scope)) {
      throw new Error("learning application scope does not match the after outcome");
    }
    if (new Date(measuredAt).getTime() < new Date(application.projectedAt).getTime()
      || new Date(measuredAt).getTime() > new Date(application.expiresAt).getTime()) {
      throw new Error("after outcome is outside its learning application window");
    }
    if (!ID_RE.test(deliveryId || "") || !delivery || delivery.applicationId !== application.id
      || delivery.learningId !== candidate.id || !exactScope(delivery.scope, scope)) {
      throw new Error("after outcomes require the matching completed model-turn delivery receipt");
    }
    if (new Date(measuredAt).getTime() < new Date(delivery.completedAt).getTime()) {
      throw new Error("after outcome predates the completed model-turn delivery");
    }
  }
  const payload = outcomePayload({ schema: ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation.schema)
    ? "agentspine.learning-outcome/v9" : evaluation.schema === "agentspine.learning-evaluation/v5"
    ? "agentspine.learning-outcome/v8" : lineageRequired ? "agentspine.learning-outcome/v7"
    : provenanceRequired ? "agentspine.learning-outcome/v6"
    : coverageRequired ? "agentspine.learning-outcome/v5" : "agentspine.learning-outcome/v4",
    id, learningId: candidate.id, phase, scope, metric, measurement, applicationId, deliveryId,
    evaluationId: evaluation.id, coverage,
    measurementReceiptId: lineageRequired ? measurementReceipt.id : undefined,
    measurementReceiptDigest: lineageRequired ? measurementReceipt.digest : undefined,
    measuredAt });
  return { ...payload, digest: digest(payload) };
}

export async function recordLearningApplications({
  root = process.cwd(), items, scope, preflightReceipt, sessionBriefingDigest, projectedAt = new Date()
}) {
  if (!Array.isArray(items)) throw new Error("learning application items must be an array");
  if (!preflightReceipt || preflightReceipt.schema !== "agentspine.preflight/v2"
    || preflightReceipt.status !== "ready" || !ID_RE.test(preflightReceipt.id || "")
    || !/^[a-f0-9]{64}$/.test(preflightReceipt.promptDigest || "")
    || !/^[a-f0-9]{64}$/.test(preflightReceipt.briefingDigest || "")
    || !ID_RE.test(preflightReceipt.sessionId || "")
    || !/^[a-f0-9]{64}$/.test(sessionBriefingDigest || "")) {
    throw new Error("learning applications require one valid consumed preflight binding");
  }
  const runtimeScope = normalizeScope(scope);
  const timestamp = date(projectedAt, "projectedAt");
  const preflightCreated = new Date(preflightReceipt.createdAt).getTime();
  const preflightExpires = new Date(preflightReceipt.expiresAt).getTime();
  if (!Number.isFinite(preflightCreated) || !Number.isFinite(preflightExpires)
    || preflightCreated > new Date(timestamp).getTime() || preflightExpires < new Date(timestamp).getTime()) {
    throw new Error("learning application preflight binding is stale");
  }
  if (preflightReceipt.agentId !== runtimeScope.personaId || preflightReceipt.userId !== runtimeScope.userId
    || preflightReceipt.tenantId !== runtimeScope.tenantId || preflightReceipt.projectId !== runtimeScope.projectId
    || preflightReceipt.groupId !== runtimeScope.groupId || preflightReceipt.taskId !== runtimeScope.taskId) {
    throw new Error("learning application preflight scope does not match the projected turn");
  }
  return mutation(root, (state, _catalog, learningPath) => {
    const pending = state.applications.filter((application) => application.schema === "agentspine.learning-application/v2"
      && application.sessionId === preflightReceipt.sessionId
      && application.preflightReceiptId !== preflightReceipt.id
      && new Date(application.deliveryExpiresAt).getTime() >= new Date(timestamp).getTime()
      && !state.deliveries.some((delivery) => delivery.applicationId === application.id));
    if (pending.length) {
      throw new Error("this session already has an unconfirmed learning application; await Stop or its bounded expiry");
    }
    const receipts = [];
    for (const item of items.filter((entry) => ["active", "revalidating"].includes(entry?.outcomeStatus))) {
      const candidate = state.candidates.find((entry) => entry.id === item.id);
      const canary = candidate?.promotion?.canary;
      const revalidating = item.outcomeStatus === "revalidating";
      if (!candidate || candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
        || (revalidating ? canary?.status !== "validated" || canary.revalidation?.status !== "active"
          || new Date(canary.revalidation.expiresAt).getTime() < new Date(timestamp).getTime()
          : canary?.status !== "active")
        || !exactScope(canary.scope, runtimeScope)) {
        throw new Error(`active learning application no longer matches its exact scope: ${item.id || "unknown"}`);
      }
      const expiresAt = revalidating ? canary.revalidation.expiresAt : canary.expiresAt;
      const deliveryExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
        new Date(timestamp).getTime() + 5 * 60_000)).toISOString();
      const material = `${candidate.id}\0${preflightReceipt.id}\0${sessionBriefingDigest}`;
      const id = `application:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
      const payload = applicationPayload({ schema: "agentspine.learning-application/v2", id, learningId: candidate.id, scope: runtimeScope,
        preflightReceiptId: preflightReceipt.id, promptDigest: preflightReceipt.promptDigest,
        preflightBriefingDigest: preflightReceipt.briefingDigest, sessionBriefingDigest,
        sessionId: preflightReceipt.sessionId, projectedAt: timestamp, deliveryExpiresAt, expiresAt });
      const receipt = { ...payload, digest: digest(payload) };
      const existing = state.applications.find((entry) => entry.id === id);
      if (existing) {
        const sameBinding = existing.learningId === receipt.learningId && exactScope(existing.scope, receipt.scope)
          && existing.preflightReceiptId === receipt.preflightReceiptId && existing.promptDigest === receipt.promptDigest
          && existing.preflightBriefingDigest === receipt.preflightBriefingDigest
          && existing.sessionBriefingDigest === receipt.sessionBriefingDigest;
        if (!sameBinding) throw new Error("learning application receipt IDs are immutable");
        receipts.push(existing);
        continue;
      }
      if (state.applications.some((entry) => entry.learningId === candidate.id
        && entry.preflightReceiptId === preflightReceipt.id)) {
        throw new Error("one preflight turn cannot produce conflicting learning application receipts");
      }
      state.applications.push(receipt);
      receipts.push(receipt);
    }
    state.applications.sort((a, b) => a.id.localeCompare(b.id));
    return { schema: "agentspine.learning-application-batch/v2", receipts, learningPath,
      authority: "context-only" };
  });
}

export async function recordLearningDeliveries({
  root = process.cwd(), sessionId, scope, hookEvent, completedAt = new Date()
}) {
  if (!ID_RE.test(sessionId || "")) throw new Error("learning delivery sessionId is required");
  if (!["Stop", "SubagentStop"].includes(hookEvent)) throw new Error("learning delivery requires Stop or SubagentStop");
  const runtimeScope = normalizeScope(scope);
  const timestamp = date(completedAt, "completedAt");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidates = state.applications.filter((application) => application.schema === "agentspine.learning-application/v2"
      && application.sessionId === sessionId && exactScope(application.scope, runtimeScope));
    if (!candidates.length) return { schema: "agentspine.learning-delivery-batch/v1", status: "not-applicable",
      receipts: [], learningPath, authority: "context-only" };
    const latest = [...candidates].sort((a, b) => b.projectedAt.localeCompare(a.projectedAt))[0];
    const batch = candidates.filter((application) => application.preflightReceiptId === latest.preflightReceiptId);
    if (new Date(timestamp).getTime() > new Date(latest.deliveryExpiresAt).getTime()) {
      return { schema: "agentspine.learning-delivery-batch/v1", status: "stale", receipts: [], learningPath,
        authority: "context-only" };
    }
    const receipts = [];
    for (const application of batch) {
      const existingForApplication = state.deliveries.find((entry) => entry.applicationId === application.id);
      if (existingForApplication) {
        if (existingForApplication.sessionId !== sessionId || existingForApplication.hookEvent !== hookEvent
          || !exactScope(existingForApplication.scope, runtimeScope)) {
          throw new Error("one learning application cannot have conflicting delivery receipts");
        }
        receipts.push(existingForApplication);
        continue;
      }
      const id = `delivery:${createHash("sha256").update(`${application.id}\0${hookEvent}`).digest("hex").slice(0, 32)}`;
      const payload = deliveryPayload({ id, applicationId: application.id, learningId: application.learningId,
        scope: runtimeScope, sessionId, preflightReceiptId: application.preflightReceiptId, hookEvent,
        completedAt: timestamp });
      const receipt = { ...payload, digest: digest(payload) };
      if (state.deliveries.some((entry) => entry.id === id)) throw new Error("learning delivery receipt IDs are immutable");
      state.deliveries.push(receipt);
      receipts.push(receipt);
    }
    state.deliveries.sort((a, b) => a.id.localeCompare(b.id));
    return { schema: "agentspine.learning-delivery-batch/v1", status: receipts.length ? "completed" : "not-applicable",
      receipts, learningPath, authority: "context-only" };
  });
}

function outcomeFresh(receipt, config, now) {
  return new Date(receipt.measuredAt).getTime() >= new Date(now).getTime() - config.outcomeMaxAgeDays * 86400000;
}

function outcomeMatchesContract(receipt, contract) {
  if (["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)) {
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

function promotableReceipts(state, candidate, timestamp) {
  const contracts = state.evaluations.filter((contract) => contract.learningId === candidate.id
    && new Date(contract.expiresAt).getTime() >= new Date(timestamp).getTime()
    && (contract.schema !== "agentspine.learning-evaluation/v7" || activeEvaluationBinding(state, contract)));
  const groups = contracts.map((contract) => ({
    contract,
    receipts: state.outcomes.filter((item) => outcomeMatchesContract(item, contract)
      && item.learningId === candidate.id && item.evaluationId === contract.id && item.phase === "before"
      && exactScope(item.scope, contract.scope) && outcomeFresh(item, state.config, timestamp)
      && item.measurement.kind !== "model-suggestion")
  })).filter(({ contract, receipts }) => receipts.some((item) => item.measurement.kind === "objective")
    && new Set(receipts.map((item) => ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
      ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId)).size >= contract.thresholds.beforeReceipts)
    .sort((a, b) => b.receipts.length - a.receipts.length || a.contract.id.localeCompare(b.contract.id));
  return groups[0] || null;
}

function improvement(direction, baseline, value) {
  return direction === "higher" ? value - baseline : baseline - value;
}

function rollbackCandidate(state, candidate, reason, timestamp, mode = "manual") {
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
    updatedAt: timestamp,
    rollback: { reason, mode, rolledBackAt: timestamp, authority: "context-only" },
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? rolledBack : entry);
  return { candidate: rolledBack, restored };
}

function reconcileCanary(state, candidate, timestamp) {
  const canary = candidate.promotion?.canary;
  if (candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
    || !["active", "validated"].includes(canary?.status)) {
    return { candidate, decision: "unchanged", restored: [] };
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
  if (evaluation?.schema === "agentspine.learning-evaluation/v7" && !activeEvaluationBinding(state, evaluation)) {
    const result = rollbackCandidate(state, candidate, "outcome evaluator registry binding was revoked or changed", timestamp, "automatic-evaluator-revocation");
    return { ...result, decision: "rolled-back" };
  }
  if (canary.status === "validated") {
    const validation = validationLeaseState(state, candidate, timestamp);
    if (evaluation?.schema === "agentspine.learning-evaluation/v7" && validation.status !== "active") {
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
    && item.metric.direction === canary.metric.direction && outcomeFresh(item, state.config, timestamp)
    && state.applications.some((application) => application.id === item.applicationId
      && application.learningId === candidate.id && exactScope(application.scope, canary.scope)));
  if (receipts.some((item) => item.metric.blockingDefects > 0)) {
    const result = rollbackCandidate(state, candidate, "outcome canary recorded a blocking defect", timestamp, "automatic-regression");
    return { ...result, decision: "rolled-back" };
  }
  const paired = ["agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation?.schema);
  const rootBound = ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation?.schema);
  const beforeByEvaluator = paired ? new Map((canary.beforeReceipts || [])
    .map((id) => state.outcomes.find((item) => item.id === id))
    .filter((item) => item?.schema === (rootBound ? "agentspine.learning-outcome/v9" : "agentspine.learning-outcome/v8"))
    .map((item) => [rootBound ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId, item])) : new Map();
  const eligible = receipts.filter((item) => item.measurement.kind !== "model-suggestion"
    && (!paired || beforeByEvaluator.has(rootBound ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId)));
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
  if (evaluation?.schema === "agentspine.learning-evaluation/v7") {
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

export async function recordLearningOutcome({ root = process.cwd(), id, learningId, phase, scope, metric, measurement,
  applicationId = null, deliveryId = null, evaluationId, measurementReceiptId = null,
  coverage = null, measuredAt, now = new Date() }) {
  if (!ID_RE.test(learningId || "")) throw new Error("learningId is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (!candidate) throw new Error(`unknown learning candidate: ${learningId}`);
    if (!ID_RE.test(evaluationId || "")) throw new Error("evaluationId is required");
    const evaluation = state.evaluations.find((item) => item.id === evaluationId);
    if (evaluation?.schema === "agentspine.learning-evaluation/v7" && !activeEvaluationBinding(state, evaluation)) {
      throw new Error("outcome evaluator registry binding is missing, changed, or revoked");
    }
    const measurementReceipt = measurementReceiptId === null ? null
      : state.measurements.find((item) => item.id === measurementReceiptId);
    const effectivePhase = ["agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(evaluation?.schema)
      ? measurementReceipt?.phase : phase;
    const application = applicationId === null ? null : state.applications.find((item) => item.id === applicationId);
    const delivery = deliveryId === null ? null : state.deliveries.find((item) => item.id === deliveryId);
    const existing = id ? state.outcomes.find((item) => item.id === id) : null;
    if (existing) {
      const retry = normalizeOutcome({ id, phase, scope, metric, measurement, applicationId, deliveryId, evaluationId, coverage,
        measuredAt: measuredAt ?? existing.measuredAt }, candidate, timestamp, application, delivery, evaluation, measurementReceipt);
      if (existing.digest === retry.digest) {
        return { receipt: existing, candidate, decision: "unchanged", learningPath, unchanged: true };
      }
      throw new Error("outcome receipt IDs are immutable");
    }
    if (effectivePhase === "before" && candidate.status !== "candidate") throw new Error("before outcomes require an unreviewed candidate");
    if (effectivePhase === "after" && (candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
      || candidate.promotion?.canary?.status !== "active")) {
      throw new Error("after outcomes require an active outcome canary");
    }
    const receipt = normalizeOutcome({ id, phase, scope, metric, measurement, applicationId, deliveryId, evaluationId, coverage,
      measuredAt }, candidate, timestamp, application, delivery, evaluation, measurementReceipt);
    const duplicate = state.outcomes.find((item) => item.digest === receipt.digest);
    if (duplicate) return { receipt: duplicate, candidate, decision: "unchanged", learningPath, unchanged: true };
    if (receipt.schema === "agentspine.learning-outcome/v6" && state.outcomes.some((item) =>
      item.schema === "agentspine.learning-outcome/v6" && item.evaluationId === receipt.evaluationId
      && item.measurement.sourceDigest === receipt.measurement.sourceDigest)) {
      throw new Error("outcome measurement provenance cannot be replayed within one evaluation contract");
    }
    if (["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
      && state.outcomes.some((item) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
        && item.measurementReceiptId === receipt.measurementReceiptId)) {
      throw new Error("one measurement receipt cannot be consumed by multiple outcomes");
    }
    if (["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
      && state.outcomes.some((item) => item.schema === receipt.schema && item.evaluationId === receipt.evaluationId
      && item.phase === receipt.phase
      && (receipt.schema === "agentspine.learning-outcome/v9"
        ? item.measurement.evaluatorRootDigest === receipt.measurement.evaluatorRootDigest
        : item.measurement.evaluatorId === receipt.measurement.evaluatorId))) {
      throw new Error("paired evaluation accepts exactly one outcome per evaluator and phase");
    }
    if (["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema) && receipt.phase === "after"
      && state.outcomes.some((item) => item.schema === receipt.schema
        && item.phase === "after" && item.evaluationId === receipt.evaluationId
        && item.applicationId === receipt.applicationId)) {
      throw new Error("paired evaluation requires a distinct completed turn for each after outcome");
    }
    state.outcomes.push(receipt);
    state.outcomes.sort((a, b) => a.id.localeCompare(b.id));
    const reconciled = effectivePhase === "after" ? reconcileCanary(state, candidate, timestamp) : { candidate, decision: "recorded", restored: [] };
    return { receipt, ...reconciled, learningPath, unchanged: false };
  });
}

export async function evaluateLearning({ root = process.cwd(), now = new Date() } = {}) {
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const accepted = [];
    const reconciled = [];
    for (const current of state.candidates.filter((entry) => entry.status === "accepted" && entry.promotion?.mode === "outcome-canary")) {
      const result = reconcileCanary(state, current, timestamp);
      if (result.decision !== "unchanged" && result.decision !== "active") reconciled.push({ id: current.id, decision: result.decision });
    }
    if (state.config.autoPromote) {
      for (const candidate of state.candidates.filter((entry) => entry.status === "candidate")) {
        if (candidate.confidence < state.config.minConfidence) continue;
        if (distinctEvidence(candidate) < state.config.minEvidence) continue;
        if (candidate.conflictsWith?.some((id) => state.candidates.some((entry) => entry.id === id && ["candidate", "accepted"].includes(entry.status)))) continue;
        if (OUTCOME_AUTO_KINDS.has(candidate.kind)) {
          if (SCOPE_FIELDS.every((field) => candidate.scope?.[field] === null)) continue;
          if (candidate.requiresLocalReview) continue;
          const planned = promotableReceipts(state, candidate, timestamp);
          if (!planned) continue;
          const { contract, receipts } = planned;
          const baseline = receipts.reduce((sum, item) => sum + item.metric.value, 0) / receipts.length;
          accepted.push(acceptCandidate(state, candidate, timestamp, true, {
            mode: "outcome-canary",
            minConfidence: state.config.minConfidence,
            minEvidence: state.config.minEvidence,
            evidenceCount: distinctEvidence(candidate),
            evaluatedAt: timestamp,
            canary: {
              status: "active",
              scope: receipts[0].scope,
              metric: { name: receipts[0].metric.name, direction: receipts[0].metric.direction },
              evaluationId: contract.id,
              evaluationDigest: contract.digest,
              pairing: ["agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema) ? contract.pairing : null,
              evaluatorRootDigest: ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
                ? digest(contract.evaluatorRoots) : null,
              evaluatorRegistryBindingDigest: contract.schema === "agentspine.learning-evaluation/v7"
                ? state.evaluationBindings.find((binding) => binding.evaluationId === contract.id)?.digest : null,
              coverage: ["agentspine.learning-evaluation/v2", "agentspine.learning-evaluation/v3", "agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema) ? {
                datasetDigest: contract.benchmark.datasetDigest,
                minCases: contract.benchmark.minCases,
                authority: "context-only"
              } : null,
              baseline,
              beforeReceipts: receipts.map((item) => item.id),
              expiresAt: new Date(Math.min(new Date(contract.expiresAt).getTime(),
                new Date(timestamp).getTime() + state.config.canaryTtlDays * 86400000)).toISOString()
            },
            authority: "context-only"
          }));
          continue;
        }
        if (AUTO_KINDS.has(candidate.kind)) {
          accepted.push(acceptCandidate(state, candidate, timestamp, true, {
            mode: "automatic-low-risk",
            minConfidence: state.config.minConfidence,
            minEvidence: state.config.minEvidence,
            evidenceCount: distinctEvidence(candidate),
            evaluatedAt: timestamp,
            authority: "context-only"
          }));
        }
      }
    }
    return { enabled: state.config.autoPromote, accepted, reconciled, learningPath, authority: "context-only" };
  });
}

export async function purgeStaleLearningApplications({ root = process.cwd(), confirmation, now = new Date() } = {}) {
  if (confirmation !== "local-user-purge-confirmed") {
    throw new Error("purging stale learning applications requires explicit local confirmation");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const ids = new Set(state.applications.filter((application) => application.schema === "agentspine.learning-application/v2"
      && new Date(application.deliveryExpiresAt).getTime() < new Date(timestamp).getTime()
      && !state.deliveries.some((delivery) => delivery.applicationId === application.id)).map((application) => application.id));
    state.applications = state.applications.filter((application) => !ids.has(application.id));
    return { schema: "agentspine.learning-delivery-purge/v1", purged: ids.size, applicationIds: [...ids].sort(),
      learningPath, authority: "context-only" };
  });
}

export async function purgeStaleLearningMeasurements({ root = process.cwd(), confirmation, now = new Date() } = {}) {
  if (confirmation !== "local-user-purge-confirmed") {
    throw new Error("purging stale learning measurements requires explicit local confirmation");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const consumed = new Set(state.outcomes.filter((outcome) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(outcome.schema))
      .map((outcome) => outcome.measurementReceiptId));
    const validationHistory = state.history.filter((entry) => entry.kind === "learning-validation")
      .map((entry) => entry.value);
    for (const lease of [...state.validationLeases, ...validationHistory]
      .filter((entry) => entry?.schema === "agentspine.learning-validation/v2")) {
      for (const evidence of lease.renewalEvidence) consumed.add(evidence.measurementId);
    }
    const cutoff = new Date(timestamp).getTime() - state.config.outcomeMaxAgeDays * 86400000;
    const ids = new Set(state.measurements.filter((measurement) => !consumed.has(measurement.id)
      && (new Date(measurement.measuredAt).getTime() < cutoff
        || state.evaluations.some((contract) => contract.id === measurement.evaluationId
          && new Date(contract.expiresAt).getTime() < new Date(timestamp).getTime())))
      .map((measurement) => measurement.id));
    state.measurements = state.measurements.filter((measurement) => !ids.has(measurement.id));
    return { schema: "agentspine.learning-measurement-purge/v1", purged: ids.size,
      measurementReceiptIds: [...ids].sort(), learningPath, authority: "context-only" };
  });
}

/**
 * Internal runtime promotion path for locally opted-in continuity signals.
 * This is intentionally not exposed over MCP. The caller must provide the
 * directness, confidence, repetition and local opt-in proof recorded by the
 * continuity state machine.
 */
export async function acceptContinuityLearning({
  root = process.cwd(), id, proof, now = new Date(), catalog: providedCatalog = null
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  if (!proof || proof.mode !== "automatic-continuity-low-risk" || proof.localOptIn !== true) {
    throw new Error("continuity promotion requires a recorded local opt-in proof");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`unknown learning candidate: ${id}`);
    if (candidate.status === "accepted") return { candidate, learningPath, unchanged: true };
    if (candidate.status !== "candidate") throw new Error("only an active candidate can be promoted");
    if (!CONTINUITY_AUTO_KINDS.has(candidate.kind)) throw new Error("learning kind is not eligible for continuity promotion");
    const minConfidence = number(proof.minConfidence, "proof.minConfidence", 0.9, 1);
    const minEvidence = integer(proof.minEvidence, "proof.minEvidence", 1, 10);
    const minDirectness = number(proof.minDirectness, "proof.minDirectness", 0.9, 1);
    const directness = number(proof.directness, "proof.directness", 0, 1);
    const evidenceCount = distinctEvidence(candidate);
    if (candidate.confidence < minConfidence || directness < minDirectness || evidenceCount < minEvidence) {
      throw new Error("continuity candidate does not meet the recorded promotion thresholds");
    }
    const accepted = acceptCandidate(state, candidate, timestamp, true, {
      mode: "automatic-continuity-low-risk",
      localOptIn: true,
      minConfidence,
      minEvidence,
      minDirectness,
      directness,
      evidenceCount,
      evaluatedAt: timestamp,
      authority: "context-only"
    });
    return { candidate: accepted, learningPath, unchanged: false };
  }, providedCatalog);
}

export async function rollbackLearning({ root = process.cwd(), id, reason, now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  const rollbackReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate || candidate.status !== "accepted") throw new Error("only an accepted learning can be rolled back");
    const result = rollbackCandidate(state, candidate, rollbackReason, timestamp, "manual");
    return { ...result, learningPath };
  });
}

function groupEntities(graph, groupId, includePrivate) {
  const result = new Set();
  if (!groupId) return result;
  result.add(groupId);
  for (const edge of graph.entityEdges) {
    if (edge.relation !== "member-of" || (!includePrivate && edge.privacy === "private")) continue;
    if (edge.to === groupId) result.add(edge.from);
    if (edge.from === groupId) result.add(edge.to);
  }
  return result;
}

function visible(candidate, entities, audience, includePrivate, groupId) {
  if (candidate.privacy === "private" && !includePrivate) return false;
  if (candidate.privacy === "group" && (!groupId || candidate.groupId !== groupId)) return false;
  if (candidate.privacy === "group" && candidate.subjectId && !audience.has(candidate.subjectId)) return false;
  const subject = candidate.subjectId ? entities.get(candidate.subjectId) : null;
  if (subject?.privacy === "private" && !includePrivate) return false;
  if (subject?.privacy === "group" && !audience.has(subject.id)) return false;
  return true;
}

export async function learningContext({
  root = process.cwd(), includePrivate = false, groupId = null, kinds = null,
  subjectIds = null, scope = null, maxItems = null, catalog: providedCatalog = null, now = new Date()
} = {}) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { learning } = await loadLearning(catalog.root, catalog);
  if (!validConfig(learning.config)) throw new Error("learning configuration is invalid; run the audit before using learned context");
  const { graph } = await loadGraph(catalog.root, catalog);
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  if (groupId !== null) {
    const group = entities.get(groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
  }
  const audience = groupEntities(graph, groupId, includePrivate);
  const runtimeScope = normalizeScope(scope, null, groupId);
  const kindFilter = kinds === null ? null : new Set(kinds);
  if (kindFilter && [...kindFilter].some((kind) => !KINDS.has(kind))) throw new Error("kinds contains an unsupported learning kind");
  const subjectFilter = subjectIds === null ? null : new Set(subjectIds);
  const limit = maxItems === null ? learning.config.maxContextItems : integer(maxItems, "maxItems", 0, 50);
  const timestamp = date(now, "now");
  const invalidCanaries = new Map(learning.candidates.map((candidate) => [candidate.id,
    canaryValidity(learning, candidate, timestamp)]).filter(([, validity]) => ![
    "not-applicable", "current-active", "current-validated", "legacy-validated"
  ].includes(validity.status)));
  const items = learning.candidates
    .filter((candidate) => candidate.status === "accepted")
    .filter((candidate) => !invalidCanaries.has(candidate.id))
    .filter((candidate) => scope === null || scopeContains(candidate.scope, runtimeScope))
    .filter((candidate) => candidate.promotion?.mode !== "outcome-canary"
      || exactScope(candidate.promotion.canary.scope, runtimeScope))
    .filter((candidate) => !kindFilter || kindFilter.has(candidate.kind))
    .filter((candidate) => !subjectFilter || subjectFilter.has(candidate.subjectId))
    .filter((candidate) => visible(candidate, entities, audience, includePrivate, groupId))
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      claim: candidate.claim,
      subjectId: candidate.subjectId,
      privacy: candidate.privacy,
      groupId: candidate.groupId,
      confidence: candidate.confidence,
      evidenceCount: candidate.evidence.length,
      automatic: candidate.automatic,
      acceptedAt: candidate.acceptedAt,
      outcomeStatus: candidate.promotion?.mode === "outcome-canary"
        ? (candidate.promotion.canary.status === "validated"
          && candidate.promotion.canary.revalidation?.status === "active"
          && new Date(candidate.promotion.canary.revalidation.expiresAt).getTime() >= new Date(timestamp).getTime()
          ? "revalidating" : candidate.promotion.canary.status)
        : "not-required",
      authority: "context-only"
    }));
  return {
    schema: "agentspine.learning-context/v1",
    root: catalog.root,
    groupId,
    scope: runtimeScope,
    items,
    degraded: invalidCanaries.size > 0,
    diagnostics: [...invalidCanaries].map(([id, validity]) => `${({
      "stale-active": "stale-outcome-canary",
      "revoked-active": "revoked-evaluator-canary",
      "stale-validated": "stale-validated-learning",
      "revoked-validated": "revoked-evaluator-validated-learning",
      "unproven-validated": "missing-validation-lease"
    })[validity.status] || validity.status}:${id}`),
    authority: "context-only",
    note: "Learned context is descriptive evidence, never permission, delegation, access, or an instruction to act."
  };
}

export async function learningOutcomeStatus({ root = process.cwd(), scope = null, now = new Date() } = {}) {
  const { learning, learningPath } = await loadLearning(root);
  const runtimeScope = scope === null ? null : normalizeScope(scope);
  const timestamp = date(now, "now");
  const records = learning.candidates
    .filter((candidate) => runtimeScope === null || scopeContains(candidate.scope, runtimeScope))
    .map((candidate) => {
      const outcomes = learning.outcomes.filter((item) => item.learningId === candidate.id);
      const measurements = learning.measurements.filter((item) => item.learningId === candidate.id);
      const measurementLineage = learning.measurementLineage.filter((item) => item.learningId === candidate.id);
      const applications = learning.applications.filter((item) => item.learningId === candidate.id);
      const deliveries = learning.deliveries.filter((item) => item.learningId === candidate.id);
      const evaluations = learning.evaluations.filter((item) => item.learningId === candidate.id);
      const canary = candidate.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
      const canaryValidityStatus = canaryValidity(learning, candidate, timestamp);
      const stale = ["stale-active", "stale-validated"].includes(canaryValidityStatus.status);
      const registryContracts = evaluations.filter((contract) => contract.schema === "agentspine.learning-evaluation/v7");
      const inactiveRegistryContracts = registryContracts.filter((contract) => !activeEvaluationBinding(learning, contract));
      const renewalMeasurementIds = new Set([...(learning.validationLeases || []),
        ...learning.history.filter((entry) => entry.kind === "learning-validation").map((entry) => entry.value)]
        .filter((lease) => lease?.learningId === candidate.id && lease.schema === "agentspine.learning-validation/v2")
        .flatMap((lease) => lease.renewalEvidence.map((entry) => entry.measurementId)));
      return {
        id: candidate.id,
        kind: candidate.kind,
        status: candidate.status,
        conflictsWith: candidate.conflictsWith || [],
        beforeReceipts: outcomes.filter((item) => item.phase === "before").length,
        afterReceipts: outcomes.filter((item) => item.phase === "after").length,
        boundAfterReceipts: outcomes.filter((item) => item.phase === "after" && item.applicationId
          && applications.some((application) => application.id === item.applicationId)).length,
        deliveredAfterReceipts: outcomes.filter((item) => item.phase === "after" && item.deliveryId
          && deliveries.some((delivery) => delivery.id === item.deliveryId)).length,
        measurementReceipts: measurements.length,
        measurementLineageReceipts: measurementLineage.length,
        consumedMeasurementReceipts: measurements.filter((item) => renewalMeasurementIds.has(item.id)
          || outcomes.some((outcome) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(outcome.schema)
            && outcome.measurementReceiptId === item.id)).length,
        staleUnconsumedMeasurements: measurements.filter((item) => new Date(item.measuredAt).getTime() < new Date(timestamp).getTime()
          - learning.config.outcomeMaxAgeDays * 86400000
          && !renewalMeasurementIds.has(item.id)
          && !outcomes.some((outcome) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(outcome.schema)
            && outcome.measurementReceiptId === item.id)).length,
        plannedOutcomeReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
          && evaluations.some((contract) => contract.id === item.evaluationId)).length,
        coverageBoundReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
          && evaluations.some((contract) => contract.id === item.evaluationId
            && ["agentspine.learning-evaluation/v2", "agentspine.learning-evaluation/v3", "agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
            && item.coverage?.datasetDigest === contract.benchmark.datasetDigest
            && item.coverage?.caseCount >= contract.benchmark.minCases)).length,
        provenanceBoundReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
          && DIGEST_RE.test(item.measurement?.sourceDigest || "")
          && evaluations.some((contract) => contract.id === item.evaluationId
            && ((item.schema === "agentspine.learning-outcome/v6" && contract.schema === "agentspine.learning-evaluation/v3")
              || (item.schema === "agentspine.learning-outcome/v7" && contract.schema === "agentspine.learning-evaluation/v4")
              || (item.schema === "agentspine.learning-outcome/v8" && contract.schema === "agentspine.learning-evaluation/v5")
              || (item.schema === "agentspine.learning-outcome/v9" && ["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema))))).length,
        lineageBoundReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
          && measurements.some((measurement) => measurement.id === item.measurementReceiptId
            && measurement.digest === item.measurementReceiptDigest)).length,
        pairedOutcomeReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)).length,
        pairedEvaluatorPairs: new Set(outcomes.filter((item) => ["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
          && item.phase === "after" && outcomes.some((before) => before.schema === item.schema
            && before.phase === "before" && before.evaluationId === item.evaluationId
            && (item.schema === "agentspine.learning-outcome/v9"
              ? before.measurement.evaluatorRootDigest === item.measurement.evaluatorRootDigest
              : before.measurement.evaluatorId === item.measurement.evaluatorId)))
          .map((item) => `${item.evaluationId}\0${item.schema === "agentspine.learning-outcome/v9"
            ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId}`)).size,
        evaluatorRootBoundReceipts: outcomes.filter((item) => item.schema === "agentspine.learning-outcome/v9").length,
        independentEvaluatorRoots: new Set(outcomes.filter((item) => item.schema === "agentspine.learning-outcome/v9")
          .map((item) => item.measurement.evaluatorRootDigest)).size,
        legacyCoverageReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v1", "agentspine.learning-outcome/v2",
          "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4"].includes(item.schema)).length,
        legacyProvenanceReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v1", "agentspine.learning-outcome/v2",
          "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6",
          "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8"].includes(item.schema)).length,
        evaluationContracts: evaluations.length,
        evaluatorRegistryContracts: registryContracts.length,
        inactiveEvaluatorRegistryContracts: inactiveRegistryContracts.length,
        activeEvaluationId: canary?.evaluationId || [...evaluations]
          .filter((contract) => new Date(contract.expiresAt).getTime() >= new Date(timestamp).getTime())
          .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))[0]?.id || null,
        applicationReceipts: applications.length,
        deliveryReceipts: deliveries.length,
        pendingApplications: applications.filter((application) => application.schema === "agentspine.learning-application/v2"
          && new Date(application.deliveryExpiresAt).getTime() >= new Date(timestamp).getTime()
          && !deliveries.some((delivery) => delivery.applicationId === application.id)).length,
        stalePendingApplications: applications.filter((application) => application.schema === "agentspine.learning-application/v2"
          && new Date(application.deliveryExpiresAt).getTime() < new Date(timestamp).getTime()
          && !deliveries.some((delivery) => delivery.applicationId === application.id)).length,
        latestApplicationId: [...applications].sort((a, b) => b.projectedAt.localeCompare(a.projectedAt))[0]?.id || null,
        canaryStatus: stale ? "stale" : (["revoked-active", "revoked-validated"].includes(canaryValidityStatus.status)
          ? "revoked" : (canaryValidityStatus.status === "unproven-validated" ? "unproven" : (canary?.status || "not-applicable"))),
        validationLeaseStatus: canaryValidityStatus.status,
        validationLeaseId: canary?.validationLeaseId || null,
        validationLeaseSchema: canaryValidityStatus.lease?.schema || null,
        revalidationStatus: canary?.revalidation?.status === "active"
          ? (new Date(canary.revalidation.expiresAt).getTime() < new Date(timestamp).getTime() ? "stale" : "active")
          : "not-applicable",
        revalidationExpiresAt: canary?.revalidation?.expiresAt || null,
        expiresAt: canary?.expiresAt || null,
        authority: "context-only"
      };
    });
  return {
    schema: "agentspine.learning-outcome-status/v1",
    root: learning.root,
    evaluatorRegistry: {
      active: learning.evaluatorRegistry.filter((record) => record.status === "active").length,
      revoked: learning.evaluatorRegistry.filter((record) => record.status === "revoked").length,
      bindings: learning.evaluationBindings.length,
      validationLeases: learning.validationLeases.length,
      authority: "context-only"
    },
    records,
    learningPath,
    authority: "context-only",
    note: "Outcome status is context-only and never grants permissions, delegation, access, or policy exceptions."
  };
}

export async function configureLearning({ root = process.cwd(), config = {}, now = new Date() }) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.keys(config).length) {
    throw new Error("config must change at least one learning setting");
  }
  const allowed = new Set([
    "autoPromote", "minConfidence", "minEvidence", "maxContextItems", "minOutcomeReceipts",
    "minImprovement", "regressionTolerance", "outcomeMaxAgeDays", "canaryReceipts", "canaryTtlDays"
  ]);
  const unknown = Object.keys(config).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unsupported learning config: ${unknown.join(", ")}`);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    preserve(state, "learning-config", { id: "config", ...state.config, privacy: "private" }, timestamp);
    if ("autoPromote" in config) {
      if (typeof config.autoPromote !== "boolean") throw new Error("autoPromote must be boolean");
      state.config.autoPromote = config.autoPromote;
    }
    if ("minConfidence" in config) state.config.minConfidence = number(config.minConfidence, "minConfidence", 0.5, 1);
    if ("minEvidence" in config) state.config.minEvidence = integer(config.minEvidence, "minEvidence", 1, 10);
    if ("maxContextItems" in config) state.config.maxContextItems = integer(config.maxContextItems, "maxContextItems", 1, 50);
    if ("minOutcomeReceipts" in config) state.config.minOutcomeReceipts = integer(config.minOutcomeReceipts, "minOutcomeReceipts", 2, 10);
    if ("minImprovement" in config) state.config.minImprovement = number(config.minImprovement, "minImprovement", 0, 1);
    if ("regressionTolerance" in config) state.config.regressionTolerance = number(config.regressionTolerance, "regressionTolerance", 0, 1);
    if ("outcomeMaxAgeDays" in config) state.config.outcomeMaxAgeDays = integer(config.outcomeMaxAgeDays, "outcomeMaxAgeDays", 1, 365);
    if ("canaryReceipts" in config) state.config.canaryReceipts = integer(config.canaryReceipts, "canaryReceipts", 1, 10);
    if ("canaryTtlDays" in config) state.config.canaryTtlDays = integer(config.canaryTtlDays, "canaryTtlDays", 1, 90);
    if (!validConfig(state.config)) throw new Error("resulting learning configuration is invalid");
    return { config: state.config, learningPath };
  });
}

export async function deleteLearning({ root = process.cwd(), id }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (candidate?.status === "accepted" && candidate.supersededIds?.length) {
      throw new Error("roll back an accepted superseding learning before permanent deletion");
    }
    const existed = Boolean(candidate);
    const evaluationIds = new Set(state.evaluations.filter((entry) => entry.learningId === id).map((entry) => entry.id));
    state.candidates = state.candidates.filter((entry) => entry.id !== id);
    state.outcomes = state.outcomes.filter((entry) => entry.learningId !== id);
    state.measurements = state.measurements.filter((entry) => entry.learningId !== id);
    state.applications = state.applications.filter((entry) => entry.learningId !== id);
    state.deliveries = state.deliveries.filter((entry) => entry.learningId !== id);
    state.validationLeases = state.validationLeases.filter((entry) => entry.learningId !== id);
    state.evaluations = state.evaluations.filter((entry) => entry.learningId !== id);
    state.evaluationBindings = state.evaluationBindings.filter((entry) => !evaluationIds.has(entry.evaluationId));
    state.history = state.history.filter((entry) => entry.recordId !== id && entry.value?.id !== id);
    return { deleted: existed, id, learningPath };
  });
}

export async function purgeLearningBySubject({ root = process.cwd(), subjectId }) {
  if (!ID_RE.test(subjectId || "")) throw new Error("subjectId is required");
  return mutation(root, (state, _catalog, learningPath) => {
    const ids = new Set(state.candidates.filter((entry) => entry.subjectId === subjectId).map((entry) => entry.id));
    const evaluationIds = new Set(state.evaluations.filter((entry) => ids.has(entry.learningId)).map((entry) => entry.id));
    state.candidates = state.candidates.filter((entry) => entry.subjectId !== subjectId);
    state.outcomes = state.outcomes.filter((entry) => !ids.has(entry.learningId));
    state.measurements = state.measurements.filter((entry) => !ids.has(entry.learningId));
    state.applications = state.applications.filter((entry) => !ids.has(entry.learningId));
    state.deliveries = state.deliveries.filter((entry) => !ids.has(entry.learningId));
    state.validationLeases = state.validationLeases.filter((entry) => !ids.has(entry.learningId));
    state.evaluations = state.evaluations.filter((entry) => !ids.has(entry.learningId));
    state.evaluationBindings = state.evaluationBindings.filter((entry) => !evaluationIds.has(entry.evaluationId));
    state.history = state.history.filter((entry) => entry.subjectId !== subjectId && !ids.has(entry.recordId) && !ids.has(entry.value?.id));
    return { deleted: ids.size, subjectId, learningPath };
  });
}

export function learningFindings(learning, graph) {
  const findings = [];
  if (!validConfig(learning.config)) findings.push("invalid-config");
  const groups = new Set(graph.entities.filter((entity) => entity.kind === "group").map((entity) => entity.id));
  for (const candidate of learning.candidates) {
    if (!KINDS.has(candidate.kind) || !STATUSES.has(candidate.status) || !PRIVACY.has(candidate.privacy)) findings.push(`invalid-candidate:${candidate.id}`);
    const nested = [...(candidate.evidence || []), candidate.review, candidate.rollback, candidate.promotion].filter(Boolean);
    if (candidate.authority !== "context-only" || nested.some((item) => item.authority !== "context-only")) findings.push(`authority:${candidate.id}`);
    if (SECRET_RE.test(candidate.claim || "") || AUTHORITY_ASSERTION_RE.test(candidate.claim || "")) findings.push(`unsafe-claim:${candidate.id}`);
    if (candidate.evidence?.some((item) => SECRET_RE.test(item.summary || ""))) findings.push(`unsafe-evidence:${candidate.id}`);
    const evidenceValid = candidate.evidence.length > 0 && candidate.evidence.every((item) => (
      ID_RE.test(item.id || "") && EVIDENCE_TYPES.has(item.type)
      && typeof item.summary === "string" && item.summary.length > 0
      && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
      && Number.isFinite(new Date(item.observedAt).getTime())
      && (item.type !== "document" || (item.sourceDocument && /^[a-f0-9]{64}$/.test(item.sourceSha256 || "")))
    ));
    if (!evidenceValid || !Number.isFinite(candidate.confidence)
      || Math.abs(candidate.confidence - evidenceConfidence(candidate.evidence)) > 1e-12) {
      findings.push(`invalid-evidence:${candidate.id}`);
    }
    if (candidate.privacy === "group" && (!groups.has(candidate.groupId) || !isGroupMember(graph, candidate.groupId, candidate.subjectId))) findings.push(`invalid-group:${candidate.id}`);
    if (!candidate.scope || Object.keys(candidate.scope).some((field) => !SCOPE_FIELDS.includes(field))
      || Object.values(candidate.scope || {}).some((value) => value !== null && !ID_RE.test(value))) findings.push(`invalid-scope:${candidate.id}`);
    if (candidate.status === "accepted") {
      const canaryEvaluation = candidate.promotion?.canary?.evaluationId
        ? (learning.evaluations || []).find((contract) => contract.id === candidate.promotion.canary.evaluationId)
        : null;
      const manualProof = candidate.automatic === false
        && candidate.review?.decision === "accept" && candidate.review?.confirmedByUser === true;
      const automaticProof = candidate.automatic === true
        && ((AUTO_KINDS.has(candidate.kind)
          && candidate.promotion?.mode === "automatic-low-risk"
          && candidate.confidence >= candidate.promotion?.minConfidence
          && distinctEvidence(candidate) >= candidate.promotion?.minEvidence
          && candidate.promotion?.evidenceCount >= candidate.promotion?.minEvidence)
        || (CONTINUITY_AUTO_KINDS.has(candidate.kind)
          && candidate.promotion?.mode === "automatic-continuity-low-risk"
          && candidate.promotion?.localOptIn === true
          && candidate.confidence >= candidate.promotion?.minConfidence
          && candidate.promotion?.directness >= candidate.promotion?.minDirectness
          && distinctEvidence(candidate) >= candidate.promotion?.minEvidence
          && candidate.promotion?.evidenceCount >= candidate.promotion?.minEvidence)
        || (OUTCOME_AUTO_KINDS.has(candidate.kind)
          && candidate.promotion?.mode === "outcome-canary"
          && candidate.requiresLocalReview === false
          && ["active", "validated"].includes(candidate.promotion?.canary?.status)
          && candidate.confidence >= candidate.promotion?.minConfidence
          && distinctEvidence(candidate) >= candidate.promotion?.minEvidence
          && candidate.promotion?.canary?.beforeReceipts?.length >= (canaryEvaluation?.thresholds.beforeReceipts
            ?? learning.config.minOutcomeReceipts)
          && (!candidate.promotion?.canary?.evaluationId
            || (canaryEvaluation && canaryEvaluation.digest === candidate.promotion.canary.evaluationDigest))));
      if (!candidate.acceptedAt || (!manualProof && !automaticProof)) findings.push(`invalid-acceptance:${candidate.id}`);
      if (candidate.promotion?.mode === "outcome-canary" && ["active", "validated"].includes(candidate.promotion?.canary?.status)
        && new Date(candidate.promotion.canary.expiresAt).getTime() <= Date.now()) findings.push(`stale-canary:${candidate.id}`);
      if (candidate.promotion?.mode === "outcome-canary" && ["active", "validated"].includes(candidate.promotion?.canary?.status)
        && canaryEvaluation?.schema === "agentspine.learning-evaluation/v7"
        && !activeEvaluationBinding(learning, canaryEvaluation)) findings.push(`inactive-evaluator-canary:${candidate.id}`);
      if (candidate.promotion?.mode === "outcome-canary" && candidate.promotion?.canary?.status === "validated"
        && canaryEvaluation?.schema === "agentspine.learning-evaluation/v7"
        && !(learning.validationLeases || []).some((lease) => lease.id === candidate.promotion.canary.validationLeaseId
          && lease.digest === candidate.promotion.canary.validationLeaseDigest
          && storedValidationLeaseStructure(lease) && validationLeaseMatchesState(learning, lease))) {
        findings.push(`missing-validation-lease:${candidate.id}`);
      }
      const revalidation = candidate.promotion?.canary?.revalidation;
      if (revalidation && (candidate.promotion?.canary?.status !== "validated"
        || revalidation.schema !== "agentspine.learning-revalidation-window/v1"
        || revalidation.status !== "active" || revalidation.authority !== "context-only"
        || !Number.isFinite(new Date(revalidation.startedAt).getTime())
        || !Number.isFinite(new Date(revalidation.expiresAt).getTime())
        || new Date(revalidation.expiresAt).getTime() <= new Date(revalidation.startedAt).getTime()
        || !ID_RE.test(revalidation.predecessorValidationId || "")
        || !DIGEST_RE.test(revalidation.predecessorValidationDigest || "")
        || !(learning.validationLeases || []).some((lease) => lease.id === revalidation.predecessorValidationId
          && lease.digest === revalidation.predecessorValidationDigest && lease.learningId === candidate.id))) {
        findings.push(`invalid-revalidation:${candidate.id}`);
      }
    }
  }
  const outcomeIds = new Set();
  for (const receipt of learning.outcomes || []) {
    const candidate = learning.candidates.find((item) => item.id === receipt.learningId);
    const valid = storedOutcomeStructure(receipt) && candidate && scopeContains(candidate.scope, receipt.scope);
    if (!valid || outcomeIds.has(receipt.id)) findings.push(`invalid-outcome:${receipt.id || "unknown"}`);
    outcomeIds.add(receipt.id);
  }
  const evaluationIds = new Set();
  for (const contract of learning.evaluations || []) {
    const candidate = learning.candidates.find((item) => item.id === contract.learningId);
    const valid = storedEvaluationStructure(contract) && candidate && scopeContains(candidate.scope, contract.scope);
    if (!valid || evaluationIds.has(contract.id)) findings.push(`invalid-evaluation:${contract.id || "unknown"}`);
    if (contract.schema === "agentspine.learning-evaluation/v7") {
      const binding = (learning.evaluationBindings || []).find((entry) => entry.evaluationId === contract.id);
      if (!binding || binding.evaluationDigest !== contract.digest) findings.push(`invalid-evaluator-binding:${contract.id}`);
    }
    evaluationIds.add(contract.id);
  }
  const validationLeaseIds = new Set();
  const validatedLearningIds = new Set();
  for (const lease of learning.validationLeases || []) {
    const valid = storedValidationLeaseStructure(lease) && validationLeaseMatchesState(learning, lease);
    if (!valid || validationLeaseIds.has(lease.id) || validatedLearningIds.has(lease.learningId)) {
      findings.push(`invalid-validation-lease:${lease.id || "unknown"}`);
    }
    validationLeaseIds.add(lease.id);
    validatedLearningIds.add(lease.learningId);
  }
  const measurementIds = new Set();
  const measurementSources = new Set();
  const measurementRuns = new Set();
  const evaluatorRootRuns = new Set();
  const measurementLineageIds = new Set();
  for (const lineage of learning.measurementLineage || []) {
    const valid = storedMeasurementLineageStructure(lineage);
    if (!valid || measurementLineageIds.has(lineage.measurementReceiptId)) {
      findings.push(`invalid-measurement-lineage:${lineage.measurementReceiptId || "unknown"}`);
    }
    if (measurementSources.has(lineage.sourceDigest) || measurementRuns.has(lineage.runDigest)
      || (lineage.schema === "agentspine.learning-measurement-lineage/v2" && evaluatorRootRuns.has(lineage.rootRunDigest))) {
      findings.push(`replayed-measurement-lineage:${lineage.measurementReceiptId || "unknown"}`);
    }
    measurementLineageIds.add(lineage.measurementReceiptId);
    measurementSources.add(lineage.sourceDigest);
    measurementRuns.add(lineage.runDigest);
    if (lineage.schema === "agentspine.learning-measurement-lineage/v2") evaluatorRootRuns.add(lineage.rootRunDigest);
  }
  for (const receipt of learning.measurements || []) {
    const candidate = learning.candidates.find((item) => item.id === receipt.learningId);
    const contract = (learning.evaluations || []).find((item) => item.id === receipt.evaluationId);
    const lineage = (learning.measurementLineage || []).find((item) => item.measurementReceiptId === receipt.id);
    const valid = storedMeasurementStructure(receipt) && candidate && contract
      && ["agentspine.learning-evaluation/v4", "agentspine.learning-evaluation/v5", "agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
      && contract.learningId === receipt.learningId
      && exactScope(contract.scope, receipt.scope) && scopeContains(candidate.scope, receipt.scope)
      && lineage?.sourceDigest === receipt.measurement?.sourceDigest
      && lineage?.runDigest === measurementRunDigest(receipt.measurement?.evaluatorId, receipt.measurement?.runId)
      && (receipt.schema !== "agentspine.learning-measurement/v2"
        || (["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema)
          && contract.evaluatorRoots.some((root) => root.evaluatorId === receipt.measurement?.evaluatorId
            && root.principalDigest === receipt.measurement?.evaluatorRootDigest)
          && lineage?.schema === "agentspine.learning-measurement-lineage/v2"
          && lineage?.evaluatorRootDigest === receipt.measurement?.evaluatorRootDigest
          && lineage?.rootRunDigest === evaluatorRootRunDigest(receipt.measurement?.evaluatorRootDigest, receipt.measurement?.runId)))
      && lineage?.registeredAt === receipt.measuredAt;
    if (!valid || measurementIds.has(receipt.id)) findings.push(`invalid-measurement:${receipt.id || "unknown"}`);
    measurementIds.add(receipt.id);
  }
  const applicationIds = new Set();
  for (const receipt of learning.applications || []) {
    const candidate = learning.candidates.find((item) => item.id === receipt.learningId);
    const valid = storedApplicationStructure(receipt) && candidate && scopeContains(candidate.scope, receipt.scope);
    if (!valid || applicationIds.has(receipt.id)) findings.push(`invalid-application:${receipt.id || "unknown"}`);
    if (receipt.schema === "agentspine.learning-application/v2"
      && new Date(receipt.deliveryExpiresAt).getTime() < Date.now()
      && !(learning.deliveries || []).some((delivery) => delivery.applicationId === receipt.id)) {
      findings.push(`stale-undelivered-application:${receipt.id}`);
    }
    applicationIds.add(receipt.id);
  }
  const deliveryIds = new Set();
  for (const receipt of learning.deliveries || []) {
    const candidate = learning.candidates.find((item) => item.id === receipt.learningId);
    const application = learning.applications.find((item) => item.id === receipt.applicationId);
    const valid = storedDeliveryStructure(receipt) && candidate && application
      && application.learningId === receipt.learningId && application.sessionId === receipt.sessionId
      && exactScope(application.scope, receipt.scope) && scopeContains(candidate.scope, receipt.scope);
    if (!valid || deliveryIds.has(receipt.id)) findings.push(`invalid-delivery:${receipt.id || "unknown"}`);
    deliveryIds.add(receipt.id);
  }
  for (const receipt of learning.outcomes || []) {
    if (["agentspine.learning-outcome/v2", "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema) && receipt.phase === "after"
      && !applicationIds.has(receipt.applicationId)) findings.push(`unbound-outcome:${receipt.id}`);
    if (["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema) && !evaluationIds.has(receipt.evaluationId)) {
      findings.push(`unplanned-outcome:${receipt.id}`);
    }
    if (["agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema) && receipt.phase === "after"
      && !deliveryIds.has(receipt.deliveryId)) findings.push(`undelivered-outcome:${receipt.id}`);
    if (["agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)) {
      const contract = (learning.evaluations || []).find((item) => item.id === receipt.evaluationId);
      if (!contract
        || (receipt.schema === "agentspine.learning-outcome/v5" && contract.schema !== "agentspine.learning-evaluation/v2")
        || (receipt.schema === "agentspine.learning-outcome/v6" && contract.schema !== "agentspine.learning-evaluation/v3")
        || (receipt.schema === "agentspine.learning-outcome/v7" && contract.schema !== "agentspine.learning-evaluation/v4")
        || (receipt.schema === "agentspine.learning-outcome/v8" && contract.schema !== "agentspine.learning-evaluation/v5")
        || (receipt.schema === "agentspine.learning-outcome/v9" && !["agentspine.learning-evaluation/v6", "agentspine.learning-evaluation/v7"].includes(contract.schema))
        || receipt.coverage?.datasetDigest !== contract.benchmark.datasetDigest
        || receipt.coverage?.caseCount < contract.benchmark.minCases) findings.push(`invalid-coverage:${receipt.id}`);
    }
    if (receipt.schema === "agentspine.learning-outcome/v6" && !DIGEST_RE.test(receipt.measurement?.sourceDigest || "")) {
      findings.push(`invalid-provenance:${receipt.id}`);
    }
    if (["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)) {
      const source = (learning.measurements || []).find((item) => item.id === receipt.measurementReceiptId);
      if (!source || source.digest !== receipt.measurementReceiptDigest) findings.push(`unbound-measurement:${receipt.id}`);
    }
  }
  const pairedOutcomeKeys = new Set();
  const pairedAfterApplications = new Set();
  for (const receipt of learning.outcomes || []) {
    if (!["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)) continue;
    const evaluatorKey = receipt.schema === "agentspine.learning-outcome/v9"
      ? receipt.measurement.evaluatorRootDigest : receipt.measurement.evaluatorId;
    const key = `${receipt.evaluationId}\0${receipt.phase}\0${evaluatorKey}`;
    if (pairedOutcomeKeys.has(key)) findings.push(`duplicate-paired-evaluator:${receipt.id}`);
    pairedOutcomeKeys.add(key);
    if (receipt.phase === "after") {
      const applicationKey = `${receipt.evaluationId}\0${receipt.applicationId}`;
      if (pairedAfterApplications.has(applicationKey)) findings.push(`duplicate-paired-turn:${receipt.id}`);
      pairedAfterApplications.add(applicationKey);
    }
  }
  for (const receipt of learning.outcomes || []) {
    if (!["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema) || receipt.phase !== "after") continue;
    const pairedBefore = learning.outcomes.some((before) => before.schema === receipt.schema
      && before.phase === "before" && before.learningId === receipt.learningId
      && before.evaluationId === receipt.evaluationId
      && before.measurement.evaluatorId === receipt.measurement.evaluatorId
      && (receipt.schema !== "agentspine.learning-outcome/v9"
        || before.measurement.evaluatorRootDigest === receipt.measurement.evaluatorRootDigest)
      && before.measurement.kind === receipt.measurement.kind
      && before.coverage.caseCount === receipt.coverage.caseCount
      && exactScope(before.scope, receipt.scope));
    if (!pairedBefore) findings.push(`unpaired-evaluator-outcome:${receipt.id}`);
  }
  const provenanceKeys = new Set();
  for (const receipt of learning.outcomes || []) {
    if (receipt.schema !== "agentspine.learning-outcome/v6") continue;
    const key = `${receipt.evaluationId}\0${receipt.measurement.sourceDigest}`;
    if (provenanceKeys.has(key)) findings.push(`replayed-provenance:${receipt.id}`);
    provenanceKeys.add(key);
  }
  for (const entry of learning.history) {
    const value = entry.value || {};
    const nested = [...(value.evidence || []), value.review, value.rollback, value.promotion].filter(Boolean);
    if (entry.authority !== "context-only" || value.authority !== "context-only" || nested.some((item) => item.authority !== "context-only")) {
      findings.push(`history-authority:${entry.recordId || "unknown"}`);
    }
    if (SECRET_RE.test(value.claim || "") || AUTHORITY_ASSERTION_RE.test(value.claim || "")
      || value.evidence?.some((item) => SECRET_RE.test(item.summary || ""))) {
      findings.push(`unsafe-history:${entry.recordId || "unknown"}`);
    }
  }
  return findings;
}
