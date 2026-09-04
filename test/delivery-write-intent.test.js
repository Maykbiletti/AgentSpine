import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/hook.js";
import {
  deliveryActorSession, deliverySuccessEvidence, deliveryToolActions,
  deliveryVerificationPath, recordDeliveryToolUse, recordDeliveryWriteIntent, verifyDeliveryStop
} from "../src/lib/delivery-verification.js";
import {
  closedPremortemForGoal, inspectDeliveryPremortems, recordDeliveryPremortem
} from "../src/lib/delivery-premortem.js";

const HOOK_PATH = fileURLToPath(new URL("../src/hook.js", import.meta.url));
const PROJECT_ID = "project:write-intent";

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-write-intent-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n\nKeep this byte-exact.\n", "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  return { root, state };
}

function lane(root, session, turn, agent = null) {
  return {
    host: "codex", cwd: root, session_id: session, turn_id: turn,
    ...(agent ? { agent_id: agent } : {}),
    agent_spine_scope: { project_id: PROJECT_ID }
  };
}

function premortemItems() {
  return [
    { category: "baseline-environment",
      failure: "this delivery fails because the synthetic baseline is stale",
      check: "Compare the synthetic baseline digest." },
    { category: "contract-tests",
      failure: "this delivery fails because the synthetic contract regresses",
      check: "Run the focused synthetic test." },
    { category: "delivery-path",
      failure: "this delivery fails because the synthetic file is misplaced",
      check: "Verify the synthetic delivery path." }
  ];
}

async function registerPremortem(root, identity) {
  const prompted = await runHook({
    ...identity, hook_event_name: "UserPromptSubmit", event_id: `prompt:${identity.turn_id}`,
    prompt: "Change the synthetic artifact safely."
  });
  const recorded = await recordDeliveryPremortem({
    root, requirementId: prompted.preflight.premortem.requirementId, items: premortemItems()
  });
  assert.equal(recorded.blocked, false);
  return recorded;
}

function closure(recorded, writeDigest) {
  return [
    `Premortem closure sha256 ${recorded.artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...recorded.artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — synthetic check passed`)
  ].join("\n");
}

function installed(state, root, input, args = []) {
  return spawnSync(process.execPath, [HOOK_PATH, ...args], {
    cwd: root, encoding: "utf8", input: JSON.stringify(input),
    env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
}

function installedOversize(state, root, input) {
  const result = installed(state, root, input, ["--silent-oversize-post-tool-use"]);
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr },
    { status: 0, stdout: "", stderr: "" });
}

test("oversized mutating PostToolUse leaves a durable intent until an objective test", async (t) => {
  const { root, state } = await fixture(t);
  const identity = lane(root, "session:oversized-write", "turn:oversized-write", "agent:writer");
  const recorded = await registerPremortem(root, identity);
  const tool = {
    tool_name: "Write", tool_use_id: "tool:oversized-write",
    tool_input: { file_path: "artifact.txt", content: "synthetic\n" }
  };
  const allowed = await runHook({ ...identity, ...tool, hook_event_name: "PreToolUse" });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.deliveryVerification.status, "intent-recorded");
  assert.equal(allowed.premortem.writeIntent, "write-intent-recorded");
  assert.match(allowed.premortem.writeDigest, /^[a-f0-9]{64}$/);
  const installedPre = installed(state, root, { ...identity, ...tool, hook_event_name: "PreToolUse" });
  assert.equal(installedPre.status, 0, installedPre.stderr);
  const intentNotice = JSON.parse(installedPre.stdout).hookSpecificOutput.additionalContext;
  assert.match(intentNotice, /recorded the allowed mutation intent/);
  assert.match(intentNotice, new RegExp(allowed.premortem.writeDigest));

  installedOversize(state, root, {
    ...identity, ...tool, hook_event_name: "PostToolUse", success: true,
    tool_response: { output: "x".repeat(70 * 1024) }
  });
  const stop = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:oversized-write",
    final_assistant_message: "Synthetic delivery complete."
  });
  assert.equal(stop.blocked, true);
  assert.match(stop.reason, /write intent\(s\).*no auditable PostToolUse result/);

  await runHook({
    ...identity, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "tool:unknown-test", tool_input: { cmd: "node --test test/synthetic.test.js" },
    tool_response: { ok: true }
  });
  const derivedSession = deliveryActorSession(identity);
  assert.equal((await verifyDeliveryStop({ root, host: "codex", sessionId: derivedSession,
    scope: { projectId: PROJECT_ID } })).blocked, true, "unknown outcome cannot prove a test passed");
  await runHook({
    ...identity, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "tool:proved-test",
    tool_input: { cmd: "node --test test/synthetic.test.js && printf AGENTSPINE_TEST_OK" },
    tool_response: { content: [{ type: "text", text: "AGENTSPINE_TEST_OK" }] }
  });
  assert.equal((await verifyDeliveryStop({ root, host: "codex", sessionId: derivedSession,
    scope: { projectId: PROJECT_ID } })).blocked, false);
  const closed = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:oversized-write:closed",
    final_assistant_message: closure(recorded, allowed.premortem.writeDigest)
  });
  assert.equal(closed.blocked, false);
  assert.equal(closed.premortem.status, "closed");
});

test("a write without tool_use_id shares one durable intent and an omitted Post still requires a test", async (t) => {
  const { root } = await fixture(t);
  const identity = lane(root, "session:fallback-write", "turn:fallback-write");
  const recorded = await registerPremortem(root, identity);
  const tool = { tool_name: "Write",
    tool_input: { file_path: "fallback.txt", content: "mutated\n" } };
  const preInput = { ...identity, ...tool, hook_event_name: "PreToolUse" };
  const pre = await runHook(preInput);
  assert.equal(pre.blocked, false);
  assert.equal(pre.deliveryVerification.status, "intent-recorded");
  assert.equal(pre.premortem.writeIntent, "write-intent-recorded");

  const verificationPath = await deliveryVerificationPath({ root, host: "codex",
    sessionId: deliveryActorSession(identity), scope: { projectId: PROJECT_ID } });
  const deliveryState = JSON.parse(await readFile(verificationPath, "utf8"));
  const premortemState = (await inspectDeliveryPremortems(root)).states[0];
  assert.equal(deliveryState.pendingWriteIntents[0].idDigest, premortemState.lastWrite.idDigest);

  await writeFile(join(root, "fallback.txt"), "mutated\n", "utf8");
  const denied = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:fallback-write:denied",
    final_assistant_message: closure(recorded, pre.premortem.writeDigest)
  });
  assert.equal(denied.blocked, true);
  assert.match(denied.reason, /write intent\(s\).*no auditable PostToolUse result/);

  await runHook({ ...identity, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "tool:fallback-write:test", tool_input: { cmd: "node --test test/synthetic.test.js" },
    success: true, tool_response: { exit_code: 0 } });
  const allowed = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:fallback-write:allowed",
    final_assistant_message: closure(recorded, pre.premortem.writeDigest)
  });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.deliveryVerification.status, "verified");
  assert.equal(allowed.premortem.status, "closed");
});

test("verified writes fail closed before mutation without a valid host session", async (t) => {
  const { root } = await fixture(t);
  for (const [label, session, reason, status] of [
    ["missing", undefined, /denied this write before mutation.*valid host session_id/, "invalid-session"],
    ["invalid", "bad session", /self-starter denied this effect: sessionId is invalid/, null]
  ]) {
    const input = {
      host: "codex", cwd: root, turn_id: `turn:${label}`,
      agent_spine_scope: { project_id: PROJECT_ID }, hook_event_name: "PreToolUse",
      tool_name: "Write", tool_use_id: `tool:${label}-session-write`,
      tool_input: { file_path: `${label}.txt`, content: "must not run\n" },
      ...(session === undefined ? {} : { session_id: session })
    };
    const denied = await runHook(input);
    assert.equal(denied.blocked, true, label);
    assert.match(denied.reason, reason, label);
    assert.equal(denied.premortem?.status ?? null, status, label);
    assert.equal(denied.deliveryVerification, undefined, label);
    await assert.rejects(readFile(join(root, `${label}.txt`)), { code: "ENOENT" });
  }
});

test("oversized non-mutating PostToolUse stays silent and read-only Stop remains allowed", async (t) => {
  const { root, state } = await fixture(t);
  const identity = lane(root, "session:oversized-read", "turn:oversized-read");
  installedOversize(state, root, {
    ...identity, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "tool:image-read",
    tool_response: { type: "image", data: "a".repeat(70 * 1024) }
  });
  const stopped = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:oversized-read",
    final_assistant_message: "Synthetic read-only answer."
  });
  assert.equal(stopped.blocked, false);
  assert.equal(stopped.deliveryVerification.status, "no-write");
  assert.equal(stopped.premortem.status, "no-write");
});

test("one host session keeps write evidence when Stop omits turn metadata", async (t) => {
  const { root } = await fixture(t);
  const writer = lane(root, "session:shared", "turn:one");
  const recorded = await registerPremortem(root, writer);
  const tool = { tool_name: "Write", tool_use_id: "tool:isolated",
    tool_input: { file_path: "isolated.txt", content: "synthetic\n" } };
  const pre = await runHook({ ...writer, ...tool, hook_event_name: "PreToolUse" });
  assert.equal(pre.blocked, false);
  const verificationPath = await deliveryVerificationPath({ root, host: "codex",
    sessionId: deliveryActorSession(writer), scope: { projectId: PROJECT_ID } });
  const deliveryState = JSON.parse(await readFile(verificationPath, "utf8"));
  const premortemState = (await inspectDeliveryPremortems(root)).states[0];
  assert.equal(deliveryState.pendingWriteIntents[0].idDigest, premortemState.lastWrite.idDigest);
  await runHook({ ...writer, ...tool, hook_event_name: "PostToolUse", success: true,
    tool_response: { exit_code: 0 } });
  const noTurnStop = { ...writer };
  delete noTurnStop.turn_id;
  const denied = await runHook({
    ...noTurnStop, hook_event_name: "Stop", event_id: "stop:without-turn",
    final_assistant_message: closure(recorded, pre.premortem.writeDigest)
  });
  assert.equal(denied.blocked, true);
  assert.match(denied.reason, /successful test after the latest write/);
  const testInput = { hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_input: { cmd: "node --test test/synthetic.test.js" }, success: true,
    tool_response: { isError: false } };
  await runHook({ ...lane(root, "session:other", "turn:sibling", "agent:beta"), ...testInput,
    tool_use_id: "tool:test:other-session" });
  const session = deliveryActorSession(writer);
  assert.equal((await verifyDeliveryStop({ root, host: "codex", sessionId: session,
    scope: { projectId: PROJECT_ID } })).blocked, true);
  await runHook({ ...writer, ...testInput, tool_use_id: "tool:test:writer" });
  assert.equal((await verifyDeliveryStop({ root, host: "codex", sessionId: session,
    scope: { projectId: PROJECT_ID } })).blocked, false);
  assert.equal(session, deliveryActorSession({ ...writer, turn_id: "turn:two" }));
  assert.equal(session, deliveryActorSession({ ...writer, agent_id: "agent:alpha" }));
});

test("redirection and PowerShell mutations share the premortem and delivery contract", async (t) => {
  const { root } = await fixture(t);
  for (const [name, toolName, command] of [
    ["redirect", "Bash", "printf synthetic > artifact.txt"],
    ["powershell", "PowerShell", "Set-Content -Path artifact.txt -Value synthetic"]
  ]) {
    const tool = { tool_name: toolName, tool_use_id: `tool:${name}:write`, tool_input: { command } };
    const missing = lane(root, `session:${name}:missing`, `turn:${name}:missing`);
    const denied = await runHook({ ...missing, ...tool, hook_event_name: "PreToolUse" });
    assert.equal(denied.blocked, true);
    assert.match(denied.reason, /missing premortem/);
    const identity = lane(root, `session:${name}:closed`, `turn:${name}:closed`);
    await registerPremortem(root, identity);
    assert.equal((await runHook({ ...identity, ...tool, hook_event_name: "PreToolUse" })).blocked, false);
    await runHook({ ...identity, ...tool, hook_event_name: "PostToolUse", success: true,
      tool_response: { exit_code: 0 } });
  }
});

test("only explicit delivery outcome evidence satisfies a recognized test", () => {
  assert.equal(deliverySuccessEvidence({ tool_response: { ok: true } }), false);
  assert.equal(deliverySuccessEvidence({ success: true }), true);
  assert.equal(deliverySuccessEvidence({ tool_response: { isError: false } }), true);
  assert.equal(deliverySuccessEvidence({ tool_response: { exit_code: 0 } }), true);
  assert.equal(deliverySuccessEvidence({
    tool_input: { cmd: "node --test test/synthetic.test.js && printf AGENTSPINE_TEST_OK" },
    tool_response: { output: "AGENTSPINE_TEST_OK" }
  }), true);
  assert.equal(deliverySuccessEvidence({ tool_input: { cmd: "node --test test/synthetic.test.js" },
    tool_response: { output: "AGENTSPINE_TEST_OK" } }), false,
  "a failing raw test can print the constant marker and must not certify itself");
  assert.equal(deliverySuccessEvidence({
    tool_input: { cmd: "node --test test/synthetic.test.js && printf AGENTSPINE_TEST_OK" },
    tool_response: { output: "AGENTSPINE_TEST_OK\nsynthetic failure" }
  }), false, "the bound marker must be the final normalized output line");
  assert.equal(deliverySuccessEvidence({
    tool_input: { cmd: "node --test test/synthetic.test.js && printf AGENTSPINE_TEST_OK" },
    tool_response: { content: [{ text: "AGENTSPINE_TEST_OK" }, { text: "synthetic failure" }] }
  }), false, "a later structured output block invalidates an earlier marker");
  assert.equal(deliverySuccessEvidence({ success: true, tool_response: { exit_code: 3,
    output: "AGENTSPINE_TEST_OK" } }), false);
  assert.deepEqual(deliveryToolActions({ tool_name: "exec_command", tool_input: {
    cmd: "node --test test/synthetic.test.js && printf AGENTSPINE_TEST_OK"
  } }).map((item) => item.kind), ["test"]);
  assert.deepEqual(deliveryToolActions({ tool_name: "exec_command", tool_input: {
    cmd: "npm test && node -e \"console.log('AGENTSPINE_TEST_OK')\""
  } }).map((item) => item.kind), ["test"]);
  for (const [tool_name, command] of [["Bash", "printf x > artifact.js"],
    ["exec_command", "python -c \"open('artifact.js', 'w').write('x')\""],
    ["Bash", "python -c \"from pathlib import Path; Path('artifact').write_text('x')\""],
    ["exec_command", "node -e \"require('fs').writeFileSync('artifact.js', 'x')\""],
    ["Bash", "node -e \"require('fs').appendFileSync('artifact.js', 'x')\""],
    ["Bash", "node -e \"require('fs').promises.writeFile('artifact.js', 'x')\""],
    ["Bash", "dd if=input.bin of=artifact.bin"],
    ["PowerShell", "Set-Content -Path artifact.js -Value x"]]) {
    assert.equal(deliveryToolActions({ tool_name, tool_input: { command } })[0]?.kind, "write", command);
  }
  assert.deepEqual(deliveryToolActions({ tool_name: "PowerShell",
    tool_input: { command: "Get-Content artifact.js" } }), []);
  for (const command of ["python -c \"print(2 > 1)\"", "node -e \"console.log(2 > 1)\"",
    "Write-Output 'synthetic > comparison'"]) {
    assert.deepEqual(deliveryToolActions({ tool_name: "PowerShell", tool_input: { command } }), [], command);
  }
});

test("PreToolUse blocks when premortem state conflicts after its initial verification", async (t) => {
  const { root } = await fixture(t);
  const identity = lane(root, "session:intent-race", "turn:intent-race");
  const recorded = await registerPremortem(root, identity);
  const target = join(root, "race.js");
  const tool = { tool_name: "Write", tool_use_id: "tool:intent-race",
    tool_input: { file_path: target, content: "const safe = true;\n" } };
  const denied = await runHook({ ...identity, ...tool, hook_event_name: "PreToolUse" }, {
    afterDeliveryWriteIntent: async () => {
      const conflict = await recordDeliveryPremortem({ root, requirementId: recorded.requirementId,
      items: premortemItems().map((item, index) => index ? item
        : { ...item, failure: `${item.failure} unexpectedly` }) });
      assert.equal(conflict.status, "conflict");
    }
  });
  assert.equal(denied.blocked, true);
  assert.equal(denied.deliveryVerification.status, "intent-recorded");
  assert.equal(denied.premortem.status, "conflict");
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("normal unknown test outcome gives actionable proof guidance and can recover", async (t) => {
  const { root, state } = await fixture(t);
  const identity = lane(root, "session:normal-proof", "turn:normal-proof");
  const recorded = await registerPremortem(root, identity);
  const tool = { tool_name: "Write", tool_use_id: "tool:normal-write",
    tool_input: { file_path: "normal.txt", content: "synthetic\n" } };
  const pre = await runHook({ ...identity, ...tool, hook_event_name: "PreToolUse" });
  await runHook({ ...identity, ...tool, hook_event_name: "PostToolUse", success: true,
    tool_response: { isError: false } });
  const unknown = installed(state, root, {
    ...identity, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "tool:normal-test-unknown", tool_input: { cmd: "npm test" },
    tool_response: { output: "synthetic suite output" }
  });
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(JSON.parse(unknown.stdout).hookSpecificOutput.additionalContext,
    /append && node -e .*AGENTSPINE_TEST_OK/);
  const denied = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:normal-proof:denied",
    final_assistant_message: closure(recorded, pre.premortem.writeDigest)
  });
  assert.equal(denied.blocked, true);
  assert.match(denied.reason, /structured exit_code 0/);

  await runHook({
    ...identity, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "tool:normal-test-proved",
    tool_input: { cmd: "npm test && node -e \"console.log('AGENTSPINE_TEST_OK')\"" },
    tool_response: { output: "synthetic suite output\nAGENTSPINE_TEST_OK\n" }
  });
  const allowed = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:normal-proof:allowed",
    final_assistant_message: closure(recorded, pre.premortem.writeDigest)
  });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.deliveryVerification.status, "verified");
  assert.equal(allowed.premortem.status, "closed");
});

test("legacy verification state upgrades without losing verified delivery evidence", async (t) => {
  const { root } = await fixture(t);
  const session = "session:legacy-upgrade";
  const scope = { projectId: PROJECT_ID };
  await recordDeliveryToolUse({ root, host: "codex", sessionId: session, scope,
    input: { tool_name: "Write", tool_use_id: "tool:legacy-write",
      tool_input: { file_path: "legacy.txt", content: "synthetic\n" } }, success: true });
  await recordDeliveryToolUse({ root, host: "codex", sessionId: session, scope,
    input: { tool_name: "exec_command", tool_use_id: "tool:legacy-test",
      tool_input: { cmd: "node --test test/synthetic.test.js" } }, success: true });
  const path = await deliveryVerificationPath({ root, host: "codex", sessionId: session, scope });
  const state = JSON.parse(await readFile(path, "utf8"));
  delete state.pendingWriteIntents;
  const material = {
    schema: state.schema, laneDigest: state.laneDigest, revision: state.revision,
    lastWrite: state.lastWrite, lastTest: state.lastTest,
    verifiedWriteDigest: state.verifiedWriteDigest, pauseEventDigest: state.pauseEventDigest,
    conflict: state.conflict, recentEvents: state.recentEvents, authority: "verification-state-only"
  };
  state.integrityDigest = createHash("sha256").update(JSON.stringify(material)).digest("hex");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const upgraded = await verifyDeliveryStop({ root, host: "codex", sessionId: session, scope });
  assert.equal(upgraded.blocked, false);
  assert.equal(upgraded.status, "verified");
});

test("task-bound verification remains isolated by host session without turn metadata", async (t) => {
  const { root } = await fixture(t);
  const scope = { entityId: "agent:synthetic", projectId: PROJECT_ID, currentTaskId: "task:shared" };
  const write = { tool_name: "Write", tool_use_id: "tool:task-session-write",
    tool_input: { file_path: "session.txt", content: "synthetic\n" } };
  await recordDeliveryWriteIntent({ root, host: "claude", sessionId: "session:writer-a", scope, input: write });
  await recordDeliveryToolUse({ root, host: "claude", sessionId: "session:writer-b", scope,
    input: { tool_name: "exec_command", tool_use_id: "tool:other-session-test",
      tool_input: { cmd: "npm test" } }, success: true });
  const writer = await verifyDeliveryStop({
    root, host: "claude", sessionId: "session:writer-a", scope
  });
  assert.equal(writer.blocked, true);
  assert.match(writer.reason, /write intent\(s\)/);
  assert.equal((await verifyDeliveryStop({
    root, host: "claude", sessionId: "session:writer-b", scope
  })).status, "no-write");
});

test("a consumed goal-step premortem blocks a stale worker before its effect", async (t) => {
  const { root } = await fixture(t);
  const digest = "a".repeat(64);
  const identity = {
    ...lane(root, "session:goal-consumed", "turn:goal-consumed"),
    agent_spine_scope: {
      project_id: PROJECT_ID, goal_id: "goal:consumed", goal_step_id: "step:consumed",
      queue_id: "queue:consumed", plan_definitions_digest: digest, gateway_attempt: 1
    }
  };
  const recorded = await registerPremortem(root, identity);
  const first = { tool_name: "Write", tool_use_id: "tool:goal:first",
    tool_input: { file_path: "goal.txt", content: "synthetic\n" } };
  const pre = await runHook({ ...identity, ...first, hook_event_name: "PreToolUse" });
  await runHook({ ...identity, ...first, hook_event_name: "PostToolUse", success: true,
    tool_response: { exit_code: 0 } });
  await runHook({ ...identity, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "tool:goal:test", tool_input: { cmd: "npm test" }, success: true,
    tool_response: { exit_code: 0 } });
  const stopped = await runHook({
    ...identity, hook_event_name: "Stop", event_id: "stop:goal:first",
    final_assistant_message: closure(recorded, pre.premortem.writeDigest)
  });
  assert.equal(stopped.blocked, false);
  assert.equal((await closedPremortemForGoal({
    root, goalId: "goal:consumed", goalStepId: "step:consumed",
    queueId: "queue:consumed", gatewayAttempt: 1
  })).status, "closed");
  const stale = await runHook({
    ...identity, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "tool:goal:stale", tool_input: { file_path: "late.txt", content: "late\n" }
  });
  assert.equal(stale.blocked, true);
  assert.equal(stale.premortem.status, "finalized");
  assert.match(stale.reason, /already consumed/);
});
