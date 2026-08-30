import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/hook.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

async function runInstalledBlunHook({ cwd, state, blunHome, input }) {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env, AGENTSPINE_STATE_DIR: state, BLUN_HOME: blunHome, BLUN_PLUGIN_ROOT: pluginRoot };
    delete env.CODEX_HOME;
    delete env.PLUGIN_ROOT;
    delete env.CLAUDE_CONFIG_DIR;
    const child = spawn(process.execPath, [join(pluginRoot, "src", "hook.js")], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`BLUN hook exited with ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test("installed BLUN hook emits a clean message alongside Claude-compatible additionalContext", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-blun-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-blun-hook-state-"));
  const blunHome = await mkdtemp(join(tmpdir(), "agentspine-blun-home-"));
  t.after(async () => {
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
    await rm(blunHome, { recursive: true });
  });
  await writeFile(join(root, "AGENTS.md"), "# BLUN project rules\n", "utf8");

  const output = await runInstalledBlunHook({
    cwd: root,
    state,
    blunHome,
    input: { hook_event_name: "UserPromptSubmit", cwd: root, prompt: [{ type: "text", text: "Hallo" }] }
  });
  assert.equal(typeof output.hookSpecificOutput.additionalContext, "string");
  assert.equal(output.hookSpecificOutput.message, output.hookSpecificOutput.additionalContext);
  assert.equal(JSON.parse(output.hookSpecificOutput.message).briefing.host, "codex");
});

test("PreToolUse blocks an agent write to a protected source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-hook-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "CLAUDE.md"), "# Rules\n", "utf8");
  const result = await runHook({
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "Write",
    tool_input: { file_path: join(root, "CLAUDE.md"), content: "replacement" }
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /CLAUDE\.md/);
});

test("PreToolUse canonicalizes an existing protected target before comparison", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-hook-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "SOUL.md"), "# Soul\n", "utf8");
  const result = await runHook({
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "Write",
    tool_input: { file_path: join(root, "SOUL.md"), content: "replacement" }
  });
  assert.equal(result.blocked, true);
});

test("PreToolUse allows an unrelated source target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-hook-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "CLAUDE.md"), "# Rules\n", "utf8");
  const result = await runHook({
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "Write",
    tool_input: { file_path: join(root, "output.txt"), content: "safe" }
  });
  assert.equal(result.blocked, false);
});

test("PreToolUse extracts protected targets from an apply_patch payload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-hook-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "SOUL.md"), "# Soul\n", "utf8");
  const result = await runHook({
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { patch: "*** Begin Patch\n*** Update File: SOUL.md\n@@\n-old\n+new\n*** End Patch" }
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /SOUL\.md/);
});

test("PreToolUse blocks shell mutation of a protected source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-hook-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  const result = await runHook({
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "sed -i 's/old/new/' AGENTS.md" }
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /AGENTS\.md/);
});

test("PreToolUse allows shell reads of a protected source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-hook-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  const result = await runHook({
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "sed -n '1,20p' AGENTS.md" }
  });
  assert.equal(result.blocked, false);
});
