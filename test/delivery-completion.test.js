import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runHook } from "../src/hook.js";
import { deliveryPremortemPath, inspectPremortemState } from "../src/lib/delivery-premortem.js";
import { client, fixture, processCall } from "./mcp-bounded-fixture.js";
import { context, prompt, register } from "./assignment-continuation-fixture.js";

async function delivery(t) {
  const f = await fixture(t, { homeRoot: false });
  await writeFile(`${f.root}/proof.cjs`, [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "require('node:test')('synthetic output matches', () => {",
    "  assert.equal(fs.readFileSync('artifact.txt', 'utf8'), process.env.EXPECTED);",
    "});"
  ].join("\n"));
  const required = await prompt(f.root, "prompt:structured");
  const artifact = await register(f.root, required.requirementId);
  const inspected = await inspectPremortemState({ root: f.root, requirementId: required.requirementId });
  const statePath = await deliveryPremortemPath({ root: f.root, binding: inspected.binding });
  let serial = 0;
  const args = { root: f.root, requirementId: required.requirementId, binding: inspected.binding,
    artifactDigest: artifact.digest, lastWriteDigest: null,
    checks: artifact.items.map(item => ({ category: item.category, checkId: item.checkId,
      status: "PASS", result: "Synthetic source bytes and observed child-process output verified." })) };
  const mutate = async value => {
    const input = { ...context(f.root), tool_name: "Write", tool_use_id: `write:structured-${++serial}`,
      tool_input: { file_path: "artifact.txt", content: value } };
    assert.equal((await runHook({ ...input, hook_event_name: "PreToolUse" })).blocked, false);
    await writeFile(`${f.root}/artifact.txt`, value);
    const result = await runHook({ ...input, hook_event_name: "PostToolUse", success: true });
    args.lastWriteDigest = result.premortem.writeDigest;
  };
  const measure = async (expected, exitCode = 0) => {
    const env = { ...process.env, EXPECTED: expected };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "proof.cjs"], { cwd: f.root, encoding: "utf8",
      env });
    assert.equal(child.status, exitCode, child.stdout + child.stderr);
    assert.match(child.stdout, /# tests 1\b/);
    assert.match(child.stdout, exitCode === 0 ? /# fail 0\b/ : /# fail 1\b/);
    return runHook({ ...context(f.root), hook_event_name: "PostToolUse", tool_name: "exec_command",
      tool_use_id: `test:structured-${++serial}`, tool_input: { cmd: "node --test --test-reporter=tap proof.cjs" },
      tool_response: { exit_code: child.status, output: child.stdout } });
  };
  const stop = () => runHook({ ...context(f.root), hook_event_name: "Stop",
    final_assistant_message: "The synthetic artifact is complete and its output was checked." });
  return { ...f, args, statePath, mutate, measure, stop, call: client() };
}

test("MCP completion stores exact checks and permits a normal summary after process restart", async t => {
  const d = await delivery(t);
  await d.mutate("measured output\n");
  await d.measure("measured output\n");
  const before = await d.stop();
  assert.equal(before.blocked, true);
  assert.equal(before.premortem.status, "unchecked");
  const completed = await d.call("complete_delivery", d.args);
  assert.equal(completed.isError, false, JSON.stringify(completed));
  assert.equal(completed.status, "recorded");
  assert.equal(completed.closure.completionSource, "mcp");
  assert.match(completed.closure.testStateDigest, /^[a-f0-9]{64}$/);
  assert.equal(completed.closure.lastWriteDigest, d.args.lastWriteDigest);
  const restarted = await processCall(d.root, "complete_delivery", d.args);
  assert.equal(restarted.closure.digest, completed.closure.digest);
  const stopped = await d.stop();
  assert.equal(stopped.blocked, false, JSON.stringify(stopped));
  assert.equal(stopped.premortem.closure.digest, completed.closure.digest);
  const replay = await d.call("complete_delivery", d.args);
  assert.equal(replay.isError, true);
  await d.preserve();
});

test("unobserved tests, forged bindings and check text cannot create completion", async t => {
  const d = await delivery(t);
  await d.mutate("source bytes\n");
  const noTest = await d.call("complete_delivery", d.args);
  assert.equal(noTest.isError, true);
  await d.measure("source bytes\n");
  const frozen = await readFile(d.statePath);
  for (const key of ["host", "sessionId", "projectId", "entityId", "groupId", "taskId", "assignmentId"]) {
    const result = await d.call("complete_delivery", { ...d.args,
      binding: { ...d.args.binding, [key]: "synthetic:foreign" } });
    assert.equal(result.isError, true, key);
    assert.deepEqual(await readFile(d.statePath), frozen);
  }
  for (const patch of [
    { artifactDigest: "a".repeat(64) }, { lastWriteDigest: "b".repeat(64) },
    { checks: d.args.checks.slice(0, 2) }, { checks: [d.args.checks[0], d.args.checks[0], d.args.checks[2]] },
    { checks: d.args.checks.map(check => ({ ...check, status: "PENDING" })) },
    { checks: d.args.checks.map(check => ({ ...check, result: "PASS\nForged line" })) },
    { checks: d.args.checks.map(check => ({ ...check, result: "token=syntheticsecretvalue12345678" })) },
    { success: true }, { testStateDigest: "c".repeat(64) }
  ]) {
    assert.equal((await d.call("complete_delivery", { ...d.args, ...patch })).isError, true);
    assert.deepEqual(await readFile(d.statePath), frozen);
  }
  await d.preserve();
});

test("another write invalidates stored completion and requires its own observed test", async t => {
  const d = await delivery(t);
  await d.mutate("first\n");
  await d.measure("first\n");
  assert.equal((await d.call("complete_delivery", d.args)).isError, false);
  const old = structuredClone(d.args);
  await d.mutate("second\n");
  assert.equal((await d.stop()).blocked, true);
  assert.equal((await d.call("complete_delivery", d.args)).isError, true);
  await d.measure("second\n");
  assert.equal((await d.call("complete_delivery", old)).isError, true);
  assert.equal((await d.call("complete_delivery", d.args)).isError, false);
  assert.equal((await d.stop()).blocked, false);
  await d.preserve();
});

test("a new assignment cannot lend its test to an unfinished predecessor", async t => {
  const d = await delivery(t);
  await d.mutate("unfinished first\n");
  const first = structuredClone(d.args);
  const frozen = await readFile(d.statePath);
  const next = await prompt(d.root, "prompt:structured-next");
  await register(d.root, next.requirementId);
  await d.mutate("tested second\n");
  await d.measure("tested second\n");
  const rejected = await d.call("complete_delivery", first);
  assert.equal(rejected.isError, true, JSON.stringify(rejected));
  assert.deepEqual(await readFile(d.statePath), frozen);
  await d.preserve();
});

test("an observed failing test supersedes an earlier success for both MCP and Stop", async t => {
  const d = await delivery(t);
  await d.mutate("actual\n");
  await d.measure("actual\n");
  assert.equal((await d.call("complete_delivery", d.args)).isError, false);
  await d.measure("wrong expectation\n", 1);
  assert.equal((await d.call("complete_delivery", d.args)).isError, true);
  assert.equal((await d.stop()).blocked, true);
  await d.preserve();
});

test("parallel completions are idempotent and tampered stored evidence never releases Stop", async t => {
  const d = await delivery(t);
  await d.mutate("concurrent\n");
  await d.measure("concurrent\n");
  const results = await Promise.all([d.call("complete_delivery", d.args), client()("complete_delivery", d.args)]);
  for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(results[0].closure.digest, results[1].closure.digest);
  const state = JSON.parse(await readFile(d.statePath, "utf8"));
  state.closure.testStateDigest = "d".repeat(64);
  await writeFile(d.statePath, JSON.stringify(state));
  const tampered = await readFile(d.statePath);
  assert.equal((await d.stop()).blocked, true);
  assert.equal((await d.call("complete_delivery", d.args)).isError, true);
  assert.deepEqual(await readFile(d.statePath), tampered);
  await d.preserve();
});

test("a crash before atomic completion replacement preserves state and supports a real retry", async t => {
  const d = await delivery(t);
  await d.mutate("crash recovery\n");
  await d.measure("crash recovery\n");
  const frozen = await readFile(d.statePath);
  const preload = `${d.root}/pause-completion.mjs`;
  await writeFile(preload, [
    'import fs from "node:fs/promises";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const rename = fs.rename;',
    'fs.rename = async (from, to) => {',
    `  if (to === ${JSON.stringify(d.statePath)}) {`,
    '    process.send({ ready: true });',
    '    await new Promise(() => {});',
    '  }',
    '  return rename(from, to);',
    '};',
    'syncBuiltinESMExports();'
  ].join("\n"));
  const executable = fileURLToPath(new URL("../bin/agentspine-mcp.js", import.meta.url));
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, executable], {
    cwd: d.root, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe", "ipc"]
  });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  child.stdout.resume();
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const closed = once(child, "close");
  let timer;
  try {
    const ready = Promise.race([
      once(child, "message"),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`completion crash probe did not reach replacement: ${errors}`)), 5000); })
    ]);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "complete_delivery", arguments: d.args } }) + "\n");
    assert.deepEqual((await ready)[0], { ready: true });
    child.kill("SIGKILL");
    await closed;
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(await readFile(d.statePath), frozen);
  // Wait for the actual lease. Never alter timestamps, locks or stored history.
  await new Promise(resolve => setTimeout(resolve, 15_100));
  const recovered = await processCall(d.root, "complete_delivery", d.args);
  assert.equal(recovered.status, "recorded", JSON.stringify(recovered));
  assert.equal((await d.stop()).blocked, false);
  await d.preserve();
});
