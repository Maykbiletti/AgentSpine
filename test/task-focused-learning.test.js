import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { artifactEvaluationPlan, measureLearningArtifacts } from "../src/lib/learning-artifact-evaluator.js";
import { sessionBriefing } from "../src/lib/briefing.js";
import { createTask } from "../src/lib/coordination.js";
import {
  addLearningEvidence, configureLearning, evaluateLearning, learningContext, loadLearning,
  proposeLearning, recordLearningMeasurement, recordLearningOutcome, reviewLearning, rollbackLearning
} from "../src/lib/learning.js";
import { runHook } from "../src/hook.js";
import { evidence, evaluation, fixture, hash, scopedTurn, upsertEntity } from "./learning-fixture.js";

const LEARNING = "learning:task-backup";
const EVALUATION = "evaluation:task-backup";
const ARTIFACT_EVALUATOR = "evaluator:task-artifact";
const INDEPENDENT_EVALUATOR = "evaluator:task-independent";

async function seed(t) {
  const original = await fixture(t);
  const root = await realpath(original.root);
  await Promise.all([mkdir(join(root, ".git")), mkdir(join(root, "artifacts"))]);
  const source = await readFile(join(root, "AGENTS.md"));
  const spec = { schema: "agentspine.artifact-checks/v1", checks: [
    { path: "AGENTS.md", sha256: hash(source), blocking: true },
    { path: "artifacts/archive.bak", sha256: hash("original archive"), blocking: false },
    { path: "artifacts/result.txt", sha256: hash("migrated archive"), blocking: false }
  ] };
  const plan = artifactEvaluationPlan(spec);
  const start = new Date();
  await upsertEntity({ root, id: scopedTurn.personaId, kind: "agent",
    displayName: "Synthetic Worker", privacy: "shared" });
  await upsertEntity({ root, id: scopedTurn.projectId, kind: "project",
    displayName: "Synthetic Archive", privacy: "shared" });
  await createTask({ root, id: scopedTurn.taskId, actorId: scopedTurn.personaId,
    assigneeId: scopedTurn.personaId, projectId: scopedTurn.projectId, privacy: "shared",
    title: "Migrate the archive safely", summary: "Preserve a backup, then migrate the archive and verify its bytes.",
    now: start });
  await proposeLearning({ root, id: LEARNING, kind: "behavior", scope: scopedTurn, privacy: "shared",
    claim: "Preserve an archive backup before migration.",
    evidence: evidence("evidence:task-backup-a", 0.98), now: start });
  await addLearningEvidence({ root, id: LEARNING,
    evidence: evidence("evidence:task-backup-b", 0.98), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 }, now: start });
  await evaluation(root, LEARNING, { id: EVALUATION, scope: scopedTurn, metric: plan.metric,
    benchmark: { taskDigest: hash("bounded archive migration"), datasetDigest: plan.datasetDigest,
      protocolDigest: plan.protocolDigest, minCases: plan.minCases },
    evaluatorIds: [ARTIFACT_EVALUATOR, INDEPENDENT_EVALUATOR], evaluatorRoots: [
      { evaluatorId: ARTIFACT_EVALUATOR, principalDigest: plan.principalDigest },
      { evaluatorId: INDEPENDENT_EVALUATOR, principalDigest: hash("independent task byte comparator") }
    ], now: start });
  const contract = (await loadLearning(root)).learning.evaluations.find((item) => item.id === EVALUATION);
  await writeFile(join(root, "artifacts/result.txt"), "migrated archive");
  const before = await measureLearningArtifacts({ root, spec, id: "measurement:task-before-a",
    learningId: LEARNING, evaluationId: EVALUATION, scope: scopedTurn, phase: "before",
    evaluatorId: ARTIFACT_EVALUATOR,
    runId: contract.initialTrials.before.find((item) => item.evaluatorId === ARTIFACT_EVALUATOR).runId,
    confirmLocalMeasurement: true });
  await recordLearningOutcome({ root, id: "outcome:task-before-a", learningId: LEARNING,
    evaluationId: EVALUATION, measurementReceiptId: before.receipt.id, now: new Date(start.getTime() + 1000) });
  const independentReport = [];
  for (const check of plan.spec.checks) {
    let observed = null;
    try { observed = hash(await readFile(join(root, check.path))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    independentReport.push({ path: check.path, observed, passed: observed === check.sha256 });
  }
  const independentValue = independentReport.filter((item) => item.passed).length / independentReport.length;
  const independent = await recordLearningMeasurement({ root, id: "measurement:task-before-b",
    learningId: LEARNING, evaluationId: EVALUATION, phase: "before", scope: scopedTurn,
    metric: { ...plan.metric, value: independentValue, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: INDEPENDENT_EVALUATOR,
      runId: contract.initialTrials.before.find((item) => item.evaluatorId === INDEPENDENT_EVALUATOR).runId,
      sourceDigest: hash(JSON.stringify(independentReport)) },
    coverage: { datasetDigest: plan.datasetDigest, caseCount: plan.minCases },
    confirmLocalMeasurement: true });
  await recordLearningOutcome({ root, id: "outcome:task-before-b", learningId: LEARNING,
    evaluationId: EVALUATION, measurementReceiptId: independent.receipt.id,
    now: new Date(start.getTime() + 1500) });
  await evaluateLearning({ root, now: new Date(start.getTime() + 2000) });
  for (let index = 0; index < 14; index += 1) {
    const id = `learning:new-unrelated-${String(index).padStart(2, "0")}`;
    await proposeLearning({ root, id, kind: "behavior", privacy: "shared",
      scope: { ...scopedTurn, taskId: null },
      claim: `Use synthetic unrelated strategy ${index} for telemetry dashboards ${"x".repeat(180)}.`,
      evidence: evidence(`evidence:new-unrelated-${index}`, 1), now: new Date(start.getTime() + 3000 + index) });
    await reviewLearning({ root, id, decision: "accept", reason: "Synthetic unrelated control.",
      confirmedByUser: true, now: new Date(start.getTime() + 3000 + index) });
  }
  return { ...original, root, source, spec, plan, contract, before, start };
}

function hasStrategy(items) {
  return items.some((item) => item.id === LEARNING);
}

test("the bounded current task selects and applies its measured strategy across provider hooks", async (t) => {
  const f = await seed(t);
  const baseline = await learningContext({ root: f.root, scope: scopedTurn, maxItems: 4,
    now: new Date(f.start.getTime() + 5000) });
  assert.equal(hasStrategy(baseline.items), false,
    "Before: confidence/newest ordering loses the older relevant strategy at the same item budget");
  const focused = await learningContext({ root: f.root, scope: scopedTurn, maxItems: 4,
    taskFocus: scopedTurn.taskId,
    now: new Date(f.start.getTime() + 5000) });
  assert.equal(focused.items[0].id, LEARNING);
  assert.equal(focused.items[0].relevance.match, "exact-task");

  const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = f.state;
  process.env.CODEX_HOME = f.state;
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const contexts = [];
  for (const host of ["claude", "codex"]) {
    const binding = { host, cwd: f.root, session_id: `session:task-focus-${host}`,
      entity_id: scopedTurn.personaId, user_id: scopedTurn.userId, tenant_id: scopedTurn.tenantId,
      project_id: scopedTurn.projectId, task_id: scopedTurn.taskId };
    const hook = await runHook({ ...binding, hook_event_name: "UserPromptSubmit",
      event_id: `turn:task-focus-${host}`, prompt: "Continue the current archive migration." });
    assert.equal(hook.blocked, false, hook.reason);
    const context = JSON.parse(hook.context);
    contexts.push(context);
    assert.equal(context.briefing.learning[0]?.id, LEARNING, JSON.stringify({
      learning: context.briefing.learning, omitted: context.briefing.budget.omitted,
      applications: context.preflight.learningApplications
    }));
    assert.equal(context.preflight.learningApplications.status, "recorded");
    assert.equal(context.preflight.learningApplications.receipts[0].learningId, LEARNING);
    assert.ok(context.briefing.budget.usedBytes <= 4096);
    const compact = await runHook({ ...binding, hook_event_name: "PostCompact" });
    assert.equal(compact.blocked, false, compact.reason);
    assert.equal(compact.briefing.learning[0].id, LEARNING);
    const stop = await runHook({ ...binding, hook_event_name: "Stop" });
    assert.equal(stop.blocked, false, stop.reason);
    assert.equal(stop.learningDelivery.status, "completed");
  }

  const selected = contexts[0].briefing.learning;
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/lib/briefing.js")).href;
  const restarted = spawnSync(process.execPath, ["--input-type=module", "-e",
    "const m=await import(process.env.MODULE_URL);const b=await m.sessionBriefing(JSON.parse(process.env.INPUT));console.log(JSON.stringify(b.learning));"], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: f.state, MODULE_URL: moduleUrl,
      INPUT: JSON.stringify({ root: f.root, host: "codex", entityId: scopedTurn.personaId,
        userId: scopedTurn.userId, tenantId: scopedTurn.tenantId, projectId: scopedTurn.projectId,
        currentTaskId: scopedTurn.taskId, includeSourceContent: false, maxBytes: 4096 }) }
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout)[0].id, LEARNING);
  if (hasStrategy(selected)) await writeFile(join(f.root, "artifacts/archive.bak"), "original archive");
  const state = (await loadLearning(f.root)).learning;
  const application = state.applications.find((item) =>
    item.initialAdmission?.evaluatorId === ARTIFACT_EVALUATOR);
  const delivery = state.deliveries.find((item) => item.applicationId === application.id);
  const started = performance.now();
  const after = await measureLearningArtifacts({ root: f.root, spec: f.spec,
    id: "measurement:task-after-a", learningId: LEARNING, evaluationId: EVALUATION,
    scope: scopedTurn, phase: "after", evaluatorId: ARTIFACT_EVALUATOR,
    runId: f.contract.initialTrials.after.find((item) => item.evaluatorId === ARTIFACT_EVALUATOR).runId,
    confirmLocalMeasurement: true });
  await recordLearningOutcome({ root: f.root, id: "outcome:task-after-a", learningId: LEARNING,
    evaluationId: EVALUATION, measurementReceiptId: after.receipt.id,
    applicationId: application.id, deliveryId: delivery.id });
  assert.equal(f.before.receipt.metric.value, 2 / 3);
  assert.equal(after.receipt.metric.value, 1);
  assert.equal(after.completionVerified, false);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
  t.diagnostic(JSON.stringify({ before: 2 / 3, after: 1, contextBytes: contexts.map((item) =>
    item.briefing.budget.usedBytes), elapsedMs: performance.now() - started, tokens: "not-measured" }));
});

test("task ranking never widens scope and keeps generic ordering unchanged", async (t) => {
  const f = await seed(t);
  const generic = await learningContext({ root: f.root, scope: scopedTurn, maxItems: 6 });
  const unrelated = await learningContext({ root: f.root, scope: scopedTurn, maxItems: 6,
    taskFocus: "task:other" });
  const foreign = await learningContext({ root: f.root, scope: { ...scopedTurn, tenantId: "tenant:foreign" },
    maxItems: 50, taskFocus: scopedTurn.taskId });
  const expected = (await loadLearning(f.root)).learning.candidates.filter((item) => item.status === "accepted")
    .sort((a, b) => b.confidence - a.confidence
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, 6).map((item) => item.id);
  assert.deepEqual(generic.items.map((item) => item.id), expected);
  assert.deepEqual(unrelated.items.map((item) => item.id), expected);
  assert.equal(foreign.items.some((item) => item.id === LEARNING), false);
  const briefing = await sessionBriefing({ root: f.root, host: "generic", entityId: scopedTurn.personaId,
    userId: scopedTurn.userId, tenantId: scopedTurn.tenantId, projectId: scopedTurn.projectId,
    currentTaskId: scopedTurn.taskId, includeSourceContent: false, maxBytes: 4096 });
  assert.equal(briefing.learning[0].id, LEARNING);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
});

for (const provider of ["claude", "codex", "king"]) test(`${provider} action hook recalls exact-task outcome learning before tool use`, async (t) => {
  const f = await seed(t);
  const keys = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "BLUN_HOME", "BLUN_PLUGIN_ROOT"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  if (provider === "claude") process.env.CLAUDE_CONFIG_DIR = f.state;
  if (provider === "codex") process.env.CODEX_HOME = f.state;
  if (provider === "king") {
    process.env.BLUN_HOME = f.state;
    process.env.BLUN_PLUGIN_ROOT = process.cwd();
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const binding = {
    ...(provider === "king" ? {} : { host: provider }),
    cwd: f.root,
    session_id: `session:action-learning-${provider}`,
    entity_id: scopedTurn.personaId,
    user_id: scopedTurn.userId,
    tenant_id: scopedTurn.tenantId,
    project_id: scopedTurn.projectId,
    task_id: scopedTurn.taskId
  };
  const prompt = await runHook({ ...binding, hook_event_name: "UserPromptSubmit",
    event_id: `turn:action-learning-${provider}`, prompt: "Continue the exact archive task." });
  assert.equal(prompt.blocked, false, prompt.reason);
  const compact = await runHook({ ...binding, hook_event_name: "PostCompact",
    event_id: `compact:action-learning-${provider}` });
  assert.equal(compact.blocked, false, compact.reason);
  const started = performance.now();
  const action = await runHook({ ...binding, hook_event_name: "PreToolUse",
    tool_use_id: `tool:action-learning-${provider}`, tool_name: "Read",
    tool_input: { path: "artifacts/result.txt" } });
  assert.equal(action.blocked, false, action.reason);
  assert.equal(action.lessonRecall.schema, "agentspine.action-lesson-recall/v2");
  assert.equal(action.lessonRecall.learning.length, 1);
  assert.equal(action.lessonRecall.learning[0].id, LEARNING);
  assert.equal(action.lessonRecall.learning[0].relevance.match, "exact-task");
  assert.ok(Buffer.byteLength(JSON.stringify(action.lessonRecall)) <= 8192);
  // The deterministic worker consumes only the action-time context.
  if (hasStrategy(action.lessonRecall.learning)) {
    await writeFile(join(f.root, "artifacts/archive.bak"), "original archive");
  }
  const stop = await runHook({ ...binding, hook_event_name: "Stop" });
  assert.equal(stop.blocked, false, stop.reason);
  const state = (await loadLearning(f.root)).learning;
  const application = state.applications.find((item) =>
    item.initialAdmission?.evaluatorId === ARTIFACT_EVALUATOR);
  const delivery = state.deliveries.find((item) => item.applicationId === application.id);
  const after = await measureLearningArtifacts({ root: f.root, spec: f.spec,
    id: `measurement:action-after-${provider}`, learningId: LEARNING, evaluationId: EVALUATION,
    scope: scopedTurn, phase: "after", evaluatorId: ARTIFACT_EVALUATOR,
    runId: f.contract.initialTrials.after.find((item) => item.evaluatorId === ARTIFACT_EVALUATOR).runId,
    confirmLocalMeasurement: true });
  await recordLearningOutcome({ root: f.root, id: `outcome:action-after-${provider}`,
    learningId: LEARNING, evaluationId: EVALUATION, measurementReceiptId: after.receipt.id,
    applicationId: application.id, deliveryId: delivery.id });
  assert.equal(f.before.receipt.metric.value, 2 / 3);
  assert.equal(after.receipt.metric.value, 1);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
  t.diagnostic(JSON.stringify({ provider, before: 2 / 3, after: 1,
    actionContextBytes: Buffer.byteLength(JSON.stringify(action.lessonRecall)),
    elapsedMs: performance.now() - started, tokens: "not-measured" }));
});

test("action-time learning degrades safely and never crosses task, tenant or group scope", async (t) => {
  const f = await seed(t);
  process.env.CODEX_HOME = f.state;
  const binding = { host: "codex", cwd: f.root, session_id: "session:action-boundaries",
    entity_id: scopedTurn.personaId, user_id: scopedTurn.userId,
    tenant_id: scopedTurn.tenantId, project_id: scopedTurn.projectId,
    task_id: scopedTurn.taskId, hook_event_name: "PreToolUse", tool_name: "Read",
    tool_input: { path: "artifacts/result.txt" } };
  const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) => runHook({
    ...binding, tool_use_id: `tool:action-race-${index}`
  })));
  assert.ok(concurrent.every((item) => !item.blocked && item.lessonRecall.learning[0]?.id === LEARNING));
  for (const [field, value] of [["tenant_id", "tenant:foreign"], ["task_id", "task:foreign"]]) {
    const result = await runHook({ ...binding, [field]: value, tool_use_id: `tool:foreign-${field}` });
    assert.deepEqual(result.lessonRecall.learning, []);
  }
  const group = await runHook({ ...binding, group_id: "group:foreign",
    tool_use_id: "tool:group-suppressed" });
  assert.equal(group.lessonRecall.status, "group-suppressed");
  assert.deepEqual(group.lessonRecall.learning, []);
  await rollbackLearning({ root: f.root, id: LEARNING, reason: "Synthetic revocation before action." });
  const revoked = await runHook({ ...binding, tool_use_id: "tool:revoked-learning" });
  assert.deepEqual(revoked.lessonRecall.learning, []);
  const { learningPath } = await loadLearning(f.root);
  const stateBytes = await readFile(learningPath);
  await writeFile(learningPath, "{synthetic-corrupt-state");
  const degraded = await runHook({ ...binding, tool_use_id: "tool:degraded-learning" });
  assert.equal(degraded.blocked, false);
  assert.equal(degraded.lessonRecall.status, "degraded");
  assert.equal(degraded.lessonRecall.learningDiagnostics.status, "degraded");
  await writeFile(learningPath, stateBytes);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
});
