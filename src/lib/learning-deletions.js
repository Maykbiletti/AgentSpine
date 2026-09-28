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

export function deletionTargetDigest(candidate) {
  return digest(deletionTargetPayload(candidate));
}

export function deletionEvidenceDigest(evidence) {
  return digest(deletionEvidencePayload(evidence));
}

function deletionPayload({ id, targetDigest, evidenceDigests, deletedAt }) {
  return {
    schema: "agentspine.learning-deletion/v1",
    id,
    targetDigest,
    evidenceDigests,
    deletedAt,
    authority: "context-only"
  };
}

export function deletionTombstone(candidate, deletedAt) {
  const targetDigest = deletionTargetDigest(candidate);
  const evidenceDigests = [...new Set(candidate.evidence.map(deletionEvidenceDigest))].sort();
  const id = `learning-deletion:${createHash("sha256")
    .update(JSON.stringify({ targetDigest, evidenceDigests })).digest("hex")}`;
  const payload = deletionPayload({ id, targetDigest, evidenceDigests, deletedAt });
  return { ...payload, digest: digest(payload) };
}

export function storedDeletionTombstone(tombstone) {
  if (!tombstone || typeof tombstone !== "object" || Array.isArray(tombstone)) return false;
  if (Object.keys(tombstone).length !== 7
    || !Object.keys(tombstone).every((field) => [
      "schema", "id", "targetDigest", "evidenceDigests", "deletedAt", "authority", "digest"
    ].includes(field))) return false;
  if (tombstone.schema !== "agentspine.learning-deletion/v1" || !ID_RE.test(tombstone.id || "")
    || !DIGEST_RE.test(tombstone.targetDigest || "") || !DIGEST_RE.test(tombstone.digest || "")
    || tombstone.authority !== "context-only" || !Number.isFinite(Date.parse(tombstone.deletedAt || ""))
    || !Array.isArray(tombstone.evidenceDigests) || tombstone.evidenceDigests.length === 0
    || tombstone.evidenceDigests.some((value) => !DIGEST_RE.test(value || ""))
    || new Set(tombstone.evidenceDigests).size !== tombstone.evidenceDigests.length
    || [...tombstone.evidenceDigests].sort().some((value, index) => value !== tombstone.evidenceDigests[index])) {
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
  const matching = state.deletionTombstones.filter((entry) => entry.targetDigest === targetDigest);
  return {
    targetDeleted: matching.length > 0,
    evidenceDeleted: matching.some((entry) => entry.evidenceDigests.includes(evidenceDigest))
  };
}
