import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { verifyDeliveryStop } from "../src/lib/delivery-verification.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-host-result-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-host-result-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  const source = "# Synthetic rules\n\nPreserve this source exactly.\n";
  process.env.AGENTSPINE_STATE_DIR = state;
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
  });
  return { root, source };
}

async function outcome(root, sessionId, { toolName = "Bash", toolInput, toolResponse,
  success } = {}) {
  const common = { host: "codex", cwd: root, session_id: sessionId };
  await runHook({ ...common, hook_event_name: "PostToolUse", tool_name: "apply_patch",
    tool_use_id: `write:${sessionId}`, tool_input: { command: "synthetic patch" },
    tool_response: { isError: false } });
  const observed = await runHook({ ...common, hook_event_name: "PostToolUse",
    tool_name: toolName, tool_use_id: `test:${sessionId}`,
    tool_input: toolInput || { command: "node --test test/synthetic.test.js" },
    tool_response: toolResponse, ...(success === undefined ? {} : { success }) });
  const verification = await verifyDeliveryStop({ root, host: "codex", sessionId, scope: {} });
  return { observed, verification };
}

test("native Codex and PowerShell exit results verify the current write", async (t) => {
  const { root, source } = await fixture(t);
  const codex = await outcome(root, "session:codex-bash-result", {
    toolResponse: { chunk_id: "synthetic-chunk", exit_code: 0,
      output: "six tests passed", wall_time_seconds: 0.25 }
  });
  assert.equal(codex.observed.deliveryVerification.status, "test-recorded");
  assert.equal(codex.verification.status, "verified");

  const workMode = await outcome(root, "session:codex-exec-result", {
    toolName: "exec_command", toolInput: { cmd: "npm run check" },
    toolResponse: { chunk_id: "synthetic-chunk", exit_code: 0,
      output: "check passed", wall_time_seconds: 0.5 }
  });
  assert.equal(workMode.verification.status, "verified");

  const powershell = await outcome(root, "session:powershell-result", {
    toolName: "PowerShell", toolInput: { command: "npm test" },
    toolResponse: { exitCode: 0, stdout: "tests passed" }
  });
  assert.equal(powershell.verification.status, "verified");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("transport, interruption, failure and stale marker are not test success", async (t) => {
  const { root, source } = await fixture(t);
  const cases = [
    ["exit-one", { success: true, toolResponse: { exit_code: 1, output: "one test failed" } }],
    ["interrupted", { success: true,
      toolResponse: { session_id: 42, output: "Script running with session ID 42" } }],
    ["transport-only", { success: true,
      toolResponse: { isError: false, content: [{ type: "text", text: "six tests passed" }] } }],
    ["nested-exit-text", { toolResponse: { isError: false,
      content: [{ type: "text", text: "{\"exit_code\":0}" }] } }],
    ["old-marker", { toolResponse: { output: "old output\nAGENTSPINE_TEST_OK" } }]
  ];
  for (const [name, options] of cases) {
    const result = await outcome(root, `session:${name}`, options);
    assert.equal(result.observed.deliveryVerification.status, "test-failed", name);
    assert.equal(result.verification.blocked, true, name);
  }
  const marker = await outcome(root, "session:current-bound-marker", {
    toolInput: { command: "npm test && node -e \"console.log('AGENTSPINE_TEST_OK')\"" },
    toolResponse: { output: "suite output\nAGENTSPINE_TEST_OK\n" }
  });
  assert.equal(marker.verification.status, "verified");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});
