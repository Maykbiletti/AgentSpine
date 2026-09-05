import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/hook.js";
import {
  deliveryToolActions, deliveryVerificationPath, recordDeliveryPause,
  recordDeliveryToolUse, recordDeliveryWriteIntent, verifyDeliveryStop
} from "../src/lib/delivery-verification.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-delivery-gate-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-delivery-state-"));
  const host = await mkdtemp(join(tmpdir(), "agentspine-delivery-host-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  const source = "# Synthetic rules\n\nKeep this source byte-exact.\n";
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([rm(root, { recursive: true, force: true }),
      rm(state, { recursive: true, force: true }), rm(host, { recursive: true, force: true })]);
  });
  return { root, state, host, source };
}

function post(root, session, toolName, toolInput, success, toolUseId) {
  return runHook({
    hook_event_name: "PostToolUse", host: "codex", cwd: root, session_id: session,
    tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId,
    success, tool_response: success ? { exit_code: 0 } : { exit_code: 1 }
  });
}

function stop(root, session, event = "Stop") {
  return runHook({ hook_event_name: event, host: "codex", cwd: root,
    session_id: session, event_id: `stop:${session}:${event}` });
}

test("Stop blocks delivery until a successful test follows the latest write", async (t) => {
  const { root, source } = await fixture(t);
  const session = "session:verification";
  const untouched = await stop(root, "session:no-write");
  assert.equal(untouched.blocked, false);
  assert.equal(untouched.deliveryVerification.status, "no-write");

  const written = await post(root, session, "Write", { file_path: "artifact.txt", content: "synthetic\n" },
    true, "tool:write:one");
  assert.equal(written.deliveryVerification.status, "write-recorded");
  assert.equal(written.deliveryVerification.pending, true);
  const denied = await stop(root, session);
  assert.equal(denied.blocked, true);
  assert.match(denied.reason, /successful test after the latest write/);

  const failed = await post(root, session, "exec_command", { cmd: "node --test test/synthetic.test.js" },
    false, "tool:test:failed");
  assert.equal(failed.deliveryVerification.status, "test-failed");
  assert.equal((await stop(root, session)).blocked, true);

  const passed = await post(root, session, "exec_command", { cmd: "node --test test/synthetic.test.js" },
    true, "tool:test:passed");
  assert.equal(passed.deliveryVerification.status, "test-recorded");
  assert.equal(passed.deliveryVerification.pending, false);
  const allowed = await stop(root, session);
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.deliveryVerification.status, "verified");

  await post(root, session, "Bash", { command: "rg TODO src" }, true, "tool:read:after-test");
  assert.equal((await stop(root, session)).blocked, false, "read-only inspection must not invalidate tests");
  await post(root, session, "apply_patch", { patch: "synthetic" }, true, "tool:write:two");
  assert.equal((await stop(root, session, "SubagentStop")).blocked, true);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("a paused Stop cannot bypass a later completion check", async (t) => {
  const { root } = await fixture(t);
  const sessionId = "session:pause-is-not-proof";
  await post(root, sessionId, "Write", { file_path: "artifact.txt", content: "synthetic\n" },
    true, "tool:pause-write");
  const paused = await recordDeliveryPause({ root, host: "codex", sessionId, scope: {}, eventId: null });
  assert.equal(paused.status, "paused-job");
  const completed = await verifyDeliveryStop({ root, host: "codex", sessionId, scope: {}, eventId: null });
  assert.equal(completed.blocked, true);
  assert.match(completed.reason, /successful test after the latest write/);
});

test("a same-event pause is idempotent but a later write intent revokes it", async (t) => {
  const { root } = await fixture(t);
  const sessionId = "session:pause-write-intent";
  const eventId = "stop:pause-write-intent";
  const argumentsForStop = { root, host: "codex", sessionId, scope: {}, eventId };

  assert.equal((await recordDeliveryPause(argumentsForStop)).status, "paused-job");
  assert.equal((await recordDeliveryPause(argumentsForStop)).status, "paused-job",
    "repeating the exact pause event remains idempotent");
  assert.equal((await verifyDeliveryStop(argumentsForStop)).status, "paused-job");

  const intent = await recordDeliveryWriteIntent({ root, host: "codex", sessionId, scope: {},
    input: { tool_name: "Write", tool_use_id: "tool:pause-write-intent",
      tool_input: { file_path: "artifact.txt", content: "synthetic\\n" } } });
  assert.equal(intent.status, "intent-recorded");

  const completion = await verifyDeliveryStop(argumentsForStop);
  assert.equal(completion.blocked, true);
  assert.match(completion.reason, /write intent\(s\).*no auditable PostToolUse result/);
  assert.notEqual(completion.status, "paused-job");
});

test("compound shell order, task restart, and concurrent duplicate delivery stay exact", async (t) => {
  const { root, source } = await fixture(t);
  const scope = { entityId: "agent:synthetic", tenantId: "tenant:synthetic", groupId: "group:synthetic",
    projectId: "project:synthetic", currentTaskId: "task:synthetic", queueId: "queue:synthetic",
    gatewayAttempt: 3, goalId: "goal:synthetic", goalStepId: "step:synthetic",
    planDefinitionsDigest: "a".repeat(64) };
  const input = { tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ artifact.css && npm test" },
    tool_use_id: "tool:compound:one", timestamp: "2033-01-01T00:00:00.000Z" };
  const results = await Promise.all(Array.from({ length: 6 }, () => recordDeliveryToolUse({
    root, host: "claude", sessionId: "session:before-restart", scope, input, success: true
  })));
  assert.equal(results.filter((result) => result.status === "write-recorded").length, 1);
  assert.equal(results.filter((result) => result.status === "duplicate").length, 5);
  assert.equal(
    await deliveryVerificationPath({ root, host: "claude", sessionId: "session:before-restart", scope }),
    await deliveryVerificationPath({ root, host: "claude", sessionId: "session:after-restart", scope })
  );
  const resumed = await verifyDeliveryStop({ root, host: "claude",
    sessionId: "session:after-restart", scope });
  assert.equal(resumed.blocked, false);
  assert.equal(resumed.status, "verified");

  const reversed = { tool_name: "Bash", tool_input: { command: "npm test && sed -i s/b/c/ artifact.css" },
    tool_use_id: "tool:compound:two", timestamp: "2033-01-01T00:00:01.000Z" };
  await recordDeliveryToolUse({ root, host: "claude", sessionId: "session:after-restart",
    scope, input: reversed, success: true });
  assert.equal((await verifyDeliveryStop({ root, host: "claude",
    sessionId: "session:third", scope })).blocked, true);
  assert.equal((await verifyDeliveryStop({ root, host: "claude", sessionId: "session:third",
    scope: { ...scope, gatewayAttempt: 4 } })).status, "no-write",
  "a different queue attempt must not inherit an earlier delivery");
  assert.equal((await verifyDeliveryStop({ root, host: "claude", sessionId: "session:third",
    scope: { ...scope, groupId: "group:foreign" } })).status, "no-write",
  "a foreign group must not inherit an exact delivery attempt");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("tampered state and conflicting tool receipts block cleanly instead of killing Stop", async (t) => {
  const { root, state, host, source } = await fixture(t);
  const session = "session:tamper";
  await post(root, session, "Write", { file_path: "artifact.txt" }, true, "tool:tamper:write");
  await post(root, session, "Bash", { command: "pytest -q" }, true, "tool:tamper:test");
  const path = await deliveryVerificationPath({ root, host: "codex", sessionId: session, scope: {} });
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.lastWrite.eventDigest = "f".repeat(64);
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
  const blocked = await stop(root, session);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /integrity validation/);

  const installed = spawnSync(process.execPath, [join(pluginRoot, "src", "hook.js")], {
    cwd: root, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "Stop", host: "codex", cwd: root,
      session_id: session, event_id: "stop:tampered:installed" }),
    env: { ...process.env, AGENTSPINE_STATE_DIR: state, CODEX_HOME: host }
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).decision, "block");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("only explicit write and test commands affect delivery verification", () => {
  assert.deepEqual(deliveryToolActions({ tool_name: "Read", tool_input: { file_path: "a.js" } }), []);
  assert.deepEqual(deliveryToolActions({ tool_name: "Bash", tool_input: { command: "rg test src" } }), []);
  assert.deepEqual(deliveryToolActions({ tool_name: "exec_command", tool_input: { cmd: "python -m pytest -q" } })
    .map((item) => [item.kind, item.family]), [["test", "pytest"]]);
  assert.deepEqual(deliveryToolActions({ tool_name: "Bash", tool_input: { command: "npm run check" } })
    .map((item) => [item.kind, item.family]), [["test", "npm-check"]]);
  for (const command of ["echo npm test", "npm test || true", "npm test; exit 0", "npm test | cat"]) {
    assert.deepEqual(deliveryToolActions({ tool_name: "exec_command", tool_input: { command } }), []);
  }
  assert.deepEqual(deliveryToolActions({ tool_name: "exec_command",
    tool_input: { command: "touch synthetic.txt && npm test -- --test-name-pattern smoke" } })
    .map((item) => item.kind), ["write", "test"]);
});
