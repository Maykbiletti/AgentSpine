import { createHash, randomUUID } from "node:crypto";
import {
  OUTCOME_PHASES, MEASUREMENT_KINDS, ID_RE, DIGEST_RE, LINEAGE_EVALUATIONS, PAIRED_EVALUATIONS,
  ROOT_BOUND_EVALUATIONS, REGISTRY_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS, TARGET_BOUND_EVALUATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS,
  DEADLINE_BOUND_APPLICATIONS, MEASUREMENT_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  normalizeScope, scopeContains, exactScope, digest, learningTargetForCandidate, measurementPayload,
  measurementRevocationPayload, revokedMeasurement, measurementRunDigest, evaluatorRootRunDigest, activeEvaluationBinding, revokedEvaluation
} from "./learning-scope-targets.js";
import {
  revokedValidationForCandidate
} from "./learning-validation-runtime.js";
import {
  measurementLineagePayload, revokedEvidenceSourceAttestation
} from "./learning-measurement-contracts.js";
import {
  revokedApplication, revokedDelivery
} from "./learning-delivery-contracts.js";
import {
  date, number, integer, safeText, mutation
} from "./learning-storage.js";

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
    if (revokedEvidenceSourceAttestation(state, evaluation.id)) {
      throw new Error("learning evidence source attestation was explicitly revoked and cannot support measurements");
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
