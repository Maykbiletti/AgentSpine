import {
  DIGEST_RE, PROTECTED_LESSON_RE, LINEAGE_EVALUATIONS, ROOT_BOUND_EVALUATIONS, REGISTRY_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS,
  TARGET_BOUND_EVALUATIONS, DEADLINE_BOUND_EVALUATIONS, TRIAL_RETRY_EVALUATIONS, STALENESS_BOUND_EVALUATIONS, CANDIDATE_ADMISSION_EVALUATIONS, CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS,
  DELIVERABLE_APPLICATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS, DEADLINE_BOUND_APPLICATIONS, defaults
} from "./learning-schema.js";
import {
  normalizeStoredScope, scopeContains, exactScope, digest, learningTargetMatchesCandidate, storedEvidenceRevocationStructure,
  evidenceRevocationMatchesState, storedOutcomeStructure, storedMeasurementStructure, storedMeasurementRevocationStructure, measurementRevocationMatchesState, measurementRunDigest,
  evaluatorRootRunDigest, storedEvaluatorRecordStructure, storedEvaluationBindingStructure, storedEvaluationRevocationStructure, evaluationRevocationMatchesState
} from "./learning-scope-targets.js";
import {
  revalidationWindowMatchesState, storedValidationLeaseStructure, validationLeaseMatchesState
} from "./learning-validation-contracts.js";
import {
  storedValidationRevocationStructure, validationRevocationMatchesState
} from "./learning-validation-runtime.js";
import {
  storedMeasurementLineageStructure, storedEvidenceSourceAttestationRevocationStructure, evidenceSourceAttestationRevocationMatchesState
} from "./learning-measurement-contracts.js";
import {
  storedCandidateEvidenceLineageStructure, candidateEvidenceLineageMatchesEvaluation, candidateAdmissionMatches
} from "./learning-evidence-contracts.js";
import {
  storedEvaluationStructure, storedApplicationStructure, initialAdmissionsMatchState, storedTrialFailureStructure, trialFailureMatchesState, storedTrialFailureRevocationStructure,
  trialFailureRevocationMatchesState
} from "./learning-evaluation-contracts.js";
import {
  trialRetryMatchesState, storedTrialRetryExhaustionStructure, trialRetryExhaustionMatchesState, revalidationAdmissionsMatchState
} from "./learning-retry-contracts.js";
import {
  storedDeliveryStructure, storedApplicationRevocationStructure, applicationRevocationMatchesState, storedDeliveryRevocationStructure, deliveryRevocationMatchesState, storedOutcomeRevocationStructure,
  outcomeRevocationMatchesState
} from "./learning-delivery-contracts.js";

export function normalizeState(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "agentspine.learning/v1" || value.root !== root
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)
    || !Array.isArray(value.candidates) || !value.candidates.every((item) => item && typeof item === "object" && Array.isArray(item.evidence))
    || (value.outcomes !== undefined && (!Array.isArray(value.outcomes) || !value.outcomes.every((item) => item && typeof item === "object")))
    || (value.measurements !== undefined && (!Array.isArray(value.measurements) || !value.measurements.every((item) => item && typeof item === "object")))
    || (value.measurementLineage !== undefined && (!Array.isArray(value.measurementLineage) || !value.measurementLineage.every((item) => item && typeof item === "object")))
    || (value.candidateEvidenceLineage !== undefined && (!Array.isArray(value.candidateEvidenceLineage)
      || !value.candidateEvidenceLineage.every((item) => item && typeof item === "object")))
    || (value.applications !== undefined && (!Array.isArray(value.applications) || !value.applications.every((item) => item && typeof item === "object")))
    || (value.deliveries !== undefined && (!Array.isArray(value.deliveries) || !value.deliveries.every((item) => item && typeof item === "object")))
    || (value.evaluations !== undefined && (!Array.isArray(value.evaluations) || !value.evaluations.every((item) => item && typeof item === "object")))
    || (value.evaluatorRegistry !== undefined && (!Array.isArray(value.evaluatorRegistry) || !value.evaluatorRegistry.every((item) => item && typeof item === "object")))
    || (value.evaluationBindings !== undefined && (!Array.isArray(value.evaluationBindings) || !value.evaluationBindings.every((item) => item && typeof item === "object")))
    || (value.validationLeases !== undefined && (!Array.isArray(value.validationLeases) || !value.validationLeases.every((item) => item && typeof item === "object")))
    || (value.trialFailures !== undefined && (!Array.isArray(value.trialFailures) || !value.trialFailures.every((item) => item && typeof item === "object")))
    || (value.trialFailureRevocations !== undefined && (!Array.isArray(value.trialFailureRevocations)
      || !value.trialFailureRevocations.every((item) => item && typeof item === "object")))
    || (value.trialRetryExhaustions !== undefined && (!Array.isArray(value.trialRetryExhaustions)
      || !value.trialRetryExhaustions.every((item) => item && typeof item === "object")))
    || (value.evaluationRevocations !== undefined && (!Array.isArray(value.evaluationRevocations)
      || !value.evaluationRevocations.every((item) => item && typeof item === "object")))
    || (value.evidenceSourceAttestationRevocations !== undefined
      && (!Array.isArray(value.evidenceSourceAttestationRevocations)
        || !value.evidenceSourceAttestationRevocations.every((item) => item && typeof item === "object")))
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
    candidateEvidenceLineage: value.candidateEvidenceLineage || [],
    applications: value.applications || [],
    deliveries: value.deliveries || [],
    evaluations: value.evaluations || [],
    evaluatorRegistry: value.evaluatorRegistry || [],
    evaluationBindings: value.evaluationBindings || [],
    validationLeases: value.validationLeases || [],
    trialFailures: value.trialFailures || [],
    trialFailureRevocations: value.trialFailureRevocations || [],
    trialRetryExhaustions: value.trialRetryExhaustions || [],
    evaluationRevocations: value.evaluationRevocations || [],
    evidenceSourceAttestationRevocations: value.evidenceSourceAttestationRevocations || [],
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
  if (normalized.candidateEvidenceLineage.some((receipt) => !storedCandidateEvidenceLineageStructure(receipt))) {
    throw new Error("learning candidate evidence lineage state is invalid; run the audit before learning");
  }
  const evidenceLineageDigests = new Set();
  const evidenceLineageIndependence = new Set();
  for (const receipt of normalized.candidateEvidenceLineage) {
    const evidenceKey = `${receipt.scopeDigest}\0${receipt.evidenceDigest}`;
    const independenceKey = `${receipt.scopeDigest}\0${receipt.independenceDigest}`;
    if (evidenceLineageDigests.has(evidenceKey) || evidenceLineageIndependence.has(independenceKey)) {
      throw new Error("learning candidate evidence lineage is replayed; run the audit before learning");
    }
    evidenceLineageDigests.add(evidenceKey);
    evidenceLineageIndependence.add(independenceKey);
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
  if (normalized.evaluations.some((contract) => CANDIDATE_ADMISSION_EVALUATIONS.has(contract.schema)
    && !candidateAdmissionMatches(contract,
      normalized.candidates.find((candidate) => candidate.id === contract.learningId)))) {
    throw new Error("learning candidate admission is invalid or changed; run the audit before learning");
  }
  if (normalized.evaluations.some((contract) => CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(contract.schema)
    && !candidateEvidenceLineageMatchesEvaluation(normalized, contract))) {
    throw new Error("learning candidate evidence lineage binding is invalid; run the audit before learning");
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
  if (normalized.trialRetryExhaustions.some((receipt) => !storedTrialRetryExhaustionStructure(receipt)
    || !trialRetryExhaustionMatchesState(normalized, receipt))
    || new Set(normalized.trialRetryExhaustions.map((entry) => entry.correctiveEvaluationId)).size
      !== normalized.trialRetryExhaustions.length
    || new Set(normalized.trialRetryExhaustions.map((entry) => entry.trialFailureId)).size
      !== normalized.trialRetryExhaustions.length) {
    throw new Error("learning trial retry exhaustion state is invalid; run the audit before learning");
  }
  if (normalized.evaluationRevocations.some((receipt) => !storedEvaluationRevocationStructure(receipt)
    || !evaluationRevocationMatchesState(normalized, receipt))
    || new Set(normalized.evaluationRevocations.map((entry) => entry.evaluationId)).size
      !== normalized.evaluationRevocations.length) {
    throw new Error("learning evaluation revocation state is invalid; run the audit before learning");
  }
  if (normalized.evidenceSourceAttestationRevocations.some((receipt) =>
    !storedEvidenceSourceAttestationRevocationStructure(receipt)
    || !evidenceSourceAttestationRevocationMatchesState(normalized, receipt))
    || new Set(normalized.evidenceSourceAttestationRevocations.map((entry) =>
      `${entry.evaluationId}\0${entry.evidenceDigest}`)).size
      !== normalized.evidenceSourceAttestationRevocations.length) {
    throw new Error("learning evidence source attestation revocation state is invalid; run the audit before learning");
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
        || candidate.promotion.canary.completionPolicyDigest === contract.completionPolicy.digest)
      && (!STALENESS_BOUND_EVALUATIONS.has(contract.schema)
        || candidate.promotion.canary.stalenessPolicyDigest === contract.stalenessPolicy.digest)))) {
    throw new Error("learning canary evaluation binding is invalid; run the audit before learning");
  }
  if (normalized.validationLeases.some((lease) => !validationLeaseMatchesState(normalized, lease))) {
    throw new Error("learning validation lease binding is invalid; run the audit before learning");
  }
  return normalized;
}
