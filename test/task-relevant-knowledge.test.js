import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runHook } from "../src/hook.js";
import { sessionBriefing } from "../src/lib/briefing.js";
import { recordWorldAssertion, worldContext, worldModelStatePath } from "../src/lib/world-model.js";

const PROJECT = "project:synthetic-task-context";
const TASK = "task:synthetic-css-archive";
const SESSION_REF = "session-ref:abcdef0123456789abcdef0123456789";
const NOW = "2035-06-07T14:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function continuation() {
  return {
    schema: "agentspine.task-continuation/v1",
    taskId: TASK,
    status: "active",
    objective: "Repair the CSS archive migration and run Suite 0 after a backup.",
    lastVerifiedStep: {
      id: "step:reproduce", summary: "Reproduced the CSS archive migration failure.", result: "failed",
      evidenceId: "measurement:reproduction", evidenceDigest: digest("reproduced"),
      observedAt: "2035-06-07T12:00:00.000Z", sessionRef: SESSION_REF,
      messageRef: "timeline-event:reproduction"
    },
    openQuestions: [{ id: "question:archive-format", question: "Which CSS archive format preserves rollback?" }],
    nextStep: { id: "step:backup-first", summary: "Back up the CSS archive before migration, then run Suite 0." }
  };
}

function assertion(root, id, kind, predicate, value, extra = {}) {
  return {
    root, id, subjectId: extra.subjectId || "project:synthetic-task-context", predicate, value,
    evidenceKind: extra.evidenceKind || "objective-measurement",
    evidenceId: extra.evidenceId || `measurement:${id.split(":")[1]}`,
    evidenceDigest: extra.evidenceDigest || digest(value), knowledgeKind: kind,
    sessionRef: extra.sessionRef === undefined ? SESSION_REF : extra.sessionRef,
    messageRef: extra.messageRef === undefined ? `timeline-event:${id.split(":")[1]}` : extra.messageRef,
    observedAt: extra.observedAt || "2035-06-07T10:00:00.000Z",
    expiresAt: extra.expiresAt, projectId: extra.projectId === undefined ? PROJECT : extra.projectId,
    groupId: extra.groupId, privacy: extra.privacy || "shared", supersedes: extra.supersedes,
    reason: extra.reason, now: NOW
  };
}

function checkpoint(root, id = "assertion:task-checkpoint", extra = {}) {
  return assertion(root, id, "task-state", "task.continuation", extra.value || continuation(), {
    ...extra, subjectId: TASK, evidenceId: extra.evidenceId || "measurement:task-checkpoint",
    observedAt: extra.observedAt || "2035-06-07T13:00:00.000Z"
  });
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-task-knowledge-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  const source = Buffer.from("# Synthetic task knowledge\n\nThese user-owned bytes stay exact.\n");
  await writeFile(join(root, "AGENTS.md"), source);
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  return { root, state, source };
}

function restartContext(root, state) {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/lib/world-model.js")).href;
  const script = "const m=await import(process.env.MODULE_URL);"
    + "const c=await m.worldContext({root:process.env.ROOT,projectId:process.env.PROJECT,"
    + "continuationTaskId:process.env.TASK,now:process.env.NOW,maxItems:8});"
    + "console.log(JSON.stringify(c.knowledge.taskContext));";
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state,
      MODULE_URL: moduleUrl, ROOT: root, PROJECT, TASK, NOW }
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function chosenAction(items) {
  return items.some((item) => JSON.stringify(item.value).includes("backup-before-migration"))
    ? "backup-first" : "delete-first";
}

async function seedRelevantKnowledge(root) {
  await recordWorldAssertion(assertion(root, "assertion:old-css-failure", "error-lesson",
    "lesson.css-archive", { failure: "CSS archive deletion broke Suite 0.",
      safeStrategy: "backup-before-migration" }));
  await recordWorldAssertion(assertion(root, "assertion:archive-decision", "decision",
    "decision.css-archive", { choice: "backup-before-migration", reason: "Preserve rollback for Suite 0." }, {
      evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:archive-decision",
      observedAt: "2035-06-07T10:05:00.000Z", reason: "The user chose a reversible CSS archive migration."
    }));
}

test("a restarted task receives the old measured lesson before repeating the failure", async (t) => {
  const { root, state, source } = await fixture(t);
  await seedRelevantKnowledge(root);
  await Promise.all(Array.from({ length: 12 }, (_, index) => recordWorldAssertion(assertion(root,
    `assertion:newer-unrelated-${index}`, "fact", `unrelated.observation-${index}`,
    { component: `unrelated-${index}`, result: "green" }, {
      observedAt: `2035-06-07T11:${String(index).padStart(2, "0")}:00.000Z`
    }))));
  await recordWorldAssertion(checkpoint(root));

  const context = await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK,
    maxItems: 8, now: NOW });
  const genericCurrent = context.knowledge.current.filter((item) => item.kind !== "task-state");
  assert.equal(chosenAction(genericCurrent), "delete-first",
    "Before: bounded newest-first knowledge omits the older relevant lesson");
  assert.equal(chosenAction(context.knowledge.taskContext.items), "backup-first",
    "After: task ranking makes the measured safe strategy actionable");
  const recalledFailure = context.knowledge.taskContext.items.find((item) => item.kind === "error-lesson");
  assert.ok(recalledFailure, "the measured failure lesson remains in the bounded task context");
  assert.deepEqual(recalledFailure.source, {
    kind: "objective-measurement", id: "measurement:old-css-failure",
    digest: digest({ failure: "CSS archive deletion broke Suite 0.", safeStrategy: "backup-before-migration" }),
    sessionRef: SESSION_REF, messageRef: "timeline-event:old-css-failure"
  });

  const restarted = restartContext(root, state);
  assert.equal(chosenAction(restarted.items), "backup-first");
  const compacted = await runHook({ hook_event_name: "PostCompact", host: "codex", cwd: root,
    session_id: "session:synthetic-task-restart", timestamp: NOW, project_id: PROJECT, task_id: TASK,
    agent_spine_scope: { project_id: PROJECT, task_id: TASK } });
  assert.equal(compacted.failedClosed, undefined, compacted.reason || compacted.error);
  const packet = JSON.parse(compacted.context);
  assert.equal(chosenAction(packet.briefing.world.knowledge.taskContext.items), "backup-first");
  assert.ok(packet.briefing.budget.usedBytes <= packet.briefing.budget.maxBytes);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("only current confirmed knowledge in the exact project and group can guide the task", async (t) => {
  const { root, source } = await fixture(t);
  await recordWorldAssertion(checkpoint(root));
  const oldValue = { failure: "CSS archive migration used the obsolete backup.", safeStrategy: "obsolete-backup" };
  await recordWorldAssertion(assertion(root, "assertion:obsolete", "error-lesson", "lesson.css-correction", oldValue));
  const correction = { failure: "CSS archive migration needs the corrected backup.", safeStrategy: "corrected-backup" };
  await recordWorldAssertion(assertion(root, "assertion:corrected", "error-lesson", "lesson.css-correction", correction, {
    evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:correction",
    observedAt: "2035-06-07T10:10:00.000Z", supersedes: ["assertion:obsolete"]
  }));
  await Promise.all([
    recordWorldAssertion(assertion(root, "assertion:proposal-one", "error-lesson", "lesson.css-proposal",
      { failure: "CSS archive proposal", safeStrategy: "proposal-backup" }, {
        evidenceKind: "model-suggestion", evidenceId: "model-output:proposal-one" })),
    recordWorldAssertion(assertion(root, "assertion:proposal-two", "error-lesson", "lesson.css-proposal-copy",
      { failure: "CSS archive proposal", safeStrategy: "proposal-backup" }, {
        evidenceKind: "model-suggestion", evidenceId: "model-output:proposal-two" })),
    recordWorldAssertion(assertion(root, "assertion:foreign-project", "error-lesson", "lesson.css-foreign",
      { failure: "CSS archive foreign project", safeStrategy: "foreign-project-backup" }, {
        projectId: "project:foreign" })),
    recordWorldAssertion(assertion(root, "assertion:private", "error-lesson", "lesson.css-private",
      { failure: "CSS archive private note", safeStrategy: "private-backup" }, { privacy: "private" })),
    recordWorldAssertion(assertion(root, "assertion:foreign-group", "error-lesson", "lesson.css-group",
      { failure: "CSS archive foreign group", safeStrategy: "foreign-group-backup" }, {
        projectId: null, privacy: "group", groupId: "group:beta" })),
    recordWorldAssertion(assertion(root, "assertion:stale", "error-lesson", "lesson.css-stale",
      { failure: "CSS archive stale lesson", safeStrategy: "stale-backup" }, {
        expiresAt: "2035-06-07T11:00:00.000Z" }))
  ]);
  await recordWorldAssertion(assertion(root, "assertion:conflict-a", "fact", "fact.css-conflict",
    { result: "CSS archive backup alpha" }));
  await recordWorldAssertion(assertion(root, "assertion:conflict-b", "fact", "fact.css-conflict",
    { result: "CSS archive backup beta" }, { observedAt: "2035-06-07T10:01:00.000Z" }));

  let context = await worldContext({ root, projectId: PROJECT, groupId: "group:alpha",
    continuationTaskId: TASK, includeKnowledgeHistory: true, now: NOW });
  const serialized = JSON.stringify(context.knowledge.taskContext.items);
  assert.match(serialized, /corrected-backup/);
  for (const forbidden of ["obsolete-backup", "proposal-backup", "foreign-project-backup",
    "private-backup", "foreign-group-backup", "stale-backup", "backup alpha", "backup beta"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
  assert.equal(context.knowledge.history.some((item) => item.id === "assertion:obsolete"), true);

  const completed = { ...continuation(), status: "completed", openQuestions: [], nextStep: null,
    lastVerifiedStep: { ...continuation().lastVerifiedStep, id: "step:complete", result: "passed",
      evidenceId: "measurement:complete", evidenceDigest: digest("complete") } };
  await recordWorldAssertion(checkpoint(root, "assertion:task-complete", {
    value: completed, evidenceId: completed.lastVerifiedStep.evidenceId,
    evidenceDigest: completed.lastVerifiedStep.evidenceDigest,
    observedAt: completed.lastVerifiedStep.observedAt,
    sessionRef: completed.lastVerifiedStep.sessionRef,
    messageRef: completed.lastVerifiedStep.messageRef,
    supersedes: ["assertion:task-checkpoint"]
  }));
  context = await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK, now: NOW });
  assert.equal(context.knowledge.taskContext.status, "terminal");
  assert.deepEqual(context.knowledge.taskContext.items, []);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("ranking is deterministic, bounded, fast, and rejects manipulated persisted state", async (t) => {
  const { root, source } = await fixture(t);
  await recordWorldAssertion(checkpoint(root));
  await Promise.all(Array.from({ length: 18 }, (_, index) => recordWorldAssertion(assertion(root,
    `assertion:parallel-lesson-${index}`, "error-lesson", `lesson.css-parallel-${index}`,
    { failure: `CSS archive migration failure ${index}`, safeStrategy: `backup-before-migration-${index}` }))));
  const context = await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK,
    maxItems: 2, now: NOW });
  assert.equal(context.knowledge.taskContext.items.length, 2);
  assert.equal(context.knowledge.taskContext.omitted, 16);
  assert.deepEqual(context.knowledge.taskContext.items.map((item) => item.id),
    ["assertion:parallel-lesson-0", "assertion:parallel-lesson-1"]);

  const measure = async (currentTaskId) => {
    const started = performance.now();
    await Promise.all(Array.from({ length: 8 }, () => sessionBriefing({ root, host: "generic",
      projectId: PROJECT, currentTaskId, includeSourceContent: false, maxBytes: 4096, now: NOW })));
    return performance.now() - started;
  };
  await measure(null);
  await measure(TASK);
  const baselineMs = (await measure(null) + await measure(null)) / 2;
  const taskContextMs = (await measure(TASK) + await measure(TASK)) / 2;
  assert.ok(baselineMs < 2_000 && taskContextMs < 2_000,
    "eight concurrent baseline and task-context briefings must each finish below two seconds");
  assert.ok(taskContextMs <= baselineMs * 1.5 + 250,
    `task recall must not materially regress briefing time (${baselineMs}ms -> ${taskContextMs}ms)`);

  const statePath = await worldModelStatePath(root);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.assertions[0].value.safeStrategy = "tampered-backup";
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await assert.rejects(worldContext({ root, projectId: PROJECT, continuationTaskId: TASK, now: NOW }),
    /world model state is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});
