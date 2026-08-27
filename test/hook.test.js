import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";

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
