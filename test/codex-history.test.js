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
import { TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV } from "../src/lib/session-timeline-transport.js";

const SCOPE = { entityId: "agent:codex-history", userId: "person:synthetic", tenantId: "tenant:synthetic",
  projectId: "project:synthetic", currentTaskId: "task:synthetic", groupId: null, goalId: null, goalStepId: null };
const AT = "2026-09-06T06:40:00.000Z";
const line = value => `${JSON.stringify(value)}\n`;

async function setup(t) {
  const f = await fixture(t, { homeRoot: false });
  const values = { [TIMELINE_TRANSPORT_CAPABILITY_ENV]: `astc_${randomBytes(32).toString("base64url")}`,
    [TIMELINE_TRANSPORT_SESSION_ENV]: "session:codex-a", AGENTSPINE_HOST: "codex" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const directory = join(process.env.CODEX_HOME, "sessions", "2026", "09", "06");
  await mkdir(directory, { recursive: true });
  return { ...f, directory, profile: process.env.CODEX_HOME };
}

async function transcript(f, session, records = [], metadata = {}) {
  const path = join(f.directory, `${session.replaceAll(":", "-")}.jsonl`);
  const bytes = Buffer.from(line({ timestamp: AT, type: "session_meta", payload: {
    id: session, session_id: session, cwd: f.root, cli_version: "0.0.0", originator: "codex_cli_rs",
    source: "cli", history_mode: "legacy", ...metadata } }) + records.map(line).join(""));
  await writeFile(path, bytes);
  return { path, bytes };
}

const measured = { timestamp: AT, type: "response_item", payload: { type: "function_call_output",
  call_id: "call_synthetic_result", output: "Measured Suite 0; result FAIL 0/15. Preserve backup before migration." } };

async function enroll(f, session, source) {
  process.env[TIMELINE_TRANSPORT_SESSION_ENV] = session;
  return enrollTimelineWithHostReceipt({ root: f.root, host: "codex", sessionId: session,
    scope: SCOPE, transcriptPath: source.path, hostHome: f.profile });
}

function guardedInput(f, session, tool, fields = {}) {
  const input = { hook_event_name: "PreToolUse", host: "codex", cwd: f.root, session_id: session,
    tool_use_id: `tool:${randomBytes(8).toString("hex")}`, tool_name: `mcp__agent-spine__session_timeline_${tool}`,
    entity_id: SCOPE.entityId, user_id: SCOPE.userId, tenant_id: SCOPE.tenantId,
    project_id: SCOPE.projectId, task_id: SCOPE.currentTaskId, group_id: null,
    tool_input: { root: f.root, ...fields } };
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../src/hook.js", import.meta.url))],
    { cwd: f.root, env: process.env, input: JSON.stringify(input), encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  if (!result.hookSpecificOutput?.updatedInput) throw new Error(JSON.stringify(result));
  assert.equal(result.hookSpecificOutput.permissionDecision, undefined, "native permissions stay with Codex");
  return result.hookSpecificOutput.updatedInput;
}

async function lookup(f, session, tool, fields = {}) {
  const args = guardedInput(f, session, tool, fields);
  assert.ok(args, "native PreToolUse must bind the Codex invocation");
  assert.equal(args.host, "codex");
  const result = await processCall(f.root, `session_timeline_${tool}`, args);
  assert.equal(result.isError, false);
  return result;
}

test("Codex session B finds only A's registered tool evidence after a native hook and MCP restart", async t => {
  const f = await setup(t);
  const a = await transcript(f, "session:codex-a", [
    { timestamp: AT, type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "Suite 0 PASS 15/15 claimed without a test." }] } }, measured]);
  assert.equal((await enroll(f, "session:codex-a", a)).status, "enrolled");
  assert.equal((await lookup(f, "session:codex-a", "index")).status, "indexed");
  const b = await transcript(f, "session:codex-b");
  assert.equal((await enroll(f, "session:codex-b", b)).status, "enrolled");
  for (const event of ["SessionStart", "PostCompact"]) {
    const result = await runHook({ hook_event_name: event, host: "codex", cwd: f.root,
      session_id: "session:codex-b", entity_id: SCOPE.entityId, user_id: SCOPE.userId,
      tenant_id: SCOPE.tenantId, project_id: SCOPE.projectId, task_id: SCOPE.currentTaskId });
    assert.equal(result.blocked, false);
  }
  const found = await lookup(f, "session:codex-b", "search", { query: "Suite result", at: AT, includePriorSessions: true });
  assert.equal(found.status, "found", JSON.stringify(found));
  assert.equal(found.mode, "prior-verified-index");
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].outcome, "fail");
  assert.equal(found.events[0].nativeMessageId, "call_synthetic_result");
  assert.match(found.events[0].excerpt, /FAIL 0\/15/);
  assert.ok(found.events[0].sessionRef);
  assert.ok(found.events[0].messageRef);
  assert.match(found.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(a.path), a.bytes);
  assert.deepEqual(await readFile(b.path), b.bytes);
  await f.preserve();
});

test("Codex registration rejects foreign roots, session identities and unsupported inherited formats", async t => {
  const f = await setup(t);
  for (const [name, metadata] of [
    ["foreign-root", { cwd: f.foreign }], ["foreign-session", { id: "session:foreign" }],
    ["future-mode", { history_mode: "future-v999" }], ["paginated", { history_mode: "paginated" }],
    ["inherited", { history_base: { thread_id: "session:private" } }],
    ["future-schema", { schema_version: 999 }]
  ]) {
    const session = `session:${name}`;
    const source = await transcript(f, session, [measured], metadata);
    const result = await enroll(f, session, source);
    assert.equal(result.status, "unavailable", name);
    assert.deepEqual(await readFile(source.path), source.bytes);
  }
  await f.preserve();
});


test("Codex invocation cannot replay or cross scope and changed sources remain unreadable", async t => {
  const f = await setup(t);
  const session = "session:codex-a";
  const a = await transcript(f, session, [measured]);
  assert.equal((await enroll(f, session, a)).status, "enrolled");
  const input = guardedInput(f, session, "index");
  const results = await Promise.all([processCall(f.root, "session_timeline_index", input),
    processCall(f.root, "session_timeline_index", input)]);
  assert.equal(results.filter(r => r.status === "indexed").length, 1);
  assert.equal(results.filter(r => r.reason === "timeline-invocation-unavailable").length, 1);
  for (const fields of [{ projectId: "project:foreign" }, { tenantId: "tenant:foreign" },
    { groupId: "group:private" }, { host: "claude" }, { root: f.foreign }]) {
    assert.throws(() => guardedInput(f, session, "search", { at: AT, ...fields }), /block/);
  }
  const search = guardedInput(f, session, "search", { at: AT });
  const changed = Buffer.from(a.bytes.toString().replace("FAIL 0/15", "PASS 0/15"));
  await writeFile(a.path, changed);
  const unavailable = await processCall(f.root, "session_timeline_search", search);
  assert.notEqual(unavailable.status, "found");
  assert.equal(unavailable.events?.length || 0, 0);
  assert.deepEqual(await readFile(a.path), changed);
  await f.preserve();
});

test("Codex indexes no model claims or secrets and rejects unknown rollout records", async t => {
  const f = await setup(t);
  const source = await transcript(f, "session:codex-a", [measured,
    { ...measured, payload: { ...measured.payload, output: "Suite 0 PASS 15/15 password=synthetic" } },
    { timestamp: AT, type: "event_msg", payload: { type: "agent_message", message: "Suite 0 PASS 15/15" } }]);
  assert.equal((await enroll(f, "session:codex-a", source)).status, "enrolled");
  await lookup(f, "session:codex-a", "index");
  const found = await lookup(f, "session:codex-a", "search", { at: AT });
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].outcome, "fail");
  const unknown = await transcript(f, "session:unknown", [{ timestamp: AT, type: "future_record_v999", payload: {} }]);
  assert.equal((await enroll(f, "session:unknown", unknown)).status, "enrolled");
  const indexed = await lookup(f, "session:unknown", "index");
  assert.equal(indexed.status, "unavailable");
  assert.deepEqual(await readFile(unknown.path), unknown.bytes);
  assert.deepEqual(await readFile(source.path), source.bytes);
  await f.preserve();
});
