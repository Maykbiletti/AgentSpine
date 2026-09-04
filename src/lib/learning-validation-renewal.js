import { createHash, randomUUID } from "node:crypto";
import {
  ID_RE, REGISTRY_BOUND_EVALUATIONS
} from "./learning-schema.js";
import {
  exactScope, digest, revokedMeasurement
} from "./learning-scope-targets.js";
import {
  revokedEvaluationForCandidate, revalidationTrialDigest, storedRevalidationWindowStructure, validationLeasePayload
} from "./learning-validation-contracts.js";
import {
  validationLeaseState
} from "./learning-validation-runtime.js";
import {
  evaluationStalenessPolicy, revokedEvidenceSourceAttestationForCandidate
} from "./learning-measurement-contracts.js";
import {
  revokedApplication, revokedApplicationForCandidate, revokedDelivery, revokedOutcomeForCandidate
} from "./learning-delivery-contracts.js";
import {
  date, mutation, preserve
} from "./learning-storage.js";
import {
  improvement, rollbackCandidate
} from "./learning-reconciliation.js";

export function validationEvidencePreviouslyUsed(state, measurementId, applicationId, deliveryId) {
  const leases = [
    ...state.validationLeases,
    ...state.history.filter((entry) => entry.kind === "learning-validation").map((entry) => entry.value)
  ];
  return leases.some((lease) => ["agentspine.learning-validation/v2", "agentspine.learning-validation/v3",
    "agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease?.schema)
    && lease.renewalEvidence?.some((entry) => entry.measurementId === measurementId
      || entry.applicationId === applicationId || entry.deliveryId === deliveryId));
}

export async function renewLearningValidation({
  root = process.cwd(), learningId, evidence, confirmLocalValidation = false, now = new Date()
}) {
  if (!confirmLocalValidation) throw new Error("validation renewal requires explicit local confirmation");
  if (!ID_RE.test(learningId || "") || !Array.isArray(evidence) || !evidence.length) {
    throw new Error("validation renewal requires a learningId and evidence bindings");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (revokedEvaluationForCandidate(state, candidate)) {
      throw new Error("validation renewal baseline contains an explicitly revoked evaluation contract");
    }
    if (revokedEvidenceSourceAttestationForCandidate(state, candidate)) {
      throw new Error("validation renewal baseline contains an explicitly revoked evidence source attestation");
    }
    if (revokedApplicationForCandidate(state, candidate)) {
      throw new Error("validation renewal baseline contains an explicitly revoked application");
    }
    if (revokedOutcomeForCandidate(state, candidate)) {
      throw new Error("validation renewal baseline contains an explicitly revoked outcome");
    }
    const validation = validationLeaseState(state, candidate, timestamp);
    const revalidation = candidate?.promotion?.canary?.revalidation;
    if (validation.status !== "active"
      || !REGISTRY_BOUND_EVALUATIONS.has(validation.evaluation?.schema)
      || revalidation?.status !== "active" || revalidation.predecessorValidationId !== validation.lease.id
      || revalidation.predecessorValidationDigest !== validation.lease.digest
      || !storedRevalidationWindowStructure(revalidation)
      || new Date(revalidation.expiresAt).getTime() < new Date(timestamp).getTime()) {
      throw new Error("validation renewal requires one current matching revalidation window");
    }
    const contract = validation.evaluation;
    const baselineReferences = validation.lease.schema === "agentspine.learning-validation/v1"
      ? validation.lease.beforeOutcomes : validation.lease.baselineOutcomes;
    const baselines = baselineReferences.map((reference) => state.outcomes.find((outcome) =>
      outcome.id === reference.id && outcome.digest === reference.digest));
    if (baselines.some((item) => !item)) throw new Error("validation renewal baseline evidence is missing");
    const baselineByRoot = new Map(baselines.map((item) => [item.measurement.evaluatorRootDigest, item]));
    let normalized = evidence.map((entry) => {
      const measurement = state.measurements.find((item) => item.id === entry?.measurementId);
      const application = state.applications.find((item) => item.id === entry?.applicationId);
      const delivery = state.deliveries.find((item) => item.id === entry?.deliveryId);
      if (!measurement || !application || !delivery) throw new Error("validation renewal evidence binding is missing");
      if (revokedApplication(state, application.id)) {
        throw new Error("validation renewal application was explicitly revoked");
      }
      if (revokedMeasurement(state, measurement.id)) {
        throw new Error("validation renewal measurement was explicitly revoked");
      }
      if (revokedDelivery(state, delivery.id)) {
        throw new Error("validation renewal delivery was explicitly revoked");
      }
      const baseline = baselineByRoot.get(measurement.measurement?.evaluatorRootDigest);
      if (measurement.phase !== "after" || measurement.learningId !== learningId
        || measurement.evaluationId !== contract.id || !exactScope(measurement.scope, contract.scope)
        || !baseline || measurement.measurement.kind === "model-suggestion"
        || measurement.measurement.kind !== baseline.measurement.kind
        || measurement.coverage.caseCount !== baseline.coverage.caseCount
        || new Date(measurement.measuredAt).getTime() < new Date(revalidation.startedAt).getTime()) {
        throw new Error("validation renewal measurement does not match the frozen baseline cohort");
      }
      if (application.learningId !== learningId || !exactScope(application.scope, contract.scope)
        || new Date(application.projectedAt).getTime() < new Date(revalidation.startedAt).getTime()
        || delivery.applicationId !== application.id || delivery.learningId !== learningId
        || !exactScope(delivery.scope, contract.scope)
        || new Date(measurement.measuredAt).getTime() < new Date(delivery.completedAt).getTime()
        || new Date(measurement.measuredAt).getTime() > new Date(application.expiresAt).getTime()) {
        throw new Error("validation renewal requires a distinct completed matching model turn");
      }
      if (validationEvidencePreviouslyUsed(state, measurement.id, application.id, delivery.id)) {
        throw new Error("validation renewal evidence cannot be replayed");
      }
      return { measurement, application, delivery, baseline };
    });
    let selectionProof = null;
    if (revalidation.schema === "agentspine.learning-revalidation-window/v2") {
      const required = revalidation.selection.requiredDeliveries;
      if (normalized.length !== required) {
        throw new Error("validation renewal must measure the complete precommitted delivery cohort");
      }
      const completed = state.deliveries.filter((delivery) => delivery.learningId === learningId
        && exactScope(delivery.scope, contract.scope)
        && new Date(delivery.completedAt).getTime() >= new Date(revalidation.startedAt).getTime()
        && new Date(delivery.completedAt).getTime() <= new Date(revalidation.expiresAt).getTime()
        && state.applications.some((application) => application.id === delivery.applicationId
          && application.learningId === learningId && exactScope(application.scope, contract.scope)
          && new Date(application.projectedAt).getTime() >= new Date(revalidation.startedAt).getTime()))
        .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id))
        .slice(0, required);
      if (completed.length !== required) {
        throw new Error("validation renewal first-completed delivery cohort is not complete");
      }
      normalized = completed.map((delivery, index) => {
        const selected = normalized.find((item) => item.delivery.id === delivery.id);
        const frozenRoot = revalidation.selection.evaluatorRoots[index];
        if (!selected) {
          throw new Error("validation renewal cannot omit or replace a precommitted completed turn");
        }
        if (selected.measurement.measurement.evaluatorRootDigest !== frozenRoot.evaluatorRootDigest) {
          throw new Error("validation renewal evaluator root does not match its precommitted turn slot");
        }
        return selected;
      });
      selectionProof = {
        revalidationWindowId: revalidation.id,
        revalidationWindowDigest: revalidation.digest,
        mode: revalidation.selection.mode,
        requiredDeliveries: required,
        deliveries: normalized.map((item, index) => ({
          slot: index + 1,
          deliveryId: item.delivery.id,
          deliveryDigest: item.delivery.digest,
          evaluatorRootDigest: item.measurement.measurement.evaluatorRootDigest,
          authority: "context-only"
        })),
        authority: "context-only"
      };
    } else if (["agentspine.learning-revalidation-window/v3",
      "agentspine.learning-revalidation-window/v4"].includes(revalidation.schema)) {
      const required = revalidation.selection.requiredDeliveries;
      if (normalized.length !== required) {
        throw new Error("validation renewal must measure the complete precommitted admission cohort");
      }
      const trialBound = revalidation.schema === "agentspine.learning-revalidation-window/v4";
      const admitted = state.applications.filter((application) =>
        application.schema === (trialBound ? "agentspine.learning-application/v4" : "agentspine.learning-application/v3")
        && application.learningId === learningId && exactScope(application.scope, contract.scope)
        && application.revalidationAdmission.revalidationWindowId === revalidation.id
        && application.revalidationAdmission.revalidationWindowDigest === revalidation.digest)
        .sort((a, b) => a.revalidationAdmission.slot - b.revalidationAdmission.slot);
      if (admitted.length !== required) {
        throw new Error("validation renewal first-admitted turn cohort is not complete");
      }
      normalized = admitted.map((application, index) => {
        const selected = normalized.find((item) => item.application.id === application.id);
        const admission = application.revalidationAdmission;
        const frozenRoot = revalidation.selection.evaluatorRoots[index];
        if (!selected) {
          throw new Error("validation renewal cannot omit or replace a precommitted admitted turn");
        }
        if (admission.slot !== index + 1 || admission.evaluatorRootDigest !== frozenRoot.evaluatorRootDigest
          || selected.measurement.measurement.evaluatorRootDigest !== frozenRoot.evaluatorRootDigest
          || (trialBound && (admission.evaluatorId !== frozenRoot.evaluatorId
            || admission.runId !== frozenRoot.runId || admission.trialDigest !== frozenRoot.trialDigest
            || selected.measurement.measurement.evaluatorId !== frozenRoot.evaluatorId
            || selected.measurement.measurement.runId !== frozenRoot.runId
            || selected.measurement.coverage.caseCount !== frozenRoot.caseCount
            || frozenRoot.trialDigest !== revalidationTrialDigest({
              evaluationId: contract.id, evaluationDigest: contract.digest,
              predecessorValidationId: validation.lease.id,
              predecessorValidationDigest: validation.lease.digest,
              slot: frozenRoot.slot, evaluatorId: frozenRoot.evaluatorId,
              evaluatorRootDigest: frozenRoot.evaluatorRootDigest, runId: frozenRoot.runId,
              benchmark: contract.benchmark, caseCount: frozenRoot.caseCount
            })))) {
          throw new Error("validation renewal evaluator root does not match its precommitted admission slot");
        }
        return selected;
      });
      selectionProof = {
        revalidationWindowId: revalidation.id,
        revalidationWindowDigest: revalidation.digest,
        mode: revalidation.selection.mode,
        requiredDeliveries: required,
        applications: normalized.map((item, index) => ({
          slot: index + 1,
          applicationId: item.application.id,
          applicationDigest: item.application.digest,
          deliveryId: item.delivery.id,
          deliveryDigest: item.delivery.digest,
          evaluatorRootDigest: item.measurement.measurement.evaluatorRootDigest,
          ...(trialBound ? {
            evaluatorId: item.measurement.measurement.evaluatorId,
            runId: item.measurement.measurement.runId,
            trialDigest: revalidation.selection.evaluatorRoots[index].trialDigest
          } : {}),
          authority: "context-only"
        })),
        authority: "context-only"
      };
    }
    const roots = new Set(normalized.map((item) => item.measurement.measurement.evaluatorRootDigest));
    const applications = new Set(normalized.map((item) => item.application.id));
    if (roots.size < contract.thresholds.afterReceipts || applications.size < contract.thresholds.afterReceipts
      || !normalized.some((item) => item.measurement.measurement.kind === "objective")) {
      throw new Error("validation renewal requires the frozen independent evidence threshold");
    }
    if (normalized.some((item) => item.measurement.metric.blockingDefects > 0)) {
      const rolledBack = rollbackCandidate(state, candidate, "validation renewal recorded a blocking defect",
        timestamp, "automatic-revalidation-regression");
      return { ...rolledBack, decision: "rolled-back", learningPath };
    }
    const deltas = normalized.map((item) => improvement(contract.metric.direction,
      item.baseline.metric.value, item.measurement.metric.value));
    if (deltas.some((value) => value < -contract.thresholds.regressionTolerance)) {
      const rolledBack = rollbackCandidate(state, candidate, "validation renewal regressed against its frozen baseline",
        timestamp, "automatic-revalidation-regression");
      return { ...rolledBack, decision: "rolled-back", learningPath };
    }
    const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    if (average < contract.thresholds.minImprovement) {
      const rolledBack = rollbackCandidate(state, candidate, "validation renewal did not meet the frozen minimum improvement",
        timestamp, "automatic-revalidation-no-improvement");
      return { ...rolledBack, decision: "rolled-back", learningPath };
    }
    const expiresAt = new Date(Math.min(new Date(contract.expiresAt).getTime(),
      new Date(timestamp).getTime()
        + evaluationStalenessPolicy(contract, state.config).canaryTtlDays * 86400000)).toISOString();
    if (new Date(expiresAt).getTime() <= new Date(validation.lease.expiresAt).getTime()) {
      throw new Error("validation renewal cannot extend the current evidence lease");
    }
    const payload = validationLeasePayload({
      schema: selectionProof?.mode === "first-admitted-trials" ? "agentspine.learning-validation/v5"
        : selectionProof?.mode === "first-admitted-turns" ? "agentspine.learning-validation/v4"
        : selectionProof ? "agentspine.learning-validation/v3" : "agentspine.learning-validation/v2",
      id: `validation:${randomUUID()}`,
      learningId,
      evaluationId: contract.id,
      evaluationDigest: contract.digest,
      evaluatorRegistryBindingDigest: validation.lease.evaluatorRegistryBindingDigest,
      scope: contract.scope,
      metric: contract.metric,
      baselineOutcomes: baselineReferences,
      predecessorValidation: { id: validation.lease.id, digest: validation.lease.digest, authority: "context-only" },
      renewalEvidence: normalized.map(({ measurement, application, delivery }) => ({
        measurementId: measurement.id, measurementDigest: measurement.digest,
        applicationId: application.id, applicationDigest: application.digest,
        deliveryId: delivery.id, deliveryDigest: delivery.digest,
        evaluatorRootDigest: measurement.measurement.evaluatorRootDigest,
        authority: "context-only"
      })).sort((a, b) => a.evaluatorRootDigest.localeCompare(b.evaluatorRootDigest)),
      selectionProof,
      improvement: average,
      validatedAt: timestamp,
      expiresAt
    });
    const lease = { ...payload, digest: digest(payload) };
    preserve(state, "learning-validation", validation.lease, timestamp);
    state.validationLeases = state.validationLeases.filter((entry) => entry.learningId !== learningId);
    state.validationLeases.push(lease);
    state.validationLeases.sort((a, b) => a.id.localeCompare(b.id));
    preserve(state, "learning-candidate", candidate, timestamp);
    const renewed = {
      ...candidate,
      promotion: { ...candidate.promotion, canary: {
        ...candidate.promotion.canary,
        validatedAt: timestamp,
        expiresAt,
        improvement: average,
        validationLeaseId: lease.id,
        validationLeaseDigest: lease.digest,
        revalidation: null
      } },
      updatedAt: timestamp,
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === learningId ? renewed : entry);
    return { candidate: renewed, lease, decision: "renewed", learningPath };
  });
}
