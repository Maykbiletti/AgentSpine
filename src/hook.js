#!/usr/bin/env node
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { recordAttentionEvent } from "./lib/attention.js";
import { scanAndSave } from "./lib/catalog.js";
import { loadGraph } from "./lib/graph.js";
import { canonicalPath, findProjectRoot } from "./lib/paths.js";
import { sessionBriefing } from "./lib/briefing.js";
import { captureContinuityPrompt, loadContinuity } from "./lib/continuity.js";
import {
  authorizeJobEffect, checkpointJobEffect, closeJobLease, resolveSessionJob, startOrResumeJob
} from "./lib/selfstarter.js";
import { isMainModule } from "./lib/runtime.js";

const MAX_STDIN_BYTES = 64 * 1024;
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);
const KNOWN_EVENTS = new Set([
  ...CONTEXT_EVENTS, "PreToolUse", "PostToolUse", "Stop", "SubagentStop"
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
    if (typeof input[key] === "string") return input[key];
  }
  return null;
}

function hostFromInput(input) {
  const explicit = input.host || input.provider || process.env.AGENTSPINE_HOST;
  if (["claude", "codex", "generic"].includes(explicit)) return explicit;
  if (process.env.CODEX_HOME) return "codex";
  return "claude";
}

async function runtimeScope(input, root) {
  const { continuity } = await loadContinuity(root);
  const supplied = input.agent_spine_scope && typeof input.agent_spine_scope === "object"
    ? input.agent_spine_scope : input;
  return {
    entityId: boundedId(supplied.entity_id ?? supplied.entityId ?? continuity.config.defaultEntityId, "entityId"),
    groupId: boundedId(supplied.group_id ?? supplied.groupId, "groupId"),
    projectId: boundedId(supplied.project_id ?? supplied.projectId ?? continuity.config.defaultProjectId, "projectId"),
    currentTaskId: boundedId(supplied.task_id ?? supplied.currentTaskId, "currentTaskId"),
    host: hostFromInput(input),
    config: continuity.config
  };
}

function renderContext(event, catalog, briefing, signal = null, attentionEvent = null, selfstarter = null) {
  const packet = {
    schema: "agentspine.hook-context/v1",
    event,
    priority: ["current-user-request", "explicit-stops", "current-task", "host-rules", "accepted-context", "style-and-relationships"],
    instruction: "Use this already-loaded briefing now. Do not call an MCP tool to obtain it. The current user request and explicit stops override all remembered style, relationships, and older context.",
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
    indexedSources: catalog.summary.total,
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

function hookDeliveryId(input) {
  return boundedId(input.tool_use_id ?? input.event_id ?? input.hook_event_id, "toolUseId");
}

function sessionId(input) {
  return boundedId(input.session_id ?? input.sessionId, "sessionId");
}

async function startSelfstarter(input, event, root, scope) {
  if (!SELFSTART_EVENTS.has(event)) return null;
  const requested = selfstarterInput(input);
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
    { kind: "promise", re: /^(?:i promise(?: to)?|i will|ich verspreche(?:,)?|ich werde)\s+(.+)$/i, prefix: "Promise: " },
    { kind: "blocker", re: /^(?:blocker|blocked(?: by)?|i am blocked(?: by)?|ich bin blockiert(?: durch)?|blockiert durch)\s*[:,-]?\s*(.+)$/i, prefix: "Blocker: " }
  ];
  for (const rule of rules) {
    const match = prompt.trim().match(rule.re);
    if (!match) continue;
    const value = match[1].trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").slice(0, 220);
    if (value) return { kind: rule.kind, summary: `${rule.prefix}${value}` };
  }
  return null;
}

async function captureAttentionLifecycle(input, event, root, scope) {
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
    observedAt: input.timestamp || new Date()
  });
}

function hookOutput(event, context) {
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

export async function runHook(payload = null) {
  const input = payload || await readStdin();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("hook input must be one JSON object");
  const event = input.hook_event_name || input.event_name || "";
  if (!KNOWN_EVENTS.has(event)) throw new Error(`unsupported hook event: ${event || "missing"}`);
  const cwd = await canonicalPath(input.cwd || process.cwd());
  const root = await findProjectRoot(cwd);
  const { catalog, catalogPath } = await scanAndSave(root);
  let scope = null;
  let selfstarter = null;

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
      scope ||= await runtimeScope(input, root);
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
    scope = await runtimeScope(input, root);
    attentionEvent = await captureAttentionLifecycle(input, event, root, scope);
  }

  if (event === "PostToolUse") {
    scope ||= await runtimeScope(input, root);
    const exact = await selfstarterScope(input, scope, root, "effect");
    if (exact) {
      selfstarter = await checkpointJobEffect({
        root, ...exact, toolName: input.tool_name, toolUseId: hookDeliveryId(input),
        success: toolSucceeded(input), result: toolResult(input), now: input.timestamp || new Date()
      });
    }
  }

  if (["Stop", "SubagentStop"].includes(event)) {
    scope ||= await runtimeScope(input, root);
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
    try {
      scope ||= await runtimeScope(input, root);
      selfstarter = await startSelfstarter(input, event, root, scope);
      if (selfstarter?.job && !scope.currentTaskId) scope.currentTaskId = selfstarter.job.taskId;
      if (event === "UserPromptSubmit") {
        const prompt = promptFromInput(input);
        try {
          attentionEvent = await captureAttentionLifecycle(input, event, root, scope);
        } catch (error) {
          attentionEvent = { event: null, duplicate: false, reason: `rejected:${error.message}` };
        }
        if (prompt !== null) {
          try {
            signal = await captureContinuityPrompt({
              root, prompt, entityId: scope.entityId, groupId: scope.groupId,
              projectId: scope.projectId,
              eventId: boundedId(input.event_id ?? input.hook_event_id, "eventId")
            });
          } catch (error) {
            signal = { captured: false, accepted: false, reason: `rejected:${error.message}` };
          }
        }
      }
      const briefing = await sessionBriefing({
        root, cwd, host: scope.host, entityId: scope.entityId, groupId: scope.groupId,
        projectId: scope.projectId, currentTaskId: scope.currentTaskId,
        includePrivate: Boolean(scope.entityId && !scope.groupId),
        focusActive: true, includeSourceContent: !scope.groupId,
        maxBytes: scope.config.maxBriefingBytes,
        now: input.timestamp || new Date(),
        catalog
      });
      const context = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter);
      if (payload) return { blocked: false, context, briefing, signal, attentionEvent, catalogPath };
      process.stdout.write(`${JSON.stringify(hookOutput(event, context))}\n`);
      return;
    } catch (error) {
      const context = JSON.stringify({
        schema: "agentspine.hook-context/v1", event, loaded: false, failedClosed: true,
        indexedSources: catalog.summary.total,
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
    process.exitCode = 1;
  });
}
