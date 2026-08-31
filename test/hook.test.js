import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blunRuntimeContext, blunRuntimeMessage, runHook } from "../src/hook.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

async function runInstalledHook({ cwd, state, blunHome, input, blun = true }) {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env, AGENTSPINE_STATE_DIR: state };
    if (blun) {
      env.BLUN_HOME = blunHome;
      env.BLUN_PLUGIN_ROOT = pluginRoot;
      delete env.CODEX_HOME;
    } else {
      env.CODEX_HOME = blunHome;
      delete env.BLUN_HOME;
      delete env.BLUN_PLUGIN_ROOT;
    }
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

test("installed BLUN hook keeps the full briefing out of the runtime message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-blun-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-blun-hook-state-"));
  const blunHome = await mkdtemp(join(tmpdir(), "agentspine-blun-home-"));
  t.after(async () => {
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
    await rm(blunHome, { recursive: true });
  });
  const rules = "# BLUN project rules\n\nKeep this detailed project rule available on demand.\n";
  await writeFile(join(root, "AGENTS.md"), rules, "utf8");
  await Promise.all(Array.from({ length: 144 }, (_, index) => writeFile(
    join(root, `reference-${String(index).padStart(3, "0")}.md`),
    `# Reference ${index}\n\nSynthetic large-workspace evidence.\n`,
    "utf8"
  )));

  const output = await runInstalledHook({
    cwd: root,
    state,
    blunHome,
    input: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "session:blun", prompt: [{ type: "text", text: "Hallo" }] }
  });
  assert.equal(
    output.hookSpecificOutput.message,
    "AgentSpine ready: 145 sources indexed. Load detailed continuity only on demand through session_briefing."
  );
  assert.equal(output.hookSpecificOutput.message.startsWith("{"), false);
  assert.equal(output.hookSpecificOutput.message.includes("agentspine.blun-runtime-context"), false);
  assert.equal("additionalContext" in output.hookSpecificOutput, false);
  assert.equal(Buffer.byteLength(output.hookSpecificOutput.message) <= 160, true);

  const compatibleOutput = await runInstalledHook({
    cwd: root,
    state,
    blunHome,
    blun: false,
    input: { hook_event_name: "UserPromptSubmit", host: "codex", cwd: root, session_id: "session:codex", prompt: [{ type: "text", text: "Hallo" }] }
  });
  assert.equal("message" in compatibleOutput.hookSpecificOutput, false);
  const detailedBytes = Buffer.byteLength(compatibleOutput.hookSpecificOutput.additionalContext);
  assert.equal(detailedBytes <= 9500, true, `preflight context exceeded the hard host injection budget: ${detailedBytes} bytes`);
  const detailed = JSON.parse(compatibleOutput.hookSpecificOutput.additionalContext);
  assert.equal(detailed.briefing.host, "codex");
  assert.equal(detailed.briefing.sources.documents[0].content, null);
  assert.equal(detailed.preflight.schema, "agentspine.preflight/v2");
  assert.equal(detailed.preflight.briefing.instructions[0].content, rules);
});

test("installed Claude hook carries one bounded required-instruction overflow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-claude-overflow-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-claude-overflow-state-"));
  const blunHome = await mkdtemp(join(tmpdir(), "agentspine-claude-overflow-home-"));
  t.after(async () => {
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
    await rm(blunHome, { recursive: true });
  });
  await writeFile(join(root, "CLAUDE.md"), `# Required Claude rules\n${"x".repeat(9000)}\n`, "utf8");
  const output = await runInstalledHook({
    cwd: root,
    state,
    blunHome,
    input: { hook_event_name: "UserPromptSubmit", host: "claude", cwd: root,
      session_id: "session:claude-overflow", event_id: "turn:claude-overflow",
      prompt: [{ type: "text", text: "Hallo" }] }
  });
  assert.match(output.hookSpecificOutput.message, /^AgentSpine ready:/);

  await writeFile(join(root, "CLAUDE.md"), `# Oversized Claude rules\n${"x".repeat(17000)}\n`, "utf8");
  const blocked = await runInstalledHook({
    cwd: root,
    state,
    blunHome,
    input: { hook_event_name: "UserPromptSubmit", host: "claude", cwd: root,
      session_id: "session:claude-oversized", event_id: "turn:claude-oversized",
      prompt: [{ type: "text", text: "Hallo" }] }
  });
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /CLAUDE\.md is \d+ bytes; mandatory limit is 16384 bytes/);
});

test("compact BLUN runtime context preserves active execution and authenticated channel signals", () => {
  const selfstarter = {
    active: true,
    blocked: false,
    jobId: "job:one",
    taskId: "task:one",
    capabilities: ["tool:Write"],
    instruction: "Resume only this exact checkpointed job."
  };
  const channelEvent = {
    active: true,
    eventId: "telegram:update:one",
    provider: "telegram",
    chatId: "1605241602",
    threadId: "0",
    text: "Current authenticated request.",
    instruction: "Answer this exact authenticated channel event."
  };
  const runtime = JSON.parse(blunRuntimeContext(JSON.stringify({
    schema: "agentspine.hook-context/v1",
    event: "SessionStart",
    loaded: true,
    indexedSources: 149,
    sourceResolution: { status: "loaded", scopes: { project: 149 } },
    selfstarter,
    channelEvent,
    briefing: { sources: { documents: Array(149).fill({ content: "large" }) } },
    authority: "context-only"
  })));
  assert.deepEqual(runtime.selfstarter, selfstarter);
  assert.deepEqual(runtime.channelEvent, channelEvent);
  assert.equal("briefing" in runtime, false);
  assert.deepEqual(runtime.sourceResolution, { status: "loaded", reason: null });

  const message = blunRuntimeMessage(JSON.stringify({
    schema: "agentspine.hook-context/v1",
    event: "SessionStart",
    loaded: true,
    indexedSources: 149,
    sourceResolution: { status: "loaded" },
    selfstarter,
    channelEvent,
    briefing: { sources: { documents: Array(149).fill({ content: "large" }) } },
    authority: "context-only"
  }));
  assert.match(message, /^AgentSpine ready: 149 sources indexed\./);
  const active = JSON.parse(message.split("Active AgentSpine runtime data: ")[1]);
  assert.deepEqual(active.selfstarter, selfstarter);
  assert.deepEqual(active.channelEvent, channelEvent);
});

test("compact BLUN runtime context preserves a failed-closed source resolution", () => {
  const runtime = JSON.parse(blunRuntimeContext(JSON.stringify({
    schema: "agentspine.hook-context/v1",
    event: "UserPromptSubmit",
    loaded: false,
    failedClosed: true,
    indexedSources: 0,
    sourceResolution: { status: "failed-closed", reason: "synthetic failure", diagnostics: "not injected" },
    instruction: "Do not claim AgentSpine recall succeeded.",
    authority: "context-only"
  })));
  assert.equal(runtime.failedClosed, true);
  assert.deepEqual(runtime.sourceResolution, { status: "failed-closed", reason: "synthetic failure" });
  assert.equal(runtime.instruction, "Do not claim AgentSpine recall succeeded.");

  const message = blunRuntimeMessage(JSON.stringify({
    schema: "agentspine.hook-context/v1",
    event: "UserPromptSubmit",
    loaded: false,
    failedClosed: true,
    indexedSources: 0,
    sourceResolution: { status: "failed-closed", reason: "synthetic failure" },
    instruction: "Do not claim AgentSpine recall succeeded.",
    authority: "context-only"
  }));
  assert.equal(
    message,
    "AgentSpine unavailable: synthetic failure. Do not claim AgentSpine recall succeeded."
  );
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

test("generic host preflight requires an explicit instruction-host binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-generic-hook-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-generic-hook-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Generic TUI rules\n", "utf8");
  const missing = await runHook({ hook_event_name: "UserPromptSubmit", host: "generic", cwd: root,
    session_id: "session:generic", event_id: "turn:missing", prompt: "Continue." });
  assert.equal(missing.blocked, true);
  assert.match(missing.reason, /instruction_host/);
  const ready = await runHook({ hook_event_name: "UserPromptSubmit", host: "generic", instruction_host: "codex", cwd: root,
    session_id: "session:generic", event_id: "turn:ready", prompt: "Continue." });
  assert.equal(ready.blocked, false);
  assert.equal(ready.preflight.receipt.host, "generic");
  assert.equal(ready.preflight.receipt.instructionHost, "codex");
});
