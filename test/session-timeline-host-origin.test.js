import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "../src/lib/coordination.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";
import {
  currentHostTranscriptReceipt, enrollPrivateSessionTimeline, issueHostTranscriptReceipt,
  LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION
} from "../src/lib/session-timeline-enrollment.js";
import { preflightStatus } from "../src/lib/preflight.js";
import {
  TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV
} from "../src/lib/session-timeline-transport.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function scope() {
  return { entityId: "agent:host-origin", userId: "person:host-origin", tenantId: "tenant:host-origin",
    projectId: "project:host-origin", currentTaskId: "task:host-origin", goalId: "goal:host-origin",
    goalStepId: "step:host-origin", groupId: null };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-host-origin-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const transcript = join(profile, "projects", "host-origin", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "host-origin"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(project, "CLAUDE.md"), "# Synthetic project rules\n"),
    writeFile(join(profile, "CLAUDE.md"), "# Synthetic host rules\n"),
    writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:00.000Z", message: {
      role: "tool", content: "Measured host-origin Suite 0; result: PASS 15/15." } })}\n`)
  ]);
  const names = ["AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const environment = {
    [TIMELINE_TRANSPORT_CAPABILITY_ENV]: `astc_${randomBytes(32).toString("base64url")}`,
    [TIMELINE_TRANSPORT_SESSION_ENV]: "session:host-origin"
  };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  Object.assign(process.env, environment);
  await upsertEntity({ root: project, id: "agent:host-origin", kind: "agent", privacy: "shared" });
  await upsertEntity({ root: project, id: "group:synthetic", kind: "group", privacy: "shared" });
  await upsertEntity({ root: project, id: "project:host-origin", kind: "project", privacy: "shared" });
  await linkEntities({ root: project, from: "agent:host-origin", to: "group:synthetic",
    relation: "member-of", privacy: "group" });
  await createTask({ root: project, id: "task:host-origin", actorId: "agent:host-origin",
    assigneeId: "agent:host-origin", projectId: "project:host-origin", title: "Synthetic host origin" });
  t.after(async () => {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { project, profile, transcript, environment };
}

function promptInput(item, { eventId = "event:host-origin", prompt = "Prepare the host origin.", event = "UserPromptSubmit", now = new Date() } = {}) {
  return { hook_event_name: event, host: "claude", cwd: item.project, session_id: "session:host-origin",
    event_id: eventId, entity_id: "agent:host-origin", user_id: "person:host-origin", tenant_id: "tenant:host-origin",
    profile_id: "profile:host-origin", project_id: "project:host-origin", task_id: "task:host-origin",
    goal_id: "goal:host-origin", goal_step_id: "step:host-origin", transcript_path: item.transcript,
    ...(prompt === undefined ? {} : { prompt }), timestamp: now.toISOString() };
}

async function pending(item, now) {
  return currentHostTranscriptReceipt({ root: item.project, clock: () => new Date(now), environment: item.environment });
}

function timelineDiagnostic(result) {
  return JSON.parse(result.context).sourceResolution.timeline;
}

test("only a consumed exact UserPromptSubmit can issue an opaque host receipt", async (t) => {
  const now = new Date();
  const item = await fixture(t);
  const before = hash(await readFile(item.transcript));
  const result = await runHook(promptInput(item, { now }));
  assert.equal(result.blocked, false);
  assert.equal((await preflightStatus(process.env)).lastTurn.status, "consumed");
  const receipt = await pending(item, now);
  assert.equal(receipt.status, "pending");
  assert.match(receipt.receipt, /^asthr_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(result).includes(receipt.receipt), false);
  assert.equal(String(result.context).includes(receipt.receipt), false);
  const enrolled = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: receipt.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, environment: item.environment, clock: () => new Date(now) });
  assert.equal(enrolled.status, "enrolled");
  assert.deepEqual(enrolled.binding, { host: "claude", sessionId: "session:host-origin", entityId: "agent:host-origin",
    userId: "person:host-origin", tenantId: "tenant:host-origin", projectId: "project:host-origin", groupId: null,
    taskId: "task:host-origin", goalId: "goal:host-origin", goalStepId: "step:host-origin" });
  assert.equal(hash(await readFile(item.transcript)), before);
});

test("optional or excluded timeline origins never block a consumed normal prompt", async (t) => {
  const now = new Date();
  const item = await fixture(t);
  const cases = [
    { id: "no-transcript", expect: { status: "unavailable" }, change: (input) => { delete input.transcript_path; } },
    { id: "group", expect: { status: "group-suppressed" }, change: (input) => {
      input.group_id = "group:synthetic";
      delete input.task_id;
    } },
    { id: "codex", expect: { status: "unavailable", reason: "host-not-supported" }, change: (input) => { input.host = "codex"; } }
  ];
  for (const itemCase of cases) {
    const input = promptInput(item, { eventId: `event:optional-${itemCase.id}`, now });
    itemCase.change(input);
    const result = await runHook(input);
    assert.equal(result.blocked, false, itemCase.id);
    assert.equal((await preflightStatus(process.env)).lastTurn.status, "consumed", itemCase.id);
    assert.equal((await pending(item, now)).status, "unavailable", itemCase.id);
    const diagnostic = timelineDiagnostic(result);
    assert.equal(diagnostic.status, itemCase.expect.status, itemCase.id);
    if (itemCase.expect.reason) assert.equal(diagnostic.reason, itemCase.expect.reason, itemCase.id);
  }
});

test("raw imports and forged lifecycle objects cannot issue a host receipt", async (t) => {
  const now = new Date();
  const item = await fixture(t);
  const before = hash(await readFile(item.transcript));
  const forged = Object.freeze({ root: item.project, hostHome: item.profile, event: "UserPromptSubmit",
    input: { transcript_path: item.transcript, event_id: "event:forged" }, binding: { host: "claude" } });
  for (const hostOrigin of [null, forged]) {
    const result = await issueHostTranscriptReceipt({ root: item.project, host: "claude", sessionId: "session:host-origin",
      scope: scope(), transcriptPath: item.transcript, hostHome: item.profile, event: "UserPromptSubmit",
      eventId: "event:forged", hostOrigin, environment: item.environment, clock: () => new Date(now) });
    assert.deepEqual(result, { schema: "agentspine.session-timeline-host-receipt/v1", status: "unavailable",
      reason: "host-lifecycle-receipt-required", receipt: null, expiresAt: null, authority: "context-only" });
  }
  const wrongEvent = await issueHostTranscriptReceipt({ root: item.project, host: "claude", sessionId: "session:host-origin",
    scope: scope(), transcriptPath: item.transcript, hostHome: item.profile, event: "PreToolUse", hostOrigin: forged,
    environment: item.environment, clock: () => new Date(now) });
  assert.equal(wrongEvent.reason, "host-receipt-event-not-supported");
  assert.equal((await pending(item, now)).status, "unavailable");
  assert.equal(hash(await readFile(item.transcript)), before);
});

test("a replayed or malformed UserPromptSubmit creates no second opaque receipt", async (t) => {
  const now = new Date();
  const item = await fixture(t);
  const input = promptInput(item, { eventId: "event:replayed", now });
  assert.equal((await runHook(input)).blocked, false);
  const first = await pending(item, now);
  assert.equal(first.status, "pending");
  assert.equal((await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: first.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, environment: item.environment, clock: () => new Date(now) })).status,
  "enrolled");
  const replay = await runHook(input);
  assert.equal(replay.blocked, true);
  assert.match(replay.reason, /delivery replay/);
  assert.equal((await pending(item, now)).status, "unavailable");
  const missingPrompt = await runHook(promptInput(item, { eventId: "event:no-prompt", prompt: null, now }));
  assert.equal(missingPrompt.blocked, true);
  assert.equal((await pending(item, now)).status, "unavailable");
});

test("non-prompt lifecycle events cannot create a host receipt", async (t) => {
  const now = new Date();
  const item = await fixture(t);
  const before = hash(await readFile(item.transcript));
  const result = await runHook(promptInput(item, { event: "SessionStart", eventId: "event:session-start", now }));
  assert.equal(result.blocked, false);
  assert.equal((await pending(item, now)).status, "unavailable");
  assert.equal(hash(await readFile(item.transcript)), before);
});
