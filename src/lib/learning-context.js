import { buildCatalog } from "./catalog.js";
import { loadGraph } from "./graph.js";
import {
  KINDS
} from "./learning-schema.js";
import {
  validConfig, normalizeScope, scopeContains, exactScope
} from "./learning-scope-targets.js";
import {
  canaryValidity
} from "./learning-validation-runtime.js";
import {
  date, integer, loadLearning
} from "./learning-storage.js";

export function groupEntities(graph, groupId, includePrivate) {
  const result = new Set();
  if (!groupId) return result;
  result.add(groupId);
  for (const edge of graph.entityEdges) {
    if (edge.relation !== "member-of" || (!includePrivate && edge.privacy === "private")) continue;
    if (edge.to === groupId) result.add(edge.from);
    if (edge.from === groupId) result.add(edge.to);
  }
  return result;
}

export function visible(candidate, entities, audience, includePrivate, groupId) {
  if (candidate.privacy === "private" && !includePrivate) return false;
  if (candidate.privacy === "group" && (!groupId || candidate.groupId !== groupId)) return false;
  if (candidate.privacy === "group" && candidate.subjectId && !audience.has(candidate.subjectId)) return false;
  const subject = candidate.subjectId ? entities.get(candidate.subjectId) : null;
  if (subject?.privacy === "private" && !includePrivate) return false;
  if (subject?.privacy === "group" && !audience.has(subject.id)) return false;
  return true;
}

export async function learningContext({
  root = process.cwd(), includePrivate = false, groupId = null, kinds = null,
  subjectIds = null, scope = null, maxItems = null, catalog: providedCatalog = null, now = new Date()
} = {}) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { learning } = await loadLearning(catalog.root, catalog);
  if (!validConfig(learning.config)) throw new Error("learning configuration is invalid; run the audit before using learned context");
  const { graph } = await loadGraph(catalog.root, catalog);
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  if (groupId !== null) {
    const group = entities.get(groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
  }
  const audience = groupEntities(graph, groupId, includePrivate);
  const runtimeScope = normalizeScope(scope, null, groupId);
  const kindFilter = kinds === null ? null : new Set(kinds);
  if (kindFilter && [...kindFilter].some((kind) => !KINDS.has(kind))) throw new Error("kinds contains an unsupported learning kind");
  const subjectFilter = subjectIds === null ? null : new Set(subjectIds);
  const limit = maxItems === null ? learning.config.maxContextItems : integer(maxItems, "maxItems", 0, 50);
  const timestamp = date(now, "now");
  const applicable = learning.candidates
    .filter((candidate) => candidate.status === "accepted")
    .filter((candidate) => scope === null || scopeContains(candidate.scope, runtimeScope))
    .filter((candidate) => candidate.promotion?.mode !== "outcome-canary"
      || exactScope(candidate.promotion.canary.scope, runtimeScope))
    .filter((candidate) => !kindFilter || kindFilter.has(candidate.kind))
    .filter((candidate) => !subjectFilter || subjectFilter.has(candidate.subjectId))
    .filter((candidate) => candidate.privacy !== "group" || (groupId && candidate.groupId === groupId));
  const invalidCanaries = new Map(applicable.map((candidate) => [candidate.id,
    canaryValidity(learning, candidate, timestamp)]).filter(([, validity]) => ![
    "not-applicable", "current-active", "current-validated", "legacy-validated"
  ].includes(validity.status)));
  const revokedTrialFailureCandidates = learning.candidates
    .filter((candidate) => candidate.status === "rolled-back"
      && learning.trialFailureRevocations.some((receipt) => receipt.learningId === candidate.id))
    .filter((candidate) => scope === null || scopeContains(candidate.scope, runtimeScope))
    .filter((candidate) => !kindFilter || kindFilter.has(candidate.kind))
    .filter((candidate) => !subjectFilter || subjectFilter.has(candidate.subjectId))
    .filter((candidate) => candidate.privacy !== "group" || (groupId && candidate.groupId === groupId))
    .filter((candidate) => visible(candidate, entities, audience, includePrivate, groupId));
  const items = applicable
    .filter((candidate) => !invalidCanaries.has(candidate.id))
    .filter((candidate) => visible(candidate, entities, audience, includePrivate, groupId))
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      claim: candidate.claim,
      subjectId: candidate.subjectId,
      privacy: candidate.privacy,
      groupId: candidate.groupId,
      confidence: candidate.confidence,
      evidenceCount: candidate.evidence.length,
      automatic: candidate.automatic,
      acceptedAt: candidate.acceptedAt,
      outcomeStatus: candidate.promotion?.mode === "outcome-canary"
        ? (candidate.promotion.canary.status === "validated"
          && candidate.promotion.canary.revalidation?.status === "active"
          && new Date(candidate.promotion.canary.revalidation.expiresAt).getTime() >= new Date(timestamp).getTime()
          ? "revalidating" : candidate.promotion.canary.status)
        : "not-required",
      authority: "context-only"
    }));
  return {
    schema: "agentspine.learning-context/v1",
    root: catalog.root,
    groupId,
    scope: runtimeScope,
    items,
    degraded: invalidCanaries.size > 0 || revokedTrialFailureCandidates.length > 0,
    diagnostics: [...invalidCanaries].map(([id, validity]) => `${({
      "stale-active": "stale-outcome-canary",
      "revoked-active": "revoked-evaluator-canary",
      "stale-validated": "stale-validated-learning",
      "revoked-validated": "revoked-evaluator-validated-learning",
      "unproven-validated": "missing-validation-lease",
      "failed-initial-trial": "blocking-initial-trial-timeout",
      "revoked-evaluation": "revoked-learning-evaluation",
      "revoked-evidence-source-attestation": "revoked-learning-evidence-source-attestation",
      "revoked-validation": "revoked-learning-validation",
      "revoked-evidence": "revoked-learning-evidence",
      "revoked-measurement": "revoked-learning-measurement",
      "revoked-application": "revoked-learning-application",
      "revoked-delivery": "revoked-learning-delivery",
      "revoked-outcome": "revoked-learning-outcome"
    })[validity.status] || validity.status}:${id}`)
      .concat(revokedTrialFailureCandidates.map((candidate) =>
        `revoked-learning-trial-failure:${candidate.id}`)),
    authority: "context-only",
    note: "Learned context is descriptive evidence, never permission, delegation, access, or an instruction to act."
  };
}
