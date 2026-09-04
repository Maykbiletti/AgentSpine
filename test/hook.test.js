import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blunRuntimeContext, blunRuntimeMessage, runHook } from "../src/hook.js";
import { recordDeliveryPremortem } from "../src/lib/delivery-premortem.js";
import { seedDeliveryAgentUse } from "./delivery-agent-use-fixture.js";
import { registeredWriteContext } from "./premortem-write-fixture.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

async function runInstalledHook({ cwd, state, blunHome, input, blun = true, environment = {},
  args = [], raw = false }) {
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
    Object.assign(env, environment);
    const child = spawn(process.execPath, [join(pluginRoot, "src", "hook.js"), ...args], {
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
      if (raw) return resolve({ code, stdout, stderr });
      if (code !== 0) return reject(new Error(`BLUN hook exited with ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test("oversized PostToolUse image results exit silently without touching project or state", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-oversize-post-tool-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  const blunHome = join(workspace, "host");
  await Promise.all([mkdir(root), mkdir(state), mkdir(blunHome)]);
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const source = "# Synthetic rules\n\nKeep the source unchanged.\n";
  await writeFile(join(root, "AGENTS.md"), source, "utf8");
  const oversizedImageResult = {
    hook_event_name: "PostToolUse", cwd: root, session_id: "session:image-read",
    tool_use_id: "tool:image-read", tool_name: "Read",
    tool_response: { type: "image", media_type: "image/png", data: "a".repeat(70 * 1024) }
  };

  const skipped = await runInstalledHook({
    cwd: root, state, blunHome, input: oversizedImageResult, raw: true,
    args: ["--silent-oversize-post-tool-use"]
  });
  assert.deepEqual(skipped, { code: 0, stdout: "", stderr: "" });
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
  assert.deepEqual(await readdir(state), [], "a skipped result must not create partial runtime state");

  const unmarked = await runInstalledHook({
    cwd: root, state, blunHome, input: oversizedImageResult, raw: true
  });
  assert.equal(unmarked.code, 2, "mandatory hook lanes retain the fail-closed input bound");
  assert.equal(unmarked.stdout, "");
  assert.match(unmarked.stderr, /hook input exceeds the 64 KiB limit/);
  assert.deepEqual(await readdir(state), []);
});

test("installed hook never recursively scans a Windows-profile home even when it has a project marker", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-unmarked-hook-"));
  const root = join(workspace, "synthetic-user-root");
  const serviceHome = join(workspace, "synthetic-service-home");
  const claudeHome = join(serviceHome, ".claude");
  const state = join(root, ".agentspine");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(claudeHome, { recursive: true }),
    mkdir(state, { recursive: true })]);
  await mkdir(join(root, ".git"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const rules = "# Synthetic local rules\n\nKeep this exact rule available.\n";
  await writeFile(join(root, "CLAUDE.md"), rules, "utf8");
  const privateState = "# Synthetic private state\n\nNever index this file.\n";
  await writeFile(join(state, "PRIVATE.md"), privateState, "utf8");
  const decoy = join(root, "large-cloud-shaped-tree");
  await mkdir(decoy);
  await Promise.all(Array.from({ length: 256 }, async (_, index) => {
    const directory = join(decoy, `folder-${String(index).padStart(3, "0")}`);
    await mkdir(directory);
    await writeFile(join(directory, "PRIVATE.md"), `# Decoy ${index}\n`, "utf8");
  }));
  const before = await readFile(join(root, "CLAUDE.md"));

  const startedAt = Date.now();
  const output = await runInstalledHook({
    cwd: root,
    state,
    blunHome: claudeHome,
    blun: false,
    environment: { HOME: serviceHome, USERPROFILE: root, CLAUDE_CONFIG_DIR: claudeHome },
    input: { hook_event_name: "UserPromptSubmit", host: "claude", cwd: root,
      session_id: "session:unmarked", event_id: "turn:unmarked", prompt: "Hallo" }
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(output.decision, undefined, JSON.stringify(output));
  const context = JSON.parse(output.hookSpecificOutput.additionalContext);
  assert.equal(context.sourceResolution.rootResolution, "project-marker");
  assert.equal(context.sourceResolution.projectTreeScan, "skipped-home-root");
  assert.equal(context.sourceResolution.broadHomeScan, false);
  assert.deepEqual(context.briefing.sources.documents.map((item) => item.path), ["claude:project/CLAUDE.md"]);
  assert.equal(context.preflight.briefing.instructions[0].content, rules);
  assert.equal(JSON.stringify(context).includes("Synthetic private state"), false);
  assert.equal(elapsedMs < 5000, true, `unmarked hook took ${elapsedMs} ms`);
  assert.deepEqual(await readFile(join(root, "CLAUDE.md")), before);
  assert.equal(await readFile(join(state, "PRIVATE.md"), "utf8"), privateState);
});

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
  assert.match(output.hookSpecificOutput.message,
    /^AgentSpine ready: 145 sources indexed\. Load detailed continuity only on demand through session_briefing\./);
  assert.match(output.hookSpecificOutput.message, /Before the first Write\/Edit\/apply_patch/);
  assert.match(output.hookSpecificOutput.message, /Premortem closure sha256 <64hex>/);
  assert.equal(output.hookSpecificOutput.message.startsWith("{"), false);
  assert.equal(output.hookSpecificOutput.message.includes("agentspine.blun-runtime-context"), false);
  assert.equal("additionalContext" in output.hookSpecificOutput, false);
  const messageBytes = Buffer.byteLength(output.hookSpecificOutput.message);
  assert.equal(messageBytes <= 1200, true, `BLUN runtime message was ${messageBytes} bytes`);

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
  const context = await registeredWriteContext({ root, sessionId: "session:unrelated-write",
    projectId: "project:hook-protection" });
  const result = await runHook({
    ...context,
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
  for (const [tool_name, command] of [["Bash", "sed -i 's/old/new/' AGENTS.md"],
    ["PowerShell", "Set-Content -Path AGENTS.md -Value changed"]]) {
    const result = await runHook({ hook_event_name: "PreToolUse", cwd: root,
      tool_name, tool_input: { command } });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /AGENTS\.md/);
  }
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

test("Claude prompts in one raw session receive separate assignment premortems", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-session-premortem-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  const source = "# Synthetic Claude rules\n\nKeep this byte-exact.\n";
  await writeFile(join(root, "CLAUDE.md"), source, "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  const base = { host: "claude", cwd: root, session_id: "session:claude-premortem",
    agent_spine_scope: { project_id: "project:session-premortem" } };
  const prompt = (text) => runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: text });
  const first = await prompt("Deliver the first synthetic change.");
  const items = [
    { category: "baseline-environment", failure: "this delivery fails because the baseline is stale",
      check: "Check the synthetic baseline digest." },
    { category: "contract-tests", failure: "this delivery fails because the contract regresses",
      check: "Run the focused synthetic test." },
    { category: "delivery-path", failure: "this delivery fails because the path is wrong",
      check: "Check the synthetic output path." }
  ];
  const requirementId = first.preflight.premortem.requirementId;
  await seedDeliveryAgentUse(root, requirementId);
  const recorded = await recordDeliveryPremortem({ root, requirementId, items });
  const writeInput = { file_path: "artifact.txt", content: "synthetic\n" };
  assert.equal((await runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "write:session:one", tool_input: writeInput })).blocked, false);
  await writeFile(join(root, "artifact.txt"), "synthetic\n", "utf8");
  const written = await runHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Write",
    tool_use_id: "write:session:one", tool_input: writeInput, success: true });
  await runHook({ ...base, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "test:session:one", tool_input: { cmd: "node --test test/synthetic.test.js" }, success: true });
  const closing = [
    `Premortem closure sha256 ${recorded.digest}`,
    `Premortem latest write sha256 ${written.premortem.writeDigest}`,
    ...recorded.artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — synthetic check passed`)
  ].join("\n");
  assert.equal((await runHook({ ...base, hook_event_name: "Stop",
    final_assistant_message: closing })).blocked, false);

  const second = await prompt("Deliver the second synthetic change.");
  assert.notEqual(second.preflight.premortem.requirementId,
    first.preflight.premortem.requirementId, "the second assignment needs its own registration");
  await seedDeliveryAgentUse(root, second.preflight.premortem.requirementId);
  const secondRecorded = await recordDeliveryPremortem({ root,
    requirementId: second.preflight.premortem.requirementId, items });
  const nextInput = { ...writeInput, content: "synthetic again\n" };
  const nextPre = await runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "write:session:two", tool_input: nextInput });
  assert.equal(nextPre.blocked, false);
  await writeFile(join(root, "artifact.txt"), nextInput.content, "utf8");
  const nextPost = await runHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Write",
    tool_use_id: "write:session:two", tool_input: nextInput, success: true });
  await runHook({ ...base, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "test:session:two", tool_input: { cmd: "node --test test/synthetic.test.js" }, success: true });
  assert.equal((await runHook({ ...base, hook_event_name: "Stop",
    final_assistant_message: closing })).blocked, true, "the old write closure is stale");
  const reclosed = [
    `Premortem closure sha256 ${secondRecorded.digest}`,
    `Premortem latest write sha256 ${nextPost.premortem.writeDigest}`,
    ...secondRecorded.artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — synthetic check passed`)
  ].join("\n");
  assert.equal((await runHook({ ...base, hook_event_name: "Stop",
    final_assistant_message: reclosed })).blocked, false);
  assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8"), source);
});
