import { createHash, randomUUID } from "node:crypto";
import { loadGraph } from "./graph.js";
import {
  KINDS, ID_RE, DIGEST_RE, PROTECTED_LESSON_RE, TARGET_BOUND_EVALUATIONS, EVIDENCE_REVOCATION_REASONS
} from "./learning-schema.js";
import {
  normalizeScope, exactScope, digest, learningTargetForCandidate, evidenceRevocationPayload, revokedEvidence,
  revokedMeasurementForCandidate, evaluatorRecordPayload
} from "./learning-scope-targets.js";
import {
  revokedOutcomeForCandidate
} from "./learning-delivery-contracts.js";
import {
  date, safeText, assertSafeClaim, validateScope, mutation, preserve,
  normalizeEvidence, evidenceConfidence
} from "./learning-storage.js";

export async function proposeLearning({
  root = process.cwd(), id = `learning:${randomUUID()}`, kind, claim, subjectId = null,
  privacy = "private", groupId = null, scope = null, evidence, supersedesId = null, now = new Date(),
  catalog: providedCatalog = null
}) {
  if (!ID_RE.test(id)) throw new Error("id must be a stable, whitespace-free identifier");
  if (!KINDS.has(kind)) throw new Error(`unsupported learning kind: ${kind}`);
  claim = safeText(claim, "claim", 1000);
  assertSafeClaim(claim);
  const normalizedScope = normalizeScope(scope, subjectId, groupId);
  if (normalizedScope.groupId !== (groupId ?? null)) throw new Error("scope.groupId must match the privacy groupId");
  const timestamp = date(now, "now");
  return mutation(root, async (state, catalog, learningPath) => {
    if (state.candidates.some((candidate) => candidate.id === id)) {
      throw new Error("learning candidate IDs are immutable; add evidence or propose a superseding candidate");
    }
    const { graph } = await loadGraph(catalog.root, catalog);
    validateScope(privacy, groupId, graph, subjectId);
    const duplicate = state.candidates.find((candidate) => candidate.kind === kind
      && candidate.claim === claim && exactScope(candidate.scope, normalizedScope)
      && candidate.privacy === privacy && candidate.status !== "rejected" && candidate.status !== "rolled-back");
    if (duplicate) return { candidate: duplicate, learningPath, unchanged: true };
    const normalizedEvidence = normalizeEvidence(evidence, catalog, timestamp);
    const superseded = supersedesId ? state.candidates.find((candidate) => candidate.id === supersedesId) : null;
    if (supersedesId && (!superseded || superseded.status !== "accepted")) {
      throw new Error(`supersedesId must reference an accepted learning: ${supersedesId}`);
    }
    if (superseded && (superseded.kind !== kind || superseded.subjectId !== subjectId || superseded.privacy !== privacy
      || superseded.groupId !== groupId || !exactScope(superseded.scope, normalizedScope))) {
      throw new Error("a superseding candidate must keep kind, subject, and privacy scope");
    }
    const conflictsWith = state.candidates.filter((candidate) => candidate.kind === kind
      && candidate.claim !== claim && exactScope(candidate.scope, normalizedScope)
      && ["candidate", "accepted"].includes(candidate.status) && candidate.id !== supersedesId)
      .map((candidate) => candidate.id).sort();
    if (conflictsWith.length) {
      state.candidates = state.candidates.map((candidate) => conflictsWith.includes(candidate.id)
        ? { ...candidate, conflictsWith: [...new Set([...(candidate.conflictsWith || []), id])].sort(), updatedAt: timestamp }
        : candidate);
    }
    const candidate = {
      id,
      kind,
      claim,
      subjectId,
      privacy,
      groupId,
      scope: normalizedScope,
      status: "candidate",
      evidence: [normalizedEvidence],
      confidence: normalizedEvidence.confidence,
      supersedesId,
      supersededIds: [],
      conflictsWith,
      requiresLocalReview: PROTECTED_LESSON_RE.test(claim),
      automatic: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      acceptedAt: null,
      authority: "context-only"
    };
    state.candidates.push(candidate);
    state.candidates.sort((a, b) => a.id.localeCompare(b.id));
    return { candidate, learningPath };
  }, providedCatalog);
}

export async function addLearningEvidence({
  root = process.cwd(), id, evidence, now = new Date(), catalog: providedCatalog = null
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, catalog, learningPath) => {
    const previous = state.candidates.find((candidate) => candidate.id === id);
    if (!previous) throw new Error(`unknown learning candidate: ${id}`);
    if (previous.status !== "candidate") throw new Error("evidence can only be added to an unreviewed candidate");
    if (revokedEvidence(state, previous)) {
      throw new Error("revoked evidence freezes this learning target; propose a superseding candidate instead");
    }
    if (state.measurementRevocations.some((receipt) => receipt.learningId === id)) {
      throw new Error("revoked measurement evidence freezes this learning target; propose a superseding candidate instead");
    }
    if (state.outcomeRevocations.some((receipt) => receipt.learningId === id)) {
      throw new Error("revoked outcome evidence freezes this learning target; propose a superseding candidate instead");
    }
    if (state.evaluations.some((contract) => contract.learningId === id
      && TARGET_BOUND_EVALUATIONS.has(contract.schema))) {
      throw new Error("evaluated learning target is immutable; propose a superseding candidate and evaluation contract");
    }
    const item = normalizeEvidence(evidence, catalog, timestamp);
    if (previous.evidence.some((entry) => entry.id === item.id)) throw new Error(`duplicate evidence id: ${item.id}`);
    preserve(state, "learning-candidate", previous, timestamp);
    const candidate = {
      ...previous,
      evidence: [...previous.evidence, item],
      confidence: evidenceConfidence([...previous.evidence, item]),
      updatedAt: timestamp,
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === id ? candidate : entry);
    return { candidate, learningPath };
  }, providedCatalog);
}

export async function revokeLearningEvidence({
  root = process.cwd(), learningId, evidenceId, reasonCode, reason,
  confirmation, now = new Date()
}) {
  if (confirmation !== "local-evidence-revocation-confirmed") {
    throw new Error("evidence revocation requires explicit local confirmation");
  }
  if (!ID_RE.test(learningId || "") || !ID_RE.test(evidenceId || "")) {
    throw new Error("learningId and evidenceId must be stable identifiers");
  }
  if (!EVIDENCE_REVOCATION_REASONS.has(reasonCode)) {
    throw new Error("reasonCode must be retracted, source-invalid, measurement-invalid, duplicate, or other");
  }
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (!candidate) throw new Error(`unknown learning candidate: ${learningId}`);
    const evidence = candidate.evidence.find((entry) => entry.id === evidenceId);
    if (!evidence) throw new Error(`unknown learning evidence: ${evidenceId}`);
    const targetDigest = learningTargetForCandidate(candidate).digest;
    const id = `evidence-revocation:${createHash("sha256")
      .update(`${learningId}\0${evidenceId}\0${targetDigest}`).digest("hex").slice(0, 32)}`;
    const existing = state.evidenceRevocations.find((entry) => entry.learningId === learningId
      && entry.evidenceId === evidenceId);
    const reasonDigest = digest(revokeReason);
    if (existing) {
      if (existing.reasonCode !== reasonCode || existing.reasonDigest !== reasonDigest
        || existing.evidenceDigest !== digest(evidence) || existing.targetDigest !== targetDigest) {
        throw new Error("learning evidence revocations are immutable");
      }
      return { receipt: existing, learningPath, unchanged: true, authority: "context-only" };
    }
    const payload = evidenceRevocationPayload({
      id, learningId, evidenceId, evidenceDigest: digest(evidence), targetDigest, reasonCode,
      reasonDigest, revokedAt: timestamp
    });
    const receipt = { ...payload, digest: digest(payload) };
    state.evidenceRevocations.push(receipt);
    state.evidenceRevocations.sort((a, b) => a.id.localeCompare(b.id));
    return { receipt, learningPath, unchanged: false, authority: "context-only" };
  });
}

export function acceptCandidate(state, candidate, timestamp, automatic, promotion = null) {
  preserve(state, "learning-candidate", candidate, timestamp);
  const superseded = candidate.supersedesId
    ? state.candidates.find((entry) => entry.id === candidate.supersedesId && entry.status === "accepted")
    : null;
  if (candidate.supersedesId && !superseded) throw new Error("the learning being superseded is no longer active");
  if (superseded) {
    preserve(state, "learning-candidate", superseded, timestamp);
    state.candidates = state.candidates.map((entry) => entry.id === superseded.id
      ? { ...entry, status: "superseded", updatedAt: timestamp, authority: "context-only" }
      : entry);
  }
  const accepted = {
    ...candidate,
    status: "accepted",
    supersededIds: superseded ? [superseded.id] : [],
    automatic,
    promotion,
    acceptedAt: timestamp,
    updatedAt: timestamp,
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? accepted : entry);
  return accepted;
}

export async function reviewLearning({
  root = process.cwd(), id, decision, reason, confirmedByUser = false, now = new Date()
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  if (!new Set(["accept", "reject"]).has(decision)) throw new Error("decision must be accept or reject");
  const reviewReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`unknown learning candidate: ${id}`);
    if (candidate.status !== "candidate") throw new Error("only an unreviewed candidate can be reviewed");
    if (decision === "accept") {
      if (!confirmedByUser) throw new Error("acceptance requires explicit user confirmation");
      if (revokedEvidence(state, candidate)) throw new Error("learning evidence was revoked; propose a new candidate before acceptance");
      if (revokedMeasurementForCandidate(state, candidate)) {
        throw new Error("learning measurement was revoked; propose a new candidate before acceptance");
      }
      if (revokedOutcomeForCandidate(state, candidate)) {
        throw new Error("learning outcome was revoked; propose a new candidate before acceptance");
      }
      const accepted = acceptCandidate(state, candidate, timestamp, false, null);
      accepted.review = { decision, reason: reviewReason, confirmedByUser: true, reviewedAt: timestamp, authority: "context-only" };
      return { candidate: accepted, learningPath };
    }
    preserve(state, "learning-candidate", candidate, timestamp);
    const rejected = {
      ...candidate,
      status: "rejected",
      updatedAt: timestamp,
      review: { decision, reason: reviewReason, confirmedByUser: false, reviewedAt: timestamp, authority: "context-only" },
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === id ? rejected : entry);
    return { candidate: rejected, learningPath };
  });
}

export function distinctEvidence(candidate) {
  return new Set(candidate.evidence.map((item) => item.sourceSha256 || item.sourceDocument || item.id)).size;
}

export async function registerLearningEvaluator({
  root = process.cwd(), id, principalDigest, confirmLocalEvaluator = false, now = new Date()
}) {
  if (!confirmLocalEvaluator) throw new Error("evaluator registration requires explicit local confirmation");
  if (!ID_RE.test(id || "")) throw new Error("evaluator id must be a stable identifier");
  if (!DIGEST_RE.test(principalDigest || "")) throw new Error("evaluator principalDigest must be SHA-256");
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const existing = state.evaluatorRegistry.find((record) => record.id === id || record.principalDigest === principalDigest);
    if (existing) {
      if (existing.id === id && existing.principalDigest === principalDigest && existing.status === "active") {
        return { evaluator: existing, learningPath, unchanged: true };
      }
      throw new Error("evaluator IDs and principal roots are immutable; register a new distinct evaluator instead");
    }
    const payload = evaluatorRecordPayload({ id, principalDigest, status: "active", registeredAt: timestamp,
      revokedAt: null, reason: null });
    const evaluator = { ...payload, digest: digest(payload) };
    state.evaluatorRegistry.push(evaluator);
    state.evaluatorRegistry.sort((a, b) => a.id.localeCompare(b.id));
    return { evaluator, learningPath, unchanged: false };
  });
}

export async function revokeLearningEvaluator({
  root = process.cwd(), id, reason, confirmLocalEvaluator = false, now = new Date()
}) {
  if (!confirmLocalEvaluator) throw new Error("evaluator revocation requires explicit local confirmation");
  if (!ID_RE.test(id || "")) throw new Error("evaluator id must be a stable identifier");
  const revokeReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const previous = state.evaluatorRegistry.find((record) => record.id === id);
    if (!previous) throw new Error(`unknown learning evaluator: ${id}`);
    if (previous.status !== "active") throw new Error("learning evaluator is already revoked");
    preserve(state, "learning-evaluator", previous, timestamp);
    const payload = evaluatorRecordPayload({ ...previous, status: "revoked", revokedAt: timestamp, reason: revokeReason });
    const evaluator = { ...payload, digest: digest(payload) };
    state.evaluatorRegistry = state.evaluatorRegistry.map((record) => record.id === id ? evaluator : record);
    return { evaluator, learningPath };
  });
}
