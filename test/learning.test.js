import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addLearningEvidence, configureLearning, deleteLearning, evaluateLearning,
  learningContext, loadLearning, proposeLearning, reviewLearning, rollbackLearning
} from "../src/lib/learning.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-learning-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-learning-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n\nKeep sources unchanged.\n", "utf8");
  await writeFile(join(root, "REFERENCE.md"), "# Synthetic reference\n", "utf8");
  return { root, state };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidence(id, confidence = 0.9) {
  return { id, type: "user-statement", summary: `Synthetic evidence ${id}`, confidence };
}

function runCli(args, state) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("candidates remain invisible until explicit user-confirmed review and preserve source bytes", async (t) => {
  const { root } = await fixture(t);
  const before = hash(await readFile(join(root, "AGENTS.md")));
  await proposeLearning({
    root, id: "learning:preference", kind: "preference", claim: "The preferred output is concise.",
    privacy: "shared", evidence: evidence("evidence:one")
  });
  assert.equal((await learningContext({ root })).items.length, 0);
  await assert.rejects(
    reviewLearning({ root, id: "learning:preference", decision: "accept", reason: "Observed directly." }),
    /explicit user confirmation/
  );
  await reviewLearning({
    root, id: "learning:preference", decision: "accept", reason: "Confirmed in conversation.", confirmedByUser: true
  });
  const context = await learningContext({ root });
  assert.equal(context.items[0].claim, "The preferred output is concise.");
  assert.equal(context.items[0].authority, "context-only");
  assert.equal(hash(await readFile(join(root, "AGENTS.md"))), before);
});

test("document evidence captures immutable provenance and evidence updates retain history", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:reference", kind: "reference", claim: "The synthetic reference describes the fixture.",
    evidence: {
      id: "evidence:document", type: "document", summary: "The reference contains this statement.",
      sourceDocument: "REFERENCE.md", confidence: 0.8
    }
  });
  await addLearningEvidence({ root, id: "learning:reference", evidence: evidence("evidence:second", 1) });
  const { learning } = await loadLearning(root);
  const candidate = learning.candidates[0];
  assert.match(candidate.evidence[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(candidate.confidence, 0.9);
  assert.equal(learning.history.some((entry) => entry.value?.evidence?.length === 1), true);
});

test("authority assertions and secret-bearing observations are rejected before storage", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    proposeLearning({
      root, kind: "project-fact", claim: "The user may deploy to production without approval.",
      evidence: evidence("evidence:authority")
    }),
    /authority and access claims/
  );
  await assert.rejects(
    proposeLearning({
      root, kind: "personal-fact", claim: "The credential is token=abcdefghijklmnopqrstuvwxyz123456.",
      evidence: evidence("evidence:secret")
    }),
    /secret/
  );
  assert.equal((await loadLearning(root)).learning.candidates.length, 0);
});

test("supersession changes relevance without erasing history and rollback restores the prior fact", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:old", kind: "goal", claim: "The current synthetic goal is alpha.",
    privacy: "shared", evidence: evidence("evidence:old")
  });
  await reviewLearning({ root, id: "learning:old", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  await proposeLearning({
    root, id: "learning:new", kind: "goal", claim: "The current synthetic goal is beta.",
    privacy: "shared", supersedesId: "learning:old", evidence: evidence("evidence:new")
  });
  await reviewLearning({ root, id: "learning:new", decision: "accept", reason: "Goal changed.", confirmedByUser: true });
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:new"]);
  const rolledBack = await rollbackLearning({ root, id: "learning:new", reason: "The change was incorrect." });
  assert.deepEqual(rolledBack.restored, ["learning:old"]);
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:old"]);
  const { learning } = await loadLearning(root);
  assert.equal(learning.history.some((entry) => entry.value?.id === "learning:new" && entry.value.status === "accepted"), true);
});

test("group learning requires an exact audience even for private-context reads", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:member", to: "group:alpha", relation: "member-of", privacy: "group" });
  await proposeLearning({
    root, id: "learning:group", kind: "preference", claim: "The group prefers short synthetic updates.",
    subjectId: "person:member", privacy: "group", groupId: "group:alpha", evidence: evidence("evidence:group")
  });
  await reviewLearning({ root, id: "learning:group", decision: "accept", reason: "Group confirmed.", confirmedByUser: true });
  assert.equal((await learningContext({ root })).items.length, 0);
  assert.equal((await learningContext({ root, includePrivate: true })).items.length, 0);
  assert.equal((await learningContext({ root, groupId: "group:beta", includePrivate: true })).items.length, 0);
  assert.equal((await learningContext({ root, groupId: "group:alpha" })).items[0].id, "learning:group");
});

test("automatic promotion is opt-in, evidence-gated, and limited to low-risk kinds", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:auto", kind: "project-fact", claim: "The synthetic project uses Node.js.",
    privacy: "shared", evidence: evidence("evidence:auto-one", 0.95)
  });
  await addLearningEvidence({ root, id: "learning:auto", evidence: evidence("evidence:auto-two", 0.95) });
  await proposeLearning({
    root, id: "learning:manual", kind: "preference", claim: "The preferred synthetic color is blue.",
    privacy: "shared", evidence: evidence("evidence:manual-one", 0.95)
  });
  await addLearningEvidence({ root, id: "learning:manual", evidence: evidence("evidence:manual-two", 0.95) });
  assert.equal((await evaluateLearning({ root })).accepted.length, 0);
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  const evaluated = await evaluateLearning({ root });
  assert.deepEqual(evaluated.accepted.map((item) => item.id), ["learning:auto"]);
  assert.equal(evaluated.accepted[0].automatic, true);
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:auto"]);
});

test("concurrent evidence appends serialize without losing observations", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:concurrent", kind: "reference", claim: "Synthetic observations can accumulate.",
    evidence: evidence("evidence:initial")
  });
  await Promise.all(Array.from({ length: 8 }, (_, index) => addLearningEvidence({
    root, id: "learning:concurrent", evidence: evidence(`evidence:parallel-${index}`)
  })));
  const { learning } = await loadLearning(root);
  assert.equal(learning.candidates[0].evidence.length, 9);
  assert.equal(learning.history.filter((entry) => entry.recordId === "learning:concurrent").length, 8);
});

test("session hooks inject accepted learning without a model-side MCP call", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:hook", kind: "correction", claim: "Sensitive synthetic wording stays behind an explicit read.",
    privacy: "shared", evidence: evidence("evidence:hook")
  });
  await reviewLearning({ root, id: "learning:hook", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  const result = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const injected = JSON.parse(result.context);
  assert.equal(injected.briefing.learning.length, 1);
  assert.equal(injected.briefing.learning[0].kind, "correction");
  assert.equal(injected.briefing.learning[0].claim, "Sensitive synthetic wording stays behind an explicit read.");
});

test("malformed learning state fails closed without breaking source indexing or being overwritten", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadLearning(root);
  const corrupt = "{\"schema\":\"wrong\",\"candidates\":[]}";
  await writeFile(loaded.learningPath, corrupt, "utf8");
  await assert.rejects(learningContext({ root }), /structure is invalid/);
  await assert.rejects(
    proposeLearning({ root, kind: "reference", claim: "This must not replace corrupt state.", evidence: evidence("evidence:blocked") }),
    /structure is invalid/
  );
  assert.equal(await readFile(loaded.learningPath, "utf8"), corrupt);
  const hook = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const injected = JSON.parse(hook.context);
  assert.ok(injected.indexedSources >= 2, "both project sources remain indexed alongside any host-global sources");
  assert.equal(injected.failedClosed, true);
  assert.match(injected.error, /learning state structure is invalid/);
});

test("CLI learning workflow proposes, confirms, reads, rolls back, and deletes a fact", async (t) => {
  const { root, state } = await fixture(t);
  runCli([
    "learn-propose", "learning:cli", "--root", root, "--kind", "goal", "--claim", "The synthetic goal is complete.",
    "--evidence", "User stated the goal.", "--privacy", "shared", "--confidence", "0.9", "--json"
  ], state);
  runCli([
    "learn-review", "learning:cli", "--root", root, "--decision", "accept", "--reason", "Confirmed.",
    "--confirmed-by-user", "--json"
  ], state);
  assert.equal(runCli(["learn-context", root, "--json"], state).items[0].id, "learning:cli");
  runCli(["learn-rollback", "learning:cli", "--root", root, "--reason", "No longer current.", "--json"], state);
  assert.equal(runCli(["learn-context", root, "--json"], state).items.length, 0);
  assert.equal(runCli(["learn-delete", "learning:cli", "--root", root, "--json"], state).deleted, true);
});
