import { createHash, randomUUID } from "node:crypto";
import {
  OUTCOME_PHASES, MEASUREMENT_KINDS, METRIC_DIRECTIONS, ID_RE, DIGEST_RE, COVERAGE_EVALUATIONS,
  LINEAGE_EVALUATIONS, ROOT_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS, TARGET_BOUND_EVALUATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS,
  DEADLINE_BOUND_APPLICATIONS
} from "./learning-schema.js";
import {
  normalizeScope, scopeContains, exactScope, digest
} from "./learning-scope-targets.js";
import {
  date, number, integer, safeText
} from "./learning-storage.js";

export function outcomePayload({ schema = "agentspine.learning-outcome/v1", id, learningId, phase, scope, metric, measurement,
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

export function normalizeOutcome(input, candidate, timestamp, application = null, delivery = null, evaluation = null,
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
