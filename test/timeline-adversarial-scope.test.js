import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { startMcpServer } from "../src/mcp.js";
import { sessionTimelinePrivatePaths, sessionTimelineStatePaths } from "../src/lib/session-timeline-auth.js";
import { indexSessionTimeline } from "../src/lib/session-timeline.js";
import { boundTimelineInvocation, enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function scope(overrides = {}) {
  return {
    entityId: "agent:adversarial", userId: "person:adversarial", tenantId: "tenant:adversarial",
    projectId: "project:adversarial", currentTaskId: "task:adversarial", goalId: "goal:adversarial",
    goalStepId: "step:adversarial", groupId: null, timelineVisibility: "private-verified", ...overrides
  };
}

function mcpClient(environment) {
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
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timed out`)), 2_000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(JSON.parse(result.content[0].text));
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-adversarial-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const transcript = join(profile, "projects", "adversarial", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "adversarial"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(project, "AGENTS.md"), "# Synthetic adversarial timeline project\n"),
    writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:11.000Z", message: {
      role: "tool", content: "Measured adversarial Suite 0; result: PASS 15/15." } })}\n`)
  ]);
  const names = [
    "AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "AGENTSPINE_TIMELINE_SESSION_CAPABILITY",
    "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID", "AGENTSPINE_GATEWAY_CONTEXT", "AGENTSPINE_HOST",
    "AGENTSPINE_ENTITY_ID", "AGENTSPINE_GROUP_ID", "AGENTSPINE_PROJECT_ID", "AGENTSPINE_TASK_ID",
    "AGENTSPINE_GOAL_ID", "AGENTSPINE_GOAL_STEP_ID"
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:adversarial";
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, profile, state, transcript };
}

async function enrollAndRegister(item) {
  const enrollment = await enrollTimelineWithHostReceipt({ root: item.project, sessionId: "session:adversarial",
    scope: scope(), transcriptPath: item.transcript, hostHome: item.profile });
  assert.equal(enrollment.status, "enrolled");
  return enrollment;
}

function toolInput(item, toolUseId, extra = {}) {
  return {
    hook_event_name: "PreToolUse", host: "claude", cwd: item.project, session_id: "session:adversarial",
    tool_use_id: toolUseId, tool_name: "mcp__plugin_agent-spine_agent-spine__session_timeline_search",
    tool_input: { root: item.project, at: "2026-09-04T12:40:11.000Z", query: "Suite PASS", windowSeconds: 0 },
    ...scope(), ...extra
  };
}

function lifecycleInput(item) {
  return {
    hook_event_name: "PreCompact", host: "claude", cwd: item.project, transcript_path: item.transcript,
    session_id: "session:adversarial", ...scope()
  };
}

test("timeline guard suppresses group claims from both top-level and nested scope aliases", async (t) => {
  const item = await fixture(t);
  await enrollAndRegister(item);
  const normal = await runHook(toolInput(item, "tool:scope:normal", { agent_spine_scope: scope() }));
  assert.equal(normal.blocked, false, normal.reason);
  const cases = [
    ["top groupId", { groupId: "group:top-camel", agent_spine_scope: scope() }],
    ["top group_id", { group_id: "group:top-snake", agent_spine_scope: scope() }],
    ["nested groupId", { agent_spine_scope: scope({ groupId: "group:nested-camel" }) }],
    ["nested group_id", { agent_spine_scope: { ...scope(), group_id: "group:nested-snake" } }]
  ];
  for (const [label, extra] of cases) {
    const guarded = await runHook(toolInput(item, `tool:scope:${label.replaceAll(" ", ":")}`, extra));
    assert.equal(guarded.blocked, true, label);
    assert.equal(guarded.updatedInput, undefined, label);
    assert.match(guarded.reason, /group-scoped/i, label);
  }
});

test("a transport-B MCP caller cannot consume transport-A's host permit", async (t) => {
  const item = await fixture(t);
  await enrollAndRegister(item);
  const guarded = await runHook(toolInput(item, "tool:transport:a"));
  assert.equal(guarded.blocked, false, guarded.reason);
  const invocation = await sessionTimelinePrivatePaths(item.project, "invocations");
  const issued = await readFile(invocation.path, "utf8");
  const transportB = {
    ...process.env,
    AGENTSPINE_TIMELINE_SESSION_CAPABILITY: `astc_${randomBytes(32).toString("base64url")}`,
    AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID: "session:adversarial"
  };
  const foreign = await mcpClient(transportB)("session_timeline_search", guarded.updatedInput);
  assert.equal(foreign.blocked, true);
  assert.equal(await readFile(invocation.path, "utf8"), issued, "transport B must not consume transport A's permit");
  const found = await mcpClient(process.env)("session_timeline_search", guarded.updatedInput);
  assert.equal(found.status, "found");
  assert.equal(found.events.length, 1);
});

test("normal PreCompact lifecycle cannot recreate a missing or replayed timeline sidecar", async (t) => {
  const item = await fixture(t);
  const sourceBefore = digest(await readFile(item.transcript));
  await enrollAndRegister(item);
  const names = await sessionTimelineStatePaths(item.project);
  const stateA = await readFile(names.path);
  const permit = await boundTimelineInvocation({ root: item.project, sessionId: "session:adversarial",
    hostHome: item.profile, tool: "index", fields: { maxBytes: 65_536 }, toolUseId: "tool:sidecar:index" });
  assert.ok(permit);
  assert.equal((await indexSessionTimeline({ root: item.project, host: "claude", sessionId: "session:adversarial",
    scope: scope(), hostHome: item.profile, maxBytes: 65_536, invocationRequest: permit.invocationRequest,
    transportDigest: permit.transportDigest, enrollmentDigest: permit.enrollmentDigest })).status, "indexed");
  const stateB = await readFile(names.path);
  assert.notDeepEqual(stateB, stateA);
  await writeFile(names.path, stateA);
  const replayed = await runHook(lifecycleInput(item));
  const replayedTimeline = JSON.parse(replayed.context).sourceResolution.timeline;
  assert.equal(replayedTimeline.status, "unavailable");
  assert.equal(replayedTimeline.reason, "timeline-state-unavailable");
  assert.deepEqual(await readFile(names.path), stateA, "normal lifecycle must not replace a replayed sidecar");
  await unlink(names.path);
  const missing = await runHook(lifecycleInput(item));
  const missingTimeline = JSON.parse(missing.context).sourceResolution.timeline;
  assert.equal(missingTimeline.status, "unavailable");
  assert.equal(missingTimeline.reason, "timeline-state-unavailable");
  await assert.rejects(readFile(names.path), { code: "ENOENT" });
  assert.equal(digest(await readFile(item.transcript)), sourceBefore, "lifecycle never changes transcript bytes");
});
