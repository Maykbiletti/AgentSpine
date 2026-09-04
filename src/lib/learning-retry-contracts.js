import {
  ID_RE, DIGEST_RE, TRIAL_RETRY_EVALUATIONS, COMPARABLE_TRIAL_RETRY_EVALUATIONS, BOUNDED_TRIAL_RETRY_EVALUATIONS
} from "./learning-schema.js";
import {
  exactScope, digest, learningTargetForCandidate
} from "./learning-scope-targets.js";
import {
  trialComparisonDigest, storedTrialRetryStructure
} from "./learning-evidence-contracts.js";
import {
  trialFailureMatchesState, trialFailureRevocationMatchesState
} from "./learning-evaluation-contracts.js";

export function revokedTrialFailure(state, trialFailureId) {
  return state.trialFailureRevocations.find((receipt) => receipt.trialFailureId === trialFailureId) || null;
}

export function evidenceIdentity(evidence) {
  return evidence.sourceSha256 || evidence.sourceDocument || evidence.id;
}

export function retryableTrialFailures(state, candidate) {
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

export function trialRetryMatchesState(state, contract) {
  if (!TRIAL_RETRY_EVALUATIONS.has(contract?.schema) || !storedTrialRetryStructure(contract.retry)) return false;
  const retry = contract.retry;
  const failure = state.trialFailures.find((entry) => entry.id === retry.trialFailureId
    && entry.digest === retry.trialFailureDigest);
  const revocation = state.trialFailureRevocations.find((entry) => entry.id === retry.trialFailureRevocationId
    && entry.digest === retry.trialFailureRevocationDigest && entry.trialFailureId === retry.trialFailureId);
  const predecessor = state.candidates.find((entry) => entry.id === retry.predecessorLearningId);
  const candidate = state.candidates.find((entry) => entry.id === retry.learningId);
  const predecessorEvaluation = state.evaluations.find((entry) => entry.id === failure?.evaluationId
    && entry.digest === failure?.evaluationDigest);
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
  if (COMPARABLE_TRIAL_RETRY_EVALUATIONS.has(contract.schema)
    && (!predecessorEvaluation
      || !["agentspine.learning-trial-retry/v2", "agentspine.learning-trial-retry/v3"].includes(retry.schema)
      || retry.predecessorEvaluationId !== predecessorEvaluation.id
      || retry.predecessorEvaluationDigest !== predecessorEvaluation.digest
      || retry.comparisonDigest !== trialComparisonDigest(predecessorEvaluation, predecessor.promotion)
      || retry.comparisonDigest !== trialComparisonDigest(contract))) return false;
  if (BOUNDED_TRIAL_RETRY_EVALUATIONS.has(contract.schema)
    && (retry.schema !== "agentspine.learning-trial-retry/v3"
      || TRIAL_RETRY_EVALUATIONS.has(predecessorEvaluation?.schema)
      || retry.rootEvaluationId !== predecessorEvaluation.id
      || retry.rootEvaluationDigest !== predecessorEvaluation.digest
      || retry.attempt !== 2 || retry.maxAttempts !== 2)) return false;
  const predecessorEvidence = new Set(predecessor.evidence.map(evidenceIdentity));
  const candidateEvidence = candidate.evidence.map(evidenceIdentity);
  return candidate.evidence.length >= Math.max(2,
    contract.thresholds?.minEvidence ?? state.config.minEvidence)
    && new Set(candidateEvidence).size === candidateEvidence.length
    && candidate.evidence.every((entry) =>
    new Date(entry.observedAt).getTime() > new Date(revocation.revokedAt).getTime()
      && !predecessorEvidence.has(evidenceIdentity(entry)));
}

export function trialRetryExhaustionPayload({ id, learningId, rootEvaluationId, rootEvaluationDigest,
  correctiveEvaluationId, correctiveEvaluationDigest, trialFailureId, trialFailureDigest,
  targetDigest, scopeDigest, attempt, maxAttempts, exhaustedAt }) {
  return {
    schema: "agentspine.learning-trial-retry-exhaustion/v1",
    id,
    learningId,
    rootEvaluationId,
    rootEvaluationDigest,
    correctiveEvaluationId,
    correctiveEvaluationDigest,
    trialFailureId,
    trialFailureDigest,
    targetDigest,
    scopeDigest,
    attempt,
    maxAttempts,
    exhaustedAt,
    terminalPolicy: "no-further-retry",
    authority: "context-only"
  };
}

export function storedTrialRetryExhaustionStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = trialRetryExhaustionPayload(receipt);
  return receipt.schema === "agentspine.learning-trial-retry-exhaustion/v1"
    && Object.keys(receipt).length === 17
    && Object.keys(receipt).every((field) => ["schema", "id", "learningId", "rootEvaluationId",
      "rootEvaluationDigest", "correctiveEvaluationId", "correctiveEvaluationDigest",
      "trialFailureId", "trialFailureDigest", "targetDigest", "scopeDigest", "attempt",
      "maxAttempts", "exhaustedAt", "terminalPolicy", "authority", "digest"].includes(field))
    && [receipt.id, receipt.learningId, receipt.rootEvaluationId, receipt.correctiveEvaluationId,
      receipt.trialFailureId].every((value) => ID_RE.test(value || ""))
    && [receipt.rootEvaluationDigest, receipt.correctiveEvaluationDigest, receipt.trialFailureDigest,
      receipt.targetDigest, receipt.scopeDigest].every((value) => DIGEST_RE.test(value || ""))
    && receipt.attempt === 2 && receipt.maxAttempts === 2
    && Number.isFinite(new Date(receipt.exhaustedAt).getTime())
    && receipt.terminalPolicy === "no-further-retry"
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

export function trialRetryExhaustionMatchesState(state, receipt) {
  const correctiveEvaluation = state.evaluations.find((entry) =>
    entry.id === receipt.correctiveEvaluationId && entry.digest === receipt.correctiveEvaluationDigest
      && entry.learningId === receipt.learningId);
  const rootEvaluation = state.evaluations.find((entry) =>
    entry.id === receipt.rootEvaluationId && entry.digest === receipt.rootEvaluationDigest);
  const failure = state.trialFailures.find((entry) => entry.id === receipt.trialFailureId
    && entry.digest === receipt.trialFailureDigest && entry.learningId === receipt.learningId);
  const retry = correctiveEvaluation?.retry;
  return Boolean(correctiveEvaluation && BOUNDED_TRIAL_RETRY_EVALUATIONS.has(correctiveEvaluation.schema)
    && rootEvaluation && failure && trialFailureMatchesState(state, failure)
    && failure.evaluationId === correctiveEvaluation.id
    && failure.evaluationDigest === correctiveEvaluation.digest
    && retry?.schema === "agentspine.learning-trial-retry/v3"
    && retry.rootEvaluationId === rootEvaluation.id && retry.rootEvaluationDigest === rootEvaluation.digest
    && retry.targetDigest === receipt.targetDigest && correctiveEvaluation.target.digest === receipt.targetDigest
    && retry.scopeDigest === receipt.scopeDigest && digest(correctiveEvaluation.scope) === receipt.scopeDigest
    && retry.attempt === receipt.attempt && retry.maxAttempts === receipt.maxAttempts
    && failure.observedAt === receipt.exhaustedAt);
}

export function revalidationAdmissionWindow(state, receipt) {
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

export function revalidationAdmissionsMatchState(state) {
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
