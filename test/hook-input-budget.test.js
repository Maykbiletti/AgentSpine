import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("..", import.meta.url));
const hook = join(plugin, "src/hook.js");
const events = ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "spine-input-budget-"));
  const state = join(root, "state");
  await mkdir(state);
  const source = Buffer.from("# Synthetic rules\nGröße, Prüfsumme und ursprüngliche Bytes erhalten.\n");
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, state, source };
}
function execute(item, input, args = [], host = "claude") {
  const env = { ...process.env, AGENTSPINE_STATE_DIR: item.state };
  for (const key of ["BLUN_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"]) delete env[key];
  env[host === "king" ? "BLUN_PLUGIN_ROOT" : host === "codex" ? "PLUGIN_ROOT" : "CLAUDE_PLUGIN_ROOT"] = plugin;
  return spawnSync(process.execPath, [hook, ...args], {
    input, encoding: "utf8", cwd: item.root, env, timeout: 5000
  });
}
function exactInput(bytes, kind = "text", event = "UserPromptSubmit") {
  const payload = kind === "text"
    ? { hook_event_name: event, prompt: "" }
    : { hook_event_name: event, prompt: "Bild prüfen", images: [{ data: "" }] };
  const padding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(payload)));
  if (kind === "text") payload.prompt = padding;
  else payload.images[0].data = padding;
  const input = JSON.stringify(payload);
  assert.equal(Buffer.byteLength(input), bytes);
  return input;
}

test("all shipped context commands continue oversized text and images without partial memory writes", async (t) => {
  const item = await fixture(t);
  for (const [host, path] of [["claude", "hooks/hooks.json"], ["codex", "hooks/codex.json"], ["king", "blun.plugin.json"]]) {
    const manifest = JSON.parse(await readFile(join(plugin, path), "utf8"));
    for (const event of events) {
      const command = host === "king" ? manifest.hooks.find((h) => h.event === event).command
        : manifest.hooks[event][0].hooks[0].command;
      const args = command.slice(command.lastIndexOf('"') + 1).trim().split(/\s+/).filter(Boolean);
      assert.deepEqual(args, [`--context-event=${event}`]);
      for (const kind of ["text", "image"]) {
        for (const bytes of [65537, 128 * 1024, 2 * 1024 * 1024]) {
          const input = exactInput(bytes, kind, event);
          const result = execute(item, input, args, host);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, "");
          const output = JSON.parse(result.stdout);
          assert.equal(output.decision, undefined);
          assert.equal(output.hookSpecificOutput.hookEventName, event);
          assert.match(output.hookSpecificOutput.additionalContext, /unavailable|unverified/);
          assert.match(output.hookSpecificOutput.message, /input.*budget/i);
          assert.doesNotMatch(result.stdout, /x{100}|AgentSpine ready/);
          assert.ok(Buffer.byteLength(result.stdout) < 1200);
        }
      }
    }
  }
  assert.deepEqual(await readFile(join(item.root, "AGENTS.md")), item.source);
  assert.deepEqual(await readdir(item.state), []);
});

test("context mode never grants a tool bypass or accepts malformed small input", async (t) => {
  const item = await fixture(t);
  for (const [input, args] of [
    [exactInput(70000), []],
    [exactInput(70000), ["--context-event=PreToolUse"]],
    [JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write" }), ["--context-event=UserPromptSubmit"]],
    ['{"hook_event_name":"UserPromptSubmit",', ["--context-event=UserPromptSubmit"]]
  ]) {
    const result = execute(item, input, args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(await readdir(item.state), []);
});

test("64 KiB boundary counts UTF-8 bytes and preserves complete small payloads", async () => {
  const { readHookInput } = await import("../src/lib/hook-input.js");
  const { Readable } = await import("node:stream");
  for (const bytes of [65535, 65536]) {
    const original = exactInput(bytes).replace("xx", "ü");
    assert.equal(Buffer.byteLength(original), bytes);
    const parsed = await readHookInput({ stream: Readable.from([Buffer.from(original)]), contextEvent: "UserPromptSubmit" });
    assert.deepEqual(parsed, JSON.parse(original));
  }
});

test("oversized context input returns without waiting for the rest of stdin", async () => {
  const { readHookInput, OVERSIZE_CONTEXT_INPUT } = await import("../src/lib/hook-input.js");
  const { Readable } = await import("node:stream");
  let sent = false;
  const stream = new Readable({ read() {
    if (!sent) { sent = true; this.push(Buffer.alloc(65537)); }
    // Deliberately never send EOF: the host can still be writing a large payload.
  } });
  try {
    const result = await Promise.race([
      readHookInput({ stream, contextEvent: "UserPromptSubmit" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("waited for stdin EOF")), 500))
    ]);
    assert.equal(result, OVERSIZE_CONTEXT_INPUT);
  } finally {
    stream.destroy();
  }
});
