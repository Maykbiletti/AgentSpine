import { canonicalPath, isInside } from "./paths.js";
import { resolveHostSourceCatalog } from "./source-roots.js";
import { inspectPremortemState } from "./delivery-premortem.js";

const INTERNAL = new Set(["catalog", "userStateRoot", "sourceDiagnostics", "sourceRegistry",
  "env", "input", "memoryHooks", "resolvedSources"]);

export function rejectInternalSourceArguments(args) {
  for (const key of INTERNAL) {
    if (Object.hasOwn(args, key)) throw new Error(`unsupported internal source argument: ${key}`);
  }
}

export async function boundBriefingArguments(args) {
  rejectInternalSourceArguments(args);
  if (!args.requirementId) return args;
  const current = await inspectPremortemState({ root: args.root, requirementId: args.requirementId });
  if (current.blocked || current.status === "degraded" || !current.binding) {
    throw new Error("delivery source binding is unavailable; no briefing receipt issued");
  }
  const result = { ...args };
  for (const [key, field] of [["host", "host"], ["entityId", "entityId"],
    ["projectId", "projectId"], ["groupId", "groupId"], ["currentTaskId", "taskId"]]) {
    const expected = current.binding[field];
    if (Object.hasOwn(args, key) && args[key] !== expected) {
      throw new Error(`delivery source ${key} does not match its requirement`);
    }
    result[key] = expected;
  }
  return result;
}

export async function resolveMcpSources({ root, cwd = root,
  host = process.env.AGENTSPINE_HOST || "generic", entityId = null,
  groupId = null, projectId = null, currentTaskId = null, required = false }) {
  const canonicalRoot = await canonicalPath(root);
  const canonicalCwd = await canonicalPath(cwd);
  if (!isInside(canonicalRoot, canonicalCwd)) throw new Error("MCP cwd must remain inside its root");
  // Only the process environment and the locally read registry select sources.
  // No MCP-provided catalog, registry, profile, or state location enters here.
  const sources = await resolveHostSourceCatalog({ host, cwd: canonicalCwd,
    input: { agent_spine_scope: { entity_id: entityId, group_id: groupId,
      project_id: projectId, task_id: currentTaskId } } });
  if (sources.projectRoot !== canonicalRoot) {
    throw new Error("MCP root differs from the resolved host project root");
  }
  if (required && (sources.diagnostics.incomplete || sources.diagnostics.skipped.length)) {
    throw new Error("MCP source discovery is incomplete; no delivery receipt issued");
  }
  return sources;
}
