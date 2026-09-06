import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { targetSnapshot } from "./delivery-target.js";
import { loadLearning } from "./learning-storage.js";
import { digest, exactScope, normalizeScope, activeEvaluationBinding } from "./learning-scope-targets.js";
import { recordLearningMeasurement } from "./learning-measurements.js";

const SCHEMA = "agentspine.artifact-checks/v1";
const PROTOCOL = "agentspine.artifact-evaluator/v1:sha256-or-absent:two-pass:16-cases:2-mib-per-file";
const PROTOCOL_DIGEST = digest(PROTOCOL);
// One implementation is ONE principal, even under different aliases or paths.
const PRINCIPAL_DIGEST = digest({ implementation: PROTOCOL });
const METRIC = { name: "artifact-check-pass-rate", direction: "higher" };

export function artifactEvaluationPlan(spec) {
  if (!spec || spec.schema !== SCHEMA || Object.keys(spec).some((key) => !["schema", "checks"].includes(key))
    || !Array.isArray(spec.checks) || spec.checks.length < 1 || spec.checks.length > 16) {
    throw new Error("artifact evaluation requires a known schema and 1 to 16 explicit checks");
  }
  const seen = new Set();
  const checks = spec.checks.map((check) => {
    if (!check || Object.keys(check).some((key) => !["path", "sha256", "blocking"].includes(key))
      || typeof check.path !== "string" || check.path.length > 240
      || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(check.path)
      || check.path.split("/").some((part) => !part || part === "." || part === "..")
      || !(check.sha256 === null || /^[a-f0-9]{64}$/.test(check.sha256 || ""))
      || typeof check.blocking !== "boolean") {
      throw new Error("artifact checks require unique project-relative paths, SHA-256 or null, and explicit blocking flags");
    }
    const key = check.path.toLowerCase();
    if (seen.has(key)) throw new Error("artifact check paths must be unique across platforms");
    seen.add(key);
    return { path: check.path, sha256: check.sha256, blocking: check.blocking };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const normalized = { schema: SCHEMA, checks };
  return { spec: normalized, datasetDigest: digest(normalized), protocolDigest: PROTOCOL_DIGEST,
    principalDigest: PRINCIPAL_DIGEST, metric: { ...METRIC }, minCases: checks.length,
    authority: "context-only" };
}

// Local evaluator only. No shell, model scores, automatic registration, source
// discovery, outcome consumption, promotion or configuration changes.
export async function measureLearningArtifacts({ root = process.cwd(), spec, id, learningId, evaluationId,
  phase, scope, evaluatorId, runId, confirmLocalMeasurement = false } = {}) {
  if (confirmLocalMeasurement !== true) throw new Error("artifact measurement requires explicit local confirmation");
  const started = performance.now();
  const plan = artifactEvaluationPlan(spec);
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw new Error("artifact project root must be canonical and non-symbolic");
  const { learning } = await loadLearning(canonical);
  const evaluation = learning.evaluations.find((entry) => entry.id === evaluationId && entry.learningId === learningId);
  const binding = normalizeScope(scope);
  if (!evaluation || !exactScope(evaluation.scope, binding) || !activeEvaluationBinding(learning, evaluation)) {
    throw new Error("artifact evaluation requires an active exact-scope local contract");
  }
  if (evaluation.benchmark.datasetDigest !== plan.datasetDigest
    || evaluation.benchmark.protocolDigest !== plan.protocolDigest
    || evaluation.benchmark.minCases !== plan.minCases
    || evaluation.metric.name !== METRIC.name || evaluation.metric.direction !== METRIC.direction) {
    throw new Error("artifact checks or measurement protocol differ from the frozen evaluation");
  }
  if (!evaluation.evaluatorRoots.some((entry) => entry.evaluatorId === evaluatorId
    && entry.principalDigest === PRINCIPAL_DIGEST)) {
    throw new Error("artifact evaluator must use its single locally registered implementation principal");
  }
  const trial = evaluation.initialTrials?.[phase]?.find((entry) => entry.evaluatorId === evaluatorId);
  if (!trial || trial.runId !== runId) throw new Error("artifact measurement requires the precommitted initial trial");
  if (learning.measurements.some((entry) => entry.id === id
    || (entry.measurement.evaluatorId === evaluatorId && entry.measurement.runId === runId))) {
    throw new Error("artifact trial was already measured; it cannot be rerun or replaced");
  }
  const snapshots = [];
  for (const check of plan.spec.checks) {
    const snapshot = await targetSnapshot(canonical, check.path);
    if (snapshot.omitted) throw new Error("artifact exceeds the bounded measurement budget");
    snapshots.push(snapshot);
  }
  // Recheck the complete bounded cohort, not just each file during its own read.
  for (let index = 0; index < snapshots.length; index++) {
    const current = await targetSnapshot(canonical, plan.spec.checks[index].path);
    if (JSON.stringify(current) !== JSON.stringify(snapshots[index])) {
      throw new Error("artifact cohort changed during measurement");
    }
  }
  const checks = plan.spec.checks.map((check, index) => ({
    path: check.path, expectedDigest: check.sha256,
    observedDigest: snapshots[index].sha256, bytes: snapshots[index].bytes,
    passed: snapshots[index].sha256 === check.sha256, blocking: check.blocking
  }));
  const metric = { ...METRIC, value: checks.filter((check) => check.passed).length / checks.length,
    blockingDefects: checks.filter((check) => !check.passed && check.blocking).length };
  const measuredAt = new Date().toISOString();
  const report = { schema: "agentspine.artifact-measurement/v1", observationId: randomUUID(), evaluationId, learningId,
    scope: binding, evaluatorId, runId, phase, datasetDigest: plan.datasetDigest,
    protocolDigest: PROTOCOL_DIGEST, measuredAt, checks, metric, authority: "context-only" };
  const sourceDigest = digest(report);
  const recorded = await recordLearningMeasurement({ root: canonical, id, learningId, evaluationId, phase,
    scope: binding, metric, measurement: { kind: "objective", evaluatorId, runId, sourceDigest },
    coverage: { datasetDigest: plan.datasetDigest, caseCount: checks.length },
    measuredAt, confirmLocalMeasurement: true });
  return { ...recorded, report, sourceDigest,
    diagnostics: { elapsedMs: performance.now() - started,
      inspectedFiles: checks.length, inspectedBytes: snapshots.reduce((sum, item) => sum + item.bytes, 0) * 2,
      broadScan: false, commandsExecuted: 0 },
    completionVerified: false, automaticRetry: false, authority: "context-only" };
}
