import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, processCall } from "./mcp-bounded-fixture.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";
import { runHook } from "../src/hook.js";
import { channelTimelineContinuity } from "../src/lib/channel-continuity.js";
import { recordWorldAssertion } from "../src/lib/world-model.js";
import { sessionTimelineStatePaths } from "../src/lib/session-timeline-auth.js";

const TASK = "task:timeline-correction";
const PROJECT = "project:timeline-correction";
const AT = "2026-09-07T05:20:00.000Z";
const SCOPE = { entityId: "agent:timeline-correction", userId: "person:timeline-correction",
  tenantId: "tenant:timeline-correction", projectId: PROJECT, currentTaskId: TASK,
  groupId: null, goalId: "goal:timeline-correction", goalStepId: "step:resume",
  timelineVisibility: "private-verified" };
const ENV_NAMES = ["AGENTSPINE_TIMELINE_SESSION_CAPABILITY", "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID",
  "AGENTSPINE_GATEWAY_CONTEXT", "AGENTSPINE_ENTITY_ID", "AGENTSPINE_USER_ID", "AGENTSPINE_TENANT_ID",
  "AGENTSPINE_PROJECT_ID", "AGENTSPINE_TASK_ID", "AGENTSPINE_GOAL_ID", "AGENTSPINE_GOAL_STEP_ID",
  "AGENTSPINE_GROUP_ID", "AGENTSPINE_HOST", "AGENTSPINE_PORTAL_REF", "AGENTSPINE_THREAD_REF"];

function route(threadId) {
  return channelTimelineContinuity({ provider: "blun", tenantId: SCOPE.tenantId,
    accountId: "account:timeline-correction", bindingId: "binding:timeline-correction",
    chatId: "chat:timeline-correction", threadId, sessionKey: "portal:timeline-correction",
    agentId: SCOPE.entityId, projectId: PROJECT, groupId: null });
}

function setGateway(binding) {
  Object.assign(process.env, { AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_ENTITY_ID: SCOPE.entityId, AGENTSPINE_USER_ID: SCOPE.userId,
    AGENTSPINE_TENANT_ID: SCOPE.tenantId, AGENTSPINE_PROJECT_ID: PROJECT,
    AGENTSPINE_TASK_ID: TASK, AGENTSPINE_GOAL_ID: SCOPE.goalId,
    AGENTSPINE_GOAL_STEP_ID: SCOPE.goalStepId, AGENTSPINE_HOST: "claude",
    AGENTSPINE_PORTAL_REF: binding.portalRef, AGENTSPINE_THREAD_REF: binding.threadRef });
  delete process.env.AGENTSPINE_GROUP_ID;
}

function scoped(binding) { return { ...SCOPE, portalRef: binding.portalRef, threadRef: binding.threadRef }; }

function hookInput(item, tool, id, fields, sessionId = "session:current") {
  return { hook_event_name: "PreToolUse", host: "claude", cwd: item.root, session_id: sessionId,
    tool_use_id: id, tool_name: `mcp__plugin_agent-spine_agent-spine__session_timeline_${tool}`,
    tool_input: fields, entity_id: SCOPE.entityId, user_id: SCOPE.userId, tenant_id: SCOPE.tenantId,
    project_id: PROJECT, task_id: TASK, goal_id: SCOPE.goalId, goal_step_id: SCOPE.goalStepId,
    group_id: null };
}

async function guarded(item, tool, id, fields, sessionId = "session:current") {
  const result = await runHook(hookInput(item, tool, id, fields, sessionId));
  assert.equal(result.blocked, false, result.reason);
  return result.updatedInput;
}

async function world(item, includeHistory = false) {
  const result = await processCall(item.root, "world_context", { root: item.root, projectId: PROJECT,
    includePrivate: true, includeKnowledgeHistory: includeHistory,
    continuationTaskId: TASK, now: "2026-09-07T06:40:00.000Z" });
  assert.equal(result.isError, false);
  return result;
}

function continuation(nextStep) {
  return { schema: "agentspine.task-continuation/v1", taskId: TASK, status: "active",
    objective: "Resume the exact synthetic portal thread.", lastVerifiedStep: null, openQuestions: [],
    nextStep: { id: "step:old-plan", summary: nextStep } };
}

async function baseline(item, binding) {
  await recordWorldAssertion({ root: item.root, id: "assertion:timeline-correction-baseline",
    subjectId: TASK, predicate: "task.continuation", value: continuation("Repeat the obsolete migration."),
    evidenceKind: "objective-measurement", evidenceId: "evidence:timeline-correction-baseline",
    evidenceDigest: "a".repeat(64), observedAt: "2026-09-07T05:00:00.000Z",
    projectId: PROJECT, groupId: null, privacy: "private", knowledgeKind: "task-state",
    sessionRef: `session-ref:${"b".repeat(32)}`, messageRef: "timeline-event:baseline-correction",
    portalRef: binding.portalRef, threadRef: binding.threadRef, now: new Date("2026-09-07T05:01:00.000Z") });
}

async function enroll(item, binding, sessionId, source) {
  setGateway(binding);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = sessionId;
  const result = await enrollTimelineWithHostReceipt({ root: item.root, host: "claude", sessionId,
    scope: scoped(binding), transcriptPath: source, hostHome: process.env.CLAUDE_CONFIG_DIR });
  assert.equal(result.status, "enrolled", result.reason);
}

test("explicit user correction atomically replaces only the exact-thread continuation across restart", async (t) => {
  const started = performance.now();
  const item = await fixture(t, { homeRoot: false });
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  const directory = join(process.env.CLAUDE_CONFIG_DIR, "projects", "timeline-correction");
  await mkdir(directory, { recursive: true });
  const prior = join(directory, "prior.jsonl");
  const current = join(directory, "current.jsonl");
  const correction = "Korrektur: nächster Schritt: Prüfe die synthetische Prüfsumme, dann migriere.";
  await writeFile(prior, [
    { timestamp: "2026-09-07T04:50:00.000Z", message: { role: "user",
      content: "Correction: next step: Use the stale obsolete instruction." } },
    { timestamp: "2026-09-07T05:18:00.000Z", message: { role: "assistant", content: correction } },
    { timestamp: "2026-09-07T05:19:00.000Z", message: { role: "user", content: "Bitte ändere den Plan irgendwann." } },
    { timestamp: AT, message: { role: "user", content: correction } }
  ].map((value) => `${JSON.stringify(value)}\n`).join(""));
  await writeFile(current, `${JSON.stringify({ timestamp: "2026-09-07T05:30:00.000Z",
    message: { role: "user", content: "Setze den Faden fort." } })}\n`);
  const sourceBytes = await readFile(prior);
  const routeA = route("thread:correction-a");
  const routeB = route("thread:correction-b");
  await baseline(item, routeA);
  await enroll(item, routeA, "session:prior", prior);
  const indexedArgs = await guarded(item, "index", "tool:correction:index", { maxBytes: 65_536 }, "session:prior");
  assert.equal((await processCall(item.root, "session_timeline_index", indexedArgs)).status, "indexed");
  const sidecar = await readFile((await sessionTimelineStatePaths(item.root)).path, "utf8");
  assert.doesNotMatch(sidecar, /synthetische Prüfsumme|stale obsolete instruction/,
    "the authenticated index retains no correction text");
  await enroll(item, routeA, "session:current", current);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:current";

  const before = await world(item);
  assert.equal(before.knowledge.continuation.tasks[0].nextStep.summary, "Repeat the obsolete migration.");
  const staleQuery = { at: "2026-09-07T04:50:00.000Z", includePriorSessions: true };
  const staleSearchArgs = await guarded(item, "search", "tool:correction:stale-search", staleQuery);
  const staleSearch = await processCall(item.root, "session_timeline_search", staleSearchArgs);
  assert.equal(staleSearch.events.length, 1);
  const staleArgs = await guarded(item, "capture", "tool:correction:stale", {
    ...staleQuery, eventId: staleSearch.events[0].id });
  const stale = await processCall(item.root, "session_timeline_capture", staleArgs);
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.reason, "timeline-correction-stale");
  assert.equal((await world(item)).knowledge.continuation.tasks[0].nextStep.summary,
    "Repeat the obsolete migration.");
  const query = { at: AT, includePriorSessions: true };
  const searchArgs = await guarded(item, "search", "tool:correction:search", query);
  const searched = await processCall(item.root, "session_timeline_search", searchArgs);
  assert.equal(searched.status, "found", JSON.stringify(searched));
  assert.equal(searched.events.length, 1, "assistant and ordinary user text must not enter the event index");
  assert.equal(searched.events[0].kind, "explicit-next-step-correction");
  assert.equal(searched.events[0].nextStepSummary, "Prüfe die synthetische Prüfsumme, dann migriere.");
  const fields = { ...query, eventId: searched.events[0].id, subjectId: "task:foreign",
    nextStepSummary: "Caller-controlled overwrite" };
  const leftArgs = await guarded(item, "capture", "tool:correction:left", fields);
  const rightArgs = await guarded(item, "capture", "tool:correction:right", fields);
  assert.equal("subjectId" in leftArgs, false);
  assert.equal("nextStepSummary" in leftArgs, false);
  const results = await Promise.all([processCall(item.root, "session_timeline_capture", leftArgs),
    processCall(item.root, "session_timeline_capture", rightArgs)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["captured", "duplicate"], JSON.stringify(results));

  const after = await world(item, true);
  assert.equal(after.knowledge.continuation.tasks.length, 1);
  assert.equal(after.knowledge.continuation.tasks[0].nextStep.summary,
    "Prüfe die synthetische Prüfsumme, dann migriere.");
  assert.equal(after.knowledge.continuation.tasks[0].source.kind, "explicit-user-feedback");
  assert.equal(after.knowledge.history.filter((entry) => entry.predicate === "task.continuation").length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(after)) < 16_384, "fresh-process context remains bounded");

  setGateway(routeB);
  const foreign = await world(item);
  assert.equal(foreign.knowledge.continuation.tasks.length, 0,
    "the same task in a foreign thread receives no private continuation");
  setGateway(routeA);
  const duplicateArgs = await guarded(item, "capture", "tool:correction:restart", {
    ...query, eventId: searched.events[0].id });
  assert.equal((await processCall(item.root, "session_timeline_capture", duplicateArgs)).status, "duplicate");
  assert.deepEqual(await readFile(prior), sourceBytes,
    "index, search, capture, race and restart preserve the enrolled user source byte-for-byte");
  console.info(JSON.stringify({ beforeCorrectNextSteps: 0, afterCorrectNextSteps: 1,
    staleCorrectionsApplied: 0, foreignThreadContinuations: foreign.knowledge.continuation.tasks.length,
    contextBytes: Buffer.byteLength(JSON.stringify(after)), elapsedMs: performance.now() - started,
    unnecessaryQuestions: null, repeatedErrors: null, tokens: null, realModelRuns: 0 }));
  await item.preserve();
});

test("active supersession compare-and-swap rejects a stale competing correction", async (t) => {
  const item = await fixture(t, { homeRoot: false });
  const binding = route("thread:correction-cas");
  await baseline(item, binding);
  const common = { root: item.root, subjectId: TASK, predicate: "task.continuation",
    evidenceKind: "explicit-user-feedback", evidenceDigest: "c".repeat(64), projectId: PROJECT,
    groupId: null, privacy: "private", knowledgeKind: "task-state", portalRef: binding.portalRef,
    threadRef: binding.threadRef, supersedes: ["assertion:timeline-correction-baseline"],
    requireActiveSupersedes: true, sessionRef: `session-ref:${"d".repeat(32)}` };
  await recordWorldAssertion({ ...common, id: "assertion:timeline-correction-first",
    value: continuation("Use the first correction."), evidenceId: "evidence:timeline-correction-first",
    messageRef: "timeline-event:correction-first", observedAt: "2026-09-07T06:10:00.000Z",
    now: new Date("2026-09-07T06:11:00.000Z") });
  await assert.rejects(recordWorldAssertion({ ...common, id: "assertion:timeline-correction-stale",
    value: continuation("Use the stale competing correction."), evidenceId: "evidence:timeline-correction-stale",
    messageRef: "timeline-event:correction-stale", observedAt: "2026-09-07T06:10:30.000Z",
    now: new Date("2026-09-07T06:11:00.000Z") }), /compare-and-swap failed/);
});
