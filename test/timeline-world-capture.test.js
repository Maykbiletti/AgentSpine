import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { startMcpServer } from "../src/mcp.js";
import { channelTimelineContinuity } from "../src/lib/channel-continuity.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

const TASK = "task:timeline-capture";
const PROJECT = "project:timeline-capture";
const SCOPE = {
  entityId: "agent:timeline-capture", userId: "person:timeline-capture",
  tenantId: "tenant:timeline-capture", projectId: PROJECT, currentTaskId: TASK,
  goalId: "goal:timeline-capture", goalStepId: "step:measure", groupId: null,
  timelineVisibility: "private-verified"
};
const ENV_NAMES = [
  "AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "AGENTSPINE_TIMELINE_SESSION_CAPABILITY",
  "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID", "AGENTSPINE_GATEWAY_CONTEXT",
  "AGENTSPINE_ENTITY_ID", "AGENTSPINE_USER_ID", "AGENTSPINE_TENANT_ID",
  "AGENTSPINE_PROJECT_ID", "AGENTSPINE_TASK_ID", "AGENTSPINE_GOAL_ID",
  "AGENTSPINE_GOAL_STEP_ID", "AGENTSPINE_HOST", "AGENTSPINE_PORTAL_REF",
  "AGENTSPINE_THREAD_REF"
];

function route(threadId) {
  return channelTimelineContinuity({
    provider: "blun", tenantId: SCOPE.tenantId, accountId: "account:timeline-capture",
    bindingId: "binding:timeline-capture", chatId: "chat:synthetic", threadId,
    sessionKey: "portal:synthetic:capture", agentId: SCOPE.entityId,
    projectId: PROJECT, groupId: null
  });
}

function gatewayEnvironment(binding) {
  return {
    ...process.env, AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_ENTITY_ID: SCOPE.entityId, AGENTSPINE_USER_ID: SCOPE.userId,
    AGENTSPINE_TENANT_ID: SCOPE.tenantId, AGENTSPINE_PROJECT_ID: PROJECT,
    AGENTSPINE_TASK_ID: TASK, AGENTSPINE_GOAL_ID: SCOPE.goalId,
    AGENTSPINE_GOAL_STEP_ID: SCOPE.goalStepId, AGENTSPINE_HOST: "claude",
    AGENTSPINE_PORTAL_REF: binding.portalRef, AGENTSPINE_THREAD_REF: binding.threadRef
  };
}

function setGateway(binding) {
  Object.assign(process.env, gatewayEnvironment(binding));
}

function hookScope() {
  return {
    entity_id: SCOPE.entityId, user_id: SCOPE.userId, tenant_id: SCOPE.tenantId,
    project_id: PROJECT, task_id: TASK, goal_id: SCOPE.goalId,
    goal_step_id: SCOPE.goalStepId, group_id: null
  };
}

function mcpClient(environment = { ...process.env }) {
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
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve({ ...result, value: JSON.parse(result.content[0].text) });
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
}

function toolInput(item, tool, toolUseId, fields) {
  return {
    hook_event_name: "PreToolUse", host: "claude", cwd: item.project,
    session_id: "session:current", tool_use_id: toolUseId,
    tool_name: `mcp__plugin_agent-spine_agent-spine__session_timeline_${tool}`,
    tool_input: fields, ...hookScope()
  };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-capture-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const transcripts = join(profile, "projects", "capture");
  await Promise.all([mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(transcripts, { recursive: true })]);
  const source = join(transcripts, "prior.jsonl");
  const current = join(transcripts, "current.jsonl");
  await Promise.all([
    writeFile(join(project, "AGENTS.md"), "# Synthetic timeline capture\n"),
    writeFile(source, `${JSON.stringify({ timestamp: "2026-09-07T04:30:00.000Z",
      message: { role: "tool", content: "Measured portal backup Suite 0; result: FAIL 0/15." } })}\n${JSON.stringify({
      timestamp: "2026-09-07T04:31:00.000Z",
      message: { role: "tool", content: "Measured portal backup Suite 0; result: PASS 15/15." }
    })}\n`),
    writeFile(current, `${JSON.stringify({ timestamp: "2026-09-07T04:40:00.000Z",
      message: { role: "user", content: "Continue from the measured result." } })}\n`)
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
  return { project, profile, state, source, current };
}

async function enroll(item, sessionId, transcriptPath, binding) {
  setGateway(binding);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = sessionId;
  const enrolled = await enrollTimelineWithHostReceipt({
    root: item.project, sessionId, scope: SCOPE, transcriptPath, hostHome: item.profile
  });
  assert.equal(enrolled.status, "enrolled", enrolled.reason);
  if (sessionId !== "session:prior") return;
  const input = { ...toolInput(item, "index", "tool:capture:index", { maxBytes: 65_536 }), session_id: sessionId };
  const guarded = await runHook(input);
  assert.equal(guarded.blocked, false, guarded.reason);
  const indexed = await mcpClient()("session_timeline_index", guarded.updatedInput);
  assert.equal(indexed.value.status, "indexed", JSON.stringify(indexed.value));
}

function freshWorldContext(item, binding) {
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "world_context", arguments: { root: item.project, projectId: PROJECT,
      includePrivate: true, now: "2026-09-07T05:00:00.000Z" }
  } };
  const child = spawnSync(process.execPath, ["src/mcp.js"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 5_000, input: `${JSON.stringify(request)}\n`,
    env: { ...gatewayEnvironment(binding), AGENTSPINE_STATE_DIR: item.state }
  });
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(child.stdout.trim());
  assert.equal(response.result.isError, false, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

async function guarded(item, tool, id, fields) {
  const result = await runHook(toolInput(item, tool, id, fields));
  assert.equal(result.blocked, false, result.reason);
  return result.updatedInput;
}

test("verified timeline evidence becomes exact-thread structured context without model provenance claims", async (t) => {
  const item = await fixture(t);
  const routeA = route("thread:capture");
  const routeB = route("thread:foreign");
  const sourceBefore = await readFile(item.source);
  await enroll(item, "session:prior", item.source, routeA);
  await enroll(item, "session:current", item.current, routeA);
  setGateway(routeA);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:current";

  const before = freshWorldContext(item, routeA);
  assert.equal(before.knowledge.current.length, 0,
    "Before: verified timeline evidence is not connected to structured knowledge");

  const query = { query: "Suite FAIL", includePriorSessions: true };
  const searchArgs = await guarded(item, "search", "tool:capture:search", query);
  const searched = await mcpClient()("session_timeline_search", searchArgs);
  assert.equal(searched.value.status, "found", JSON.stringify(searched.value));
  assert.equal(searched.value.events.length, 1);
  assert.equal("messageDigest" in searched.value.events[0], false,
    "ordinary search does not expose the private raw-line digest");
  const eventId = searched.value.events[0].id;

  const supplied = { ...query, eventId, evidenceDigest: "f".repeat(64),
    evidenceKind: "explicit-user-feedback", subjectId: "task:foreign" };
  const firstArgs = await guarded(item, "capture", "tool:capture:first", supplied);
  const secondArgs = await guarded(item, "capture", "tool:capture:second", supplied);
  assert.equal("evidenceDigest" in firstArgs, false);
  assert.equal("evidenceKind" in firstArgs, false);
  assert.equal("subjectId" in firstArgs, false);
  const [left, right] = await Promise.all([
    mcpClient()("session_timeline_capture", firstArgs),
    mcpClient()("session_timeline_capture", secondArgs)
  ]);
  assert.deepEqual([left.value.status, right.value.status].sort(), ["captured", "duplicate"]);
  const capture = left.value.status === "captured" ? left.value : right.value;
  assert.equal(capture.captured.value.outcome, "fail");
  assert.deepEqual(capture.captured.value.count, { value: 0, total: 15 });
  assert.equal(capture.captured.value.testLabel, "suite-0");
  assert.equal(capture.captured.value.sourceDigest, capture.timeline.sourceDigest);
  assert.equal(capture.captured.subjectId, TASK);
  assert.equal(capture.captured.scope.threadRef, routeA.threadRef);
  assert.equal(capture.captured.source.id, eventId);
  assert.match(capture.captured.source.digest, /^[a-f0-9]{64}$/);
  assert.equal(capture.completionVerified, false);
  assert.equal(capture.deliveryConfirmed, false);

  const afterRestart = freshWorldContext(item, routeA);
  assert.equal(afterRestart.knowledge.current.length, 1);
  assert.equal(afterRestart.knowledge.current[0].status, "confirmed");
  assert.equal(afterRestart.knowledge.current[0].source.id, eventId);
  assert.equal(afterRestart.knowledge.current[0].scope.threadRef, routeA.threadRef);
  assert.equal(afterRestart.facts[0].value.outcome, "fail");
  const foreign = freshWorldContext(item, routeB);
  assert.equal(foreign.knowledge.current.length, 0);
  assert.equal(foreign.facts.length, 0);

  const duplicateArgs = await guarded(item, "capture", "tool:capture:restart", { ...query, eventId });
  const duplicate = await mcpClient()("session_timeline_capture", duplicateArgs);
  assert.equal(duplicate.value.status, "duplicate");
  const wrongArgs = await guarded(item, "capture", "tool:capture:wrong", {
    ...query, eventId: `timeline-event:${"0".repeat(32)}`
  });
  const wrong = await mcpClient()("session_timeline_capture", wrongArgs);
  assert.equal(wrong.value.status, "unavailable");
  assert.equal(wrong.value.reason, "timeline-capture-event-not-found");
  assert.equal(freshWorldContext(item, routeA).knowledge.current.length, 1);

  const passQuery = { query: "Suite PASS", includePriorSessions: true };
  const passSearchArgs = await guarded(item, "search", "tool:capture:pass-search", passQuery);
  const passSearch = await mcpClient()("session_timeline_search", passSearchArgs);
  assert.equal(passSearch.value.events.length, 1);
  const passArgs = await guarded(item, "capture", "tool:capture:pass", {
    ...passQuery, eventId: passSearch.value.events[0].id
  });
  const pass = await mcpClient()("session_timeline_capture", passArgs);
  assert.equal(pass.value.status, "captured");
  const conflicted = freshWorldContext(item, routeA);
  assert.equal(conflicted.facts.length, 0,
    "a later contradictory measurement is not silently treated as the current fact");
  assert.equal(conflicted.uncertainty.conflicts, 1);
  assert.equal(conflicted.knowledge.counts.contradictory, 2);
  assert.deepEqual(await readFile(item.source), sourceBefore,
    "search and capture preserve the enrolled user source byte-for-byte");
});

test("capture rejects direct calls, changed sources, invalid bindings, and group scope", async (t) => {
  const item = await fixture(t);
  const routeA = route("thread:security");
  await enroll(item, "session:prior", item.source, routeA);
  await enroll(item, "session:current", item.current, routeA);
  setGateway(routeA);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:current";
  const query = { query: "Suite FAIL", includePriorSessions: true };
  const searchArgs = await guarded(item, "search", "tool:security:search", query);
  const searched = await mcpClient()("session_timeline_search", searchArgs);
  const eventId = searched.value.events[0].id;

  const direct = await mcpClient()("session_timeline_capture", { ...query, eventId });
  assert.equal(direct.value.status, "unavailable");
  const captureArgs = await guarded(item, "capture", "tool:security:changed", { ...query, eventId });
  await writeFile(item.source, `${await readFile(item.source, "utf8")} `);
  const changed = await mcpClient()("session_timeline_capture", captureArgs);
  assert.equal(changed.value.status, "unavailable");
  assert.equal(freshWorldContext(item, routeA).knowledge.current.length, 0);

  const foreignRoute = route("thread:other");
  setGateway(foreignRoute);
  const wrongRoute = await runHook(toolInput(item, "capture", "tool:security:route", {
    ...query, eventId, portalRef: routeA.portalRef, threadRef: routeA.threadRef
  }));
  assert.equal(wrongRoute.blocked, true);
  const grouped = await runHook({ ...toolInput(item, "capture", "tool:security:group", { ...query, eventId }),
    group_id: "group:synthetic" });
  assert.equal(grouped.blocked, true);
});
