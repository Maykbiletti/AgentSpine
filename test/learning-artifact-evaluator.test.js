import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { artifactEvaluationPlan, measureLearningArtifacts } from "../src/lib/learning-artifact-evaluator.js";
import { fixture, hash, evidence, scopedTurn, evaluation, application } from "./learning-fixture.js";
import { proposeLearning, addLearningEvidence, configureLearning, loadLearning,
  recordLearningMeasurement, recordLearningOutcome, evaluateLearning, learningContext } from "../src/lib/learning.js";
import { upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";

const SCOPE = { ...scopedTurn, taskId: null };
const LEARNING = "learning:artifact-backup";
const EVALUATION = "evaluation:artifact-backup";
const EVALUATOR = "evaluator:artifact";
const EXTERNAL = "evaluator:independent-fixture";

async function setup(t, checks = null) {
  const original = await fixture(t);
  const root = await realpath(original.root);
  await mkdir(join(root, "artifacts"));
  await mkdir(join(root, ".git"));
  const source = await readFile(join(root, "AGENTS.md"));
  const spec = { schema: "agentspine.artifact-checks/v1", checks: checks || [
    { path: "artifacts/archive.bak", sha256: hash("original archive"), blocking: false },
    { path: "artifacts/result.txt", sha256: hash("migrated archive"), blocking: false },
    { path: "AGENTS.md", sha256: hash(source), blocking: true }
  ] };
  const plan = artifactEvaluationPlan(spec);
  await proposeLearning({ root, id: LEARNING, kind: "behavior", scope: SCOPE, privacy: "shared",
    claim: "Preserve an archive backup before migration.", evidence: evidence("evidence:artifact-a", 0.98) });
  await addLearningEvidence({ root, id: LEARNING, evidence: evidence("evidence:artifact-b", 0.98) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  await evaluation(root, LEARNING, { id: EVALUATION, scope: SCOPE, metric: plan.metric,
    benchmark: { taskDigest: hash("synthetic archive migration task"), datasetDigest: plan.datasetDigest,
      protocolDigest: plan.protocolDigest, minCases: plan.minCases },
    evaluatorIds: [EVALUATOR, EXTERNAL], evaluatorRoots: [
      { evaluatorId: EVALUATOR, principalDigest: plan.principalDigest },
      { evaluatorId: EXTERNAL, principalDigest: hash("independent synthetic byte comparator") }
    ] });
  const { learning } = await loadLearning(root);
  const contract = learning.evaluations.find((entry) => entry.id === EVALUATION);
  const input = (phase = "before", extra = {}) => ({ root, spec, id: `measurement:artifact-${phase}`,
    learningId: LEARNING, evaluationId: EVALUATION, scope: SCOPE, phase, evaluatorId: EVALUATOR,
    runId: contract.initialTrials[phase].find((entry) => entry.evaluatorId === EVALUATOR).runId,
    confirmLocalMeasurement: true, ...extra });
  return { ...original, root, source, spec, plan, contract, input };
}

async function consume(root, receipt, binding = {}) {
  return recordLearningOutcome({ root, id: `outcome:${receipt.id.split(":").at(-1)}`,
    learningId: LEARNING, evaluationId: EVALUATION, measurementReceiptId: receipt.id, ...binding });
}

// An independently implemented synthetic byte comparator supplies the OTHER
// required principal. It is not claimed to be an independent organization or LLM.
async function externalMeasurement(f, phase) {
  const expected = [
    ["artifacts/archive.bak", Buffer.from("original archive")],
    ["artifacts/result.txt", Buffer.from("migrated archive")],
    ["AGENTS.md", f.source]
  ];
  const observed = [];
  for (const [path, bytes] of expected) {
    let data = null;
    try { data = await readFile(join(f.root, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    observed.push({ path, matches: data !== null && data.equals(bytes),
      digest: data === null ? null : hash(data) });
  }
  return recordLearningMeasurement({ root: f.root, id: `measurement:external-${phase}`,
    learningId: LEARNING, evaluationId: EVALUATION, scope: SCOPE, phase,
    metric: { ...f.plan.metric, value: observed.filter((entry) => entry.matches).length / expected.length,
      blockingDefects: observed.at(-1).matches ? 0 : 1 },
    measurement: { kind: "objective", evaluatorId: EXTERNAL,
      runId: f.contract.initialTrials[phase].find((entry) => entry.evaluatorId === EXTERNAL).runId,
      sourceDigest: hash(JSON.stringify({ phase, observed, method: "byte-equality" })) },
    coverage: { datasetDigest: f.plan.datasetDigest, caseCount: expected.length },
    confirmLocalMeasurement: true });
}

test("artifact plans pin exact bounded checks and cannot create evaluator independence by alias", () => {
  const spec = { schema: "agentspine.artifact-checks/v1", checks: [
    { path: "result.txt", sha256: null, blocking: true }
  ] };
  assert.equal(artifactEvaluationPlan(spec).minCases, 1);
  for (const path of ["../escape", "/absolute", "a/../b", "C:/host", "a\\b", ".env", "a//b"]) {
    assert.throws(() => artifactEvaluationPlan({ ...spec, checks: [{ ...spec.checks[0], path }] }));
  }
  assert.throws(() => artifactEvaluationPlan({ ...spec, schema: "agentspine.artifact-checks/v999" }));
  assert.throws(() => artifactEvaluationPlan({ ...spec, loaded: true }));
  assert.throws(() => artifactEvaluationPlan({ ...spec, checks: [...spec.checks, { ...spec.checks[0], path: "RESULT.txt" }] }));
  assert.throws(() => artifactEvaluationPlan({ ...spec, checks: Array(17).fill(spec.checks[0]) }));
  const changed = { ...spec, checks: [{ ...spec.checks[0], blocking: false }] };
  assert.notEqual(artifactEvaluationPlan(spec).datasetDigest, artifactEvaluationPlan(changed).datasetDigest);
  assert.equal(artifactEvaluationPlan(spec).principalDigest, artifactEvaluationPlan(changed).principalDigest);
});

test("real filesystem results replace supplied scores and flow through canary, restart and validation", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.root, "artifacts/result.txt"), "migrated archive");
  const before = await measureLearningArtifacts(f.input("before", { value: 1, blockingDefects: 0 }));
  assert.equal(before.receipt.metric.value, 2 / 3);
  assert.equal(before.completionVerified, false);
  assert.equal(before.automaticRetry, false);
  assert.equal(before.sourceDigest, hash(JSON.stringify(before.report)));
  assert.equal(before.diagnostics.commandsExecuted, 0);
  assert.equal(before.diagnostics.broadScan, false);
  await consume(f.root, before.receipt);
  await consume(f.root, (await externalMeasurement(f, "before")).receipt);
  await evaluateLearning({ root: f.root });
  const context = await learningContext({ root: f.root, scope: SCOPE });
  assert.equal(context.items[0].outcomeStatus, "active");
  // A deterministic synthetic worker actually applies the recalled strategy.
  if (context.items.some((entry) => entry.claim.includes("backup before migration"))) {
    await writeFile(join(f.root, "artifacts/archive.bak"), "original archive");
  }
  const projected = await application(f.root, LEARNING, "artifact-after", new Date(), "active", SCOPE);
  const child = spawnSync(process.execPath, ["bin/agentspine.js", "learn-artifact-measure", "measurement:artifact-after",
    "--root", f.root, "--checks", JSON.stringify(f.spec), "--learning", LEARNING, "--evaluation", EVALUATION,
    "--phase", "after", "--evaluator", EVALUATOR, "--run", f.input("after").runId,
    "--persona", SCOPE.personaId, "--user", SCOPE.userId, "--tenant", SCOPE.tenantId,
    "--project", SCOPE.projectId, "--confirm-local-measurement", "--json"],
  { encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: f.state } });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const after = JSON.parse(child.stdout);
  assert.equal(after.receipt.metric.value, 1);
  await consume(f.root, after.receipt, { applicationId: projected.id, deliveryId: projected.deliveryId });
  const second = await application(f.root, LEARNING, "artifact-independent-after", new Date(), "active", SCOPE);
  const result = await consume(f.root, (await externalMeasurement(f, "after")).receipt,
    { applicationId: second.id, deliveryId: second.deliveryId });
  assert.equal(result.decision, "validated");
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
  assert.equal((await loadLearning(f.root)).learning.measurements.length, 4);
  t.diagnostic(JSON.stringify({ before: before.receipt.metric.value, after: after.receipt.metric.value,
    checks: f.plan.minCases, inspectedBytes: after.diagnostics.inspectedBytes,
    evaluatorMs: after.diagnostics.elapsedMs, tokens: "not-measured" }));
});

test("foreign scopes, criteria drift, unregistered principals and replay cannot yield measurements", async (t) => {
  const f = await setup(t);
  for (const field of ["personaId", "userId", "tenantId", "projectId", "groupId", "taskId"]) {
    await assert.rejects(measureLearningArtifacts(f.input("before", { scope: { ...SCOPE, [field]: "foreign:id" } })), /exact-scope/);
  }
  await assert.rejects(measureLearningArtifacts(f.input("before", { confirmLocalMeasurement: false })), /local confirmation/);
  await assert.rejects(measureLearningArtifacts(f.input("before", { evaluatorId: EXTERNAL })), /single locally registered/);
  await assert.rejects(measureLearningArtifacts(f.input("before", { runId: "run:replacement" })), /precommitted/);
  const changed = structuredClone(f.spec);
  changed.checks[0].sha256 = null;
  await assert.rejects(measureLearningArtifacts(f.input("before", { spec: changed })), /frozen evaluation/);
  assert.equal((await loadLearning(f.root)).learning.measurements.length, 0);
  const concurrent = await Promise.allSettled(Array.from({ length: 4 }, () => measureLearningArtifacts(f.input())));
  assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal((await loadLearning(f.root)).learning.measurements.length, 1);
  await assert.rejects(measureLearningArtifacts(f.input()), /already measured/);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
});

test("symlink, oversized and missing artifacts never become invented passing results", async (t) => {
  const f = await setup(t);
  // Directory junctions provide a non-admin Windows symlink counterexample.
  const linked = await setup(t, [{ path: "artifacts/link/AGENTS.md", sha256: hash(f.source), blocking: true }]);
  await symlink(f.root, join(linked.root, "artifacts/link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(measureLearningArtifacts(linked.input()), /non-symbolic/);
  process.env.AGENTSPINE_STATE_DIR = f.state;
  await writeFile(join(f.root, "artifacts/archive.bak"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(measureLearningArtifacts(f.input()), /bounded measurement budget/);
  await unlink(join(f.root, "artifacts/archive.bak"));
  const missing = await measureLearningArtifacts(f.input());
  assert.equal(missing.receipt.metric.value, 1 / 3);
  assert.equal(missing.report.checks.filter((entry) => entry.observedDigest === null).length, 2);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
});

for (const host of ["claude", "codex"]) test(`${host} real prompt and Stop bind measured artifact outcomes without claiming completion`, async (t) => {
  const f = await setup(t);
  const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = f.state;
  process.env.CODEX_HOME = f.state;
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  await upsertEntity({ root: f.root, id: SCOPE.personaId, kind: "agent", displayName: "Synthetic Evaluator", privacy: "shared" });
  await writeFile(join(f.root, "artifacts/result.txt"), "migrated archive");
  await consume(f.root, (await measureLearningArtifacts(f.input())).receipt);
  await consume(f.root, (await externalMeasurement(f, "before")).receipt);
  await evaluateLearning({ root: f.root });
  const binding = { host, cwd: f.root, session_id: `session:artifact-${host}`, entity_id: SCOPE.personaId,
    user_id: SCOPE.userId, tenant_id: SCOPE.tenantId, project_id: SCOPE.projectId };
  const hook = await runHook({ ...binding, hook_event_name: "UserPromptSubmit",
    event_id: `turn:artifact-${host}`, prompt: "Continue the synthetic archive migration." });
  assert.equal(hook.blocked, false, hook.reason);
  const injected = JSON.parse(hook.context);
  assert.equal(injected.preflight.learningApplications.status, "recorded");
  assert.ok(injected.briefing.learning.some((entry) => entry.id === LEARNING));
  const compact = await runHook({ ...binding, hook_event_name: "PostCompact" });
  assert.equal(compact.blocked, false, compact.reason);
  assert.ok(compact.briefing.learning.some((entry) => entry.id === LEARNING));
  await writeFile(join(f.root, "artifacts/archive.bak"), "original archive");
  await assert.rejects(measureLearningArtifacts(f.input("after")), /completed delivery/);
  const stop = await runHook({ ...binding, hook_event_name: "Stop" });
  assert.equal(stop.blocked, false, stop.reason);
  assert.equal(stop.learningDelivery.status, "completed");
  const measured = await measureLearningArtifacts(f.input("after"));
  assert.equal(measured.receipt.metric.value, 1);
  assert.equal(measured.completionVerified, false);
  const delivered = stop.learningDelivery.receipts[0];
  const outcome = await consume(f.root, measured.receipt,
    { applicationId: delivered.applicationId, deliveryId: delivered.id });
  assert.equal(outcome.decision, "active", "one evaluator cannot validate the lesson alone");
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
});

test("a blocking artifact defect is measured and rolls back the active canary", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.root, "artifacts/result.txt"), "migrated archive");
  await consume(f.root, (await measureLearningArtifacts(f.input())).receipt);
  await consume(f.root, (await externalMeasurement(f, "before")).receipt);
  await evaluateLearning({ root: f.root });
  const projected = await application(f.root, LEARNING, "artifact-rollback", new Date(), "active", SCOPE);
  // Synthetic fault only; the original fixture bytes are restored below.
  await writeFile(join(f.root, "AGENTS.md"), "synthetic corrupted source");
  const measured = await measureLearningArtifacts(f.input("after"));
  assert.equal(measured.receipt.metric.blockingDefects, 1);
  const result = await consume(f.root, measured.receipt,
    { applicationId: projected.id, deliveryId: projected.deliveryId });
  assert.equal(result.decision, "rolled-back");
  assert.equal((await learningContext({ root: f.root, scope: SCOPE })).items.length, 0);
  await writeFile(join(f.root, "AGENTS.md"), f.source);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
});

test("interrupted, denied and racing artifact reads leave no successful measurement or source rewrite", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.root, "artifacts/archive.bak"), "original archive");
  const { learningPath } = await loadLearning(f.root);
  const originalLedger = await readFile(learningPath);
  const url = pathToFileURL(join(process.cwd(), "src/lib/learning-artifact-evaluator.js")).href;
  const script = `
    import fs from "node:fs/promises";
    import { writeSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.readFile;
    let injected = false;
    fs.readFile = async function(path, ...args) {
      if (!injected && String(path).endsWith("archive.bak")) {
        injected = true;
        if (process.env.FAULT === "crash") {
          writeSync(1, "artifact-read-crash");
          process.kill(process.pid, "SIGKILL");
        }
        if (process.env.FAULT === "permission") {
          throw Object.assign(new Error("synthetic artifact EACCES"), { code: "EACCES" });
        }
        const data = await original.call(this, path, ...args);
        await fs.writeFile(path, "synthetic racing artifact");
        return data;
      }
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const { measureLearningArtifacts } = await import(process.env.EVALUATOR_URL);
    try { await measureLearningArtifacts(JSON.parse(process.env.EVALUATOR_INPUT)); }
    catch (error) { writeSync(1, error.message); process.exitCode = 7; }
  `;
  for (const fault of ["crash", "permission", "race"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, AGENTSPINE_STATE_DIR: f.state, EVALUATOR_URL: url,
        EVALUATOR_INPUT: JSON.stringify(f.input()), FAULT: fault }
    });
    assert.equal(child.error, undefined, "counterprobe must execute, not time out");
    assert.notEqual(child.status, 0);
    assert.match(child.stdout, fault === "crash" ? /artifact-read-crash/
      : fault === "permission" ? /EACCES/ : /changed during/);
    assert.deepEqual(await readFile(learningPath), originalLedger);
    assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
  }
  // A later explicit invocation measures the current changed artifact, not a
  // fabricated successful result from the interrupted invocation.
  const restarted = await measureLearningArtifacts(f.input());
  assert.equal(restarted.receipt.metric.value, 1 / 3);
  assert.equal(restarted.automaticRetry, false);
});

test("artifact measurement reads only named targets and state, without directory discovery", async (t) => {
  const f = await setup(t);
  const script = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    fs.opendir = fs.readdir = async () => { throw new Error("forbidden directory discovery"); };
    syncBuiltinESMExports();
    const { measureLearningArtifacts } = await import(process.env.EVALUATOR_URL);
    const result = await measureLearningArtifacts(JSON.parse(process.env.EVALUATOR_INPUT));
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, AGENTSPINE_STATE_DIR: f.state,
      EVALUATOR_URL: pathToFileURL(join(process.cwd(), "src/lib/learning-artifact-evaluator.js")).href,
      EVALUATOR_INPUT: JSON.stringify(f.input()) }
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.receipt.metric.value, 1 / 3);
  assert.equal(result.diagnostics.broadScan, false);
  assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), f.source);
});
