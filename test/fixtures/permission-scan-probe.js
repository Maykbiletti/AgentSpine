import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runHook } from "../../src/hook.js";
import { hookScanAuditPath } from "../../src/lib/hook-audit.js";
import { workspaceFingerprint } from "../../src/lib/selfstarter.js";
import { resolveHostSourceCatalog } from "../../src/lib/source-roots.js";

const root = await realpath(resolve(process.argv[2]));
const resolved = await resolveHostSourceCatalog({ host: "codex", cwd: root, env: process.env });
const fingerprint = await workspaceFingerprint(root);
const hooks = [];
for (const toolName of ["Edit", "Write", "apply_patch", "Bash", "exec_command"]) {
  hooks.push({
    toolName,
    result: await runHook({
      hook_event_name: "PreToolUse", host: "codex", cwd: root,
      session_id: "session:permission-probe", tool_use_id: `tool:permission-probe:${toolName}`,
      tool_name: toolName, tool_input: { file_path: "allowed-output.txt", content: "allowed\n" }
    })
  });
}
const lifecycle = [];
for (const event of ["PostToolUse", "Stop"]) {
  lifecycle.push({
    event,
    result: await runHook({
      hook_event_name: event, host: "codex", cwd: root,
      session_id: "session:permission-probe", event_id: `event:permission-probe:${event}`,
      ...(event === "PostToolUse" ? {
        tool_use_id: "tool:permission-probe:post", tool_name: "Write",
        tool_input: { file_path: "allowed-output.txt" }, tool_response: { ok: true }
      } : {})
    })
  });
}
let audit = [];
try {
  audit = (await readFile(hookScanAuditPath(), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
process.stdout.write(`${JSON.stringify({
  sourceSkipped: resolved.diagnostics.skipped,
  sourceDocuments: resolved.catalog.documents.map((item) => item.relativePath),
  fingerprintSkipped: fingerprint.skipped,
  hooks,
  lifecycle,
  audit
})}\n`);
