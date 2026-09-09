import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, processCall } from "./mcp-bounded-fixture.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";
import { runHook } from "../src/hook.js";
import { hookOutput } from "../src/lib/hook-output.js";
import { preAnswerRecallCapsule } from "../src/lib/hook-output.js";
import { channelTimelineContinuity } from "../src/lib/channel-continuity.js";
import { recordWorldAssertion } from "../src/lib/world-model.js";

const NOW = "2026-09-08T08:00:00.000Z";
const HOOK_PATH = fileURLToPath(new URL("../src/hook.js", import.meta.url));
const TASK = "task:multisession-feedback";
const PROJECT = "project:multisession-feedback";
const SCOPE = { entityId: "agent:multisession-feedback", userId: "person:multisession-feedback",
  tenantId: "tenant:multisession-feedback", projectId: PROJECT, currentTaskId: TASK,
  groupId: null, goalId: "goal:multisession-feedback", goalStepId: "step:resume",
  timelineVisibility: "private-verified" };
const ENV_NAMES = ["AGENTSPINE_TIMELINE_SESSION_CAPABILITY", "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID",
  "AGENTSPINE_GATEWAY_CONTEXT", "AGENTSPINE_ENTITY_ID", "AGENTSPINE_USER_ID", "AGENTSPINE_TENANT_ID",
  "AGENTSPINE_PROJECT_ID", "AGENTSPINE_TASK_ID", "AGENTSPINE_GOAL_ID", "AGENTSPINE_GOAL_STEP_ID",
  "AGENTSPINE_GROUP_ID", "AGENTSPINE_HOST", "AGENTSPINE_PORTAL_REF", "AGENTSPINE_THREAD_REF"];
const hash = (value) => createHash("sha256").update(value).digest("hex");

function route() {
  return channelTimelineContinuity({ provider: "blun", tenantId: SCOPE.tenantId,
    accountId: "account:multisession-feedback", bindingId: "binding:multisession-feedback",
    chatId: "chat:multisession-feedback", threadId: "thread:a", sessionKey: "portal:multisession-feedback",
    agentId: SCOPE.entityId, projectId: PROJECT, groupId: null });
}

function gateway(binding) {
  Object.assign(process.env, { AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_ENTITY_ID: SCOPE.entityId, AGENTSPINE_USER_ID: SCOPE.userId,
    AGENTSPINE_TENANT_ID: SCOPE.tenantId, AGENTSPINE_PROJECT_ID: PROJECT,
    AGENTSPINE_TASK_ID: TASK, AGENTSPINE_GOAL_ID: SCOPE.goalId,
    AGENTSPINE_GOAL_STEP_ID: SCOPE.goalStepId, AGENTSPINE_HOST: "claude",
    AGENTSPINE_PORTAL_REF: binding.portalRef, AGENTSPINE_THREAD_REF: binding.threadRef });
  delete process.env.AGENTSPINE_GROUP_ID;
}

async function enroll(item, binding, sessionId, transcriptPath) {
  gateway(binding);
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = sessionId;
  const result = await enrollTimelineWithHostReceipt({ root: item.root, host: "claude", sessionId,
    scope: { ...SCOPE, portalRef: binding.portalRef, threadRef: binding.threadRef },
    transcriptPath, hostHome: process.env.CLAUDE_CONFIG_DIR });
  assert.equal(result.status, "enrolled", result.reason);
}

async function guarded(item, tool, id, fields, sessionId) {
  const result = await runHook({ hook_event_name: "PreToolUse", host: "claude", cwd: item.root,
    session_id: sessionId, tool_use_id: id,
    tool_name: `mcp__plugin_agent-spine_agent-spine__session_timeline_${tool}`,
    tool_input: fields, entity_id: SCOPE.entityId, user_id: SCOPE.userId, tenant_id: SCOPE.tenantId,
    project_id: PROJECT, task_id: TASK, goal_id: SCOPE.goalId, goal_step_id: SCOPE.goalStepId, group_id: null });
  assert.equal(result.blocked, false, result.reason);
  return result.updatedInput;
}

async function capture(item, sessionId, at, suffix) {
  const query = { at, query: "user message", windowSeconds: 1, includePriorSessions: true };
  const found = await processCall(item.root, "session_timeline_search",
    await guarded(item, "search", `tool:multisession:search:${suffix}`, query, sessionId));
  assert.equal(found.events.length, 1, JSON.stringify(found));
  const result = await processCall(item.root, "session_timeline_capture",
    await guarded(item, "capture", `tool:multisession:capture:${suffix}`,
      { ...query, eventId: found.events[0].id }, sessionId));
  assert.equal(result.status, "captured", JSON.stringify(result));
  return { query, found, assertion: result.captured };
}

function nativeClaudePrompt(root, input) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: "/synthetic/claude" };
  delete env.PLUGIN_ROOT;
  delete env.BLUN_PLUGIN_ROOT;
  const child = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: root, env, input: JSON.stringify(input), encoding: "utf8", timeout: 5000
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const context = JSON.parse(child.stdout).hookSpecificOutput?.additionalContext;
  assert.equal(typeof context, "string", child.stdout);
  return context;
}

test("one clarification preserves and rechecks candidates from two prior sessions", async (t) => {
  const started = performance.now();
  const item = await fixture(t, { homeRoot: false });
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  const binding = route();
  gateway(binding);
  const artifact = join(item.root, "result.txt");
  const artifactBytes = Buffer.from("synthetic multi-session result\r\n");
  await writeFile(artifact, artifactBytes);
  const target = { root: item.root, id: "assertion:multisession-baseline", subjectId: TASK,
    predicate: "task.continuation", value: { schema: "agentspine.task-continuation/v1", taskId: TASK,
      status: "active", objective: "Prepare result.txt using the selected source file",
      lastVerifiedStep: { id: "step:result", summary: "Created result.txt", result: "passed",
        evidenceId: "evidence:result", evidenceDigest: hash(artifactBytes),
        observedAt: "2026-09-08T05:00:00.000Z", sessionRef: `session-ref:${"a".repeat(32)}`,
        messageRef: "message:result" }, openQuestions: [],
      nextStep: { id: "step:select", summary: "Select the source file" } },
    evidenceKind: "objective-measurement", evidenceId: "evidence:result", evidenceDigest: hash(artifactBytes),
    observedAt: "2026-09-08T05:00:00.000Z", projectId: PROJECT, groupId: null,
    privacy: "private", knowledgeKind: "task-state", sessionRef: `session-ref:${"a".repeat(32)}`,
    messageRef: "message:result", portalRef: binding.portalRef, threadRef: binding.threadRef,
    now: new Date(NOW) };
  await recordWorldAssertion(target);
  const directory = join(process.env.CLAUDE_CONFIG_DIR, "projects", "multisession-feedback");
  await mkdir(directory, { recursive: true });
  const sources = [
    { session: "session:old-a", at: "2026-09-08T05:20:00.000Z",
      text: "Nein, nimm zuerst die Datei aus Sitzung A", path: join(directory, "old-a.jsonl") },
    { session: "session:old-b", at: "2026-09-08T05:40:00.000Z",
      text: "Nimm dafür doch die andere Datei", path: join(directory, "old-b.jsonl") }
  ];
  for (const source of sources) {
    source.bytes = Buffer.from(`${JSON.stringify({ timestamp: source.at,
      message: { role: "user", content: source.text } })}\n`);
    await writeFile(source.path, source.bytes);
    await enroll(item, binding, source.session, source.path);
    const indexed = await processCall(item.root, "session_timeline_index",
      await guarded(item, "index", `tool:multisession:index:${source.session}`,
        { maxBytes: 65_536 }, source.session));
    assert.equal(indexed.status, "indexed", JSON.stringify(indexed));
  }
  const currentPath = join(directory, "current.jsonl");
  await writeFile(currentPath, `${JSON.stringify({ timestamp: "2026-09-08T06:00:00.000Z",
    message: { role: "user", content: "Bitte setze den Auftrag fort." } })}\n`);
  const currentSession = "session:current";
  await enroll(item, binding, currentSession, currentPath);
  const first = await capture(item, currentSession, sources[0].at, "a");
  const second = await capture(item, currentSession, sources[1].at, "b");
  assert.notEqual(first.assertion.value.sourceDigest, second.assertion.value.sourceDigest);
  assert.notEqual(first.assertion.source.sessionRef, second.assertion.source.sessionRef);
  const ids = [first.assertion.assertionId, second.assertion.assertionId].sort();
  const interpretation = { schema: "agentspine.timeline-user-feedback-clarification-request/v2",
    feedbackAssertionIds: ids, targetAssertionId: target.id,
    clarificationQuestion: "Welche der beiden Sitzungsdateien soll ich verwenden?" };
  const interpretationFields = { ...second.query, eventId: second.found.events[0].id, interpretation };
  const proposed = await processCall(item.root, "session_timeline_capture",
    await guarded(item, "capture", "tool:multisession:clarify", interpretationFields, currentSession));
  assert.equal(proposed.status, "captured", JSON.stringify(proposed));
  assert.deepEqual(proposed.captured.value.sourceBindings
    .map((item) => item.feedbackAssertionId), ids);
  assert.equal(proposed.captured.value.completionVerified, false);
  const duplicate = await processCall(item.root, "session_timeline_capture",
    await guarded(item, "capture", "tool:multisession:duplicate", interpretationFields, currentSession));
  assert.equal(duplicate.status, "duplicate", JSON.stringify(duplicate));
  const competing = { ...interpretationFields, interpretation: { ...interpretation,
    clarificationQuestion: "Welche Datei meinst du genau?" } };
  const conflicted = await processCall(item.root, "session_timeline_capture",
    await guarded(item, "capture", "tool:multisession:conflict", competing, currentSession));
  assert.equal(conflicted.reason, "timeline-feedback-interpretation-conflicted");
  const compact = await runHook({ hook_event_name: "PostCompact", host: "claude", cwd: item.root,
    session_id: currentSession, entity_id: SCOPE.entityId, user_id: SCOPE.userId,
    tenant_id: SCOPE.tenantId, project_id: PROJECT, task_id: TASK,
    goal_id: SCOPE.goalId, goal_step_id: SCOPE.goalStepId, group_id: null });
  assert.match(compact.context, /Welche der beiden Sitzungsdateien/);
  const prompted = nativeClaudePrompt(item.root, { hook_event_name: "UserPromptSubmit", host: "claude", cwd: item.root,
    session_id: currentSession, event_id: "turn:multisession:recall", prompt: "Setze den Auftrag fort",
    entity_id: SCOPE.entityId, user_id: SCOPE.userId, tenant_id: SCOPE.tenantId,
    project_id: PROJECT, task_id: TASK, goal_id: SCOPE.goalId,
    goal_step_id: SCOPE.goalStepId, group_id: null });
  const capsule = preAnswerRecallCapsule(JSON.parse(prompted));
  t.diagnostic(JSON.stringify({ capsuleBytes: Buffer.byteLength(JSON.stringify(capsule)) }));
  for (const env of [{ CLAUDE_PLUGIN_ROOT: "/synthetic/claude" }, { PLUGIN_ROOT: "/synthetic/codex" },
    { BLUN_PLUGIN_ROOT: "/synthetic/blun" }]) {
    const native = hookOutput("UserPromptSubmit", prompted, env).hookSpecificOutput;
    const text = native.additionalContext || native.message;
    assert.match(text, /Datei aus Sitzung A/);
    assert.match(text, /andere Datei/);
    assert.match(text, /Welche der beiden Sitzungsdateien/);
    assert.match(text, /result.txt/);
    if (native.message) assert.ok(Buffer.byteLength(native.message) <= 1200);
  }
  await writeFile(sources[0].path, Buffer.concat([sources[0].bytes, Buffer.from(" ")]));
  const changed = await processCall(item.root, "session_timeline_capture",
    await guarded(item, "capture", "tool:multisession:changed", interpretationFields, currentSession));
  assert.equal(changed.reason, "timeline-feedback-interpretation-source-mismatch");
  await writeFile(sources[0].path, sources[0].bytes);
  assert.deepEqual(await readFile(sources[0].path), sources[0].bytes);
  assert.deepEqual(await readFile(sources[1].path), sources[1].bytes);
  assert.deepEqual(await readFile(artifact), artifactBytes);
  await item.preserve();
  t.diagnostic(JSON.stringify({ sources: "1 -> 2", exactBindings: "0 -> 2",
    falseAutomaticApplications: 0, contextBytes: Buffer.byteLength(compact.context),
    elapsedMs: performance.now() - started, realModelRuns: 0 }));
});
