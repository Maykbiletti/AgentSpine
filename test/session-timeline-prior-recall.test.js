import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { hookOutput } from "../src/lib/hook-output.js";
import { fitTimelineRecallToHostContext } from "../src/lib/pre-answer-timeline-recall.js";
import { startMcpServer } from "../src/mcp.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

const SESSION_A = "session:prior-recall-a";
const SESSION_B = "session:prior-recall-b";
const SESSION_C = "session:prior-recall-c";
const SESSION_D = "session:prior-recall-d";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function scope(overrides = {}) {
  return {
    entityId: "agent:prior-recall", userId: "person:prior-recall", tenantId: "tenant:prior-recall",
    projectId: "project:prior-recall", currentTaskId: "task:prior-recall", goalId: "goal:prior-recall",
    goalStepId: "step:measure", groupId: null, portalRef: `portal-ref:${"a".repeat(32)}`,
    threadRef: `thread-ref:${"b".repeat(32)}`, timelineVisibility: "private-verified", ...overrides
  };
}

function hookScope(overrides = {}) {
  const value = scope(overrides);
  return { entity_id: value.entityId, user_id: value.userId, tenant_id: value.tenantId,
    project_id: value.projectId, task_id: value.currentTaskId, goal_id: value.goalId,
    goal_step_id: value.goalStepId, group_id: value.groupId,
    portal_ref: value.portalRef, thread_ref: value.threadRef };
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
    content: "Measured CSS archive Suite 0 in result.txt; result: FAIL 0/15. Synthetic checksum detail: abc123." } };
  const newerUnrelated = { timestamp: "2026-09-04T12:40:19.000Z", message: { role: "tool",
    content: "Measured unrelated typography audit in other.log; result: PASS 1/1." } };
  const feedback = [
    "Nein, erst die Prüfsumme prüfen",
    "Nimm dafür die andere Datei",
    "Das hatten wir schon erledigt",
    "Korrektur: nächster Schritt: Prüfsumme validieren"
  ].map((content, index) => ({
    timestamp: `2026-09-04T13:00:${String(20 + index).padStart(2, "0")}.000Z`,
    message: { role: "user", content }
  }));
  const laterChatter = ["Danke für die Erklärung", "Bitte antworte künftig kurz",
    "Die Schriftgröße ist jetzt passend", "Morgen machen wir weiter"].map((content, index) => ({
    timestamp: `2026-09-04T13:${String(10 + index).padStart(2, "0")}:00.000Z`,
    message: { role: "user", content }
  }));
  const links = Array.from({ length: 2500 }, (_, index) => ({
    timestamp: "2026-09-04T12:41:00.000Z", type: "memory-link",
    memory_link: { id: `memory:prior:${index}` }, payload: "x".repeat(1800)
  }));
  return [...lessons, target, newerUnrelated, ...feedback, ...laterChatter, ...links]
    .map((item) => JSON.stringify(item)).join("\n") + "\n";
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-prior-recall-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const sessions = join(profile, "projects", "prior-recall");
  const transcriptA = join(sessions, "session-a.jsonl");
  const transcriptB = join(sessions, "session-b.jsonl");
  const transcriptC = join(sessions, "session-c.jsonl");
  const transcriptD = join(sessions, "session-d.jsonl");
  await Promise.all([mkdir(state), mkdir(join(project, ".git"), { recursive: true }), mkdir(sessions, { recursive: true })]);
  await Promise.all([
    writeFile(join(project, "AGENTS.md"), "# Synthetic prior-session recall project\n"),
    writeFile(transcriptA, priorTranscript()),
    writeFile(transcriptB, `${JSON.stringify({ timestamp: "2026-09-04T13:00:00.000Z",
      message: { role: "user", content: "Continue the archive after restart." } })}\n`),
    writeFile(transcriptC, `${JSON.stringify({ timestamp: "2026-09-04T13:10:00.000Z",
      message: { role: "user", content: "Continue in a different private thread." } })}\n`),
    writeFile(transcriptD, `${JSON.stringify({ timestamp: "2026-09-04T13:20:00.000Z",
      message: { role: "tool", content: "Measured newer unrelated typography in other.log; result: PASS 1/1." } })}\n${JSON.stringify({ timestamp: "2026-09-04T13:20:01.000Z",
      message: { role: "user", content: "Nein, ändere zuerst die Schriftgröße in other.log" } })}\n`)
  ]);
  const names = ["AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "AGENTSPINE_TIMELINE_SESSION_CAPABILITY",
    "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID", "AGENTSPINE_GATEWAY_CONTEXT", "AGENTSPINE_HOST",
    "AGENTSPINE_ENTITY_ID", "AGENTSPINE_USER_ID", "AGENTSPINE_TENANT_ID",
    "AGENTSPINE_PROJECT_ID", "AGENTSPINE_TASK_ID",
    "AGENTSPINE_GOAL_ID", "AGENTSPINE_GOAL_STEP_ID", "AGENTSPINE_PORTAL_REF", "AGENTSPINE_THREAD_REF"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_A;
  process.env.AGENTSPINE_GATEWAY_CONTEXT = "agentspine.gateway-start/v1";
  process.env.AGENTSPINE_HOST = "claude";
  process.env.AGENTSPINE_ENTITY_ID = scope().entityId;
  process.env.AGENTSPINE_USER_ID = scope().userId;
  process.env.AGENTSPINE_TENANT_ID = scope().tenantId;
  process.env.AGENTSPINE_PROJECT_ID = scope().projectId;
  process.env.AGENTSPINE_TASK_ID = scope().currentTaskId;
  process.env.AGENTSPINE_GOAL_ID = scope().goalId;
  process.env.AGENTSPINE_GOAL_STEP_ID = scope().goalStepId;
  process.env.AGENTSPINE_PORTAL_REF = scope().portalRef;
  process.env.AGENTSPINE_THREAD_REF = scope().threadRef;
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, profile, transcriptA, transcriptB, transcriptC, transcriptD };
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
  assert.equal(indexed.events, 14);

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
  assert.equal(timeline.priorSessions.indexedEvents, 14);
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
  assert.equal(found.events[0].excerpt, "Measured CSS archive Suite 0 in result.txt; result: FAIL 0/15.");
  assert.equal(found.events[0].trust, "untrusted-session-history");
  assert.equal(found.events[0].authority, "context-only");

  const detailFields = { query: "objective result", includePriorSessions: true,
    detailEventId: found.events[0].id, sourceDigest: found.sourceDigest,
    sessionRef: found.events[0].sessionRef };
  const detailGuard = await runHook(toolInput(item, SESSION_B, "tool:prior:detail", detailFields));
  assert.equal(detailGuard.blocked, false, detailGuard.reason);
  assert.equal(detailGuard.updatedInput.detailEventId, detailFields.detailEventId);
  const detail = await client()("session_timeline_search", detailGuard.updatedInput);
  assert.equal(detail.status, "found", JSON.stringify(detail));
  assert.equal(detail.events.length, 1);
  assert.match(detail.events[0].sourceDetail.text, /Synthetic checksum detail: abc123/);
  assert.equal(detail.events[0].sourceDetail.complete, false);
  assert.equal(detail.events[0].sourceDetail.reason, "bounded-extraction");
  assert.match(detail.events[0].messageDigest, /^[a-f0-9]{64}$/);
  assert.equal(found.events[0].sourceDetail, undefined, "short first-stage hits omit detail");

  const wrongDigest = await runHook(toolInput(item, SESSION_B, "tool:prior:wrong-digest",
    { ...detailFields, sourceDigest: "0".repeat(64) }));
  if (!wrongDigest.blocked) {
    const rejected = await client()("session_timeline_search", wrongDigest.updatedInput);
    assert.equal(rejected.blocked, true);
  }

  const replay = await client()("session_timeline_search", priorGuard.updatedInput);
  assert.equal(replay.blocked, true);
  const compacted = await runHook({ hook_event_name: "PostCompact", ...lifecycleInput, transcript_path: undefined });
  assert.equal(JSON.parse(compacted.context).sourceResolution.timeline.priorSessions.sessions, 1);
  assert.equal(sha256(await readFile(item.transcriptA)), beforeA, "prior transcript stays byte-identical");
  assert.equal(sha256(await readFile(item.transcriptB)), beforeB, "current transcript stays byte-identical");
});

test("every private pre-answer turn awaits bounded prior evidence without a search hint", async (t) => {
  const item = await fixture(t);
  const beforeA = sha256(await readFile(item.transcriptA));
  const beforeB = sha256(await readFile(item.transcriptB));
  await enroll(item, SESSION_A, item.transcriptA);
  const indexGuard = await runHook(toolInput(item, SESSION_A, "tool:prior:auto-index",
    { maxBytes: 16 * 1024 * 1024 }));
  await client()("session_timeline_index", indexGuard.updatedInput);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_B;
  await enroll(item, SESSION_B, item.transcriptB);

  const prompt = async (eventId, value) => runHook({ hook_event_name: "UserPromptSubmit", host: "claude",
    cwd: item.project, session_id: SESSION_B, transcript_path: item.transcriptB,
    event_id: eventId, prompt: value, ...hookScope() });
  const direct = await prompt("event:prior:auto-direct", "What was the CSS archive Suite 0 result in result.txt?");
  const continuation = await prompt(undefined, "Continue the existing task.");
  for (const result of [direct, continuation]) {
    assert.equal(result.blocked, false, result.reason);
    const recall = JSON.parse(result.context).sourceResolution.timeline.preAnswerRecall;
    assert.equal(recall.status, "recalled");
    assert.equal(recall.awaited, true);
    assert.equal(recall.completionVerified, false);
    assert.equal(recall.sourceReads, 2);
    assert.ok(recall.omittedEvents > 0);
    assert.equal(recall.fields.includes("value"), true);
    const events = JSON.stringify(recall.events);
    assert.match(events, /Nein, erst die Prüfsumme prüfen/);
    assert.match(events, /Nimm dafür die andere Datei/);
    assert.match(events, /Das hatten wir schon erledigt/);
    const kind = recall.fields.indexOf("kind");
    assert.equal(recall.events.filter((event) => event[kind] === "user").length, 3);
  }
  const directRecall = JSON.parse(direct.context).sourceResolution.timeline.preAnswerRecall;
  assert.equal(directRecall.omittedEvents, 9);
  const timeline=JSON.parse(direct.context).sourceResolution.timeline;
  const empty={...directRecall,events:[],omittedEvents:directRecall.omittedEvents+directRecall.events.length};
  const maximumBytes=Buffer.byteLength(JSON.stringify({...timeline,preAnswerRecall:empty}));
  const budgeted=fitTimelineRecallToHostContext({timeline,render:JSON.stringify,maximumBytes}).timeline.preAnswerRecall;
  assert.equal(budgeted.status,"unavailable");
  assert.equal(budgeted.reason,"host-context-budget");
  assert.deepEqual(budgeted.events,[]);
  assert.equal(budgeted.omittedEvents,empty.omittedEvents);
  const directEvents = JSON.stringify(directRecall.events);
  assert.match(directEvents, /Measured CSS archive Suite 0 in result\.txt; result: FAIL 0\/15\./);
  assert.doesNotMatch(directEvents, /other\.log/);
  const continuationEvents = JSON.stringify(
    JSON.parse(continuation.context).sourceResolution.timeline.preAnswerRecall.events
  );
  assert.match(continuationEvents, /Measured unrelated typography audit in other\.log; result: PASS 1\/1\./);
  for (const environment of [{ CLAUDE_PLUGIN_ROOT: "/synthetic/claude" },
    { PLUGIN_ROOT: "/synthetic/codex" }, { BLUN_PLUGIN_ROOT: "/synthetic/king" }]) {
    const output = hookOutput("UserPromptSubmit", direct.context, environment);
    const handoff = output.hookSpecificOutput.additionalContext;
    assert.match(handoff, /result\.txt/);
    assert.match(handoff, /Nein, erst die Prüfsumme prüfen/);
    assert.match(handoff, /Nimm dafür die andere Datei/);
    assert.match(handoff, /Das hatten wir schon erledigt/);
    assert.match(handoff, /completionVerified(?:\\?"|&quot;):false/);
    assert.match(handoff, /omitted(?:Events)?(?:\\?"|&quot;):[1-9]/);
    if (environment.BLUN_PLUGIN_ROOT) assert.equal(Buffer.byteLength(handoff) <= 1200, true);
  }
  assert.equal(sha256(await readFile(item.transcriptA)), beforeA);
  assert.equal(sha256(await readFile(item.transcriptB)), beforeB);
  t.diagnostic(JSON.stringify({ sourceRetrieval: "verified", contextHandoff: "repository-hook-only",
    modelRuns: 0, semanticApplication: "unverified", directPrompt: "recalled",
    continuationWithoutSearchHint: "recalled" }));
});

test("host-context fitting preserves measured recall evidence when optional detail is removed", () => {
  const recall={schema:"agentspine.pre-answer-timeline-recall/v1",status:"recalled",awaited:true,
    sourceReads:2,events:[],omittedEvents:9,completionVerified:false,authority:"context-only",
    optionalDetail:"x".repeat(512)};
  const timeline={schema:"agentspine.session-timeline/v1",status:"indexed",preAnswerRecall:recall,
    authority:"context-only"};
  const unavailableRecall={schema:recall.schema,status:"unavailable",reason:"host-context-budget",
    awaited:true,sourceReads:2,events:[],omittedEvents:9,completionVerified:false,
    authority:"context-only"};
  const maximumBytes=Buffer.byteLength(JSON.stringify({...timeline,preAnswerRecall:unavailableRecall}));
  const before=JSON.parse(JSON.stringify(timeline));
  const fit=()=>fitTimelineRecallToHostContext({timeline,render:JSON.stringify,maximumBytes});
  const first=fit();
  assert.equal(Buffer.byteLength(first.context)<=maximumBytes,true);
  assert.equal(first.timeline.preAnswerRecall.status,"unavailable");
  assert.equal(first.timeline.preAnswerRecall.reason,"host-context-budget");
  assert.equal(first.timeline.preAnswerRecall.sourceReads,2);
  assert.equal(first.timeline.preAnswerRecall.omittedEvents,9);
  assert.deepEqual(timeline,before);
  assert.deepEqual(fit(),first);
});

test("automatic recall does not return unanchored prior messages without an objective result", async (t) => {
  const item=await fixture(t);
  const unanchored=`${JSON.stringify({timestamp:"2026-09-04T12:40:11.000Z",
    message:{role:"user",content:"Use unrelated-unanchored.txt for a different request."}})}\n`;
  await writeFile(item.transcriptA,unanchored);
  const before=sha256(await readFile(item.transcriptA));
  await enroll(item,SESSION_A,item.transcriptA);
  const indexGuard=await runHook(toolInput(item,SESSION_A,"tool:prior:unanchored-index",
    {maxBytes:16*1024*1024}));
  const indexed=await client()("session_timeline_index",indexGuard.updatedInput);
  assert.equal(indexed.status,"indexed",JSON.stringify(indexed));
  assert.equal(indexed.events,1);

  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID=SESSION_B;
  await enroll(item,SESSION_B,item.transcriptB);
  const result=await runHook({hook_event_name:"UserPromptSubmit",host:"claude",cwd:item.project,
    session_id:SESSION_B,transcript_path:item.transcriptB,event_id:"event:prior:unanchored",
    prompt:"Continue the existing task.",...hookScope()});
  assert.equal(result.blocked,false,result.reason);
  const recall=JSON.parse(result.context).sourceResolution.timeline.preAnswerRecall;
  assert.equal(recall.status,"not-found");
  assert.equal(recall.awaited,true);
  assert.equal(recall.sourceReads,1);
  assert.deepEqual(recall.events,[]);
  assert.doesNotMatch(result.context,/unrelated-unanchored\.txt/);
  assert.equal(sha256(await readFile(item.transcriptA)),before);
});

test("automatic recall bounds generated queries without losing later relevance terms", async (t) => {
  const item=await fixture(t);
  const before=sha256(await readFile(item.transcriptA));
  await enroll(item,SESSION_A,item.transcriptA);
  const guard=await runHook(toolInput(item,SESSION_A,"tool:prior:oversized-query",
    {maxBytes:16*1024*1024}));
  assert.equal((await client()("session_timeline_index",guard.updatedInput)).status,"indexed");
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID=SESSION_B;
  await enroll(item,SESSION_B,item.transcriptB);
  const result=await runHook({hook_event_name:"UserPromptSubmit",host:"claude",cwd:item.project,
    session_id:SESSION_B,transcript_path:item.transcriptB,event_id:"event:prior:oversized-query",
    prompt:`Continue ${"x".repeat(600)} alpha beta gamma delta epsilon zeta eta theta iota result.txt`,
    ...hookScope()});
  assert.equal(result.blocked,false,result.reason);
  const recall=JSON.parse(result.context).sourceResolution.timeline.preAnswerRecall;
  assert.equal(recall.status,"recalled");
  assert.equal(recall.sourceReads,2);
  assert.match(JSON.stringify(recall.events),/result\.txt/);
  assert.doesNotMatch(JSON.stringify(recall.events),/other\.log/);
  assert.equal(sha256(await readFile(item.transcriptA)),before);
});

test("a direct prompt selects the relevant result across multiple prior sessions", async (t) => {
  const item = await fixture(t);
  const beforeA = sha256(await readFile(item.transcriptA));
  const beforeD = sha256(await readFile(item.transcriptD));
  await enroll(item, SESSION_A, item.transcriptA);
  const oldGuard = await runHook(toolInput(item, SESSION_A, "tool:prior:multi-old",
    { maxBytes: 16 * 1024 * 1024 }));
  await client()("session_timeline_index", oldGuard.updatedInput);

  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_D;
  await enroll(item, SESSION_D, item.transcriptD);
  const newerGuard = await runHook(toolInput(item, SESSION_D, "tool:prior:multi-new",
    { maxBytes: 16 * 1024 * 1024 }));
  await client()("session_timeline_index", newerGuard.updatedInput);

  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_B;
  await enroll(item, SESSION_B, item.transcriptB);
  const result = await runHook({ hook_event_name: "UserPromptSubmit", host: "claude",
    cwd: item.project, session_id: SESSION_B, transcript_path: item.transcriptB,
    event_id: "event:prior:multi-relevant",
    prompt: "What was the CSS archive Suite 0 result in result.txt?", ...hookScope() });
  const continuation = await runHook({ hook_event_name: "UserPromptSubmit", host: "claude",
    cwd: item.project, session_id: SESSION_B, transcript_path: item.transcriptB,
    event_id: "event:prior:multi-continuation", prompt: "Continue the existing task.", ...hookScope() });
  assert.equal(result.blocked, false, result.reason);
  const recall = JSON.parse(result.context).sourceResolution.timeline.preAnswerRecall;
  assert.equal(recall.status, "recalled");
  assert.equal(recall.sourceReads, 2);
  assert.equal(recall.sources, undefined, "result and feedback must share one verified source");
  assert.match(JSON.stringify(recall.events), /result\.txt/);
  assert.doesNotMatch(JSON.stringify(recall.events), /other\.log/);
  const handoff = hookOutput("UserPromptSubmit", result.context,
    { BLUN_PLUGIN_ROOT: "/synthetic/king" }).hookSpecificOutput.additionalContext;
  assert.match(handoff, /result\.txt/);
  assert.doesNotMatch(handoff, /other\.log/);
  assert.match(handoff, /Nein, erst die Prüfsumme prüfen/);
  assert.doesNotMatch(handoff, /Schriftgröße/);
  const continuationRecall = JSON.parse(continuation.context).sourceResolution.timeline.preAnswerRecall;
  assert.equal(continuationRecall.status, "recalled");
  assert.match(JSON.stringify(continuationRecall.events), /other\.log/);
  assert.match(JSON.stringify(continuationRecall.events), /Schriftgröße/);
  assert.equal(continuationRecall.sources, undefined);
  assert.equal(sha256(await readFile(item.transcriptA)), beforeA);
  assert.equal(sha256(await readFile(item.transcriptD)), beforeD);
});

test("automatic recall isolates private threads and fails open when prior evidence changes", async (t) => {
  const item = await fixture(t);
  await enroll(item, SESSION_A, item.transcriptA);
  const indexGuard = await runHook(toolInput(item, SESSION_A, "tool:prior:auto-isolation-index",
    { maxBytes: 16 * 1024 * 1024 }));
  await client()("session_timeline_index", indexGuard.updatedInput);

  const foreignThread = `thread-ref:${"c".repeat(32)}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_C;
  process.env.AGENTSPINE_THREAD_REF = foreignThread;
  await enrollTimelineWithHostReceipt({ root: item.project, sessionId: SESSION_C,
    scope: scope({ threadRef: foreignThread }), transcriptPath: item.transcriptC, hostHome: item.profile });
  const isolated = await runHook({ hook_event_name: "UserPromptSubmit", host: "claude",
    cwd: item.project, session_id: SESSION_C, transcript_path: item.transcriptC,
    event_id: "event:prior:auto-foreign-thread", prompt: "Continue the existing task.",
    ...hookScope({ threadRef: foreignThread }) });
  assert.equal(isolated.blocked, false, isolated.reason);
  const isolatedRecall = JSON.parse(isolated.context).sourceResolution.timeline.preAnswerRecall;
  assert.equal(isolatedRecall.status, "not-found");
  assert.doesNotMatch(isolated.context, /result\.txt|Prüfsumme|andere Datei|schon erledigt/);

  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = SESSION_B;
  process.env.AGENTSPINE_THREAD_REF = scope().threadRef;
  await enroll(item, SESSION_B, item.transcriptB);
  await writeFile(item.transcriptA, `${priorTranscript()}${JSON.stringify({ timestamp: "2026-09-04T12:50:00.000Z",
    message: { role: "tool", content: "Measured changed Suite 1; result: PASS 1/1." } })}\n`);
  const degraded = await runHook({ hook_event_name: "UserPromptSubmit", host: "claude",
    cwd: item.project, session_id: SESSION_B, transcript_path: item.transcriptB,
    event_id: "event:prior:auto-changed", prompt: "Continue the existing task.", ...hookScope() });
  assert.equal(degraded.blocked, false, degraded.reason);
  const degradedRecall = JSON.parse(degraded.context).sourceResolution.timeline.preAnswerRecall;
  assert.equal(degradedRecall.status, "unavailable");
  assert.equal(degradedRecall.awaited, true);
  assert.deepEqual(degradedRecall.events, []);
  assert.doesNotMatch(degraded.context, /Measured changed Suite 1/);
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
