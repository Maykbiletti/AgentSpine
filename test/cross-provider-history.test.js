import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { TIMELINE_CROSS_PROVIDER_ENV } from "../src/lib/session-timeline-provider.js";
import {
  TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV
} from "../src/lib/session-timeline-transport.js";
import { fixture, processCall } from "./mcp-bounded-fixture.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

const CLAUDE_SESSION = "session:handoff-claude-a";
const CODEX_SESSION = "session:handoff-codex-b";
const AT = "2026-09-06T09:40:00.000Z";
const SCOPE = {
  entityId: "agent:provider-handoff", userId: "person:synthetic-handoff",
  tenantId: "tenant:synthetic-handoff", projectId: "project:synthetic-handoff",
  currentTaskId: "task:synthetic-handoff", goalId: "goal:synthetic-handoff",
  goalStepId: "step:verify", groupId: null, timelineVisibility: "private-verified"
};

function line(value) { return `${JSON.stringify(value)}\n`; }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function hookScope(overrides = {}) {
  const value = { ...SCOPE, ...overrides };
  return { entity_id: value.entityId, user_id: value.userId, tenant_id: value.tenantId,
    project_id: value.projectId, task_id: value.currentTaskId, goal_id: value.goalId,
    goal_step_id: value.goalStepId, group_id: value.groupId };
}

async function setup(t) {
  const f = await fixture(t, { homeRoot: false });
  const claudeDirectory = join(process.env.CLAUDE_CONFIG_DIR, "projects", "provider-handoff");
  const codexDirectory = join(process.env.CODEX_HOME, "sessions", "2026", "09", "06");
  await Promise.all([mkdir(claudeDirectory, { recursive: true }), mkdir(codexDirectory, { recursive: true })]);
  const claudePath = join(claudeDirectory, "session-a.jsonl");
  const codexPath = join(codexDirectory, "session-b.jsonl");
  const claudeBytes = Buffer.from(line({ timestamp: AT, message: { role: "tool",
    content: "Measured provider handoff Suite 0; result: FAIL 0/15." } }));
  const codexBytes = Buffer.from(line({ timestamp: AT, type: "session_meta", payload: {
    id: CODEX_SESSION, session_id: CODEX_SESSION, cwd: f.root, cli_version: "0.0.0",
    originator: "codex_cli_rs", source: "cli", history_mode: "legacy" } }));
  await Promise.all([writeFile(claudePath, claudeBytes), writeFile(codexPath, codexBytes)]);
  const values = {
    [TIMELINE_TRANSPORT_CAPABILITY_ENV]: `astc_${randomBytes(32).toString("base64url")}`,
    [TIMELINE_TRANSPORT_SESSION_ENV]: CLAUDE_SESSION
  };
  const previous = Object.fromEntries([...Object.keys(values), TIMELINE_CROSS_PROVIDER_ENV]
    .map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  delete process.env[TIMELINE_CROSS_PROVIDER_ENV];
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { ...f, claudePath, codexPath, claudeBytes, codexBytes };
}

async function enroll(f, host, sessionId, transcriptPath) {
  process.env[TIMELINE_TRANSPORT_SESSION_ENV] = sessionId;
  const hostHome = host === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  const result = await enrollTimelineWithHostReceipt({ root: f.root, host, sessionId, scope: SCOPE,
    transcriptPath, hostHome });
  assert.equal(result.status, "enrolled", JSON.stringify(result));
}

async function guard(f, host, sessionId, tool, fields, overrides = {}) {
  const result = await runHook({ hook_event_name: "PreToolUse", host, cwd: f.root, session_id: sessionId,
    tool_use_id: `tool:${randomBytes(8).toString("hex")}`,
    tool_name: `mcp__plugin_agent-spine_agent-spine__session_timeline_${tool}`,
    tool_input: { root: f.root, ...fields }, ...hookScope(overrides) });
  return result;
}

async function prepare(f) {
  await enroll(f, "claude", CLAUDE_SESSION, f.claudePath);
  const indexGuard = await guard(f, "claude", CLAUDE_SESSION, "index", { maxBytes: 16 * 1024 * 1024 });
  assert.equal(indexGuard.blocked, false, indexGuard.reason);
  assert.equal((await processCall(f.root, "session_timeline_index", indexGuard.updatedInput)).status, "indexed");
  await enroll(f, "codex", CODEX_SESSION, f.codexPath);
}

const searchFields = { at: AT, query: "Suite FAIL", includePriorSessions: true,
  includePriorProviders: true };

test("an opted-in Codex session recalls one Claude result with provider provenance after restart", async t => {
  const f = await setup(t);
  const beforeClaude = digest(await readFile(f.claudePath));
  const beforeCodex = digest(await readFile(f.codexPath));
  await prepare(f);

  const denied = await guard(f, "codex", CODEX_SESSION, "search", searchFields);
  assert.equal(denied.blocked, true);
  assert.match(denied.reason, /not enabled by this local host/);
  process.env[TIMELINE_CROSS_PROVIDER_ENV] = "1";

  const sameProviderOnly = await guard(f, "codex", CODEX_SESSION, "search",
    { at: AT, query: "Suite FAIL", includePriorSessions: true });
  assert.equal(sameProviderOnly.blocked, true, "the default must not silently mix providers");
  for (const event of ["SessionStart", "PostCompact"]) {
    const result = await runHook({ hook_event_name: event, host: "codex", cwd: f.root,
      session_id: CODEX_SESSION, ...hookScope() });
    assert.equal(result.blocked, false);
    const timeline = JSON.parse(result.context).sourceResolution.timeline;
    assert.equal(timeline.priorSessions.latest.sourceProvider, "claude");
  }

  const guarded = await guard(f, "codex", CODEX_SESSION, "search", searchFields);
  assert.equal(guarded.blocked, false, guarded.reason);
  const found = await processCall(f.root, "session_timeline_search", guarded.updatedInput);
  assert.equal(found.status, "found", JSON.stringify(found));
  assert.equal(found.sourceProvider, "claude");
  assert.equal(found.priorProvider, true);
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].sourceProvider, "claude");
  assert.equal(found.events[0].outcome, "fail");
  assert.deepEqual(found.events[0].count, { value: 0, total: 15 });
  assert.match(found.events[0].sessionRef, /^session-ref:[a-f0-9]{32}$/);
  assert.match(found.events[0].excerpt, /FAIL 0\/15/);
  assert.equal(found.events[0].authority, "context-only");
  const replay = await processCall(f.root, "session_timeline_search", guarded.updatedInput);
  assert.equal(replay.status, undefined);
  assert.equal(replay.blocked, true);
  assert.equal(digest(await readFile(f.claudePath)), beforeClaude);
  assert.equal(digest(await readFile(f.codexPath)), beforeCodex);
  await f.preserve();
});

test("cross-provider selection rejects missing coupling, foreign scope, groups and changed sources", async t => {
  const f = await setup(t);
  await prepare(f);
  process.env[TIMELINE_CROSS_PROVIDER_ENV] = "1";

  const uncoupled = await guard(f, "codex", CODEX_SESSION, "search",
    { at: AT, query: "Suite FAIL", includePriorProviders: true });
  assert.equal(uncoupled.blocked, true);
  for (const overrides of [{ tenantId: "tenant:foreign" }, { projectId: "project:foreign" },
    { currentTaskId: "task:foreign" }, { groupId: "group:foreign" }]) {
    const result = await guard(f, "codex", CODEX_SESSION, "search", searchFields, overrides);
    assert.equal(result.blocked, true);
    assert.doesNotMatch(result.reason, /Measured provider handoff/);
  }

  const guarded = await guard(f, "codex", CODEX_SESSION, "search", searchFields);
  assert.equal(guarded.blocked, false, guarded.reason);
  await writeFile(f.claudePath, Buffer.concat([f.claudeBytes, Buffer.from(line({ timestamp: AT,
    message: { role: "tool", content: "Measured injected Suite 0; result: PASS 15/15." } }))]));
  const changed = await processCall(f.root, "session_timeline_search", guarded.updatedInput);
  assert.notEqual(changed.status, "found");
  assert.equal(changed.events?.length || 0, 0);
  assert.doesNotMatch(JSON.stringify(changed), /Measured|injected|PASS 15\/15/);
  assert.deepEqual(await readFile(f.codexPath), f.codexBytes);
  await f.preserve();
});
