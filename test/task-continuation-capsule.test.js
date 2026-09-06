import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runHook } from "../src/hook.js";
import { sessionBriefing } from "../src/lib/briefing.js";
import { recordWorldAssertion, worldContext, worldModelStatePath } from "../src/lib/world-model.js";

const PROJECT = "project:synthetic-continuation";
const TASK = "task:synthetic-continuation";
const SESSION_REF = "session-ref:0123456789abcdef0123456789abcdef";
const NOW = "2034-05-04T14:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function step(id = "step:baseline", result = "passed") {
  return {
    id,
    summary: `Verified ${id}.`,
    result,
    evidenceId: `measurement:${id.split(":")[1]}`,
    evidenceDigest: digest(`${id}:${result}`),
    observedAt: "2034-05-04T12:30:00.000Z",
    sessionRef: SESSION_REF,
    messageRef: `timeline-event:${id.split(":")[1]}`
  };
}

function capsule(status = "active", extra = {}) {
  return {
    schema: "agentspine.task-continuation/v1",
    taskId: TASK,
    status,
    objective: "Finish the synthetic continuation milestone.",
    lastVerifiedStep: step(),
    openQuestions: [{ id: "question:compatibility", question: "Does the compatibility fixture still pass?" }],
    nextStep: { id: "step:contract-tests", summary: "Run the bounded contract tests." },
    ...extra
  };
}

function assertion(root, id, value, extra = {}) {
  return {
    root,
    id,
    subjectId: TASK,
    predicate: "task.continuation",
    value,
    evidenceKind: "objective-measurement",
    evidenceId: `measurement:${id.split(":")[1]}`,
    evidenceDigest: digest(value),
    observedAt: "2034-05-04T13:00:00.000Z",
    projectId: PROJECT,
    privacy: "shared",
    knowledgeKind: "task-state",
    sessionRef: SESSION_REF,
    messageRef: `timeline-event:${id.split(":")[1]}`,
    now: NOW,
    ...extra
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-task-continuation-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-task-continuation-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  await mkdir(join(root, ".git"));
  const source = Buffer.from("# Synthetic continuation source\n\nThese bytes remain user-owned.\n");
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  return { root, state, source };
}

function restartedContext(root, state) {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/lib/world-model.js")).href;
  const script = "const m=await import(process.env.MODULE_URL);"
    + "const value=await m.worldContext({root:process.env.PROJECT_ROOT,projectId:process.env.PROJECT_ID,"
    + "continuationTaskId:process.env.TASK_ID,now:process.env.NOW});"
    + "console.log(JSON.stringify(value.knowledge.continuation));";
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, AGENTSPINE_STATE_DIR: state, MODULE_URL: moduleUrl,
      PROJECT_ROOT: root, PROJECT_ID: PROJECT, TASK_ID: TASK, NOW }
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("normal task state gains one source-bound continuation across restart and PostCompact", async (t) => {
  const { root, state, source } = await fixture(t);
  await recordWorldAssertion({
    ...assertion(root, "assertion:legacy", "active"),
    predicate: "task.legacy-state",
    sessionRef: undefined,
    messageRef: undefined
  });
  const before = await worldContext({ root, projectId: PROJECT, now: NOW });
  assert.deepEqual(before.knowledge.continuation.tasks, [],
    "Before: an ordinary task-state assertion cannot reconstruct the working step");

  await recordWorldAssertion(assertion(root, "assertion:checkpoint", capsule()));
  const restarted = restartedContext(root, state);
  assert.equal(restarted.tasks.length, 1);
  assert.equal(restarted.tasks[0].taskId, TASK);
  assert.equal(restarted.tasks[0].lastVerifiedStep.result, "passed");
  assert.equal(restarted.tasks[0].nextStep.id, "step:contract-tests");
  assert.deepEqual(restarted.tasks[0].source, {
    kind: "objective-measurement",
    id: "measurement:checkpoint",
    digest: digest(capsule()),
    sessionRef: SESSION_REF,
    messageRef: "timeline-event:checkpoint"
  });

  const briefing = await sessionBriefing({ root, host: "generic", projectId: PROJECT,
    currentTaskId: TASK, includeSourceContent: false, maxBytes: 8192, now: NOW });
  assert.equal(briefing.world.knowledge.continuation.tasks[0].taskId, TASK);
  assert.equal(briefing.voiceBrief.currentTask.nextStep.id, "step:contract-tests");
  assert.equal(briefing.world.knowledge.current.some((item) => item.id === "assertion:checkpoint"), false,
    "the briefing does not duplicate the full checkpoint entry");

  const compacted = await runHook({
    hook_event_name: "PostCompact", host: "codex", cwd: root,
    session_id: "session:synthetic-restart", timestamp: NOW,
    project_id: PROJECT, task_id: TASK,
    agent_spine_scope: { project_id: PROJECT, task_id: TASK }
  });
  assert.equal(compacted.failedClosed, undefined, compacted.reason || compacted.error);
  const packet = JSON.parse(compacted.context);
  assert.equal(packet.briefing.world.knowledge.continuation.tasks[0].nextStep.id, "step:contract-tests");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("suggestions and conflicts do not resume; correction and completion preserve history", async (t) => {
  const { root } = await fixture(t);
  const suggestion = assertion(root, "assertion:suggestion-one", capsule(), {
    evidenceKind: "model-suggestion", evidenceId: "model-output:suggestion-one"
  });
  const suggestionTwo = assertion(root, "assertion:suggestion-two", capsule(), {
    evidenceKind: "model-suggestion", evidenceId: "model-output:suggestion-two"
  });
  await Promise.all([recordWorldAssertion(suggestion), recordWorldAssertion(suggestionTwo)]);
  let context = await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK, now: NOW });
  assert.deepEqual(context.knowledge.continuation.tasks, [], "repetition cannot promote a proposed checkpoint");

  const active = assertion(root, "assertion:active", capsule());
  const pausedValue = capsule("paused", {
    nextStep: { id: "step:resolve-conflict", summary: "Resolve the synthetic state conflict." }
  });
  const paused = assertion(root, "assertion:paused", pausedValue, {
    evidenceId: "measurement:paused", observedAt: "2034-05-04T13:10:00.000Z"
  });
  await Promise.all([recordWorldAssertion(active), recordWorldAssertion(paused)]);
  context = await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK, now: NOW });
  assert.deepEqual(context.knowledge.continuation.tasks, [], "conflicting checkpoints must be withheld");

  const correctedValue = capsule("paused", {
    objective: "Follow the newest synthetic user instruction.",
    openQuestions: [],
    nextStep: { id: "step:new-instruction", summary: "Apply the explicitly corrected next step." }
  });
  await recordWorldAssertion(assertion(root, "assertion:corrected", correctedValue, {
    evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:corrected",
    observedAt: "2034-05-04T13:20:00.000Z",
    supersedes: [suggestion.id, suggestionTwo.id, active.id, paused.id],
    reason: "Newest explicit instruction replaces the older task state."
  }));
  context = await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK,
    includeKnowledgeHistory: true, now: NOW });
  assert.equal(context.knowledge.continuation.tasks[0].nextStep.id, "step:new-instruction");
  assert.equal(context.knowledge.continuation.tasks[0].source.kind, "explicit-user-feedback");
  assert.equal(context.knowledge.history.length, 4);

  const completedValue = capsule("completed", {
    lastVerifiedStep: step("step:final-suite", "passed"), openQuestions: [], nextStep: null
  });
  await recordWorldAssertion(assertion(root, "assertion:completed", completedValue, {
    evidenceId: "measurement:completed", observedAt: "2034-05-04T13:30:00.000Z",
    supersedes: ["assertion:corrected"]
  }));
  context = await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK, now: NOW });
  assert.deepEqual(context.knowledge.continuation.tasks, []);
  assert.equal(context.knowledge.continuation.terminal[0].status, "completed");
  assert.equal(context.knowledge.continuation.terminal[0].nextStep, null);
  const briefing = await sessionBriefing({ root, host: "generic", projectId: PROJECT,
    currentTaskId: TASK, includeSourceContent: false, maxBytes: 8192, now: NOW });
  assert.equal(briefing.voiceBrief.currentTask.status, "completed");
  assert.equal(briefing.world.knowledge.continuation.tasks.length, 0,
    "a terminal checkpoint must never become resumable work");
});

test("continuation enforces exact scope, bounded structure, integrity, and source preservation", async (t) => {
  const { root, source } = await fixture(t);
  await recordWorldAssertion(assertion(root, "assertion:group-alpha", capsule(), {
    projectId: null, privacy: "group", groupId: "group:alpha"
  }));
  await recordWorldAssertion(assertion(root, "assertion:group-beta", capsule("blocked", {
    nextStep: { id: "step:beta", summary: "Continue only in beta." }
  }), { projectId: null, privacy: "group", groupId: "group:beta", evidenceId: "measurement:beta" }));
  assert.equal((await worldContext({ root, groupId: "group:alpha", continuationTaskId: TASK, now: NOW }))
    .knowledge.continuation.tasks[0].scope.groupId, "group:alpha");
  assert.equal((await worldContext({ root, groupId: "group:beta", continuationTaskId: TASK, now: NOW }))
    .knowledge.continuation.tasks[0].nextStep.id, "step:beta");
  assert.deepEqual((await worldContext({ root, projectId: PROJECT, continuationTaskId: TASK, now: NOW }))
    .knowledge.continuation.tasks, []);

  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:invalid-complete",
    capsule("completed"))), /completed task continuation/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:user-complete",
    capsule("completed", { lastVerifiedStep: step("step:user-complete"), openQuestions: [], nextStep: null }), {
    evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:complete"
  })), /objective measurement evidence/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:invalid-open",
    capsule("active", { nextStep: null }))), /requires a next step/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:future-step",
    capsule("active", { lastVerifiedStep: { ...step(), observedAt: "2034-05-04T13:30:00.000Z" } }),
    { observedAt: "2034-05-04T13:00:00.000Z" })), /timestamp is invalid/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:secret",
    capsule("active", { objective: "Use github_pat_abcdefghijklmnopqrstuvwxyz0123456789" }))),
  /secret-shaped/);

  const path = await worldModelStatePath(root);
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.assertions[0].value.nextStep.summary = "Tampered next step.";
  await writeFile(path, `${JSON.stringify(stored)}\n`);
  await assert.rejects(worldContext({ root, groupId: "group:alpha", now: NOW }), /world model state is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("parallel checkpoints stay bounded and an exact task excludes unrelated work", async (t) => {
  const { root, source } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const taskId = `task:bounded-${index}`;
    const value = capsule("active", {
      taskId,
      objective: `Finish bounded synthetic task ${index}.`,
      nextStep: { id: `step:bounded-${index}`, summary: `Run bounded step ${index}.` }
    });
    return recordWorldAssertion(assertion(root, `assertion:bounded-${index}`, value, {
      subjectId: taskId,
      evidenceId: `measurement:bounded-${index}`,
      messageRef: `timeline-event:bounded-${index}`
    }));
  }));
  const all = await worldContext({ root, projectId: PROJECT, now: NOW, maxItems: 100 });
  assert.equal(all.knowledge.continuation.tasks.length, 8);
  assert.equal(all.knowledge.continuation.omitted, 4);
  const exact = await worldContext({ root, projectId: PROJECT,
    continuationTaskId: "task:bounded-11", now: NOW, maxItems: 100 });
  assert.deepEqual(exact.knowledge.continuation.tasks.map((item) => item.taskId), ["task:bounded-11"]);
  const briefing = await sessionBriefing({ root, host: "generic", projectId: PROJECT,
    currentTaskId: "task:bounded-11", includeSourceContent: false, maxBytes: 4096, now: NOW });
  assert.equal(briefing.world.knowledge.continuation.tasks.length, 1);
  assert.ok(briefing.budget.usedBytes <= briefing.budget.maxBytes);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});
