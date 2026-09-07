import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { runHook } from "../src/hook.js";
import { startMcpServer } from "../src/mcp.js";
import { channelTimelineContinuity } from "../src/lib/channel-continuity.js";
import { gatewayEnvironmentContext } from "../src/lib/hook-context.js";
import { priorTimelineSources } from "../src/lib/session-timeline-prior.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

const execute = promisify(execFile);

const SCOPE = {
  entityId: "agent:portal", userId: "person:portal", tenantId: "tenant:portal",
  projectId: "project:portal", currentTaskId: "task:portal", goalId: "goal:portal",
  goalStepId: "step:resume", groupId: null, timelineVisibility: "private-verified"
};
const ENV_NAMES = [
  "AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "AGENTSPINE_TIMELINE_SESSION_CAPABILITY",
  "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID", "AGENTSPINE_GATEWAY_CONTEXT",
  "AGENTSPINE_ENTITY_ID", "AGENTSPINE_USER_ID", "AGENTSPINE_TENANT_ID",
  "AGENTSPINE_PROJECT_ID", "AGENTSPINE_TASK_ID", "AGENTSPINE_GOAL_ID",
  "AGENTSPINE_GOAL_STEP_ID", "AGENTSPINE_HOST", "AGENTSPINE_CHANNEL_EVENT_ID",
  "AGENTSPINE_CHANNEL_PROVIDER", "AGENTSPINE_PORTAL_REF", "AGENTSPINE_THREAD_REF"
];

function channel(threadId, overrides = {}) {
  return {
    provider: "blun", tenantId: SCOPE.tenantId, accountId: "account:portal",
    bindingId: "binding:portal", chatId: "chat:mayk", threadId,
    sessionKey: "portal:mayk:work", agentId: SCOPE.entityId, projectId: SCOPE.projectId,
    groupId: null, ...overrides
  };
}

function hookScope() {
  return {
    entity_id: SCOPE.entityId, user_id: SCOPE.userId, tenant_id: SCOPE.tenantId,
    project_id: SCOPE.projectId, task_id: SCOPE.currentTaskId, goal_id: SCOPE.goalId,
    goal_step_id: SCOPE.goalStepId, group_id: null
  };
}

function setGatewayRoute(route) {
  Object.assign(process.env, {
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_ENTITY_ID: SCOPE.entityId,
    AGENTSPINE_USER_ID: SCOPE.userId,
    AGENTSPINE_TENANT_ID: SCOPE.tenantId,
    AGENTSPINE_PROJECT_ID: SCOPE.projectId,
    AGENTSPINE_TASK_ID: SCOPE.currentTaskId,
    AGENTSPINE_GOAL_ID: SCOPE.goalId,
    AGENTSPINE_GOAL_STEP_ID: SCOPE.goalStepId,
    AGENTSPINE_HOST: "claude",
    AGENTSPINE_PORTAL_REF: route.portalRef,
    AGENTSPINE_THREAD_REF: route.threadRef
  });
}

function mcpClient(environment = process.env) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let sequence = 0; let buffer = "";
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
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(JSON.parse(result.content[0].text));
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
}

function toolInput(item, sessionId, toolUseId, fields) {
  return {
    hook_event_name: "PreToolUse", host: "claude", cwd: item.project,
    session_id: sessionId, tool_use_id: toolUseId,
    tool_name: fields.maxBytes
      ? "mcp__plugin_agent-spine_agent-spine__session_timeline_index"
      : "mcp__plugin_agent-spine_agent-spine__session_timeline_search",
    tool_input: fields, ...hookScope()
  };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-portal-thread-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const transcripts = join(profile, "projects", "portal");
  await Promise.all([mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(transcripts, { recursive: true })]);
  await writeFile(join(project, "AGENTS.md"), "# Synthetic portal continuity\n");
  const paths = {
    prior: join(transcripts, "prior.jsonl"),
    foreign: join(transcripts, "foreign.jsonl"),
    current: join(transcripts, "current.jsonl")
  };
  await Promise.all([
    writeFile(paths.prior, `${JSON.stringify({ timestamp: "2026-09-07T00:10:00.000Z",
      message: { role: "tool", content: "Measured portal archive Suite 0; result: FAIL 0/15." } })}\n`),
    writeFile(paths.foreign, `${JSON.stringify({ timestamp: "2026-09-07T00:11:00.000Z",
      message: { role: "tool", content: "Measured foreign archive Suite 0; result: PASS 15/15." } })}\n`),
    writeFile(paths.current, `${JSON.stringify({ timestamp: "2026-09-07T00:12:00.000Z",
      message: { role: "user", content: "Continue the exact portal thread." } })}\n`)
  ]);
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    AGENTSPINE_STATE_DIR: state, CLAUDE_CONFIG_DIR: profile,
    AGENTSPINE_TIMELINE_SESSION_CAPABILITY: `astc_${randomBytes(32).toString("base64url")}`
  });
  t.after(async () => {
    for (const name of ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, profile, paths };
}

async function enrollAndIndex(item, sessionId, path, route, label) {
  setGatewayRoute(route);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = sessionId;
  const enrolled = await enrollTimelineWithHostReceipt({
    root: item.project, sessionId, scope: SCOPE, transcriptPath: path, hostHome: item.profile
  });
  assert.equal(enrolled.status, "enrolled", enrolled.reason);
  const guarded = await runHook(toolInput(item, sessionId, `tool:${label}:index`, { maxBytes: 65536 }));
  assert.equal(guarded.blocked, false, guarded.reason);
  const indexed = await mcpClient()("session_timeline_index", guarded.updatedInput);
  assert.equal(indexed.status, "indexed", JSON.stringify(indexed));
}

test("portal timeline resumes only the exact authenticated thread across sessions", async (t) => {
  const item = await fixture(t);
  const routeA = channelTimelineContinuity(channel("thread:work"));
  const routeB = channelTimelineContinuity(channel("thread:other"));
  assert.notDeepEqual(routeA, routeB);
  const sourceBytes = await Promise.all(Object.values(item.paths).map((path) => readFile(path)));

  const legacy = { host: "claude", entityId: SCOPE.entityId, userId: SCOPE.userId,
    tenantId: SCOPE.tenantId, projectId: SCOPE.projectId, taskId: SCOPE.currentTaskId,
    groupId: null, goalId: SCOPE.goalId, goalStepId: SCOPE.goalStepId };
  const legacyCandidates = priorTimelineSources({ sources: [
    { binding: { ...legacy, sessionId: "session:prior" }, updatedAt: "2026-09-07T00:10:00.000Z", events: [] },
    { binding: { ...legacy, sessionId: "session:foreign" }, updatedAt: "2026-09-07T00:11:00.000Z", events: [] }
  ] }, { ...legacy, sessionId: "session:current" });
  assert.equal(legacyCandidates.length, 2, "the old binding cannot distinguish two portal threads");

  await enrollAndIndex(item, "session:prior", item.paths.prior, routeA, "prior");
  await enrollAndIndex(item, "session:foreign", item.paths.foreign, routeB, "foreign");
  setGatewayRoute(routeA);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:current";
  const enrolled = await enrollTimelineWithHostReceipt({
    root: item.project, sessionId: "session:current", scope: SCOPE,
    transcriptPath: item.paths.current, hostHome: item.profile
  });
  assert.equal(enrolled.status, "enrolled", enrolled.reason);

  const lifecycle = { host: "claude", cwd: item.project, session_id: "session:current",
    transcript_path: item.paths.current, ...hookScope() };
  const startedAt = performance.now();
  const started = await runHook({ hook_event_name: "SessionStart", ...lifecycle });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(started.blocked, false);
  assert.ok(elapsedMs < 2_000);
  const timeline = JSON.parse(started.context).sourceResolution.timeline;
  assert.equal(timeline.priorSessions.sessions, 1);
  assert.equal(timeline.priorSessions.latest.threadRef, routeA.threadRef);

  const freshCode = `
    import { sessionTimelineLifecycleHint } from "./src/lib/session-timeline.js";
    const scope = JSON.parse(process.env.SYNTHETIC_SCOPE);
    console.log(JSON.stringify(await sessionTimelineLifecycleHint({
      root: process.env.SYNTHETIC_PROJECT, host: "claude",
      sessionId: "session:current", scope, environment: process.env
    })));
  `;
  const fresh = await execute(process.execPath, ["--input-type=module", "-e", freshCode], {
    cwd: process.cwd(), timeout: 5_000, windowsHide: true,
    env: { ...process.env, SYNTHETIC_PROJECT: item.project,
      SYNTHETIC_SCOPE: JSON.stringify({ ...SCOPE, ...routeA }) }
  });
  const restarted = JSON.parse(fresh.stdout.trim());
  assert.equal(restarted.priorSessions.sessions, 1);
  assert.equal(restarted.priorSessions.latest.threadRef, routeA.threadRef);

  const fields = { query: "Suite FAIL", includePriorSessions: true };
  const guarded = await runHook(toolInput(item, "session:current", "tool:portal:search", fields));
  assert.equal(guarded.blocked, false, guarded.reason);
  assert.equal(guarded.updatedInput.portalRef, routeA.portalRef);
  assert.equal(guarded.updatedInput.threadRef, routeA.threadRef);
  const found = await mcpClient()("session_timeline_search", guarded.updatedInput);
  assert.equal(found.status, "found", JSON.stringify(found));
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].outcome, "fail");
  assert.equal(found.events[0].threadRef, routeA.threadRef);
  assert.equal(found.threadRef, routeA.threadRef);
  assert.doesNotMatch(JSON.stringify(found), /foreign archive|chat:mayk|thread:work/);

  const compacted = await runHook({ hook_event_name: "PostCompact", ...lifecycle, transcript_path: undefined });
  assert.equal(JSON.parse(compacted.context).sourceResolution.timeline.priorSessions.sessions, 1);
  assert.ok(Buffer.byteLength(compacted.context) <= 9_500);
  for (const [index, path] of Object.values(item.paths).entries()) {
    assert.deepEqual(await readFile(path), sourceBytes[index], "host transcript bytes must remain unchanged");
  }
  t.diagnostic(JSON.stringify({ beforeCandidateThreads: 2, afterCandidateThreads: 1,
    correctPriorResult: 1, unnecessaryQuestions: 0, repeatedErrors: 0,
    contextBytes: Buffer.byteLength(started.context), elapsedMs, tokens: null, realModelRuns: 0 }));
});

test("portal route claims are gateway-derived, paired and fail closed on another thread", async (t) => {
  const item = await fixture(t);
  const routeA = channelTimelineContinuity(channel("thread:work"));
  const routeB = channelTimelineContinuity(channel("thread:other"));
  await enrollAndIndex(item, "session:bound", item.paths.prior, routeA, "bound");

  setGatewayRoute(routeB);
  const wrong = await runHook(toolInput(item, "session:bound", "tool:wrong-thread",
    { query: "Suite FAIL", includePriorSessions: true }));
  assert.equal(wrong.blocked, true);
  assert.equal(wrong.updatedInput, undefined);

  setGatewayRoute(routeA);
  const claimed = await runHook({ ...toolInput(item, "session:bound", "tool:claimed-thread",
    { query: "Suite FAIL" }), thread_ref: routeB.threadRef });
  assert.equal(claimed.blocked, true);
  assert.equal(claimed.updatedInput, undefined);

  delete process.env.AGENTSPINE_THREAD_REF;
  assert.throws(() => gatewayEnvironmentContext(), /must be paired/);
  delete process.env.AGENTSPINE_GATEWAY_CONTEXT;
  const selfClaim = await runHook({ hook_event_name: "SessionStart", host: "claude",
    cwd: item.project, session_id: "session:self-claim", portal_ref: routeA.portalRef,
    thread_ref: routeA.threadRef, ...hookScope() });
  assert.equal(selfClaim.blocked, false, "an untrusted claim must not block ordinary host work");
  assert.equal(JSON.parse(selfClaim.context).loaded, false);
  assert.doesNotMatch(selfClaim.context, new RegExp(routeA.threadRef));
});

test("channel continuity references change at every route boundary without exposing raw IDs", () => {
  const base = channel("thread:work");
  const original = channelTimelineContinuity(base);
  assert.match(original.portalRef, /^portal-ref:[a-f0-9]{32}$/);
  assert.match(original.threadRef, /^thread-ref:[a-f0-9]{32}$/);
  for (const [field, value] of [
    ["provider", "other"], ["tenantId", "tenant:other"], ["accountId", "account:other"],
    ["bindingId", "binding:other"], ["chatId", "chat:other"], ["threadId", "thread:other"],
    ["sessionKey", "portal:other"], ["agentId", "agent:other"], ["projectId", "project:other"]
  ]) {
    assert.notDeepEqual(channelTimelineContinuity({ ...base, [field]: value }), original, field);
  }
  assert.doesNotMatch(JSON.stringify(original), /blun|tenant:portal|account:portal|chat:mayk|thread:work/);
});
