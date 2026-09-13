import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight, verifyPreflightReceipt } from "../src/lib/preflight.js";
import { resolveHostSourceCatalog } from "../src/lib/source-roots.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const EXACT_RULE_BYTES = 17_590;

function exactRules(bytes, fill = "x") {
  const header = "# Synthetic Codex rules\n\n";
  return `${header}${fill.repeat(bytes - Buffer.byteLength(header))}`;
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

function input(root, eventId) {
  return { hook_event_name: "UserPromptSubmit", host: "codex", cwd: root,
    session_id: `session:${eventId}`, event_id: `turn:${eventId}`,
    prompt: "Please clean up AGENTS.md without deleting any instructions." };
}

async function installedHook({ root, env, eventId }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "src", "hook.js")], {
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
    child.stdin.end(JSON.stringify(input(root, eventId)));
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
  ["escaped-32768", 32768, 0, '"']
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
  const output = await installedHook({ ...item, eventId: `hook-${name}` });
  assert.equal(output.decision, undefined, JSON.stringify(output));
  assert.equal(Object.hasOwn(output.hookSpecificOutput, "message"), false);
  assert.equal(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 1200, true);
  assert.deepEqual(await readFile(path), source);
  if (userSource) assert.deepEqual(await readFile(userPath), userSource);
});

test("King uses its own profile and retains the source-reader safety limit", async (t) => {
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
  await writeFile(path, exactRules(4 * 1024 * 1024 + 1));
  await assert.rejects(resolveHostSourceCatalog({ host: "codex", cwd: item.root, env: item.env }), /source exceeds its byte limit/);
});
