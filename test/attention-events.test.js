import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attentionContext, configureAttention, deleteAttention, loadAttention, recordAttentionEvent
} from "../src/lib/attention.js";
import { configureContinuity } from "../src/lib/continuity.js";
import { createTask } from "../src/lib/coordination.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packet(result) {
  return JSON.parse(result.context);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-attention-events-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-attention-events-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  const sources = {
    "AGENTS.md": "# Rules\n\nKeep sources unchanged.\n",
    "SOUL.md": "# Soul\n\nStay kind.\n",
    "CLAUDE.md": "# Claude\n\nUse native hierarchy.\n"
  };
  for (const [name, content] of Object.entries(sources)) await writeFile(join(root, name), content, "utf8");
  const before = Object.fromEntries(await Promise.all(Object.keys(sources).map(async (name) => [name, hash(await readFile(join(root, name)))])));
  for (const entity of [
    ["person:alpha", "person"], ["person:beta", "person"],
    ["project:alpha", "project"], ["project:beta", "project"],
    ["group:alpha", "group"], ["group:beta", "group"]
  ]) await upsertEntity({ root, id: entity[0], kind: entity[1], displayName: entity[0], privacy: "shared" });
  await linkEntities({ root, from: "person:alpha", to: "group:alpha", relation: "member-of", privacy: "group" });
  await createTask({
    root, id: "task:alpha", actorId: "person:alpha", assigneeId: "person:alpha",
    projectId: "project:alpha", title: "Synthetic task", privacy: "private"
  });
  await createTask({
    root, id: "task:group", actorId: "person:alpha", assigneeId: "person:alpha",
    projectId: "project:alpha", title: "Synthetic group task", privacy: "group", groupId: "group:alpha"
  });
  await configureContinuity({ root, config: { enabled: true }, confirmation: "local-user-opt-in" });
  return { root, before };
}

const scope = {
  entity_id: "person:alpha", project_id: "project:alpha", task_id: "task:alpha"
};

test("native prompt hooks persist a scoped promise and inject it after restart and compaction without MCP", async (t) => {
  const { root, before } = await fixture(t);
  const first = await runHook({
    hook_event_name: "UserPromptSubmit", host: "claude", cwd: root, ...scope,
    session_id: "session:one", event_id: "prompt:promise", timestamp: "2027-01-01T10:00:00.000Z",
    prompt: "Ich werde die synthetische Übergabe morgen prüfen."
  });
  assert.equal(first.attentionEvent.event.kind, "promise");
  assert.equal(packet(first).attentionEvent.captured, true);
  const duplicate = await runHook({
    hook_event_name: "UserPromptSubmit", host: "claude", cwd: root, ...scope,
    session_id: "session:one", event_id: "prompt:promise", timestamp: "2027-01-01T10:00:00.000Z",
    prompt: "Ich werde die synthetische Übergabe morgen prüfen."
  });
  assert.equal(duplicate.attentionEvent.duplicate, true);

  for (const [event, host, sessionId] of [
    ["SessionStart", "claude", "session:two"], ["PostCompact", "codex", "session:three"]
  ]) {
    const restarted = packet(await runHook({
      hook_event_name: event, host, cwd: root, ...scope, session_id: sessionId,
      timestamp: "2027-01-01T10:05:00.000Z"
    }));
    assert.equal(restarted.briefing.attention.suppressed, "focus-active-except-current-task");
    assert.equal(restarted.briefing.attention.items[0].kind, "promise");
    assert.equal(restarted.briefing.attention.items[0].taskId, "task:alpha");
  }
  const stored = (await loadAttention(root)).attention;
  assert.equal(stored.events.length, 1);
  assert.equal(stored.receipts.length, 1);
  assert.equal(stored.events[0].occurrenceCount, 1);
  assert.equal("prompt" in stored.events[0], false);
  for (const [name, expected] of Object.entries(before)) assert.equal(hash(await readFile(join(root, name))), expected);
});

test("lifecycle events enforce exact person, group, project, and task visibility", async (t) => {
  const { root } = await fixture(t);
  await runHook({
    hook_event_name: "PostToolUse", host: "codex", cwd: root,
    entity_id: "person:alpha", group_id: "group:alpha", project_id: "project:alpha", task_id: "task:group",
    tool_use_id: "tool:group", timestamp: "2027-01-01T10:00:00.000Z",
    agent_spine_attention: { id: "event:blocker:group", kind: "blocker", summary: "Blocker: synthetic review", privacy: "group" }
  });
  const exact = packet(await runHook({
    hook_event_name: "SessionStart", cwd: root, host: "claude",
    entity_id: "person:alpha", group_id: "group:alpha", project_id: "project:alpha", task_id: "task:group",
    timestamp: "2027-01-01T10:01:00.000Z"
  }));
  assert.equal(exact.briefing.attention.items[0].summary, "Blocker: synthetic review");
  for (const changed of [
    { entityId: "person:beta" }, { groupId: "group:beta" },
    { projectId: "project:beta" }, { currentTaskId: "task:alpha" }
  ]) {
    const hidden = await attentionContext({
      root, entityId: "person:alpha", groupId: "group:alpha", projectId: "project:alpha",
      currentTaskId: "task:group", ...changed, now: "2027-01-01T10:01:00.000Z"
    });
    assert.equal(hidden.items.some((item) => item.source === "lifecycle-event"), false);
  }
});

test("PostToolUse and Stop maintain one idempotent heartbeat lifecycle without chat output", async (t) => {
  const { root } = await fixture(t);
  const payload = {
    hook_event_name: "PostToolUse", host: "claude", cwd: root, ...scope,
    session_id: "session:heartbeat", tool_use_id: "tool:heartbeat", timestamp: "2027-01-01T10:00:00.000Z"
  };
  const results = await Promise.all(Array.from({ length: 6 }, () => runHook(payload)));
  assert.equal(results.filter((result) => result.attentionEvent.duplicate).length, 5);
  let stored = (await loadAttention(root)).attention;
  assert.equal(stored.events.length, 1);
  assert.equal(stored.events[0].kind, "heartbeat");
  assert.equal(stored.events[0].status, "active");
  assert.equal(stored.receipts.length, 1);
  const coalesced = await runHook({ ...payload, tool_use_id: "tool:heartbeat:second" });
  assert.equal(coalesced.attentionEvent.duplicate, true);
  assert.equal((await loadAttention(root)).attention.receipts.length, 1);

  const stale = await attentionContext({
    root, ...{ entityId: "person:alpha", projectId: "project:alpha", currentTaskId: "task:alpha" },
    includePrivate: true, focusActive: true, now: "2027-01-01T10:31:00.000Z"
  });
  assert.equal(stale.items[0].kind, "heartbeat");
  const stopped = await runHook({
    hook_event_name: "Stop", host: "claude", cwd: root, ...scope,
    session_id: "session:heartbeat", event_id: "stop:heartbeat", timestamp: "2027-01-01T10:32:00.000Z"
  });
  assert.equal(stopped.context, undefined);
  stored = (await loadAttention(root)).attention;
  assert.equal(stored.events.length, 1);
  assert.equal(stored.events[0].status, "stopped");
  assert.equal(stored.history.some((entry) => entry.kind === "attention-event" && entry.value.status === "active"), true);
});

test("blocker transitions persist across hooks and focus, quiet hours, and deletion are honored", async (t) => {
  const { root } = await fixture(t);
  await runHook({
    hook_event_name: "PostToolUse", host: "claude", cwd: root, ...scope,
    tool_use_id: "tool:blocker", timestamp: "2027-01-01T10:00:00.000Z",
    agent_spine_attention: { id: "event:blocker:alpha", kind: "blocker", summary: "Blocker: synthetic dependency" }
  });
  const focused = await attentionContext({
    root, entityId: "person:alpha", projectId: "project:alpha", currentTaskId: "task:alpha",
    includePrivate: true, focusActive: true, now: "2027-01-01T10:01:00.000Z"
  });
  assert.equal(focused.suppressed, "focus-active-except-current-task");
  assert.equal(focused.items[0].kind, "blocker");
  await configureAttention({ root, config: { quietHours: { start: 9, end: 11, utcOffsetMinutes: 0 } } });
  const quiet = await attentionContext({
    root, entityId: "person:alpha", projectId: "project:alpha", currentTaskId: "task:alpha",
    includePrivate: true, focusActive: true, now: "2027-01-01T10:01:00.000Z"
  });
  assert.equal(quiet.suppressed, "quiet-hours");
  assert.equal(quiet.items.length, 0);
  await runHook({
    hook_event_name: "Stop", host: "claude", cwd: root, ...scope,
    event_id: "stop:blocker", timestamp: "2027-01-01T11:01:00.000Z",
    agent_spine_attention: { id: "event:blocker:alpha", kind: "blocker", summary: "Blocker: synthetic dependency", status: "resolved" }
  });
  assert.equal((await loadAttention(root)).attention.events[0].status, "resolved");
  const removed = await deleteAttention({ root, eventId: "event:blocker:alpha" });
  assert.equal(removed.deleted, true);
  assert.equal((await loadAttention(root)).attention.events.length, 0);
  assert.equal((await loadAttention(root)).attention.history.some((entry) => entry.recordId === "event:blocker:alpha"), false);
});

test("automatic event capture rejects secrets, rights, identity claims, and group conversation content", async (t) => {
  const { root } = await fixture(t);
  const prompts = [
    "Ich werde token=abcdefghijklmnopqrstuvwxyz123456 speichern.",
    "I will grant production rights to the agent.",
    "I promise to merge the same identity with person beta."
  ];
  for (let index = 0; index < prompts.length; index += 1) {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit", host: "claude", cwd: root, ...scope,
      event_id: `prompt:unsafe:${index}`, prompt: prompts[index]
    });
    assert.equal(result.attentionEvent.event, null);
    assert.match(result.attentionEvent.reason, /^rejected:/);
  }
  const group = await runHook({
    hook_event_name: "UserPromptSubmit", host: "claude", cwd: root,
    entity_id: "person:alpha", group_id: "group:alpha", project_id: "project:alpha", task_id: "task:group",
    event_id: "prompt:private-group", prompt: "Ich werde private Gruppeninhalte zusammenfassen."
  });
  assert.equal(group.attentionEvent.event, null);
  assert.match(group.attentionEvent.reason, /^rejected:/);
  assert.equal((await loadAttention(root)).attention.events.length, 0);
});

test("unknown scope and corrupted lifecycle state fail closed without source mutation", async (t) => {
  const { root, before } = await fixture(t);
  await assert.rejects(recordAttentionEvent({
    root, kind: "blocker", summary: "Blocker: unknown task", entityId: "person:alpha",
    projectId: "project:alpha", taskId: "task:missing", privacy: "private",
    receiptId: "receipt:missing", host: "claude", hookEvent: "PostToolUse"
  }), /task must exist/);
  const valid = {
    root, id: "event:receipt:collision", kind: "blocker", summary: "Blocker: first payload",
    entityId: "person:alpha", projectId: "project:alpha", taskId: "task:alpha", privacy: "private",
    receiptId: "receipt:collision", host: "claude", hookEvent: "PostToolUse"
  };
  await recordAttentionEvent(valid);
  await assert.rejects(recordAttentionEvent({ ...valid, summary: "Blocker: changed payload" }), /receipt collision/);
  const loaded = await loadAttention(root);
  await writeFile(loaded.attentionPath, `${JSON.stringify({
    ...loaded.attention,
    events: [{ id: "event:corrupt", kind: "blocker", status: "open", authority: "host-policy" }]
  })}\n`, "utf8");
  const failed = await runHook({
    hook_event_name: "SessionStart", cwd: root, host: "claude", ...scope
  });
  assert.equal(failed.failedClosed, true);
  assert.match(packet(failed).error, /attention lifecycle state is invalid/);
  for (const [name, expected] of Object.entries(before)) assert.equal(hash(await readFile(join(root, name))), expected);
});

test("entity purge removes lifecycle events, receipts, history, and presentations", async (t) => {
  const { root } = await fixture(t);
  await runHook({
    hook_event_name: "UserPromptSubmit", host: "codex", cwd: root, ...scope,
    event_id: "prompt:purge", timestamp: "2027-01-01T10:00:00.000Z",
    prompt: "I promise to review the synthetic result."
  });
  await attentionContext({
    root, entityId: "person:alpha", projectId: "project:alpha", currentTaskId: "task:alpha",
    includePrivate: true, focusActive: true, markPresented: true, now: "2027-01-01T10:01:00.000Z"
  });
  const purged = await deleteAttention({ root, entityId: "person:alpha" });
  assert.equal(purged.deletedEvents, 1);
  const state = (await loadAttention(root)).attention;
  assert.equal(state.events.length, 0);
  assert.equal(state.receipts.length, 0);
  assert.equal(state.history.some((entry) => entry.entityId === "person:alpha"), false);
  assert.equal(Object.keys(state.presentations).some((key) => key.includes("event:")), false);
});
