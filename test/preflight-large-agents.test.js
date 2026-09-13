import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "../src/lib/preflight.js";
import { resolveHostSourceCatalog } from "../src/lib/source-roots.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const EXACT_RULE_BYTES = 17_590;

function exactRules(bytes) {
  const header = "# Synthetic Codex rules\n\n";
  return `${header}${"x".repeat(bytes - Buffer.byteLength(header))}`;
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
    scope: { entityId: "agent:synthetic", projectId: "project:synthetic", groupId: null,
      currentTaskId: "task:cleanup" }, resolvedSources, prompt: turn.prompt, env: item.env });

  assert.equal(preflight.receipt.instructionBudget.mode, "codex-required-overflow");
  assert.equal(preflight.receipt.instructionBudget.standardBytes, 8 * 1024);
  assert.equal(preflight.receipt.instructionBudget.hardLimitBytes, 32 * 1024);
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
  assert.match(output.hookSpecificOutput.message, /^AgentSpine ready:/);
  assert.equal(Buffer.byteLength(output.hookSpecificOutput.message) <= 1200, true);
  assert.deepEqual(await readFile(path), source);
});
