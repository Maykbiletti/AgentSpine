import {
  KINDS, EVIDENCE_TYPES, PRIVACY, STATUSES, AUTO_KINDS, OUTCOME_AUTO_KINDS,
  CONTINUITY_AUTO_KINDS, SCOPE_FIELDS, ID_RE, DIGEST_RE, SECRET_RE, AUTHORITY_ASSERTION_RE,
  LINEAGE_EVALUATIONS, ROOT_BOUND_EVALUATIONS, REGISTRY_BOUND_EVALUATIONS, TRIAL_RETRY_EVALUATIONS, CANDIDATE_ADMISSION_EVALUATIONS, CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS,
  DELIVERABLE_APPLICATIONS
} from "./learning-schema.js";
import {
  validConfig, scopeContains, exactScope, digest, storedEvidenceRevocationStructure, evidenceRevocationMatchesState,
  storedOutcomeStructure, storedMeasurementStructure, storedMeasurementRevocationStructure, measurementRevocationMatchesState, revokedMeasurementForCandidate, measurementRunDigest,
  evaluatorRootRunDigest, activeEvaluationBinding, storedEvaluationRevocationStructure, evaluationRevocationMatchesState
} from "./learning-scope-targets.js";
import {
  revokedEvaluationForCandidate, storedRevalidationWindowStructure, revalidationWindowMatchesState, storedValidationLeaseStructure, validationLeaseMatchesState
} from "./learning-validation-contracts.js";
import {
  storedValidationRevocationStructure, validationRevocationMatchesState, revokedValidationForCandidate
} from "./learning-validation-runtime.js";
import {
  storedMeasurementLineageStructure, storedEvidenceSourceAttestationRevocationStructure, evidenceSourceAttestationRevocationMatchesState, revokedEvidenceSourceAttestationForCandidate
} from "./learning-measurement-contracts.js";
import {
  storedCandidateEvidenceLineageStructure, candidateEvidenceLineageMatchesEvaluation, candidateAdmissionMatches
} from "./learning-evidence-contracts.js";
import {
  storedEvaluationStructure, storedApplicationStructure, storedTrialFailureStructure, trialFailureMatchesState, storedTrialFailureRevocationStructure, trialFailureRevocationMatchesState
} from "./learning-evaluation-contracts.js";
import {
  trialRetryMatchesState, storedTrialRetryExhaustionStructure, trialRetryExhaustionMatchesState
} from "./learning-retry-contracts.js";
import {
  storedDeliveryStructure, storedApplicationRevocationStructure, applicationRevocationMatchesState, revokedApplicationForCandidate, storedDeliveryRevocationStructure, deliveryRevocationMatchesState,
  revokedDeliveryForCandidate, storedOutcomeRevocationStructure, outcomeRevocationMatchesState, revokedOutcomeForCandidate
} from "./learning-delivery-contracts.js";
import {
  isGroupMember, evidenceConfidence
} from "./learning-storage.js";
import {
  distinctEvidence
} from "./learning-candidates.js";

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
      if (revokedEvidenceSourceAttestationForCandidate(learning, candidate)) {
        findings.push(`revoked-evidence-source-attestation:${candidate.id}`);
      }
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
    const valid = storedEvaluationStructure(contract) && candidate && scopeContains(candidate.scope, contract.scope)
      && (!CANDIDATE_ADMISSION_EVALUATIONS.has(contract.schema)
        || candidateAdmissionMatches(contract, candidate));
    if (!valid || evaluationIds.has(contract.id)) findings.push(`invalid-evaluation:${contract.id || "unknown"}`);
    if (REGISTRY_BOUND_EVALUATIONS.has(contract.schema)) {
      const binding = (learning.evaluationBindings || []).find((entry) => entry.evaluationId === contract.id);
      if (!binding || binding.evaluationDigest !== contract.digest) findings.push(`invalid-evaluator-binding:${contract.id}`);
    }
    evaluationIds.add(contract.id);
  }
  const candidateEvidenceDigests = new Set();
  const candidateEvidenceIndependence = new Set();
  for (const lineage of learning.candidateEvidenceLineage || []) {
    const evidenceKey = `${lineage.scopeDigest}\0${lineage.evidenceDigest}`;
    const independenceKey = `${lineage.scopeDigest}\0${lineage.independenceDigest}`;
    const valid = storedCandidateEvidenceLineageStructure(lineage);
    if (!valid || candidateEvidenceDigests.has(evidenceKey)
      || candidateEvidenceIndependence.has(independenceKey)) {
      findings.push(`invalid-candidate-evidence-lineage:${lineage.evaluationId || "unknown"}`);
    }
    candidateEvidenceDigests.add(evidenceKey);
    candidateEvidenceIndependence.add(independenceKey);
  }
  for (const contract of (learning.evaluations || [])
    .filter((entry) => CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(entry.schema))) {
    if (!candidateEvidenceLineageMatchesEvaluation(learning, contract)) {
      findings.push(`invalid-candidate-evidence-lineage-binding:${contract.id || "unknown"}`);
    }
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
  const trialRetryExhaustionIds = new Set();
  const exhaustedCorrectiveEvaluations = new Set();
  const exhaustedTrialFailures = new Set();
  for (const receipt of learning.trialRetryExhaustions || []) {
    const valid = storedTrialRetryExhaustionStructure(receipt)
      && trialRetryExhaustionMatchesState(learning, receipt);
    if (!valid || trialRetryExhaustionIds.has(receipt.id)
      || exhaustedCorrectiveEvaluations.has(receipt.correctiveEvaluationId)
      || exhaustedTrialFailures.has(receipt.trialFailureId)) {
      findings.push(`invalid-trial-retry-exhaustion:${receipt.id || "unknown"}`);
    }
    trialRetryExhaustionIds.add(receipt.id);
    exhaustedCorrectiveEvaluations.add(receipt.correctiveEvaluationId);
    exhaustedTrialFailures.add(receipt.trialFailureId);
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
  const evidenceSourceAttestationRevocationIds = new Set();
  const revokedEvidenceSourceAttestations = new Set();
  for (const receipt of learning.evidenceSourceAttestationRevocations || []) {
    const key = `${receipt.evaluationId}\0${receipt.evidenceDigest}`;
    const valid = storedEvidenceSourceAttestationRevocationStructure(receipt)
      && evidenceSourceAttestationRevocationMatchesState(learning, receipt);
    if (!valid || evidenceSourceAttestationRevocationIds.has(receipt.id)
      || revokedEvidenceSourceAttestations.has(key)) {
      findings.push(`invalid-evidence-source-attestation-revocation:${receipt.id || "unknown"}`);
    }
    evidenceSourceAttestationRevocationIds.add(receipt.id);
    revokedEvidenceSourceAttestations.add(key);
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
