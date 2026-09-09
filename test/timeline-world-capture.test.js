import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { startMcpServer } from "../src/mcp.js";
import { channelTimelineContinuity } from "../src/lib/channel-continuity.js";
import { hookOutput } from "../src/lib/hook-output.js";
import { recordWorldAssertion } from "../src/lib/world-model.js";
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
    })}\n${JSON.stringify({ timestamp: "2026-09-07T04:50:00.000Z",
      message: { role: "tool", content: "Measured portal backup test; result: PASS 1/1." } })}\n`),
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

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

async function taskState(item, binding, { id, value, observedAt, evidenceKind = "objective-measurement",
  supersedes = [], recordedAt = "2026-09-07T04:29:00.000Z" }) {
  return recordWorldAssertion({ root: item.project, id, subjectId: TASK,
    predicate: value.schema === "agentspine.task-continuation/v1"
      ? "task.continuation" : "task.timeline-outcome-contract",
    value, evidenceKind, evidenceId: `${evidenceKind === "explicit-user-feedback" ? "user" : "measurement"}:${hash(id).slice(0, 24)}`,
    evidenceDigest: hash(value), observedAt, projectId: PROJECT, groupId: null, privacy: "private",
    knowledgeKind: "task-state", sessionRef: `session-ref:${"c".repeat(32)}`,
    messageRef: `message:${hash(`message\0${id}`).slice(0, 24)}`, supersedes,
    requireActiveSupersedes: supersedes.length > 0,
    reason: "Synthetic pre-existing task outcome contract.", portalRef: binding.portalRef,
    threadRef: binding.threadRef, now: recordedAt });
}

function continuation(nextStep, openQuestions = []) {
  return { schema: "agentspine.task-continuation/v1", taskId: TASK, status: "active",
    objective: "Verify result.txt using the pre-agreed Suite 0 outcome contract.",
    lastVerifiedStep: null, openQuestions, nextStep };
}

function outcomeContract(step, onSuccess, measurement = { testLabel: "suite-0", total: 15, successCount: 15 }) {
  return { schema: "agentspine.timeline-continuation-outcome-contract/v1", taskId: TASK, step,
    measurement, onSuccess };
}

async function captureQuery(item, query, searchId, captureId) {
  const found = await mcpClient()("session_timeline_search",
    await guarded(item, "search", searchId, query));
  assert.equal(found.value.events.length, 1, JSON.stringify(found.value));
  return mcpClient()("session_timeline_capture", await guarded(item, "capture", captureId,
    { ...query, eventId: found.value.events[0].id }));
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

test("a pre-existing objective contract advances only its exact continuation and preserves measured conflict", async (t) => {
  const started = performance.now();
  const item = await fixture(t);
  const binding = route("thread:contract");
  const sourceBefore = await readFile(item.source);
  await enroll(item, "session:prior", item.source, binding);
  await enroll(item, "session:current", item.current, binding);
  setGateway(binding);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:current";
  const measured = { id: "step:suite-0", summary: "Run Suite 0 against result.txt." };
  const next = { id: "step:publish", summary: "Publish the verified result.txt report." };
  await taskState(item, binding, { id: "assertion:contract-baseline",
    value: continuation(measured), observedAt: "2026-09-07T04:00:00.000Z",
    recordedAt: "2026-09-07T04:01:00.000Z" });
  await taskState(item, binding, { id: "assertion:suite-0-contract",
    value: outcomeContract(measured, { status: "active", nextStep: next }),
    observedAt: "2026-09-07T04:10:00.000Z", recordedAt: "2026-09-07T04:11:00.000Z",
    evidenceKind: "explicit-user-feedback" });

  const failed = await captureQuery(item, { query: "Suite FAIL", includePriorSessions: true },
    "tool:contract:fail-search", "tool:contract:fail-capture");
  assert.equal(failed.value.continuationUpdate.status, "updated", JSON.stringify(failed.value));
  assert.equal(failed.value.continuationUpdate.continuation.value.lastVerifiedStep.result, "failed");
  assert.deepEqual(failed.value.continuationUpdate.continuation.value.nextStep, measured);
  assert.equal(failed.value.continuationUpdate.automaticRetry, false);
  const failedRestart = freshWorldContext(item, binding);
  assert.equal(failedRestart.knowledge.continuation.tasks[0].lastVerifiedStep.result, "failed");
  assert.deepEqual(failedRestart.knowledge.continuation.tasks[0].nextStep, measured);

  const passed = await captureQuery(item, { query: "Suite PASS", includePriorSessions: true },
    "tool:contract:pass-search", "tool:contract:pass-capture");
  assert.equal(passed.value.continuationUpdate.status, "updated", JSON.stringify(passed.value));
  assert.equal(passed.value.completionVerified, false);
  const passedRestart = freshWorldContext(item, binding);
  assert.equal(passedRestart.knowledge.continuation.tasks[0].lastVerifiedStep.result, "passed");
  assert.deepEqual(passedRestart.knowledge.continuation.tasks[0].nextStep, next);
  assert.equal(passedRestart.uncertainty.conflicts, 1,
    "the raw fail/pass measurements remain visibly contradictory instead of being erased");
  const compacted = await runHook({ hook_event_name: "PostCompact", host: "claude",
    cwd: item.project, session_id: "session:current", ...hookScope() });
  assert.match(compacted.context, /Publish the verified result\.txt report/);
  const prompted = await runHook({ hook_event_name: "UserPromptSubmit", host: "claude",
    cwd: item.project, session_id: "session:current", prompt: "Continue this exact task.",
    event_id: "event:contract:next-turn", ...hookScope() });
  assert.equal(prompted.blocked, false, prompted.reason);
  const recall = JSON.parse(prompted.context).briefing.preAnswerRecall;
  assert.equal(recall.task.lastVerifiedStep.result, "passed");
  assert.equal(recall.task.nextStep.summary, next.summary);
  assert.equal(recall.task.assertionId, passedRestart.knowledge.continuation.tasks[0].assertionId);
  assert.equal(recall.task.source.id, passedRestart.knowledge.continuation.tasks[0].source.id);
  assert.equal(recall.task.source.digest, passedRestart.knowledge.continuation.tasks[0].source.digest);
  assert.equal(recall.task.scope.threadRef, binding.threadRef);
  assert.equal(recall.task.correctionStatus, "none-current");
  let kingBytes = null;
  for (const environment of [{ CLAUDE_PLUGIN_ROOT: "/synthetic/claude" },
    { PLUGIN_ROOT: "/synthetic/codex" }, { BLUN_PLUGIN_ROOT: "/synthetic/blun" }]) {
    const native = hookOutput("UserPromptSubmit", prompted.context, environment).hookSpecificOutput;
    const modelContext = native.additionalContext || native.message;
    assert.match(modelContext, /Publish the verified result\.txt report/);
    assert.match(modelContext, /"result":"passed"/);
    assert.match(modelContext, new RegExp(recall.task.source.digest));
    assert.match(modelContext, new RegExp(binding.threadRef));
    assert.match(modelContext, /objective-measurement|none-current/);
    if (native.message) {
      kingBytes = Buffer.byteLength(native.message);
      assert.ok(kingBytes <= 1200);
    }
  }
  const duplicate = await captureQuery(item, { query: "Suite PASS", includePriorSessions: true },
    "tool:contract:duplicate-search", "tool:contract:duplicate-capture");
  assert.equal(duplicate.value.status, "duplicate");
  assert.equal(duplicate.value.continuationUpdate.status, "duplicate");
  assert.deepEqual(await readFile(item.source), sourceBefore);
  t.diagnostic(JSON.stringify({ correctThreadUpdates: "0 -> 2", falseTaskUpdates: 0,
    preservedConflicts: 1, automaticRetries: 0, repeatedWorkAfterPass: 0,
    restartContinuity: "2/2", postCompactHandoffs: "0 -> 3", kingBytes,
    elapsedMs: performance.now() - started, realModelRuns: 0 }));
});

test("newer user correction defeats an old outcome contract and explicit replacement can complete", async (t) => {
  const item = await fixture(t);
  const binding = route("thread:correction-priority");
  await enroll(item, "session:prior", item.source, binding);
  await enroll(item, "session:current", item.current, binding);
  setGateway(binding);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:current";
  const oldStep = { id: "step:suite-0", summary: "Run Suite 0 against result.txt." };
  const corrected = { id: "step:checksum-first", summary: "Check the result.txt checksum first." };
  const baseline = await taskState(item, binding, { id: "assertion:priority-baseline",
    value: continuation(oldStep), observedAt: "2026-09-07T04:00:00.000Z",
    recordedAt: "2026-09-07T04:01:00.000Z" });
  const oldContract = await taskState(item, binding, { id: "assertion:priority-old-contract",
    value: outcomeContract(oldStep, { status: "completed", nextStep: null }),
    observedAt: "2026-09-07T04:05:00.000Z", recordedAt: "2026-09-07T04:06:00.000Z",
    evidenceKind: "explicit-user-feedback" });
  const correction = await taskState(item, binding, { id: "assertion:priority-correction",
    value: continuation(corrected), observedAt: "2026-09-07T04:20:00.000Z",
    recordedAt: "2026-09-07T04:21:00.000Z",
    evidenceKind: "explicit-user-feedback", supersedes: [baseline.assertion.id] });
  const rejected = await captureQuery(item, { query: "Suite PASS", includePriorSessions: true },
    "tool:priority:old-search", "tool:priority:old-capture");
  assert.equal(rejected.value.continuationUpdate.status, "unavailable");
  assert.equal(rejected.value.continuationUpdate.reason, "timeline-outcome-contract-superseded");
  assert.deepEqual(freshWorldContext(item, binding).knowledge.continuation.tasks[0].nextStep, corrected);

  const hindsight = await taskState(item, binding, { id: "assertion:priority-hindsight-contract",
    value: outcomeContract(corrected, { status: "completed", nextStep: null }),
    observedAt: "2026-09-07T04:20:00.000Z", recordedAt: "2026-09-07T04:40:00.000Z",
    evidenceKind: "explicit-user-feedback",
    supersedes: [oldContract.assertion.id] });
  const postdated = await captureQuery(item, { query: "Suite PASS", includePriorSessions: true },
    "tool:priority:postdated-search", "tool:priority:postdated-capture");
  assert.equal(postdated.value.continuationUpdate.reason, "timeline-outcome-contract-postdated");
  await taskState(item, binding, { id: "assertion:priority-new-contract",
    value: outcomeContract(corrected, { status: "completed", nextStep: null },
      { testLabel: "test", total: 1, successCount: 1 }),
    observedAt: "2026-09-07T04:45:00.000Z", recordedAt: "2026-09-07T04:46:00.000Z",
    evidenceKind: "explicit-user-feedback", supersedes: [hindsight.assertion.id] });
  const accepted = await captureQuery(item, { query: "test PASS", includePriorSessions: true },
    "tool:priority:new-search", "tool:priority:new-capture");
  assert.equal(accepted.value.status, "captured");
  assert.equal(accepted.value.continuationUpdate.status, "updated");
  assert.equal(accepted.value.completionVerified, true);
  const restarted = freshWorldContext(item, binding);
  assert.equal(restarted.knowledge.continuation.tasks.length, 0);
  assert.equal(restarted.knowledge.continuation.terminal[0].status, "completed");
  assert.equal(restarted.knowledge.continuation.terminal[0].lastVerifiedStep.result, "passed");
  assert.equal(restarted.knowledge.continuation.terminal[0].nextStep, null);
  assert.equal(restarted.knowledge.current.some((entry) => entry.id === correction.assertion.id), false,
    "the correction is superseded only by its explicitly matching objective contract");
});

test("outcome contracts reject model authority, loose scope, and invalid success transitions", async (t) => {
  const item = await fixture(t);
  const binding = route("thread:contract-validation");
  const step = { id: "step:suite-0", summary: "Run Suite 0 against result.txt." };
  const value = outcomeContract(step, { status: "active",
    nextStep: { id: "step:publish", summary: "Publish result.txt." } });
  const base = { root: item.project, id: "assertion:validation-contract", subjectId: TASK,
    predicate: "task.timeline-outcome-contract", value, evidenceKind: "explicit-user-feedback",
    evidenceId: "user:validation-contract", evidenceDigest: hash(value),
    observedAt: "2026-09-07T04:10:00.000Z", projectId: PROJECT, groupId: null,
    privacy: "private", knowledgeKind: "task-state", sessionRef: `session-ref:${"d".repeat(32)}`,
    messageRef: "message:validation-contract", reason: "Synthetic validation contract.",
    portalRef: binding.portalRef, threadRef: binding.threadRef, now: "2026-09-07T04:11:00.000Z" };
  await assert.doesNotReject(recordWorldAssertion(base));
  for (const patch of [{ evidenceKind: "model-suggestion" }, { privacy: "shared" },
    { portalRef: null, threadRef: null }, { groupId: "group:foreign", privacy: "group" }]) {
    await assert.rejects(recordWorldAssertion({ ...base, ...patch,
      id: `assertion:invalid-${hash(JSON.stringify(patch)).slice(0, 16)}` }),
    /private source-bound task contract/);
  }
  for (const changed of [
    { ...value, measurement: { ...value.measurement, successCount: 16 } },
    { ...value, onSuccess: { status: "completed", nextStep: value.onSuccess.nextStep } }
  ]) {
    await assert.rejects(recordWorldAssertion({ ...base, value: changed,
      evidenceDigest: hash(changed), id: `assertion:invalid-${hash(changed).slice(0, 16)}` }));
  }
});
