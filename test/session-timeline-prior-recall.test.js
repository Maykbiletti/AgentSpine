import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { startMcpServer } from "../src/mcp.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

const SESSION_A = "session:prior-recall-a";
const SESSION_B = "session:prior-recall-b";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function scope(overrides = {}) {
  return {
    entityId: "agent:prior-recall", userId: "person:prior-recall", tenantId: "tenant:prior-recall",
    projectId: "project:prior-recall", currentTaskId: "task:prior-recall", goalId: "goal:prior-recall",
    goalStepId: "step:measure", groupId: null, timelineVisibility: "private-verified", ...overrides
  };
}

function hookScope(overrides = {}) {
  const value = scope(overrides);
  return { entity_id: value.entityId, user_id: value.userId, tenant_id: value.tenantId,
    project_id: value.projectId, task_id: value.currentTaskId, goal_id: value.goalId,
    goal_step_id: value.goalStepId, group_id: value.groupId };
}

function client(environment = process.env) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let sequence = 0;
  let buffer = "";
  const pending = new Map();
  output.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output, { environment });
  return (name, args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timed out`)), 4_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(JSON.parse(result.content[0].text)); });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
}

function priorTranscript() {
  const lessons = ["baseline", "contract", "delivery", "outcome"].map((kind, index) => ({
    timestamp: `2026-09-04T${String(8 + index).padStart(2, "0")}:10:00.000Z`,
    message: { role: "tool", content: `Measured old archive ${kind} lesson; result: FAIL 0/1.` }
  }));
  const target = { timestamp: "2026-09-04T12:40:11.000Z", message: { role: "tool",
    content: "Measured CSS archive Suite 0; result: FAIL 0/15." } };
  const links = Array.from({ length: 2500 }, (_, index) => ({
    timestamp: "2026-09-04T12:41:00.000Z", type: "memory-link",
    memory_link: { id: `memory:prior:${index}` }, payload: "x".repeat(1800)
  }));
  return [...lessons, target, ...links].map((item) => JSON.stringify(item)).join("\n") + "\n";
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-prior-recall-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const sessions = join(profile, "projects", "prior-recall");
  const transcriptA = join(sessions, "session-a.jsonl");
  const transcriptB = join(sessions, "session-b.jsonl");
  await Promise.all([mkdir(state), mkdir(join(project, ".git"), { recursive: true }), mkdir(sessions, { recursive: true })]);
  await Promise.all([
    writeFile(join(project, "AGENTS.md"), "# Synthetic prior-session recall project\n"),
    writeFile(transcriptA, priorTranscript()),
    writeFile(transcriptB, `${JSON.stringify({ timestamp: "2026-09-04T13:00:00.000Z",
      message: { role: "user", content: "Continue the archive after restart." } })}\n`)
  ]);
  const names = ["AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "AGENTSPINE_TIMELINE_SESSION_CAPABILITY",
    "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_A;
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, profile, transcriptA, transcriptB };
}

function toolInput(item, sessionId, toolUseId, fields, overrides = {}) {
  return { hook_event_name: "PreToolUse", host: "claude", cwd: item.project, session_id: sessionId,
    tool_use_id: toolUseId,
    tool_name: fields.maxBytes
      ? "mcp__plugin_agent-spine_agent-spine__session_timeline_index"
      : "mcp__plugin_agent-spine_agent-spine__session_timeline_search",
    tool_input: fields, ...hookScope(overrides) };
}

async function enroll(item, sessionId, transcriptPath) {
  const result = await enrollTimelineWithHostReceipt({ root: item.project, sessionId, scope: scope(),
    transcriptPath, hostHome: item.profile });
  assert.equal(result.status, "enrolled", result.reason);
}

test("a restarted task recalls one indexed prior-session result with stable source references", async (t) => {
  const item = await fixture(t);
  const beforeA = sha256(await readFile(item.transcriptA));
  const beforeB = sha256(await readFile(item.transcriptB));
  await enroll(item, SESSION_A, item.transcriptA);
  const indexGuard = await runHook(toolInput(item, SESSION_A, "tool:prior:index", { maxBytes: 16 * 1024 * 1024 }));
  assert.equal(indexGuard.blocked, false, indexGuard.reason);
  const indexed = await client()("session_timeline_index", indexGuard.updatedInput);
  assert.equal(indexed.status, "indexed", JSON.stringify(indexed));
  assert.equal(indexed.events, 5);

  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_B;
  await enroll(item, SESSION_B, item.transcriptB);
  const lifecycleInput = { host: "claude", cwd: item.project, session_id: SESSION_B,
    transcript_path: item.transcriptB, ...hookScope() };
  const startedAt = Date.now();
  const started = await runHook({ hook_event_name: "SessionStart", ...lifecycleInput });
  assert.equal(started.blocked, false);
  assert.ok(Date.now() - startedAt < 2_000, "restart hint must not scan either transcript");
  const timeline = JSON.parse(started.context).sourceResolution.timeline;
  assert.equal(timeline.priorSessions.available, true);
  assert.equal(timeline.priorSessions.sessions, 1);
  assert.equal(timeline.priorSessions.indexedEvents, 5);
  assert.doesNotMatch(started.context, /Measured CSS archive Suite 0/);

  const fields = { at: "2026-09-04T12:40:11.000Z", windowSeconds: 0 };
  const currentGuard = await runHook(toolInput(item, SESSION_B, "tool:prior:before", fields));
  assert.equal(currentGuard.blocked, false, currentGuard.reason);
  const before = await client()("session_timeline_search", currentGuard.updatedInput);
  assert.equal(before.status, "not-found", JSON.stringify(before));

  const priorGuard = await runHook(toolInput(item, SESSION_B, "tool:prior:after",
    { ...fields, includePriorSessions: true }));
  assert.equal(priorGuard.blocked, false, priorGuard.reason);
  const found = await client()("session_timeline_search", priorGuard.updatedInput);
  assert.equal(found.status, "found", JSON.stringify(found));
  assert.equal(found.mode, "prior-verified-index");
  assert.equal(found.priorSession, true);
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].outcome, "fail");
  assert.deepEqual(found.events[0].count, { value: 0, total: 15 });
  assert.equal(found.events[0].testLabel, "suite-0");
  assert.match(found.events[0].sessionRef, /^session-ref:[a-f0-9]{32}$/);
  assert.equal(found.events[0].messageRef, found.events[0].id);
  assert.equal(found.events[0].excerpt, "Measured CSS archive Suite 0; result: FAIL 0/15.");
  assert.equal(found.events[0].trust, "untrusted-session-history");
  assert.equal(found.events[0].authority, "context-only");

  const replay = await client()("session_timeline_search", priorGuard.updatedInput);
  assert.equal(replay.blocked, true);
  const compacted = await runHook({ hook_event_name: "PostCompact", ...lifecycleInput, transcript_path: undefined });
  assert.equal(JSON.parse(compacted.context).sourceResolution.timeline.priorSessions.sessions, 1);
  assert.equal(sha256(await readFile(item.transcriptA)), beforeA, "prior transcript stays byte-identical");
  assert.equal(sha256(await readFile(item.transcriptB)), beforeB, "current transcript stays byte-identical");
});

test("prior-session recall rejects foreign tasks and groups before returning evidence", async (t) => {
  const item = await fixture(t);
  await enroll(item, SESSION_A, item.transcriptA);
  const indexGuard = await runHook(toolInput(item, SESSION_A, "tool:prior:scope-index", { maxBytes: 16 * 1024 * 1024 }));
  await client()("session_timeline_index", indexGuard.updatedInput);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_B;
  await enroll(item, SESSION_B, item.transcriptB);
  const fields = { query: "Suite FAIL", includePriorSessions: true };
  const foreignTask = await runHook(toolInput(item, SESSION_B, "tool:prior:foreign-task", fields,
    { currentTaskId: "task:foreign" }));
  assert.equal(foreignTask.blocked, true);
  assert.equal(foreignTask.updatedInput, undefined);
  const group = await runHook(toolInput(item, SESSION_B, "tool:prior:group", fields, { groupId: "group:foreign" }));
  assert.equal(group.blocked, true);
  assert.equal(group.updatedInput, undefined);
  assert.doesNotMatch(`${foreignTask.reason}\n${group.reason}`, /Measured CSS archive/);
});

test("changed prior transcript is rejected before any historical content is returned", async (t) => {
  const item = await fixture(t);
  await enroll(item, SESSION_A, item.transcriptA);
  const indexGuard = await runHook(toolInput(item, SESSION_A, "tool:prior:tamper-index", { maxBytes: 16 * 1024 * 1024 }));
  await client()("session_timeline_index", indexGuard.updatedInput);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_B;
  await enroll(item, SESSION_B, item.transcriptB);
  await writeFile(item.transcriptA, `${priorTranscript()}${JSON.stringify({ timestamp: "2026-09-04T12:50:00.000Z",
    message: { role: "tool", content: "Measured injected Suite 0; result: PASS 15/15." } })}\n`);
  const guarded = await runHook(toolInput(item, SESSION_B, "tool:prior:tampered",
    { query: "Suite FAIL", includePriorSessions: true }));
  assert.equal(guarded.blocked, true);
  assert.equal(guarded.updatedInput, undefined);
  assert.doesNotMatch(guarded.reason, /Measured|injected|PASS 15\/15/);
});
