import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../src/hook.js", import.meta.url));

test("real restarted hooks allow unverified programming and replies without certifying success", async t => {
  const base = await mkdtemp(join(tmpdir(), "agentspine-advisory-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(join(root, ".git"), { recursive: true });
  const source = "# Synthetic contract\nPreserve these bytes.\n";
  await writeFile(join(root, "AGENTS.md"), source);
  const env = { ...process.env, AGENTSPINE_STATE_DIR: join(base, "state") };
  function invoke(event, extra = {}) {
    const result = spawnSync(process.execPath, [hook], {
      cwd: root, env, encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ host: "codex", cwd: root, session_id: "synthetic-advisory",
        agent_spine_scope: { project_id: "project:advisory" },
        hook_event_name: event, ...extra })
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  invoke("UserPromptSubmit", { event_id: "synthetic:A", prompt: "Implement a synthetic artifact." });
  const write = { tool_name: "Write", tool_use_id: "synthetic:write",
    tool_input: { file_path: "artifact.txt", content: "synthetic" } };
  const allowed = invoke("PreToolUse", write);
  assert.equal(allowed.decision, undefined);
  const diagnostic = JSON.parse(allowed.hookSpecificOutput.additionalContext);
  assert.equal(diagnostic.presentation, "internal-only");
  assert.equal(diagnostic.completionVerified, false);
  assert.equal(diagnostic.automaticRetry, false);
  assert.equal(diagnostic.action, "continue-authorized-task");
  assert.deepEqual(invoke("PreToolUse", write), {}, "restart does not repeat the warning");
  await writeFile(join(root, "artifact.txt"), "synthetic");
  invoke("PostToolUse", { ...write, success: true, tool_response: { ok: true } });
  const stop = invoke("Stop", { last_assistant_message: "Synthetic implementation finished." });
  assert.equal(stop.decision, undefined);
  invoke("UserPromptSubmit", { event_id: "synthetic:B", prompt: "Analyze the completed artifact." });
  assert.equal(invoke("Stop", { last_assistant_message: "Synthetic analysis finished." }).decision, undefined);
  const protectedWrite = invoke("PreToolUse", { ...write,
    tool_input: { file_path: "AGENTS.md", content: "changed" } });
  assert.equal(protectedWrite.decision, "block", "source access gate remains enforced");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});
