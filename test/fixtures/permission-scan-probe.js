import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runHook } from "../../src/hook.js";
import { hookScanAuditPath } from "../../src/lib/hook-audit.js";
import { workspaceFingerprint } from "../../src/lib/selfstarter.js";
import { resolveHostSourceCatalog } from "../../src/lib/source-roots.js";
import { registeredWriteContext } from "../premortem-write-fixture.js";

const root = await realpath(resolve(process.argv[2]));
const resolved = await resolveHostSourceCatalog({ host: "codex", cwd: root, env: process.env });
const fingerprint = await workspaceFingerprint(root);
const hookContext = await registeredWriteContext({
  root,
  sessionId: "session:permission-probe",
  projectId: "project:permission-probe"
});
const hooks = [];
for (const toolName of ["Edit", "Write", "apply_patch", "Bash", "exec_command"]) {
  hooks.push({
    toolName,
    result: await runHook({
      ...hookContext, hook_event_name: "PreToolUse",
      tool_use_id: `tool:permission-probe:${toolName}`,
      tool_name: toolName, tool_input: { file_path: "allowed-output.txt", content: "allowed\n" }
    })
  });
}
const lifecycleContext = {
  host: "codex",
  cwd: root,
  session_id: "session:permission-lifecycle",
  agent_spine_scope: { project_id: "project:permission-probe" }
};
const lifecycle = [];
for (const event of ["PostToolUse", "Stop"]) {
  lifecycle.push({
    event,
    result: await runHook({
      ...lifecycleContext, hook_event_name: event,
      event_id: `event:permission-probe:${event}`,
      ...(event === "PostToolUse" ? {
        tool_use_id: "tool:permission-probe:post", tool_name: "Read",
        tool_input: { file_path: "AGENTS.md" }, tool_response: { ok: true }
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
