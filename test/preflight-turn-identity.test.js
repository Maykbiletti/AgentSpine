import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightDeliveryId } from "../src/lib/preflight-delivery-id.js";
import { runPreflight, verifyPreflightReceipt } from "../src/lib/preflight.js";
import { resolveHostSourceCatalog } from "../src/lib/source-roots.js";

const HOOK = fileURLToPath(new URL("../src/hook.js", import.meta.url));

async function fixture(t, host) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-turn-project-"));
  const home = await mkdtemp(join(tmpdir(), "agentspine-turn-home-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-turn-state-"));
  await mkdir(join(root, ".git"));
  const env = { ...process.env, AGENTSPINE_STATE_DIR: state, HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
  await mkdir(env.CLAUDE_CONFIG_DIR); await mkdir(env.CODEX_HOME);
  const sourcePath = join(root, host === "codex" ? "AGENTS.md" : "CLAUDE.md");
  const sourceBytes = Buffer.from("# Synthetic rules\n\nRecall before answering.\n");
  await writeFile(sourcePath, sourceBytes);
  t.after(() => Promise.all([root, home, state].map((path) => rm(path, { recursive: true, force: true }))));
  const input = { hook_event_name: "UserPromptSubmit", host, cwd: root,
    session_id: `session:${host}`, prompt: "Continue the exact task." };
  const scope = { host, entityId: null, groupId: null,
    projectId: "project:turn-binding", currentTaskId: "task:turn-binding" };
  return { root, env, input, scope, sourcePath, sourceBytes };
}

async function prepare(setup, input) {
  const resolvedSources = await resolveHostSourceCatalog({ host: setup.scope.host,
    cwd: setup.root, input, env: setup.env });
  const preflight = await runPreflight({ ...setup, input, resolvedSources, prompt: input.prompt });
  return { resolvedSources, preflight };
}

function native(setup, input) {
  const env = { ...setup.env };
  if (setup.scope.host === "codex") {
    env.PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
    delete env.CLAUDE_PLUGIN_ROOT;
  } else {
    env.CLAUDE_PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
    delete env.PLUGIN_ROOT;
  }
  delete env.BLUN_PLUGIN_ROOT;
  const child = spawnSync(process.execPath, [HOOK], { cwd: setup.root, env,
    input: JSON.stringify(input), encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

test("Codex binds identical prompts to its supported turn_id", async (t) => {
  const setup = await fixture(t, "codex");
  const firstInput = { ...setup.input, turn_id: "turn:codex-one" };
  const secondInput = { ...setup.input, turn_id: "turn:codex-two" };
  const first = await prepare(setup, firstInput);
  const second = await prepare(setup, secondInput);
  assert.equal(first.preflight.receipt.deliveryId, firstInput.turn_id);
  assert.equal(second.preflight.receipt.deliveryId, secondInput.turn_id);
  assert.notEqual(first.preflight.receipt.id, second.preflight.receipt.id);
  assert.equal(await verifyPreflightReceipt({ ...setup, input: firstInput,
    resolvedSources: first.resolvedSources, receipt: first.preflight.receipt,
    prompt: firstInput.prompt, consume: true }), true);
  assert.equal(await verifyPreflightReceipt({ ...setup, input: secondInput,
    resolvedSources: second.resolvedSources, receipt: first.preflight.receipt,
    prompt: secondInput.prompt }), false);
  await assert.rejects(prepare(setup, { ...firstInput }), /replay/);
});

test("Claude identical prompts receive distinct process-local invocation bindings", async (t) => {
  const setup = await fixture(t, "claude");
  const firstInput = { ...setup.input };
  const first = await prepare(setup, firstInput);
  assert.match(first.preflight.receipt.deliveryId, /^hook-invocation:[a-f0-9]{32}$/);
  assert.equal(preflightDeliveryId({ ...firstInput }), null,
    "copied host JSON cannot reconstruct the invocation capability");
  assert.equal(await verifyPreflightReceipt({ ...setup, input: firstInput,
    resolvedSources: first.resolvedSources, receipt: first.preflight.receipt,
    prompt: firstInput.prompt, consume: true }), true);
  const secondInput = { ...setup.input };
  const second = await prepare(setup, secondInput);
  assert.notEqual(second.preflight.receipt.deliveryId, first.preflight.receipt.deliveryId);
  assert.equal(await verifyPreflightReceipt({ ...setup, input: secondInput,
    resolvedSources: second.resolvedSources, receipt: second.preflight.receipt,
    prompt: secondInput.prompt, consume: true }), true);
});

test("all supplied host identifiers are bound together", () => {
  const input = { turn_id: "turn:one", event_id: "event:one" };
  const id = preflightDeliveryId(input, { issue: true });
  assert.match(id, /^host-turn:[a-f0-9]{32}$/);
  assert.equal(preflightDeliveryId(input), id);
  assert.notEqual(preflightDeliveryId({ ...input, event_id: "event:two" }), id);
  assert.throws(() => preflightDeliveryId({ turn_id: 7 }, { issue: true }), /turnId/);
});

test("native prompt hooks accept legitimate repeats and reject a reused Codex turn", async (t) => {
  const claude = await fixture(t, "claude");
  const firstClaude = native(claude, claude.input);
  const secondClaude = native(claude, claude.input);
  assert.equal(firstClaude.decision, undefined);
  assert.equal(secondClaude.decision, undefined);
  assert.equal(typeof firstClaude.hookSpecificOutput.additionalContext, "string");
  assert.equal(typeof secondClaude.hookSpecificOutput.additionalContext, "string");

  const codex = await fixture(t, "codex");
  const firstInput = { ...codex.input, turn_id: "turn:native-one" };
  const secondInput = { ...codex.input, turn_id: "turn:native-two" };
  assert.equal(native(codex, firstInput).decision, undefined);
  assert.equal(native(codex, secondInput).decision, undefined);
  const replay = native(codex, firstInput);
  assert.equal(replay.decision, "block");
  assert.match(replay.reason, /delivery replay/);
  assert.deepEqual(await readFile(claude.sourcePath), claude.sourceBytes);
  assert.deepEqual(await readFile(codex.sourcePath), codex.sourceBytes);
});
