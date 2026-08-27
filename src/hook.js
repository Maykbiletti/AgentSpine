#!/usr/bin/env node
import { resolve } from "node:path";
import { scanAndSave } from "./lib/catalog.js";
import { loadGraph } from "./lib/graph.js";
import { findProjectRoot } from "./lib/paths.js";

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
  return /(^|__)(apply_patch|edit|write|delete|move|rename)(_|$)/i.test(name);
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
  const cwd = resolve(input.cwd || process.cwd());
  const root = await findProjectRoot(cwd);
  const { catalog, catalogPath } = await scanAndSave(root);

  if (event === "PreToolUse" && isMutationTool(input.tool_name)) {
    const { graph } = await loadGraph(root);
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
    const protectedPaths = new Set(catalog.documents
      .filter((doc) => protectedRelative.has(doc.relativePath))
      .map((doc) => resolve(doc.path)));
    const targets = candidatePaths(input.tool_input || input.tool_args).map((path) => resolve(cwd, path));
    const hit = targets.find((path) => protectedPaths.has(path));
    if (hit) {
      const relativePath = catalog.documents.find((doc) => resolve(doc.path) === hit)?.relativePath || hit;
      const reason = `AgentSpine protected source: ${relativePath}. Existing identity, rule, soul, and memory documents are read-only to agents.`;
      if (payload) return { blocked: true, reason };
      deny(reason);
      return;
    }
  }

  if (["SessionStart", "UserPromptSubmit", "PostCompact"].includes(event)) {
    const summary = `AgentSpine indexed ${catalog.summary.total} Markdown sources (${catalog.summary.protected} protected). Source files remain byte-for-byte untouched. Catalog: ${catalogPath}`;
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
