import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionBriefing } from "../src/lib/briefing.js";
import {
  recordWorldAssertion, worldContext, worldModelStatePath
} from "../src/lib/world-model.js";

const PROJECT = "project:synthetic-memory";
const NOW = "2034-05-04T14:00:00.000Z";
const SESSION = "session-ref:0123456789abcdef0123456789abcdef";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-structured-memory-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-structured-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  await mkdir(join(root, ".git"));
  const source = Buffer.from("# Synthetic memory fixture\n\nUser-owned bytes stay unchanged.\n");
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  return { root, source };
}

function assertion(root, id, kind, value, extra = {}) {
  const suffix = id.split(":")[1];
  return {
    root,
    id,
    subjectId: extra.subjectId || PROJECT,
    predicate: extra.predicate || `memory.${kind}`,
    value,
    evidenceKind: extra.evidenceKind || "objective-measurement",
    evidenceId: extra.evidenceId || `measurement:${suffix}`,
    evidenceDigest: digest(value),
    observedAt: extra.observedAt || "2034-05-04T12:00:00.000Z",
    projectId: extra.projectId === undefined ? PROJECT : extra.projectId,
    groupId: extra.groupId || null,
    privacy: extra.privacy || "shared",
    knowledgeKind: kind,
    sessionRef: extra.sessionRef !== undefined ? extra.sessionRef
      : extra.withMessage === false ? undefined : SESSION,
    messageRef: extra.messageRef !== undefined ? extra.messageRef
      : extra.withMessage === false ? undefined : `timeline-event:${suffix}`,
    supersedes: extra.supersedes || [],
    reason: extra.reason || "",
    now: NOW
  };
}

test("typed knowledge exposes source, scope, time, and evidence-derived status after restart", async (t) => {
  const { root, source } = await fixture(t);
  await recordWorldAssertion({
    root, id: "assertion:legacy", subjectId: PROJECT, predicate: "legacy.value", value: "kept",
    evidenceKind: "objective-measurement", evidenceId: "measurement:legacy",
    evidenceDigest: digest("kept"), observedAt: "2034-05-04T11:00:00.000Z",
    projectId: PROJECT, privacy: "shared", now: NOW
  });
  assert.equal((await worldContext({ root, projectId: PROJECT, now: NOW })).knowledge.current.length, 0,
    "legacy assertions remain readable without being relabelled as structured knowledge");

  const entries = [
    assertion(root, "assertion:fact", "fact", { suite: 0, result: "red" }),
    assertion(root, "assertion:preference", "user-preference", "concise", {
      subjectId: "person:synthetic-owner", predicate: "response.length",
      evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:preference"
    }),
    assertion(root, "assertion:decision", "decision", "retain-current-setting", {
      predicate: "settings.migration", evidenceKind: "explicit-user-feedback",
      evidenceId: "user-turn:decision", reason: "The synthetic owner chose compatibility."
    }),
    assertion(root, "assertion:task", "task-state", "running", {
      predicate: "task.release-state"
    }),
    assertion(root, "assertion:error-one", "error-lesson", "check the path first", {
      predicate: "lesson.path-check", evidenceKind: "model-suggestion",
      evidenceId: "model-output:error-one"
    }),
    assertion(root, "assertion:error-two", "error-lesson", "check the path first", {
      predicate: "lesson.path-check", evidenceKind: "model-suggestion",
      evidenceId: "model-output:error-two"
    })
  ];
  for (const entry of entries) await recordWorldAssertion(entry);

  const restarted = await worldContext({ root, projectId: PROJECT, now: NOW, includeKnowledgeHistory: true });
  assert.equal(restarted.knowledge.current.length, 6);
  assert.equal(restarted.knowledge.counts.confirmed, 4);
  assert.equal(restarted.knowledge.counts.assumption, 2,
    "repeating a model suggestion must not turn it into confirmed knowledge");
  const decision = restarted.knowledge.current.find((item) => item.kind === "decision");
  assert.equal(decision.status, "confirmed");
  assert.equal(decision.rationale, "The synthetic owner chose compatibility.");
  assert.deepEqual(decision.source, {
    kind: "explicit-user-feedback",
    id: "user-turn:decision",
    digest: digest("retain-current-setting"),
    sessionRef: SESSION,
    messageRef: "timeline-event:decision"
  });
  assert.deepEqual(decision.scope, { projectId: PROJECT, groupId: null, privacy: "shared" });
  assert.equal(decision.observedAt, "2034-05-04T12:00:00.000Z");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("conflict withholds a fact and an explicit correction preserves superseded history", async (t) => {
  const { root } = await fixture(t);
  await recordWorldAssertion(assertion(root, "assertion:task-running", "task-state", "running", {
    predicate: "task.release-state"
  }));
  await recordWorldAssertion(assertion(root, "assertion:task-done", "task-state", "done", {
    predicate: "task.release-state", evidenceId: "measurement:task-done"
  }));
  let context = await worldContext({ root, projectId: PROJECT, now: NOW, includeKnowledgeHistory: true });
  assert.equal(context.facts.some((item) => item.predicate === "task.release-state"), false);
  assert.deepEqual(context.knowledge.current.map((item) => item.status), ["contradictory", "contradictory"]);

  await recordWorldAssertion(assertion(root, "assertion:task-corrected", "task-state", "blocked", {
    predicate: "task.release-state", evidenceKind: "explicit-user-feedback",
    evidenceId: "user-turn:task-correction",
    supersedes: ["assertion:task-running", "assertion:task-done"],
    reason: "Newest explicit instruction corrects both older states.",
    observedAt: "2034-05-04T13:00:00.000Z"
  }));
  context = await worldContext({ root, projectId: PROJECT, now: NOW, includeKnowledgeHistory: true });
  assert.deepEqual(context.facts.filter((item) => item.predicate === "task.release-state")
    .map((item) => item.value), ["blocked"]);
  assert.deepEqual(context.knowledge.current.map((item) => [item.value, item.status]), [["blocked", "confirmed"]]);
  assert.deepEqual(context.knowledge.history.map((item) => [item.value, item.status, item.statusReason]), [
    ["done", "superseded", "replaced"], ["running", "superseded", "replaced"]
  ]);
});

test("briefing includes only bounded current knowledge while scopes remain exact", async (t) => {
  const { root, source } = await fixture(t);
  await recordWorldAssertion(assertion(root, "assertion:shared", "fact", "visible"));
  await recordWorldAssertion(assertion(root, "assertion:group-alpha", "task-state", "alpha", {
    projectId: null, groupId: "group:alpha", privacy: "group"
  }));
  await recordWorldAssertion(assertion(root, "assertion:group-beta", "task-state", "beta", {
    projectId: null, groupId: "group:beta", privacy: "group"
  }));
  await recordWorldAssertion(assertion(root, "assertion:private", "user-preference", "private", {
    subjectId: "person:synthetic-owner", predicate: "response.private",
    evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:private",
    privacy: "private"
  }));

  const foreignProject = await worldContext({ root, projectId: "project:foreign", now: NOW });
  assert.equal(foreignProject.knowledge.current.some((item) => item.value === "visible"), false);
  const alpha = await worldContext({ root, projectId: PROJECT, groupId: "group:alpha", now: NOW });
  assert.deepEqual(alpha.knowledge.current.map((item) => item.value).sort(), ["alpha", "visible"]);
  assert.equal(alpha.knowledge.current.some((item) => item.value === "beta"), false);
  assert.equal(alpha.knowledge.current.some((item) => item.value === "private"), false);
  const briefing = await sessionBriefing({
    root, host: "generic", projectId: PROJECT, includePrivate: false,
    includeSourceContent: false, maxBytes: 8192, now: NOW
  });
  assert.deepEqual(briefing.world.knowledge.current.map((item) => item.value), ["visible"]);
  assert.equal("history" in briefing.world.knowledge, false);
  assert.ok(briefing.budget.usedBytes <= briefing.budget.maxBytes);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("secret-shaped, invalid-source, invalid-kind, and tampered structured knowledge fail closed", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:secret", "fact",
    "github_pat_abcdefghijklmnopqrstuvwxyz0123456789")), /secret-shaped/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:source", "fact", true, {
    withMessage: false, sessionRef: SESSION
  })), /sessionRef and messageRef|session references/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:kind", "unknown", true)), /knowledgeKind/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:decision", "decision", true, {
    evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:no-rationale"
  })), /rationale/);

  await recordWorldAssertion(assertion(root, "assertion:valid", "fact", true));
  const path = await worldModelStatePath(root);
  const state = JSON.parse(await readFile(path, "utf8"));
  state.assertions[0].sessionRef = "session-ref:tampered";
  await writeFile(path, `${JSON.stringify(state)}\n`);
  await assert.rejects(worldContext({ root, projectId: PROJECT, now: NOW }), /world model state is invalid/);

  state.assertions[0].sessionRef = SESSION;
  state.assertions[0].value = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
  state.assertions[0].valueDigest = digest(state.assertions[0].value);
  await writeFile(path, `${JSON.stringify(state)}\n`);
  await assert.rejects(worldContext({ root, projectId: PROJECT, now: NOW }), /world model state is invalid/);
});
