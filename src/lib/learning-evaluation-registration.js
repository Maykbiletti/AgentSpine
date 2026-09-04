import { createHash, randomUUID } from "node:crypto";
import {
  METRIC_DIRECTIONS, ID_RE, DIGEST_RE, TRIAL_RETRY_EVALUATIONS, STALENESS_BOUND_EVALUATIONS, CANDIDATE_EVIDENCE_BOUND_EVALUATIONS,
  BLOCKING_DEFECT_BOUND_EVALUATIONS, EVIDENCE_SOURCE_BOUND_EVALUATIONS, EVIDENCE_SOURCE_ATTESTED_EVALUATIONS, CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS
} from "./learning-schema.js";
import {
  normalizeScope, scopeContains, exactScope, digest, learningTargetForCandidate, evaluationBindingPayload,
  activeEvaluatorRecord
} from "./learning-scope-targets.js";
import {
  initialTrialDigest, completionPolicyPayload, stalenessPolicyPayload, blockingDefectPolicyPayload, evidenceSourcePolicyPayload, qualifyingEvidenceCount,
  evidenceSourceAttestations
} from "./learning-measurement-contracts.js";
import {
  candidateEvidencePolicyPayload, eligibleCandidateEvidence, candidateEvidenceCohort, candidateEvidenceLineageReceipts, candidateAdmissionPayload, trialComparisonDigest,
  trialRetryPayload
} from "./learning-evidence-contracts.js";
import {
  evaluationPayload
} from "./learning-evaluation-contracts.js";
import {
  retryableTrialFailures, trialRetryMatchesState
} from "./learning-retry-contracts.js";
import {
  date, integer, safeText, mutation, evidenceConfidence
} from "./learning-storage.js";

export async function registerLearningEvaluation({
  root = process.cwd(), id = `evaluation:${randomUUID()}`, learningId, scope, metric, benchmark,
  evaluatorIds, evaluatorRoots, expiresAt = null, retryTrialFailureId = null,
  confirmLocalEvaluation = false, confirmLocalTrialRetry = false,
  confirmLocalEvidenceSources = false, now = new Date()
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
    let thresholds = {
      minImprovement: state.config.minImprovement,
      regressionTolerance: state.config.regressionTolerance,
      beforeReceipts: requiredEvaluators,
      afterReceipts: requiredEvaluators,
      minConfidence: state.config.minConfidence,
      minEvidence: Math.max(2, state.config.minEvidence)
    };
    const pairing = {
      mode: "same-evaluator",
      maxOutcomesPerEvaluatorPerPhase: 1,
      matchMeasurementKind: true,
      matchCaseCount: true,
      authority: "context-only"
    };
    const target = learningTargetForCandidate(candidate);
    const stalenessPolicyPayloadValue = stalenessPolicyPayload({
      outcomeMaxAgeDays: state.config.outcomeMaxAgeDays,
      canaryTtlDays: state.config.canaryTtlDays
    });
    const stalenessPolicy = {
      ...stalenessPolicyPayloadValue,
      digest: digest(stalenessPolicyPayloadValue)
    };
    const blockingDefectPolicyPayloadValue = blockingDefectPolicyPayload();
    const blockingDefectPolicy = {
      ...blockingDefectPolicyPayloadValue,
      digest: digest(blockingDefectPolicyPayloadValue)
    };
    const evidenceSourcePolicyPayloadValue = evidenceSourcePolicyPayload(
      "agentspine.learning-evidence-source-policy/v2");
    let evidenceSourcePolicy = {
      ...evidenceSourcePolicyPayloadValue,
      digest: digest(evidenceSourcePolicyPayloadValue)
    };
    const retryable = retryableTrialFailures(state, candidate);
    let retry = null;
    let evaluationSchema = "agentspine.learning-evaluation/v28";
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
      const predecessorEvaluation = state.evaluations.find((entry) =>
        entry.id === selected.failure.evaluationId && entry.digest === selected.failure.evaluationDigest);
      if (!predecessorEvaluation) {
        throw new Error("trial retry predecessor evaluation is missing or changed");
      }
      if (EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(predecessorEvaluation.schema)
        && !EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(predecessorEvaluation.schema)) {
        evidenceSourcePolicy = predecessorEvaluation.evidenceSourcePolicy;
      }
      if (state.trialRetryExhaustions.some((receipt) => receipt.trialFailureId === selected.failure.id
        && receipt.trialFailureDigest === selected.failure.digest)) {
        throw new Error("trial retry budget is exhausted by an immutable terminal receipt");
      }
      if (TRIAL_RETRY_EVALUATIONS.has(predecessorEvaluation.schema)) {
        throw new Error("trial retry budget is exhausted; a failed corrective Canary cannot be retried again");
      }
      evaluationSchema = EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(predecessorEvaluation.schema)
        ? "agentspine.learning-evaluation/v29"
        : EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(predecessorEvaluation.schema)
        ? "agentspine.learning-evaluation/v25"
        : BLOCKING_DEFECT_BOUND_EVALUATIONS.has(predecessorEvaluation.schema)
          ? "agentspine.learning-evaluation/v23"
          : STALENESS_BOUND_EVALUATIONS.has(predecessorEvaluation.schema)
          ? "agentspine.learning-evaluation/v21"
          : "agentspine.learning-evaluation/v13";
      const comparisonDigest = trialComparisonDigest({
        schema: evaluationSchema,
        metric: normalizedMetric,
        benchmark: normalizedBenchmark,
        evaluatorRoots: normalizedRoots,
        thresholds,
        pairing,
        stalenessPolicy,
        blockingDefectPolicy,
        evidenceSourcePolicy
      });
      if (comparisonDigest !== trialComparisonDigest(predecessorEvaluation, selected.predecessor.promotion)) {
        throw new Error("trial retry objective contract drift is not allowed");
      }
      const retryPayload = trialRetryPayload({
        schema: "agentspine.learning-trial-retry/v3",
        trialFailureId: selected.failure.id,
        trialFailureDigest: selected.failure.digest,
        trialFailureRevocationId: selected.revocation.id,
        trialFailureRevocationDigest: selected.revocation.digest,
        predecessorLearningId: selected.predecessor.id,
        predecessorEvaluationId: predecessorEvaluation.id,
        predecessorEvaluationDigest: predecessorEvaluation.digest,
        comparisonDigest,
        rootEvaluationId: predecessorEvaluation.id,
        rootEvaluationDigest: predecessorEvaluation.digest,
        attempt: 2,
        maxAttempts: 2,
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
    const evidencePolicyPayloadValue = candidateEvidencePolicyPayload({
      maxAgeDays: stalenessPolicy.outcomeMaxAgeDays,
      minimumIndependentEvidence: thresholds.minEvidence
    });
    const evidencePolicy = {
      ...evidencePolicyPayloadValue,
      digest: digest(evidencePolicyPayloadValue)
    };
    const eligibleEvidence = eligibleCandidateEvidence(candidate, timestamp, evidencePolicy.maxAgeDays);
    const evidenceCohort = candidateEvidenceCohort(eligibleEvidence);
    if (EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(evaluationSchema) && !confirmLocalEvidenceSources) {
      throw new Error("qualifying evidence sources require explicit local confirmation");
    }
    const sourceAttestations = EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(evaluationSchema)
      ? evidenceSourceAttestations(evidenceCohort, timestamp) : [];
    const evidenceCount = new Set(evidenceCohort.map((entry) => entry.independenceDigest)).size;
    const observedConfidence = evidenceConfidence(eligibleEvidence);
    if (candidate.evidence.some((entry) => new Date(entry.observedAt).getTime() > new Date(timestamp).getTime())) {
      throw new Error("evaluation candidate evidence cannot be observed in the future");
    }
    if (EVIDENCE_SOURCE_BOUND_EVALUATIONS.has(evaluationSchema)
      && qualifyingEvidenceCount(evidenceCohort, evidenceSourcePolicy, sourceAttestations)
        < evidenceSourcePolicy.minimumQualifyingEvidence) {
      throw new Error("evaluation requires fresh explicit-user or objective-test evidence; interaction- or document-only cohorts are insufficient");
    }
    if (!retry && (observedConfidence < thresholds.minConfidence || evidenceCount < thresholds.minEvidence)) {
      throw new Error("evaluation requires a candidate that already satisfies the frozen confidence and evidence gates");
    }
    const evidenceLineage = CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(evaluationSchema)
      ? candidateEvidenceLineageReceipts({
        learningId: candidate.id,
        evaluationId: id,
        attestations: sourceAttestations,
        targetDigest: target.digest,
        scopeDigest: digest(normalizedScope),
        admittedAt: timestamp
      }) : [];
    const liveIdempotentEvaluation = state.evaluations.some((entry) => entry.id === id
      && entry.learningId === candidate.id);
    for (const lineage of evidenceLineage) {
      const existingLineage = state.candidateEvidenceLineage.find((entry) =>
        entry.scopeDigest === lineage.scopeDigest
        && (entry.evidenceDigest === lineage.evidenceDigest
          || entry.independenceDigest === lineage.independenceDigest));
      if (existingLineage && (!liveIdempotentEvaluation || existingLineage.evaluationId !== id
        || existingLineage.learningId !== candidate.id || existingLineage.digest !== lineage.digest)) {
        throw new Error("qualifying candidate evidence was already admitted in this exact scope and cannot be replayed");
      }
    }
    const candidateAdmissionPayloadValue = candidateAdmissionPayload({
      schema: EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(evaluationSchema)
        ? CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS.has(evaluationSchema)
          ? "agentspine.learning-candidate-admission/v4"
          : "agentspine.learning-candidate-admission/v3"
        : CANDIDATE_EVIDENCE_BOUND_EVALUATIONS.has(evaluationSchema)
        ? "agentspine.learning-candidate-admission/v2"
        : "agentspine.learning-candidate-admission/v1",
      learningId: candidate.id,
      targetDigest: target.digest,
      scopeDigest: digest(normalizedScope),
      minConfidence: thresholds.minConfidence,
      minEvidence: thresholds.minEvidence,
      observedConfidence,
      evidenceCount,
      evidencePolicy,
      evidenceCohort,
      evidenceSourceAttestations: sourceAttestations,
      evidenceLineageDigest: evidenceLineage.length ? digest(evidenceLineage) : undefined,
      admittedAt: timestamp
    });
    const candidateAdmission = {
      ...candidateAdmissionPayloadValue,
      digest: digest(candidateAdmissionPayloadValue)
    };
    const completionPolicyPayloadValue = completionPolicyPayload({
      deliveryTimeoutMs: 5 * 60_000,
      outcomeTimeoutMs: state.config.initialTrialOutcomeTimeoutMinutes * 60_000
    });
    const completionPolicy = {
      ...completionPolicyPayloadValue,
      digest: digest(completionPolicyPayloadValue)
    };
    const payload = evaluationPayload({
      schema: evaluationSchema,
      id, learningId, scope: normalizedScope, metric: normalizedMetric,
      benchmark: normalizedBenchmark,
      evaluatorIds: normalizedEvaluators,
      evaluatorRoots: normalizedRoots,
      thresholds,
      pairing,
      initialTrials,
      target,
      completionPolicy,
      stalenessPolicy,
      blockingDefectPolicy,
      evidenceSourcePolicy,
      candidateAdmission,
      retry,
      registeredAt: timestamp, expiresAt: expiry
    });
    const contract = { ...payload, digest: digest(payload) };
    if (retry && !trialRetryMatchesState(state, contract)) {
      throw new Error("trial retry requires a fresh candidate and independently observed evidence after revocation");
    }
    if (retry && (observedConfidence < thresholds.minConfidence || evidenceCount < thresholds.minEvidence)) {
      throw new Error("evaluation requires a candidate that already satisfies the frozen confidence and evidence gates");
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
    state.candidateEvidenceLineage.push(...evidenceLineage);
    state.candidateEvidenceLineage.sort((a, b) => a.evidenceDigest.localeCompare(b.evidenceDigest)
      || a.scopeDigest.localeCompare(b.scopeDigest));
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
