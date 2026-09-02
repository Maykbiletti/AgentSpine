import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateRoot } from "./paths.js";

export function hookScanAuditPath(env = process.env) {
  return join(stateRoot(env), "hook-scan-audit.jsonl");
}

export async function recordHookScanAudit({ event = "PreToolUse", toolName = null, phase, error = null,
  path = null, operation = null, now = new Date(), env = process.env }) {
  try {
    const target = hookScanAuditPath(env);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const record = {
      schema: "agentspine.hook-scan-audit/v1",
      at: new Date(now).toISOString(), event, toolName, phase,
      code: String(error?.code || "SCAN_ERROR").slice(0, 64),
      error: String(error?.message || error || "filesystem scan skipped").slice(0, 2048),
      path: String(path || error?.path || "unknown").slice(0, 4096),
      operation: operation || error?.syscall || null,
      decision: "allow",
      authority: "diagnostic-only"
    };
    await appendFile(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
