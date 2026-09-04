import {
  AUTO_KINDS, OUTCOME_AUTO_KINDS, CONTINUITY_AUTO_KINDS, SCOPE_FIELDS, ID_RE, COVERAGE_EVALUATIONS,
  LINEAGE_EVALUATIONS, PAIRED_EVALUATIONS, ROOT_BOUND_EVALUATIONS, REGISTRY_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS, TARGET_BOUND_EVALUATIONS,
  DEADLINE_BOUND_EVALUATIONS, STALENESS_BOUND_EVALUATIONS, DEADLINE_BOUND_APPLICATIONS
} from "./learning-schema.js";
import {
  digest, revokedEvidence, revokedMeasurement, revokedMeasurementForCandidate, activeEvaluationBinding, revokedEvaluation
} from "./learning-scope-targets.js";
import {
  evaluationStalenessPolicy, revokedEvidenceSourceAttestation
} from "./learning-measurement-contracts.js";
import {
  revokedApplication, revokedApplicationForCandidate, revokedDelivery, revokedDeliveryForCandidate, revokedOutcome, revokedOutcomeForCandidate
} from "./learning-delivery-contracts.js";
import {
  date, number, integer, safeText, mutation
} from "./learning-storage.js";
import {
  acceptCandidate, distinctEvidence
} from "./learning-candidates.js";
import {
  normalizeOutcome
} from "./learning-outcome-contracts.js";
import {
  promotableReceipts, rollbackCandidate
} from "./learning-reconciliation.js";
import {
  reconcileCanary
} from "./learning-trial-recovery.js";

export async function recordLearningOutcome({ root = process.cwd(), id, learningId, phase, scope, metric, measurement,
  applicationId = null, deliveryId = null, evaluationId, measurementReceiptId = null,
  coverage = null, measuredAt, now = new Date() }) {
  if (!ID_RE.test(learningId || "")) throw new Error("learningId is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (!candidate) throw new Error(`unknown learning candidate: ${learningId}`);
    if (!ID_RE.test(evaluationId || "")) throw new Error("evaluationId is required");
    const evaluation = state.evaluations.find((item) => item.id === evaluationId);
    if (revokedEvaluation(state, evaluationId)) {
      throw new Error("learning evaluation contract was explicitly revoked and cannot support an outcome");
    }
    if (revokedEvidenceSourceAttestation(state, evaluationId)) {
      throw new Error("learning evidence source attestation was explicitly revoked and cannot support an outcome");
    }
    if (REGISTRY_BOUND_EVALUATIONS.has(evaluation?.schema)
      && !activeEvaluationBinding(state, evaluation)) {
      throw new Error("outcome evaluator registry binding is missing, changed, or revoked");
    }
    const measurementReceipt = measurementReceiptId === null ? null
      : state.measurements.find((item) => item.id === measurementReceiptId);
    if (measurementReceipt && revokedMeasurement(state, measurementReceipt.id)) {
      throw new Error("learning measurement was explicitly revoked and cannot be consumed");
    }
    const effectivePhase = LINEAGE_EVALUATIONS.has(evaluation?.schema)
      ? measurementReceipt?.phase : phase;
    const application = applicationId === null ? null : state.applications.find((item) => item.id === applicationId);
    const delivery = deliveryId === null ? null : state.deliveries.find((item) => item.id === deliveryId);
    if (application && revokedApplication(state, application.id)) {
      throw new Error("learning application was explicitly revoked and cannot support an outcome");
    }
    if (delivery && revokedDelivery(state, delivery.id)) {
      throw new Error("learning delivery was explicitly revoked and cannot support an outcome");
    }
    const existing = id ? state.outcomes.find((item) => item.id === id) : null;
    if (existing) {
      if (revokedOutcome(state, existing.id)) {
        throw new Error("learning outcome was explicitly revoked and cannot be replayed");
      }
      const retry = normalizeOutcome({ id, phase, scope, metric, measurement, applicationId, deliveryId, evaluationId, coverage,
        measuredAt: measuredAt ?? existing.measuredAt }, candidate, timestamp, application, delivery, evaluation, measurementReceipt);
      if (existing.digest === retry.digest) {
        return { receipt: existing, candidate, decision: "unchanged", learningPath, unchanged: true };
      }
      throw new Error("outcome receipt IDs are immutable");
    }
    if (effectivePhase === "before" && candidate.status !== "candidate") throw new Error("before outcomes require an unreviewed candidate");
    if (effectivePhase === "after" && (candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
      || candidate.promotion?.canary?.status !== "active")) {
      throw new Error("after outcomes require an active outcome canary");
    }
    if (effectivePhase === "after" && DEADLINE_BOUND_APPLICATIONS.has(application?.schema)
      && new Date(timestamp).getTime() > new Date(application.outcomeExpiresAt).getTime()) {
      throw new Error("after outcome registration missed its immutable initial trial deadline");
    }
    const receipt = normalizeOutcome({ id, phase, scope, metric, measurement, applicationId, deliveryId, evaluationId, coverage,
      measuredAt }, candidate, timestamp, application, delivery, evaluation, measurementReceipt);
    const duplicate = state.outcomes.find((item) => item.digest === receipt.digest);
    if (duplicate) return { receipt: duplicate, candidate, decision: "unchanged", learningPath, unchanged: true };
    if (receipt.schema === "agentspine.learning-outcome/v6" && state.outcomes.some((item) =>
      item.schema === "agentspine.learning-outcome/v6" && item.evaluationId === receipt.evaluationId
      && item.measurement.sourceDigest === receipt.measurement.sourceDigest)) {
      throw new Error("outcome measurement provenance cannot be replayed within one evaluation contract");
    }
    if (["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
      && state.outcomes.some((item) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(item.schema)
        && item.measurementReceiptId === receipt.measurementReceiptId)) {
      throw new Error("one measurement receipt cannot be consumed by multiple outcomes");
    }
    if (["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema)
      && state.outcomes.some((item) => item.schema === receipt.schema && item.evaluationId === receipt.evaluationId
      && item.phase === receipt.phase
      && (receipt.schema === "agentspine.learning-outcome/v9"
        ? item.measurement.evaluatorRootDigest === receipt.measurement.evaluatorRootDigest
        : item.measurement.evaluatorId === receipt.measurement.evaluatorId))) {
      throw new Error("paired evaluation accepts exactly one outcome per evaluator and phase");
    }
    if (["agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(receipt.schema) && receipt.phase === "after"
      && state.outcomes.some((item) => item.schema === receipt.schema
        && item.phase === "after" && item.evaluationId === receipt.evaluationId
        && item.applicationId === receipt.applicationId)) {
      throw new Error("paired evaluation requires a distinct completed turn for each after outcome");
    }
    state.outcomes.push(receipt);
    state.outcomes.sort((a, b) => a.id.localeCompare(b.id));
    const reconciled = effectivePhase === "after" ? reconcileCanary(state, candidate, timestamp) : { candidate, decision: "recorded", restored: [] };
    return { receipt, ...reconciled, learningPath, unchanged: false };
  });
}

export async function evaluateLearning({ root = process.cwd(), now = new Date() } = {}) {
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const accepted = [];
    const reconciled = [];
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted" && revokedEvidence(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning evidence was explicitly revoked",
        timestamp, "automatic-evidence-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedMeasurementForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning measurement evidence was explicitly revoked",
        timestamp, "automatic-measurement-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedApplicationForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning application evidence was explicitly revoked",
        timestamp, "automatic-application-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedDeliveryForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning delivery evidence was explicitly revoked",
        timestamp, "automatic-delivery-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    while (true) {
      const current = state.candidates.find((entry) => entry.status === "accepted"
        && revokedOutcomeForCandidate(state, entry));
      if (!current) break;
      rollbackCandidate(state, current, "learning outcome evidence was explicitly revoked",
        timestamp, "automatic-outcome-revocation");
      reconciled.push({ id: current.id, decision: "rolled-back" });
    }
    for (const current of state.candidates.filter((entry) => entry.status === "accepted" && entry.promotion?.mode === "outcome-canary")) {
      const result = reconcileCanary(state, current, timestamp);
      if (result.decision !== "unchanged" && result.decision !== "active") reconciled.push({ id: current.id, decision: result.decision });
    }
    if (state.config.autoPromote) {
      for (const candidate of state.candidates.filter((entry) => entry.status === "candidate")) {
        if (revokedEvidence(state, candidate)) continue;
        if (state.measurementRevocations.some((receipt) => receipt.learningId === candidate.id)) continue;
        if (state.applicationRevocations.some((receipt) => receipt.learningId === candidate.id)) continue;
        if (state.outcomeRevocations.some((receipt) => receipt.learningId === candidate.id)) continue;
        if (candidate.conflictsWith?.some((id) => state.candidates.some((entry) => entry.id === id && ["candidate", "accepted"].includes(entry.status)))) continue;
        if (OUTCOME_AUTO_KINDS.has(candidate.kind)) {
          if (SCOPE_FIELDS.every((field) => candidate.scope?.[field] === null)) continue;
          if (candidate.requiresLocalReview) continue;
          const planned = promotableReceipts(state, candidate, timestamp);
          if (!planned) continue;
          const { contract, receipts } = planned;
          const minConfidence = contract.thresholds?.minConfidence ?? state.config.minConfidence;
          const minEvidence = contract.thresholds?.minEvidence ?? state.config.minEvidence;
          if (candidate.confidence < minConfidence || distinctEvidence(candidate) < minEvidence) continue;
          const baseline = receipts.reduce((sum, item) => sum + item.metric.value, 0) / receipts.length;
          accepted.push(acceptCandidate(state, candidate, timestamp, true, {
            mode: "outcome-canary",
            minConfidence,
            minEvidence,
            evidenceCount: distinctEvidence(candidate),
            evaluatedAt: timestamp,
            canary: {
              status: "active",
              scope: receipts[0].scope,
              metric: { name: receipts[0].metric.name, direction: receipts[0].metric.direction },
              evaluationId: contract.id,
              evaluationDigest: contract.digest,
              pairing: PAIRED_EVALUATIONS.has(contract.schema) ? contract.pairing : null,
              evaluatorRootDigest: ROOT_BOUND_EVALUATIONS.has(contract.schema)
                ? digest(contract.evaluatorRoots) : null,
              evaluatorRegistryBindingDigest: REGISTRY_BOUND_EVALUATIONS.has(contract.schema)
                ? state.evaluationBindings.find((binding) => binding.evaluationId === contract.id)?.digest : null,
              initialTrialsDigest: INITIAL_TRIAL_EVALUATIONS.has(contract.schema)
                ? digest(contract.initialTrials) : null,
              targetDigest: TARGET_BOUND_EVALUATIONS.has(contract.schema) ? contract.target.digest : null,
              completionPolicyDigest: DEADLINE_BOUND_EVALUATIONS.has(contract.schema)
                ? contract.completionPolicy.digest : null,
              stalenessPolicyDigest: STALENESS_BOUND_EVALUATIONS.has(contract.schema)
                ? contract.stalenessPolicy.digest : null,
              coverage: COVERAGE_EVALUATIONS.has(contract.schema) ? {
                datasetDigest: contract.benchmark.datasetDigest,
                minCases: contract.benchmark.minCases,
                authority: "context-only"
              } : null,
              baseline,
              beforeReceipts: receipts.map((item) => item.id),
              expiresAt: new Date(Math.min(new Date(contract.expiresAt).getTime(),
                new Date(timestamp).getTime()
                  + evaluationStalenessPolicy(contract, state.config).canaryTtlDays * 86400000)).toISOString()
            },
            authority: "context-only"
          }));
          continue;
        }
        if (AUTO_KINDS.has(candidate.kind)) {
          if (candidate.confidence < state.config.minConfidence) continue;
          if (distinctEvidence(candidate) < state.config.minEvidence) continue;
          accepted.push(acceptCandidate(state, candidate, timestamp, true, {
            mode: "automatic-low-risk",
            minConfidence: state.config.minConfidence,
            minEvidence: state.config.minEvidence,
            evidenceCount: distinctEvidence(candidate),
            evaluatedAt: timestamp,
            authority: "context-only"
          }));
        }
      }
    }
    return { enabled: state.config.autoPromote, accepted, reconciled, learningPath, authority: "context-only" };
  });
}

export async function purgeStaleLearningApplications({ root = process.cwd(), confirmation, now = new Date() } = {}) {
  if (confirmation !== "local-user-purge-confirmed") {
    throw new Error("purging stale learning applications requires explicit local confirmation");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const ids = new Set(state.applications.filter((application) => application.schema === "agentspine.learning-application/v2"
      && new Date(application.deliveryExpiresAt).getTime() < new Date(timestamp).getTime()
      && !revokedApplication(state, application.id)
      && !state.deliveries.some((delivery) => delivery.applicationId === application.id)).map((application) => application.id));
    state.applications = state.applications.filter((application) => !ids.has(application.id));
    return { schema: "agentspine.learning-delivery-purge/v1", purged: ids.size, applicationIds: [...ids].sort(),
      learningPath, authority: "context-only" };
  });
}

export async function purgeStaleLearningMeasurements({ root = process.cwd(), confirmation, now = new Date() } = {}) {
  if (confirmation !== "local-user-purge-confirmed") {
    throw new Error("purging stale learning measurements requires explicit local confirmation");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const consumed = new Set(state.outcomes.filter((outcome) => ["agentspine.learning-outcome/v7", "agentspine.learning-outcome/v8", "agentspine.learning-outcome/v9"].includes(outcome.schema))
      .map((outcome) => outcome.measurementReceiptId));
    for (const revocation of state.measurementRevocations) consumed.add(revocation.measurementId);
    const validationHistory = state.history.filter((entry) => entry.kind === "learning-validation")
      .map((entry) => entry.value);
    for (const lease of [...state.validationLeases, ...validationHistory]
      .filter((entry) => ["agentspine.learning-validation/v2", "agentspine.learning-validation/v3",
        "agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(entry?.schema))) {
      for (const evidence of lease.renewalEvidence) consumed.add(evidence.measurementId);
    }
    const cutoff = new Date(timestamp).getTime() - state.config.outcomeMaxAgeDays * 86400000;
    const ids = new Set(state.measurements.filter((measurement) => !consumed.has(measurement.id)
      && (new Date(measurement.measuredAt).getTime() < cutoff
        || state.evaluations.some((contract) => contract.id === measurement.evaluationId
          && new Date(contract.expiresAt).getTime() < new Date(timestamp).getTime())))
      .map((measurement) => measurement.id));
    state.measurements = state.measurements.filter((measurement) => !ids.has(measurement.id));
    return { schema: "agentspine.learning-measurement-purge/v1", purged: ids.size,
      measurementReceiptIds: [...ids].sort(), learningPath, authority: "context-only" };
  });
}

/**
 * Internal runtime promotion path for locally opted-in continuity signals.
 * This is intentionally not exposed over MCP. The caller must provide the
 * directness, confidence, repetition and local opt-in proof recorded by the
 * continuity state machine.
 */

export async function acceptContinuityLearning({
  root = process.cwd(), id, proof, now = new Date(), catalog: providedCatalog = null
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  if (!proof || proof.mode !== "automatic-continuity-low-risk" || proof.localOptIn !== true) {
    throw new Error("continuity promotion requires a recorded local opt-in proof");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`unknown learning candidate: ${id}`);
    if (revokedEvidence(state, candidate)) throw new Error("learning evidence was revoked; propose a new candidate before promotion");
    if (candidate.status === "accepted") return { candidate, learningPath, unchanged: true };
    if (candidate.status !== "candidate") throw new Error("only an active candidate can be promoted");
    if (!CONTINUITY_AUTO_KINDS.has(candidate.kind)) throw new Error("learning kind is not eligible for continuity promotion");
    const minConfidence = number(proof.minConfidence, "proof.minConfidence", 0.9, 1);
    const minEvidence = integer(proof.minEvidence, "proof.minEvidence", 1, 10);
    const minDirectness = number(proof.minDirectness, "proof.minDirectness", 0.9, 1);
    const directness = number(proof.directness, "proof.directness", 0, 1);
    const evidenceCount = distinctEvidence(candidate);
    if (candidate.confidence < minConfidence || directness < minDirectness || evidenceCount < minEvidence) {
      throw new Error("continuity candidate does not meet the recorded promotion thresholds");
    }
    const accepted = acceptCandidate(state, candidate, timestamp, true, {
      mode: "automatic-continuity-low-risk",
      localOptIn: true,
      minConfidence,
      minEvidence,
      minDirectness,
      directness,
      evidenceCount,
      evaluatedAt: timestamp,
      authority: "context-only"
    });
    return { candidate: accepted, learningPath, unchanged: false };
  }, providedCatalog);
}

export async function rollbackLearning({ root = process.cwd(), id, reason, now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  const rollbackReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate || candidate.status !== "accepted") throw new Error("only an accepted learning can be rolled back");
    const result = rollbackCandidate(state, candidate, rollbackReason, timestamp, "manual");
    return { ...result, learningPath };
  });
}
