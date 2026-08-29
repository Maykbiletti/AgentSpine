import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attentionContext, configureAttention, deleteAttention, loadAttention,
  recordActivity, resolveAttention, upsertAttention
} from "../src/lib/attention.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-attention-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-attention-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n\nKeep sources unchanged.\n", "utf8");
  return { root, state };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runCli(args, state) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("attention prioritizes due cues without exposing private context or rewriting sources", async (t) => {
  const { root } = await fixture(t);
  const sourceBefore = hash(await readFile(join(root, "AGENTS.md")));
  await upsertEntity({ root, id: "person:collaborator", kind: "person", displayName: "Collaborator", privacy: "private" });
  await upsertAttention({
    root, id: "signal:question", kind: "unanswered-question", summary: "A shared question is waiting.",
    dueAt: "2027-01-01T10:00:00.000Z", priority: 60, privacy: "shared", now: "2027-01-01T09:00:00.000Z"
  });
  await upsertAttention({
    root, id: "signal:private", kind: "promise", summary: "Private promise.", entityId: "person:collaborator",
    dueAt: "2027-01-01T10:00:00.000Z", priority: 100, privacy: "private", now: "2027-01-01T09:00:00.000Z"
  });
  await upsertAttention({
    root, id: "signal:future", kind: "meaningful-change", summary: "Not due yet.",
    dueAt: "2027-02-01T10:00:00.000Z", priority: 100, privacy: "shared", now: "2027-01-01T09:00:00.000Z"
  });

  const shared = await attentionContext({ root, now: "2027-01-02T10:00:00.000Z" });
  assert.deepEqual(shared.items.map((item) => item.key), ["cue:signal:question"]);
  assert.equal(shared.items[0].authority, "context-only");
  const privateView = await attentionContext({ root, now: "2027-01-02T10:00:00.000Z", includePrivate: true });
  assert.deepEqual(privateView.items.map((item) => item.key), ["cue:signal:private", "cue:signal:question"]);

  const focused = await attentionContext({ root, now: "2027-01-02T10:00:00.000Z", includePrivate: true, focusActive: true });
  assert.equal(focused.suppressed, "focus-active");
  assert.equal(focused.items.length, 0);

  await attentionContext({ root, now: "2027-01-02T10:00:00.000Z", markPresented: true });
  const throttled = await attentionContext({ root, now: "2027-01-02T11:00:00.000Z" });
  assert.equal(throttled.items.length, 0);

  await resolveAttention({ root, id: "signal:question", status: "completed", now: "2027-01-02T12:00:00.000Z" });
  const { attention } = await loadAttention(root);
  assert.equal(attention.history.some((entry) => entry.value?.id === "signal:question" && entry.value.status === "open"), true);
  await deleteAttention({ root, signalId: "signal:question" });
  const deleted = (await loadAttention(root)).attention;
  assert.equal(deleted.signals.some((signal) => signal.id === "signal:question"), false);
  assert.equal(deleted.history.some((entry) => entry.value?.id === "signal:question"), false);
  assert.equal(hash(await readFile(join(root, "AGENTS.md"))), sourceBefore);
});

test("quiet hours, disable switch, and sparse limits suppress attention deterministically", async (t) => {
  const { root } = await fixture(t);
  const sourceBefore = hash(await readFile(join(root, "AGENTS.md")));
  await upsertAttention({ root, id: "signal:one", kind: "check-in", summary: "First", privacy: "shared", priority: 50 });
  await upsertAttention({ root, id: "signal:two", kind: "promise", summary: "Second", privacy: "shared", priority: 50 });
  await configureAttention({
    root,
    config: { maxItems: 1, quietHours: { start: 22, end: 7, utcOffsetMinutes: 0 } },
    now: "2027-01-01T20:00:00.000Z"
  });
  const quiet = await attentionContext({ root, now: "2027-01-01T23:00:00.000Z" });
  assert.equal(quiet.suppressed, "quiet-hours");
  assert.equal(quiet.items.length, 0);
  const daytime = await attentionContext({ root, now: "2027-01-02T12:00:00.000Z" });
  assert.equal(daytime.items.length, 1);
  assert.equal(daytime.remaining, 1);
  assert.equal(daytime.items[0].kind, "promise");
  await configureAttention({ root, config: { enabled: false }, now: "2027-01-02T13:00:00.000Z" });
  const disabled = await attentionContext({ root, now: "2027-01-02T14:00:00.000Z" });
  assert.equal(disabled.suppressed, "disabled");
  assert.equal(hash(await readFile(join(root, "AGENTS.md"))), sourceBefore);
});

test("relationship silence creates a check-in cue and minimal activity clears it", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "agent:builder", kind: "agent", displayName: "Builder", privacy: "shared" });
  await upsertEntity({ root, id: "project:alpha", kind: "project", displayName: "Alpha", privacy: "shared" });
  await linkEntities({ root, from: "agent:builder", to: "project:alpha", relation: "responsible-for", privacy: "shared" });
  const future = "2030-01-01T12:00:00.000Z";
  const neglected = await attentionContext({ root, now: future });
  assert.equal(neglected.items.some((item) => item.key === "neglected:agent:builder"), true);
  await recordActivity({ root, entityId: "agent:builder", kind: "interaction", at: future, privacy: "private" });
  const stillPublic = await attentionContext({ root, now: future });
  assert.equal(stillPublic.items.some((item) => item.key === "neglected:agent:builder"), true);
  const privateView = await attentionContext({ root, now: future, includePrivate: true });
  assert.equal(privateView.items.some((item) => item.key === "neglected:agent:builder"), false);
  await recordActivity({ root, entityId: "agent:builder", kind: "interaction", at: future, privacy: "shared" });
  const current = await attentionContext({ root, now: future });
  assert.equal(current.items.some((item) => item.key === "neglected:agent:builder"), false);
});

test("private team edges cannot create public relationship-silence cues", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "agent:private-edge", kind: "agent", displayName: "Private edge", privacy: "shared" });
  await upsertEntity({ root, id: "project:hidden", kind: "project", displayName: "Hidden", privacy: "shared" });
  await linkEntities({ root, from: "agent:private-edge", to: "project:hidden", relation: "responsible-for", privacy: "private" });
  const now = "2030-01-01T12:00:00.000Z";
  const publicView = await attentionContext({ root, now });
  assert.equal(publicView.items.some((item) => item.key === "neglected:agent:private-edge"), false);
  const privateView = await attentionContext({ root, now, includePrivate: true });
  assert.equal(privateView.items.some((item) => item.key === "neglected:agent:private-edge"), true);
});

test("group cues require a known group and appear only in that audience", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "group:alpha", kind: "group", displayName: "Alpha", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", displayName: "Beta", privacy: "shared" });
  await upsertEntity({ root, id: "person:member", kind: "person", displayName: "Member", privacy: "group" });
  await linkEntities({ root, from: "person:member", to: "group:alpha", relation: "member-of", privacy: "group" });
  await assert.rejects(
    upsertAttention({ root, id: "signal:invalid-group", kind: "check-in", summary: "Invalid", privacy: "group" }),
    /requires groupId/
  );
  await assert.rejects(
    recordActivity({ root, entityId: "person:member", privacy: "group", groupId: "group:beta" }),
    /not a visible member/
  );
  await upsertAttention({
    root, id: "signal:group", kind: "check-in", summary: "Alpha-only cue",
    entityId: "person:member", privacy: "group", groupId: "group:alpha"
  });
  assert.equal((await attentionContext({ root })).items.length, 0);
  assert.equal((await attentionContext({ root, groupId: "group:beta" })).items.length, 0);
  assert.equal((await attentionContext({ root, includePrivate: true })).items.length, 0);
  assert.equal((await attentionContext({ root, groupId: "group:beta", includePrivate: true })).items.length, 0);
  const alpha = await attentionContext({ root, groupId: "group:alpha" });
  assert.equal(alpha.items[0].key, "cue:signal:group");
  assert.equal(alpha.items[0].summary, "Alpha-only cue");
  assert.equal(alpha.items[0].groupId, "group:alpha");

  await upsertEntity({ root, id: "agent:shared", kind: "agent", displayName: "Shared", privacy: "shared" });
  await linkEntities({
    root, from: "agent:shared", to: "person:member", relation: "works-with", privacy: "shared"
  });
  const publicView = await attentionContext({ root, now: "2030-01-01T12:00:00.000Z" });
  assert.equal(publicView.items.some((item) => item.key === "neglected:agent:shared"), false);
  const groupView = await attentionContext({ root, groupId: "group:alpha", now: "2030-01-01T12:00:00.000Z" });
  const groupRelationshipCue = groupView.items.find((item) => item.key === "neglected:agent:shared");
  assert.equal(groupRelationshipCue.privacy, "group");
  assert.equal(groupRelationshipCue.groupId, "group:alpha");
  const hook = await runHook({ hook_event_name: "SessionStart", cwd: root });
  assert.doesNotMatch(hook.context, /shared attention cue/);
  assert.doesNotMatch(hook.context, /Alpha-only/);
});

test("concurrent activity writes are serialized and entity purge removes their traces", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "agent:worker", kind: "agent", privacy: "private" });
  await Promise.all(Array.from({ length: 12 }, (_, index) => recordActivity({
    root, entityId: "agent:worker", at: new Date(Date.UTC(2027, 0, 1, 0, index)).toISOString(), privacy: "private"
  })));
  assert.equal((await loadAttention(root)).attention.activities.length, 12);
  const purged = await deleteAttention({ root, entityId: "agent:worker" });
  assert.equal(purged.deletedActivities, 12);
  assert.equal((await loadAttention(root)).attention.activities.length, 0);
});

test("session hooks inject the real focused briefing without surfacing suppressed attention", async (t) => {
  const { root } = await fixture(t);
  await upsertAttention({
    root, id: "signal:shared", kind: "promise", summary: "Sensitive wording must not enter automatic context.",
    privacy: "shared"
  });
  const result = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const context = JSON.parse(result.context);
  assert.equal(context.briefing.attention.suppressed, "focus-active");
  assert.equal(context.briefing.attention.items.length, 0);
  assert.doesNotMatch(result.context, /Sensitive wording/);
});

test("corrupt attention configuration fails closed without breaking session indexing", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadAttention(root);
  loaded.attention.config.maxItems = 999;
  await writeFile(loaded.attentionPath, `${JSON.stringify(loaded.attention)}\n`, "utf8");
  await assert.rejects(attentionContext({ root }), /configuration is invalid/);
  const hook = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const context = JSON.parse(hook.context);
  assert.ok(context.indexedSources >= 1, "the project source remains indexed alongside any host-global sources");
  assert.equal(context.failedClosed, true);
  assert.match(context.error, /attention configuration is invalid/);
});

test("CLI attention workflow creates, presents, resolves, and disables cues", async (t) => {
  const { root, state } = await fixture(t);
  runCli([
    "attention-add", "signal:cli", "--root", root, "--kind", "promise",
    "--summary", "Synthetic CLI promise", "--privacy", "shared", "--json"
  ], state);
  const due = runCli(["attention", root, "--mark-presented", "--json"], state);
  assert.equal(due.items[0].key, "cue:signal:cli");
  const resolved = runCli(["attention-resolve", "signal:cli", "--root", root, "--status", "completed", "--json"], state);
  assert.equal(resolved.signal.status, "completed");
  runCli(["attention-config", root, "--enabled", "false", "--json"], state);
  const disabled = runCli(["attention", root, "--json"], state);
  assert.equal(disabled.suppressed, "disabled");
});
