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
const EVALUATION_SCHEMAS = new Set(Array.from({ length: 11 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 1}`));
const COVERAGE_EVALUATIONS = new Set(Array.from({ length: 10 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 2}`));
const LINEAGE_EVALUATIONS = new Set(Array.from({ length: 8 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 4}`));
const PAIRED_EVALUATIONS = new Set(Array.from({ length: 7 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 5}`));
const ROOT_BOUND_EVALUATIONS = new Set(Array.from({ length: 6 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 6}`));
const REGISTRY_BOUND_EVALUATIONS = new Set(Array.from({ length: 5 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 7}`));
const INITIAL_TRIAL_EVALUATIONS = new Set(["agentspine.learning-evaluation/v8", "agentspine.learning-evaluation/v9",
  "agentspine.learning-evaluation/v10", "agentspine.learning-evaluation/v11"]);
const TARGET_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v9", "agentspine.learning-evaluation/v10",
  "agentspine.learning-evaluation/v11"]);
const DEADLINE_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v10", "agentspine.learning-evaluation/v11"]);
const TRIAL_RETRY_EVALUATIONS = new Set(["agentspine.learning-evaluation/v11"]);
const DELIVERABLE_APPLICATIONS = new Set(Array.from({ length: 6 }, (_, index) =>
  `agentspine.learning-application/v${index + 2}`));
const INITIAL_TRIAL_APPLICATIONS = new Set(["agentspine.learning-application/v5", "agentspine.learning-application/v6",
  "agentspine.learning-application/v7"]);
const TARGET_BOUND_APPLICATIONS = new Set(["agentspine.learning-application/v6", "agentspine.learning-application/v7"]);
const DEADLINE_BOUND_APPLICATIONS = new Set(["agentspine.learning-application/v7"]);
const EVIDENCE_REVOCATION_REASONS = new Set(["retracted", "source-invalid", "measurement-invalid", "duplicate", "other"]);
const MEASUREMENT_REVOCATION_REASONS = new Set(["source-invalid", "evaluator-invalid", "protocol-invalid", "duplicate", "other"]);
const DELIVERY_REVOCATION_REASONS = new Set(["host-invalid", "session-invalid", "hook-invalid", "duplicate", "other"]);
const OUTCOME_REVOCATION_REASONS = new Set(["binding-invalid", "phase-invalid", "scope-invalid", "duplicate", "other"]);
const APPLICATION_REVOCATION_REASONS = new Set(["preflight-invalid", "scope-invalid", "projection-invalid", "duplicate", "other"]);
const EVALUATION_REVOCATION_REASONS = new Set(["benchmark-invalid", "protocol-invalid", "scope-invalid", "threshold-invalid", "duplicate", "other"]);
const VALIDATION_REVOCATION_REASONS = new Set(["decision-invalid", "cohort-invalid", "binding-invalid", "scope-invalid", "duplicate", "other"]);
const TRIAL_FAILURE_REVOCATION_REASONS = new Set(["clock-invalid", "host-invalid", "receipt-invalid", "scope-invalid", "duplicate", "other"]);

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
    canaryTtlDays: 14,
    initialTrialOutcomeTimeoutMinutes: 1440
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
    trialFailures: [],
    trialFailureRevocations: [],
    evaluationRevocations: [],
    validationRevocations: [],
    evidenceRevocations: [],
    measurementRevocations: [],
    applicationRevocations: [],
    deliveryRevocations: [],
    outcomeRevocations: [],
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
    || (value.trialFailures !== undefined && (!Array.isArray(value.trialFailures) || !value.trialFailures.every((item) => item && typeof item === "object")))
    || (value.trialFailureRevocations !== undefined && (!Array.isArray(value.trialFailureRevocations)
      || !value.trialFailureRevocations.every((item) => item && typeof item === "object")))
    || (value.evaluationRevocations !== undefined && (!Array.isArray(value.evaluationRevocations)
      || !value.evaluationRevocations.every((item) => item && typeof item === "object")))
    || (value.validationRevocations !== undefined && (!Array.isArray(value.validationRevocations)
      || !value.validationRevocations.every((item) => item && typeof item === "object")))
    || (value.evidenceRevocations !== undefined && (!Array.isArray(value.evidenceRevocations)
      || !value.evidenceRevocations.every((item) => item && typeof item === "object")))
    || (value.measurementRevocations !== undefined && (!Array.isArray(value.measurementRevocations)
      || !value.measurementRevocations.every((item) => item && typeof item === "object")))
    || (value.applicationRevocations !== undefined && (!Array.isArray(value.applicationRevocations)
      || !value.applicationRevocations.every((item) => item && typeof item === "object")))
    || (value.deliveryRevocations !== undefined && (!Array.isArray(value.deliveryRevocations)
      || !value.deliveryRevocations.every((item) => item && typeof item === "object")))
    || (value.outcomeRevocations !== undefined && (!Array.isArray(value.outcomeRevocations)
      || !value.outcomeRevocations.every((item) => item && typeof item === "object")))
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
    validationLeases: value.validationLeases || [],
    trialFailures: value.trialFailures || [],
    trialFailureRevocations: value.trialFailureRevocations || [],
    evaluationRevocations: value.evaluationRevocations || [],
    validationRevocations: value.validationRevocations || [],
    evidenceRevocations: value.evidenceRevocations || [],
    measurementRevocations: value.measurementRevocations || [],
    applicationRevocations: value.applicationRevocations || [],
    deliveryRevocations: value.deliveryRevocations || [],
    outcomeRevocations: value.outcomeRevocations || []
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
  if (normalized.evaluations.some((contract) => TARGET_BOUND_EVALUATIONS.has(contract.schema)
    && !learningTargetMatchesCandidate(contract.target,
      normalized.candidates.find((candidate) => candidate.id === contract.learningId)))) {
    throw new Error("learning evaluation target is invalid or changed; run the audit before learning");
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
  if (normalized.evaluations.some((contract) => REGISTRY_BOUND_EVALUATIONS.has(contract.schema)
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
  if (normalized.trialFailures.some((receipt) => !storedTrialFailureStructure(receipt)
    || !trialFailureMatchesState(normalized, receipt))
    || new Set(normalized.trialFailures.map((entry) => entry.applicationId)).size !== normalized.trialFailures.length) {
    throw new Error("learning trial failure state is invalid; run the audit before learning");
  }
  if (normalized.trialFailureRevocations.some((receipt) => !storedTrialFailureRevocationStructure(receipt)
    || !trialFailureRevocationMatchesState(normalized, receipt))
    || new Set(normalized.trialFailureRevocations.map((entry) => entry.trialFailureId)).size
      !== normalized.trialFailureRevocations.length) {
    throw new Error("learning trial failure revocation state is invalid; run the audit before learning");
  }
  const retryContracts = normalized.evaluations.filter((contract) => TRIAL_RETRY_EVALUATIONS.has(contract.schema));
  if (retryContracts.some((contract) => !trialRetryMatchesState(normalized, contract))
    || new Set(retryContracts.map((contract) => contract.retry.trialFailureRevocationId)).size
      !== retryContracts.length) {
    throw new Error("learning trial retry state is invalid; run the audit before learning");
  }
  if (normalized.evaluationRevocations.some((receipt) => !storedEvaluationRevocationStructure(receipt)
    || !evaluationRevocationMatchesState(normalized, receipt))
    || new Set(normalized.evaluationRevocations.map((entry) => entry.evaluationId)).size
      !== normalized.evaluationRevocations.length) {
    throw new Error("learning evaluation revocation state is invalid; run the audit before learning");
  }
  if (normalized.validationRevocations.some((receipt) => !storedValidationRevocationStructure(receipt)
    || !validationRevocationMatchesState(normalized, receipt))
    || new Set(normalized.validationRevocations.map((entry) => entry.validationLeaseId)).size
      !== normalized.validationRevocations.length) {
    throw new Error("learning validation revocation state is invalid; run the audit before learning");
  }
  if (normalized.evidenceRevocations.some((receipt) => !storedEvidenceRevocationStructure(receipt)
    || !evidenceRevocationMatchesState(normalized, receipt))
    || new Set(normalized.evidenceRevocations.map((entry) => `${entry.learningId}\0${entry.evidenceId}`)).size
      !== normalized.evidenceRevocations.length) {
    throw new Error("learning evidence revocation state is invalid; run the audit before learning");
  }
  if (normalized.measurementRevocations.some((receipt) => !storedMeasurementRevocationStructure(receipt)
    || !measurementRevocationMatchesState(normalized, receipt))
    || new Set(normalized.measurementRevocations.map((entry) => entry.measurementId)).size
      !== normalized.measurementRevocations.length) {
    throw new Error("learning measurement revocation state is invalid; run the audit before learning");
  }
  if (normalized.applicationRevocations.some((receipt) => !storedApplicationRevocationStructure(receipt)
    || !applicationRevocationMatchesState(normalized, receipt))
    || new Set(normalized.applicationRevocations.map((entry) => entry.applicationId)).size
      !== normalized.applicationRevocations.length) {
    throw new Error("learning application revocation state is invalid; run the audit before learning");
  }
  if (normalized.deliveryRevocations.some((receipt) => !storedDeliveryRevocationStructure(receipt)
    || !deliveryRevocationMatchesState(normalized, receipt))
    || new Set(normalized.deliveryRevocations.map((entry) => entry.deliveryId)).size
      !== normalized.deliveryRevocations.length) {
    throw new Error("learning delivery revocation state is invalid; run the audit before learning");
  }
  if (normalized.outcomeRevocations.some((receipt) => !storedOutcomeRevocationStructure(receipt)
    || !outcomeRevocationMatchesState(normalized, receipt))
    || new Set(normalized.outcomeRevocations.map((entry) => entry.outcomeId)).size
      !== normalized.outcomeRevocations.length) {
    throw new Error("learning outcome revocation state is invalid; run the audit before learning");
  }
  if (normalized.candidates.some((candidate) => candidate.promotion?.canary?.revalidation
    && !revalidationWindowMatchesState(normalized, candidate))) {
    throw new Error("learning revalidation window state is invalid; run the audit before learning");
  }
  if (!revalidationAdmissionsMatchState(normalized)) {
    throw new Error("learning revalidation admission state is invalid; run the audit before learning");
  }
  if (!initialAdmissionsMatchState(normalized)) {
    throw new Error("learning initial trial admission state is invalid; run the audit before learning");
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
      || !DELIVERABLE_APPLICATIONS.has(application.schema)
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
    const evaluatorRoot = ROOT_BOUND_EVALUATIONS.has(contract?.schema)
      ? contract.evaluatorRoots.find((root) => root.evaluatorId === receipt.measurement?.evaluatorId) : null;
    return !candidate || !contract || !LINEAGE_EVALUATIONS.has(contract.schema)
      || contract.learningId !== receipt.learningId || !exactScope(contract.scope, receipt.scope)
      || contract.metric.name !== receipt.metric.name || contract.metric.direction !== receipt.metric.direction
      || !contract.evaluatorIds.includes(receipt.measurement.evaluatorId)
      || contract.benchmark.datasetDigest !== receipt.coverage.datasetDigest
      || (ROOT_BOUND_EVALUATIONS.has(contract.schema)
        && (receipt.schema !== "agentspine.learning-measurement/v2"
          || evaluatorRoot?.principalDigest !== receipt.measurement?.evaluatorRootDigest))
      || receipt.coverage.caseCount < contract.benchmark.minCases
      || !scopeContains(candidate.scope, receipt.scope)
      || new Date(receipt.measuredAt).getTime() < new Date(contract.registeredAt).getTime()
      || new Date(receipt.measuredAt).getTime() > new Date(contract.expiresAt).getTime();
  })) throw new Error("learning measurement binding is invalid; run the audit before learning");
  if (normalized.measurements.some((receipt) => {
    const contract = normalized.evaluations.find((entry) => entry.id === receipt.evaluationId);
    if (!INITIAL_TRIAL_EVALUATIONS.has(contract?.schema)) return false;
    const retainedByValidation = normalized.validationLeases.some((lease) =>
      lease?.renewalEvidence?.some((entry) => entry.measurementId === receipt.id
        && entry.measurementDigest === receipt.digest));
    if (retainedByValidation) return false;
    const revalidationApplication = receipt.phase === "after" ? normalized.applications.find((entry) =>
      entry.schema === "agentspine.learning-application/v4" && entry.learningId === receipt.learningId
      && entry.revalidationAdmission.evaluatorId === receipt.measurement?.evaluatorId
      && entry.revalidationAdmission.evaluatorRootDigest === receipt.measurement?.evaluatorRootDigest
      && entry.revalidationAdmission.runId === receipt.measurement?.runId) : null;
    if (revalidationApplication) {
      const delivery = normalized.deliveries.find((entry) => entry.applicationId === revalidationApplication.id);
      return !delivery || new Date(receipt.measuredAt).getTime() < new Date(delivery.completedAt).getTime();
    }
    const trial = contract.initialTrials?.[receipt.phase]?.find((entry) =>
      entry.evaluatorId === receipt.measurement?.evaluatorId);
    if (!trial || receipt.measurement.evaluatorRootDigest !== trial.evaluatorRootDigest
      || receipt.measurement.runId !== trial.runId || receipt.coverage.caseCount !== trial.caseCount) return true;
    if (receipt.phase !== "after") return false;
    const application = normalized.applications.find((entry) => INITIAL_TRIAL_APPLICATIONS.has(entry.schema)
      && entry.learningId === receipt.learningId && entry.initialAdmission.evaluationId === contract.id
      && entry.initialAdmission.evaluationDigest === contract.digest && entry.initialAdmission.slot === trial.slot
      && entry.initialAdmission.trialDigest === trial.trialDigest
      && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
        || (TARGET_BOUND_APPLICATIONS.has(entry.schema)
          && entry.initialAdmission.targetDigest === contract.target.digest)));
    const delivery = application && normalized.deliveries.find((entry) => entry.applicationId === application.id);
    return !delivery || new Date(receipt.measuredAt).getTime() < new Date(delivery.completedAt).getTime()
      || (DEADLINE_BOUND_APPLICATIONS.has(application.schema)
        && new Date(receipt.measuredAt).getTime() > new Date(application.outcomeExpiresAt).getTime());
  })) throw new Error("learning initial trial measurement binding is invalid; run the audit before learning");
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
      && new Date(receipt.measuredAt).getTime() <= new Date(application.expiresAt).getTime()
      && (!DEADLINE_BOUND_APPLICATIONS.has(application.schema)
        || new Date(receipt.measuredAt).getTime() <= new Date(application.outcomeExpiresAt).getTime())))) {
    throw new Error("learning outcome application binding is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5", "agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
    && !normalized.evaluations.some((contract) => contract.id === receipt.evaluationId
      && contract.learningId === receipt.learningId && exactScope(contract.scope, receipt.scope)
      && contract.metric.name === receipt.metric.name && contract.metric.direction === receipt.metric.direction
      && contract.evaluatorIds.includes(receipt.measurement.evaluatorId)
      && (receipt.schema !== "agentspine.learning-outcome/v9"
        || (ROOT_BOUND_EVALUATIONS.has(contract.schema)
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
        || (receipt.schema === "agentspine.learning-outcome/v9" && ROOT_BOUND_EVALUATIONS.has(contract.schema)))
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
      && exactScope(contract.scope, candidate.promotion.canary.scope)
      && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
        || (candidate.promotion.canary.targetDigest === contract.target.digest
          && learningTargetMatchesCandidate(contract.target, candidate)))
      && (!DEADLINE_BOUND_EVALUATIONS.has(contract.schema)
        || candidate.promotion.canary.completionPolicyDigest === contract.completionPolicy.digest)))) {
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
    && Number.isInteger(config.canaryTtlDays) && config.canaryTtlDays >= 1 && config.canaryTtlDays <= 90
    && Number.isInteger(config.initialTrialOutcomeTimeoutMinutes)
    && config.initialTrialOutcomeTimeoutMinutes >= 5 && config.initialTrialOutcomeTimeoutMinutes <= 10080;
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

function learningTargetRevisionPayload(candidate) {
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

function learningTargetPayload({ learningId, revisionDigest, claimDigest, evidenceDigest, scopeDigest }) {
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

function learningTargetForCandidate(candidate) {
  const payload = learningTargetPayload({
    learningId: candidate.id,
    revisionDigest: digest(learningTargetRevisionPayload(candidate)),
    claimDigest: digest(candidate.claim),
    evidenceDigest: digest(candidate.evidence),
    scopeDigest: digest(candidate.scope)
  });
  return { ...payload, digest: digest(payload) };
}

function storedLearningTargetStructure(target) {
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

function learningTargetMatchesCandidate(target, candidate) {
  return Boolean(candidate) && storedLearningTargetStructure(target)
    && target.digest === learningTargetForCandidate(candidate).digest;
}

function evidenceRevocationPayload({ id, learningId, evidenceId, evidenceDigest, targetDigest, reasonCode,
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

function storedEvidenceRevocationStructure(receipt) {
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

function evidenceRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evidence = candidate?.evidence.find((entry) => entry.id === receipt.evidenceId);
  return Boolean(candidate && evidence && digest(evidence) === receipt.evidenceDigest
    && learningTargetForCandidate(candidate).digest === receipt.targetDigest);
}

function revokedEvidence(state, candidate) {
  return state.evidenceRevocations.find((receipt) => receipt.learningId === candidate?.id) || null;
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

function measurementRevocationPayload({ id, learningId, evaluationId, evaluationDigest, measurementId,
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

function storedMeasurementRevocationStructure(receipt) {
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

function measurementRevocationMatchesState(state, receipt) {
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

function revokedMeasurement(state, measurementId) {
  return state.measurementRevocations.find((receipt) => receipt.measurementId === measurementId) || null;
}

function revokedMeasurementForCandidate(state, candidate) {
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

function evaluationRevocationPayload({ id, learningId, evaluationId, evaluationDigest,
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

function storedEvaluationRevocationStructure(receipt) {
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

function evaluationRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId);
  const binding = state.evaluationBindings.find((entry) => entry.evaluationId === receipt.evaluationId
    && entry.evaluationDigest === receipt.evaluationDigest) || null;
  return Boolean(candidate && evaluation && evaluation.learningId === candidate.id
    && evaluation.digest === receipt.evaluationDigest
    && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && (binding?.digest || null) === receipt.evaluatorBindingDigest);
}

function revokedEvaluation(state, evaluationId) {
  return state.evaluationRevocations.find((receipt) => receipt.evaluationId === evaluationId) || null;
}

function revokedEvaluationForCandidate(state, candidate) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (canary?.evaluationId) {
    return state.evaluationRevocations.find((receipt) => receipt.learningId === candidate.id
      && receipt.evaluationId === canary.evaluationId
      && receipt.evaluationDigest === canary.evaluationDigest) || null;
  }
  return state.evaluationRevocations.find((receipt) => receipt.learningId === candidate?.id) || null;
}

function validationOutcomeReferences(receipts) {
  return receipts.map((receipt) => ({ id: receipt.id, digest: receipt.digest, authority: "context-only" }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function revalidationWindowPayload({
  id, status, startedAt, expiresAt, predecessorValidationId, predecessorValidationDigest, selection,
  schema = "agentspine.learning-revalidation-window/v1"
}) {
  const selectionBound = ["agentspine.learning-revalidation-window/v2",
    "agentspine.learning-revalidation-window/v3", "agentspine.learning-revalidation-window/v4"].includes(schema);
  return {
    schema,
    ...(selectionBound ? { id } : {}),
    status,
    startedAt,
    expiresAt,
    predecessorValidationId,
    predecessorValidationDigest,
    ...(selectionBound ? { selection } : {}),
    authority: "context-only"
  };
}

function revalidationTrialPayload({ evaluationId, evaluationDigest, predecessorValidationId,
  predecessorValidationDigest, slot, evaluatorId, evaluatorRootDigest, runId, benchmark, caseCount }) {
  return {
    schema: "agentspine.learning-revalidation-trial/v1",
    evaluationId,
    evaluationDigest,
    predecessorValidationId,
    predecessorValidationDigest,
    slot,
    evaluatorId,
    evaluatorRootDigest,
    runId,
    benchmarkDigest: digest(benchmark),
    caseCount,
    authority: "context-only"
  };
}

function revalidationTrialDigest(input) {
  return digest(revalidationTrialPayload(input));
}

function storedRevalidationWindowStructure(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return false;
  const payload = revalidationWindowPayload(window);
  const common = ["agentspine.learning-revalidation-window/v1", "agentspine.learning-revalidation-window/v2",
    "agentspine.learning-revalidation-window/v3", "agentspine.learning-revalidation-window/v4"]
    .includes(window.schema)
    && window.status === "active" && window.authority === "context-only"
    && Number.isFinite(new Date(window.startedAt).getTime())
    && Number.isFinite(new Date(window.expiresAt).getTime())
    && new Date(window.expiresAt).getTime() > new Date(window.startedAt).getTime()
    && ID_RE.test(window.predecessorValidationId || "")
    && DIGEST_RE.test(window.predecessorValidationDigest || "");
  if (!common) return false;
  if (window.schema === "agentspine.learning-revalidation-window/v1") return true;
  const roots = window.selection?.evaluatorRoots;
  const validMode = window.schema === "agentspine.learning-revalidation-window/v2"
    ? window.selection?.mode === "first-completed-turns"
    : window.schema === "agentspine.learning-revalidation-window/v3"
      ? window.selection?.mode === "first-admitted-turns"
      : window.selection?.mode === "first-admitted-trials";
  return ID_RE.test(window.id || "") && validMode
    && Number.isInteger(window.selection?.requiredDeliveries)
    && window.selection.requiredDeliveries >= 2 && window.selection.requiredDeliveries <= 10
    && Array.isArray(roots) && roots.length === window.selection.requiredDeliveries
    && roots.every((entry, index) => entry?.slot === index + 1
      && DIGEST_RE.test(entry?.evaluatorRootDigest || "")
      && (window.schema !== "agentspine.learning-revalidation-window/v4"
        || (ID_RE.test(entry?.evaluatorId || "") && ID_RE.test(entry?.runId || "")
          && Number.isInteger(entry?.caseCount) && entry.caseCount >= 1 && entry.caseCount <= 1000000
          && DIGEST_RE.test(entry?.trialDigest || "")))
      && entry?.authority === "context-only")
    && new Set(roots.map((entry) => entry.evaluatorRootDigest)).size === roots.length
    && window.selection.authority === "context-only" && window.digest === digest(payload);
}

function revalidationWindowMatchesState(state, candidate) {
  const window = candidate?.promotion?.canary?.revalidation;
  if (!window) return true;
  const predecessor = state.validationLeases.find((lease) => lease.id === window.predecessorValidationId
    && lease.digest === window.predecessorValidationDigest && lease.learningId === candidate.id);
  if (!storedRevalidationWindowStructure(window) || candidate.promotion?.canary?.status !== "validated"
    || !predecessor || window.expiresAt !== predecessor.expiresAt) return false;
  if (window.schema === "agentspine.learning-revalidation-window/v1") return true;
  const references = predecessor.schema === "agentspine.learning-validation/v1"
    ? predecessor.beforeOutcomes : predecessor.baselineOutcomes;
  const baselines = references.map((reference) => state.outcomes.find((outcome) =>
    outcome.id === reference.id && outcome.digest === reference.digest))
    .filter(Boolean).sort((a, b) => a.measurement.evaluatorId.localeCompare(b.measurement.evaluatorId));
  const contract = state.evaluations.find((entry) => entry.id === candidate.promotion?.canary?.evaluationId
    && entry.digest === candidate.promotion.canary.evaluationDigest);
  return baselines.length === references.length && baselines.length === window.selection.requiredDeliveries
    && window.selection.evaluatorRoots.every((entry, index) => {
      const baseline = baselines[index];
      if (entry.evaluatorRootDigest !== baseline.measurement.evaluatorRootDigest) return false;
      if (window.schema !== "agentspine.learning-revalidation-window/v4") return true;
      return contract && entry.evaluatorId === baseline.measurement.evaluatorId
        && entry.caseCount === baseline.coverage.caseCount
        && entry.trialDigest === revalidationTrialDigest({
          evaluationId: contract.id, evaluationDigest: contract.digest,
          predecessorValidationId: predecessor.id, predecessorValidationDigest: predecessor.digest,
          slot: entry.slot, evaluatorId: entry.evaluatorId, evaluatorRootDigest: entry.evaluatorRootDigest,
          runId: entry.runId, benchmark: contract.benchmark, caseCount: entry.caseCount
        });
    });
}

function validationLeasePayload({
  id, learningId, evaluationId, evaluationDigest, evaluatorRegistryBindingDigest,
  scope, metric, beforeOutcomes, afterOutcomes, baselineOutcomes, predecessorValidation,
  renewalEvidence, selectionProof, improvement, validatedAt, expiresAt,
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
      : { baselineOutcomes, predecessorValidation, renewalEvidence,
          ...(["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
            "agentspine.learning-validation/v5"].includes(schema)
            ? { selectionProof } : {}) }),
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
  const admissionBound = ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema);
  const trialBound = lease.schema === "agentspine.learning-validation/v5";
  const selectionEntries = admissionBound
    ? lease.selectionProof?.applications : lease.selectionProof?.deliveries;
  const validSelectionProof = lease.selectionProof && ID_RE.test(lease.selectionProof.revalidationWindowId || "")
    && DIGEST_RE.test(lease.selectionProof.revalidationWindowDigest || "")
    && (trialBound
      ? lease.selectionProof.mode === "first-admitted-trials"
      : lease.schema === "agentspine.learning-validation/v4"
        ? lease.selectionProof.mode === "first-admitted-turns"
      : lease.selectionProof.mode === "first-completed-turns")
    && Number.isInteger(lease.selectionProof.requiredDeliveries)
    && lease.selectionProof.requiredDeliveries >= 2 && lease.selectionProof.requiredDeliveries <= 10
    && Array.isArray(selectionEntries)
    && selectionEntries.length === lease.selectionProof.requiredDeliveries
    && selectionEntries.every((entry, index) => entry?.slot === index + 1
      && (!admissionBound
        || (ID_RE.test(entry?.applicationId || "") && DIGEST_RE.test(entry?.applicationDigest || "")))
      && ID_RE.test(entry?.deliveryId || "") && DIGEST_RE.test(entry?.deliveryDigest || "")
      && DIGEST_RE.test(entry?.evaluatorRootDigest || "")
      && (!trialBound || (ID_RE.test(entry?.evaluatorId || "") && ID_RE.test(entry?.runId || "")
        && DIGEST_RE.test(entry?.trialDigest || "")))
      && entry?.authority === "context-only")
    && new Set(selectionEntries.map((entry) => entry.deliveryId)).size === selectionEntries.length
    && new Set(selectionEntries.map((entry) => entry.evaluatorRootDigest)).size === selectionEntries.length
    && (!admissionBound
      || new Set(selectionEntries.map((entry) => entry.applicationId)).size === selectionEntries.length)
    && lease.selectionProof.authority === "context-only";
  return ["agentspine.learning-validation/v1", "agentspine.learning-validation/v2",
    "agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
    "agentspine.learning-validation/v5"].includes(lease.schema)
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
      : validReferences(lease.baselineOutcomes) && validPredecessor && validRenewalEvidence
        && (!["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
          "agentspine.learning-validation/v5"].includes(lease.schema)
          || validSelectionProof))
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
    && REGISTRY_BOUND_EVALUATIONS.has(contract?.schema)
    && contract.digest === lease.evaluationDigest
    && (!INITIAL_TRIAL_EVALUATIONS.has(contract.schema)
      || canary.initialTrialsDigest === digest(contract.initialTrials))
    && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
      || (canary.targetDigest === contract.target.digest && learningTargetMatchesCandidate(contract.target, candidate)))
    && (!DEADLINE_BOUND_EVALUATIONS.has(contract.schema)
      || canary.completionPolicyDigest === contract.completionPolicy.digest)
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
  const selectionMatches = !["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
    "agentspine.learning-validation/v5"]
    .includes(lease.schema) || (() => {
    const historicalWindow = state.history.find((entry) => entry.kind === "learning-candidate"
      && entry.value?.id === lease.learningId
      && entry.value?.promotion?.canary?.revalidation?.id === lease.selectionProof.revalidationWindowId
      && entry.value.promotion.canary.revalidation.digest === lease.selectionProof.revalidationWindowDigest)
      ?.value?.promotion?.canary?.revalidation;
    if (!storedRevalidationWindowStructure(historicalWindow)
      || (lease.schema === "agentspine.learning-validation/v3"
        ? historicalWindow.schema !== "agentspine.learning-revalidation-window/v2"
        : lease.schema === "agentspine.learning-validation/v4"
          ? historicalWindow.schema !== "agentspine.learning-revalidation-window/v3"
          : historicalWindow.schema !== "agentspine.learning-revalidation-window/v4")
      || historicalWindow.selection.mode !== lease.selectionProof.mode
      || historicalWindow.selection.requiredDeliveries !== lease.selectionProof.requiredDeliveries) return false;
    const selectedEntries = ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema)
      ? lease.selectionProof.applications : lease.selectionProof.deliveries;
    return selectedEntries.every((selected, index) => {
      const frozen = historicalWindow.selection.evaluatorRoots[index];
      const evidence = lease.renewalEvidence.find((entry) => entry.deliveryId === selected.deliveryId);
      const measurement = evidence ? state.measurements.find((entry) => entry.id === evidence.measurementId
        && entry.digest === evidence.measurementDigest) : null;
      const application = ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema)
        ? state.applications.find((entry) => entry.id === selected.applicationId
          && entry.digest === selected.applicationDigest) : null;
      return frozen?.slot === selected.slot && frozen.evaluatorRootDigest === selected.evaluatorRootDigest
        && (lease.schema !== "agentspine.learning-validation/v5"
          || (frozen.evaluatorId === selected.evaluatorId && frozen.runId === selected.runId
            && frozen.trialDigest === selected.trialDigest
            && measurement?.measurement?.evaluatorId === selected.evaluatorId
            && measurement?.measurement?.runId === selected.runId
            && measurement?.coverage?.caseCount === frozen.caseCount
            && selected.trialDigest === revalidationTrialDigest({
              evaluationId: lease.evaluationId, evaluationDigest: lease.evaluationDigest,
              predecessorValidationId: lease.predecessorValidation.id,
              predecessorValidationDigest: lease.predecessorValidation.digest,
              slot: selected.slot, evaluatorId: selected.evaluatorId,
              evaluatorRootDigest: selected.evaluatorRootDigest, runId: selected.runId,
              benchmark: contract.benchmark, caseCount: frozen.caseCount
            })))
        && (!["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema)
          || (evidence?.applicationId === selected.applicationId
            && evidence.applicationDigest === selected.applicationDigest
            && application?.schema === (lease.schema === "agentspine.learning-validation/v5"
              ? "agentspine.learning-application/v4" : "agentspine.learning-application/v3")
            && application.revalidationAdmission.revalidationWindowId === historicalWindow.id
            && application.revalidationAdmission.revalidationWindowDigest === historicalWindow.digest
            && application.revalidationAdmission.slot === selected.slot
            && application.revalidationAdmission.evaluatorRootDigest === selected.evaluatorRootDigest
            && (lease.schema !== "agentspine.learning-validation/v5"
              || (application.revalidationAdmission.trialDigest === selected.trialDigest
                && application.revalidationAdmission.runId === selected.runId
                && application.revalidationAdmission.evaluatorId === selected.evaluatorId))))
        && evidence?.deliveryDigest === selected.deliveryDigest
        && evidence.evaluatorRootDigest === selected.evaluatorRootDigest;
    });
  })();
  const initialSelectionMatches = !INITIAL_TRIAL_EVALUATIONS.has(contract?.schema)
    || lease.schema !== "agentspine.learning-validation/v1" || (() => {
    if (lease.beforeOutcomes.length !== contract.initialTrials.requiredTrials
      || lease.afterOutcomes.length !== contract.initialTrials.requiredTrials) return false;
    const outcomeMatchesTrial = (reference, phase, trial) => {
      const outcome = state.outcomes.find((entry) => entry.id === reference.id && entry.digest === reference.digest);
      const measurement = outcome && state.measurements.find((entry) => entry.id === outcome.measurementReceiptId
        && entry.digest === outcome.measurementReceiptDigest);
      if (!outcome || !measurement || outcome.phase !== phase
        || measurement.measurement.evaluatorId !== trial.evaluatorId
        || measurement.measurement.evaluatorRootDigest !== trial.evaluatorRootDigest
        || measurement.measurement.runId !== trial.runId || measurement.coverage.caseCount !== trial.caseCount) return false;
      if (phase === "before") return true;
      const application = state.applications.find((entry) => entry.id === outcome.applicationId
        && INITIAL_TRIAL_APPLICATIONS.has(entry.schema)
        && entry.initialAdmission.evaluationId === contract.id
        && entry.initialAdmission.evaluationDigest === contract.digest
        && entry.initialAdmission.slot === trial.slot
        && entry.initialAdmission.trialDigest === trial.trialDigest
        && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
          || (TARGET_BOUND_APPLICATIONS.has(entry.schema)
            && entry.initialAdmission.targetDigest === contract.target.digest)));
      const delivery = application && state.deliveries.find((entry) => entry.id === outcome.deliveryId
        && entry.applicationId === application.id);
      return Boolean(application && delivery);
    };
    return contract.initialTrials.before.every((trial, index) =>
      outcomeMatchesTrial(lease.beforeOutcomes[index], "before", trial))
      && contract.initialTrials.after.every((trial, index) =>
        outcomeMatchesTrial(lease.afterOutcomes[index], "after", trial));
  })();
  return Boolean(common && evidenceMatches && selectionMatches && initialSelectionMatches);
}

function validationLeaseRecords(state) {
  return [...state.validationLeases, ...state.history
    .filter((entry) => entry.kind === "learning-validation")
    .map((entry) => entry.value)
    .filter(Boolean)];
}

function validationLeaseRecord(state, id, leaseDigest = null) {
  return validationLeaseRecords(state).find((lease) => lease.id === id
    && (leaseDigest === null || lease.digest === leaseDigest)) || null;
}

function validationLeaseChain(state, candidate) {
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

function validationRevocationPayload({ id, learningId, evaluationId, evaluationDigest,
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

function storedValidationRevocationStructure(receipt) {
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

function validationRevocationMatchesState(state, receipt) {
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

function revokedValidation(state, validationLeaseId) {
  return state.validationRevocations.find((receipt) => receipt.validationLeaseId === validationLeaseId) || null;
}

function revokedValidationForCandidate(state, candidate) {
  const chain = validationLeaseChain(state, candidate);
  if (!chain.length) return null;
  return state.validationRevocations.find((receipt) => receipt.learningId === candidate.id
    && chain.some((lease) => lease.id === receipt.validationLeaseId
      && lease.digest === receipt.validationLeaseDigest)) || null;
}

function validationLeaseState(state, candidate, timestamp) {
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

function initialTrialTimeout(state, candidate, timestamp) {
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

function canaryValidity(state, candidate, timestamp) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  const evidenceRevocation = revokedEvidence(state, candidate);
  if (candidate?.status === "accepted" && evidenceRevocation) {
    return { status: "revoked-evidence", canary, evaluation: null, lease: null, evidenceRevocation };
  }
  const evaluationRevocation = revokedEvaluationForCandidate(state, candidate);
  if (candidate?.status === "accepted" && evaluationRevocation) {
    return { status: "revoked-evaluation", canary, evaluation: null, lease: null, evaluationRevocation };
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

function initialTrialPayload({ evaluationId, learningId, scope, metric, benchmark, phase, slot,
  evaluatorId, evaluatorRootDigest, runId, caseCount }) {
  return {
    schema: "agentspine.learning-initial-trial/v1",
    evaluationId,
    learningId,
    scopeDigest: digest(scope),
    metricDigest: digest(metric),
    benchmarkDigest: digest(benchmark),
    phase,
    slot,
    evaluatorId,
    evaluatorRootDigest,
    runId,
    caseCount,
    authority: "context-only"
  };
}

function initialTrialDigest(input) {
  return digest(initialTrialPayload(input));
}

function storedInitialTrialPlanStructure(plan, contract) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)
    || plan.schema !== "agentspine.learning-initial-trials/v1"
    || plan.mode !== "first-admitted-trials"
    || !Number.isInteger(plan.requiredTrials) || plan.requiredTrials < 2 || plan.requiredTrials > 10
    || plan.benchmarkDigest !== digest(contract.benchmark)
    || plan.authority !== "context-only") return false;
  const validPhase = (phase) => Array.isArray(plan[phase]) && plan[phase].length === plan.requiredTrials
    && plan[phase].every((entry, index) => entry?.slot === index + 1
      && ID_RE.test(entry?.evaluatorId || "") && DIGEST_RE.test(entry?.evaluatorRootDigest || "")
      && ID_RE.test(entry?.runId || "") && Number.isInteger(entry?.caseCount)
      && entry.caseCount === contract.benchmark.minCases && DIGEST_RE.test(entry?.trialDigest || "")
      && entry.authority === "context-only"
      && entry.trialDigest === initialTrialDigest({
        evaluationId: contract.id, learningId: contract.learningId, scope: contract.scope,
        metric: contract.metric, benchmark: contract.benchmark, phase, slot: entry.slot,
        evaluatorId: entry.evaluatorId, evaluatorRootDigest: entry.evaluatorRootDigest,
        runId: entry.runId, caseCount: entry.caseCount
      }))
    && new Set(plan[phase].map((entry) => entry.evaluatorId)).size === plan[phase].length
    && new Set(plan[phase].map((entry) => entry.evaluatorRootDigest)).size === plan[phase].length
    && new Set(plan[phase].map((entry) => entry.runId)).size === plan[phase].length;
  return validPhase("before") && validPhase("after")
    && plan.before.every((entry, index) => entry.evaluatorId === plan.after[index].evaluatorId
      && entry.evaluatorRootDigest === plan.after[index].evaluatorRootDigest
      && entry.runId !== plan.after[index].runId)
    && plan.before.every((entry) => contract.evaluatorRoots.some((root) => root.evaluatorId === entry.evaluatorId
      && root.principalDigest === entry.evaluatorRootDigest));
}

function completionPolicyPayload({ deliveryTimeoutMs, outcomeTimeoutMs }) {
  return {
    schema: "agentspine.learning-completion-policy/v1",
    deliveryTimeoutMs,
    outcomeTimeoutMs,
    missingDelivery: "blocking-defect",
    missingOutcome: "blocking-defect",
    authority: "context-only"
  };
}

function storedCompletionPolicyStructure(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const payload = completionPolicyPayload(policy);
  return policy.schema === "agentspine.learning-completion-policy/v1"
    && Number.isInteger(policy.deliveryTimeoutMs) && policy.deliveryTimeoutMs >= 60_000
    && policy.deliveryTimeoutMs <= 15 * 60_000
    && Number.isInteger(policy.outcomeTimeoutMs) && policy.outcomeTimeoutMs >= policy.deliveryTimeoutMs
    && policy.outcomeTimeoutMs <= 7 * 86400000
    && policy.missingDelivery === "blocking-defect" && policy.missingOutcome === "blocking-defect"
    && policy.authority === "context-only" && policy.digest === digest(payload);
}

function trialRetryPayload({ trialFailureId, trialFailureDigest, trialFailureRevocationId,
  trialFailureRevocationDigest, predecessorLearningId, learningId, targetDigest, scopeDigest,
  minimumEvidenceObservedAt, admittedAt }) {
  return {
    schema: "agentspine.learning-trial-retry/v1",
    trialFailureId,
    trialFailureDigest,
    trialFailureRevocationId,
    trialFailureRevocationDigest,
    predecessorLearningId,
    learningId,
    targetDigest,
    scopeDigest,
    minimumEvidenceObservedAt,
    admittedAt,
    authority: "context-only"
  };
}

function storedTrialRetryStructure(retry) {
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) return false;
  const payload = trialRetryPayload(retry);
  return retry.schema === "agentspine.learning-trial-retry/v1"
    && Object.keys(retry).length === 13
    && Object.keys(retry).every((field) => ["schema", "trialFailureId", "trialFailureDigest",
      "trialFailureRevocationId", "trialFailureRevocationDigest", "predecessorLearningId", "learningId",
      "targetDigest", "scopeDigest", "minimumEvidenceObservedAt", "admittedAt", "authority", "digest"].includes(field))
    && [retry.trialFailureId, retry.trialFailureRevocationId, retry.predecessorLearningId, retry.learningId]
      .every((value) => ID_RE.test(value || ""))
    && [retry.trialFailureDigest, retry.trialFailureRevocationDigest, retry.targetDigest, retry.scopeDigest]
      .every((value) => DIGEST_RE.test(value || ""))
    && Number.isFinite(new Date(retry.minimumEvidenceObservedAt).getTime())
    && Number.isFinite(new Date(retry.admittedAt).getTime())
    && new Date(retry.admittedAt).getTime() > new Date(retry.minimumEvidenceObservedAt).getTime()
    && retry.authority === "context-only" && retry.digest === digest(payload);
}

function evaluationPayload({ id, learningId, scope, metric, benchmark, evaluatorIds, evaluatorRoots, thresholds, pairing,
  initialTrials, target, completionPolicy, retry, registeredAt, expiresAt,
  schema = "agentspine.learning-evaluation/v1" }) {
  return {
    schema, id, learningId, scope, metric, benchmark,
    evaluatorIds,
    ...(ROOT_BOUND_EVALUATIONS.has(schema) ? { evaluatorRoots } : {}),
    thresholds,
    ...(PAIRED_EVALUATIONS.has(schema) ? { pairing } : {}),
    ...(INITIAL_TRIAL_EVALUATIONS.has(schema) ? { initialTrials } : {}),
    ...(TARGET_BOUND_EVALUATIONS.has(schema) ? { target } : {}),
    ...(DEADLINE_BOUND_EVALUATIONS.has(schema) ? { completionPolicy } : {}),
    ...(TRIAL_RETRY_EVALUATIONS.has(schema) ? { retry } : {}),
    registeredAt, expiresAt, authority: "context-only"
  };
}

function storedEvaluationStructure(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return false;
  const payload = evaluationPayload(contract);
  return EVALUATION_SCHEMAS.has(contract.schema)
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
    && (!ROOT_BOUND_EVALUATIONS.has(contract.schema)
      || (Array.isArray(contract.evaluatorRoots)
        && contract.evaluatorRoots.length === contract.evaluatorIds.length
        && contract.evaluatorRoots.every((root) => ID_RE.test(root?.evaluatorId || "")
          && DIGEST_RE.test(root?.principalDigest || "") && root?.authority === "context-only")
        && new Set(contract.evaluatorRoots.map((root) => root.evaluatorId)).size === contract.evaluatorRoots.length
        && new Set(contract.evaluatorRoots.map((root) => root.principalDigest)).size === contract.evaluatorRoots.length
        && contract.evaluatorRoots.map((root) => root.evaluatorId).sort().join("\0") === [...contract.evaluatorIds].sort().join("\0")))
    && (!PAIRED_EVALUATIONS.has(contract.schema)
      || (contract.pairing?.mode === "same-evaluator"
        && contract.pairing?.maxOutcomesPerEvaluatorPerPhase === 1
        && contract.pairing?.matchMeasurementKind === true
        && contract.pairing?.matchCaseCount === true
        && contract.pairing?.authority === "context-only"))
    && (!INITIAL_TRIAL_EVALUATIONS.has(contract.schema)
      || storedInitialTrialPlanStructure(contract.initialTrials, contract))
    && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
      || (storedLearningTargetStructure(contract.target) && contract.target.learningId === contract.learningId))
    && (!DEADLINE_BOUND_EVALUATIONS.has(contract.schema)
      || storedCompletionPolicyStructure(contract.completionPolicy))
    && (!TRIAL_RETRY_EVALUATIONS.has(contract.schema)
      || (storedTrialRetryStructure(contract.retry)
        && contract.retry.learningId === contract.learningId
        && contract.retry.targetDigest === contract.target?.digest
        && contract.retry.scopeDigest === digest(contract.scope)
        && contract.retry.admittedAt === contract.registeredAt))
    && Number.isFinite(new Date(contract.registeredAt).getTime())
    && Number.isFinite(new Date(contract.expiresAt).getTime())
    && new Date(contract.expiresAt).getTime() > new Date(contract.registeredAt).getTime()
    && contract.authority === "context-only" && contract.digest === digest(payload);
}

function applicationPayload({ id, learningId, scope, preflightReceiptId, promptDigest,
  preflightBriefingDigest, sessionBriefingDigest, sessionId, projectedAt, deliveryExpiresAt, expiresAt,
  revalidationAdmission, initialAdmission, outcomeExpiresAt, completionPolicyDigest,
  schema = "agentspine.learning-application/v1" }) {
  return {
    schema, id, learningId, scope,
    preflightReceiptId, promptDigest, preflightBriefingDigest, sessionBriefingDigest,
    ...(DELIVERABLE_APPLICATIONS.has(schema)
      ? { sessionId, deliveryExpiresAt } : {}),
    ...(["agentspine.learning-application/v3", "agentspine.learning-application/v4"].includes(schema)
      ? { revalidationAdmission } : {}),
    ...(INITIAL_TRIAL_APPLICATIONS.has(schema) ? { initialAdmission } : {}),
    ...(DEADLINE_BOUND_APPLICATIONS.has(schema) ? { outcomeExpiresAt, completionPolicyDigest } : {}),
    projectedAt, expiresAt, authority: "context-only"
  };
}

function storedApplicationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = applicationPayload(receipt);
  const legacy = receipt.schema === "agentspine.learning-application/v1";
  const delivered = receipt.schema === "agentspine.learning-application/v2";
  const admitted = ["agentspine.learning-application/v3", "agentspine.learning-application/v4"].includes(receipt.schema);
  const initialAdmitted = INITIAL_TRIAL_APPLICATIONS.has(receipt.schema);
  const targetBound = TARGET_BOUND_APPLICATIONS.has(receipt.schema);
  const deadlineBound = DEADLINE_BOUND_APPLICATIONS.has(receipt.schema);
  const trialBound = receipt.schema === "agentspine.learning-application/v4";
  const admission = receipt.revalidationAdmission;
  const initial = receipt.initialAdmission;
  return (legacy || delivered || admitted || initialAdmitted) && ID_RE.test(receipt.id || "")
    && ID_RE.test(receipt.learningId || "") && ID_RE.test(receipt.preflightReceiptId || "")
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && [receipt.promptDigest, receipt.preflightBriefingDigest, receipt.sessionBriefingDigest]
      .every((value) => /^[a-f0-9]{64}$/.test(value || ""))
    && Number.isFinite(new Date(receipt.projectedAt).getTime())
    && Number.isFinite(new Date(receipt.expiresAt).getTime())
    && new Date(receipt.expiresAt).getTime() >= new Date(receipt.projectedAt).getTime()
    && (!(delivered || admitted || initialAdmitted) || (ID_RE.test(receipt.sessionId || "")
      && Number.isFinite(new Date(receipt.deliveryExpiresAt).getTime())
      && new Date(receipt.deliveryExpiresAt).getTime() >= new Date(receipt.projectedAt).getTime()
      && new Date(receipt.deliveryExpiresAt).getTime() <= new Date(receipt.expiresAt).getTime()))
    && (!admitted || (ID_RE.test(admission?.revalidationWindowId || "")
      && DIGEST_RE.test(admission?.revalidationWindowDigest || "")
      && Number.isInteger(admission?.slot) && admission.slot >= 1 && admission.slot <= 10
      && DIGEST_RE.test(admission?.evaluatorRootDigest || "")
      && (!trialBound || (ID_RE.test(admission?.evaluatorId || "") && ID_RE.test(admission?.runId || "")
        && DIGEST_RE.test(admission?.trialDigest || "")))
      && admission?.authority === "context-only"))
    && (!initialAdmitted || (ID_RE.test(initial?.evaluationId || "")
      && DIGEST_RE.test(initial?.evaluationDigest || "")
      && Number.isInteger(initial?.slot) && initial.slot >= 1 && initial.slot <= 10
      && ID_RE.test(initial?.evaluatorId || "") && DIGEST_RE.test(initial?.evaluatorRootDigest || "")
      && ID_RE.test(initial?.runId || "") && DIGEST_RE.test(initial?.trialDigest || "")
      && (!targetBound || DIGEST_RE.test(initial?.targetDigest || ""))
      && initial?.authority === "context-only"))
    && (!deadlineBound || (Number.isFinite(new Date(receipt.outcomeExpiresAt).getTime())
      && new Date(receipt.outcomeExpiresAt).getTime() >= new Date(receipt.deliveryExpiresAt).getTime()
      && new Date(receipt.outcomeExpiresAt).getTime() <= new Date(receipt.expiresAt).getTime()
      && DIGEST_RE.test(receipt.completionPolicyDigest || "")))
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

function initialAdmissionsMatchState(state) {
  const groups = new Map();
  for (const receipt of state.applications.filter((entry) => INITIAL_TRIAL_APPLICATIONS.has(entry.schema))) {
    const admission = receipt.initialAdmission;
    const contract = state.evaluations.find((entry) => entry.id === admission.evaluationId
      && entry.digest === admission.evaluationDigest);
    const candidate = state.candidates.find((entry) => entry.id === receipt.learningId)
      || state.history.find((entry) => entry.kind === "learning-candidate"
        && entry.value?.id === receipt.learningId)?.value;
    const trial = contract?.initialTrials?.after?.[admission.slot - 1];
    if (!candidate || !contract || (receipt.schema === "agentspine.learning-application/v5"
      ? contract.schema !== "agentspine.learning-evaluation/v8"
      : receipt.schema === "agentspine.learning-application/v6"
        ? contract.schema !== "agentspine.learning-evaluation/v9"
        : !DEADLINE_BOUND_EVALUATIONS.has(contract.schema))
      || contract.learningId !== receipt.learningId || contract.initialTrials.mode !== "first-admitted-trials"
      || (TARGET_BOUND_APPLICATIONS.has(receipt.schema)
        && (admission.targetDigest !== contract.target.digest || !learningTargetMatchesCandidate(contract.target, candidate)))
      || (DEADLINE_BOUND_APPLICATIONS.has(receipt.schema)
        && (receipt.completionPolicyDigest !== contract.completionPolicy.digest
          || receipt.deliveryExpiresAt !== new Date(Math.min(new Date(receipt.expiresAt).getTime(),
            new Date(receipt.projectedAt).getTime() + contract.completionPolicy.deliveryTimeoutMs)).toISOString()
          || receipt.outcomeExpiresAt !== new Date(Math.min(new Date(receipt.expiresAt).getTime(),
            new Date(receipt.projectedAt).getTime() + contract.completionPolicy.outcomeTimeoutMs)).toISOString()))
      || admission.slot > contract.initialTrials.requiredTrials
      || admission.evaluatorId !== trial?.evaluatorId
      || admission.evaluatorRootDigest !== trial?.evaluatorRootDigest
      || admission.runId !== trial?.runId || admission.trialDigest !== trial?.trialDigest
      || !exactScope(receipt.scope, contract.scope)
      || new Date(receipt.projectedAt).getTime() < new Date(contract.registeredAt).getTime()
      || new Date(receipt.projectedAt).getTime() > new Date(contract.expiresAt).getTime()) return false;
    const key = `${contract.id}\0${contract.digest}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(receipt);
  }
  return [...groups.values()].every((receipts) => {
    const ordered = [...receipts].sort((a, b) => a.initialAdmission.slot - b.initialAdmission.slot);
    return new Set(ordered.map((receipt) => receipt.initialAdmission.slot)).size === ordered.length
      && ordered.every((receipt, index) => receipt.initialAdmission.slot === index + 1);
  });
}

function trialFailurePayload({ id, learningId, evaluationId, evaluationDigest, applicationId, applicationDigest,
  slot, trialDigest, targetDigest, completionPolicyDigest, failure, deadline, observedAt }) {
  return {
    schema: "agentspine.learning-trial-failure/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    applicationId,
    applicationDigest,
    slot,
    trialDigest,
    targetDigest,
    completionPolicyDigest,
    failure,
    deadline,
    observedAt,
    authority: "context-only"
  };
}

function storedTrialFailureStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = trialFailurePayload(receipt);
  return receipt.schema === "agentspine.learning-trial-failure/v1"
    && [receipt.id, receipt.learningId, receipt.evaluationId, receipt.applicationId].every((value) => ID_RE.test(value || ""))
    && [receipt.evaluationDigest, receipt.applicationDigest, receipt.trialDigest, receipt.targetDigest,
      receipt.completionPolicyDigest].every((value) => DIGEST_RE.test(value || ""))
    && Number.isInteger(receipt.slot) && receipt.slot >= 1 && receipt.slot <= 10
    && ["delivery-timeout", "outcome-timeout"].includes(receipt.failure)
    && Number.isFinite(new Date(receipt.deadline).getTime())
    && Number.isFinite(new Date(receipt.observedAt).getTime())
    && new Date(receipt.observedAt).getTime() > new Date(receipt.deadline).getTime()
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

function trialFailureMatchesState(state, receipt) {
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId
    && entry.digest === receipt.evaluationDigest && entry.learningId === receipt.learningId);
  const application = state.applications.find((entry) => entry.id === receipt.applicationId
    && entry.digest === receipt.applicationDigest && entry.learningId === receipt.learningId);
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  if (!evaluation || !DEADLINE_BOUND_EVALUATIONS.has(evaluation.schema)
    || !application || application.schema !== "agentspine.learning-application/v7"
    || application.initialAdmission.evaluationId !== evaluation.id
    || application.initialAdmission.evaluationDigest !== evaluation.digest
    || application.initialAdmission.slot !== receipt.slot
    || application.initialAdmission.trialDigest !== receipt.trialDigest
    || application.initialAdmission.targetDigest !== receipt.targetDigest
    || receipt.targetDigest !== evaluation.target.digest
    || application.completionPolicyDigest !== receipt.completionPolicyDigest
    || receipt.completionPolicyDigest !== evaluation.completionPolicy.digest
    || candidate?.status !== "rolled-back"
    || candidate.rollback?.trialFailureId !== receipt.id
    || candidate.rollback?.trialFailureDigest !== receipt.digest) return false;
  const delivery = state.deliveries.find((entry) => entry.applicationId === application.id);
  const outcome = state.outcomes.find((entry) => entry.applicationId === application.id
    && entry.evaluationId === evaluation.id && entry.phase === "after");
  return receipt.failure === "delivery-timeout"
    ? receipt.deadline === application.deliveryExpiresAt && !delivery
    : receipt.deadline === application.outcomeExpiresAt && Boolean(delivery) && !outcome;
}

function trialFailureRevocationPayload({ id, learningId, evaluationId, evaluationDigest,
  evaluatorBindingDigest, applicationId, applicationDigest, trialFailureId, trialFailureDigest,
  targetDigest, scopeDigest, reasonCode, reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-trial-failure-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    evaluatorBindingDigest,
    applicationId,
    applicationDigest,
    trialFailureId,
    trialFailureDigest,
    targetDigest,
    scopeDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    retryPolicy: "fresh-candidate-and-contract-required",
    authority: "context-only"
  };
}

function storedTrialFailureRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = trialFailureRevocationPayload(receipt);
  return receipt.schema === "agentspine.learning-trial-failure-revocation/v1"
    && Object.keys(receipt).length === 18
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId",
      "evaluationDigest", "evaluatorBindingDigest", "applicationId", "applicationDigest",
      "trialFailureId", "trialFailureDigest", "targetDigest", "scopeDigest", "reasonCode",
      "reasonDigest", "revokedAt", "retryPolicy", "authority", "digest"].includes(field))
    && [receipt.id, receipt.learningId, receipt.evaluationId, receipt.applicationId,
      receipt.trialFailureId].every((value) => ID_RE.test(value || ""))
    && [receipt.evaluationDigest, receipt.evaluatorBindingDigest, receipt.applicationDigest,
      receipt.trialFailureDigest, receipt.targetDigest, receipt.scopeDigest,
      receipt.reasonDigest].every((value) => DIGEST_RE.test(value || ""))
    && TRIAL_FAILURE_REVOCATION_REASONS.has(receipt.reasonCode)
    && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.retryPolicy === "fresh-candidate-and-contract-required"
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

function trialFailureRevocationMatchesState(state, receipt) {
  const failure = state.trialFailures.find((entry) => entry.id === receipt.trialFailureId
    && entry.digest === receipt.trialFailureDigest);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId
    && entry.digest === receipt.evaluationDigest);
  const binding = state.evaluationBindings.find((entry) => entry.evaluationId === receipt.evaluationId
    && entry.evaluationDigest === receipt.evaluationDigest);
  const application = state.applications.find((entry) => entry.id === receipt.applicationId
    && entry.digest === receipt.applicationDigest);
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  return Boolean(failure && evaluation && binding && application && candidate
    && trialFailureMatchesState(state, failure)
    && failure.learningId === candidate.id && failure.evaluationId === evaluation.id
    && failure.applicationId === application.id
    && evaluation.learningId === candidate.id && application.learningId === candidate.id
    && binding.digest === receipt.evaluatorBindingDigest
    && failure.targetDigest === receipt.targetDigest
    && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && digest(application.scope) === receipt.scopeDigest && exactScope(application.scope, evaluation.scope));
}

function revokedTrialFailure(state, trialFailureId) {
  return state.trialFailureRevocations.find((receipt) => receipt.trialFailureId === trialFailureId) || null;
}

function evidenceIdentity(evidence) {
  return evidence.sourceSha256 || evidence.sourceDocument || evidence.id;
}

function retryableTrialFailures(state, candidate) {
  return state.trialFailureRevocations.map((revocation) => {
    const failure = state.trialFailures.find((entry) => entry.id === revocation.trialFailureId
      && entry.digest === revocation.trialFailureDigest);
    const predecessor = state.candidates.find((entry) => entry.id === revocation.learningId);
    return { revocation, failure, predecessor };
  }).filter(({ revocation, failure, predecessor }) => failure && predecessor
    && predecessor.id !== candidate.id && predecessor.status === "rolled-back"
    && predecessor.kind === candidate.kind && predecessor.claim === candidate.claim
    && predecessor.subjectId === candidate.subjectId && predecessor.privacy === candidate.privacy
    && predecessor.groupId === candidate.groupId && exactScope(predecessor.scope, candidate.scope)
    && trialFailureRevocationMatchesState(state, revocation))
    .sort((left, right) => new Date(left.revocation.revokedAt).getTime()
      - new Date(right.revocation.revokedAt).getTime());
}

function trialRetryMatchesState(state, contract) {
  if (!TRIAL_RETRY_EVALUATIONS.has(contract?.schema) || !storedTrialRetryStructure(contract.retry)) return false;
  const retry = contract.retry;
  const failure = state.trialFailures.find((entry) => entry.id === retry.trialFailureId
    && entry.digest === retry.trialFailureDigest);
  const revocation = state.trialFailureRevocations.find((entry) => entry.id === retry.trialFailureRevocationId
    && entry.digest === retry.trialFailureRevocationDigest && entry.trialFailureId === retry.trialFailureId);
  const predecessor = state.candidates.find((entry) => entry.id === retry.predecessorLearningId);
  const candidate = state.candidates.find((entry) => entry.id === retry.learningId);
  if (!failure || !revocation || !predecessor || !candidate
    || !trialFailureRevocationMatchesState(state, revocation)
    || predecessor.id !== failure.learningId || predecessor.status !== "rolled-back"
    || candidate.id !== contract.learningId
    || predecessor.kind !== candidate.kind || predecessor.claim !== candidate.claim
    || predecessor.subjectId !== candidate.subjectId || predecessor.privacy !== candidate.privacy
    || predecessor.groupId !== candidate.groupId || !exactScope(predecessor.scope, candidate.scope)
    || retry.targetDigest !== learningTargetForCandidate(candidate).digest
    || retry.scopeDigest !== digest(candidate.scope)
    || retry.minimumEvidenceObservedAt !== revocation.revokedAt
    || new Date(candidate.createdAt).getTime() <= new Date(revocation.revokedAt).getTime()) return false;
  const predecessorEvidence = new Set(predecessor.evidence.map(evidenceIdentity));
  const candidateEvidence = candidate.evidence.map(evidenceIdentity);
  return candidate.evidence.length >= Math.max(2, state.config.minEvidence)
    && new Set(candidateEvidence).size === candidateEvidence.length
    && candidate.evidence.every((entry) =>
    new Date(entry.observedAt).getTime() > new Date(revocation.revokedAt).getTime()
      && !predecessorEvidence.has(evidenceIdentity(entry)));
}

function revalidationAdmissionWindow(state, receipt) {
  const admission = receipt.revalidationAdmission;
  const candidates = [
    ...state.candidates,
    ...state.history.filter((entry) => entry.kind === "learning-candidate").map((entry) => entry.value)
  ];
  return candidates.find((candidate) => candidate?.id === receipt.learningId
    && candidate.promotion?.canary?.revalidation?.id === admission?.revalidationWindowId
    && candidate.promotion.canary.revalidation.digest === admission?.revalidationWindowDigest)
    ?.promotion?.canary?.revalidation || null;
}

function revalidationAdmissionsMatchState(state) {
  const admitted = state.applications.filter((receipt) => ["agentspine.learning-application/v3",
    "agentspine.learning-application/v4"].includes(receipt.schema));
  const groups = new Map();
  for (const receipt of admitted) {
    const window = revalidationAdmissionWindow(state, receipt);
    const admission = receipt.revalidationAdmission;
    const expectedWindowSchema = receipt.schema === "agentspine.learning-application/v4"
      ? "agentspine.learning-revalidation-window/v4" : "agentspine.learning-revalidation-window/v3";
    const expectedMode = receipt.schema === "agentspine.learning-application/v4"
      ? "first-admitted-trials" : "first-admitted-turns";
    const frozen = window?.selection?.evaluatorRoots?.[admission.slot - 1];
    if (!window || window.schema !== expectedWindowSchema
      || window.selection.mode !== expectedMode
      || admission.slot > window.selection.requiredDeliveries
      || admission.evaluatorRootDigest !== frozen?.evaluatorRootDigest
      || (receipt.schema === "agentspine.learning-application/v4"
        && (admission.evaluatorId !== frozen.evaluatorId || admission.runId !== frozen.runId
          || admission.trialDigest !== frozen.trialDigest))
      || new Date(receipt.projectedAt).getTime() < new Date(window.startedAt).getTime()
      || new Date(receipt.projectedAt).getTime() > new Date(window.expiresAt).getTime()) return false;
    const key = `${window.id}\0${window.digest}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(receipt);
  }
  return [...groups.values()].every((receipts) => {
    const ordered = [...receipts].sort((a, b) => a.revalidationAdmission.slot - b.revalidationAdmission.slot);
    return new Set(ordered.map((receipt) => receipt.revalidationAdmission.slot)).size === ordered.length
      && ordered.every((receipt, index) => receipt.revalidationAdmission.slot === index + 1);
  });
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

function applicationRevocationPayload({ id, learningId, evaluationId, evaluationDigest, applicationId,
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

function storedApplicationRevocationStructure(receipt) {
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

function applicationRevocationMatchesState(state, receipt) {
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

function revokedApplication(state, applicationId) {
  return state.applicationRevocations.find((receipt) => receipt.applicationId === applicationId) || null;
}

function revokedApplicationForCandidate(state, candidate) {
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

function deliveryRevocationPayload({ id, learningId, evaluationId, evaluationDigest, applicationId,
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

function storedDeliveryRevocationStructure(receipt) {
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

function deliveryRevocationMatchesState(state, receipt) {
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

function revokedDelivery(state, deliveryId) {
  return state.deliveryRevocations.find((receipt) => receipt.deliveryId === deliveryId) || null;
}

function revokedDeliveryForCandidate(state, candidate) {
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

function outcomeRevocationPayload({ id, learningId, evaluationId, evaluationDigest, outcomeId, outcomeDigest,
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

function storedOutcomeRevocationStructure(receipt) {
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

function outcomeRevocationMatchesState(state, receipt) {
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

function revokedOutcome(state, outcomeId) {
  return state.outcomeRevocations.find((receipt) => receipt.outcomeId === outcomeId) || null;
}

function referencedValidationOutcomeIds(state, candidate) {
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

function revokedOutcomeForCandidate(state, candidate) {
  const revocations = state.outcomeRevocations.filter((receipt) => receipt.learningId === candidate?.id);
  if (!revocations.length) return null;
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (!canary?.evaluationId) return revocations[0];
  const referenced = referencedValidationOutcomeIds(state, candidate);
  return revocations.find((receipt) => receipt.evaluationId === canary.evaluationId
    && (referenced.has(receipt.outcomeId) || canary.status === "active")) || null;
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
    if (revokedEvidence(state, previous)) {
      throw new Error("revoked evidence freezes this learning target; propose a superseding candidate instead");
    }
    if (state.measurementRevocations.some((receipt) => receipt.learningId === id)) {
      throw new Error("revoked measurement evidence freezes this learning target; propose a superseding candidate instead");
    }
    if (state.outcomeRevocations.some((receipt) => receipt.learningId === id)) {
      throw new Error("revoked outcome evidence freezes this learning target; propose a superseding candidate instead");
    }
    if (state.evaluations.some((contract) => contract.learningId === id
      && TARGET_BOUND_EVALUATIONS.has(contract.schema))) {
      throw new Error("evaluated learning target is immutable; propose a superseding candidate and evaluation contract");
    }
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

export async function revokeLearningEvidence({
  root = process.cwd(), learningId, evidenceId, reasonCode, reason,
  confirmation, now = new Date()
}) {
  if (confirmation !== "local-evidence-revocation-confirmed") {
    throw new Error("evidence revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(learningId || "") || !ID_RE.test(evidenceId || "")) {
    throw new Error("learningId and evidenceId must be stable identifiers");
  }
  if (!EVIDENCE_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be retracted, source-invalid, measurement-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (!candidate) throw new Error(`unknown learning candidate: ${learningId}`);
    const evidence = candidate.evidence.find((entry) => entry.id === evidenceId);
    if (!evidence) throw new Error(`unknown learning evidence: ${evidenceId}`);
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const id = `evidence-revocation:${createHash("sha256")
      .update(`${learningId}\0${evidenceId}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const existing = state.evidenceRevocations.find((entry) => entry.learningId === learningId
      && entry.evidenceId === evidenceId);
    const reasonDigest = digest(revokeReason);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.evidenceDigest !== digest(evidence) || existing.targetDigest !== targetDigest) {
        throw new Error("learning evidence revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const payload = evidenceRevocationPayload({
      id, learningId, evidenceId, evidenceDigest: digest(evidence), targetDigest, reasonCode,
      reasonDigest, revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.evidenceRevocations.push(receipt);
    state.evidenceRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
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
      if (revokedEvidence(state, candidate)) throw new Error("learning evidence was revoked; propose a new candidate before acceptance");
      if (revokedMeasurementForCandidate(state, candidate)) {
        throw new Error("learning measurement was revoked; propose a new candidate before acceptance");
      }
      if (revokedOutcomeForCandidate(state, candidate)) {
        throw new Error("learning outcome was revoked; propose a new candidate before acceptance");
      }
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
  evaluatorIds, evaluatorRoots, expiresAt = null, retryTrialFailureId = null,
  confirmLocalEvaluation = false, confirmLocalTrialRetry = false, now = new Date()
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
    const requestedEvaluators = [...new Set((evaluatorIds || []).map((value) => String(value)))];
    const normalizedEvaluators = [...requestedEvaluators].sort();
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
    const normalizedMetric = { name, direction };
    const normalizedBenchmark = {
      ...digests, minCases: integer(benchmark?.minCases, "evaluation.benchmark.minCases", 1, 1000000)
    };
    const selectedRoots = requestedEvaluators.slice(0, requiredEvaluators).map((evaluatorId) => {
      const rootRecord = registeredRoots.find((record) => record.id === evaluatorId);
      return { evaluatorId, evaluatorRootDigest: rootRecord.principalDigest };
    });
    const trialsForPhase = (phase) => selectedRoots.map((rootRecord, index) => {
      const trial = {
        slot: index + 1,
        evaluatorId: rootRecord.evaluatorId,
        evaluatorRootDigest: rootRecord.evaluatorRootDigest,
        runId: `run:initial:${phase}:${digest([id, learningId, normalizedScope, normalizedMetric,
          normalizedBenchmark, phase, index + 1, rootRecord.evaluatorId,
          rootRecord.evaluatorRootDigest]).slice(0, 32)}`,
        caseCount: normalizedBenchmark.minCases,
        authority: "context-only"
      };
      return { ...trial, trialDigest: initialTrialDigest({
        evaluationId: id, learningId, scope: normalizedScope, metric: normalizedMetric,
        benchmark: normalizedBenchmark, phase, slot: trial.slot, evaluatorId: trial.evaluatorId,
        evaluatorRootDigest: trial.evaluatorRootDigest, runId: trial.runId, caseCount: trial.caseCount
      }) };
    });
    const initialTrials = {
      schema: "agentspine.learning-initial-trials/v1",
      mode: "first-admitted-trials",
      requiredTrials: requiredEvaluators,
      benchmarkDigest: digest(normalizedBenchmark),
      before: trialsForPhase("before"),
      after: trialsForPhase("after"),
      authority: "context-only"
    };
    const target = learningTargetForCandidate(candidate);
    const retryable = retryableTrialFailures(state, candidate);
    let retry = null;
    if (retryable.length) {
      if (!confirmLocalTrialRetry) {
        throw new Error("a repeated failed learning requires explicit local trial-retry confirmation");
      }
      if (!ID_RE.test(retryTrialFailureId || "")) {
        throw new Error("retryTrialFailureId must identify the revoked failure being retried");
      }
      const selected = retryable.find((entry) => entry.failure.id === retryTrialFailureId);
      const latest = retryable[retryable.length - 1];
      if (!selected || selected.revocation.id !== latest.revocation.id) {
        throw new Error("trial retry must bind the latest matching revoked failure");
      }
      const retryPayload = trialRetryPayload({
        trialFailureId: selected.failure.id,
        trialFailureDigest: selected.failure.digest,
        trialFailureRevocationId: selected.revocation.id,
        trialFailureRevocationDigest: selected.revocation.digest,
        predecessorLearningId: selected.predecessor.id,
        learningId: candidate.id,
        targetDigest: target.digest,
        scopeDigest: digest(candidate.scope),
        minimumEvidenceObservedAt: selected.revocation.revokedAt,
        admittedAt: timestamp
      });
      retry = { ...retryPayload, digest: digest(retryPayload) };
    } else if (retryTrialFailureId !== null || confirmLocalTrialRetry) {
      throw new Error("trial retry confirmation does not match a revoked failure for this exact learning scope");
    }
    const completionPolicyPayloadValue = completionPolicyPayload({
      deliveryTimeoutMs: 5 * 60_000,
      outcomeTimeoutMs: state.config.initialTrialOutcomeTimeoutMinutes * 60_000
    });
    const completionPolicy = {
      ...completionPolicyPayloadValue,
      digest: digest(completionPolicyPayloadValue)
    };
    const payload = evaluationPayload({
      schema: retry ? "agentspine.learning-evaluation/v11" : "agentspine.learning-evaluation/v10",
      id, learningId, scope: normalizedScope, metric: normalizedMetric,
      benchmark: normalizedBenchmark,
      evaluatorIds: normalizedEvaluators,
      evaluatorRoots: normalizedRoots,
      thresholds: {
        minImprovement: state.config.minImprovement,
        regressionTolerance: state.config.regressionTolerance,
        beforeReceipts: requiredEvaluators,
        afterReceipts: requiredEvaluators
      },
      pairing: {
        mode: "same-evaluator",
        maxOutcomesPerEvaluatorPerPhase: 1,
        matchMeasurementKind: true,
        matchCaseCount: true,
        authority: "context-only"
      },
      initialTrials,
      target,
      completionPolicy,
      retry,
      registeredAt: timestamp, expiresAt: expiry
    });
    const contract = { ...payload, digest: digest(payload) };
    if (retry && !trialRetryMatchesState(state, contract)) {
      throw new Error("trial retry requires a fresh candidate and independently observed evidence after revocation");
    }
    const existing = state.evaluations.find((entry) => entry.id === id);
    if (existing) {
      if (existing.digest === contract.digest) {
        const binding = state.evaluationBindings.find((entry) => entry.evaluationId === existing.id) || null;
        return { contract: existing, binding, learningPath, unchanged: true };
      }
      throw new Error("evaluation contract IDs are immutable");
    }
    if (retry && state.evaluations.some((entry) => TRIAL_RETRY_EVALUATIONS.has(entry.schema)
      && entry.retry.trialFailureRevocationId === retry.trialFailureRevocationId)) {
      throw new Error("the revoked trial failure already has an immutable retry contract");
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

export async function revokeLearningEvaluation({
  root = process.cwd(), evaluationId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-evaluation-revocation-confirmed") {
    throw new Error("evaluation revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(evaluationId || "")) throw new Error("evaluationId must be a stable identifier");
  if (!EVALUATION_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be benchmark-invalid, protocol-invalid, scope-invalid, threshold-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    if (!evaluation) throw new Error(`unknown learning evaluation: ${evaluationId}`);
    const candidate = state.candidates.find((entry) => entry.id === evaluation.learningId);
    if (!candidate) throw new Error("evaluation revocation requires its immutable candidate lineage");
    const binding = state.evaluationBindings.find((entry) => entry.evaluationId === evaluation.id
      && entry.evaluationDigest === evaluation.digest) || null;
    if (REGISTRY_BOUND_EVALUATIONS.has(evaluation.schema) && !binding) {
      throw new Error("evaluation revocation requires its immutable evaluator binding");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedEvaluation(state, evaluationId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.learningId !== candidate.id || existing.evaluationDigest !== evaluation.digest
        || existing.evaluatorBindingDigest !== (binding?.digest || null)
        || existing.targetDigest !== targetDigest) {
        throw new Error("learning evaluation revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `evaluation-revocation:${createHash("sha256")
      .update(`${evaluation.id}\0${evaluation.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = evaluationRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      evaluatorBindingDigest: binding?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.evaluationRevocations.push(receipt);
    state.evaluationRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export async function revokeLearningValidation({
  root = process.cwd(), validationLeaseId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-validation-revocation-confirmed") {
    throw new Error("validation revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(validationLeaseId || "")) throw new Error("validationLeaseId must be a stable identifier");
  if (!VALIDATION_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be decision-invalid, cohort-invalid, binding-invalid, scope-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const lease = validationLeaseRecord(state, validationLeaseId);
    if (!lease || !storedValidationLeaseStructure(lease)) {
      throw new Error(`unknown learning validation lease: ${validationLeaseId}`);
    }
    const candidate = state.candidates.find((entry) => entry.id === lease.learningId);
    const evaluation = state.evaluations.find((entry) => entry.id === lease.evaluationId
      && entry.digest === lease.evaluationDigest);
    const binding = state.evaluationBindings.find((entry) => entry.evaluationId === lease.evaluationId
      && entry.evaluationDigest === lease.evaluationDigest);
    if (!candidate || !evaluation || !binding || binding.digest !== lease.evaluatorRegistryBindingDigest) {
      throw new Error("validation revocation requires its immutable candidate, evaluation, and evaluator binding");
    }
    const activeChain = validationLeaseChain(state, candidate);
    if (!activeChain.some((entry) => entry.id === lease.id && entry.digest === lease.digest)) {
      throw new Error("validation revocation requires a lease in the candidate's current immutable validation chain");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const scopeDigest = digest(lease.scope);
    const reasonDigest = digest(revokeReason);
    const existing = revokedValidation(state, validationLeaseId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.learningId !== candidate.id || existing.evaluationId !== evaluation.id
        || existing.evaluationDigest !== evaluation.digest || existing.evaluatorBindingDigest !== binding.digest
        || existing.validationLeaseDigest !== lease.digest || existing.targetDigest !== targetDigest
        || existing.scopeDigest !== scopeDigest) {
        throw new Error("learning validation revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `validation-revocation:${createHash("sha256")
      .update(`${lease.id}\0${lease.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = validationRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      evaluatorBindingDigest: binding.digest,
      validationLeaseId: lease.id,
      validationLeaseDigest: lease.digest,
      targetDigest,
      scopeDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.validationRevocations.push(receipt);
    state.validationRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
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
    if (revokedEvaluationForCandidate(state, candidate)) {
      throw new Error("revalidation baseline contains an explicitly revoked evaluation contract");
    }
    if (revokedApplicationForCandidate(state, candidate)) {
      throw new Error("revalidation baseline contains an explicitly revoked application");
    }
    if (revokedOutcomeForCandidate(state, candidate)) {
      throw new Error("revalidation baseline contains an explicitly revoked outcome");
    }
    const validation = validationLeaseState(state, candidate, timestamp);
    if (validation.status !== "active"
      || !REGISTRY_BOUND_EVALUATIONS.has(validation.evaluation?.schema)) {
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
    const baselineReferences = validation.lease.schema === "agentspine.learning-validation/v1"
      ? validation.lease.beforeOutcomes : validation.lease.baselineOutcomes;
    const baselines = baselineReferences.map((reference) => state.outcomes.find((outcome) =>
      outcome.id === reference.id && outcome.digest === reference.digest));
    if (baselines.some((outcome) => outcome?.schema !== "agentspine.learning-outcome/v9"
      || !DIGEST_RE.test(outcome.measurement?.evaluatorRootDigest || ""))) {
      throw new Error("revalidation requires a complete root-bound frozen baseline cohort");
    }
    const orderedRoots = [...baselines].sort((a, b) => a.measurement.evaluatorId.localeCompare(b.measurement.evaluatorId))
      .map((outcome, index) => {
        const trial = {
          evaluationId: validation.evaluation.id,
          evaluationDigest: validation.evaluation.digest,
          predecessorValidationId: validation.lease.id,
          predecessorValidationDigest: validation.lease.digest,
          slot: index + 1,
          evaluatorId: outcome.measurement.evaluatorId,
          evaluatorRootDigest: outcome.measurement.evaluatorRootDigest,
          runId: `run:revalidation:${randomUUID()}`,
          benchmark: validation.evaluation.benchmark,
          caseCount: outcome.coverage.caseCount
        };
        return { slot: trial.slot, evaluatorId: trial.evaluatorId,
          evaluatorRootDigest: trial.evaluatorRootDigest, runId: trial.runId,
          caseCount: trial.caseCount, trialDigest: revalidationTrialDigest(trial), authority: "context-only" };
      });
    const revalidationPayload = revalidationWindowPayload({
      schema: "agentspine.learning-revalidation-window/v4",
      id: `revalidation:${randomUUID()}`,
      status: "active",
      startedAt: timestamp,
      expiresAt: validation.lease.expiresAt,
      predecessorValidationId: validation.lease.id,
      predecessorValidationDigest: validation.lease.digest,
      selection: { mode: "first-admitted-trials", requiredDeliveries: orderedRoots.length,
        evaluatorRoots: orderedRoots, authority: "context-only" }
    });
    const revalidation = { ...revalidationPayload, digest: digest(revalidationPayload) };
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
  return leases.some((lease) => ["agentspine.learning-validation/v2", "agentspine.learning-validation/v3",
    "agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease?.schema)
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
    if (revokedEvaluationForCandidate(state, candidate)) {
      throw new Error("validation renewal baseline contains an explicitly revoked evaluation contract");
    }
    if (revokedApplicationForCandidate(state, candidate)) {
      throw new Error("validation renewal baseline contains an explicitly revoked application");
    }
    if (revokedOutcomeForCandidate(state, candidate)) {
      throw new Error("validation renewal baseline contains an explicitly revoked outcome");
    }
    const validation = validationLeaseState(state, candidate, timestamp);
    const revalidation = candidate?.promotion?.canary?.revalidation;
    if (validation.status !== "active"
      || !REGISTRY_BOUND_EVALUATIONS.has(validation.evaluation?.schema)
      || revalidation?.status !== "active" || revalidation.predecessorValidationId !== validation.lease.id
      || revalidation.predecessorValidationDigest !== validation.lease.digest
      || !storedRevalidationWindowStructure(revalidation)
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
    let normalized = evidence.map((entry) => {
      const measurement = state.measurements.find((item) => item.id === entry?.measurementId);
      const application = state.applications.find((item) => item.id === entry?.applicationId);
      const delivery = state.deliveries.find((item) => item.id === entry?.deliveryId);
      if (!measurement || !application || !delivery) throw new Error("validation renewal evidence binding is missing");
      if (revokedApplication(state, application.id)) {
        throw new Error("validation renewal application was explicitly revoked");
      }
      if (revokedMeasurement(state, measurement.id)) {
        throw new Error("validation renewal measurement was explicitly revoked");
      }
      if (revokedDelivery(state, delivery.id)) {
        throw new Error("validation renewal delivery was explicitly revoked");
      }
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
    let selectionProof = null;
    if (revalidation.schema === "agentspine.learning-revalidation-window/v2") {
      const required = revalidation.selection.requiredDeliveries;
      if (normalized.length !== required) {
        throw new Error("validation renewal must measure the complete precommitted delivery cohort");
      }
      const completed = state.deliveries.filter((delivery) => delivery.learningId === learningId
        && exactScope(delivery.scope, contract.scope)
        && new Date(delivery.completedAt).getTime() >= new Date(revalidation.startedAt).getTime()
        && new Date(delivery.completedAt).getTime() <= new Date(revalidation.expiresAt).getTime()
        && state.applications.some((application) => application.id === delivery.applicationId
          && application.learningId === learningId && exactScope(application.scope, contract.scope)
          && new Date(application.projectedAt).getTime() >= new Date(revalidation.startedAt).getTime()))
        .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id))
        .slice(0, required);
      if (completed.length !== required) {
        throw new Error("validation renewal first-completed delivery cohort is not complete");
      }
      normalized = completed.map((delivery, index) => {
        const selected = normalized.find((item) => item.delivery.id === delivery.id);
        const frozenRoot = revalidation.selection.evaluatorRoots[index];
        if (!selected) {
          throw new Error("validation renewal cannot omit or replace a precommitted completed turn");
        }
        if (selected.measurement.measurement.evaluatorRootDigest !== frozenRoot.evaluatorRootDigest) {
          throw new Error("validation renewal evaluator root does not match its precommitted turn slot");
        }
        return selected;
      });
      selectionProof = {
        revalidationWindowId: revalidation.id,
        revalidationWindowDigest: revalidation.digest,
        mode: revalidation.selection.mode,
        requiredDeliveries: required,
        deliveries: normalized.map((item, index) => ({
          slot: index + 1,
          deliveryId: item.delivery.id,
          deliveryDigest: item.delivery.digest,
          evaluatorRootDigest: item.measurement.measurement.evaluatorRootDigest,
          authority: "context-only"
        })),
        authority: "context-only"
      };
    } else if (["agentspine.learning-revalidation-window/v3",
      "agentspine.learning-revalidation-window/v4"].includes(revalidation.schema)) {
      const required = revalidation.selection.requiredDeliveries;
      if (normalized.length !== required) {
        throw new Error("validation renewal must measure the complete precommitted admission cohort");
      }
      const trialBound = revalidation.schema === "agentspine.learning-revalidation-window/v4";
      const admitted = state.applications.filter((application) =>
        application.schema === (trialBound ? "agentspine.learning-application/v4" : "agentspine.learning-application/v3")
        && application.learningId === learningId && exactScope(application.scope, contract.scope)
        && application.revalidationAdmission.revalidationWindowId === revalidation.id
        && application.revalidationAdmission.revalidationWindowDigest === revalidation.digest)
        .sort((a, b) => a.revalidationAdmission.slot - b.revalidationAdmission.slot);
      if (admitted.length !== required) {
        throw new Error("validation renewal first-admitted turn cohort is not complete");
      }
      normalized = admitted.map((application, index) => {
        const selected = normalized.find((item) => item.application.id === application.id);
        const admission = application.revalidationAdmission;
        const frozenRoot = revalidation.selection.evaluatorRoots[index];
        if (!selected) {
          throw new Error("validation renewal cannot omit or replace a precommitted admitted turn");
        }
        if (admission.slot !== index + 1 || admission.evaluatorRootDigest !== frozenRoot.evaluatorRootDigest
          || selected.measurement.measurement.evaluatorRootDigest !== frozenRoot.evaluatorRootDigest
          || (trialBound && (admission.evaluatorId !== frozenRoot.evaluatorId
            || admission.runId !== frozenRoot.runId || admission.trialDigest !== frozenRoot.trialDigest
            || selected.measurement.measurement.evaluatorId !== frozenRoot.evaluatorId
            || selected.measurement.measurement.runId !== frozenRoot.runId
            || selected.measurement.coverage.caseCount !== frozenRoot.caseCount
            || frozenRoot.trialDigest !== revalidationTrialDigest({
              evaluationId: contract.id, evaluationDigest: contract.digest,
              predecessorValidationId: validation.lease.id,
              predecessorValidationDigest: validation.lease.digest,
              slot: frozenRoot.slot, evaluatorId: frozenRoot.evaluatorId,
              evaluatorRootDigest: frozenRoot.evaluatorRootDigest, runId: frozenRoot.runId,
              benchmark: contract.benchmark, caseCount: frozenRoot.caseCount
            })))) {
          throw new Error("validation renewal evaluator root does not match its precommitted admission slot");
        }
        return selected;
      });
      selectionProof = {
        revalidationWindowId: revalidation.id,
        revalidationWindowDigest: revalidation.digest,
        mode: revalidation.selection.mode,
        requiredDeliveries: required,
        applications: normalized.map((item, index) => ({
          slot: index + 1,
          applicationId: item.application.id,
          applicationDigest: item.application.digest,
          deliveryId: item.delivery.id,
          deliveryDigest: item.delivery.digest,
          evaluatorRootDigest: item.measurement.measurement.evaluatorRootDigest,
          ...(trialBound ? {
            evaluatorId: item.measurement.measurement.evaluatorId,
            runId: item.measurement.measurement.runId,
            trialDigest: revalidation.selection.evaluatorRoots[index].trialDigest
          } : {}),
          authority: "context-only"
        })),
        authority: "context-only"
      };
    }
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
      schema: selectionProof?.mode === "first-admitted-trials" ? "agentspine.learning-validation/v5"
        : selectionProof?.mode === "first-admitted-turns" ? "agentspine.learning-validation/v4"
        : selectionProof ? "agentspine.learning-validation/v3" : "agentspine.learning-validation/v2",
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
      selectionProof,
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
    if (!candidate || !evaluation || !LINEAGE_EVALUATIONS.has(evaluation.schema)
      || evaluation.learningId !== learningId) {
      throw new Error("measurements require a matching lineage evaluation contract");
    }
    if (revokedEvaluation(state, evaluation.id)) {
      throw new Error("learning evaluation contract was explicitly revoked and cannot accept measurements");
    }
    if (REGISTRY_BOUND_EVALUATIONS.has(evaluation.schema)
      && !activeEvaluationBinding(state, evaluation)) {
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
    if (activeRevalidation && revokedValidationForCandidate(state, candidate)) {
      throw new Error("learning validation decision was explicitly revoked and cannot accept renewal measurements");
    }
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
    const evaluatorRoot = ROOT_BOUND_EVALUATIONS.has(evaluation.schema)
      ? evaluation.evaluatorRoots.find((root) => root.evaluatorId === evaluatorId) : null;
    if (ROOT_BOUND_EVALUATIONS.has(evaluation.schema) && !evaluatorRoot) {
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
    const initialTrial = INITIAL_TRIAL_EVALUATIONS.has(evaluation.schema) && !activeRevalidation
      ? evaluation.initialTrials?.[phase]?.find((entry) => entry.evaluatorId === evaluatorId) : null;
    if (INITIAL_TRIAL_EVALUATIONS.has(evaluation.schema) && !activeRevalidation
      && (!initialTrial || initialTrial.evaluatorRootDigest !== evaluatorRoot?.principalDigest
        || initialTrial.runId !== runId || initialTrial.caseCount !== normalizedCoverage.caseCount)) {
      throw new Error("measurement does not match the precommitted initial trial");
    }
    const observedAt = date(measuredAt || existing?.measuredAt || timestamp, "measurement.measuredAt");
    if (new Date(observedAt).getTime() < new Date(evaluation.registeredAt).getTime()
      || new Date(observedAt).getTime() > new Date(evaluation.expiresAt).getTime()
      || (!existing && new Date(observedAt).getTime() > new Date(timestamp).getTime())) {
      throw new Error("measurement is outside its evaluation contract window");
    }
    if (INITIAL_TRIAL_EVALUATIONS.has(evaluation.schema) && phase === "after" && !activeRevalidation) {
      const application = state.applications.find((entry) => INITIAL_TRIAL_APPLICATIONS.has(entry.schema)
        && entry.learningId === learningId && entry.initialAdmission.evaluationId === evaluation.id
        && entry.initialAdmission.evaluationDigest === evaluation.digest
        && entry.initialAdmission.slot === initialTrial.slot
        && entry.initialAdmission.trialDigest === initialTrial.trialDigest
        && (!TARGET_BOUND_EVALUATIONS.has(evaluation.schema)
          || (TARGET_BOUND_APPLICATIONS.has(entry.schema)
            && entry.initialAdmission.targetDigest === evaluation.target.digest)));
      const delivery = application && state.deliveries.find((entry) => entry.applicationId === application.id);
      if (!application || revokedApplication(state, application.id) || !delivery || revokedDelivery(state, delivery.id)
        || new Date(observedAt).getTime() < new Date(delivery.completedAt).getTime()) {
        throw new Error("after measurement requires the precommitted first-admitted trial and completed delivery");
      }
      if (DEADLINE_BOUND_APPLICATIONS.has(application.schema)
        && (new Date(observedAt).getTime() > new Date(application.outcomeExpiresAt).getTime()
          || (!existing && new Date(timestamp).getTime() > new Date(application.outcomeExpiresAt).getTime()))) {
        throw new Error("after measurement missed its immutable initial trial outcome deadline");
      }
    }
    if (phase === "after" && activeRevalidation) {
      const application = state.applications.find((entry) => entry.schema === "agentspine.learning-application/v4"
        && entry.learningId === learningId
        && entry.revalidationAdmission.evaluatorId === evaluatorId
        && entry.revalidationAdmission.evaluatorRootDigest === evaluatorRoot?.principalDigest
        && entry.revalidationAdmission.runId === runId);
      const delivery = application && state.deliveries.find((entry) => entry.applicationId === application.id);
      if (!application || revokedApplication(state, application.id) || !delivery || revokedDelivery(state, delivery.id)
        || new Date(observedAt).getTime() < new Date(delivery.completedAt).getTime()) {
        throw new Error("revalidation measurement requires its precommitted admission slot and completed delivery");
      }
    }
    const payload = measurementPayload({
      schema: ROOT_BOUND_EVALUATIONS.has(evaluation.schema)
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
    if (PAIRED_EVALUATIONS.has(evaluation.schema) && phase === "after") {
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

export async function revokeLearningMeasurement({
  root = process.cwd(), measurementId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-measurement-revocation-confirmed") {
    throw new Error("measurement revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(measurementId || "")) throw new Error("measurementId must be a stable identifier");
  if (!MEASUREMENT_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be source-invalid, evaluator-invalid, protocol-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const measurement = state.measurements.find((entry) => entry.id === measurementId);
    if (!measurement) throw new Error(`unknown learning measurement: ${measurementId}`);
    const candidate = state.candidates.find((entry) => entry.id === measurement.learningId);
    const evaluation = state.evaluations.find((entry) => entry.id === measurement.evaluationId);
    if (!candidate || !evaluation || evaluation.learningId !== candidate.id) {
      throw new Error("measurement revocation requires its bound candidate and evaluation contract");
    }
    const outcome = state.outcomes.find((entry) => entry.measurementReceiptId === measurement.id) || null;
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedMeasurement(state, measurementId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.measurementDigest !== measurement.digest || existing.evaluationDigest !== evaluation.digest
        || existing.targetDigest !== targetDigest || existing.outcomeId !== (outcome?.id || null)
        || existing.outcomeDigest !== (outcome?.digest || null)) {
        throw new Error("learning measurement revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `measurement-revocation:${createHash("sha256")
      .update(`${measurement.id}\0${measurement.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = measurementRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      measurementId: measurement.id,
      measurementDigest: measurement.digest,
      outcomeId: outcome?.id || null,
      outcomeDigest: outcome?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.measurementRevocations.push(receipt);
    state.measurementRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
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
  const lineageRequired = LINEAGE_EVALUATIONS.has(evaluation?.schema);
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
  const evaluatorRoot = ROOT_BOUND_EVALUATIONS.has(evaluation.schema)
    ? evaluation.evaluatorRoots.find((root) => root.evaluatorId === evaluatorId) : null;
  if (ROOT_BOUND_EVALUATIONS.has(evaluation.schema)
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
  const coverageRequired = COVERAGE_EVALUATIONS.has(evaluation.schema);
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
    if (DEADLINE_BOUND_APPLICATIONS.has(application.schema)
      && new Date(measuredAt).getTime() > new Date(application.outcomeExpiresAt).getTime()) {
      throw new Error("after outcome missed its immutable initial trial outcome deadline");
    }
    if (!ID_RE.test(deliveryId || "") || !delivery || delivery.applicationId !== application.id
      || delivery.learningId !== candidate.id || !exactScope(delivery.scope, scope)) {
      throw new Error("after outcomes require the matching completed model-turn delivery receipt");
    }
    if (new Date(measuredAt).getTime() < new Date(delivery.completedAt).getTime()) {
      throw new Error("after outcome predates the completed model-turn delivery");
    }
    if (INITIAL_TRIAL_EVALUATIONS.has(evaluation.schema)
      && application.schema !== "agentspine.learning-application/v4") {
      const trial = evaluation.initialTrials.after.find((entry) =>
        entry.evaluatorId === measurementReceipt.measurement.evaluatorId);
      if (!trial || !INITIAL_TRIAL_APPLICATIONS.has(application.schema)
        || application.initialAdmission.evaluationId !== evaluation.id
        || application.initialAdmission.evaluationDigest !== evaluation.digest
        || application.initialAdmission.slot !== trial.slot
        || application.initialAdmission.trialDigest !== trial.trialDigest
        || (TARGET_BOUND_EVALUATIONS.has(evaluation.schema)
          && (!TARGET_BOUND_APPLICATIONS.has(application.schema)
            || application.initialAdmission.targetDigest !== evaluation.target.digest))) {
        throw new Error("after outcome does not match its precommitted first-admitted trial");
      }
    }
  }
  const payload = outcomePayload({ schema: ROOT_BOUND_EVALUATIONS.has(evaluation.schema)
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
    const pending = state.applications.filter((application) =>
      DELIVERABLE_APPLICATIONS.has(application.schema)
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
        || revokedEvaluationForCandidate(state, candidate)
        || revokedValidationForCandidate(state, candidate)
        || revokedApplicationForCandidate(state, candidate)
        || (revalidating ? canary?.status !== "validated" || canary.revalidation?.status !== "active"
          || new Date(canary.revalidation.expiresAt).getTime() < new Date(timestamp).getTime()
          : canary?.status !== "active")
        || !exactScope(canary.scope, runtimeScope)) {
        throw new Error(`active learning application no longer matches its exact scope: ${item.id || "unknown"}`);
      }
      const expiresAt = revalidating ? canary.revalidation.expiresAt : canary.expiresAt;
      let deliveryExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
        new Date(timestamp).getTime() + 5 * 60_000)).toISOString();
      let outcomeExpiresAt;
      let completionPolicyDigest;
      const material = `${candidate.id}\0${preflightReceipt.id}\0${sessionBriefingDigest}`;
      const id = `application:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
      const existing = state.applications.find((entry) => entry.id === id);
      if (existing) {
        const sameBinding = existing.learningId === candidate.id && exactScope(existing.scope, runtimeScope)
          && existing.preflightReceiptId === preflightReceipt.id && existing.promptDigest === preflightReceipt.promptDigest
          && existing.preflightBriefingDigest === preflightReceipt.briefingDigest
          && existing.sessionBriefingDigest === sessionBriefingDigest;
        if (!sameBinding) throw new Error("learning application receipt IDs are immutable");
        receipts.push(existing);
        continue;
      }
      let schema = "agentspine.learning-application/v2";
      let revalidationAdmission;
      let initialAdmission;
      if (revalidating && ["agentspine.learning-revalidation-window/v3",
        "agentspine.learning-revalidation-window/v4"].includes(canary.revalidation.schema)) {
        const window = canary.revalidation;
        const priorAdmissions = state.applications.filter((application) =>
          ["agentspine.learning-application/v3", "agentspine.learning-application/v4"].includes(application.schema)
          && application.revalidationAdmission.revalidationWindowId === window.id
          && application.revalidationAdmission.revalidationWindowDigest === window.digest);
        if (priorAdmissions.length < window.selection.requiredDeliveries) {
          const slot = priorAdmissions.length + 1;
          const trial = window.selection.evaluatorRoots[slot - 1];
          schema = window.schema === "agentspine.learning-revalidation-window/v4"
            ? "agentspine.learning-application/v4" : "agentspine.learning-application/v3";
          revalidationAdmission = {
            revalidationWindowId: window.id,
            revalidationWindowDigest: window.digest,
            slot,
            evaluatorRootDigest: trial.evaluatorRootDigest,
            ...(schema === "agentspine.learning-application/v4" ? {
              evaluatorId: trial.evaluatorId, runId: trial.runId, trialDigest: trial.trialDigest
            } : {}),
            authority: "context-only"
          };
        }
      }
      if (!revalidating) {
        const evaluation = state.evaluations.find((entry) => entry.id === canary.evaluationId
          && entry.digest === canary.evaluationDigest && entry.learningId === candidate.id);
        if (INITIAL_TRIAL_EVALUATIONS.has(evaluation?.schema)) {
          const priorAdmissions = state.applications.filter((application) =>
            INITIAL_TRIAL_APPLICATIONS.has(application.schema)
            && application.initialAdmission.evaluationId === evaluation.id
            && application.initialAdmission.evaluationDigest === evaluation.digest);
          if (priorAdmissions.length < evaluation.initialTrials.requiredTrials) {
            const slot = priorAdmissions.length + 1;
            const trial = evaluation.initialTrials.after[slot - 1];
            schema = DEADLINE_BOUND_EVALUATIONS.has(evaluation.schema)
              ? "agentspine.learning-application/v7"
              : evaluation.schema === "agentspine.learning-evaluation/v9"
                ? "agentspine.learning-application/v6" : "agentspine.learning-application/v5";
            initialAdmission = {
              evaluationId: evaluation.id,
              evaluationDigest: evaluation.digest,
              slot,
              evaluatorId: trial.evaluatorId,
              evaluatorRootDigest: trial.evaluatorRootDigest,
              runId: trial.runId,
              trialDigest: trial.trialDigest,
              ...(TARGET_BOUND_APPLICATIONS.has(schema) ? { targetDigest: evaluation.target.digest } : {}),
              authority: "context-only"
            };
            if (schema === "agentspine.learning-application/v7") {
              deliveryExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
                new Date(timestamp).getTime() + evaluation.completionPolicy.deliveryTimeoutMs)).toISOString();
              outcomeExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
                new Date(timestamp).getTime() + evaluation.completionPolicy.outcomeTimeoutMs)).toISOString();
              completionPolicyDigest = evaluation.completionPolicy.digest;
            }
          }
        }
      }
      const payload = applicationPayload({ schema, id, learningId: candidate.id, scope: runtimeScope,
        preflightReceiptId: preflightReceipt.id, promptDigest: preflightReceipt.promptDigest,
        preflightBriefingDigest: preflightReceipt.briefingDigest, sessionBriefingDigest,
        sessionId: preflightReceipt.sessionId, projectedAt: timestamp, deliveryExpiresAt, expiresAt,
        revalidationAdmission, initialAdmission, outcomeExpiresAt, completionPolicyDigest });
      const receipt = { ...payload, digest: digest(payload) };
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

export async function revokeLearningApplication({
  root = process.cwd(), applicationId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-application-revocation-confirmed") {
    throw new Error("application revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(applicationId || "")) throw new Error("applicationId must be a stable identifier");
  if (!APPLICATION_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be preflight-invalid, scope-invalid, projection-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const application = state.applications.find((entry) => entry.id === applicationId);
    if (!application) throw new Error(`unknown learning application: ${applicationId}`);
    const candidate = state.candidates.find((entry) => entry.id === application.learningId);
    const evaluationId = application.initialAdmission?.evaluationId || candidate?.promotion?.canary?.evaluationId;
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    const deliveries = state.deliveries.filter((entry) => entry.applicationId === application.id);
    const outcomes = state.outcomes.filter((entry) => entry.applicationId === application.id);
    if (deliveries.length > 1 || outcomes.length > 1) {
      throw new Error("application revocation requires one unambiguous delivery and outcome lineage");
    }
    const delivery = deliveries[0] || null;
    const outcome = outcomes[0] || null;
    if (!candidate || !evaluation || evaluation.learningId !== candidate.id
      || application.learningId !== candidate.id || (outcome && outcome.deliveryId !== delivery?.id)) {
      throw new Error("application revocation requires its complete immutable evaluation lineage");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedApplication(state, applicationId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.applicationDigest !== application.digest || existing.evaluationDigest !== evaluation.digest
        || existing.deliveryId !== (delivery?.id || null) || existing.deliveryDigest !== (delivery?.digest || null)
        || existing.outcomeId !== (outcome?.id || null) || existing.outcomeDigest !== (outcome?.digest || null)
        || existing.targetDigest !== targetDigest) {
        throw new Error("learning application revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `application-revocation:${createHash("sha256")
      .update(`${application.id}\0${application.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = applicationRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      applicationId: application.id,
      applicationDigest: application.digest,
      deliveryId: delivery?.id || null,
      deliveryDigest: delivery?.digest || null,
      outcomeId: outcome?.id || null,
      outcomeDigest: outcome?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.applicationRevocations.push(receipt);
    state.applicationRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
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
    const candidates = state.applications.filter((application) =>
      DELIVERABLE_APPLICATIONS.has(application.schema)
      && application.sessionId === sessionId && exactScope(application.scope, runtimeScope));
    if (!candidates.length) return { schema: "agentspine.learning-delivery-batch/v1", status: "not-applicable",
      receipts: [], learningPath, authority: "context-only" };
    if (candidates.some((application) => revokedApplication(state, application.id))) {
      throw new Error("learning application was explicitly revoked and cannot produce a delivery");
    }
    if (candidates.some((application) => {
      const candidate = state.candidates.find((entry) => entry.id === application.learningId);
      return revokedEvaluationForCandidate(state, candidate);
    })) throw new Error("learning evaluation contract was explicitly revoked and cannot produce a delivery");
    if (candidates.some((application) => {
      const candidate = state.candidates.find((entry) => entry.id === application.learningId);
      return revokedValidationForCandidate(state, candidate);
    })) throw new Error("learning validation decision was explicitly revoked and cannot produce a delivery");
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

export async function revokeLearningDelivery({
  root = process.cwd(), deliveryId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-delivery-revocation-confirmed") {
    throw new Error("delivery revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(deliveryId || "")) throw new Error("deliveryId must be a stable identifier");
  if (!DELIVERY_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be host-invalid, session-invalid, hook-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const delivery = state.deliveries.find((entry) => entry.id === deliveryId);
    if (!delivery) throw new Error(`unknown learning delivery: ${deliveryId}`);
    const application = state.applications.find((entry) => entry.id === delivery.applicationId);
    const candidate = state.candidates.find((entry) => entry.id === delivery.learningId);
    const outcomes = state.outcomes.filter((entry) => entry.deliveryId === delivery.id);
    if (outcomes.length > 1) throw new Error("delivery revocation requires one unambiguous bound outcome");
    const outcome = outcomes[0] || null;
    const evaluationId = outcome?.evaluationId || candidate?.promotion?.canary?.evaluationId;
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    if (!candidate || !application || !evaluation || application.learningId !== candidate.id
      || evaluation.learningId !== candidate.id) {
      throw new Error("delivery revocation requires its bound candidate, application, and evaluation contract");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedDelivery(state, deliveryId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.deliveryDigest !== delivery.digest || existing.applicationDigest !== application.digest
        || existing.evaluationDigest !== evaluation.digest || existing.targetDigest !== targetDigest
        || existing.outcomeId !== (outcome?.id || null) || existing.outcomeDigest !== (outcome?.digest || null)) {
        throw new Error("learning delivery revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `delivery-revocation:${createHash("sha256")
      .update(`${delivery.id}\0${delivery.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = deliveryRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      applicationId: application.id,
      applicationDigest: application.digest,
      deliveryId: delivery.id,
      deliveryDigest: delivery.digest,
      outcomeId: outcome?.id || null,
      outcomeDigest: outcome?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.deliveryRevocations.push(receipt);
    state.deliveryRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export async function revokeLearningOutcome({
  root = process.cwd(), outcomeId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-outcome-revocation-confirmed") {
    throw new Error("outcome revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(outcomeId || "")) throw new Error("outcomeId must be a stable identifier");
  if (!OUTCOME_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be binding-invalid, phase-invalid, scope-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const outcome = state.outcomes.find((entry) => entry.id === outcomeId);
    if (!outcome) throw new Error(`unknown learning outcome: ${outcomeId}`);
    const candidate = state.candidates.find((entry) => entry.id === outcome.learningId);
    const evaluation = state.evaluations.find((entry) => entry.id === outcome.evaluationId);
    const measurement = outcome.measurementReceiptId
      ? state.measurements.find((entry) => entry.id === outcome.measurementReceiptId) : null;
    const application = outcome.applicationId
      ? state.applications.find((entry) => entry.id === outcome.applicationId) : null;
    const delivery = outcome.deliveryId
      ? state.deliveries.find((entry) => entry.id === outcome.deliveryId) : null;
    if (!candidate || !evaluation || evaluation.learningId !== candidate.id
      || (outcome.measurementReceiptId && !measurement)
      || (outcome.applicationId && !application) || (outcome.deliveryId && !delivery)) {
      throw new Error("outcome revocation requires its complete immutable evaluation lineage");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedOutcome(state, outcomeId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.outcomeDigest !== outcome.digest || existing.evaluationDigest !== evaluation.digest
        || existing.measurementDigest !== (measurement?.digest || null)
        || existing.applicationDigest !== (application?.digest || null)
        || existing.deliveryDigest !== (delivery?.digest || null) || existing.targetDigest !== targetDigest) {
        throw new Error("learning outcome revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `outcome-revocation:${createHash("sha256")
      .update(`${outcome.id}\0${outcome.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = outcomeRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      outcomeId: outcome.id,
      outcomeDigest: outcome.digest,
      measurementId: measurement?.id || null,
      measurementDigest: measurement?.digest || null,
      applicationId: application?.id || null,
      applicationDigest: application?.digest || null,
      deliveryId: delivery?.id || null,
      deliveryDigest: delivery?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.outcomeRevocations.push(receipt);
    state.outcomeRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

function outcomeFresh(receipt, config, now) {
  return new Date(receipt.measuredAt).getTime() >= new Date(now).getTime() - config.outcomeMaxAgeDays * 86400000;
}

function outcomeMatchesContract(receipt, contract) {
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

function outcomeMatchesInitialTrial(state, receipt, contract) {
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

function promotableReceipts(state, candidate, timestamp) {
  const contracts = state.evaluations.filter((contract) => contract.learningId === candidate.id
    && !revokedEvaluation(state, contract.id)
    && new Date(contract.expiresAt).getTime() >= new Date(timestamp).getTime()
    && (!REGISTRY_BOUND_EVALUATIONS.has(contract.schema)
      || activeEvaluationBinding(state, contract)));
  const groups = contracts.map((contract) => {
    const receipts = state.outcomes.filter((item) => outcomeMatchesContract(item, contract)
      && item.learningId === candidate.id && item.evaluationId === contract.id && item.phase === "before"
      && exactScope(item.scope, contract.scope) && outcomeFresh(item, state.config, timestamp)
      && !revokedMeasurement(state, item.measurementReceiptId)
      && item.measurement.kind !== "model-suggestion" && outcomeMatchesInitialTrial(state, item, contract));
    if (INITIAL_TRIAL_EVALUATIONS.has(contract.schema)) receipts.sort((a, b) =>
      contract.initialTrials.before.findIndex((trial) => trial.evaluatorId === a.measurement.evaluatorId)
      - contract.initialTrials.before.findIndex((trial) => trial.evaluatorId === b.measurement.evaluatorId));
    return { contract, receipts };
  }).filter(({ contract, receipts }) => receipts.some((item) => item.measurement.kind === "objective")
    && new Set(receipts.map((item) => ROOT_BOUND_EVALUATIONS.has(contract.schema)
      ? item.measurement.evaluatorRootDigest : item.measurement.evaluatorId)).size >= contract.thresholds.beforeReceipts)
    .sort((a, b) => b.receipts.length - a.receipts.length || a.contract.id.localeCompare(b.contract.id));
  return groups[0] || null;
}

function improvement(direction, baseline, value) {
  return direction === "higher" ? value - baseline : baseline - value;
}

function rollbackCandidate(state, candidate, reason, timestamp, mode = "manual", trialFailure = null) {
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

function recordInitialTrialFailure(state, timeout, timestamp) {
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

function reconcileCanary(state, candidate, timestamp) {
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
    return { ...result, decision: "rolled-back", failureReceipt };
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
    && item.metric.direction === canary.metric.direction && outcomeFresh(item, state.config, timestamp)
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
    if (revokedEvaluation(state, evaluationId)) {
      throw new Error("learning evaluation contract was explicitly revoked and cannot support an outcome");
    }
    if (REGISTRY_BOUND_EVALUATIONS.has(evaluation?.schema)
      && !activeEvaluationBinding(state, evaluation)) {
      throw new Error("outcome evaluator registry binding is missing, changed, or revoked");
    }
    const measurementReceipt = measurementReceiptId === null ? null
      : state.measurements.find((item) => item.id === measurementReceiptId);
    if (measurementReceipt && revokedMeasurement(state, measurementReceipt.id)) {
      throw new Error("learning measurement was explicitly revoked and cannot be consumed");
    }
    const effectivePhase = LINEAGE_EVALUATIONS.has(evaluation?.schema)
      ? measurementReceipt?.phase : phase;
    const application = applicationId === null ? null : state.applications.find((item) => item.id === applicationId);
    const delivery = deliveryId === null ? null : state.deliveries.find((item) => item.id === deliveryId);
    if (application && revokedApplication(state, application.id)) {
      throw new Error("learning application was explicitly revoked and cannot support an outcome");
    }
    if (delivery && revokedDelivery(state, delivery.id)) {
      throw new Error("learning delivery was explicitly revoked and cannot support an outcome");
    }
    const existing = id ? state.outcomes.find((item) => item.id === id) : null;
    if (existing) {
      if (revokedOutcome(state, existing.id)) {
        throw new Error("learning outcome was explicitly revoked and cannot be replayed");
      }
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
    if (effectivePhase === "after" && DEADLINE_BOUND_APPLICATIONS.has(application?.schema)
      && new Date(timestamp).getTime() > new Date(application.outcomeExpiresAt).getTime()) {
      throw new Error("after outcome registration missed its immutable initial trial deadline");
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
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted" && revokedEvidence(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning evidence was explicitly revoked",
        timestamp, "automatic-evidence-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedMeasurementForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning measurement evidence was explicitly revoked",
        timestamp, "automatic-measurement-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedApplicationForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning application evidence was explicitly revoked",
        timestamp, "automatic-application-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedDeliveryForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning delivery evidence was explicitly revoked",
        timestamp, "automatic-delivery-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedOutcomeForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning outcome evidence was explicitly revoked",
        timestamp, "automatic-outcome-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    for (const current of state.candidates.filter((entry) => entry.status === "accepted" && entry.promotion?.mode === "outcome-canary")) {
      const result = reconcileCanary(state, current, timestamp);
      if (result.decision !== "unchanged" && result.decision !== "active") reconciled.push({ id: current.id, decision: result.decision });
    }
    if (state.config.autoPromote) {
      for (const candidate of state.candidates.filter((entry) => entry.status === "candidate")) {
        if (revokedEvidence(state, candidate)) continue;
        if (state.measurementRevocations.some((receipt) => receipt.learningId === candidate.id)) continue;
        if (state.applicationRevocations.some((receipt) => receipt.learningId === candidate.id)) continue;
        if (state.outcomeRevocations.some((receipt) => receipt.learningId === candidate.id)) continue;
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
              pairing: PAIRED_EVALUATIONS.has(contract.schema) ? contract.pairing : null,
              evaluatorRootDigest: ROOT_BOUND_EVALUATIONS.has(contract.schema)
                ? digest(contract.evaluatorRoots) : null,
              evaluatorRegistryBindingDigest: REGISTRY_BOUND_EVALUATIONS.has(contract.schema)
                ? state.evaluationBindings.find((binding) => binding.evaluationId === contract.id)?.digest : null,
              initialTrialsDigest: INITIAL_TRIAL_EVALUATIONS.has(contract.schema)
                ? digest(contract.initialTrials) : null,
              targetDigest: TARGET_BOUND_EVALUATIONS.has(contract.schema) ? contract.target.digest : null,
              completionPolicyDigest: DEADLINE_BOUND_EVALUATIONS.has(contract.schema)
                ? contract.completionPolicy.digest : null,
              coverage: COVERAGE_EVALUATIONS.has(contract.schema) ? {
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
      && !revokedApplication(state, application.id)
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
    for (const revocation of state.measurementRevocations) consumed.add(revocation.measurementId);
    const validationHistory = state.history.filter((entry) => entry.kind === "learning-validation")
      .map((entry) => entry.value);
    for (const lease of [...state.validationLeases, ...validationHistory]
      .filter((entry) => ["agentspine.learning-validation/v2", "agentspine.learning-validation/v3",
        "agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(entry?.schema))) {
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
    if (revokedEvidence(state, candidate)) throw new Error("learning evidence was revoked; propose a new candidate before promotion");
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
  const applicable = learning.candidates
    .filter((candidate) => candidate.status === "accepted")
    .filter((candidate) => scope === null || scopeContains(candidate.scope, runtimeScope))
    .filter((candidate) => candidate.promotion?.mode !== "outcome-canary"
      || exactScope(candidate.promotion.canary.scope, runtimeScope))
    .filter((candidate) => !kindFilter || kindFilter.has(candidate.kind))
    .filter((candidate) => !subjectFilter || subjectFilter.has(candidate.subjectId))
    .filter((candidate) => candidate.privacy !== "group" || (groupId && candidate.groupId === groupId));
  const invalidCanaries = new Map(applicable.map((candidate) => [candidate.id,
    canaryValidity(learning, candidate, timestamp)]).filter(([, validity]) => ![
    "not-applicable", "current-active", "current-validated", "legacy-validated"
  ].includes(validity.status)));
  const revokedTrialFailureCandidates = learning.candidates
    .filter((candidate) => candidate.status === "rolled-back"
      && learning.trialFailureRevocations.some((receipt) => receipt.learningId === candidate.id))
    .filter((candidate) => scope === null || scopeContains(candidate.scope, runtimeScope))
    .filter((candidate) => !kindFilter || kindFilter.has(candidate.kind))
    .filter((candidate) => !subjectFilter || subjectFilter.has(candidate.subjectId))
    .filter((candidate) => candidate.privacy !== "group" || (groupId && candidate.groupId === groupId))
    .filter((candidate) => visible(candidate, entities, audience, includePrivate, groupId));
  const items = applicable
    .filter((candidate) => !invalidCanaries.has(candidate.id))
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
    degraded: invalidCanaries.size > 0 || revokedTrialFailureCandidates.length > 0,
    diagnostics: [...invalidCanaries].map(([id, validity]) => `${({
      "stale-active": "stale-outcome-canary",
      "revoked-active": "revoked-evaluator-canary",
      "stale-validated": "stale-validated-learning",
      "revoked-validated": "revoked-evaluator-validated-learning",
      "unproven-validated": "missing-validation-lease",
      "failed-initial-trial": "blocking-initial-trial-timeout",
      "revoked-evaluation": "revoked-learning-evaluation",
      "revoked-validation": "revoked-learning-validation",
      "revoked-evidence": "revoked-learning-evidence",
      "revoked-measurement": "revoked-learning-measurement",
      "revoked-application": "revoked-learning-application",
      "revoked-delivery": "revoked-learning-delivery",
      "revoked-outcome": "revoked-learning-outcome"
    })[validity.status] || validity.status}:${id}`)
      .concat(revokedTrialFailureCandidates.map((candidate) =>
        `revoked-learning-trial-failure:${candidate.id}`)),
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
      const trialFailures = learning.trialFailures.filter((item) => item.learningId === candidate.id);
      const trialFailureRevocations = learning.trialFailureRevocations.filter((item) => item.learningId === candidate.id);
      const evaluationRevocations = learning.evaluationRevocations.filter((item) => item.learningId === candidate.id);
      const validationRevocations = learning.validationRevocations.filter((item) => item.learningId === candidate.id);
      const evidenceRevocations = learning.evidenceRevocations.filter((item) => item.learningId === candidate.id);
      const measurementRevocations = learning.measurementRevocations.filter((item) => item.learningId === candidate.id);
      const applicationRevocations = learning.applicationRevocations.filter((item) => item.learningId === candidate.id);
      const deliveryRevocations = learning.deliveryRevocations.filter((item) => item.learningId === candidate.id);
      const outcomeRevocations = learning.outcomeRevocations.filter((item) => item.learningId === candidate.id);
      const canary = candidate.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
      const canaryValidityStatus = canaryValidity(learning, candidate, timestamp);
      const stale = ["stale-active", "stale-validated"].includes(canaryValidityStatus.status);
      const registryContracts = evaluations.filter((contract) =>
        REGISTRY_BOUND_EVALUATIONS.has(contract.schema));
      const inactiveRegistryContracts = registryContracts.filter((contract) => !activeEvaluationBinding(learning, contract));
      const renewalMeasurementIds = new Set([...(learning.validationLeases || []),
        ...learning.history.filter((entry) => entry.kind === "learning-validation").map((entry) => entry.value)]
        .filter((lease) => lease?.learningId === candidate.id
          && ["agentspine.learning-validation/v2", "agentspine.learning-validation/v3",
            "agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema))
        .flatMap((lease) => lease.renewalEvidence.map((entry) => entry.measurementId)));
      const revalidation = canary?.revalidation;
      const admissionBound = ["agentspine.learning-revalidation-window/v3",
        "agentspine.learning-revalidation-window/v4"].includes(revalidation?.schema);
      const admittedApplications = admissionBound
        ? applications.filter((application) => application.schema === (revalidation.schema === "agentspine.learning-revalidation-window/v4"
          ? "agentspine.learning-application/v4" : "agentspine.learning-application/v3")
          && application.revalidationAdmission.revalidationWindowId === revalidation.id
          && application.revalidationAdmission.revalidationWindowDigest === revalidation.digest) : [];
      const initialContract = evaluations.find((contract) => INITIAL_TRIAL_EVALUATIONS.has(contract.schema)
        && contract.id === canary?.evaluationId && contract.digest === canary?.evaluationDigest)
        || [...evaluations].filter((contract) => INITIAL_TRIAL_EVALUATIONS.has(contract.schema))
          .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))[0] || null;
      const initialApplications = initialContract ? applications.filter((application) =>
        INITIAL_TRIAL_APPLICATIONS.has(application.schema)
        && application.initialAdmission.evaluationId === initialContract.id
        && application.initialAdmission.evaluationDigest === initialContract.digest) : [];
      const fixedCohortDeliveries = revalidation?.schema === "agentspine.learning-revalidation-window/v2"
        ? deliveries.filter((delivery) => new Date(delivery.completedAt).getTime() >= new Date(revalidation.startedAt).getTime()
          && new Date(delivery.completedAt).getTime() <= new Date(revalidation.expiresAt).getTime()
          && applications.some((application) => application.id === delivery.applicationId
            && new Date(application.projectedAt).getTime() >= new Date(revalidation.startedAt).getTime())).length
        : admissionBound
          ? deliveries.filter((delivery) => admittedApplications.some((application) =>
            application.id === delivery.applicationId)).length : 0;
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
            && COVERAGE_EVALUATIONS.has(contract.schema)
            && item.coverage?.datasetDigest === contract.benchmark.datasetDigest
            && item.coverage?.caseCount >= contract.benchmark.minCases)).length,
        provenanceBoundReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v6", "agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
          && DIGEST_RE.test(item.measurement?.sourceDigest || "")
          && evaluations.some((contract) => contract.id === item.evaluationId
            && ((item.schema === "agentspine.learning-outcome/v6" && contract.schema === "agentspine.learning-evaluation/v3")
              || (item.schema === "agentspine.learning-outcome/v7" && contract.schema === "agentspine.learning-evaluation/v4")
              || (item.schema === "agentspine.learning-outcome/v8" && contract.schema === "agentspine.learning-evaluation/v5")
              || (item.schema === "agentspine.learning-outcome/v9" && ROOT_BOUND_EVALUATIONS.has(contract.schema))))).length,
        initialTrialMode: initialContract?.initialTrials.mode || null,
        initialTrialSlots: initialContract?.initialTrials.requiredTrials || 0,
        initialAdmittedApplications: initialApplications.length,
        initialCompletedDeliveries: deliveries.filter((delivery) => initialApplications.some((application) =>
          application.id === delivery.applicationId)).length,
        incompleteInitialAdmissions: initialApplications.filter((application) =>
          !deliveries.some((delivery) => delivery.applicationId === application.id)
          && !trialFailures.some((failure) => failure.applicationId === application.id)).length,
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
        targetBoundEvaluationContracts: evaluations.filter((contract) =>
          TARGET_BOUND_EVALUATIONS.has(contract.schema)).length,
        deadlineBoundEvaluationContracts: evaluations.filter((contract) =>
          DEADLINE_BOUND_EVALUATIONS.has(contract.schema)).length,
        trialRetryEvaluationContracts: evaluations.filter((contract) =>
          TRIAL_RETRY_EVALUATIONS.has(contract.schema)).length,
        activeTargetDigest: TARGET_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.target.digest : null,
        activeCompletionPolicyDigest: DEADLINE_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.completionPolicy.digest : null,
        evaluatorRegistryContracts: registryContracts.length,
        inactiveEvaluatorRegistryContracts: inactiveRegistryContracts.length,
        activeEvaluationId: canary?.evaluationId || [...evaluations]
          .filter((contract) => new Date(contract.expiresAt).getTime() >= new Date(timestamp).getTime())
          .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))[0]?.id || null,
        applicationReceipts: applications.length,
        targetBoundApplications: applications.filter((application) =>
          TARGET_BOUND_APPLICATIONS.has(application.schema)).length,
        deadlineBoundApplications: applications.filter((application) =>
          DEADLINE_BOUND_APPLICATIONS.has(application.schema)).length,
        trialFailureReceipts: trialFailures.length,
        trialFailureRevocationReceipts: trialFailureRevocations.length,
        revokedTrialFailureIds: trialFailureRevocations.map((receipt) => receipt.trialFailureId).sort(),
        evaluationRevocationReceipts: evaluationRevocations.length,
        revokedEvaluationIds: evaluationRevocations.map((receipt) => receipt.evaluationId).sort(),
        validationRevocationReceipts: validationRevocations.length,
        revokedValidationLeaseIds: validationRevocations.map((receipt) => receipt.validationLeaseId).sort(),
        evidenceRevocationReceipts: evidenceRevocations.length,
        revokedEvidenceIds: evidenceRevocations.map((receipt) => receipt.evidenceId).sort(),
        measurementRevocationReceipts: measurementRevocations.length,
        revokedMeasurementIds: measurementRevocations.map((receipt) => receipt.measurementId).sort(),
        applicationRevocationReceipts: applicationRevocations.length,
        revokedApplicationIds: applicationRevocations.map((receipt) => receipt.applicationId).sort(),
        deliveryRevocationReceipts: deliveryRevocations.length,
        revokedDeliveryIds: deliveryRevocations.map((receipt) => receipt.deliveryId).sort(),
        outcomeRevocationReceipts: outcomeRevocations.length,
        revokedOutcomeIds: outcomeRevocations.map((receipt) => receipt.outcomeId).sort(),
        deliveryTimeoutFailures: trialFailures.filter((receipt) => receipt.failure === "delivery-timeout").length,
        outcomeTimeoutFailures: trialFailures.filter((receipt) => receipt.failure === "outcome-timeout").length,
        pendingInitialOutcomes: initialApplications.filter((application) =>
          DEADLINE_BOUND_APPLICATIONS.has(application.schema)
          && deliveries.some((delivery) => delivery.applicationId === application.id)
          && !outcomes.some((outcome) => outcome.applicationId === application.id)
          && !trialFailures.some((failure) => failure.applicationId === application.id)
          && new Date(application.outcomeExpiresAt).getTime() >= new Date(timestamp).getTime()).length,
        staleInitialOutcomes: initialApplications.filter((application) =>
          DEADLINE_BOUND_APPLICATIONS.has(application.schema)
          && deliveries.some((delivery) => delivery.applicationId === application.id)
          && !outcomes.some((outcome) => outcome.applicationId === application.id)
          && !trialFailures.some((failure) => failure.applicationId === application.id)
          && new Date(application.outcomeExpiresAt).getTime() < new Date(timestamp).getTime()).length,
        deliveryReceipts: deliveries.length,
        pendingApplications: applications.filter((application) =>
          DELIVERABLE_APPLICATIONS.has(application.schema)
          && new Date(application.deliveryExpiresAt).getTime() >= new Date(timestamp).getTime()
          && !deliveries.some((delivery) => delivery.applicationId === application.id)
          && !trialFailures.some((failure) => failure.applicationId === application.id)).length,
        stalePendingApplications: applications.filter((application) =>
          DELIVERABLE_APPLICATIONS.has(application.schema)
          && new Date(application.deliveryExpiresAt).getTime() < new Date(timestamp).getTime()
          && !deliveries.some((delivery) => delivery.applicationId === application.id)
          && !trialFailures.some((failure) => failure.applicationId === application.id)).length,
        latestApplicationId: [...applications].sort((a, b) => b.projectedAt.localeCompare(a.projectedAt))[0]?.id || null,
        canaryStatus: canaryValidityStatus.status === "not-applicable" ? "not-applicable"
          : canaryValidityStatus.status === "failed-initial-trial" ? "failed-trial"
          : canaryValidityStatus.status === "revoked-evaluation" ? "revoked-evaluation"
          : canaryValidityStatus.status === "revoked-validation" ? "revoked-validation"
          : canaryValidityStatus.status === "revoked-evidence" ? "revoked-evidence"
          : canaryValidityStatus.status === "revoked-measurement" ? "revoked-measurement"
          : canaryValidityStatus.status === "revoked-application" ? "revoked-application"
          : canaryValidityStatus.status === "revoked-delivery" ? "revoked-delivery"
          : canaryValidityStatus.status === "revoked-outcome" ? "revoked-outcome"
          : stale ? "stale" : (["revoked-active", "revoked-validated"].includes(canaryValidityStatus.status)
          ? "revoked" : (canaryValidityStatus.status === "unproven-validated" ? "unproven" : (canary?.status || "not-applicable"))),
        validationLeaseStatus: canaryValidityStatus.status,
        validationLeaseId: canary?.validationLeaseId || null,
        validationLeaseSchema: canaryValidityStatus.lease?.schema || null,
        revalidationStatus: canary?.revalidation?.status === "active"
          ? (new Date(canary.revalidation.expiresAt).getTime() < new Date(timestamp).getTime() ? "stale" : "active")
          : "not-applicable",
        revalidationSelectionMode: ["agentspine.learning-revalidation-window/v2",
          "agentspine.learning-revalidation-window/v3", "agentspine.learning-revalidation-window/v4"].includes(revalidation?.schema)
          ? revalidation.selection.mode : null,
        revalidationRequiredDeliveries: ["agentspine.learning-revalidation-window/v2",
          "agentspine.learning-revalidation-window/v3", "agentspine.learning-revalidation-window/v4"].includes(revalidation?.schema)
          ? revalidation.selection.requiredDeliveries : 0,
        revalidationAdmittedApplications: admissionBound
          ? admittedApplications.length : 0,
        revalidationPrecommittedTrials: revalidation?.schema === "agentspine.learning-revalidation-window/v4"
          ? revalidation.selection.evaluatorRoots.length : 0,
        revalidationTrials: revalidation?.schema === "agentspine.learning-revalidation-window/v4"
          ? revalidation.selection.evaluatorRoots.map((entry) => ({
            slot: entry.slot,
            evaluatorId: entry.evaluatorId,
            evaluatorRootDigest: entry.evaluatorRootDigest,
            runId: entry.runId,
            caseCount: entry.caseCount,
            trialDigest: entry.trialDigest,
            authority: "context-only"
          })) : [],
        revalidationCompletedDeliveries: ["agentspine.learning-revalidation-window/v2",
          "agentspine.learning-revalidation-window/v3", "agentspine.learning-revalidation-window/v4"].includes(revalidation?.schema)
          ? Math.min(fixedCohortDeliveries, revalidation.selection.requiredDeliveries) : 0,
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
    trialRetryEvaluationContracts: learning.evaluations.filter((contract) =>
      TRIAL_RETRY_EVALUATIONS.has(contract.schema)).length,
    trialFailureRevocations: learning.trialFailureRevocations.length,
    evaluationRevocations: learning.evaluationRevocations.length,
    validationRevocations: learning.validationRevocations.length,
    evidenceRevocations: learning.evidenceRevocations.length,
    measurementRevocations: learning.measurementRevocations.length,
    applicationRevocations: learning.applicationRevocations.length,
    deliveryRevocations: learning.deliveryRevocations.length,
    outcomeRevocations: learning.outcomeRevocations.length,
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
    "minImprovement", "regressionTolerance", "outcomeMaxAgeDays", "canaryReceipts", "canaryTtlDays",
    "initialTrialOutcomeTimeoutMinutes"
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
    if ("initialTrialOutcomeTimeoutMinutes" in config) {
      state.config.initialTrialOutcomeTimeoutMinutes = integer(config.initialTrialOutcomeTimeoutMinutes,
        "initialTrialOutcomeTimeoutMinutes", 5, 10080);
    }
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
    if (state.evaluations.some((entry) => TRIAL_RETRY_EVALUATIONS.has(entry.schema)
      && entry.retry.predecessorLearningId === id && entry.learningId !== id)) {
      throw new Error("delete the dependent trial-retry learning before its failed predecessor");
    }
    const retryContract = state.evaluations.find((entry) => TRIAL_RETRY_EVALUATIONS.has(entry.schema)
      && entry.learningId === id);
    if (retryContract && state.candidates.some((entry) => entry.id === retryContract.retry.predecessorLearningId)) {
      throw new Error("purge the shared subject atomically to delete a trial-retry lineage");
    }
    const existed = Boolean(candidate);
    const evaluationIds = new Set(state.evaluations.filter((entry) => entry.learningId === id).map((entry) => entry.id));
    state.candidates = state.candidates.filter((entry) => entry.id !== id);
    state.outcomes = state.outcomes.filter((entry) => entry.learningId !== id);
    state.measurements = state.measurements.filter((entry) => entry.learningId !== id);
    state.applications = state.applications.filter((entry) => entry.learningId !== id);
    state.deliveries = state.deliveries.filter((entry) => entry.learningId !== id);
    state.validationLeases = state.validationLeases.filter((entry) => entry.learningId !== id);
    state.trialFailures = state.trialFailures.filter((entry) => entry.learningId !== id);
    state.trialFailureRevocations = state.trialFailureRevocations.filter((entry) => entry.learningId !== id);
    state.evaluationRevocations = state.evaluationRevocations.filter((entry) => entry.learningId !== id);
    state.validationRevocations = state.validationRevocations.filter((entry) => entry.learningId !== id);
    state.evidenceRevocations = state.evidenceRevocations.filter((entry) => entry.learningId !== id);
    state.measurementRevocations = state.measurementRevocations.filter((entry) => entry.learningId !== id);
    state.applicationRevocations = state.applicationRevocations.filter((entry) => entry.learningId !== id);
    state.deliveryRevocations = state.deliveryRevocations.filter((entry) => entry.learningId !== id);
    state.outcomeRevocations = state.outcomeRevocations.filter((entry) => entry.learningId !== id);
    state.evaluations = state.evaluations.filter((entry) => entry.learningId !== id);
    state.evaluationBindings = state.evaluationBindings.filter((entry) => !evaluationIds.has(entry.evaluationId));
    state.history = state.history.filter((entry) => entry.recordId !== id && entry.value?.id !== id
      && entry.value?.learningId !== id);
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
    state.trialFailures = state.trialFailures.filter((entry) => !ids.has(entry.learningId));
    state.trialFailureRevocations = state.trialFailureRevocations.filter((entry) => !ids.has(entry.learningId));
    state.evaluationRevocations = state.evaluationRevocations.filter((entry) => !ids.has(entry.learningId));
    state.validationRevocations = state.validationRevocations.filter((entry) => !ids.has(entry.learningId));
    state.evidenceRevocations = state.evidenceRevocations.filter((entry) => !ids.has(entry.learningId));
    state.measurementRevocations = state.measurementRevocations.filter((entry) => !ids.has(entry.learningId));
    state.applicationRevocations = state.applicationRevocations.filter((entry) => !ids.has(entry.learningId));
    state.deliveryRevocations = state.deliveryRevocations.filter((entry) => !ids.has(entry.learningId));
    state.outcomeRevocations = state.outcomeRevocations.filter((entry) => !ids.has(entry.learningId));
    state.evaluations = state.evaluations.filter((entry) => !ids.has(entry.learningId));
    state.evaluationBindings = state.evaluationBindings.filter((entry) => !evaluationIds.has(entry.evaluationId));
    state.history = state.history.filter((entry) => entry.subjectId !== subjectId && !ids.has(entry.recordId)
      && !ids.has(entry.value?.id) && !ids.has(entry.value?.learningId));
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
      if ((learning.evidenceRevocations || []).some((receipt) => receipt.learningId === candidate.id)) {
        findings.push(`revoked-evidence:${candidate.id}`);
      }
      if (revokedMeasurementForCandidate(learning, candidate)) findings.push(`revoked-measurement:${candidate.id}`);
      if (revokedApplicationForCandidate(learning, candidate)) findings.push(`revoked-application:${candidate.id}`);
      if (revokedDeliveryForCandidate(learning, candidate)) findings.push(`revoked-delivery:${candidate.id}`);
      if (revokedOutcomeForCandidate(learning, candidate)) findings.push(`revoked-outcome:${candidate.id}`);
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
        && REGISTRY_BOUND_EVALUATIONS.has(canaryEvaluation?.schema)
        && !activeEvaluationBinding(learning, canaryEvaluation)) findings.push(`inactive-evaluator-canary:${candidate.id}`);
      if (revokedEvaluationForCandidate(learning, candidate)) findings.push(`revoked-evaluation:${candidate.id}`);
      if (revokedValidationForCandidate(learning, candidate)) findings.push(`revoked-validation:${candidate.id}`);
      if (candidate.promotion?.mode === "outcome-canary" && candidate.promotion?.canary?.status === "validated"
        && REGISTRY_BOUND_EVALUATIONS.has(canaryEvaluation?.schema)
        && !(learning.validationLeases || []).some((lease) => lease.id === candidate.promotion.canary.validationLeaseId
          && lease.digest === candidate.promotion.canary.validationLeaseDigest
          && storedValidationLeaseStructure(lease) && validationLeaseMatchesState(learning, lease))) {
        findings.push(`missing-validation-lease:${candidate.id}`);
      }
      const revalidation = candidate.promotion?.canary?.revalidation;
      const predecessorValidation = revalidation ? (learning.validationLeases || []).find((lease) =>
        lease.id === revalidation.predecessorValidationId
        && lease.digest === revalidation.predecessorValidationDigest && lease.learningId === candidate.id) : null;
      const revalidationBaselineReferences = predecessorValidation?.schema === "agentspine.learning-validation/v1"
        ? predecessorValidation.beforeOutcomes : predecessorValidation?.baselineOutcomes;
      const revalidationRoots = (revalidationBaselineReferences || []).map((reference) =>
        (learning.outcomes || []).find((outcome) => outcome.id === reference.id && outcome.digest === reference.digest))
        .filter(Boolean).sort((a, b) => a.measurement.evaluatorId.localeCompare(b.measurement.evaluatorId))
        .map((outcome) => outcome.measurement.evaluatorRootDigest);
      if (revalidation && (candidate.promotion?.canary?.status !== "validated"
        || !storedRevalidationWindowStructure(revalidation) || !predecessorValidation
        || !revalidationWindowMatchesState(learning, candidate)
        || (["agentspine.learning-revalidation-window/v2", "agentspine.learning-revalidation-window/v3",
          "agentspine.learning-revalidation-window/v4"]
          .includes(revalidation.schema)
          && (revalidation.selection.requiredDeliveries !== revalidationRoots.length
            || revalidation.selection.evaluatorRoots.some((entry, index) =>
              entry.evaluatorRootDigest !== revalidationRoots[index]))))) {
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
    if (REGISTRY_BOUND_EVALUATIONS.has(contract.schema)) {
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
  const trialFailureIds = new Set();
  const failedApplications = new Set();
  for (const receipt of learning.trialFailures || []) {
    const valid = storedTrialFailureStructure(receipt) && trialFailureMatchesState(learning, receipt);
    if (!valid || trialFailureIds.has(receipt.id) || failedApplications.has(receipt.applicationId)) {
      findings.push(`invalid-trial-failure:${receipt.id || "unknown"}`);
    }
    trialFailureIds.add(receipt.id);
    failedApplications.add(receipt.applicationId);
  }
  const trialFailureRevocationIds = new Set();
  const revokedTrialFailureIds = new Set();
  for (const receipt of learning.trialFailureRevocations || []) {
    const valid = storedTrialFailureRevocationStructure(receipt)
      && trialFailureRevocationMatchesState(learning, receipt);
    if (!valid || trialFailureRevocationIds.has(receipt.id)
      || revokedTrialFailureIds.has(receipt.trialFailureId)) {
      findings.push(`invalid-trial-failure-revocation:${receipt.id || "unknown"}`);
    }
    trialFailureRevocationIds.add(receipt.id);
    revokedTrialFailureIds.add(receipt.trialFailureId);
  }
  const retryRevocationIds = new Set();
  for (const contract of (learning.evaluations || []).filter((entry) => TRIAL_RETRY_EVALUATIONS.has(entry.schema))) {
    if (!trialRetryMatchesState(learning, contract)
      || retryRevocationIds.has(contract.retry?.trialFailureRevocationId)) {
      findings.push(`invalid-trial-retry:${contract.id || "unknown"}`);
    }
    retryRevocationIds.add(contract.retry?.trialFailureRevocationId);
  }
  const evaluationRevocationIds = new Set();
  const revokedEvaluationIds = new Set();
  for (const receipt of learning.evaluationRevocations || []) {
    const valid = storedEvaluationRevocationStructure(receipt) && evaluationRevocationMatchesState(learning, receipt);
    if (!valid || evaluationRevocationIds.has(receipt.id) || revokedEvaluationIds.has(receipt.evaluationId)) {
      findings.push(`invalid-evaluation-revocation:${receipt.id || "unknown"}`);
    }
    evaluationRevocationIds.add(receipt.id);
    revokedEvaluationIds.add(receipt.evaluationId);
  }
  const validationRevocationIds = new Set();
  const revokedValidationLeaseIds = new Set();
  for (const receipt of learning.validationRevocations || []) {
    const valid = storedValidationRevocationStructure(receipt) && validationRevocationMatchesState(learning, receipt);
    if (!valid || validationRevocationIds.has(receipt.id)
      || revokedValidationLeaseIds.has(receipt.validationLeaseId)) {
      findings.push(`invalid-validation-revocation:${receipt.id || "unknown"}`);
    }
    validationRevocationIds.add(receipt.id);
    revokedValidationLeaseIds.add(receipt.validationLeaseId);
  }
  const evidenceRevocationIds = new Set();
  const revokedEvidenceKeys = new Set();
  for (const receipt of learning.evidenceRevocations || []) {
    const key = `${receipt.learningId}\0${receipt.evidenceId}`;
    const valid = storedEvidenceRevocationStructure(receipt) && evidenceRevocationMatchesState(learning, receipt);
    if (!valid || evidenceRevocationIds.has(receipt.id) || revokedEvidenceKeys.has(key)) {
      findings.push(`invalid-evidence-revocation:${receipt.id || "unknown"}`);
    }
    evidenceRevocationIds.add(receipt.id);
    revokedEvidenceKeys.add(key);
  }
  const measurementRevocationIds = new Set();
  const revokedMeasurementIds = new Set();
  for (const receipt of learning.measurementRevocations || []) {
    const valid = storedMeasurementRevocationStructure(receipt) && measurementRevocationMatchesState(learning, receipt);
    if (!valid || measurementRevocationIds.has(receipt.id) || revokedMeasurementIds.has(receipt.measurementId)) {
      findings.push(`invalid-measurement-revocation:${receipt.id || "unknown"}`);
    }
    measurementRevocationIds.add(receipt.id);
    revokedMeasurementIds.add(receipt.measurementId);
  }
  const applicationRevocationIds = new Set();
  const revokedApplicationIds = new Set();
  for (const receipt of learning.applicationRevocations || []) {
    const valid = storedApplicationRevocationStructure(receipt) && applicationRevocationMatchesState(learning, receipt);
    if (!valid || applicationRevocationIds.has(receipt.id) || revokedApplicationIds.has(receipt.applicationId)) {
      findings.push(`invalid-application-revocation:${receipt.id || "unknown"}`);
    }
    applicationRevocationIds.add(receipt.id);
    revokedApplicationIds.add(receipt.applicationId);
  }
  const deliveryRevocationIds = new Set();
  const revokedDeliveryIds = new Set();
  for (const receipt of learning.deliveryRevocations || []) {
    const valid = storedDeliveryRevocationStructure(receipt) && deliveryRevocationMatchesState(learning, receipt);
    if (!valid || deliveryRevocationIds.has(receipt.id) || revokedDeliveryIds.has(receipt.deliveryId)) {
      findings.push(`invalid-delivery-revocation:${receipt.id || "unknown"}`);
    }
    deliveryRevocationIds.add(receipt.id);
    revokedDeliveryIds.add(receipt.deliveryId);
  }
  const outcomeRevocationIds = new Set();
  const revokedOutcomeIds = new Set();
  for (const receipt of learning.outcomeRevocations || []) {
    const valid = storedOutcomeRevocationStructure(receipt) && outcomeRevocationMatchesState(learning, receipt);
    if (!valid || outcomeRevocationIds.has(receipt.id) || revokedOutcomeIds.has(receipt.outcomeId)) {
      findings.push(`invalid-outcome-revocation:${receipt.id || "unknown"}`);
    }
    outcomeRevocationIds.add(receipt.id);
    revokedOutcomeIds.add(receipt.outcomeId);
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
      && LINEAGE_EVALUATIONS.has(contract.schema)
      && contract.learningId === receipt.learningId
      && exactScope(contract.scope, receipt.scope) && scopeContains(candidate.scope, receipt.scope)
      && lineage?.sourceDigest === receipt.measurement?.sourceDigest
      && lineage?.runDigest === measurementRunDigest(receipt.measurement?.evaluatorId, receipt.measurement?.runId)
      && (receipt.schema !== "agentspine.learning-measurement/v2"
        || (ROOT_BOUND_EVALUATIONS.has(contract.schema)
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
    if (DELIVERABLE_APPLICATIONS.has(receipt.schema)
      && new Date(receipt.deliveryExpiresAt).getTime() < Date.now()
      && !(learning.deliveries || []).some((delivery) => delivery.applicationId === receipt.id)
      && !failedApplications.has(receipt.id)) {
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
        || (receipt.schema === "agentspine.learning-outcome/v9" && !ROOT_BOUND_EVALUATIONS.has(contract.schema))
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
