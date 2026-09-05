import { canonicalPath } from "./paths.js";
import { resolveHostSourceCatalog } from "./source-roots.js";
import { authorizeSessionTimelineInvocation } from "./session-timeline.js";
import { timelineInvocationRequest, timelineToolKind } from "./mcp-timeline-tools.js";
import { gatewayEnvironmentContext, hookDeliveryId, hostFromInput, sessionId } from "./hook-context.js";
import { blockedHookOutput } from "./hook-output.js";
import { sessionTimelineBinding } from "./session-timeline-contract.js";
import { resolvePrivateSessionTimelineEnrollment } from "./session-timeline-enrollment.js";
import { timelineTransportDigest } from "./session-timeline-transport.js";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function absent(value) { return value === undefined || value === null || value === ""; }

function rawGroupClaim(input, gateway) {
  const nested = plainObject(input?.agent_spine_scope) ? input.agent_spine_scope : null;
  return !absent(process.env.AGENTSPINE_GROUP_ID) || !absent(gateway?.groupId)
    || !absent(input?.group_id ?? input?.groupId)
    || !absent(nested?.group_id ?? nested?.groupId);
}

function gatewayMatchesEnrollment(gateway, binding) {
  if (!gateway) return true;
  if (!absent(gateway.groupId)) return false;
  const fields = [
    ["host", "host"], ["entityId", "entityId"], ["projectId", "projectId"],
    ["taskId", "taskId"], ["goalId", "goalId"], ["goalStepId", "goalStepId"]
  ];
  return fields.every(([gatewayField, bindingField]) => gateway[gatewayField] === binding[bindingField])
    && process.env.AGENTSPINE_USER_ID === binding.userId && process.env.AGENTSPINE_TENANT_ID === binding.tenantId;
}

function bindingScope(binding, enrollment) {
  return { entityId: binding.entityId, userId: binding.userId, tenantId: binding.tenantId,
    projectId: binding.projectId, groupId: null, currentTaskId: binding.taskId,
    goalId: binding.goalId, goalStepId: binding.goalStepId,
    timelineVisibility: enrollment.timelineVisibility };
}

function nestedScope(args) {
  return plainObject(args?.agent_spine_scope) ? args.agent_spine_scope : null;
}

function validNestedScope(args) {
  return args?.agent_spine_scope === undefined || args.agent_spine_scope === null || plainObject(args.agent_spine_scope);
}

function scopeValues(args, keys) {
  const nested = nestedScope(args);
  return keys.flatMap((key) => [args?.[key], nested?.[key]]);
}

function scopeClaimsMatch(args, keys, expected) {
  return scopeValues(args, keys).every((value) => absent(value) || value === expected);
}

function noScopeClaims(args, keys) {
  return scopeValues(args, keys).every(absent);
}

function matchesScopeBinding(args, binding) {
  return validNestedScope(args)
    && scopeClaimsMatch(args, ["sessionId", "session_id"], binding.sessionId)
    && scopeClaimsMatch(args, ["entityId", "entity_id"], binding.entityId)
    && scopeClaimsMatch(args, ["userId", "user_id"], binding.userId)
    && scopeClaimsMatch(args, ["tenantId", "tenant_id"], binding.tenantId)
    && scopeClaimsMatch(args, ["projectId", "project_id"], binding.projectId)
    && scopeClaimsMatch(args, ["taskId", "task_id", "currentTaskId", "current_task_id"], binding.taskId)
    && scopeClaimsMatch(args, ["goalId", "goal_id"], binding.goalId)
    && scopeClaimsMatch(args, ["goalStepId", "goal_step_id"], binding.goalStepId)
    && noScopeClaims(args, ["groupId", "group_id"]);
}

function matchesBinding(args, binding) {
  return matchesScopeBinding(args, binding)
    && noScopeClaims(args, ["accessProof", "access_proof", "invocationPermit", "invocation_permit",
      "transportDigest", "transport_digest", "timelineVisibility", "timeline_visibility",
      "enrollmentDigest", "enrollment_digest"]);
}

function matchesHostBinding(input, binding) {
  return matchesScopeBinding(input, binding)
    && scopeClaimsMatch(input, ["host", "provider"], binding.host)
    && noScopeClaims(input, ["accessProof", "access_proof", "invocationPermit", "invocation_permit",
      "transportDigest", "transport_digest", "enrollmentDigest", "enrollment_digest"]);
}

function claimedScope(input) {
  const claim = (keys) => {
    const values = scopeValues(input, keys).filter((value) => !absent(value));
    return values.length && values.every((value) => value === values[0]) ? values[0] : null;
  };
  return {
    entityId: claim(["entityId", "entity_id"]), userId: claim(["userId", "user_id"]),
    tenantId: claim(["tenantId", "tenant_id"]), projectId: claim(["projectId", "project_id"]),
    groupId: claim(["groupId", "group_id"]), currentTaskId: claim(["taskId", "task_id", "currentTaskId", "current_task_id"]),
    goalId: claim(["goalId", "goal_id"]), goalStepId: claim(["goalStepId", "goal_step_id"])
  };
}

async function matchesRoot(value, root) {
  if (absent(value)) return true;
  if (typeof value !== "string") return false;
  try { return await canonicalPath(value) === root; }
  catch { return false; }
}

function requestInput(tool, args) {
  if (tool === "index") return args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes };
  if (args.at === undefined && args.query === undefined) return null;
  return { ...(args.at === undefined ? {} : { at: args.at }), ...(args.query === undefined ? {} : { query: args.query }),
    ...(args.windowSeconds === undefined ? {} : { windowSeconds: args.windowSeconds }) };
}

function denied(reason) {
  return { blocked: true, reason, hostOutput: blockedHookOutput("PreToolUse", reason) };
}

function allowed(updatedInput) {
  return {
    blocked: false,
    updatedInput,
    hostOutput: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "AgentSpine binds this one context-only timeline lookup to the current Claude session and local transport.",
        updatedInput
      }
    }
  };
}

export async function runTimelineToolGuard(input) {
  try {
    const tool = timelineToolKind(input?.tool_name);
    if (input?.hook_event_name !== "PreToolUse" || !tool || hostFromInput(input) !== "claude" || !plainObject(input.tool_input)) {
      return denied("AgentSpine session timeline requires a verified Claude PreToolUse payload.");
    }
    const resolved = await resolveHostSourceCatalog({ host: "claude", cwd: input.cwd || process.cwd(), input });
    const root = resolved.projectRoot;
    const hostSession = sessionId(input);
    const gateway = gatewayEnvironmentContext();
    if (rawGroupClaim(input, gateway)) return denied("AgentSpine session timeline is unavailable for group-scoped activity.");
    const provisionalBinding = sessionTimelineBinding({ host: "claude", sessionId: hostSession, scope: claimedScope(input) });
    const transportDigest = timelineTransportDigest({ root, binding: provisionalBinding });
    if (!transportDigest) {
      return denied("AgentSpine session timeline requires a locally configured per-session transport capability.");
    }
    const enrollment = await resolvePrivateSessionTimelineEnrollment({ root, host: "claude", sessionId: hostSession,
      transcriptPath: input.transcript_path ?? input.transcriptPath, hostHome: resolved.hostHome,
      expectedTransportDigest: transportDigest });
    if (enrollment.status !== "enrolled") {
      return denied("AgentSpine session timeline has no active private local enrollment for this host session.");
    }
    if (!gatewayMatchesEnrollment(gateway, enrollment.binding) || !matchesHostBinding(input, enrollment.binding)) {
      return denied("AgentSpine session timeline binding does not match the authenticated gateway scope.");
    }
    if (!await matchesRoot(input.tool_input.root, root) || !matchesBinding(input.tool_input, enrollment.binding)) {
      return denied("AgentSpine session timeline binding does not match this host session and scope.");
    }
    const scope = bindingScope(enrollment.binding, enrollment);
    const requestFields = requestInput(tool, input.tool_input);
    if (!requestFields) return denied("AgentSpine session timeline search needs an exact time or a concrete query.");
    const updatedInput = { ...requestFields, root, sessionId: enrollment.binding.sessionId,
      entityId: enrollment.binding.entityId, userId: enrollment.binding.userId, tenantId: enrollment.binding.tenantId,
      projectId: enrollment.binding.projectId, taskId: enrollment.binding.taskId, groupId: null,
      goalId: enrollment.binding.goalId, goalStepId: enrollment.binding.goalStepId,
      timelineVisibility: enrollment.timelineVisibility, enrollmentDigest: enrollment.enrollmentDigest };
    const request = timelineInvocationRequest(tool, updatedInput, root);
    const authorization = await authorizeSessionTimelineInvocation({
      root, host: "claude", sessionId: hostSession, scope, hostHome: resolved.hostHome,
      tool, request, toolUseId: hookDeliveryId(input), transportDigest, enrollmentDigest: enrollment.enrollmentDigest
    });
    if (!authorization) return denied("AgentSpine session timeline invocation is unavailable for this bound source.");
    return allowed(updatedInput);
  } catch {
    return denied("AgentSpine session timeline invocation is unavailable for this bound source.");
  }
}

export function emitTimelineToolGuard(result) {
  process.stdout.write(`${JSON.stringify(result.hostOutput)}\n`);
}
