import { join } from "node:path";
import {
  ID_RE, DIGEST_RE, COVERAGE_EVALUATIONS, ROOT_BOUND_EVALUATIONS, REGISTRY_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS,
  TARGET_BOUND_EVALUATIONS, DEADLINE_BOUND_EVALUATIONS, TRIAL_RETRY_EVALUATIONS, COMPARABLE_TRIAL_RETRY_EVALUATIONS, BOUNDED_TRIAL_RETRY_EVALUATIONS, STALENESS_BOUND_EVALUATIONS,
  PROMOTION_BOUND_EVALUATIONS, CANDIDATE_ADMISSION_EVALUATIONS, CANDIDATE_EVIDENCE_BOUND_EVALUATIONS, BLOCKING_DEFECT_BOUND_EVALUATIONS, EVIDENCE_SOURCE_BOUND_EVALUATIONS, EVIDENCE_SOURCE_ATTESTED_EVALUATIONS,
  CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS, DELIVERABLE_APPLICATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS, DEADLINE_BOUND_APPLICATIONS
} from "./learning-schema.js";
import {
  validConfig, normalizeScope, scopeContains, digest, activeEvaluationBinding
} from "./learning-scope-targets.js";
import {
  canaryValidity
} from "./learning-validation-runtime.js";
import {
  evidenceSourceAttestations
} from "./learning-measurement-contracts.js";
import {
  candidateEvidenceLineageReceipts
} from "./learning-evidence-contracts.js";
import {
  date, number, integer, loadLearning, mutation, preserve
} from "./learning-storage.js";

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
      const candidateEvidenceLineage = learning.candidateEvidenceLineage
        .filter((item) => item.learningId === candidate.id);
      const applications = learning.applications.filter((item) => item.learningId === candidate.id);
      const deliveries = learning.deliveries.filter((item) => item.learningId === candidate.id);
      const evaluations = learning.evaluations.filter((item) => item.learningId === candidate.id);
      const trialFailures = learning.trialFailures.filter((item) => item.learningId === candidate.id);
      const trialFailureRevocations = learning.trialFailureRevocations.filter((item) => item.learningId === candidate.id);
      const trialRetryExhaustions = learning.trialRetryExhaustions.filter((item) => item.learningId === candidate.id);
      const evaluationRevocations = learning.evaluationRevocations.filter((item) => item.learningId === candidate.id);
      const evidenceSourceAttestationRevocations = learning.evidenceSourceAttestationRevocations
        .filter((item) => item.learningId === candidate.id);
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
        candidateEvidenceLineageReceipts: candidateEvidenceLineage.length,
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
        stalenessBoundEvaluationContracts: evaluations.filter((contract) =>
          STALENESS_BOUND_EVALUATIONS.has(contract.schema)).length,
        promotionBoundEvaluationContracts: evaluations.filter((contract) =>
          PROMOTION_BOUND_EVALUATIONS.has(contract.schema)).length,
        candidateAdmissionEvaluationContracts: evaluations.filter((contract) =>
          CANDIDATE_ADMISSION_EVALUATIONS.has(contract.schema)).length,
        candidateEvidenceCohortEvaluationContracts: evaluations.filter((contract) =>
          CANDIDATE_EVIDENCE_BOUND_EVALUATIONS.has(contract.schema)).length,
        blockingDefectBoundEvaluationContracts: evaluations.filter((contract) =>
          BLOCKING_DEFECT_BOUND_EVALUATIONS.has(contract.schema)).length,
        evidenceSourceBoundEvaluationContracts: evaluations.filter((contract) =>
          EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(contract.schema)).length,
        evidenceSourceAttestedEvaluationContracts: evaluations.filter((contract) =>
          EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(contract.schema)).length,
        candidateEvidenceLineageEvaluationContracts: evaluations.filter((contract) =>
          CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(contract.schema)).length,
        blockingDefectOutcomeReceipts: outcomes.filter((item) => item.metric.blockingDefects > 0).length,
        activePromotionThresholdDigest: PROMOTION_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? digest({ minConfidence: initialContract.thresholds.minConfidence,
            minEvidence: initialContract.thresholds.minEvidence, authority: "context-only" }) : null,
        activeCandidateAdmissionDigest: CANDIDATE_ADMISSION_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.candidateAdmission.digest : null,
        activeCandidateEvidencePolicyDigest: CANDIDATE_EVIDENCE_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.candidateAdmission.evidencePolicy.digest : null,
        activeCandidateEvidenceCohortDigest: CANDIDATE_EVIDENCE_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? digest(initialContract.candidateAdmission.evidenceCohort) : null,
        activeBlockingDefectPolicyDigest: BLOCKING_DEFECT_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.blockingDefectPolicy.digest : null,
        activeEvidenceSourcePolicyDigest: EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.evidenceSourcePolicy.digest : null,
        activeEvidenceSourceAttestationDigest: EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(initialContract?.schema)
          ? digest(initialContract.candidateAdmission.evidenceSourceAttestations) : null,
        activeCandidateEvidenceLineageDigest: CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.candidateAdmission.evidenceLineageDigest : null,
        activeStalenessPolicyDigest: STALENESS_BOUND_EVALUATIONS.has(initialContract?.schema)
          ? initialContract.stalenessPolicy.digest : null,
        trialRetryEvaluationContracts: evaluations.filter((contract) =>
          TRIAL_RETRY_EVALUATIONS.has(contract.schema)).length,
        comparableTrialRetryEvaluationContracts: evaluations.filter((contract) =>
          COMPARABLE_TRIAL_RETRY_EVALUATIONS.has(contract.schema)).length,
        boundedTrialRetryEvaluationContracts: evaluations.filter((contract) =>
          BOUNDED_TRIAL_RETRY_EVALUATIONS.has(contract.schema)).length,
        trialRetryExhaustionReceipts: trialRetryExhaustions.length,
        trialRetryBudgetStatus: trialRetryExhaustions.length > 0 ? "exhausted"
          : evaluations.some((contract) => BOUNDED_TRIAL_RETRY_EVALUATIONS.has(contract.schema)) ? "bounded"
          : "not-applicable",
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
        evidenceSourceAttestationRevocationReceipts: evidenceSourceAttestationRevocations.length,
        revokedEvidenceSourceAttestationDigests: evidenceSourceAttestationRevocations
          .map((receipt) => receipt.evidenceDigest).sort(),
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
          : canaryValidityStatus.status === "revoked-evidence-source-attestation"
            ? "revoked-evidence-source-attestation"
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
  const visibleCandidateIds = new Set(records.map((record) => record.id));
  const visibleEvaluations = runtimeScope === null ? learning.evaluations
    : learning.evaluations.filter((contract) => visibleCandidateIds.has(contract.learningId));
  const visibleEvaluationIds = new Set(visibleEvaluations.map((contract) => contract.id));
  const visibleEvaluatorIds = new Set(visibleEvaluations.flatMap((contract) => [
    ...(contract.evaluatorIds || []),
    ...(contract.evaluatorRoots || []).map((entry) => entry.evaluatorId)
  ]));
  const visibleEvaluatorRegistry = runtimeScope === null ? learning.evaluatorRegistry
    : learning.evaluatorRegistry.filter((record) => visibleEvaluatorIds.has(record.id));
  const visibleEvaluationBindings = runtimeScope === null ? learning.evaluationBindings
    : learning.evaluationBindings.filter((binding) => visibleEvaluationIds.has(binding.evaluationId));
  const visibleValidationLeases = runtimeScope === null ? learning.validationLeases
    : learning.validationLeases.filter((lease) => visibleCandidateIds.has(lease.learningId)
      && visibleEvaluationIds.has(lease.evaluationId));
  const visibleCandidateEvidenceLineage = runtimeScope === null ? learning.candidateEvidenceLineage
    : learning.candidateEvidenceLineage.filter((receipt) => receipt.scopeDigest === digest(runtimeScope));
  const recordTotal = (field) => records.reduce((sum, record) => sum + record[field], 0);
  return {
    schema: "agentspine.learning-outcome-status/v1",
    root: learning.root,
    evaluatorRegistry: {
      active: visibleEvaluatorRegistry.filter((record) => record.status === "active").length,
      revoked: visibleEvaluatorRegistry.filter((record) => record.status === "revoked").length,
      bindings: visibleEvaluationBindings.length,
      validationLeases: visibleValidationLeases.length,
      authority: "context-only"
    },
    trialRetryEvaluationContracts: recordTotal("trialRetryEvaluationContracts"),
    comparableTrialRetryEvaluationContracts: recordTotal("comparableTrialRetryEvaluationContracts"),
    boundedTrialRetryEvaluationContracts: recordTotal("boundedTrialRetryEvaluationContracts"),
    stalenessBoundEvaluationContracts: recordTotal("stalenessBoundEvaluationContracts"),
    promotionBoundEvaluationContracts: recordTotal("promotionBoundEvaluationContracts"),
    candidateAdmissionEvaluationContracts: recordTotal("candidateAdmissionEvaluationContracts"),
    candidateEvidenceCohortEvaluationContracts: recordTotal("candidateEvidenceCohortEvaluationContracts"),
    blockingDefectBoundEvaluationContracts: recordTotal("blockingDefectBoundEvaluationContracts"),
    evidenceSourceBoundEvaluationContracts: recordTotal("evidenceSourceBoundEvaluationContracts"),
    evidenceSourceAttestedEvaluationContracts: recordTotal("evidenceSourceAttestedEvaluationContracts"),
    candidateEvidenceLineageEvaluationContracts: recordTotal("candidateEvidenceLineageEvaluationContracts"),
    candidateEvidenceLineageReceipts: visibleCandidateEvidenceLineage.length,
    blockingDefectOutcomeReceipts: recordTotal("blockingDefectOutcomeReceipts"),
    trialRetryExhaustions: recordTotal("trialRetryExhaustionReceipts"),
    trialFailureRevocations: recordTotal("trialFailureRevocationReceipts"),
    evaluationRevocations: recordTotal("evaluationRevocationReceipts"),
    evidenceSourceAttestationRevocations: recordTotal("evidenceSourceAttestationRevocationReceipts"),
    validationRevocations: recordTotal("validationRevocationReceipts"),
    evidenceRevocations: recordTotal("evidenceRevocationReceipts"),
    measurementRevocations: recordTotal("measurementRevocationReceipts"),
    applicationRevocations: recordTotal("applicationRevocationReceipts"),
    deliveryRevocations: recordTotal("deliveryRevocationReceipts"),
    outcomeRevocations: recordTotal("outcomeRevocationReceipts"),
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
    state.trialRetryExhaustions = state.trialRetryExhaustions.filter((entry) => entry.learningId !== id);
    state.evaluationRevocations = state.evaluationRevocations.filter((entry) => entry.learningId !== id);
    state.evidenceSourceAttestationRevocations = state.evidenceSourceAttestationRevocations
      .filter((entry) => entry.learningId !== id);
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
    state.trialRetryExhaustions = state.trialRetryExhaustions.filter((entry) => !ids.has(entry.learningId));
    state.evaluationRevocations = state.evaluationRevocations.filter((entry) => !ids.has(entry.learningId));
    state.evidenceSourceAttestationRevocations = state.evidenceSourceAttestationRevocations
      .filter((entry) => !ids.has(entry.learningId));
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
