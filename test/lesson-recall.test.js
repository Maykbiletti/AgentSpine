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
import { resolveHostSourceCatalog } from "../src/lib/source-roots.js";
import { startMcpServer } from "../src/mcp.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function client() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let id = 0;
  let buffer = "";
  const pending = new Map();
  output.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output);
  return (name, args) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timeout`)), 2_000);
    pending.set(requestId, (response) => { clearTimeout(timer); resolve(response); });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId,
      method: "tools/call", params: { name, arguments: args } })}\n`);
  });
}

function mcpResult(response) {
  assert.equal(response.isError, false);
  return JSON.parse(response.content[0].text);
}

function scope(overrides = {}) {
  return { entity_id: "agent:synthetic", user_id: "user:synthetic", tenant_id: "tenant:synthetic",
    project_id: "project:css", task_id: "task:f79",
    goal_id: "goal:f79", goal_step_id: "step:archive", group_id: null, ...overrides };
}

function timelineScope(overrides = {}) {
  const input = scope(overrides);
  return { entityId: input.entity_id, userId: input.user_id, tenantId: input.tenant_id,
    projectId: input.project_id, currentTaskId: input.task_id,
    goalId: input.goal_id, goalStepId: input.goal_step_id, groupId: input.group_id };
}

async function enrollTimeline({ project, profile, session }, now = null) {
  const enrolled = await enrollTimelineWithHostReceipt({ root: project, sessionId: "session:dieter",
    scope: timelineScope(), transcriptPath: session, hostHome: profile,
    ...(now ? { clock: () => now } : {}) });
  assert.equal(enrolled.status, "enrolled", enrolled.reason);
  return enrolled;
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-lesson-recall-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const sessionDir = join(profile, "projects", "css-project");
  const session = join(sessionDir, "session.jsonl");
  const memory = join(sessionDir, "memory");
  await Promise.all([mkdir(state), mkdir(project), mkdir(join(memory, "lessons"), { recursive: true })]);
  await mkdir(join(project, ".git"));
  await writeFile(join(project, "AGENTS.md"), "# Synthetic project\n");
  await writeFile(session, "{}\n");
  const lessonNames = ["baseline", "contract", "delivery", "outcome"];
  const lessons = new Map(lessonNames.map((name) => [`lessons/css-archive-${name}.md`,
    `# ${name}\n\nObserved 2026-08-29: never repeat synthetic ${name} failure for the CSS archive Suite 0 task.\n`]));
  for (const [path, content] of lessons) await writeFile(join(memory, path), content);
  const required = [...lessons.keys()].map((path) => `[CSS archive Suite lesson](${path}) <!-- agentspine:keywords=css -->`);
  const noise = Array.from({ length: 2496 }, (_, index) =>
    `[Unrelated memory ${index}](noise/entry-${String(index).padStart(4, "0")}.md)`);
  await writeFile(join(memory, "MEMORY.md"), `# Indexed memory\n\n${[...required, ...noise].join("\n")}\n`);
  const previous = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:dieter";
  await upsertEntity({ root: project, id: "agent:synthetic", kind: "agent", privacy: "private" });
  await upsertEntity({ root: project, id: "project:css", kind: "project", privacy: "private" });
  await createTask({ root: project, id: "task:f79", actorId: "agent:synthetic", assigneeId: "agent:synthetic",
    projectId: "project:css", title: "Synthetic CSS archive" });
  t.after(async () => {
    if (previous.state === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = previous.state;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    if (previous.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = previous.capability;
    if (previous.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = previous.transportSession;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, profile, session, memory, lessons };
}

test("four relevant error lessons survive four hours and compaction without loading 2,500 links", async (t) => {
  const item = await fixture(t);
  const { project, session, memory, lessons } = item;
  const before = new Map(await Promise.all([join(memory, "MEMORY.md"), ...[...lessons.keys()].map((path) => join(memory, path))]
    .map(async (path) => [path, hash(await readFile(path))])));
  const input = { host: "claude", cwd: project, transcript_path: session, session_id: "session:dieter",
    prompt: "Continue CSS archive Suite 0 and avoid the old failure.", timestamp: "2026-09-04T08:00:00.000Z", ...scope() };
  const opened = [];
  const first = await resolveHostSourceCatalog({ host: "claude", cwd: project, input,
    memoryHooks: { onOpen: ({ relativePath }) => opened.push(relativePath) } });
  assert.equal(first.diagnostics.memory.indexed, 2500);
  assert.equal(first.diagnostics.memory.selected, 4);
  assert.equal(first.diagnostics.memory.loaded, 4);
  assert.equal(first.diagnostics.memory.directoryEnumeration, 0);
  assert.ok(opened.length <= 6, "only MEMORY.md and four relevant links may be opened");

  await enrollTimeline(item);
  const started = await runHook({ hook_event_name: "SessionStart", ...input });
  assert.equal(started.blocked, false);
  const postCompact = await runHook({ hook_event_name: "PostCompact", ...input,
    prompt: undefined, timestamp: "2026-09-04T12:00:00.000Z" });
  assert.equal(postCompact.failedClosed, undefined, postCompact.error || postCompact.reason);
  const compacted = JSON.parse(postCompact.context);
  assert.ok(compacted.lessonRecall, JSON.stringify(compacted.sourceResolution.memory));
  assert.equal(postCompact.lessonRecall.status, "recalled");
  assert.equal(compacted.lessonRecall.items.length, 4);
  assert.ok(compacted.lessonRecall.items.every((item) => item.content.includes("synthetic")));
  assert.equal(compacted.sourceResolution.timeline.continuation.lessonDigest, null,
    "source-blind timeline bootstrap does not duplicate lesson content or selectors");
  assert.deepEqual(compacted.sourceResolution.timeline.continuation.roomIds, []);

  const action = await runHook({ hook_event_name: "PreToolUse", host: "claude", cwd: project,
    transcript_path: session, session_id: "session:dieter", timestamp: "2026-09-04T12:00:01.000Z",
    tool_name: "Read", tool_input: { path: "css/archive.css" }, ...scope() });
  assert.equal(action.blocked, false);
  assert.equal(action.lessonRecall.status, "recalled");
  assert.equal(action.lessonRecall.items.length, 4);
  assert.match(action.lessonRecall.instruction, /Before this action/);

  const group = await runHook({ hook_event_name: "PreToolUse", host: "claude", cwd: project,
    transcript_path: session, session_id: "session:dieter", tool_name: "Read", tool_input: { path: "css/archive.css" },
    timestamp: "2026-09-04T12:00:02.000Z", ...scope({ entity_id: undefined, project_id: undefined,
      task_id: undefined, group_id: "group:synthetic" }) });
  assert.equal(group.lessonRecall.status, "group-suppressed");
  assert.deepEqual(group.lessonRecall.items, []);
  for (const [path, expected] of before) assert.equal(hash(await readFile(path)), expected);
});

test("2,500 links retain four old lessons while post-compaction recall seeks only 12:40 evidence", async (t) => {
  const item = await fixture(t);
  const { project, session, memory, lessons } = item;
  const early = JSON.stringify({ timestamp: "2026-09-04T12:40:11.000Z", message: { role: "tool",
    content: "Measured historical CSS archive Suite 0; result: FAIL 0/1." } });
  const filler = `${JSON.stringify({ timestamp: "2026-09-04T12:41:00.000Z", message: { content: "ordinary conversation without objective action data" } })}\n`;
  const tail = JSON.stringify({ timestamp: "2026-09-04T12:42:00.000Z", message: { role: "tool",
    content: "Measured current CSS archive Suite 0; result: PASS 15/15." } });
  await writeFile(session, `${early}\n${filler.repeat(Math.ceil((5 * 1024 * 1024) / Buffer.byteLength(filler)))}${tail}\n`);
  const before = new Map(await Promise.all([session, join(memory, "MEMORY.md"), ...[...lessons.keys()].map((path) => join(memory, path))]
    .map(async (path) => [path, hash(await readFile(path))])));
  const input = { host: "claude", cwd: project, transcript_path: session, session_id: "session:dieter",
    prompt: "Continue CSS archive Suite 0 without the old failures.", timestamp: "2026-09-04T12:43:00.000Z", ...scope() };
  const opened = [];
  const catalog = await resolveHostSourceCatalog({ host: "claude", cwd: project, input,
    memoryHooks: { onOpen: ({ relativePath }) => opened.push(relativePath) } });
  assert.equal(catalog.diagnostics.memory.indexed, 2500);
  assert.equal(catalog.diagnostics.memory.selected, 4);
  assert.equal(catalog.diagnostics.memory.loaded, 4);
  assert.equal(catalog.diagnostics.memory.directoryEnumeration, 0);
  assert.ok(opened.length <= 6);
  await enrollTimeline(item);
  const callBefore = client();
  const blockedBefore = mcpResult(await callBefore("session_timeline_search", {
    at: "2026-09-04T12:40:11.000Z", windowSeconds: 0
  }));
  assert.equal(blockedBefore.status, "unavailable");
  assert.equal(blockedBefore.events, undefined);
  const startedAt = Date.now();
  const preCompact = await runHook({ hook_event_name: "PreCompact", ...input });
  assert.equal(preCompact.failedClosed, undefined, preCompact.error || preCompact.reason);
  assert.ok(Date.now() - startedAt < 5_000, "PreCompact must not backfill a multi-megabyte transcript");
  const pre = JSON.parse(preCompact.context);
  assert.equal(pre.sourceResolution.timeline.status, "partial");
  assert.equal(pre.sourceResolution.timeline.indexedBytes, 0);
  assert.ok(pre.sourceResolution.timeline.size > 4 * 1024 * 1024);
  assert.equal("accessProof" in pre.sourceResolution.timeline, false);
  assert.doesNotMatch(preCompact.context, /historical CSS archive Suite 0; result: FAIL/);
  const postCompact = await runHook({ hook_event_name: "PostCompact", ...input,
    transcript_path: undefined, timestamp: "2026-09-04T12:44:00.000Z" });
  assert.equal(postCompact.failedClosed, undefined, postCompact.error || postCompact.reason);
  const post = JSON.parse(postCompact.context);
  assert.equal(post.sourceResolution.timeline.status, "partial");
  assert.equal(post.sourceResolution.timeline.sourceDigest, pre.sourceResolution.timeline.sourceDigest,
    "PostCompact resolves the enrolled source without receiving a transcript path");
  assert.equal(post.lessonRecall.items.length, 4);
  assert.equal("accessProof" in post.sourceResolution.timeline, false);
  assert.doesNotMatch(postCompact.context, /historical CSS archive Suite 0; result: FAIL/);
  const callAfter = client();
  const guarded = await runHook({ hook_event_name: "PreToolUse", host: "claude", cwd: project,
    session_id: "session:dieter", tool_use_id: "tool:lesson-recall:timeline",
    tool_name: "mcp__plugin_agent-spine_agent-spine__session_timeline_search", ...scope(), tool_input: {
    at: "2026-09-04T12:40:11.000Z", windowSeconds: 0
  } });
  assert.equal(guarded.blocked, false, guarded.reason);
  assert.equal("accessProof" in guarded.updatedInput, false);
  assert.equal("invocationPermit" in guarded.updatedInput, false);
  assert.equal("transportDigest" in guarded.updatedInput, false);
  assert.equal(guarded.updatedInput.sessionId, "session:dieter");
  assert.equal(guarded.updatedInput.entityId, "agent:synthetic");
  const found = mcpResult(await callAfter("session_timeline_search", guarded.updatedInput));
  assert.equal(found.mode, "timestamp-seek", JSON.stringify(found));
  assert.equal(found.budgetExhausted, true);
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].outcome, "fail");
  assert.deepEqual(found.events[0].count, { value: 0, total: 1 });
  assert.equal(found.events[0].testLabel, "suite-0");
  assert.equal("summary" in found.events[0], false);
  for (const [path, expected] of before) assert.equal(hash(await readFile(path)), expected);
});
