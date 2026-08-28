#!/usr/bin/env node
import { isAbsolute, relative, resolve } from "node:path";
import { scanAndSave } from "./lib/catalog.js";
import { loadGraph } from "./lib/graph.js";
import { canonicalPath, findProjectRoot } from "./lib/paths.js";
import { attentionContext } from "./lib/attention.js";
import { learningContext } from "./lib/learning.js";
import { taskContext } from "./lib/coordination.js";

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim() ? JSON.parse(value) : {};
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

  if (["SessionStart", "UserPromptSubmit", "PostCompact"].includes(event)) {
    let attentionNote = "";
    let learningNote = "";
    let coordinationNote = "";
    try {
      const attention = await attentionContext({ root, includePrivate: false, maxItems: 3, catalog });
      attentionNote = attention.items.length
        ? ` ${attention.items.length} shared attention cue(s) are due (${[...new Set(attention.items.map((item) => item.kind))].join(", ")}). Treat them as suggestions and inspect only after the current task allows.`
        : "";
    } catch {
      attentionNote = " Attention state needs review; run agentspine audit before using attention cues.";
    }
    try {
      const learned = await learningContext({ root, includePrivate: false, maxItems: 50, catalog });
      learningNote = learned.items.length
        ? ` ${learned.items.length} accepted learning item(s) are available (${[...new Set(learned.items.map((item) => item.kind))].join(", ")}); load only relevant items with learning_context.`
        : "";
    } catch {
      learningNote = " Learning state needs review; run agentspine audit before using learned context.";
    }
    try {
      const tasks = await taskContext({ root, includePrivate: false, includeClosed: false, maxItems: 50, catalog });
      coordinationNote = tasks.items.length
        ? ` ${tasks.items.length} shared coordination item(s) are open (${[...new Set(tasks.items.map((item) => item.kind))].join(", ")}); load relevant details with task_context and check delegation before acting for another entity.`
        : "";
    } catch {
      coordinationNote = " Coordination state needs review; run agentspine audit before using tasks or delegation decisions.";
    }
    const summary = `AgentSpine indexed ${catalog.summary.total} Markdown sources (${catalog.summary.protected} protected). Source files remain byte-for-byte untouched.${attentionNote}${learningNote}${coordinationNote} Catalog: ${catalogPath}`;
    if (payload) return { blocked: false, context: summary };
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: summary }
    })}\n`);
    return;
  }

  if (payload) return { blocked: false };
  process.stdout.write("{}\n");
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runHook().catch((error) => {
    process.stderr.write(`AgentSpine hook: ${error.message}\n`);
    process.exitCode = 1;
  });
}
