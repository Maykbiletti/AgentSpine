const KNOWLEDGE_KINDS = new Set([
  "fact", "user-preference", "decision", "task-state", "error-lesson"
]);

const SESSION_REF = /^session-ref:[a-f0-9]{32}$/;
const MESSAGE_REF = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk[-_](?:proj[-_])?|gh[opusu]_)[A-Za-z0-9_-]{20,}\b|\b(?:xox[bapcrs]-|github_pat_|glpat-|npm_)[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const TASK_CONTINUATION_SCHEMA = "agentspine.task-continuation/v1";
const TASK_STATUSES = new Set(["active", "blocked", "paused", "completed"]);
const STEP_RESULTS = new Set(["passed", "failed", "blocked"]);
const STABLE_ID = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const DIGEST = /^[a-f0-9]{64}$/;

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

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${field} has an invalid structure`);
  }
}

function boundedText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${field} must be a bounded non-empty string`);
  }
}

function validateContinuation(input, value) {
  if (value?.schema !== TASK_CONTINUATION_SCHEMA) return;
  exactKeys(value, ["schema", "taskId", "status", "objective", "lastVerifiedStep", "openQuestions", "nextStep"], "task continuation");
  if (input.knowledgeKind !== "task-state" || input.predicate !== "task.continuation"
    || value.taskId !== input.subjectId || !STABLE_ID.test(value.taskId || "")) {
    throw new Error("task continuation must be a task-state bound to its task subject and predicate");
  }
  if (input.sessionRef === undefined || input.messageRef === undefined) {
    throw new Error("task continuation requires stable session and message source references");
  }
  if (!TASK_STATUSES.has(value.status)) throw new Error("task continuation status is invalid");
  boundedText(value.objective, "task continuation objective", 500);
  if (!Array.isArray(value.openQuestions) || value.openQuestions.length > 8) {
    throw new Error("task continuation openQuestions must be a bounded array");
  }
  for (const question of value.openQuestions) {
    exactKeys(question, ["id", "question"], "task continuation question");
    if (!STABLE_ID.test(question.id || "")) throw new Error("task continuation question id is invalid");
    boundedText(question.question, "task continuation question", 300);
  }
  if (new Set(value.openQuestions.map((item) => item.id)).size !== value.openQuestions.length) {
    throw new Error("task continuation question ids must be unique");
  }
  if (value.nextStep !== null) {
    exactKeys(value.nextStep, ["id", "summary"], "task continuation nextStep");
    if (!STABLE_ID.test(value.nextStep.id || "")) throw new Error("task continuation next step id is invalid");
    boundedText(value.nextStep.summary, "task continuation next step", 500);
  }
  if (value.lastVerifiedStep !== null) {
    exactKeys(value.lastVerifiedStep,
      ["id", "summary", "result", "evidenceId", "evidenceDigest", "observedAt", "sessionRef", "messageRef"],
      "task continuation lastVerifiedStep");
    if (!STABLE_ID.test(value.lastVerifiedStep.id || "") || !STEP_RESULTS.has(value.lastVerifiedStep.result)
      || !STABLE_ID.test(value.lastVerifiedStep.evidenceId || "")
      || !DIGEST.test(value.lastVerifiedStep.evidenceDigest || "")) {
      throw new Error("task continuation verified step evidence is invalid");
    }
    boundedText(value.lastVerifiedStep.summary, "task continuation verified step", 500);
    if (new Date(value.lastVerifiedStep.observedAt).toISOString() !== value.lastVerifiedStep.observedAt
      || new Date(value.lastVerifiedStep.observedAt).getTime() > new Date(input.observedAt).getTime()) {
      throw new Error("task continuation verified step timestamp is invalid");
    }
    pairedSourceRefs(value.lastVerifiedStep.sessionRef, value.lastVerifiedStep.messageRef);
  }
  if (value.status === "completed" && (value.nextStep !== null || value.openQuestions.length)) {
    throw new Error("completed task continuation cannot retain a next step or open questions");
  }
  if (value.status === "completed" && value.lastVerifiedStep?.result !== "passed") {
    throw new Error("completed task continuation requires a passed verified step");
  }
  if (value.status === "completed" && input.evidenceKind !== "objective-measurement") {
    throw new Error("completed task continuation requires objective measurement evidence");
  }
  if (value.status !== "completed" && value.nextStep === null) {
    throw new Error("resumable task continuation requires a next step");
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
  validateContinuation(input, value);
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
    validateContinuation(assertion, assertion.value);
    pairedSourceRefs(assertion.sessionRef ?? null, assertion.messageRef ?? null);
    return true;
  } catch {
    return false;
  }
}

function continuationView(entries, taskId, maxItems) {
  const eligible = entries.filter((item) => item.kind === "task-state" && item.status === "confirmed"
    && item.predicate === "task.continuation" && item.value?.schema === TASK_CONTINUATION_SCHEMA
    && (!taskId || item.subjectId === taskId));
  const selected = new Map();
  for (const item of eligible) {
    if (!selected.has(item.subjectId)) selected.set(item.subjectId, item);
  }
  const capsules = [...selected.values()].map((item) => ({
    schema: TASK_CONTINUATION_SCHEMA,
    assertionId: item.id,
    ...structuredClone(item.value),
    source: structuredClone(item.source),
    observedAt: item.observedAt,
    scope: structuredClone(item.scope),
    authority: "context-only"
  }));
  const limited = capsules.slice(0, Math.min(maxItems, 8));
  return {
    schema: "agentspine.task-continuation-context/v1",
    tasks: limited.filter((item) => item.status !== "completed"),
    terminal: limited.filter((item) => item.status === "completed"),
    omitted: capsules.length - limited.length,
    authority: "context-only",
    note: "Continuation is descriptive context only and never grants permission, tools, delegation, or execution."
  };
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
  includeHistory = false, continuationTaskId = null, maxItems = 100
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
    continuation: continuationView(current, continuationTaskId, maxItems),
    counts,
    omitted: {
      current: Math.max(0, current.length - maxItems),
      history: includeHistory ? Math.max(0, historical.length - maxItems) : historical.length
    },
    authority: "context-only"
  };
}
