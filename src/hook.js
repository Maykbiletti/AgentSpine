#!/usr/bin/env node
import { isAbsolute, relative, resolve } from "node:path";
import { scanAndSave } from "./lib/catalog.js";
import { loadGraph } from "./lib/graph.js";
import { canonicalPath, findProjectRoot } from "./lib/paths.js";
import { sessionBriefing } from "./lib/briefing.js";
import { captureContinuityPrompt, loadContinuity } from "./lib/continuity.js";

const MAX_STDIN_BYTES = 64 * 1024;
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);
const KNOWN_EVENTS = new Set([
  ...CONTEXT_EVENTS, "PreToolUse", "PostToolUse", "Stop", "SubagentStop"
]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;

async function readStdin() {
  let value = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_STDIN_BYTES) throw new Error("hook input exceeds the 64 KiB limit");
    value += chunk;
  }
  return value.trim() ? JSON.parse(value) : {};
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

function renderContext(event, catalog, briefing, signal = null) {
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
    indexedSources: catalog.summary.total,
    briefing,
    authority: "context-only"
  };
  return JSON.stringify(packet);
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
  const event = input.hook_event_name || input.event_name || "";
  if (!KNOWN_EVENTS.has(event)) throw new Error(`unsupported hook event: ${event || "missing"}`);
  const cwd = await canonicalPath(input.cwd || process.cwd());
  const root = await findProjectRoot(cwd);
  const { catalog, catalogPath } = await scanAndSave(root);

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

  if (CONTEXT_EVENTS.has(event)) {
    let scope;
    let signal = null;
    try {
      scope = await runtimeScope(input, root);
      if (event === "UserPromptSubmit") {
        const prompt = promptFromInput(input);
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
        catalog
      });
      const context = renderContext(event, catalog, briefing, signal);
      if (payload) return { blocked: false, context, briefing, signal, catalogPath };
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

  if (payload) return { blocked: false };
  process.stdout.write("{}\n");
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runHook().catch((error) => {
    process.stderr.write(`AgentSpine hook: ${String(error.message).slice(0, 2048)}\n`);
    process.exitCode = 1;
  });
}
