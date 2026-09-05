import { createHash } from "node:crypto";
import { recordAttentionEvent } from "./attention.js";
import { catalogForStateRoot } from "./catalog.js";
import { claimChannelEvent } from "./channel-runtime.js";
import { loadContinuity } from "./continuity.js";
import { resolveSessionJob, startOrResumeJob } from "./selfstarter.js";

const STANDARD_HOST_CONTEXT_BYTES = 9500;
const MAX_CLAUDE_OVERFLOW_CONTEXT_BYTES = 32 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
export const ATTENTION_WRITE_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"]);
const SELFSTART_EVENTS = new Set(["SessionStart", "PostCompact"]);

export function boundedId(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function positiveInteger(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : (typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${field} is invalid`);
  return parsed;
}

export function promptFromInput(input) {
  for (const key of ["prompt", "user_prompt", "message", "input"]) {
    const value = input[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const text = value
        .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return null;
}

export function hostContextLimit(preflight) {
  return preflight?.receipt?.instructionBudget?.mode === "claude-required-overflow"
    ? MAX_CLAUDE_OVERFLOW_CONTEXT_BYTES
    : STANDARD_HOST_CONTEXT_BYTES;
}

export function hostFromInput(input) {
  const explicit = input.host || input.provider || process.env.AGENTSPINE_HOST;
  if (["claude", "codex", "generic"].includes(explicit)) return explicit;
  if ((typeof input.model === "string" && input.model.trim()) || process.env.PLUGIN_ROOT || process.env.CODEX_HOME
    || process.env.BLUN_PLUGIN_ROOT || process.env.BLUN_HOME) return "codex";
  return "claude";
}

export function gatewayEnvironmentContext(env = process.env) {
  if (env.AGENTSPINE_GATEWAY_CONTEXT !== "agentspine.gateway-start/v1") return null;
  return {
    host: boundedId(env.AGENTSPINE_HOST, "AGENTSPINE_HOST"),
    entityId: boundedId(env.AGENTSPINE_ENTITY_ID, "AGENTSPINE_ENTITY_ID"),
    groupId: boundedId(env.AGENTSPINE_GROUP_ID, "AGENTSPINE_GROUP_ID"),
    projectId: boundedId(env.AGENTSPINE_PROJECT_ID, "AGENTSPINE_PROJECT_ID"),
    taskId: boundedId(env.AGENTSPINE_TASK_ID, "AGENTSPINE_TASK_ID"),
    queueId: boundedId(env.AGENTSPINE_GATEWAY_QUEUE_ID, "AGENTSPINE_GATEWAY_QUEUE_ID"),
    goalId: boundedId(env.AGENTSPINE_GOAL_ID, "AGENTSPINE_GOAL_ID"),
    goalStepId: boundedId(env.AGENTSPINE_GOAL_STEP_ID, "AGENTSPINE_GOAL_STEP_ID"),
    planDefinitionsDigest: boundedId(env.AGENTSPINE_PLAN_DEFINITIONS_DIGEST,
      "AGENTSPINE_PLAN_DEFINITIONS_DIGEST"),
    gatewayAttempt: positiveInteger(env.AGENTSPINE_GATEWAY_ATTEMPT, "AGENTSPINE_GATEWAY_ATTEMPT"),
    eventId: boundedId(env.AGENTSPINE_CHANNEL_EVENT_ID, "AGENTSPINE_CHANNEL_EVENT_ID"),
    provider: boundedId(env.AGENTSPINE_CHANNEL_PROVIDER, "AGENTSPINE_CHANNEL_PROVIDER")
  };
}

function gatewayBound(gateway, key, suppliedValue, field, allowAbsent = false) {
  if (!gateway) return suppliedValue;
  const gatewayValue = gateway[key];
  if (gatewayValue === null || gatewayValue === undefined || gatewayValue === "") {
    if (allowAbsent) return suppliedValue;
    if (suppliedValue !== undefined && suppliedValue !== null && suppliedValue !== "") {
      throw new Error(`${field} does not match the authenticated gateway binding`);
    }
    return null;
  }
  if (suppliedValue !== undefined && suppliedValue !== null
    && suppliedValue !== "" && suppliedValue !== gatewayValue) {
    throw new Error(`${field} does not match the authenticated gateway binding`);
  }
  return gatewayValue;
}

export async function runtimeScope(input, root, userStateRoot = null, catalog) {
  const { continuity: projectContinuity } = await loadContinuity(root, catalog);
  const userCatalog = userStateRoot && userStateRoot !== root
    ? catalogForStateRoot(catalog, userStateRoot) : catalog;
  const userContinuity = userStateRoot && userStateRoot !== root
    ? (await loadContinuity(userStateRoot, userCatalog)).continuity
    : projectContinuity;
  const continuity = {
    config: {
      ...projectContinuity.config,
      enabled: userContinuity.config.enabled,
      minConfidence: userContinuity.config.minConfidence,
      minDirectness: userContinuity.config.minDirectness,
      minEvidence: userContinuity.config.minEvidence,
      maxPromptBytes: userContinuity.config.maxPromptBytes,
      maxBriefingBytes: userContinuity.config.maxBriefingBytes,
      defaultEntityId: userContinuity.config.defaultEntityId
    }
  };
  const supplied = input.agent_spine_scope && typeof input.agent_spine_scope === "object"
    ? input.agent_spine_scope : input;
  const gateway = gatewayEnvironmentContext();
  const suppliedAttempt = positiveInteger(supplied.gateway_attempt ?? supplied.gatewayAttempt,
    "gatewayAttempt");
  return {
    entityId: boundedId(gatewayBound(gateway, "entityId",
      supplied.entity_id ?? supplied.entityId, "entityId")
      ?? (gateway ? null : continuity.config.defaultEntityId), "entityId"),
    userId: boundedId(supplied.user_id ?? supplied.userId ?? process.env.AGENTSPINE_USER_ID, "userId"),
    tenantId: boundedId(supplied.tenant_id ?? supplied.tenantId ?? process.env.AGENTSPINE_TENANT_ID, "tenantId"),
    groupId: boundedId(gatewayBound(gateway, "groupId",
      supplied.group_id ?? supplied.groupId, "groupId"), "groupId"),
    projectId: boundedId(gatewayBound(gateway, "projectId",
      supplied.project_id ?? supplied.projectId, "projectId")
      ?? (gateway ? null : continuity.config.defaultProjectId), "projectId"),
    currentTaskId: boundedId(gatewayBound(gateway, "taskId",
      supplied.task_id ?? supplied.taskId ?? supplied.currentTaskId, "currentTaskId", true), "currentTaskId"),
    queueId: boundedId(gatewayBound(gateway, "queueId",
      supplied.queue_id ?? supplied.queueId, "queueId"), "queueId"),
    goalId: boundedId(gatewayBound(gateway, "goalId",
      supplied.goal_id ?? supplied.goalId, "goalId"), "goalId"),
    goalStepId: boundedId(gatewayBound(gateway, "goalStepId",
      supplied.goal_step_id ?? supplied.goalStepId, "goalStepId"), "goalStepId"),
    planDefinitionsDigest: boundedId(gatewayBound(gateway, "planDefinitionsDigest",
      supplied.plan_definitions_digest ?? supplied.planDefinitionsDigest,
      "planDefinitionsDigest"), "planDefinitionsDigest"),
    gatewayAttempt: gatewayBound(gateway, "gatewayAttempt", suppliedAttempt, "gatewayAttempt"),
    host: gateway
      ? gatewayBound(gateway, "host", input.host ?? input.provider, "host")
      : hostFromInput(input),
    config: continuity.config
  };
}

export function renderContext(event, catalog, briefing, signal = null, attentionEvent = null, selfstarter = null, channelEvent = null, sourceDiagnostics = null, preflight = null, lessonRecall = null) {
  const loaded = sourceDiagnostics?.status === "loaded";
  const packet = {
    schema: "agentspine.hook-context/v1",
    event,
    priority: ["current-user-request", "explicit-stops", "current-task", "host-rules", "accepted-context", "style-and-relationships"],
    loaded,
    instruction: loaded
      ? "Use this already-loaded briefing now. Do not call an MCP tool to obtain it. The current user request and explicit stops override all remembered style, relationships, and older context."
      : "No host-native source context was loaded. Do not claim personal continuity or recall succeeded. Continue under current native host rules and inspect sourceResolution.",
    signal: signal ? {
      captured: Boolean(signal.captured),
      accepted: Boolean(signal.accepted),
      duplicate: Boolean(signal.duplicate),
      kind: signal.kind || null,
      reason: signal.reason || null
    } : null,
    attentionEvent: attentionEvent ? {
      captured: Boolean(attentionEvent.event),
      duplicate: Boolean(attentionEvent.duplicate),
      id: attentionEvent.event?.id || null,
      kind: attentionEvent.event?.kind || null,
      status: attentionEvent.event?.status || null,
      reason: attentionEvent.reason || null
    } : null,
    selfstarter: selfstarter ? {
      active: Boolean(selfstarter.job),
      blocked: Boolean(selfstarter.blocked),
      action: selfstarter.action || null,
      reason: selfstarter.reason || null,
      jobId: selfstarter.job?.id || null,
      taskId: selfstarter.job?.taskId || null,
      actorId: selfstarter.job?.actorId || null,
      targetId: selfstarter.job?.targetId || null,
      projectId: selfstarter.job?.projectId || null,
      groupId: selfstarter.job?.groupId || null,
      checkpointSequence: selfstarter.job?.checkpoint?.sequence ?? null,
      capabilities: selfstarter.job?.capabilities || [],
      leaseExpiresAt: selfstarter.job?.lease?.expiresAt || null,
      receiptId: selfstarter.receipt?.id || null,
      instruction: selfstarter.job
        ? "Resume only this exact checkpointed job. Attach its job ID to every host tool event. Each effect is separately re-authorized by PreToolUse and checkpointed by PostToolUse. Stop immediately on any denial."
        : null,
      authority: selfstarter.job ? "explicit-local-execution-policy" : "execution-state-only"
    } : null,
    channelEvent: channelEvent?.event ? {
      active: true,
      eventId: channelEvent.event.eventId,
      bindingId: channelEvent.event.bindingId,
      provider: channelEvent.event.provider,
      chatId: channelEvent.event.chatId,
      threadId: channelEvent.event.threadId,
      senderId: channelEvent.event.senderId,
      replyTo: channelEvent.event.replyTo,
      agentId: channelEvent.event.agentId,
      projectId: channelEvent.event.projectId,
      groupId: channelEvent.event.groupId,
      sessionKey: channelEvent.event.sessionKey,
      text: channelEvent.event.text,
      leaseExpiresAt: channelEvent.event.lease?.expiresAt || null,
      receiptId: channelEvent.receipt?.id || null,
      instruction: "Answer this exact authenticated channel event in its bound chat and thread. Do not infer another recipient or route. Sending remains subject to the separate current channel policy and adapter receipt.",
      authority: "explicit-local-channel-policy"
    } : null,
    indexedSources: catalog.summary.total,
    sourceResolution: sourceDiagnostics,
    lessonRecall: lessonRecall?.status === "recalled" ? {
      status: "recalled", schema: lessonRecall.schema, receiptDigest: lessonRecall.receiptDigest,
      items: lessonRecall.items, omitted: lessonRecall.omitted,
      instruction: lessonRecall.instruction, authority: "context-only"
    } : lessonRecall?.status === "group-suppressed" ? {
      status: "group-suppressed", items: [], authority: "context-only"
    } : null,
    preflight: preflight ? {
      schema: preflight.receipt.schema,
      receiptId: preflight.receipt.id,
      promptDigest: preflight.receipt.promptDigest,
      briefingDigest: preflight.receipt.briefingDigest,
      createdAt: preflight.receipt.createdAt,
      expiresAt: preflight.receipt.expiresAt,
      policy: preflight.policy,
      learningApplications: preflight.learningApplications || null,
      pendingMustRemember: preflight.pendingMustRemember ? {
        id: preflight.pendingMustRemember.candidate?.id || null,
        status: preflight.pendingMustRemember.candidate?.status || (preflight.pendingMustRemember.rejected ? "rejected" : null),
        reason: preflight.pendingMustRemember.reason || null
      } : null,
      premortem: preflight.premortem ? {
        status: preflight.premortem.status,
        requirementId: preflight.premortem.requirementId || null,
        digest: preflight.premortem.requirement?.digest || null,
        registration: preflight.premortem.registration || null,
        instruction: preflight.premortem.instruction,
        authority: preflight.premortem.requirement?.authority || "context-only"
      } : null,
      briefing: preflight.briefing,
      instruction: "This exact turn passed the mandatory pre-answer gate. Apply the complete preflight briefing before answering.",
      authority: "preflight-proof-only"
    } : null,
    briefing,
    authority: "context-only"
  };
  return JSON.stringify(packet);
}

export function selfstarterInput(input) {
  const value = input.agent_spine_job;
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_spine_job must be one object");
  return value;
}

function channelEventInput(input) {
  const gateway = gatewayEnvironmentContext();
  const value = input.agent_spine_channel_event ?? (gateway?.eventId && gateway?.provider
    ? { event_id: gateway.eventId, provider: gateway.provider } : null);
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_spine_channel_event must be one object");
  const unknown = Object.keys(value).filter((key) => !["event_id", "eventId", "provider"].includes(key));
  if (unknown.length) throw new Error(`agent_spine_channel_event contains unknown field: ${unknown.sort()[0]}`);
  return value;
}

export function hookDeliveryId(input) {
  return boundedId(input.tool_use_id ?? input.event_id ?? input.hook_event_id, "toolUseId");
}

export function sessionId(input) {
  return boundedId(input.session_id ?? input.sessionId, "sessionId");
}

export function selfstarterRootSkipped(sourceDiagnostics) {
  return ["skipped-unmarked-home", "skipped-home-root", "skipped-profile-root"]
    .includes(sourceDiagnostics?.projectTreeScan);
}

export async function startSelfstarter(input, event, root, scope, sourceDiagnostics) {
  if (!SELFSTART_EVENTS.has(event)) return null;
  const requested = selfstarterInput(input);
  if (selfstarterRootSkipped(sourceDiagnostics)) {
    if (requested) throw new Error("self-starter cannot use a user home or host profile as its workspace root");
    return null;
  }
  const session = sessionId(input);
  if (!scope.entityId || !scope.projectId || !session) {
    if (requested) throw new Error("self-starter start requires an exact actor, project, and host session");
    return null;
  }
  return startOrResumeJob({
    root, actorId: scope.entityId, projectId: scope.projectId, groupId: scope.groupId,
    taskId: scope.currentTaskId, jobId: boundedId(requested?.job_id ?? requested?.jobId, "jobId"),
    host: scope.host, sessionId: session, now: input.timestamp || new Date()
  });
}

export async function startChannelEvent(input, event, root, scope, catalog) {
  const requested = channelEventInput(input);
  if (!requested) return null;
  if (event !== "SessionStart") throw new Error("channel event claims are accepted only at SessionStart");
  const session = sessionId(input);
  if (!scope.entityId || !scope.projectId || !session) {
    throw new Error("channel event start requires an exact agent, project, and host session");
  }
  const workerId = `channel-worker:${createHash("sha256").update(`${scope.host}\0${session}`).digest("hex").slice(0, 24)}`;
  const claim = await claimChannelEvent({
    root, eventId: boundedId(requested.event_id ?? requested.eventId, "channelEventId"),
    agentId: scope.entityId, projectId: scope.projectId, groupId: scope.groupId,
    provider: boundedId(requested.provider, "channelProvider"), workerId,
    now: input.timestamp || new Date(), catalog
  });
  if (!claim.event) throw new Error("the exact channel event is unavailable in this agent lane");
  return claim;
}

export async function selfstarterScope(input, scope, root, action) {
  const requested = selfstarterInput(input);
  const hostSession = sessionId(input);
  const supplied = {
    actorId: scope.entityId, projectId: scope.projectId, groupId: scope.groupId,
    taskId: scope.currentTaskId, host: scope.host, sessionId: hostSession
  };
  if (requested) return { ...supplied, jobId: boundedId(requested.job_id ?? requested.jobId, "jobId") };
  if (!hostSession) return null;
  return resolveSessionJob({ root, ...supplied, action, now: input.timestamp || new Date() });
}

export function toolSucceeded(input) {
  if (input.success === false || input.is_error === true || input.tool_error) return false;
  if (input.tool_result && typeof input.tool_result === "object" && input.tool_result.isError === true) return false;
  return true;
}

export function toolResult(input) {
  return input.tool_result ?? input.tool_response ?? input.result ?? (input.tool_error ? { failed: true } : null);
}

function eventReceipt(input, event, scope, discriminator = "lifecycle") {
  const supplied = input.event_id ?? input.hook_event_id ?? input.tool_use_id ?? input.session_id;
  if (typeof supplied === "string" && ID_RE.test(supplied)) {
    return `receipt:${createHash("sha256").update(`${event}\0${supplied}\0${discriminator}`).digest("hex").slice(0, 24)}`;
  }
  const material = [event, scope.host, scope.entityId, scope.projectId, scope.currentTaskId, discriminator].join("\0");
  return `receipt:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

function heartbeatReceipt(input, scope) {
  const at = new Date(input.timestamp || Date.now());
  if (!Number.isFinite(at.getTime())) throw new Error("heartbeat timestamp is invalid");
  const minute = at.toISOString().slice(0, 16);
  const material = [scope.host, scope.entityId, scope.groupId, scope.projectId, scope.currentTaskId, minute].join("\0");
  return `receipt:heartbeat:${createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}

function minimalAttentionSignal(prompt) {
  if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 16384) return null;
  const rules = [
    { kind: "promise", re: /^(?:i promise(?: to)?|i will|ich verspreche(?:,)?|ich werde|prometo(?: que)?|voy a|jag lovar att|jag kommer att)\s+(.+)$/i, prefix: "Promise: " },
    { kind: "blocker", re: /^(?:blocker|blocked(?: by)?|i am blocked(?: by)?|ich bin blockiert(?: durch)?|blockiert durch|bloquead[oa](?: por)?|estoy bloquead[oa](?: por)?|blockerad(?: av)?|jag är blockerad(?: av)?)\s*[:,-]?\s*(.+)$/i, prefix: "Blocker: " }
  ];
  for (const rule of rules) {
    const match = prompt.trim().match(rule.re);
    if (!match) continue;
    const value = match[1].trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").slice(0, 220);
    if (value) return { kind: rule.kind, summary: `${rule.prefix}${value}` };
  }
  return null;
}

export async function captureAttentionLifecycle(input, event, root, scope, catalog) {
  if (!ATTENTION_WRITE_EVENTS.has(event)) return null;
  const explicit = input.agent_spine_attention && typeof input.agent_spine_attention === "object"
    && !Array.isArray(input.agent_spine_attention) ? input.agent_spine_attention : null;
  let proposed = explicit;
  let automaticHeartbeat = false;
  if (!proposed && event === "UserPromptSubmit" && scope.config.enabled) {
    proposed = minimalAttentionSignal(promptFromInput(input));
    if (proposed && scope.groupId) return { event: null, duplicate: false, reason: "rejected:group conversation events are never learned automatically" };
  }
  if (!proposed && event === "PostToolUse" && scope.currentTaskId) {
    proposed = { kind: "heartbeat", summary: "Work heartbeat recorded.", status: "active" };
    automaticHeartbeat = true;
  }
  if (!proposed && ["Stop", "SubagentStop"].includes(event) && scope.currentTaskId) {
    proposed = { kind: "heartbeat", summary: "Work heartbeat recorded.", status: "stopped" };
  }
  if (!proposed) return null;
  if (event === "PostToolUse" && ![input.event_id, input.hook_event_id, input.tool_use_id].some((value) => typeof value === "string" && ID_RE.test(value))) {
    throw new Error("PostToolUse attention requires a stable host delivery ID");
  }
  if (!scope.entityId || !scope.projectId || !scope.currentTaskId) {
    if (explicit) throw new Error("lifecycle attention event is missing exact actor, project, or task scope");
    return { event: null, duplicate: false, reason: "missing-exact-scope" };
  }
  const privacy = proposed.privacy || "private";
  if (event === "UserPromptSubmit" && privacy === "group") {
    return { event: null, duplicate: false, reason: "rejected:group conversation events are never learned automatically" };
  }
  const discriminator = proposed.id || `${proposed.kind}:${proposed.status || ""}:${proposed.summary}`;
  return recordAttentionEvent({
    root,
    id: boundedId(proposed.id, "attentionEventId"),
    kind: proposed.kind,
    summary: proposed.summary,
    status: proposed.status || null,
    entityId: scope.entityId,
    groupId: privacy === "group" ? scope.groupId : null,
    projectId: scope.projectId,
    taskId: scope.currentTaskId,
    privacy,
    dueAt: proposed.due_at ?? proposed.dueAt ?? null,
    receiptId: automaticHeartbeat ? heartbeatReceipt(input, scope) : eventReceipt(input, event, scope, discriminator),
    host: scope.host,
    hookEvent: event,
    observedAt: input.timestamp || new Date(), catalog
  });
}
