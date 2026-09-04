import { createHash, randomUUID } from "node:crypto";
import {
  ID_RE, DIGEST_RE, REGISTRY_BOUND_EVALUATIONS, EVIDENCE_SOURCE_ATTESTED_EVALUATIONS, EVALUATION_REVOCATION_REASONS, EVIDENCE_SOURCE_ATTESTATION_REVOCATION_REASONS,
  VALIDATION_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  digest, learningTargetForCandidate, evaluationRevocationPayload, revokedEvaluation
} from "./learning-scope-targets.js";
import {
  revokedEvaluationForCandidate, revalidationWindowPayload, revalidationTrialDigest, storedValidationLeaseStructure
} from "./learning-validation-contracts.js";
import {
  validationLeaseRecord, validationLeaseChain, validationRevocationPayload, revokedValidation, validationLeaseState
} from "./learning-validation-runtime.js";
import {
  evaluationStalenessPolicy, evidenceSourceAttestations, evidenceSourceAttestationRevocationPayload, revokedEvidenceSourceAttestation, revokedEvidenceSourceAttestationForCandidate
} from "./learning-measurement-contracts.js";
import {
  revokedApplicationForCandidate, revokedOutcomeForCandidate
} from "./learning-delivery-contracts.js";
import {
  date, safeText, mutation, preserve
} from "./learning-storage.js";

export async function revokeLearningEvaluation({
  root = process.cwd(), evaluationId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-evaluation-revocation-confirmed") {
    throw new Error("evaluation revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(evaluationId || "")) throw new Error("evaluationId must be a stable identifier");
  if (!EVALUATION_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be benchmark-invalid, protocol-invalid, scope-invalid, threshold-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    if (!evaluation) throw new Error(`unknown learning evaluation: ${evaluationId}`);
    const candidate = state.candidates.find((entry) => entry.id === evaluation.learningId);
    if (!candidate) throw new Error("evaluation revocation requires its immutable candidate lineage");
    const binding = state.evaluationBindings.find((entry) => entry.evaluationId === evaluation.id
      && entry.evaluationDigest === evaluation.digest) || null;
    if (REGISTRY_BOUND_EVALUATIONS.has(evaluation.schema) && !binding) {
      throw new Error("evaluation revocation requires its immutable evaluator binding");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const reasonDigest = digest(revokeReason);
    const existing = revokedEvaluation(state, evaluationId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.learningId !== candidate.id || existing.evaluationDigest !== evaluation.digest
        || existing.evaluatorBindingDigest !== (binding?.digest || null)
        || existing.targetDigest !== targetDigest) {
        throw new Error("learning evaluation revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `evaluation-revocation:${createHash("sha256")
      .update(`${evaluation.id}\0${evaluation.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = evaluationRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      evaluatorBindingDigest: binding?.digest || null,
      targetDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.evaluationRevocations.push(receipt);
    state.evaluationRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export async function revokeLearningEvidenceSourceAttestation({
  root = process.cwd(), evaluationId, evidenceDigest, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-evidence-source-attestation-revocation-confirmed") {
    throw new Error("evidence source attestation revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(evaluationId || "")) throw new Error("evaluationId must be a stable identifier");
  if (!DIGEST_RE.test(evidenceDigest || "")) throw new Error("evidenceDigest must be one SHA-256 digest");
  if (!EVIDENCE_SOURCE_ATTESTATION_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be source-class-invalid, confirmation-invalid, scope-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
    if (!evaluation || !EVIDENCE_SOURCE_ATTESTED_EVALUATIONS.has(evaluation.schema)) {
      throw new Error(`unknown source-attested learning evaluation: ${evaluationId}`);
    }
    const candidate = state.candidates.find((entry) => entry.id === evaluation.learningId);
    const attestation = evaluation.candidateAdmission.evidenceSourceAttestations.find((entry) =>
      entry.evidenceDigest === evidenceDigest);
    if (!candidate || !attestation) {
      throw new Error("source attestation revocation requires its exact immutable candidate and evidence binding");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const scopeDigest = digest(evaluation.scope);
    const reasonDigest = digest(revokeReason);
    const existing = revokedEvidenceSourceAttestation(state, evaluationId, evidenceDigest);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.learningId !== candidate.id || existing.evaluationDigest !== evaluation.digest
        || existing.candidateAdmissionDigest !== evaluation.candidateAdmission.digest
        || existing.independenceDigest !== attestation.independenceDigest
        || existing.sourceClass !== attestation.sourceClass || existing.targetDigest !== targetDigest
        || existing.scopeDigest !== scopeDigest) {
        throw new Error("learning evidence source attestation revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `evidence-source-attestation-revocation:${createHash("sha256")
      .update(`${evaluation.id}\0${evaluation.digest}\0${evidenceDigest}`).digest("hex").slice(0, 32)}`;
    const payload = evidenceSourceAttestationRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      candidateAdmissionDigest: evaluation.candidateAdmission.digest,
      evidenceDigest,
      independenceDigest: attestation.independenceDigest,
      sourceClass: attestation.sourceClass,
      targetDigest,
      scopeDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.evidenceSourceAttestationRevocations.push(receipt);
    state.evidenceSourceAttestationRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export async function revokeLearningValidation({
  root = process.cwd(), validationLeaseId, reasonCode, reason, confirmation, now = new Date()
}) {
  if (confirmation !== "local-validation-revocation-confirmed") {
    throw new Error("validation revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(validationLeaseId || "")) throw new Error("validationLeaseId must be a stable identifier");
  if (!VALIDATION_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be decision-invalid, cohort-invalid, binding-invalid, scope-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const lease = validationLeaseRecord(state, validationLeaseId);
    if (!lease || !storedValidationLeaseStructure(lease)) {
      throw new Error(`unknown learning validation lease: ${validationLeaseId}`);
    }
    const candidate = state.candidates.find((entry) => entry.id === lease.learningId);
    const evaluation = state.evaluations.find((entry) => entry.id === lease.evaluationId
      && entry.digest === lease.evaluationDigest);
    const binding = state.evaluationBindings.find((entry) => entry.evaluationId === lease.evaluationId
      && entry.evaluationDigest === lease.evaluationDigest);
    if (!candidate || !evaluation || !binding || binding.digest !== lease.evaluatorRegistryBindingDigest) {
      throw new Error("validation revocation requires its immutable candidate, evaluation, and evaluator binding");
    }
    const activeChain = validationLeaseChain(state, candidate);
    if (!activeChain.some((entry) => entry.id === lease.id && entry.digest === lease.digest)) {
      throw new Error("validation revocation requires a lease in the candidate's current immutable validation chain");
    }
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const scopeDigest = digest(lease.scope);
    const reasonDigest = digest(revokeReason);
    const existing = revokedValidation(state, validationLeaseId);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.learningId !== candidate.id || existing.evaluationId !== evaluation.id
        || existing.evaluationDigest !== evaluation.digest || existing.evaluatorBindingDigest !== binding.digest
        || existing.validationLeaseDigest !== lease.digest || existing.targetDigest !== targetDigest
        || existing.scopeDigest !== scopeDigest) {
        throw new Error("learning validation revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const id = `validation-revocation:${createHash("sha256")
      .update(`${lease.id}\0${lease.digest}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const payload = validationRevocationPayload({
      id,
      learningId: candidate.id,
      evaluationId: evaluation.id,
      evaluationDigest: evaluation.digest,
      evaluatorBindingDigest: binding.digest,
      validationLeaseId: lease.id,
      validationLeaseDigest: lease.digest,
      targetDigest,
      scopeDigest,
      reasonCode,
      reasonDigest,
      revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.validationRevocations.push(receipt);
    state.validationRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export async function beginLearningRevalidation({
  root = process.cwd(), learningId, confirmLocalValidation = false, now = new Date()
}) {
  if (!confirmLocalValidation) throw new Error("revalidation requires explicit local confirmation");
  if (!ID_RE.test(learningId || "")) throw new Error("learningId is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (revokedEvaluationForCandidate(state, candidate)) {
      throw new Error("revalidation baseline contains an explicitly revoked evaluation contract");
    }
    if (revokedEvidenceSourceAttestationForCandidate(state, candidate)) {
      throw new Error("revalidation baseline contains an explicitly revoked evidence source attestation");
    }
    if (revokedApplicationForCandidate(state, candidate)) {
      throw new Error("revalidation baseline contains an explicitly revoked application");
    }
    if (revokedOutcomeForCandidate(state, candidate)) {
      throw new Error("revalidation baseline contains an explicitly revoked outcome");
    }
    const validation = validationLeaseState(state, candidate, timestamp);
    if (validation.status !== "active"
      || !REGISTRY_BOUND_EVALUATIONS.has(validation.evaluation?.schema)) {
      throw new Error("revalidation requires one current registry-bound validation lease");
    }
    const canary = candidate.promotion.canary;
    if (canary.revalidation?.status === "active"
      && new Date(canary.revalidation.expiresAt).getTime() > new Date(timestamp).getTime()) {
      return { candidate, revalidation: canary.revalidation, learningPath, unchanged: true };
    }
    const possibleExpiry = Math.min(new Date(validation.evaluation.expiresAt).getTime(),
      new Date(timestamp).getTime()
        + evaluationStalenessPolicy(validation.evaluation, state.config).canaryTtlDays * 86400000);
    if (possibleExpiry <= new Date(validation.lease.expiresAt).getTime()) {
      throw new Error("revalidation cannot extend evidence within the current evaluation contract window");
    }
    const baselineReferences = validation.lease.schema === "agentspine.learning-validation/v1"
      ? validation.lease.beforeOutcomes : validation.lease.baselineOutcomes;
    const baselines = baselineReferences.map((reference) => state.outcomes.find((outcome) =>
      outcome.id === reference.id && outcome.digest === reference.digest));
    if (baselines.some((outcome) => outcome?.schema !== "agentspine.learning-outcome/v9"
      || !DIGEST_RE.test(outcome.measurement?.evaluatorRootDigest || ""))) {
      throw new Error("revalidation requires a complete root-bound frozen baseline cohort");
    }
    const orderedRoots = [...baselines].sort((a, b) => a.measurement.evaluatorId.localeCompare(b.measurement.evaluatorId))
      .map((outcome, index) => {
        const trial = {
          evaluationId: validation.evaluation.id,
          evaluationDigest: validation.evaluation.digest,
          predecessorValidationId: validation.lease.id,
          predecessorValidationDigest: validation.lease.digest,
          slot: index + 1,
          evaluatorId: outcome.measurement.evaluatorId,
          evaluatorRootDigest: outcome.measurement.evaluatorRootDigest,
          runId: `run:revalidation:${randomUUID()}`,
          benchmark: validation.evaluation.benchmark,
          caseCount: outcome.coverage.caseCount
        };
        return { slot: trial.slot, evaluatorId: trial.evaluatorId,
          evaluatorRootDigest: trial.evaluatorRootDigest, runId: trial.runId,
          caseCount: trial.caseCount, trialDigest: revalidationTrialDigest(trial), authority: "context-only" };
      });
    const revalidationPayload = revalidationWindowPayload({
      schema: "agentspine.learning-revalidation-window/v4",
      id: `revalidation:${randomUUID()}`,
      status: "active",
      startedAt: timestamp,
      expiresAt: validation.lease.expiresAt,
      predecessorValidationId: validation.lease.id,
      predecessorValidationDigest: validation.lease.digest,
      selection: { mode: "first-admitted-trials", requiredDeliveries: orderedRoots.length,
        evaluatorRoots: orderedRoots, authority: "context-only" }
    });
    const revalidation = { ...revalidationPayload, digest: digest(revalidationPayload) };
    preserve(state, "learning-candidate", candidate, timestamp);
    const updated = {
      ...candidate,
      promotion: { ...candidate.promotion, canary: { ...canary, revalidation } },
      updatedAt: timestamp,
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === learningId ? updated : entry);
    return { candidate: updated, revalidation, learningPath, unchanged: false };
  });
}
