import {
  ID_RE, DIGEST_RE, STALENESS_BOUND_EVALUATIONS, EVIDENCE_SOURCE_ATTESTED_EVALUATIONS, EVIDENCE_SOURCE_ATTESTATION_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  digest, learningTargetForCandidate
} from "./learning-scope-targets.js";

export function measurementLineagePayload({ measurementReceiptId, learningId, evaluationId, sourceDigest, runDigest,
  evaluatorRootDigest, rootRunDigest, registeredAt,
  schema = "agentspine.learning-measurement-lineage/v1" }) {
  return {
    schema, measurementReceiptId, learningId, evaluationId,
    sourceDigest, runDigest,
    ...(schema === "agentspine.learning-measurement-lineage/v2" ? { evaluatorRootDigest, rootRunDigest } : {}),
    registeredAt, authority: "context-only"
  };
}

export function storedMeasurementLineageStructure(receipt) {
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

export function initialTrialPayload({ evaluationId, learningId, scope, metric, benchmark, phase, slot,
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

export function initialTrialDigest(input) {
  return digest(initialTrialPayload(input));
}

export function storedInitialTrialPlanStructure(plan, contract) {
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

export function completionPolicyPayload({ deliveryTimeoutMs, outcomeTimeoutMs }) {
  return {
    schema: "agentspine.learning-completion-policy/v1",
    deliveryTimeoutMs,
    outcomeTimeoutMs,
    missingDelivery: "blocking-defect",
    missingOutcome: "blocking-defect",
    authority: "context-only"
  };
}

export function storedCompletionPolicyStructure(policy) {
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

export function stalenessPolicyPayload({ outcomeMaxAgeDays, canaryTtlDays }) {
  return {
    schema: "agentspine.learning-staleness-policy/v1",
    outcomeMaxAgeDays,
    canaryTtlDays,
    staleOutcome: "ineligible",
    expiredCanary: "automatic-rollback",
    authority: "context-only"
  };
}

export function storedStalenessPolicyStructure(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const payload = stalenessPolicyPayload(policy);
  return policy.schema === "agentspine.learning-staleness-policy/v1"
    && Number.isInteger(policy.outcomeMaxAgeDays) && policy.outcomeMaxAgeDays >= 1
    && policy.outcomeMaxAgeDays <= 365
    && Number.isInteger(policy.canaryTtlDays) && policy.canaryTtlDays >= 1
    && policy.canaryTtlDays <= 90
    && policy.staleOutcome === "ineligible" && policy.expiredCanary === "automatic-rollback"
    && policy.authority === "context-only" && policy.digest === digest(payload);
}

export function evaluationStalenessPolicy(contract, config) {
  return STALENESS_BOUND_EVALUATIONS.has(contract?.schema)
    ? contract.stalenessPolicy
    : { outcomeMaxAgeDays: config.outcomeMaxAgeDays, canaryTtlDays: config.canaryTtlDays };
}

export function blockingDefectPolicyPayload() {
  return {
    schema: "agentspine.learning-blocking-defect-policy/v1",
    phases: ["before", "after", "revalidation"],
    aggregation: "any-defect-overrides-average",
    beforeAction: "block-canary-admission",
    afterAction: "automatic-rollback",
    authority: "context-only"
  };
}

export function storedBlockingDefectPolicyStructure(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const payload = blockingDefectPolicyPayload();
  return Object.keys(policy).length === 7
    && JSON.stringify(policy.phases) === JSON.stringify(payload.phases)
    && policy.schema === payload.schema && policy.aggregation === payload.aggregation
    && policy.beforeAction === payload.beforeAction && policy.afterAction === payload.afterAction
    && policy.authority === "context-only" && policy.digest === digest(payload);
}

export function evidenceSourcePolicyPayload(schema = "agentspine.learning-evidence-source-policy/v1") {
  return {
    schema,
    qualifyingTypes: ["user-statement", "test"],
    minimumQualifyingEvidence: 1,
    documentOnly: "insufficient",
    interactionOnly: "insufficient",
    ...(schema === "agentspine.learning-evidence-source-policy/v2"
      ? { qualifyingEvidence: "explicit-local-attestation-required" } : {}),
    insufficientCohort: "reject-before-evaluation",
    authority: "context-only"
  };
}

export function storedEvidenceSourcePolicyStructure(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const payload = evidenceSourcePolicyPayload(policy.schema);
  const attested = policy.schema === "agentspine.learning-evidence-source-policy/v2";
  return ["agentspine.learning-evidence-source-policy/v1",
    "agentspine.learning-evidence-source-policy/v2"].includes(policy.schema)
    && Object.keys(policy).length === (attested ? 9 : 8)
    && JSON.stringify(policy.qualifyingTypes) === JSON.stringify(payload.qualifyingTypes)
    && policy.minimumQualifyingEvidence === payload.minimumQualifyingEvidence
    && policy.documentOnly === payload.documentOnly && policy.interactionOnly === payload.interactionOnly
    && (!attested || policy.qualifyingEvidence === payload.qualifyingEvidence)
    && policy.insufficientCohort === payload.insufficientCohort
    && policy.authority === "context-only" && policy.digest === digest(payload);
}

export function qualifyingEvidenceCount(cohort, policy, attestations = []) {
  if (policy.schema === "agentspine.learning-evidence-source-policy/v2") {
    return new Set(attestations.map((entry) => entry.independenceDigest)).size;
  }
  return new Set(cohort.filter((entry) => policy.qualifyingTypes.includes(entry.type))
    .map((entry) => entry.independenceDigest)).size;
}

export function evidenceSourceAttestations(cohort, confirmedAt) {
  return cohort.filter((entry) => ["user-statement", "test"].includes(entry.type)).map((entry) => ({
    schema: "agentspine.learning-evidence-source-attestation/v1",
    evidenceDigest: entry.evidenceDigest,
    independenceDigest: entry.independenceDigest,
    sourceClass: entry.type === "test" ? "objective-test" : "explicit-user-feedback",
    confirmedAt,
    authority: "context-only"
  })).sort((left, right) => left.evidenceDigest.localeCompare(right.evidenceDigest));
}

export function storedEvidenceSourceAttestationsStructure(attestations, cohort, confirmedAt) {
  const expected = evidenceSourceAttestations(cohort, confirmedAt);
  return Array.isArray(attestations) && attestations.length >= 1
    && attestations.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && Object.keys(entry).length === 6
      && entry.schema === "agentspine.learning-evidence-source-attestation/v1"
      && DIGEST_RE.test(entry.evidenceDigest || "") && DIGEST_RE.test(entry.independenceDigest || "")
      && ["explicit-user-feedback", "objective-test"].includes(entry.sourceClass)
      && entry.confirmedAt === confirmedAt && entry.authority === "context-only")
    && digest(attestations) === digest(expected);
}

export function evidenceSourceAttestationRevocationPayload({ id, learningId, evaluationId, evaluationDigest,
  candidateAdmissionDigest, evidenceDigest, independenceDigest, sourceClass, targetDigest, scopeDigest,
  reasonCode, reasonDigest, revokedAt }) {
  return {
    schema: "agentspine.learning-evidence-source-attestation-revocation/v1",
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    candidateAdmissionDigest,
    evidenceDigest,
    independenceDigest,
    sourceClass,
    targetDigest,
    scopeDigest,
    reasonCode,
    reasonDigest,
    revokedAt,
    authority: "context-only"
  };
}

export function storedEvidenceSourceAttestationRevocationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = evidenceSourceAttestationRevocationPayload(receipt);
  return receipt.schema === "agentspine.learning-evidence-source-attestation-revocation/v1"
    && Object.keys(receipt).length === 16
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "evaluationId",
      "evaluationDigest", "candidateAdmissionDigest", "evidenceDigest", "independenceDigest",
      "sourceClass", "targetDigest", "scopeDigest", "reasonCode", "reasonDigest", "revokedAt",
      "authority", "digest"].includes(field))
    && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.evaluationId || "") && DIGEST_RE.test(receipt.evaluationDigest || "")
    && DIGEST_RE.test(receipt.candidateAdmissionDigest || "") && DIGEST_RE.test(receipt.evidenceDigest || "")
    && DIGEST_RE.test(receipt.independenceDigest || "")
    && ["explicit-user-feedback", "objective-test"].includes(receipt.sourceClass)
    && DIGEST_RE.test(receipt.targetDigest || "") && DIGEST_RE.test(receipt.scopeDigest || "")
    && EVIDENCE_SOURCE_ATTESTATION_REVOCATION_REASONS.has(receipt.reasonCode)
    && DIGEST_RE.test(receipt.reasonDigest || "") && Number.isFinite(new Date(receipt.revokedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function evidenceSourceAttestationRevocationMatchesState(state, receipt) {
  const candidate = state.candidates.find((entry) => entry.id === receipt.learningId);
  const evaluation = state.evaluations.find((entry) => entry.id === receipt.evaluationId
    && entry.learningId === receipt.learningId && entry.digest === receipt.evaluationDigest);
  const attestation = evaluation?.candidateAdmission?.evidenceSourceAttestations?.find((entry) =>
    entry.evidenceDigest === receipt.evidenceDigest && entry.independenceDigest === receipt.independenceDigest
    && entry.sourceClass === receipt.sourceClass);
  return Boolean(candidate && evaluation && EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(evaluation.schema)
    && evaluation.candidateAdmission.digest === receipt.candidateAdmissionDigest
    && attestation && learningTargetForCandidate(candidate).digest === receipt.targetDigest
    && digest(evaluation.scope) === receipt.scopeDigest);
}

export function revokedEvidenceSourceAttestation(state, evaluationId, evidenceDigest = null) {
  return state.evidenceSourceAttestationRevocations.find((receipt) => receipt.evaluationId === evaluationId
    && (evidenceDigest === null || receipt.evidenceDigest === evidenceDigest)) || null;
}

export function revokedEvidenceSourceAttestationForCandidate(state, candidate) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (canary?.evaluationId) {
    return state.evidenceSourceAttestationRevocations.find((receipt) => receipt.learningId === candidate.id
      && receipt.evaluationId === canary.evaluationId && receipt.evaluationDigest === canary.evaluationDigest) || null;
  }
  return state.evidenceSourceAttestationRevocations.find((receipt) =>
    receipt.learningId === candidate?.id) || null;
}
