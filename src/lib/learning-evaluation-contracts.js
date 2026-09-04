import { join } from "node:path";
import {
  METRIC_DIRECTIONS, SCOPE_FIELDS, ID_RE, DIGEST_RE, EVALUATION_SCHEMAS, PAIRED_EVALUATIONS,
  ROOT_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS, TARGET_BOUND_EVALUATIONS, DEADLINE_BOUND_EVALUATIONS, TRIAL_RETRY_EVALUATIONS, COMPARABLE_TRIAL_RETRY_EVALUATIONS,
  STALENESS_BOUND_EVALUATIONS, PROMOTION_BOUND_EVALUATIONS, CANDIDATE_ADMISSION_EVALUATIONS, CANDIDATE_EVIDENCE_BOUND_EVALUATIONS, BLOCKING_DEFECT_BOUND_EVALUATIONS, EVIDENCE_SOURCE_BOUND_EVALUATIONS,
  EVIDENCE_SOURCE_ATTESTED_EVALUATIONS, CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS, DELIVERABLE_APPLICATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS, DEADLINE_BOUND_APPLICATIONS,
  TRIAL_FAILURE_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  exactScope, digest, learningTargetForCandidate, storedLearningTargetStructure, learningTargetMatchesCandidate
} from "./learning-scope-targets.js";
import {
  storedInitialTrialPlanStructure, storedCompletionPolicyStructure, storedStalenessPolicyStructure, storedBlockingDefectPolicyStructure, storedEvidenceSourcePolicyStructure
} from "./learning-measurement-contracts.js";
import {
  storedCandidateAdmissionStructure, storedTrialRetryStructure
} from "./learning-evidence-contracts.js";

export function evaluationPayload({ id, learningId, scope, metric, benchmark, evaluatorIds, evaluatorRoots, thresholds, pairing,
  initialTrials, target, completionPolicy, stalenessPolicy, blockingDefectPolicy, evidenceSourcePolicy,
  candidateAdmission, retry, registeredAt, expiresAt,
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
    ...(STALENESS_BOUND_EVALUATIONS.has(schema) ? { stalenessPolicy } : {}),
    ...(BLOCKING_DEFECT_BOUND_EVALUATIONS.has(schema) ? { blockingDefectPolicy } : {}),
    ...(EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(schema) ? { evidenceSourcePolicy } : {}),
    ...(CANDIDATE_ADMISSION_EVALUATIONS.has(schema) ? { candidateAdmission } : {}),
    ...(TRIAL_RETRY_EVALUATIONS.has(schema) ? { retry } : {}),
    registeredAt, expiresAt, authority: "context-only"
  };
}

export function storedEvaluationStructure(contract) {
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
    && (!(COMPARABLE_TRIAL_RETRY_EVALUATIONS.has(contract.schema)
      || PROMOTION_BOUND_EVALUATIONS.has(contract.schema))
      || (Number.isFinite(contract.thresholds?.minConfidence)
        && contract.thresholds.minConfidence >= 0.5 && contract.thresholds.minConfidence <= 1
        && Number.isInteger(contract.thresholds?.minEvidence)
        && contract.thresholds.minEvidence >= 2 && contract.thresholds.minEvidence <= 10))
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
    && (!STALENESS_BOUND_EVALUATIONS.has(contract.schema)
      || storedStalenessPolicyStructure(contract.stalenessPolicy))
    && (!BLOCKING_DEFECT_BOUND_EVALUATIONS.has(contract.schema)
      || storedBlockingDefectPolicyStructure(contract.blockingDefectPolicy))
    && (!EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(contract.schema)
      || storedEvidenceSourcePolicyStructure(contract.evidenceSourcePolicy))
    && (!CANDIDATE_ADMISSION_EVALUATIONS.has(contract.schema)
      || (storedCandidateAdmissionStructure(contract.candidateAdmission)
        && contract.candidateAdmission.schema === (CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(contract.schema)
          ? "agentspine.learning-candidate-admission/v4"
          : EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(contract.schema)
          ? "agentspine.learning-candidate-admission/v3"
          : CANDIDATE_EVIDENCE_BOUND_EVALUATIONS.has(contract.schema)
          ? "agentspine.learning-candidate-admission/v2"
          : "agentspine.learning-candidate-admission/v1")
        && contract.candidateAdmission.learningId === contract.learningId
        && contract.candidateAdmission.targetDigest === contract.target?.digest
        && contract.candidateAdmission.scopeDigest === digest(contract.scope)
        && contract.candidateAdmission.minConfidence === contract.thresholds?.minConfidence
        && contract.candidateAdmission.minEvidence === contract.thresholds?.minEvidence
        && contract.candidateAdmission.admittedAt === contract.registeredAt))
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

export function applicationPayload({ id, learningId, scope, preflightReceiptId, promptDigest,
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

export function storedApplicationStructure(receipt) {
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

export function initialAdmissionsMatchState(state) {
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

export function trialFailurePayload({ id, learningId, evaluationId, evaluationDigest, applicationId, applicationDigest,
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

export function storedTrialFailureStructure(receipt) {
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

export function trialFailureMatchesState(state, receipt) {
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

export function trialFailureRevocationPayload({ id, learningId, evaluationId, evaluationDigest,
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

export function storedTrialFailureRevocationStructure(receipt) {
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

export function trialFailureRevocationMatchesState(state, receipt) {
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
