import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { createTask } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import { startMcpServer } from "../src/mcp.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function hookScope() {
  return {
    entity_id: "agent:scaled-synthetic", user_id: "user:scaled-synthetic",
    tenant_id: "tenant:scaled-synthetic", project_id: "project:scaled-css",
    task_id: "task:scaled-css-archive", goal_id: "goal:scaled-css-archive",
    goal_step_id: "step:objective-measurement", group_id: null
  };
}

function timelineScope() {
  return {
    entityId: "agent:scaled-synthetic", userId: "user:scaled-synthetic",
    tenantId: "tenant:scaled-synthetic", projectId: "project:scaled-css",
    currentTaskId: "task:scaled-css-archive", goalId: "goal:scaled-css-archive",
    goalStepId: "step:objective-measurement", groupId: null
  };
}

function mcpClient() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let nextId = 0;
  let buffered = "";
  const pending = new Map();
  output.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output);
  return (name, args) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timed out`)), 4_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
}

function mcpResult(response) {
  assert.equal(response.isError, false);
  return JSON.parse(response.content[0].text);
}

function jsonlFixture() {
  const oldLessons = ["baseline", "contract", "delivery", "outcome"].map((kind, index) => ({
    timestamp: `2026-08-29T0${8 + index}:10:00.000Z`,
    message: { role: "tool", content: `Measured old CSS archive ${kind} failure; result: FAIL 0/1.` }
  }));
  const target = {
    timestamp: "2026-09-04T12:40:11.000Z",
    message: { role: "tool", content: "Measured CSS archive Suite 0; result: FAIL 0/15." }
  };
  const memoryLinks = Array.from({ length: 2500 }, (_, index) => ({
    timestamp: "2026-09-04T12:41:00.000Z",
    type: "memory-link",
    memory_link: { id: `memory:scaled:${index}`, room: `archive-${Math.floor(index / 50)}` },
    message: { role: "user", content: `Synthetic retained context link ${String(index).padStart(4, "0")}.` },
    payload: "x".repeat(1800)
  }));
  const tail = {
    timestamp: "2026-09-04T12:42:00.000Z",
    message: { role: "user", content: "Synthetic ordinary post-compaction continuation." }
  };
  return { oldLessons, target, text: [...oldLessons, target, ...memoryLinks, tail]
    .map((line) => JSON.stringify(line)).join("\n") + "\n" };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-scaled-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const session = join(profile, "projects", "scaled-css", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(project), mkdir(join(profile, "projects", "scaled-css"), { recursive: true })
  ]);
  await mkdir(join(project, ".git"));
  await writeFile(join(project, "AGENTS.md"), "# Synthetic scaled timeline project\n");
  const transcript = jsonlFixture();
  await writeFile(session, transcript.text, "utf8");
  const previous = {
    state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID
  };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:scaled-synthetic";
  await upsertEntity({ root: project, id: "agent:scaled-synthetic", kind: "agent", privacy: "private" });
  await upsertEntity({ root: project, id: "project:scaled-css", kind: "project", privacy: "private" });
  await createTask({ root: project, id: "task:scaled-css-archive", actorId: "agent:scaled-synthetic",
    assigneeId: "agent:scaled-synthetic", projectId: "project:scaled-css", title: "Synthetic scaled CSS archive" });
  t.after(async () => {
    if (previous.state === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous.state;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    if (previous.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = previous.capability;
    if (previous.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = previous.transportSession;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, profile, session, transcript };
}

test("scaled timeline seeks one old measurement across compaction without loading 2,500 memory links", async (t) => {
  const { project, profile, session, transcript } = await fixture(t);
  const sourceBefore = sha256(await readFile(session));
  assert.equal(transcript.oldLessons.length, 4);
  assert.equal(transcript.text.match(/"type":"memory-link"/g)?.length, 2500);
  assert.ok(Buffer.byteLength(transcript.text) > 4 * 1024 * 1024, "fixture must exceed hook tail budget");
  const input = {
    host: "claude", cwd: project, transcript_path: session, session_id: "session:scaled-synthetic",
    timestamp: "2026-09-04T12:43:00.000Z", prompt: "Continue the synthetic CSS archive.", ...hookScope()
  };
  const enrolled = await enrollTimelineWithHostReceipt({ root: project, sessionId: "session:scaled-synthetic",
    scope: timelineScope(), transcriptPath: session, hostHome: profile });
  assert.equal(enrolled.status, "enrolled", enrolled.reason);

  const beforeCompaction = Date.now();
  const preCompact = await runHook({ hook_event_name: "PreCompact", ...input });
  assert.equal(preCompact.failedClosed, undefined, preCompact.error || preCompact.reason);
  assert.ok(Date.now() - beforeCompaction < 5_000, "PreCompact must not scan the full history");
  const preContext = JSON.parse(preCompact.context);
  assert.equal(preContext.sourceResolution.timeline.status, "partial");
  assert.equal(preContext.sourceResolution.timeline.indexedBytes, 0);
  assert.doesNotMatch(preCompact.context, /Measured CSS archive Suite 0; result: FAIL 0\/15/);

  const restarted = await runHook({ hook_event_name: "SessionStart", ...input,
    timestamp: "2026-09-04T12:44:00.000Z" });
  assert.equal(restarted.failedClosed, undefined, restarted.error || restarted.reason);
  const restartContext = JSON.parse(restarted.context);
  assert.equal(restartContext.sourceResolution.timeline.status, "partial");
  assert.doesNotMatch(restarted.context, /Measured CSS archive Suite 0; result: FAIL 0\/15/);

  const postCompact = await runHook({ hook_event_name: "PostCompact", ...input,
    transcript_path: undefined, timestamp: "2026-09-04T12:45:00.000Z" });
  assert.equal(postCompact.failedClosed, undefined, postCompact.error || postCompact.reason);
  const postContext = JSON.parse(postCompact.context);
  assert.equal(postContext.sourceResolution.timeline.status, "partial");
  assert.equal(postContext.sourceResolution.timeline.sourceDigest, preContext.sourceResolution.timeline.sourceDigest);
  assert.doesNotMatch(postCompact.context, /Measured CSS archive Suite 0; result: FAIL 0\/15/);

  const guarded = await runHook({
    hook_event_name: "PreToolUse", host: "claude", cwd: project, session_id: "session:scaled-synthetic",
    tool_use_id: "tool:scaled-synthetic:12-40", tool_name: "mcp__plugin_agent-spine_agent-spine__session_timeline_search",
    ...hookScope(), tool_input: { at: "2026-09-04T12:40:11.000Z", windowSeconds: 0 }
  });
  assert.equal(guarded.blocked, false, guarded.reason);
  assert.equal("accessProof" in guarded.updatedInput, false);
  assert.equal("invocationPermit" in guarded.updatedInput, false);
  const found = mcpResult(await mcpClient()("session_timeline_search", guarded.updatedInput));
  assert.equal(found.mode, "timestamp-seek", JSON.stringify(found));
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].at, "2026-09-04T12:40:11.000Z");
  assert.equal(found.events[0].outcome, "fail");
  assert.deepEqual(found.events[0].count, { value: 0, total: 15 });
  assert.equal(found.events[0].testLabel, "suite-0");
  assert.equal("summary" in found.events[0], false);
  assert.equal(found.events[0].trust, "untrusted-session-history");
  assert.equal(found.events[0].authority, "context-only");
  assert.equal(sha256(await readFile(session)), sourceBefore, "source JSONL stays byte-identical");
});
