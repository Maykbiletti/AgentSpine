import { isAbsolute, relative } from "node:path";
import { recordHookScanAudit } from "./hook-audit.js";

export function candidatePaths(value, output = []) {
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

export function isMutationTool(name = "") {
  return /(^|__)(apply_patch|edit|write|delete|move|rename|bash|exec_command|shell)(_|$)/i.test(name);
}

export function isScanFailOpenTool(name = "") {
  return /(^|__)(apply_patch|edit|write|bash|exec_command)(_|$)/i.test(name);
}

function filesystemScanError(error) {
  return Boolean(error && (error.code === "AGENTSPINE_SCAN_INCOMPLETE" || error.agentSpineScan === true));
}

export function hookScanFailureFailsOpen(error) {
  return filesystemScanError(error) || (["EPERM", "EACCES"].includes(error?.code)
    && ["opendir", "readdir", "scandir"].includes(error?.syscall));
}

export async function auditSkippedScans(input, phase, skipped = []) {
  const item = skipped[0];
  if (!item) return;
  await recordHookScanAudit({
    event: "PreToolUse", toolName: input.tool_name || null, phase,
    error: { code: item.code, message: `${item.code}: ${item.operation} skipped ${item.path}` },
    path: item.path, operation: item.operation, now: input.timestamp || new Date()
  });
}

export async function auditGuard(input, phase, result, once = false) {
  await recordHookScanAudit({
    event: input.hook_event_name || input.event_name || "unknown", toolName: input.tool_name || null,
    phase, error: { code: result.status || "GUARD_ERROR", message: result.reason || result.status },
    path: result.path || input.cwd || process.cwd(), operation: "verify",
    onceKey: once ? `${phase}\0${result.status}\0${result.path || input.cwd || ""}` : null,
    now: input.timestamp || new Date()
  });
}

async function allowScanFailure(input, phase, error) {
  const event = input.hook_event_name || input.event_name || "unknown";
  await recordHookScanAudit({
    event, toolName: input.tool_name || null, phase, error,
    path: error?.path || input.cwd || process.cwd(), now: input.timestamp || new Date()
  });
  return { blocked: false, scanFailedOpen: true, event, phase, error: error.message };
}

export async function finishScanFailure(input, payload, phase, error) {
  const allowed = await allowScanFailure(input, phase, error);
  if (payload) return allowed;
  process.stdout.write("{}\n");
  return undefined;
}

function stringValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringValues(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringValues(item, output));
  return output;
}

export function shellTargetsProtected(input, documents, cwd, root) {
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
