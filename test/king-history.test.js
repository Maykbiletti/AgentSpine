import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fixture, processCall } from "./mcp-bounded-fixture.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";
import { runHook } from "../src/hook.js";
import { KING_TIMELINE_SOURCE_ENV, KING_WIRE_PROTOCOL_ENV } from "../src/lib/session-timeline-provider.js";
import { TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV } from "../src/lib/session-timeline-transport.js";

const SCOPE = { entityId: "agent:king-history", userId: "person:synthetic", tenantId: "tenant:synthetic",
  projectId: "project:synthetic", currentTaskId: "task:synthetic", groupId: null, goalId: null, goalStepId: null };
const PROTOCOL = "synthetic-king-wire-v1";
const AT_MS = Date.parse("2026-09-06T08:40:00.000Z");
const line = value => `${JSON.stringify(value)}\n`;

async function setup(t) {
  const f = await fixture(t, { homeRoot: false });
  const profile = join(f.home, ".king");
  await mkdir(join(profile, "sessions", "2026", "09", "06"), { recursive: true });
  const values = { BLUN_HOME: profile, BLUN_PLUGIN_ROOT: join(profile, "plugins", "agent-spine"),
    [KING_WIRE_PROTOCOL_ENV]: PROTOCOL,
    [TIMELINE_TRANSPORT_CAPABILITY_ENV]: `astc_${randomBytes(32).toString("base64url")}`,
    [TIMELINE_TRANSPORT_SESSION_ENV]: "session_king-a", AGENTSPINE_HOST: "codex",
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1", AGENTSPINE_ENTITY_ID: SCOPE.entityId,
    AGENTSPINE_USER_ID: SCOPE.userId, AGENTSPINE_TENANT_ID: SCOPE.tenantId,
    AGENTSPINE_PROJECT_ID: SCOPE.projectId, AGENTSPINE_TASK_ID: SCOPE.currentTaskId };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { ...f, profile };
}

async function wire(f, sessionId, records = [], protocol = PROTOCOL) {
  const directory = join(f.profile, "sessions", "2026", "09", "06", sessionId, "agents", "main");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "wire.jsonl");
  const bytes = Buffer.from(line({ type: "metadata", protocol_version: protocol, created_at: AT_MS, time: AT_MS })
    + records.map(line).join(""));
  await writeFile(path, bytes);
  return { path, bytes };
}

const measured = { type: "context.append_loop_event", time: AT_MS,
  event: { type: "tool.result", parentUuid: "step:synthetic", toolCallId: "tool:king-result",
    result: { output: "Measured Suite 0; result FAIL 0/15. Keep the verified backup.", isError: true, exitCode: 1 } } };

async function enroll(f, sessionId, source) {
  process.env[TIMELINE_TRANSPORT_SESSION_ENV] = sessionId;
  process.env[KING_TIMELINE_SOURCE_ENV] = source.path;
  return enrollTimelineWithHostReceipt({ root: f.root, host: "king", sessionId,
    scope: SCOPE, transcriptPath: source.path, hostHome: f.profile });
}

function guardedInput(f, sessionId, tool, fields = {}) {
  const input = { hook_event_name: "PreToolUse", host: "codex", cwd: f.root, session_id: sessionId,
    tool_use_id: `tool:${randomBytes(8).toString("hex")}`,
    tool_name: `mcp__agent-spine__session_timeline_${tool}`,
    entity_id: SCOPE.entityId, user_id: SCOPE.userId, tenant_id: SCOPE.tenantId,
    project_id: SCOPE.projectId, task_id: SCOPE.currentTaskId, group_id: null,
    tool_input: { root: f.root, ...fields } };
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../src/hook.js", import.meta.url))],
    { cwd: f.root, env: process.env, input: JSON.stringify(input), encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.hookSpecificOutput?.permissionDecision, undefined, "King keeps native permission ownership");
  if (!result.hookSpecificOutput?.updatedInput) throw new Error(JSON.stringify(result));
  return result.hookSpecificOutput.updatedInput;
}

async function lookup(f, sessionId, tool, fields = {}) {
  const args = guardedInput(f, sessionId, tool, fields);
  assert.equal(args.host, "king");
  const result = await processCall(f.root, `session_timeline_${tool}`, args);
  assert.equal(result.isError, false);
  return result;
}

test("King session B recalls only A's objective wire result after restart and compaction", async t => {
  const f = await setup(t);
  const a = await wire(f, "session_king-a", [
    { type: "context.append_message", time: AT_MS, message: { role: "assistant",
      content: "Suite 0 PASS 15/15 claimed by a model." } }, measured]);
  const enrolledA = await enroll(f, "session_king-a", a);
  assert.equal(enrolledA.status, "enrolled", JSON.stringify(enrolledA));
  assert.equal((await lookup(f, "session_king-a", "index")).status, "indexed");
  const b = await wire(f, "session_king-b");
  assert.equal((await enroll(f, "session_king-b", b)).status, "enrolled");
  for (const event of ["SessionStart", "PostCompact"]) {
    const result = await runHook({ hook_event_name: event, host: "codex", cwd: f.root,
      session_id: "session_king-b", entity_id: SCOPE.entityId, user_id: SCOPE.userId,
      tenant_id: SCOPE.tenantId, project_id: SCOPE.projectId, task_id: SCOPE.currentTaskId });
    assert.equal(result.blocked, false);
  }
  const found = await lookup(f, "session_king-b", "search",
    { query: "Suite result", at: new Date(AT_MS).toISOString(), includePriorSessions: true });
  assert.equal(found.status, "found", JSON.stringify(found));
  assert.equal(found.mode, "prior-verified-index");
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].outcome, "fail");
  assert.equal(found.events[0].nativeMessageId, "tool:king-result");
  assert.match(found.events[0].excerpt, /FAIL 0\/15/);
  assert.ok(found.events[0].sessionRef);
  assert.ok(found.events[0].messageRef);
  assert.deepEqual(await readFile(a.path), a.bytes);
  assert.deepEqual(await readFile(b.path), b.bytes);
  await f.preserve();
});

test("King rejects wrong versions, paths, scopes, replay, mutations and unknown records", async t => {
  const f = await setup(t);
  const wrong = await wire(f, "session_wrong-version", [measured], "future-v999");
  assert.equal((await enroll(f, "session_wrong-version", wrong)).status, "unavailable");
  const sessionId = "session_king-a";
  const source = await wire(f, sessionId, [measured]);
  const enrolled = await enroll(f, sessionId, source);
  assert.equal(enrolled.status, "enrolled", JSON.stringify(enrolled));
  const first = guardedInput(f, sessionId, "index");
  const replay = await Promise.all([processCall(f.root, "session_timeline_index", first),
    processCall(f.root, "session_timeline_index", first)]);
  assert.equal(replay.filter(item => item.status === "indexed").length, 1);
  assert.equal(replay.filter(item => item.reason === "timeline-invocation-unavailable").length, 1);
  for (const fields of [{ projectId: "project:foreign" }, { tenantId: "tenant:foreign" },
    { groupId: "group:foreign" }, { host: "codex" }, { root: f.foreign }]) {
    assert.throws(() => guardedInput(f, sessionId, "search", { at: new Date(AT_MS).toISOString(), ...fields }), /block/);
  }
  const search = guardedInput(f, sessionId, "search", { at: new Date(AT_MS).toISOString() });
  const changed = Buffer.from(source.bytes.toString().replace("FAIL 0/15", "PASS 0/15"));
  await writeFile(source.path, changed);
  const unavailable = await processCall(f.root, "session_timeline_search", search);
  assert.notEqual(unavailable.status, "found");
  const future = await wire(f, "session_future", [{ type: "future.record", time: AT_MS }]);
  assert.equal((await enroll(f, "session_future", future)).status, "enrolled");
  assert.equal((await lookup(f, "session_future", "index")).status, "unavailable");
  assert.deepEqual(await readFile(future.path), future.bytes);
  await f.preserve();
});
