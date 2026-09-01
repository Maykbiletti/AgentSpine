#!/usr/bin/env node
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { recordAttentionEvent } from "./lib/attention.js";
import { catalogForStateRoot, saveCatalog } from "./lib/catalog.js";
import { loadGraph } from "./lib/graph.js";
import { canonicalPath } from "./lib/paths.js";
import { resolveHostSourceCatalog } from "./lib/source-roots.js";
import { sessionBriefing } from "./lib/briefing.js";
import { captureContinuityPrompt, loadContinuity } from "./lib/continuity.js";
import { recordLearningApplications } from "./lib/learning.js";
import {
  authorizeJobEffect, checkpointJobEffect, closeJobLease, resolveSessionJob, startOrResumeJob
} from "./lib/selfstarter.js";
import { claimChannelEvent } from "./lib/channel-runtime.js";
import { syncPersonaRosterFromEnvironment } from "./lib/persona-runtime.js";
import { captureMustRememberPrompt, recordPreflightFailure, runPreflight, verifyPreflightReceipt } from "./lib/preflight.js";
import { isMainModule } from "./lib/runtime.js";

const MAX_STDIN_BYTES = 64 * 1024;
const STANDARD_HOST_CONTEXT_BYTES = 9500;
const MAX_CLAUDE_OVERFLOW_CONTEXT_BYTES = 32 * 1024;
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);
const KNOWN_EVENTS = new Set([
  ...CONTEXT_EVENTS, "InstructionsLoaded", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"
]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const ATTENTION_WRITE_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"]);
const SELFSTART_EVENTS = new Set(["SessionStart", "PostCompact"]);

async function readStdin() {
  let value = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_STDIN_BYTES) throw new Error("hook input exceeds the 64 KiB limit");
    value += chunk;
  }
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hook input must be one JSON object");
  return parsed;
}

function boundedId(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function promptFromInput(input) {
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

function hostContextLimit(preflight) {
  return preflight?.receipt?.instructionBudget?.mode === "claude-required-overflow"
    ? MAX_CLAUDE_OVERFLOW_CONTEXT_BYTES
    : STANDARD_HOST_CONTEXT_BYTES;
}

function hostFromInput(input) {
  const explicit = input.host || input.provider || process.env.AGENTSPINE_HOST;
  if (["claude", "codex", "generic"].includes(explicit)) return explicit;
  if ((typeof input.model === "string" && input.model.trim()) || process.env.PLUGIN_ROOT || process.env.CODEX_HOME
    || process.env.BLUN_PLUGIN_ROOT || process.env.BLUN_HOME) return "codex";
  return "claude";
}

function gatewayEnvironmentContext(env = process.env) {
  if (env.AGENTSPINE_GATEWAY_CONTEXT !== "agentspine.gateway-start/v1") return null;
  return {
    entityId: boundedId(env.AGENTSPINE_ENTITY_ID, "AGENTSPINE_ENTITY_ID"),
    groupId: boundedId(env.AGENTSPINE_GROUP_ID, "AGENTSPINE_GROUP_ID"),
    projectId: boundedId(env.AGENTSPINE_PROJECT_ID, "AGENTSPINE_PROJECT_ID"),
    taskId: boundedId(env.AGENTSPINE_TASK_ID, "AGENTSPINE_TASK_ID"),
    eventId: boundedId(env.AGENTSPINE_CHANNEL_EVENT_ID, "AGENTSPINE_CHANNEL_EVENT_ID"),
    provider: boundedId(env.AGENTSPINE_CHANNEL_PROVIDER, "AGENTSPINE_CHANNEL_PROVIDER")
  };
}

async function runtimeScope(input, root, userStateRoot = null, catalog) {
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
  return {
    entityId: boundedId(supplied.entity_id ?? supplied.entityId ?? gateway?.entityId ?? continuity.config.defaultEntityId, "entityId"),
    userId: boundedId(supplied.user_id ?? supplied.userId ?? process.env.AGENTSPINE_USER_ID, "userId"),
    tenantId: boundedId(supplied.tenant_id ?? supplied.tenantId ?? process.env.AGENTSPINE_TENANT_ID, "tenantId"),
    groupId: boundedId(supplied.group_id ?? supplied.groupId ?? gateway?.groupId, "groupId"),
    projectId: boundedId(supplied.project_id ?? supplied.projectId ?? gateway?.projectId ?? continuity.config.defaultProjectId, "projectId"),
    currentTaskId: boundedId(supplied.task_id ?? supplied.currentTaskId ?? gateway?.taskId, "currentTaskId"),
    host: hostFromInput(input),
    config: continuity.config
  };
}

function renderContext(event, catalog, briefing, signal = null, attentionEvent = null, selfstarter = null, channelEvent = null, sourceDiagnostics = null, preflight = null) {
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
      briefing: preflight.briefing,
      instruction: "This exact turn passed the mandatory pre-answer gate. Apply the complete preflight briefing before answering.",
      authority: "preflight-proof-only"
    } : null,
    briefing,
    authority: "context-only"
  };
  return JSON.stringify(packet);
}

function selfstarterInput(input) {
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

function hookDeliveryId(input) {
  return boundedId(input.tool_use_id ?? input.event_id ?? input.hook_event_id, "toolUseId");
}

function sessionId(input) {
  return boundedId(input.session_id ?? input.sessionId, "sessionId");
}

async function startSelfstarter(input, event, root, scope, sourceDiagnostics) {
  if (!SELFSTART_EVENTS.has(event)) return null;
  const requested = selfstarterInput(input);
  if (["skipped-unmarked-home", "skipped-home-root"].includes(sourceDiagnostics?.projectTreeScan)) {
    if (requested) throw new Error("self-starter cannot use a user home as its workspace root");
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

async function startChannelEvent(input, event, root, scope, catalog) {
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

async function selfstarterScope(input, scope, root, action) {
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

function toolSucceeded(input) {
  if (input.success === false || input.is_error === true || input.tool_error) return false;
  if (input.tool_result && typeof input.tool_result === "object" && input.tool_result.isError === true) return false;
  return true;
}

function toolResult(input) {
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

async function captureAttentionLifecycle(input, event, root, scope, catalog) {
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

export function blunRuntimeContext(context) {
  const detailed = JSON.parse(context);
  const sourceResolution = detailed.sourceResolution ? {
    status: detailed.sourceResolution.status || null,
    reason: detailed.sourceResolution.reason || null
  } : null;
  const runtime = {
    schema: "agentspine.blun-runtime-context/v1",
    event: detailed.event,
    loaded: Boolean(detailed.loaded),
    failedClosed: detailed.failedClosed ? true : undefined,
    indexedSources: detailed.indexedSources || 0,
    sourceResolution,
    instruction: detailed.loaded
      ? "Detailed AgentSpine context is available on demand through session_briefing. Load it only when the current request needs continuity."
      : detailed.instruction,
    authority: "context-only"
  };
  if (detailed.signal && (detailed.signal.captured || detailed.signal.accepted || detailed.signal.reason)) {
    runtime.signal = detailed.signal;
  }
  if (detailed.attentionEvent
    && (detailed.attentionEvent.captured || detailed.attentionEvent.duplicate || detailed.attentionEvent.reason)) {
    runtime.attentionEvent = detailed.attentionEvent;
  }
  if (detailed.selfstarter && (detailed.selfstarter.active || detailed.selfstarter.blocked)) {
    runtime.selfstarter = detailed.selfstarter;
  }
  if (detailed.channelEvent?.active) runtime.channelEvent = detailed.channelEvent;
  return JSON.stringify(runtime);
}

export function blunRuntimeMessage(context) {
  const runtime = JSON.parse(blunRuntimeContext(context));
  const base = runtime.loaded
    ? `AgentSpine ready: ${runtime.indexedSources} sources indexed. Load detailed continuity only on demand through session_briefing.`
    : `AgentSpine unavailable${runtime.sourceResolution?.reason ? `: ${runtime.sourceResolution.reason}` : ""}. ${runtime.instruction}`;
  const active = {};
  if (runtime.signal && (runtime.signal.captured || runtime.signal.accepted
    || String(runtime.signal.reason || "").startsWith("rejected:"))) {
    active.signal = runtime.signal;
  }
  if (runtime.attentionEvent && (runtime.attentionEvent.captured || runtime.attentionEvent.duplicate
    || String(runtime.attentionEvent.reason || "").startsWith("rejected:"))) {
    active.attentionEvent = runtime.attentionEvent;
  }
  if (runtime.selfstarter) active.selfstarter = runtime.selfstarter;
  if (runtime.channelEvent) active.channelEvent = runtime.channelEvent;
  return Object.keys(active).length === 0
    ? base
    : `${base}\nActive AgentSpine runtime data: ${JSON.stringify(active)}`;
}

function hookOutput(event, context) {
  if (process.env.BLUN_PLUGIN_ROOT) {
    return { hookSpecificOutput: { hookEventName: event, message: blunRuntimeMessage(context) } };
  }
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

function candidatePaths(value, output = []) {
  if (!value) return output;
  if (typeof value === "string") {
    for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) output.push(match[1].trim());
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) candidatePaths(item, output);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (["path", "file_path", "target_file", "filename"].includes(key) && typeof item === "string") output.push(item);
    else candidatePaths(item, output);
  }
  return output;
}

function isMutationTool(name = "") {
  return /(^|__)(apply_patch|edit|write|delete|move|rename|bash|exec_command|shell)(_|$)/i.test(name);
}

function stringValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringValues(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringValues(item, output));
  return output;
}

function shellTargetsProtected(input, documents, cwd, root) {
  if (!/(bash|exec_command|shell)/i.test(input.tool_name || "")) return null;
  const command = stringValues(input.tool_input || input.tool_args).join("\n").replaceAll("\\", "/");
  if (!/(?:^|[;&|\s])(?:rm|mv|cp|truncate|tee|sed\s+-i|perl\s+-i)\b|(?:^|[^>])>{1,2}(?!>)/i.test(command)) return null;
  for (const document of documents) {
    const forms = new Set([document.path.replaceAll("\\", "/"), document.relativePath]);
    for (const base of [cwd, root]) {
      const candidate = relative(base, document.path);
      if (candidate && !candidate.startsWith("..") && !isAbsolute(candidate)) forms.add(candidate.replaceAll("\\", "/"));
    }
    if ([...forms].some((form) => form && command.includes(form))) return document;
  }
  return null;
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  })}\n`);
}

function blockPrompt(reason) {
  process.stdout.write(`${JSON.stringify({
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", decision: "block", reason }
  })}\n`);
}

export async function runHook(payload = null) {
  const input = payload || await readStdin();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("hook input must be one JSON object");
  const event = input.hook_event_name || input.event_name || "";
  if (!KNOWN_EVENTS.has(event)) throw new Error(`unsupported hook event: ${event || "missing"}`);
  if (event === "InstructionsLoaded") {
    const file = input.file_path;
    if (typeof file !== "string" || !file || !["User", "Project", "Local", "Managed"].includes(input.memory_type)
      || !["session_start", "nested_traversal", "path_glob_match", "include", "compact"].includes(input.load_reason)) {
      throw new Error("InstructionsLoaded payload is invalid");
    }
    if (payload) return { blocked: false, observed: true };
    process.stdout.write("{}\n");
    return;
  }
  const cwd = await canonicalPath(input.cwd || process.cwd());
  const host = hostFromInput(input);
  const instructionHost = host === "generic" ? input.instruction_host : host;
  if (host === "generic" && !["claude", "codex"].includes(instructionHost)) {
    const reason = "AgentSpine generic hosts must bind instruction_host to claude or codex";
    if (event === "UserPromptSubmit") {
      if (payload) return { blocked: true, failedClosed: true, reason };
      blockPrompt(reason);
      return;
    }
    throw new Error(reason);
  }
  let resolvedSources;
  try {
    resolvedSources = await resolveHostSourceCatalog({ host: instructionHost, cwd, input });
  } catch (error) {
    const reason = `AgentSpine source resolution failed closed: ${error.message}`;
    if (event === "PreToolUse" && isMutationTool(input.tool_name)) {
      if (payload) return { blocked: true, failedClosed: true, reason };
      deny(reason);
      return;
    }
    if (event === "UserPromptSubmit") {
      if (payload) return { blocked: true, failedClosed: true, reason };
      blockPrompt(reason);
      return;
    }
    const context = JSON.stringify({
      schema: "agentspine.hook-context/v1", event, loaded: false, failedClosed: true,
      indexedSources: 0, sourceResolution: { status: "failed-closed", reason: error.message },
      instruction: "Do not claim AgentSpine recall succeeded. Continue under current native host rules; no remembered context or automatic effect was applied.",
      authority: "context-only"
    });
    if (payload) return { blocked: false, failedClosed: true, context, error: error.message };
    if (CONTEXT_EVENTS.has(event)) process.stdout.write(`${JSON.stringify(hookOutput(event, context))}\n`);
    else process.stdout.write("{}\n");
    return;
  }
  const root = resolvedSources.projectRoot;
  const catalog = resolvedSources.catalog;
  const catalogPath = await saveCatalog(catalog);
  let scope = null;
  let selfstarter = null;
  let channelEvent = null;

  if (event === "PreToolUse" && isMutationTool(input.tool_name)) {
    const { graph } = await loadGraph(root, catalog);
    const inferredProtected = new Set(graph.annotations
      .filter((annotation) => ["constitution", "soul", "memory-index", "memory-fact"].includes(annotation.layer))
      .map((annotation) => annotation.path));
    const protectedRelative = new Set(catalog.documents
      .filter((doc) => doc.protected || inferredProtected.has(doc.relativePath))
      .map((doc) => doc.relativePath));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const edge of graph.edges) {
        if (protectedRelative.has(edge.from) && !protectedRelative.has(edge.to)) {
          protectedRelative.add(edge.to);
          expanded = true;
        }
      }
    }
    const protectedDocuments = catalog.documents.filter((doc) => protectedRelative.has(doc.relativePath));
    const protectedPaths = new Set(protectedDocuments.map((doc) => resolve(doc.path)));
    const targets = await Promise.all(candidatePaths(input.tool_input || input.tool_args).map(async (path) => {
      const target = resolve(cwd, path);
      try { return await canonicalPath(target); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return target;
      }
    }));
    const hit = targets.find((path) => protectedPaths.has(path));
    const shellHit = shellTargetsProtected(input, protectedDocuments, cwd, root);
    if (hit || shellHit) {
      const relativePath = shellHit?.relativePath || catalog.documents.find((doc) => resolve(doc.path) === hit)?.relativePath || hit;
      const reason = `AgentSpine protected source: ${relativePath}. Existing identity, rule, soul, and memory documents are read-only to agents.`;
      if (payload) return { blocked: true, reason };
      deny(reason);
      return;
    }
  }

  if (event === "PreToolUse") {
    try {
      scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
      const exact = await selfstarterScope(input, scope, root, "effect");
      if (exact) {
        selfstarter = await authorizeJobEffect({
          root, ...exact, toolName: input.tool_name, toolUseId: hookDeliveryId(input),
          now: input.timestamp || new Date()
        });
      }
    } catch (error) {
      const reason = `AgentSpine self-starter denied this effect: ${error.message}`;
      if (payload) return { blocked: true, reason, selfstarter: { allowed: false, reason: error.message } };
      deny(reason);
      return;
    }
  }

  let attentionEvent = null;
  if (ATTENTION_WRITE_EVENTS.has(event) && !CONTEXT_EVENTS.has(event)) {
    scope = await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    attentionEvent = await captureAttentionLifecycle(input, event, root, scope, catalog);
  }

  if (event === "PostToolUse") {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    const exact = await selfstarterScope(input, scope, root, "effect");
    if (exact) {
      selfstarter = await checkpointJobEffect({
        root, ...exact, toolName: input.tool_name, toolUseId: hookDeliveryId(input),
        success: toolSucceeded(input), result: toolResult(input), now: input.timestamp || new Date()
      });
    }
  }

  if (["Stop", "SubagentStop"].includes(event)) {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    const exact = await selfstarterScope(input, scope, root, "resume");
    const requested = selfstarterInput(input);
    if (exact) {
      selfstarter = await closeJobLease({
        root, ...exact, status: requested?.status || "waiting", now: input.timestamp || new Date()
      });
    }
  }

  if (CONTEXT_EVENTS.has(event)) {
    let signal = null;
    let preflight = null;
    try {
      await syncPersonaRosterFromEnvironment({ root, env: process.env, now: input.timestamp || new Date(), catalog });
      scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
      channelEvent = await startChannelEvent(input, event, root, scope, catalog);
      selfstarter = await startSelfstarter(input, event, root, scope, resolvedSources.diagnostics);
      if (selfstarter?.job && !scope.currentTaskId) scope.currentTaskId = selfstarter.job.taskId;
      if (event === "UserPromptSubmit") {
        const prompt = promptFromInput(input);
        if (prompt === null) throw new Error("mandatory preflight requires the exact current prompt");
        preflight = await runPreflight({
          input, scope, resolvedSources, prompt, now: input.timestamp || new Date(), env: process.env
        });
        if (!await verifyPreflightReceipt({
          receipt: preflight.receipt, input, scope, resolvedSources, prompt,
          now: input.timestamp || new Date(), env: process.env
        })) throw new Error("newly created preflight receipt failed exact turn verification");
        preflight.pendingMustRemember = await captureMustRememberPrompt({ prompt, receipt: preflight.receipt, env: process.env });
        try {
          attentionEvent = await captureAttentionLifecycle(input, event, root, scope, catalog);
        } catch (error) {
          attentionEvent = { event: null, duplicate: false, reason: `rejected:${error.message}` };
        }
        if (prompt !== null) {
          try {
            signal = await captureContinuityPrompt({
              root, prompt, entityId: scope.entityId, groupId: scope.groupId,
              projectId: scope.projectId, userStateRoot: resolvedSources.userStateRoot,
              eventId: boundedId(input.event_id ?? input.hook_event_id, "eventId"), catalog,
              userCatalog: resolvedSources.userStateRoot && resolvedSources.userStateRoot !== root
                ? catalogForStateRoot(catalog, resolvedSources.userStateRoot) : catalog
            });
          } catch (error) {
            signal = { captured: false, accepted: false, reason: `rejected:${error.message}` };
          }
        }
      }
      const briefing = await sessionBriefing({
        root, cwd, host: scope.host, entityId: scope.entityId, groupId: scope.groupId,
        userId: scope.userId, tenantId: scope.tenantId, projectId: scope.projectId, currentTaskId: scope.currentTaskId,
        includePrivate: Boolean(scope.entityId && !scope.groupId),
        focusActive: true, includeSourceContent: event === "UserPromptSubmit" ? false : !scope.groupId,
        maxBytes: event === "UserPromptSubmit" ? 4096 : scope.config.maxBriefingBytes,
        now: input.timestamp || new Date(),
        catalog, userStateRoot: resolvedSources.userStateRoot, sourceDiagnostics: resolvedSources.diagnostics,
        prompt: event === "UserPromptSubmit" ? promptFromInput(input) : null
      });
      let context = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent, resolvedSources.diagnostics, preflight);
      if (event === "UserPromptSubmit" && Buffer.byteLength(context) > hostContextLimit(preflight)) {
        throw new Error("mandatory preflight context exceeds the host hook injection limit");
      }
      if (event === "UserPromptSubmit" && !await verifyPreflightReceipt({
        receipt: preflight.receipt, input, scope, resolvedSources, prompt: promptFromInput(input),
        now: input.timestamp || new Date(), env: process.env, consume: true
      })) throw new Error("preflight receipt could not be consumed atomically for this exact turn");
      if (event === "UserPromptSubmit") {
        const activeCanaries = briefing.learning.filter((item) => item.outcomeStatus === "active");
        if (!activeCanaries.length) {
          preflight.learningApplications = {
            status: "not-applicable", receipts: [], authority: "context-only"
          };
        } else try {
          const application = await recordLearningApplications({
            root, items: briefing.learning,
            scope: {
              personaId: scope.entityId, userId: scope.userId, tenantId: scope.tenantId,
              projectId: scope.projectId, groupId: scope.groupId, taskId: scope.currentTaskId
            },
            preflightReceipt: preflight.receipt,
            sessionBriefingDigest: createHash("sha256").update(JSON.stringify(briefing)).digest("hex"),
            projectedAt: input.timestamp || new Date()
          });
          preflight.learningApplications = {
            status: application.receipts.length ? "recorded" : "not-applicable",
            receipts: application.receipts.map((item) => ({
              id: item.id, learningId: item.learningId, projectedAt: item.projectedAt, expiresAt: item.expiresAt
            })),
            authority: "context-only"
          };
        } catch (error) {
          briefing.learning = briefing.learning.filter((item) => item.outcomeStatus !== "active");
          preflight.learningApplications = {
            status: "degraded", receipts: [], reason: error.message, authority: "context-only"
          };
        }
        const enriched = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent,
          resolvedSources.diagnostics, preflight);
        if (Buffer.byteLength(enriched) <= hostContextLimit(preflight)) context = enriched;
        else if (preflight.learningApplications.status === "degraded") {
          preflight.learningApplications = null;
          context = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent,
            resolvedSources.diagnostics, preflight);
        }
      }
      if (payload) return { blocked: false, context, briefing, preflight, signal, attentionEvent, channelEvent, catalogPath };
      process.stdout.write(`${JSON.stringify(hookOutput(event, context))}\n`);
      return;
    } catch (error) {
      if (event === "UserPromptSubmit") {
        await recordPreflightFailure({ receiptId: preflight?.receipt?.id || null, input, host,
          error, now: input.timestamp || new Date(), env: process.env }).catch(() => {});
        const reason = `AgentSpine pre-answer preflight blocked this turn: ${error.message}`;
        if (payload) return { blocked: true, failedClosed: true, reason, error: error.message, catalogPath };
        blockPrompt(reason);
        return;
      }
      const context = JSON.stringify({
        schema: "agentspine.hook-context/v1", event, loaded: false, failedClosed: true,
        indexedSources: catalog.summary.total,
        sourceResolution: resolvedSources.diagnostics,
        error: error.message,
        instruction: "Do not claim AgentSpine recall succeeded. Continue with the current request under native host rules and run agentspine audit before using remembered context.",
        authority: "context-only"
      });
      if (payload) return { blocked: false, failedClosed: true, context, error: error.message, catalogPath };
      process.stdout.write(`${JSON.stringify(hookOutput(event, context))}\n`);
      return;
    }
  }

  if (payload) return { blocked: false, attentionEvent, selfstarter };
  process.stdout.write("{}\n");
}

if (isMainModule(import.meta.url)) {
  runHook().catch((error) => {
    process.stderr.write(`AgentSpine hook: ${String(error.message).slice(0, 2048)}\n`);
    // Claude command hooks treat exit 2 as a blocking failure. Exit 1 is
    // fail-open, which is unsafe for malformed pre-answer payloads.
    process.exitCode = 2;
  });
}
