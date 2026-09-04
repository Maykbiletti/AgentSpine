import { createHash, randomUUID } from "node:crypto";
import {
  ID_RE, INITIAL_TRIAL_EVALUATIONS, DEADLINE_BOUND_EVALUATIONS, DELIVERABLE_APPLICATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS,
  DELIVERY_REVOCATION_REASONS, OUTCOME_REVOCATION_REASONS, APPLICATION_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  normalizeScope, exactScope, digest, learningTargetForCandidate
} from "./learning-scope-targets.js";
import {
  revokedEvaluationForCandidate
} from "./learning-validation-contracts.js";
import {
  revokedValidationForCandidate
} from "./learning-validation-runtime.js";
import {
  evaluationStalenessPolicy, revokedEvidenceSourceAttestationForCandidate
} from "./learning-measurement-contracts.js";
import {
  applicationPayload
} from "./learning-evaluation-contracts.js";
import {
  deliveryPayload, applicationRevocationPayload, revokedApplication, revokedApplicationForCandidate, deliveryRevocationPayload, revokedDelivery,
  outcomeRevocationPayload, revokedOutcome
} from "./learning-delivery-contracts.js";
import {
  date, safeText, mutation
} from "./learning-storage.js";

export async function recordLearningApplications({
  root = process.cwd(), items, scope, preflightReceipt, sessionBriefingDigest, projectedAt = new Date()
}) {
  if (!Array.isArray(items)) throw new Error("learning application items must be an array");
  if (!preflightReceipt || preflightReceipt.schema !== "agentspine.preflight/v2"
    || preflightReceipt.status !== "ready" || !ID_RE.test(preflightReceipt.id || "")
    || !/^[a-f0-9]{64}$/.test(preflightReceipt.promptDigest || "")
    || !/^[a-f0-9]{64}$/.test(preflightReceipt.briefingDigest || "")
    || !ID_RE.test(preflightReceipt.sessionId || "")
    || !/^[a-f0-9]{64}$/.test(sessionBriefingDigest || "")) {
    throw new Error("learning applications require one valid consumed preflight binding");
  }
  const runtimeScope = normalizeScope(scope);
  const timestamp = date(projectedAt, "projectedAt");
  const preflightCreated = new Date(preflightReceipt.createdAt).getTime();
  const preflightExpires = new Date(preflightReceipt.expiresAt).getTime();
  if (!Number.isFinite(preflightCreated) || !Number.isFinite(preflightExpires)
    || preflightCreated > new Date(timestamp).getTime() || preflightExpires < new Date(timestamp).getTime()) {
    throw new Error("learning application preflight binding is stale");
  }
  if (preflightReceipt.agentId !== runtimeScope.personaId || preflightReceipt.userId !== runtimeScope.userId
    || preflightReceipt.tenantId !== runtimeScope.tenantId || preflightReceipt.projectId !== runtimeScope.projectId
    || preflightReceipt.groupId !== runtimeScope.groupId || preflightReceipt.taskId !== runtimeScope.taskId) {
    throw new Error("learning application preflight scope does not match the projected turn");
  }
  return mutation(root, (state, _catalog, learningPath) => {
    const pending = state.applications.filter((application) =>
      DELIVERABLE_APPLICATIONS.has(application.schema)
      && application.sessionId === preflightReceipt.sessionId
      && application.preflightReceiptId !== preflightReceipt.id
      && new Date(application.deliveryExpiresAt).getTime() >= new Date(timestamp).getTime()
      && !state.deliveries.some((delivery) => delivery.applicationId === application.id));
    if (pending.length) {
      throw new Error("this session already has an unconfirmed learning application; await Stop or its bounded expiry");
    }
    const receipts = [];
    for (const item of items.filter((entry) => ["active", "revalidating"].includes(entry?.outcomeStatus))) {
      const candidate = state.candidates.find((entry) => entry.id === item.id);
      const canary = candidate?.promotion?.canary;
      const revalidating = item.outcomeStatus === "revalidating";
      if (!candidate || candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
        || revokedEvaluationForCandidate(state, candidate)
        || revokedEvidenceSourceAttestationForCandidate(state, candidate)
        || revokedValidationForCandidate(state, candidate)
        || revokedApplicationForCandidate(state, candidate)
        || (revalidating ? canary?.status !== "validated" || canary.revalidation?.status !== "active"
          || new Date(canary.revalidation.expiresAt).getTime() < new Date(timestamp).getTime()
          : canary?.status !== "active")
        || !exactScope(canary.scope, runtimeScope)) {
        throw new Error(`active learning application no longer matches its exact scope: ${item.id || "unknown"}`);
      }
      const expiresAt = revalidating ? canary.revalidation.expiresAt : canary.expiresAt;
      let deliveryExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
        new Date(timestamp).getTime() + 5 * 60_000)).toISOString();
      let outcomeExpiresAt;
      let completionPolicyDigest;
      const material = `${candidate.id}\0${preflightReceipt.id}\0${sessionBriefingDigest}`;
      const id = `application:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
      const existing = state.applications.find((entry) => entry.id === id);
      if (existing) {
        const sameBinding = existing.learningId === candidate.id && exactScope(existing.scope, runtimeScope)
          && existing.preflightReceiptId === preflightReceipt.id && existing.promptDigest === preflightReceipt.promptDigest
          && existing.preflightBriefingDigest === preflightReceipt.briefingDigest
          && existing.sessionBriefingDigest === sessionBriefingDigest;
        if (!sameBinding) throw new Error("learning application receipt IDs are immutable");
        receipts.push(existing);
        continue;
      }
      let schema = "agentspine.learning-application/v2";
      let revalidationAdmission;
      let initialAdmission;
      if (revalidating && ["agentspine.learning-revalidation-window/v3",
        "agentspine.learning-revalidation-window/v4"].includes(canary.revalidation.schema)) {
        const window = canary.revalidation;
        const priorAdmissions = state.applications.filter((application) =>
          ["agentspine.learning-application/v3", "agentspine.learning-application/v4"].includes(application.schema)
          && application.revalidationAdmission.revalidationWindowId === window.id
          && application.revalidationAdmission.revalidationWindowDigest === window.digest);
        if (priorAdmissions.length < window.selection.requiredDeliveries) {
          const slot = priorAdmissions.length + 1;
          const trial = window.selection.evaluatorRoots[slot - 1];
          schema = window.schema === "agentspine.learning-revalidation-window/v4"
            ? "agentspine.learning-application/v4" : "agentspine.learning-application/v3";
          revalidationAdmission = {
            revalidationWindowId: window.id,
            revalidationWindowDigest: window.digest,
            slot,
            evaluatorRootDigest: trial.evaluatorRootDigest,
            ...(schema === "agentspine.learning-application/v4" ? {
              evaluatorId: trial.evaluatorId, runId: trial.runId, trialDigest: trial.trialDigest
            } : {}),
            authority: "context-only"
          };
        }
      }
      if (!revalidating) {
        const evaluation = state.evaluations.find((entry) => entry.id === canary.evaluationId
          && entry.digest === canary.evaluationDigest && entry.learningId === candidate.id);
        if (INITIAL_TRIAL_EVALUATIONS.has(evaluation?.schema)) {
          const priorAdmissions = state.applications.filter((application) =>
            INITIAL_TRIAL_APPLICATIONS.has(application.schema)
            && application.initialAdmission.evaluationId === evaluation.id
            && application.initialAdmission.evaluationDigest === evaluation.digest);
          if (priorAdmissions.length < evaluation.initialTrials.requiredTrials) {
            const slot = priorAdmissions.length + 1;
            const trial = evaluation.initialTrials.after[slot - 1];
            schema = DEADLINE_BOUND_EVALUATIONS.has(evaluation.schema)
              ? "agentspine.learning-application/v7"
              : evaluation.schema === "agentspine.learning-evaluation/v9"
                ? "agentspine.learning-application/v6" : "agentspine.learning-application/v5";
            initialAdmission = {
              evaluationId: evaluation.id,
              evaluationDigest: evaluation.digest,
              slot,
              evaluatorId: trial.evaluatorId,
              evaluatorRootDigest: trial.evaluatorRootDigest,
              runId: trial.runId,
              trialDigest: trial.trialDigest,
              ...(TARGET_BOUND_APPLICATIONS.has(schema) ? { targetDigest: evaluation.target.digest } : {}),
              authority: "context-only"
            };
            if (schema === "agentspine.learning-application/v7") {
              deliveryExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
                new Date(timestamp).getTime() + evaluation.completionPolicy.deliveryTimeoutMs)).toISOString();
              outcomeExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
                new Date(timestamp).getTime() + evaluation.completionPolicy.outcomeTimeoutMs)).toISOString();
              completionPolicyDigest = evaluation.completionPolicy.digest;
            }
          }
        }
      }
      const payload = applicationPayload({ schema, id, learningId: candidate.id, scope: runtimeScope,
        preflightReceiptId: preflightReceipt.id, promptDigest: preflightReceipt.promptDigest,
        preflightBriefingDigest: preflightReceipt.briefingDigest, sessionBriefingDigest,
        sessionId: preflightReceipt.sessionId, projectedAt: timestamp, deliveryExpiresAt, expiresAt,
        revalidationAdmission, initialAdmission, outcomeExpiresAt, completionPolicyDigest });
      const receipt = { ...payload, digest: digest(payload) };
      if (state.applications.some((entry) => entry.learningId === candidate.id
        && entry.preflightReceiptId === preflightReceipt.id)) {
        throw new Error("one preflight turn cannot produce conflicting learning application receipts");
      }
      state.applications.push(receipt);
      receipts.push(receipt);
    }
    state.applications.sort((a, b) => a.id.localeCompare(b.id));
    return { schema: "agentspine.learning-application-batch/v2", receipts, learningPath,
      authority: "context-only" };
  });
}

export async function revokeLearningApplication({
  root = process.cwd(), applicationId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-application-revocation-confirmed") {
    throw new Error("application revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(applicationId || "")) throw new Error("applicationId must be a stable identifier");
  if (!APPLICATION_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be preflight-invalid, scope-invalid, projection-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const application = state.applications.find((entry) => entry.id === applicationId);
    if (!application) throw new Error(`unknown learning application: ${applicationId}`);
    const candidate = state.candidates.find((entry) => entry.id === application.learningId);
    const evaluationId = application.initialAdmission?.evaluationId || candidate?.promotion?.canary?.evaluationId;
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    const deliveries = state.deliveries.filter((entry) => entry.applicationId === application.id);
    const outcomes = state.outcomes.filter((entry) => entry.applicationId === application.id);
    if (deliveries.length > 1 || outcomes.length > 1) {
      throw new Error("application revocation requires one unambiguous delivery and outcome lineage");
    }
    const delivery = deliveries[0] || null;
    const outcome = outcomes[0] || null;
    if (!candidate || !evaluation || evaluation.learningId !== candidate.id
      || application.learningId !== candidate.id || (outcome && outcome.deliveryId !== delivery?.id)) {
      throw new Error("application revocation requires its complete immutable evaluation lineage");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedApplication(state, applicationId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.applicationDigest !== application.digest || existing.evaluationDigest !== evaluation.digest
        || existing.deliveryId !== (delivery?.id || null) || existing.deliveryDigest !== (delivery?.digest || null)
        || existing.outcomeId !== (outcome?.id || null) || existing.outcomeDigest !== (outcome?.digest || null)
        || existing.targetDigest !== targetDigest) {
        throw new Error("learning application revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `application-revocation:${createHash("sha256")
      .update(`${application.id}\0${application.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = applicationRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      applicationId: application.id,
      applicationDigest: application.digest,
      deliveryId: delivery?.id || null,
      deliveryDigest: delivery?.digest || null,
      outcomeId: outcome?.id || null,
      outcomeDigest: outcome?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.applicationRevocations.push(receipt);
    state.applicationRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export async function recordLearningDeliveries({
  root = process.cwd(), sessionId, scope, hookEvent, completedAt = new Date()
}) {
  if (!ID_RE.test(sessionId || "")) throw new Error("learning delivery sessionId is required");
  if (!["Stop", "SubagentStop"].includes(hookEvent)) throw new Error("learning delivery requires Stop or SubagentStop");
  const runtimeScope = normalizeScope(scope);
  const timestamp = date(completedAt, "completedAt");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidates = state.applications.filter((application) =>
      DELIVERABLE_APPLICATIONS.has(application.schema)
      && application.sessionId === sessionId && exactScope(application.scope, runtimeScope));
    if (!candidates.length) return { schema: "agentspine.learning-delivery-batch/v1", status: "not-applicable",
      receipts: [], learningPath, authority: "context-only" };
    if (candidates.some((application) => revokedApplication(state, application.id))) {
      throw new Error("learning application was explicitly revoked and cannot produce a delivery");
    }
    if (candidates.some((application) => {
      const candidate = state.candidates.find((entry) => entry.id === application.learningId);
      return revokedEvaluationForCandidate(state, candidate);
    })) throw new Error("learning evaluation contract was explicitly revoked and cannot produce a delivery");
    if (candidates.some((application) => {
      const candidate = state.candidates.find((entry) => entry.id === application.learningId);
      return revokedEvidenceSourceAttestationForCandidate(state, candidate);
    })) throw new Error("learning evidence source attestation was explicitly revoked and cannot produce a delivery");
    if (candidates.some((application) => {
      const candidate = state.candidates.find((entry) => entry.id === application.learningId);
      return revokedValidationForCandidate(state, candidate);
    })) throw new Error("learning validation decision was explicitly revoked and cannot produce a delivery");
    const latest = [...candidates].sort((a, b) => b.projectedAt.localeCompare(a.projectedAt))[0];
    const batch = candidates.filter((application) => application.preflightReceiptId === latest.preflightReceiptId);
    if (new Date(timestamp).getTime() > new Date(latest.deliveryExpiresAt).getTime()) {
      return { schema: "agentspine.learning-delivery-batch/v1", status: "stale", receipts: [], learningPath,
        authority: "context-only" };
    }
    const receipts = [];
    for (const application of batch) {
      const existingForApplication = state.deliveries.find((entry) => entry.applicationId === application.id);
      if (existingForApplication) {
        if (existingForApplication.sessionId !== sessionId || existingForApplication.hookEvent !== hookEvent
          || !exactScope(existingForApplication.scope, runtimeScope)) {
          throw new Error("one learning application cannot have conflicting delivery receipts");
        }
        receipts.push(existingForApplication);
        continue;
      }
      const id = `delivery:${createHash("sha256").update(`${application.id}\0${hookEvent}`).digest("hex").slice(0, 32)}`;
      const payload = deliveryPayload({ id, applicationId: application.id, learningId: application.learningId,
        scope: runtimeScope, sessionId, preflightReceiptId: application.preflightReceiptId, hookEvent,
        completedAt: timestamp });
      const receipt = { ...payload, digest: digest(payload) };
      if (state.deliveries.some((entry) => entry.id === id)) throw new Error("learning delivery receipt IDs are immutable");
      state.deliveries.push(receipt);
      receipts.push(receipt);
    }
    state.deliveries.sort((a, b) => a.id.localeCompare(b.id));
    return { schema: "agentspine.learning-delivery-batch/v1", status: receipts.length ? "completed" : "not-applicable",
      receipts, learningPath, authority: "context-only" };
  });
}

export async function revokeLearningDelivery({
  root = process.cwd(), deliveryId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-delivery-revocation-confirmed") {
    throw new Error("delivery revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(deliveryId || "")) throw new Error("deliveryId must be a stable identifier");
  if (!DELIVERY_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be host-invalid, session-invalid, hook-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const delivery = state.deliveries.find((entry) => entry.id === deliveryId);
    if (!delivery) throw new Error(`unknown learning delivery: ${deliveryId}`);
    const application = state.applications.find((entry) => entry.id === delivery.applicationId);
    const candidate = state.candidates.find((entry) => entry.id === delivery.learningId);
    const outcomes = state.outcomes.filter((entry) => entry.deliveryId === delivery.id);
    if (outcomes.length > 1) throw new Error("delivery revocation requires one unambiguous bound outcome");
    const outcome = outcomes[0] || null;
    const evaluationId = outcome?.evaluationId || candidate?.promotion?.canary?.evaluationId;
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    if (!candidate || !application || !evaluation || application.learningId !== candidate.id
      || evaluation.learningId !== candidate.id) {
      throw new Error("delivery revocation requires its bound candidate, application, and evaluation contract");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedDelivery(state, deliveryId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.deliveryDigest !== delivery.digest || existing.applicationDigest !== application.digest
        || existing.evaluationDigest !== evaluation.digest || existing.targetDigest !== targetDigest
        || existing.outcomeId !== (outcome?.id || null) || existing.outcomeDigest !== (outcome?.digest || null)) {
        throw new Error("learning delivery revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `delivery-revocation:${createHash("sha256")
      .update(`${delivery.id}\0${delivery.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = deliveryRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      applicationId: application.id,
      applicationDigest: application.digest,
      deliveryId: delivery.id,
      deliveryDigest: delivery.digest,
      outcomeId: outcome?.id || null,
      outcomeDigest: outcome?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.deliveryRevocations.push(receipt);
    state.deliveryRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export async function revokeLearningOutcome({
  root = process.cwd(), outcomeId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-outcome-revocation-confirmed") {
    throw new Error("outcome revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(outcomeId || "")) throw new Error("outcomeId must be a stable identifier");
  if (!OUTCOME_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be binding-invalid, phase-invalid, scope-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const outcome = state.outcomes.find((entry) => entry.id === outcomeId);
    if (!outcome) throw new Error(`unknown learning outcome: ${outcomeId}`);
    const candidate = state.candidates.find((entry) => entry.id === outcome.learningId);
    const evaluation = state.evaluations.find((entry) => entry.id === outcome.evaluationId);
    const measurement = outcome.measurementReceiptId
      ? state.measurements.find((entry) => entry.id === outcome.measurementReceiptId) : null;
    const application = outcome.applicationId
      ? state.applications.find((entry) => entry.id === outcome.applicationId) : null;
    const delivery = outcome.deliveryId
      ? state.deliveries.find((entry) => entry.id === outcome.deliveryId) : null;
    if (!candidate || !evaluation || evaluation.learningId !== candidate.id
      || (outcome.measurementReceiptId && !measurement)
      || (outcome.applicationId && !application) || (outcome.deliveryId && !delivery)) {
      throw new Error("outcome revocation requires its complete immutable evaluation lineage");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedOutcome(state, outcomeId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.outcomeDigest !== outcome.digest || existing.evaluationDigest !== evaluation.digest
        || existing.measurementDigest !== (measurement?.digest || null)
        || existing.applicationDigest !== (application?.digest || null)
        || existing.deliveryDigest !== (delivery?.digest || null) || existing.targetDigest !== targetDigest) {
        throw new Error("learning outcome revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `outcome-revocation:${createHash("sha256")
      .update(`${outcome.id}\0${outcome.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = outcomeRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      outcomeId: outcome.id,
      outcomeDigest: outcome.digest,
      measurementId: measurement?.id || null,
      measurementDigest: measurement?.digest || null,
      applicationId: application?.id || null,
      applicationDigest: application?.digest || null,
      deliveryId: delivery?.id || null,
      deliveryDigest: delivery?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.outcomeRevocations.push(receipt);
    state.outcomeRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export function outcomeFresh(receipt, contract, config, now) {
  const policy = evaluationStalenessPolicy(contract, config);
  return new Date(receipt.measuredAt).getTime() >= new Date(now).getTime()
    - policy.outcomeMaxAgeDays * 86400000;
}
