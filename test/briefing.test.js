import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionBriefing } from "../src/lib/briefing.js";
import { createTask } from "../src/lib/coordination.js";
import { linkEntities, relationshipContext, upsertEntity } from "../src/lib/graph.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import { loadAttention, upsertAttention } from "../src/lib/attention.js";
import { initDirectoryAdapter, publishLearning, pullShared, reviewShared } from "../src/lib/sharing.js";

async function acceptedLearning(root, { id, claim, subjectId = null, privacy = "shared", groupId = null }) {
  await proposeLearning({
    root, id, kind: "project-fact", claim, subjectId, privacy, groupId,
    evidence: { id: `evidence:${id}`, type: "user-statement", summary: `Synthetic evidence for ${id}.`, confidence: 1 }
  });
  await reviewLearning({ root, id, decision: "accept", reason: "Synthetic confirmation.", confirmedByUser: true });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-briefing-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-briefing-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Agent rules\n\nNever rewrite user sources.\n", "utf8");
  await writeFile(join(root, "CLAUDE.md"), "# Claude rules\n\nLoad [memory](MEMORY.md).\n", "utf8");
  await writeFile(join(root, "SOUL.md"), "# Soul\n\nCurious and direct.\n", "utf8");
  await writeFile(join(root, "MEMORY.md"), "# Index\n\n- [Fact](memory/fact.md)\n", "utf8");
  await writeFile(join(root, "memory", "fact.md"), "# Fact\n\nSynthetic stable fact.\n", "utf8");
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:alpha", kind: "person", displayName: "Alpha", privacy: "shared" });
  await upsertEntity({ root, id: "person:teammate", kind: "person", displayName: "Teammate", privacy: "shared" });
  await upsertEntity({ root, id: "person:outsider", kind: "person", displayName: "Outsider", privacy: "group" });
  await upsertEntity({ root, id: "person:private", kind: "person", displayName: "Private Person", privacy: "private" });
  await upsertEntity({ root, id: "project:demo", kind: "project", privacy: "shared" });
  await linkEntities({ root, from: "person:alpha", to: "group:alpha", relation: "member-of", privacy: "shared" });
  await linkEntities({ root, from: "person:teammate", to: "group:alpha", relation: "member-of", privacy: "shared" });
  await linkEntities({ root, from: "person:outsider", to: "group:beta", relation: "member-of", privacy: "shared" });
  await linkEntities({ root, from: "person:alpha", to: "person:teammate", relation: "works-with", privacy: "shared" });
  await linkEntities({ root, from: "person:alpha", to: "person:outsider", relation: "works-with", privacy: "group" });
  return { root, state };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("session briefing combines current context within an exact compact JSON byte budget", async (t) => {
  const { root } = await fixture(t);
  const sourceBefore = hash(await readFile(join(root, "AGENTS.md")));
  await acceptedLearning(root, { id: "learning:alpha", claim: "Alpha prefers concise synthetic updates.", subjectId: "person:alpha" });
  await createTask({
    root, id: "task:current", actorId: "person:alpha", assigneeId: "person:alpha",
    title: "Current synthetic task", projectId: "project:demo", privacy: "shared", priority: 90
  });
  await upsertAttention({
    root, id: "signal:alpha", kind: "promise", summary: "Follow up on the synthetic promise.",
    entityId: "person:alpha", privacy: "shared", dueAt: "2026-01-01T00:00:00.000Z"
  });

  const result = await sessionBriefing({
    root, host: "codex", entityId: "person:alpha", projectId: "project:demo",
    currentTaskId: "task:current", focusActive: false, maxBytes: 8192,
    now: "2027-01-01T00:00:00.000Z"
  });
  assert.equal(result.tasks[0].id, "task:current");
  assert.equal(result.relationship.relatedEntities.some((item) => item.id === "person:teammate"), true);
  assert.equal(result.learning[0].id, "learning:alpha");
  assert.equal(result.attention.items[0].key, "cue:signal:alpha");
  assert.equal(result.sources.documents.some((item) => item.path === "AGENTS.md"), true);
  assert.equal(result.budget.measurement, "compact-json-utf8");
  assert.equal(Buffer.byteLength(JSON.stringify(result)), result.budget.usedBytes);
  assert.equal(result.budget.usedBytes <= 8192, true);
  assert.equal(hash(await readFile(join(root, "AGENTS.md"))), sourceBefore);
});

test("focus is the default and briefing reads never consume attention cues", async (t) => {
  const { root } = await fixture(t);
  await upsertAttention({
    root, id: "signal:focus", kind: "check-in", summary: "Synthetic due cue.",
    entityId: "person:alpha", privacy: "shared"
  });
  const { attentionPath } = await loadAttention(root);
  const before = await readFile(attentionPath);
  const first = await sessionBriefing({ root, entityId: "person:alpha" });
  const second = await sessionBriefing({ root, entityId: "person:alpha", focusActive: false });
  assert.equal(first.attention.suppressed, "focus-active");
  assert.equal(first.attention.items.length, 0);
  assert.equal(second.attention.items[0].key, "cue:signal:focus");
  assert.deepEqual(await readFile(attentionPath), before);
});

test("fail-closed parallel reads fully settle before returning an error", async (t) => {
  const { root, state } = await fixture(t);
  const { attentionPath, attention } = await loadAttention(root);
  attention.config.enabled = "invalid";
  await writeFile(attentionPath, JSON.stringify(attention), "utf8");
  await assert.rejects(sessionBriefing({ root }), /attention configuration is invalid/);
  await rm(state, { recursive: true });
  await mkdir(state, { recursive: true });
});

test("group briefing enforces one exact audience and never loads Markdown content", async (t) => {
  const { root } = await fixture(t);
  await acceptedLearning(root, {
    id: "learning:group-alpha", claim: "Alpha group context.", subjectId: "person:alpha",
    privacy: "group", groupId: "group:alpha"
  });
  await acceptedLearning(root, {
    id: "learning:group-beta", claim: "Beta group context.", subjectId: "person:outsider",
    privacy: "group", groupId: "group:beta"
  });
  const result = await sessionBriefing({
    root, entityId: "person:alpha", groupId: "group:alpha", focusActive: false, maxBytes: 8192
  });
  const serialized = JSON.stringify(result);
  assert.match(serialized, /Alpha group context/);
  assert.doesNotMatch(serialized, /Beta group context|Outsider|Private Person/);
  assert.equal(result.relationship.relatedEntities.some((item) => item.id === "person:teammate"), true);
  assert.equal(result.sources.documents.every((item) => item.loaded === false && item.content === null), true);
  assert.equal((await relationshipContext({ root, entityId: "person:alpha" })).edges.some((item) => item.privacy === "group"), false);
  await assert.rejects(
    sessionBriefing({ root, entityId: "person:alpha", groupId: "group:alpha", includePrivate: true }),
    /private context cannot be assembled/
  );
  await assert.rejects(
    relationshipContext({ root, entityId: "person:outsider", groupId: "group:alpha" }),
    /not a visible member/
  );
});

test("small budgets retain whole values or omit them without truncation", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({
    root, id: "person:alpha", kind: "person", displayName: "Alpha",
    attributes: { profile: "x".repeat(10000) }, privacy: "shared"
  });
  for (let index = 0; index < 12; index += 1) {
    await acceptedLearning(root, {
      id: `learning:budget-${index}`, claim: `Complete synthetic claim ${index} ${"x".repeat(300)}.`,
      subjectId: "person:alpha"
    });
  }
  const result = await sessionBriefing({ root, entityId: "person:alpha", maxBytes: 4096 });
  assert.equal(Buffer.byteLength(JSON.stringify(result)), result.budget.usedBytes);
  assert.equal(result.budget.usedBytes <= 4096, true);
  assert.equal(result.budget.omitted.learning > 0, true);
  assert.equal(result.relationship.entity, null);
  assert.equal(result.budget.omitted.relationships > 0, true);
  for (const item of result.learning) assert.match(item.claim, /\.$/);
  for (const document of result.sources.documents) {
    if (document.loaded) assert.equal(Buffer.byteLength(document.content), document.bytes);
  }
});

test("a current task must be visible and is prioritized ahead of higher-priority work", async (t) => {
  const { root } = await fixture(t);
  await createTask({ root, id: "task:high", actorId: "person:alpha", title: "High", privacy: "shared", priority: 100 });
  await createTask({ root, id: "task:focus", actorId: "person:alpha", title: "Focus", privacy: "shared", priority: 1 });
  const result = await sessionBriefing({ root, entityId: "person:alpha", currentTaskId: "task:focus", maxBytes: 4096 });
  assert.equal(result.tasks[0].id, "task:focus");
  await assert.rejects(
    sessionBriefing({ root, entityId: "person:alpha", currentTaskId: "task:missing" }),
    /not visible/
  );
});

test("reviewed shared duplicates yield to local confirmed learning", async (t) => {
  const { root } = await fixture(t);
  const origin = await mkdtemp(join(tmpdir(), "agentspine-briefing-origin-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-briefing-adapter-"));
  t.after(async () => { await rm(origin, { recursive: true }); await rm(adapter, { recursive: true }); });
  await writeFile(join(origin, "AGENTS.md"), "# Origin\n", "utf8");
  const claim = "The synthetic project uses one stable format.";
  await acceptedLearning(origin, { id: "learning:origin", claim });
  await initDirectoryAdapter({ root: origin, directory: adapter, scopeId: "team:briefing", confirmation: "local-share-confirmed" });
  await publishLearning({ root: origin, directory: adapter, learningId: "learning:origin", eventId: "shared:briefing", confirmation: "local-share-confirmed" });
  await pullShared({ root, directory: adapter });
  await reviewShared({ root, id: "shared:briefing", decision: "accept", reason: "Synthetic local review.", confirmedByUser: true });
  await acceptedLearning(root, { id: "learning:local", claim });
  const result = await sessionBriefing({ root, maxBytes: 8192 });
  assert.equal(result.learning.some((item) => item.id === "learning:local"), true);
  assert.equal(result.shared.some((item) => item.id === "shared:briefing"), false);
  assert.equal(result.budget.omitted.shared >= 1, true);
});

test("CLI exposes the same provider-neutral briefing for Claude and Codex", async (t) => {
  const { root, state } = await fixture(t);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  for (const host of ["claude", "codex"]) {
    const run = spawnSync(process.execPath, [cli, "briefing", root, "--host", host, "--max-bytes", "4096", "--json"], {
      encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.host, host);
    assert.equal(result.budget.usedBytes <= 4096, true);
    assert.equal(result.authority, "context-only");
  }
});
