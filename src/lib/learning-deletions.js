import { createHash } from "node:crypto";
import { DIGEST_RE, ID_RE } from "./learning-schema.js";
import { digest } from "./learning-scope-targets.js";

function deletionTargetPayload(candidate) {
  return {
    schema: "agentspine.learning-deletion-target/v1",
    kind: candidate.kind,
    claim: candidate.claim,
    subjectId: candidate.subjectId,
    privacy: candidate.privacy,
    groupId: candidate.groupId,
    scope: candidate.scope,
    authority: "context-only"
  };
}

function deletionEvidencePayload(evidence) {
  return {
    schema: "agentspine.learning-deletion-evidence/v1",
    type: evidence.type,
    summary: evidence.summary,
    sourceDocument: evidence.sourceDocument,
    sourceSha256: evidence.sourceSha256,
    authority: "context-only"
  };
}

function deletionSourcePayload(evidence) {
  if (!evidence.sourceSha256) return null;
  return {
    schema: "agentspine.learning-deletion-source/v1",
    type: evidence.type,
    sourceSha256: evidence.sourceSha256,
    authority: "context-only"
  };
}

export function deletionTargetDigest(candidate) {
  return digest(deletionTargetPayload(candidate));
}

export function deletionEvidenceDigest(evidence) {
  return digest(deletionEvidencePayload(evidence));
}

export function deletionSourceDigest(evidence) {
  const payload = deletionSourcePayload(evidence);
  return payload ? digest(payload) : null;
}

function deletionPayload({ schema, id, targetDigest, evidenceDigests, sourceDigests, deletedAt }) {
  const payload = {
    schema,
    id,
    targetDigest,
    evidenceDigests,
    deletedAt,
    authority: "context-only"
  };
  if (schema === "agentspine.learning-deletion/v2") payload.sourceDigests = sourceDigests;
  return payload;
}

export function deletionTombstone(candidate, deletedAt) {
  const schema = "agentspine.learning-deletion/v2";
  const targetDigest = deletionTargetDigest(candidate);
  const evidenceDigests = [...new Set(candidate.evidence.map(deletionEvidenceDigest))].sort();
  const sourceDigests = [...new Set(candidate.evidence.map(deletionSourceDigest).filter(Boolean))].sort();
  const id = `learning-deletion:${createHash("sha256")
    .update(JSON.stringify({ targetDigest, evidenceDigests, sourceDigests })).digest("hex")}`;
  const payload = deletionPayload({ schema, id, targetDigest, evidenceDigests, sourceDigests, deletedAt });
  return { ...payload, digest: digest(payload) };
}

export function storedDeletionTombstone(tombstone) {
  if (!tombstone || typeof tombstone !== "object" || Array.isArray(tombstone)) return false;
  const v1 = tombstone.schema === "agentspine.learning-deletion/v1";
  const v2 = tombstone.schema === "agentspine.learning-deletion/v2";
  const fields = ["schema", "id", "targetDigest", "evidenceDigests", "deletedAt", "authority", "digest"];
  if (v2) fields.push("sourceDigests");
  if ((!v1 && !v2) || Object.keys(tombstone).length !== fields.length
    || !Object.keys(tombstone).every((field) => fields.includes(field))) return false;
  if (!ID_RE.test(tombstone.id || "")
    || !DIGEST_RE.test(tombstone.targetDigest || "") || !DIGEST_RE.test(tombstone.digest || "")
    || tombstone.authority !== "context-only" || !Number.isFinite(Date.parse(tombstone.deletedAt || ""))
    || !Array.isArray(tombstone.evidenceDigests) || tombstone.evidenceDigests.length === 0
    || tombstone.evidenceDigests.some((value) => !DIGEST_RE.test(value || ""))
    || new Set(tombstone.evidenceDigests).size !== tombstone.evidenceDigests.length
    || [...tombstone.evidenceDigests].sort().some((value, index) => value !== tombstone.evidenceDigests[index])) {
    return false;
  }
  if (v2 && (!Array.isArray(tombstone.sourceDigests)
    || tombstone.sourceDigests.some((value) => !DIGEST_RE.test(value || ""))
    || new Set(tombstone.sourceDigests).size !== tombstone.sourceDigests.length
    || [...tombstone.sourceDigests].sort().some((value, index) => value !== tombstone.sourceDigests[index]))) {
    return false;
  }
  return tombstone.digest === digest(deletionPayload(tombstone));
}

export function recordDeletionTombstone(state, candidate, deletedAt) {
  const tombstone = deletionTombstone(candidate, deletedAt);
  if (!state.deletionTombstones.some((entry) => entry.id === tombstone.id)) {
    state.deletionTombstones.push(tombstone);
    state.deletionTombstones.sort((left, right) => left.id.localeCompare(right.id));
  }
  return tombstone;
}

export function deletedEvidenceState(state, candidate, evidence) {
  const targetDigest = deletionTargetDigest(candidate);
  const evidenceDigest = deletionEvidenceDigest(evidence);
  const sourceDigest = deletionSourceDigest(evidence);
  const matching = state.deletionTombstones.filter((entry) => entry.targetDigest === targetDigest);
  return {
    targetDeleted: matching.length > 0,
    evidenceDeleted: matching.some((entry) => entry.evidenceDigests.includes(evidenceDigest)
      || (sourceDigest && entry.schema === "agentspine.learning-deletion/v2"
        && entry.sourceDigests.includes(sourceDigest)))
  };
}
