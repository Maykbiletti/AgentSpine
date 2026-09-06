const KNOWLEDGE_KINDS = new Set([
  "fact", "user-preference", "decision", "task-state", "error-lesson"
]);

const SESSION_REF = /^session-ref:[a-f0-9]{32}$/;
const MESSAGE_REF = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk[-_](?:proj[-_])?|gh[opusu]_)[A-Za-z0-9_-]{20,}\b|\b(?:xox[bapcrs]-|github_pat_|glpat-|npm_)[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;

function containsSecret(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && SECRET_RE.test(item)) return true;
    if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === "object") pending.push(...Object.values(item));
  }
  return false;
}

function pairedSourceRefs(sessionRef, messageRef) {
  if ((sessionRef === null) !== (messageRef === null)) {
    throw new Error("sessionRef and messageRef must be provided together");
  }
  if (sessionRef !== null && (!SESSION_REF.test(sessionRef) || !MESSAGE_REF.test(messageRef))) {
    throw new Error("sessionRef and messageRef must be stable provenance references");
  }
}

export function normalizeKnowledgeFields(input, evidenceKind, value) {
  const kind = input.knowledgeKind ?? null;
  if (kind === null) {
    if (input.sessionRef !== undefined || input.messageRef !== undefined) {
      throw new Error("session references require knowledgeKind");
    }
    return { knowledgeKind: null, sessionRef: null, messageRef: null };
  }
  if (!KNOWLEDGE_KINDS.has(kind)) throw new Error("unsupported knowledgeKind");
  if (containsSecret(value) || containsSecret(input.reason || "")) {
    throw new Error("secret-shaped content cannot enter structured knowledge");
  }
  if (kind === "user-preference" && !["explicit-user-feedback", "model-suggestion"].includes(evidenceKind)) {
    throw new Error("user preferences require explicit feedback or remain a model suggestion");
  }
  if (kind === "decision" && !["explicit-user-feedback", "model-suggestion"].includes(evidenceKind)) {
    throw new Error("decisions require explicit feedback or remain a model suggestion");
  }
  if (kind === "decision" && (typeof input.reason !== "string" || !input.reason.trim())) {
    throw new Error("decisions require a bounded rationale");
  }
  const sessionRef = input.sessionRef ?? null;
  const messageRef = input.messageRef ?? null;
  pairedSourceRefs(sessionRef, messageRef);
  return { knowledgeKind: kind, sessionRef, messageRef };
}

export function validKnowledgeFields(assertion) {
  const kind = assertion.knowledgeKind ?? null;
  if (kind === null) return assertion.sessionRef === undefined && assertion.messageRef === undefined;
  if (!KNOWLEDGE_KINDS.has(kind)) return false;
  if (containsSecret(assertion.value) || containsSecret(assertion.reason || "")) return false;
  if (kind === "user-preference" && !["explicit-user-feedback", "model-suggestion"].includes(assertion.evidenceKind)) return false;
  if (kind === "decision" && !["explicit-user-feedback", "model-suggestion"].includes(assertion.evidenceKind)) return false;
  if (kind === "decision" && !assertion.reason) return false;
  try {
    pairedSourceRefs(assertion.sessionRef ?? null, assertion.messageRef ?? null);
    return true;
  } catch {
    return false;
  }
}

function publicEntry(assertion, status, statusReason) {
  return {
    id: assertion.id,
    kind: assertion.knowledgeKind,
    subjectId: assertion.subjectId,
    predicate: assertion.predicate,
    value: structuredClone(assertion.value),
    status,
    statusReason,
    source: {
      kind: assertion.evidenceKind,
      id: assertion.evidenceId,
      digest: assertion.evidenceDigest,
      sessionRef: assertion.sessionRef ?? null,
      messageRef: assertion.messageRef ?? null
    },
    observedAt: assertion.observedAt,
    expiresAt: assertion.expiresAt,
    recordedAt: assertion.recordedAt,
    rationale: assertion.reason || null,
    scope: {
      projectId: assertion.projectId,
      groupId: assertion.groupId,
      privacy: assertion.privacy
    },
    authority: "context-only"
  };
}

function statusFor(assertion, { staleIds, supersededIds, conflictIds }) {
  if (staleIds.has(assertion.id)) return ["superseded", "expired"];
  if (supersededIds.has(assertion.id)) return ["superseded", "replaced"];
  if (assertion.status === "proposed") return ["assumption", "model-suggestion"];
  if (conflictIds.has(assertion.id)) return ["contradictory", "active-conflict"];
  return ["confirmed", "established-evidence"];
}

export function structuredKnowledgeView({
  candidates, stale, active, supersededIds, conflictAssertions,
  includeHistory = false, maxItems = 100
}) {
  const staleIds = new Set(stale.map((item) => item.id));
  const activeIds = new Set(active.map((item) => item.id));
  const conflictIds = new Set(conflictAssertions.flatMap((items) => items.map((item) => item.id)));
  const entries = candidates.filter((item) => item.knowledgeKind).map((assertion) => {
    const [status, reason] = statusFor(assertion, { staleIds, supersededIds, conflictIds });
    return publicEntry(assertion, status, reason);
  }).sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id));
  const current = entries.filter((item) => activeIds.has(item.id));
  const historical = entries.filter((item) => !activeIds.has(item.id));
  const history = includeHistory ? historical : [];
  const counts = Object.fromEntries(["confirmed", "assumption", "superseded", "contradictory"]
    .map((status) => [status, entries.filter((item) => item.status === status).length]));
  return {
    schema: "agentspine.structured-knowledge/v1",
    current: current.slice(0, maxItems),
    history: history.slice(0, maxItems),
    counts,
    omitted: {
      current: Math.max(0, current.length - maxItems),
      history: includeHistory ? Math.max(0, historical.length - maxItems) : historical.length
    },
    authority: "context-only"
  };
}
