import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight, verifyPreflightReceipt } from "../src/lib/preflight.js";
import { resolveHostSourceCatalog } from "../src/lib/source-roots.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const EXACT_RULE_BYTES = 17_590;

function exactRules(bytes, fill = "x") {
  const header = "# Synthetic Codex rules\n\n";
  const remaining = bytes - Buffer.byteLength(header);
  return `${header}${fill.repeat(Math.ceil(remaining / fill.length)).slice(0, remaining)}`;
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function exactUtf8Rules(bytes) {
  const header = "# Synthetische Regeln: Größe\n\n";
  const remaining = bytes - Buffer.byteLength(header);
  return `${header}${"ä".repeat(Math.floor(remaining / 2))}${remaining % 2 ? "x" : ""}`;
}

async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-large-agents-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  const hostHome = join(workspace, "host");
  await Promise.all([mkdir(root), mkdir(state), mkdir(hostHome)]);
  await mkdir(join(root, ".git"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const env = { ...process.env, AGENTSPINE_STATE_DIR: state, CODEX_HOME: hostHome,
    BLUN_HOME: hostHome, BLUN_PLUGIN_ROOT: pluginRoot };
  return { root, state, hostHome, env };
}

function input(root, eventId, prompt = "Please clean up AGENTS.md without deleting any instructions.") {
  return { hook_event_name: "UserPromptSubmit", host: "codex", cwd: root,
    session_id: `session:${eventId}`, event_id: `turn:${eventId}`,
    prompt };
}

async function installedHook({ root, env, eventId, prompt, hookInput, pluginRoot: installedRoot = pluginRoot }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(installedRoot, "src", "hook.js")], {
      cwd: root, env, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(hookInput || input(root, eventId, prompt)));
  });
}

test("a 17,590-byte AGENTS.md remains byte-exact and cannot block its own cleanup", async (t) => {
  const item = await setup(t);
  const path = join(item.root, "AGENTS.md");
  const source = Buffer.from(exactRules(EXACT_RULE_BYTES));
  await writeFile(path, source);
  const turn = input(item.root, "large-agents-direct");
  const resolvedSources = await resolveHostSourceCatalog({ host: "codex", cwd: item.root,
    input: turn, env: item.env });

  const preflight = await runPreflight({ input: turn,
    scope: { host: "codex", entityId: "agent:synthetic", projectId: "project:synthetic", groupId: null,
      currentTaskId: "task:cleanup" }, resolvedSources, prompt: turn.prompt, env: item.env });

  assert.equal(preflight.receipt.instructionBudget.mode, "codex-required-overflow");
  assert.equal(preflight.receipt.instructionBudget.standardBytes, 8 * 1024);
  assert.equal(preflight.receipt.instructionBudget.hardLimitBytes, 8 * 1024 * 1024);
  assert.equal(preflight.receipt.instructionBudget.usedBytes, EXACT_RULE_BYTES);
  assert.equal(preflight.briefing.instructions[0].content, source.toString("utf8"));
  assert.deepEqual(await readFile(path), source);
});

test("completed King source resolution stays non-blocking after its time budget", async (t) => {
  const item = await setup(t);
  const path = join(item.root, "AGENTS.md");
  const source = Buffer.from(exactRules(EXACT_RULE_BYTES));
  await writeFile(path, source);
  const env = { ...item.env, HOME: item.root, USERPROFILE: item.root };
  const actualNow = Date.now;
  let clockReads = 0;
  try {
    Date.now = () => clockReads++ === 0 ? 1_000 : 3_001;
    const resolved = await resolveHostSourceCatalog({ host: "codex", cwd: item.root, env });
    assert.equal(resolved.diagnostics.status, "loaded");
    assert.equal(resolved.diagnostics.incomplete, false);
  } finally {
    Date.now = actualNow;
  }
  assert.deepEqual(await readFile(path), source);
  const output = await installedHook({ ...item, env, eventId: "elapsed-source-budget" });
  assert.equal(output.decision, undefined, JSON.stringify(output));
});

test("the installed King envelope accepts the same cleanup turn without rewriting AGENTS.md", async (t) => {
  const item = await setup(t);
  const path = join(item.root, "AGENTS.md");
  const source = Buffer.from(exactRules(EXACT_RULE_BYTES));
  await writeFile(path, source);

  const output = await installedHook({ root: item.root, env: item.env, eventId: "large-agents-king" });

  assert.equal(output.decision, undefined, JSON.stringify(output));
  assert.equal(Object.hasOwn(output.hookSpecificOutput, "message"), false);
  assert.match(output.hookSpecificOutput.additionalContext, /^AgentSpine ready:/);
  assert.equal(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 1200, true);
  assert.deepEqual(await readFile(path), source);
});

for (const [name, projectBytes, userBytes, fill] of [
  ["single-44000", 44000, 0, "x"],
  ["combined-44000", 25000, 19000, "x"],
  ["escaped-32768", 32768, 0, "\"\\\\\n"]
]) test(`King preserves complete instructions and stays quiet: ${name}`, async (t) => {
  const item = await setup(t);
  const path = join(item.root, "AGENTS.md");
  const source = Buffer.from(exactRules(projectBytes, fill));
  await writeFile(path, source);
  const userPath = join(item.hostHome, "AGENTS.md");
  const userSource = userBytes ? Buffer.from(exactRules(userBytes)) : null;
  if (userSource) await writeFile(userPath, userSource);
  const turn = input(item.root, name);
  const resolvedSources = await resolveHostSourceCatalog({ host: "codex", cwd: item.root,
    input: turn, env: item.env });
  const args = { input: turn, scope: { host: "codex" }, resolvedSources,
    prompt: turn.prompt, env: item.env };
  const preflight = await runPreflight(args);
  assert.equal(preflight.receipt.instructionBudget.usedBytes, projectBytes + userBytes);
  assert.equal(preflight.briefing.instructions.find((entry) => entry.scope === "project").content, source.toString());
  if (userSource) assert.equal(preflight.briefing.instructions.find((entry) => entry.scope === "user").content, userSource.toString());
  assert.equal(await verifyPreflightReceipt({ ...args, receipt: preflight.receipt }), true);
  assert.equal(await verifyPreflightReceipt({ ...args, receipt: preflight.receipt, prompt: "different" }), false);
  assert.equal(await verifyPreflightReceipt({ ...args, receipt: preflight.receipt, consume: true }), true);
  assert.equal(await verifyPreflightReceipt({ ...args, receipt: preflight.receipt }), false);
  for (const [suffix, prompt] of [["ordinary", "Continue the current task."],
    ["cleanup", "Please clean up AGENTS.md without deleting any instructions."]]) {
    const output = await installedHook({ ...item, eventId: `hook-${name}-${suffix}`, prompt });
    assert.equal(output.decision, undefined, JSON.stringify(output));
    assert.equal(Object.hasOwn(output.hookSpecificOutput, "message"), false);
    assert.equal(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 1200, true);
  }
  assert.deepEqual(await readFile(path), source);
  if (userSource) assert.deepEqual(await readFile(userPath), userSource);
});

for (const [name, source] of [
  ...[8191, 8192, 8193, 17590, 32767, 32768, 32769, 65536, 131072]
    .map((bytes) => [`bytes-${bytes}`, Buffer.from(exactRules(bytes))]),
  ["utf8-65537", Buffer.from(exactUtf8Rules(65537))]
]) test(`King loads exact instruction bytes through the real hook: ${name}`, async (t) => {
  const item = await setup(t);
  const path = join(item.root, "AGENTS.md");
  await writeFile(path, source);
  const sourceDigest = digest(source);
  assert.equal((await readFile(path)).length, source.length);
  if (name.startsWith("utf8")) assert.notEqual(source.length, source.toString("utf8").length);
  for (const [eventId, prompt] of [[`${name}-ordinary`, "Continue the current task."],
    [`${name}-cleanup`, "Please clean up AGENTS.md without deleting any instructions."]]) {
    const output = await installedHook({ ...item, eventId, prompt });
    assert.equal(output.decision, undefined, JSON.stringify(output));
    assert.equal(Object.hasOwn(output.hookSpecificOutput, "message"), false);
  }
  const preserved = await readFile(path);
  assert.deepEqual(preserved, source);
  assert.equal(digest(preserved), sourceDigest);
});

test("King resource limits stay non-blocking and explicitly unverified", async (t) => {
  const item = await setup(t);
  const foreignHome = join(item.root, "foreign-profile");
  await mkdir(foreignHome);
  await writeFile(join(foreignHome, "AGENTS.md"), "# Foreign profile must not load\n");
  item.env.CODEX_HOME = foreignHome;
  const path = join(item.root, "AGENTS.md");
  const source = Buffer.from(exactRules(44000));
  await writeFile(path, source);
  const resolved = await resolveHostSourceCatalog({ host: "codex", cwd: item.root, env: item.env });
  assert.equal(resolved.catalog.documents.some((entry) => entry.sourceScope === "user"), false);
  assert.deepEqual(await readFile(path), source);
  const oversized = Buffer.from(exactRules(4 * 1024 * 1024 + 1));
  await writeFile(path, oversized);
  const limited = await resolveHostSourceCatalog({ host: "codex", cwd: item.root, env: item.env });
  assert.equal(limited.diagnostics.status, "incomplete");
  assert.deepEqual(limited.unverified.map((entry) => ({ id: entry.id, bytes: entry.bytes })),
    [{ id: "codex:project/AGENTS.md", bytes: oversized.length }]);
  for (const [eventId, prompt] of [["ordinary-oversized", "Continue the current task."],
    ["cleanup-oversized", "Please clean up AGENTS.md without deleting any instructions."]]) {
    const output = await installedHook({ ...item, eventId, prompt });
    assert.equal(output.decision, undefined, JSON.stringify(output));
    assert.match(output.hookSpecificOutput.message, /did not load or verify/);
    assert.match(output.hookSpecificOutput.message, /Continue; no retry/);
  }
  const protectedWrite = await installedHook({ ...item, eventId: "write-oversized", hookInput: {
    ...input(item.root, "write-oversized"), hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "tool:write-oversized", tool_input: { file_path: "AGENTS.md", content: "changed" }
  } });
  assert.equal(protectedWrite.decision, "block");
  assert.match(protectedWrite.reason, /codex:project\/AGENTS\.md/);
  assert.deepEqual(await readFile(path), oversized);
});

test("King cumulative resource overflow stays non-blocking and preserves every source", async (t) => {
  const item = await setup(t);
  const nested = join(item.root, "nested");
  await mkdir(nested);
  const sources = [
    [join(item.hostHome, "AGENTS.md"), Buffer.from(exactRules(3 * 1024 * 1024, "u"))],
    [join(item.root, "AGENTS.md"), Buffer.from(exactRules(3 * 1024 * 1024, "r"))],
    [join(nested, "AGENTS.md"), Buffer.from(exactRules(3 * 1024 * 1024, "n"))]
  ];
  for (const [path, source] of sources) await writeFile(path, source);
  const limited = await resolveHostSourceCatalog({ host: "codex", cwd: nested, env: item.env });
  assert.equal(limited.diagnostics.status, "incomplete");
  assert.equal(limited.unverified.length, 1);
  for (const [suffix, prompt] of [["ordinary", "Continue the current task."],
    ["cleanup", "Please clean up AGENTS.md without deleting any instructions."]]) {
    const output = await installedHook({ ...item, root: nested,
      eventId: `cumulative-${suffix}`, prompt });
    assert.equal(output.decision, undefined, JSON.stringify(output));
    assert.match(output.hookSpecificOutput.message, /total reader budget/);
    assert.match(output.hookSpecificOutput.additionalContext, /^AgentSpine ready: 2 sources indexed\./);
    assert.match(output.hookSpecificOutput.additionalContext, /Warning: .*did not load or verify/);
  }
  const protectedWrite = await installedHook({ ...item, root: nested, eventId: "write-cumulative", hookInput: {
    ...input(nested, "write-cumulative"), hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "tool:write-cumulative", tool_input: { file_path: "AGENTS.md", content: "changed" }
  } });
  assert.equal(protectedWrite.decision, "block");
  for (const [path, source] of sources) assert.deepEqual(await readFile(path), source);
});

test("King reports every source omitted by the cumulative reader budget", async (t) => {
  const item = await setup(t);
  const nested = join(item.root, "nested");
  const deep = join(nested, "deep");
  await mkdir(deep, { recursive: true });
  const sources = [join(item.hostHome, "AGENTS.md"), join(item.root, "AGENTS.md"),
    join(nested, "AGENTS.md"), join(deep, "AGENTS.md")]
    .map((path, index) => [path, Buffer.from(exactRules(3 * 1024 * 1024, String(index)))]);
  for (const [path, source] of sources) await writeFile(path, source);
  const limited = await resolveHostSourceCatalog({ host: "codex", cwd: deep, env: item.env });
  assert.deepEqual(limited.unverified.map((item) => item.id),
    ["codex:project/nested/AGENTS.md", "codex:project/nested/deep/AGENTS.md"]);
  const output = await installedHook({ ...item, root: deep,
    eventId: "multiple-cumulative-overflow", prompt: "Continue the current task." });
  assert.equal(output.decision, undefined, JSON.stringify(output));
  assert.match(output.hookSpecificOutput.message, /2 King rules/);
  assert.doesNotMatch(output.hookSpecificOutput.message, /^King rule /);
  assert.match(output.hookSpecificOutput.additionalContext, /2 King rules/);
  assert.equal(Buffer.byteLength(output.hookSpecificOutput.message) <= 900, true);
  assert.equal(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 1200, true);
  for (const [path, source] of sources) {
    const preserved = await readFile(path);
    assert.deepEqual(preserved, source);
    assert.equal(digest(preserved), digest(source));
  }
});

test("fresh and upgraded package copies preserve the King size contract", async (t) => {
  const item = await setup(t);
  const installs = [join(item.root, "fresh-package"), join(item.root, "upgraded-package")];
  for (const installedRoot of installs) {
    await mkdir(installedRoot);
    await cp(join(pluginRoot, "src"), join(installedRoot, "src"), { recursive: true });
    await cp(join(pluginRoot, "package.json"), join(installedRoot, "package.json"));
  }
  await writeFile(join(installs[1], "src", "hook.js"), "// stale package\n");
  await cp(join(pluginRoot, "src"), join(installs[1], "src"), { recursive: true, force: true });
  const path = join(item.root, "AGENTS.md");
  for (const [installIndex, installedRoot] of installs.entries()) {
    const installState = join(item.state, String(installIndex));
    await mkdir(installState);
    const env = { ...item.env, AGENTSPINE_STATE_DIR: installState, BLUN_PLUGIN_ROOT: installedRoot };
    for (const [name, source] of [
      ...[8191, 8192, 8193, 17590, 32767, 32768, 32769, 65536, 131072]
        .map((bytes) => [`bytes-${bytes}`, Buffer.from(exactRules(bytes))]),
      ["escaped-32768", Buffer.from(exactRules(32768, "\"\\\\\n"))],
      ["utf8-65537", Buffer.from(exactUtf8Rules(65537))],
      ["reader-overflow", Buffer.from(exactRules(4 * 1024 * 1024 + 1))]
    ]) {
      await writeFile(path, source);
      const before = digest(source);
      for (const [suffix, prompt] of [["ordinary", "Continue the current task."],
        ["cleanup", "Please clean up AGENTS.md without deleting any instructions."]]) {
        const output = await installedHook({ ...item, env, pluginRoot: installedRoot,
          eventId: `${installIndex}-${name}-${suffix}`, prompt });
        assert.equal(output.decision, undefined, JSON.stringify(output));
        if (name === "reader-overflow") assert.match(output.hookSpecificOutput.message, /did not load or verify/);
      }
      assert.equal(digest(await readFile(path)), before);
    }
  }
});
