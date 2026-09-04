import {
  EVIDENCE_TYPES, ID_RE, DIGEST_RE, STALENESS_BOUND_EVALUATIONS, CANDIDATE_EVIDENCE_BOUND_EVALUATIONS, BLOCKING_DEFECT_BOUND_EVALUATIONS,
  EVIDENCE_SOURCE_BOUND_EVALUATIONS, CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS
} from "./learning-schema.js";
import {
  digest, learningTargetForCandidate
} from "./learning-scope-targets.js";
import {
  qualifyingEvidenceCount, evidenceSourceAttestations, storedEvidenceSourceAttestationsStructure
} from "./learning-measurement-contracts.js";
import {
  evidenceIdentity
} from "./learning-retry-contracts.js";
import {
  evidenceConfidence
} from "./learning-storage.js";
import {
  distinctEvidence
} from "./learning-candidates.js";

export function candidateEvidencePolicyPayload({ maxAgeDays, minimumIndependentEvidence }) {
  return {
    schema: "agentspine.learning-candidate-evidence-policy/v1",
    maxAgeDays,
    minimumIndependentEvidence,
    staleEvidence: "ineligible",
    futureEvidence: "reject",
    authority: "context-only"
  };
}

export function storedCandidateEvidencePolicyStructure(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const payload = candidateEvidencePolicyPayload(policy);
  return policy.schema === "agentspine.learning-candidate-evidence-policy/v1"
    && Object.keys(policy).length === 7
    && Number.isInteger(policy.maxAgeDays) && policy.maxAgeDays >= 1 && policy.maxAgeDays <= 365
    && Number.isInteger(policy.minimumIndependentEvidence)
    && policy.minimumIndependentEvidence >= 2 && policy.minimumIndependentEvidence <= 10
    && policy.staleEvidence === "ineligible" && policy.futureEvidence === "reject"
    && policy.authority === "context-only" && policy.digest === digest(payload);
}

export function eligibleCandidateEvidence(candidate, admittedAt, maxAgeDays) {
  const admittedTime = new Date(admittedAt).getTime();
  const earliest = admittedTime - maxAgeDays * 86400000;
  return candidate.evidence.filter((entry) => {
    const observedTime = new Date(entry.observedAt).getTime();
    return observedTime >= earliest && observedTime <= admittedTime;
  });
}

export function candidateEvidenceCohort(evidence) {
  return evidence.map((entry) => ({
    evidenceDigest: digest(entry),
    independenceDigest: digest(evidenceIdentity(entry)),
    type: entry.type,
    observedAt: entry.observedAt,
    authority: "context-only"
  })).sort((left, right) => left.evidenceDigest.localeCompare(right.evidenceDigest));
}

export function storedCandidateEvidenceCohortStructure(cohort) {
  return Array.isArray(cohort) && cohort.length >= 2 && cohort.length <= 1000
    && cohort.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && Object.keys(entry).length === 5
      && Object.keys(entry).every((field) => ["evidenceDigest", "independenceDigest", "type",
        "observedAt", "authority"].includes(field))
      && DIGEST_RE.test(entry.evidenceDigest || "") && DIGEST_RE.test(entry.independenceDigest || "")
      && EVIDENCE_TYPES.has(entry.type) && Number.isFinite(new Date(entry.observedAt).getTime())
      && entry.authority === "context-only")
    && new Set(cohort.map((entry) => entry.evidenceDigest)).size === cohort.length
    && cohort.every((entry, index) => index === 0
      || cohort[index - 1].evidenceDigest.localeCompare(entry.evidenceDigest) < 0);
}

export function candidateEvidenceLineagePayload({ learningId, evaluationId, evidenceDigest,
  independenceDigest, sourceClass, targetDigest, scopeDigest, admittedAt }) {
  return {
    schema: "agentspine.learning-candidate-evidence-lineage/v1",
    learningId,
    evaluationId,
    evidenceDigest,
    independenceDigest,
    sourceClass,
    targetDigest,
    scopeDigest,
    admittedAt,
    authority: "context-only"
  };
}

export function storedCandidateEvidenceLineageStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = candidateEvidenceLineagePayload(receipt);
  return receipt.schema === "agentspine.learning-candidate-evidence-lineage/v1"
    && Object.keys(receipt).length === 11
    && Object.keys(receipt).every((field) => ["schema", "learningId", "evaluationId", "evidenceDigest",
      "independenceDigest", "sourceClass", "targetDigest", "scopeDigest", "admittedAt",
      "authority", "digest"].includes(field))
    && ID_RE.test(receipt.learningId || "") && ID_RE.test(receipt.evaluationId || "")
    && DIGEST_RE.test(receipt.evidenceDigest || "") && DIGEST_RE.test(receipt.independenceDigest || "")
    && ["explicit-user-feedback", "objective-test"].includes(receipt.sourceClass)
    && DIGEST_RE.test(receipt.targetDigest || "") && DIGEST_RE.test(receipt.scopeDigest || "")
    && Number.isFinite(new Date(receipt.admittedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function candidateEvidenceLineageReceipts({ learningId, evaluationId, attestations, targetDigest,
  scopeDigest, admittedAt }) {
  return attestations.map((attestation) => {
    const payload = candidateEvidenceLineagePayload({
      learningId,
      evaluationId,
      evidenceDigest: attestation.evidenceDigest,
      independenceDigest: attestation.independenceDigest,
      sourceClass: attestation.sourceClass,
      targetDigest,
      scopeDigest,
      admittedAt
    });
    return { ...payload, digest: digest(payload) };
  }).sort((left, right) => left.evidenceDigest.localeCompare(right.evidenceDigest));
}

export function candidateEvidenceLineageMatchesEvaluation(state, contract) {
  if (!CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(contract?.schema)) return true;
  const receipts = state.candidateEvidenceLineage.filter((entry) => entry.evaluationId === contract.id
    && entry.learningId === contract.learningId).sort((left, right) =>
    left.evidenceDigest.localeCompare(right.evidenceDigest));
  const expected = candidateEvidenceLineageReceipts({
    learningId: contract.learningId,
    evaluationId: contract.id,
    attestations: contract.candidateAdmission.evidenceSourceAttestations,
    targetDigest: contract.target.digest,
    scopeDigest: digest(contract.scope),
    admittedAt: contract.registeredAt
  });
  return receipts.length === expected.length
    && digest(receipts) === contract.candidateAdmission.evidenceLineageDigest
    && digest(receipts) === digest(expected);
}

export function candidateAdmissionPayload({ learningId, targetDigest, scopeDigest, minConfidence, minEvidence,
  observedConfidence, evidenceCount, evidencePolicy, evidenceCohort, evidenceSourceAttestations: attestations,
  evidenceLineageDigest, admittedAt,
  schema = "agentspine.learning-candidate-admission/v1" }) {
  return {
    schema,
    learningId,
    targetDigest,
    scopeDigest,
    minConfidence,
    minEvidence,
    observedConfidence,
    evidenceCount,
    ...(["agentspine.learning-candidate-admission/v2", "agentspine.learning-candidate-admission/v3",
      "agentspine.learning-candidate-admission/v4"].includes(schema)
      ? { evidencePolicy, evidenceCohort } : {}),
    ...(["agentspine.learning-candidate-admission/v3", "agentspine.learning-candidate-admission/v4"].includes(schema)
      ? { evidenceSourceAttestations: attestations } : {}),
    ...(schema === "agentspine.learning-candidate-admission/v4" ? { evidenceLineageDigest } : {}),
    decision: "eligible",
    admittedAt,
    authority: "context-only"
  };
}

export function storedCandidateAdmissionStructure(admission) {
  if (!admission || typeof admission !== "object" || Array.isArray(admission)) return false;
  const payload = candidateAdmissionPayload(admission);
  const evidenceBound = ["agentspine.learning-candidate-admission/v2",
    "agentspine.learning-candidate-admission/v3", "agentspine.learning-candidate-admission/v4"]
    .includes(admission.schema);
  const sourceAttested = ["agentspine.learning-candidate-admission/v3",
    "agentspine.learning-candidate-admission/v4"].includes(admission.schema);
  const lineageBound = admission.schema === "agentspine.learning-candidate-admission/v4";
  return ["agentspine.learning-candidate-admission/v1",
    "agentspine.learning-candidate-admission/v2",
    "agentspine.learning-candidate-admission/v3",
    "agentspine.learning-candidate-admission/v4"].includes(admission.schema)
    && Object.keys(admission).length === (lineageBound ? 16 : sourceAttested ? 15 : evidenceBound ? 14 : 12)
    && Object.keys(admission).every((field) => ["schema", "learningId", "targetDigest", "scopeDigest",
      "minConfidence", "minEvidence", "observedConfidence", "evidenceCount", "evidencePolicy",
      "evidenceCohort", "evidenceSourceAttestations", "evidenceLineageDigest", "decision", "admittedAt",
      "authority", "digest"].includes(field))
    && ID_RE.test(admission.learningId || "") && DIGEST_RE.test(admission.targetDigest || "")
    && DIGEST_RE.test(admission.scopeDigest || "")
    && Number.isFinite(admission.minConfidence) && admission.minConfidence >= 0.5 && admission.minConfidence <= 1
    && Number.isInteger(admission.minEvidence) && admission.minEvidence >= 2 && admission.minEvidence <= 10
    && Number.isFinite(admission.observedConfidence) && admission.observedConfidence >= admission.minConfidence
    && admission.observedConfidence <= 1
    && Number.isInteger(admission.evidenceCount) && admission.evidenceCount >= admission.minEvidence
    && admission.evidenceCount <= 1000 && admission.decision === "eligible"
    && (!evidenceBound || (storedCandidateEvidencePolicyStructure(admission.evidencePolicy)
      && admission.evidencePolicy.minimumIndependentEvidence === admission.minEvidence
      && storedCandidateEvidenceCohortStructure(admission.evidenceCohort)
      && admission.evidenceCohort.length >= admission.evidenceCount
      && new Set(admission.evidenceCohort.map((entry) => entry.independenceDigest)).size
        === admission.evidenceCount
      && admission.evidenceCohort.every((entry) => {
        const observedTime = new Date(entry.observedAt).getTime();
        const admittedTime = new Date(admission.admittedAt).getTime();
        return observedTime <= admittedTime
          && observedTime >= admittedTime - admission.evidencePolicy.maxAgeDays * 86400000;
      })
      && (!sourceAttested || storedEvidenceSourceAttestationsStructure(
        admission.evidenceSourceAttestations, admission.evidenceCohort, admission.admittedAt))
      && (!lineageBound || DIGEST_RE.test(admission.evidenceLineageDigest || ""))))
    && Number.isFinite(new Date(admission.admittedAt).getTime())
    && admission.authority === "context-only" && admission.digest === digest(payload);
}

export function candidateAdmissionMatches(contract, candidate) {
  const admission = contract?.candidateAdmission;
  const evidenceBound = ["agentspine.learning-candidate-admission/v2",
    "agentspine.learning-candidate-admission/v3", "agentspine.learning-candidate-admission/v4"]
    .includes(admission?.schema);
  const eligibleEvidence = evidenceBound && candidate
    ? eligibleCandidateEvidence(candidate, admission.admittedAt, admission.evidencePolicy.maxAgeDays) : [];
  const eligibleCohort = evidenceBound ? candidateEvidenceCohort(eligibleEvidence) : [];
  const eligibleCount = evidenceBound
    ? new Set(eligibleCohort.map((entry) => entry.independenceDigest)).size : null;
  return Boolean(candidate && storedCandidateAdmissionStructure(admission)
    && admission.learningId === candidate.id
    && admission.targetDigest === learningTargetForCandidate(candidate).digest
    && admission.scopeDigest === digest(contract.scope)
    && admission.minConfidence === contract.thresholds?.minConfidence
    && admission.minEvidence === contract.thresholds?.minEvidence
    && admission.observedConfidence === (evidenceBound ? evidenceConfidence(eligibleEvidence) : candidate.confidence)
    && admission.evidenceCount === (evidenceBound ? eligibleCount : distinctEvidence(candidate))
    && admission.admittedAt === contract.registeredAt
    && (!evidenceBound || (CANDIDATE_EVIDENCE_BOUND_EVALUATIONS.has(contract.schema)
      && candidate.evidence.every((entry) => new Date(entry.observedAt).getTime()
        <= new Date(admission.admittedAt).getTime())
      && admission.evidencePolicy.maxAgeDays === contract.stalenessPolicy?.outcomeMaxAgeDays
      && digest(admission.evidenceCohort) === digest(eligibleCohort)
      && (!EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(contract.schema)
        || qualifyingEvidenceCount(eligibleCohort, contract.evidenceSourcePolicy,
          admission.evidenceSourceAttestations)
          >= contract.evidenceSourcePolicy.minimumQualifyingEvidence))));
}

export function trialComparisonDigest(contract, candidateGate = null) {
  const thresholds = {
    ...contract.thresholds,
    minConfidence: contract.thresholds?.minConfidence ?? candidateGate?.minConfidence,
    minEvidence: contract.thresholds?.minEvidence ?? candidateGate?.minEvidence
  };
  const stalenessBound = STALENESS_BOUND_EVALUATIONS.has(contract.schema);
  const blockingDefectBound = BLOCKING_DEFECT_BOUND_EVALUATIONS.has(contract.schema);
  const evidenceSourceBound = EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(contract.schema);
  return digest({
    schema: evidenceSourceBound ? "agentspine.learning-trial-comparison/v4"
      : blockingDefectBound ? "agentspine.learning-trial-comparison/v3"
      : stalenessBound ? "agentspine.learning-trial-comparison/v2" : "agentspine.learning-trial-comparison/v1",
    metric: contract.metric,
    benchmark: contract.benchmark,
    evaluatorRoots: contract.evaluatorRoots,
    thresholds,
    pairing: contract.pairing,
    ...(stalenessBound ? { stalenessPolicyDigest: contract.stalenessPolicy.digest } : {}),
    ...(blockingDefectBound ? { blockingDefectPolicyDigest: contract.blockingDefectPolicy.digest } : {}),
    ...(evidenceSourceBound ? { evidenceSourcePolicyDigest: contract.evidenceSourcePolicy.digest } : {}),
    authority: "context-only"
  });
}

export function trialRetryPayload({ trialFailureId, trialFailureDigest, trialFailureRevocationId,
  trialFailureRevocationDigest, predecessorLearningId, predecessorEvaluationId,
  predecessorEvaluationDigest, comparisonDigest, rootEvaluationId, rootEvaluationDigest,
  attempt, maxAttempts, learningId, targetDigest, scopeDigest,
  minimumEvidenceObservedAt, admittedAt, schema = "agentspine.learning-trial-retry/v1" }) {
  const comparable = ["agentspine.learning-trial-retry/v2", "agentspine.learning-trial-retry/v3"].includes(schema);
  const bounded = schema === "agentspine.learning-trial-retry/v3";
  return {
    schema,
    trialFailureId,
    trialFailureDigest,
    trialFailureRevocationId,
    trialFailureRevocationDigest,
    predecessorLearningId,
    ...(comparable
      ? { predecessorEvaluationId, predecessorEvaluationDigest, comparisonDigest } : {}),
    ...(bounded ? { rootEvaluationId, rootEvaluationDigest, attempt, maxAttempts } : {}),
    learningId,
    targetDigest,
    scopeDigest,
    minimumEvidenceObservedAt,
    admittedAt,
    authority: "context-only"
  };
}

export function storedTrialRetryStructure(retry) {
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) return false;
  const payload = trialRetryPayload(retry);
  const comparable = ["agentspine.learning-trial-retry/v2", "agentspine.learning-trial-retry/v3"]
    .includes(retry.schema);
  const bounded = retry.schema === "agentspine.learning-trial-retry/v3";
  return ["agentspine.learning-trial-retry/v1", "agentspine.learning-trial-retry/v2",
    "agentspine.learning-trial-retry/v3"].includes(retry.schema)
    && Object.keys(retry).length === (bounded ? 20 : comparable ? 16 : 13)
    && Object.keys(retry).every((field) => ["schema", "trialFailureId", "trialFailureDigest",
      "trialFailureRevocationId", "trialFailureRevocationDigest", "predecessorLearningId", "learningId",
      "predecessorEvaluationId", "predecessorEvaluationDigest", "comparisonDigest", "rootEvaluationId",
      "rootEvaluationDigest", "attempt", "maxAttempts", "targetDigest", "scopeDigest",
      "minimumEvidenceObservedAt", "admittedAt", "authority", "digest"].includes(field))
    && [retry.trialFailureId, retry.trialFailureRevocationId, retry.predecessorLearningId, retry.learningId,
      ...(comparable ? [retry.predecessorEvaluationId] : []), ...(bounded ? [retry.rootEvaluationId] : [])]
      .every((value) => ID_RE.test(value || ""))
    && [retry.trialFailureDigest, retry.trialFailureRevocationDigest, retry.targetDigest, retry.scopeDigest,
      ...(comparable ? [retry.predecessorEvaluationDigest, retry.comparisonDigest] : []),
      ...(bounded ? [retry.rootEvaluationDigest] : [])]
      .every((value) => DIGEST_RE.test(value || ""))
    && (!bounded || (retry.attempt === 2 && retry.maxAttempts === 2))
    && Number.isFinite(new Date(retry.minimumEvidenceObservedAt).getTime())
    && Number.isFinite(new Date(retry.admittedAt).getTime())
    && new Date(retry.admittedAt).getTime() > new Date(retry.minimumEvidenceObservedAt).getTime()
    && retry.authority === "context-only" && retry.digest === digest(payload);
}
