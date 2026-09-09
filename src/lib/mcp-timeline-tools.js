import { TIMELINE_HOSTS } from "./session-timeline-provider.js";

const stableId = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$"
};

const optionalId = { anyOf: [stableId, { type: "null" }] };
const assertionId = {
  type: "string",
  pattern: "^assertion:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$"
};

export const TIMELINE_INTERPRETATION_SCHEMA = "agentspine.timeline-user-feedback-interpretation-request/v1";
export const TIMELINE_CLARIFICATION_SCHEMA = "agentspine.timeline-user-feedback-clarification-request/v2";
const INTERPRETATION_KINDS = new Set([
  "next-step-correction", "completion-claim", "not-current-instruction", "ambiguous"
]);

export function timelineInterpretationRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const clarificationKeys = ["schema", "feedbackAssertionIds", "targetAssertionId", "clarificationQuestion"];
  if (Object.keys(value).sort().join("\0") === clarificationKeys.sort().join("\0")
    && value.schema === TIMELINE_CLARIFICATION_SCHEMA
    && Array.isArray(value.feedbackAssertionIds) && value.feedbackAssertionIds.length >= 2
    && value.feedbackAssertionIds.length <= 3
    && value.feedbackAssertionIds.every((id) => /^assertion:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(id))
    && new Set(value.feedbackAssertionIds).size === value.feedbackAssertionIds.length
    && [...value.feedbackAssertionIds].sort().every((id, index) => id === value.feedbackAssertionIds[index])
    && /^assertion:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(value.targetAssertionId || "")
    && typeof value.clarificationQuestion === "string" && Boolean(value.clarificationQuestion.trim())
    && value.clarificationQuestion.length <= 300 && !/[\r\n]/u.test(value.clarificationQuestion)) {
    return structuredClone(value);
  }
  const keys = ["schema", "feedbackAssertionId", "targetAssertionId", "kind",
    "proposedNextStepSummary", "clarificationQuestion"];
  if (Object.keys(value).sort().join("\0") !== keys.sort().join("\0")
    || value.schema !== TIMELINE_INTERPRETATION_SCHEMA
    || !/^assertion:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(value.feedbackAssertionId || "")
    || !/^assertion:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(value.targetAssertionId || "")
    || !INTERPRETATION_KINDS.has(value.kind)) return null;
  const next = value.proposedNextStepSummary;
  const question = value.clarificationQuestion;
  const validNext = typeof next === "string" && Boolean(next.trim())
    && next.length <= 500 && !/[\r\n]/u.test(next);
  const validQuestion = typeof question === "string" && Boolean(question.trim())
    && question.length <= 300 && !/[\r\n]/u.test(question);
  if ((value.kind === "next-step-correction" ? !validNext || question !== null
    : next !== null || (value.kind === "ambiguous" ? !validQuestion : question !== null))) return null;
  return structuredClone(value);
}

// Hosts qualify MCP tools differently. These prefixes must stay exact: a
// foreign MCP server can expose an identically named tool but must never
// receive a timeline invocation permit.
export const AGENTSPINE_TIMELINE_TOOL_PREFIX = "mcp__plugin_agent-spine_agent-spine__";
export const BLUN_TIMELINE_TOOL_PREFIX = "mcp__agent-spine__";

const TIMELINE_TOOL_PREFIXES = [
  AGENTSPINE_TIMELINE_TOOL_PREFIX,
  BLUN_TIMELINE_TOOL_PREFIX
];

const SCOPE_FIELDS = [
  ["entityId", ["entityId", "entity_id"]],
  ["userId", ["userId", "user_id"]],
  ["tenantId", ["tenantId", "tenant_id"]],
  ["projectId", ["projectId", "project_id"]],
  ["groupId", ["groupId", "group_id"]],
  ["currentTaskId", ["taskId", "task_id", "currentTaskId", "current_task_id"]],
  ["goalId", ["goalId", "goal_id"]],
  ["goalStepId", ["goalStepId", "goal_step_id"]],
  ["portalRef", ["portalRef", "portal_ref"]],
  ["threadRef", ["threadRef", "thread_ref"]],
  ["timelineVisibility", ["timelineVisibility", "timeline_visibility"]]
];

const REQUEST_FIELDS = [
  ["host", ["host"]],
  ["sessionId", ["sessionId", "session_id"]],
  ["enrollmentDigest", ["enrollmentDigest", "enrollment_digest"]]
];

function owns(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function absent(value) { return value === undefined || value === null || value === ""; }

function containers(args) {
  if (!plainObject(args)) return { valid: false, reason: "timeline-scope-invalid", values: [] };
  if (!owns(args, "agent_spine_scope") || args.agent_spine_scope === null) {
    return { valid: true, reason: null, values: [args] };
  }
  if (!plainObject(args.agent_spine_scope)) {
    return { valid: false, reason: "timeline-scope-invalid", values: [args] };
  }
  return { valid: true, reason: null, values: [args, args.agent_spine_scope] };
}

function claim(values, aliases) {
  const supplied = values.flatMap((value) => aliases.filter((key) => owns(value, key)).map((key) => value[key]));
  const present = supplied.filter((value) => !absent(value));
  if (!present.length) return { valid: true, value: null, present: false };
  if (present.some((value) => typeof value !== "string") || !present.every((value) => value === present[0])) {
    return { valid: false, value: null, present: true };
  }
  return { valid: true, value: present[0], present: true };
}

function validId(value) {
  return value === null || (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/.test(value));
}

function resolvedClaims(args) {
  const nested = containers(args);
  const values = nested.values;
  const result = { valid: nested.valid, reason: nested.reason, groupClaim: false, scope: {}, request: {} };
  for (const [field, aliases] of [...SCOPE_FIELDS, ...REQUEST_FIELDS]) {
    const resolved = claim(values, aliases);
    if (field === "groupId") result.groupClaim = resolved.present;
    if (!resolved.valid || (field === "host" && resolved.value !== null && !TIMELINE_HOSTS.includes(resolved.value))
      || (field !== "timelineVisibility" && !validId(resolved.value))
      || (field === "timelineVisibility" && resolved.value !== null && resolved.value !== "private-verified")
      || (field === "enrollmentDigest" && resolved.value !== null && !/^[a-f0-9]{64}$/.test(resolved.value))) {
      result.valid = false;
      result.reason ||= "timeline-scope-conflict";
    }
    if (SCOPE_FIELDS.some(([name]) => name === field)) result.scope[field] = resolved.value;
    else result.request[field] = resolved.value;
  }
  return result;
}

// Direct stdio callers can bypass the MCP schema. Merge the flat and nested
// representations only when every present claim agrees. In particular, a
// nested group claim stays visible when a top-level argument tries to clear
// it with null, so no existing private permit crosses into a group turn.
export function timelineInvocationInput(args = {}) {
  return resolvedClaims(args);
}

export function timelineScope(args = {}) {
  return resolvedClaims(args).scope;
}

export function timelineToolKind(name) {
  const qualified = String(name || "");
  if (TIMELINE_TOOL_PREFIXES.some((prefix) => qualified === `${prefix}session_timeline_index`)) return "index";
  if (TIMELINE_TOOL_PREFIXES.some((prefix) => qualified === `${prefix}session_timeline_search`)) return "search";
  if (TIMELINE_TOOL_PREFIXES.some((prefix) => qualified === `${prefix}session_timeline_capture`)) return "capture";
  return null;
}

export function timelineInvocationRequest(tool, args, root) {
  const input = resolvedClaims(args);
  if (!input.valid || input.groupClaim || !input.request.sessionId) return null;
  const scope = input.scope;
  const request = { root, tool, sessionId: input.request.sessionId, entityId: scope.entityId, userId: scope.userId,
    tenantId: scope.tenantId, projectId: scope.projectId, groupId: scope.groupId, taskId: scope.currentTaskId,
    goalId: scope.goalId, goalStepId: scope.goalStepId, timelineVisibility: scope.timelineVisibility,
    portalRef: scope.portalRef, threadRef: scope.threadRef,
    enrollmentDigest: input.request.enrollmentDigest };
  if (tool === "index") return { ...request, maxBytes: args.maxBytes ?? 4 * 1024 * 1024 };
  return { ...request, ...(tool === "capture" ? { eventId: args.eventId ?? null,
    interpretation: args.interpretation ?? null } : {}),
    at: args.at ?? null, query: args.query ?? null,
    windowSeconds: args.windowSeconds === undefined ? 0 : args.windowSeconds,
    includePriorSessions: args.includePriorSessions === true,
    includePriorProviders: args.includePriorProviders === true };
}

const scopeProperties = {
  host: { enum: TIMELINE_HOSTS },
  entityId: stableId, userId: stableId, tenantId: stableId, projectId: stableId,
  taskId: stableId, goalId: optionalId, goalStepId: optionalId,
  portalRef: optionalId, threadRef: optionalId
};

export const sessionTimelineTools = [
  {
    name: "session_timeline_index",
    description: "Index bounded evidence from one explicitly enrolled immutable provider transcript snapshot. Claude, Codex and King use separate format adapters; changed sources require a renewed host receipt and this tool never copies a transcript or grants authority.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: [],
      properties: { root: { type: "string", minLength: 1 }, sessionId: stableId, ...scopeProperties,
        enrollmentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        timelineVisibility: { const: "private-verified" }, groupId: { anyOf: [stableId, { type: "null" }] },
        maxBytes: { type: "integer", minimum: 65536, maximum: 16777216 } }
    }
  },
  {
    name: "session_timeline_search",
    description: "Search one enrolled immutable same-task source for objective evidence or strict user corrections. Query 'user message' explicitly selects bounded native user-message candidates without interpreting them; add exact UTC time to narrow. No source text is indexed. Cross-provider recall requires opt-in; one source is opened and no authority is granted.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: [],
      anyOf: [{ required: ["at"] }, { required: ["query"] }],
      properties: { root: { type: "string", minLength: 1 }, sessionId: stableId, ...scopeProperties,
        enrollmentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        timelineVisibility: { const: "private-verified" }, groupId: { anyOf: [stableId, { type: "null" }] },
        at: { type: "string", format: "date-time" }, query: { type: "string", minLength: 3, maxLength: 512 },
        windowSeconds: { type: "integer", minimum: 0, maximum: 900 },
        includePriorSessions: { type: "boolean" }, includePriorProviders: { type: "boolean" } }
    }
  },
  {
    name: "session_timeline_capture",
    description: "Reopen one source-bound event. Objective fields become descriptive task state; strict prefixed corrections may replace the same-thread next step. Natural user messages remain uninterpreted beside their exact checkpoint. A second source-bound call may preserve one model interpretation as an unconfirmed proposal; it never changes continuation, proves completion or grants authority.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["eventId"],
      anyOf: [{ required: ["at"] }, { required: ["query"] }],
      properties: { root: { type: "string", minLength: 1 }, sessionId: stableId, ...scopeProperties,
        enrollmentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        timelineVisibility: { const: "private-verified" }, groupId: { anyOf: [stableId, { type: "null" }] },
        eventId: { type: "string", pattern: "^timeline-event:[a-f0-9]{32}$" },
        interpretation: { oneOf: [{
          type: "object", additionalProperties: false,
          required: ["schema", "feedbackAssertionId", "targetAssertionId", "kind",
            "proposedNextStepSummary", "clarificationQuestion"],
          properties: { schema: { const: TIMELINE_INTERPRETATION_SCHEMA },
            feedbackAssertionId: assertionId, targetAssertionId: assertionId,
            kind: { enum: [...INTERPRETATION_KINDS] },
            proposedNextStepSummary: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
            clarificationQuestion: { anyOf: [{ type: "string", minLength: 1, maxLength: 300 }, { type: "null" }] } }
        }, {
          type: "object", additionalProperties: false,
          required: ["schema", "feedbackAssertionIds", "targetAssertionId", "clarificationQuestion"],
          properties: { schema: { const: TIMELINE_CLARIFICATION_SCHEMA },
            feedbackAssertionIds: { type: "array", minItems: 2, maxItems: 3, uniqueItems: true,
              items: assertionId }, targetAssertionId: assertionId,
            clarificationQuestion: { type: "string", minLength: 1, maxLength: 300 } }
        }] },
        at: { type: "string", format: "date-time" }, query: { type: "string", minLength: 3, maxLength: 512 },
        windowSeconds: { type: "integer", minimum: 0, maximum: 900 },
        includePriorSessions: { type: "boolean" }, includePriorProviders: { type: "boolean" } }
    }
  }
];
