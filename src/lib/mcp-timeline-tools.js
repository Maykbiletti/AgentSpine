const stableId = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$"
};

const optionalId = { anyOf: [stableId, { type: "null" }] };

// Claude qualifies plugin MCP tools with the plugin and configured server
// names. This must stay exact: a foreign MCP server can expose an identically
// named tool but must never receive a timeline invocation permit.
export const AGENTSPINE_TIMELINE_TOOL_PREFIX = "mcp__plugin_agent-spine_agent-spine__";

const SCOPE_FIELDS = [
  ["entityId", ["entityId", "entity_id"]],
  ["userId", ["userId", "user_id"]],
  ["tenantId", ["tenantId", "tenant_id"]],
  ["projectId", ["projectId", "project_id"]],
  ["groupId", ["groupId", "group_id"]],
  ["currentTaskId", ["taskId", "task_id", "currentTaskId", "current_task_id"]],
  ["goalId", ["goalId", "goal_id"]],
  ["goalStepId", ["goalStepId", "goal_step_id"]],
  ["timelineVisibility", ["timelineVisibility", "timeline_visibility"]]
];

const REQUEST_FIELDS = [
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
    if (!resolved.valid || (field !== "timelineVisibility" && !validId(resolved.value))
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
  if (qualified === `${AGENTSPINE_TIMELINE_TOOL_PREFIX}session_timeline_index`) return "index";
  if (qualified === `${AGENTSPINE_TIMELINE_TOOL_PREFIX}session_timeline_search`) return "search";
  return null;
}

export function timelineInvocationRequest(tool, args, root) {
  const input = resolvedClaims(args);
  if (!input.valid || input.groupClaim || !input.request.sessionId) return null;
  const scope = input.scope;
  const request = { root, tool, sessionId: input.request.sessionId, entityId: scope.entityId, userId: scope.userId,
    tenantId: scope.tenantId, projectId: scope.projectId, groupId: scope.groupId, taskId: scope.currentTaskId,
    goalId: scope.goalId, goalStepId: scope.goalStepId, timelineVisibility: scope.timelineVisibility,
    enrollmentDigest: input.request.enrollmentDigest };
  if (tool === "index") return { ...request, maxBytes: args.maxBytes ?? 4 * 1024 * 1024 };
  return { ...request, at: args.at ?? null, query: args.query ?? null,
    windowSeconds: args.windowSeconds === undefined ? 0 : args.windowSeconds };
}

const scopeProperties = {
  entityId: stableId, userId: stableId, tenantId: stableId, projectId: stableId,
  taskId: stableId, goalId: optionalId, goalStepId: optionalId
};

export const sessionTimelineTools = [
  {
    name: "session_timeline_index",
    description: "Index bounded evidence from one explicitly enrolled immutable Claude transcript snapshot. The matching hook and locally bound transport supply the private binding; changed sources require a renewed host receipt and this tool never copies a transcript or grants authority.",
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
    description: "Search one explicitly enrolled immutable Claude transcript snapshot for redacted objective evidence by exact UTC time or at least two concrete terms. The matching hook and locally bound transport supply the private binding; it returns no raw transcript and never grants authority.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: [],
      anyOf: [{ required: ["at"] }, { required: ["query"] }],
      properties: { root: { type: "string", minLength: 1 }, sessionId: stableId, ...scopeProperties,
        enrollmentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        timelineVisibility: { const: "private-verified" }, groupId: { anyOf: [stableId, { type: "null" }] },
        at: { type: "string", format: "date-time" }, query: { type: "string", minLength: 3, maxLength: 512 },
        windowSeconds: { type: "integer", minimum: 0, maximum: 900 } }
    }
  }
];
