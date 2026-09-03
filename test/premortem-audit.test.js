import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAudit } from "../src/lib/audit.js";
import {
  closedPremortemForGoal,
  deliveryPremortemPath,
  finalizeReadOnlyPremortemForGoal,
  preparePremortemRequirement,
  recordDeliveryPremortem,
  recordPremortemWrite,
  verifyPremortemStop
} from "../src/lib/delivery-premortem.js";
import { inspectPremortemLaneIndexes } from "../src/lib/delivery-premortem-index.js";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function reseal(value) {
  const material = { ...value };
  delete material.digest;
  return { ...material, digest: createHash("sha256").update(canonical(material)).digest("hex") };
}

async function fixture(t, suffix) {
  const root = await mkdtemp(join(tmpdir(), `agentspine-premortem-audit-${suffix}-`));
  const state = await mkdtemp(join(tmpdir(), `agentspine-premortem-audit-state-${suffix}-`));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  const source = "# Synthetic rules\n\nRemain byte-exact.\n";
  await writeFile(join(root, "AGENTS.md"), source, "utf8");
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(state, { recursive: true, force: true })
    ]);
  });
  return { root, source };
}

const binding = {
  host: "codex",
  sessionId: "session:audit",
  projectId: "project:synthetic",
  entityId: "agent:synthetic",
  groupId: "group:synthetic"
};

const goalBinding = {
  ...binding,
  sessionId: "session:audit-goal",
  goalId: "goal:synthetic",
  goalStepId: "step:delivery",
  queueId: "queue:delivery",
  gatewayAttempt: 2,
  planDefinitionsDigest: "a".repeat(64)
};

const items = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline is stale",
    check: "Compare the frozen baseline digest before editing." },
  { category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regresses",
    check: "Run the named synthetic regression suite." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact misses its destination",
    check: "Hash the artifact at the configured exchange path." }
];

async function finalizedGoalIndex(root) {
  const requirement = await preparePremortemRequirement({ root, binding: goalBinding });
  const artifact = await recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items });
  const write = await recordPremortemWrite({ root, binding: goalBinding,
    input: { tool_use_id: "write:audit-finalized" } });
  const checks = artifact.artifact.items.map((item) =>
    `- ${item.category} ${item.checkId}: PASS — verified ${item.category}`);
  await verifyPremortemStop({ root, binding: goalBinding, message: [
    `Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${write.writeDigest}`,
    ...checks
  ].join("\n") });
  await closedPremortemForGoal({ root, goalId: goalBinding.goalId,
    goalStepId: goalBinding.goalStepId, queueId: goalBinding.queueId,
    gatewayAttempt: goalBinding.gatewayAttempt });
  const statePath = await deliveryPremortemPath({ root, binding: goalBinding });
  return inspectPremortemLaneIndexes(dirname(statePath));
}

test("audit includes sealed context-only premortem artifacts without changing ten gates", async (t) => {
  const { root, source } = await fixture(t, "healthy");
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items });

  const result = await runAudit(root);
  assert.equal(result.total, 10);
  assert.equal(result.ok, true);
  assert.equal(result.gates.find((gate) => gate.name === "State isolation").ok, true);
  assert.equal(result.gates.find((gate) => gate.name === "Authority boundary").ok, true);
  assert.equal(result.premortemDiagnostics.states, 1);
  assert.equal(result.premortemDiagnostics.artifacts, 1);
  assert.equal(result.premortemDiagnostics.errors.length, 0);
  assert.equal(result.premortemDiagnostics.authority, "context-only");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("audit reports a malformed premortem state without overwriting it", async (t) => {
  const { root, source } = await fixture(t, "malformed");
  await preparePremortemRequirement({ root, binding });
  const path = await deliveryPremortemPath({ root, binding });
  const malformed = "{\"schema\":\"wrong\"}\n";
  await writeFile(path, malformed, "utf8");

  const result = await runAudit(root);
  assert.equal(result.total, 10);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(result.premortemDiagnostics.states, 0);
  assert.equal(result.premortemDiagnostics.errors.length, 1);
  assert.equal(await readFile(path, "utf8"), malformed);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("audit rejects a corrupt enforcement index pointer without changing sources", async (t) => {
  const { root, source } = await fixture(t, "index-corrupt");
  await preparePremortemRequirement({ root, binding: goalBinding });
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: goalBinding }));
  const indexed = await inspectPremortemLaneIndexes(stateDirectory);
  assert.equal(indexed.paths.length, 1);
  const pointerPath = indexed.paths[0];
  const corrupt = "{\"schema\":\"agentspine.delivery-premortem-index/v1\"}\n";
  await writeFile(pointerPath, corrupt, "utf8");

  const result = await runAudit(root);
  assert.equal(result.total, 10);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(result.premortemDiagnostics.index.errors.length, 1);
  assert.deepEqual(result.premortemDiagnostics.index.tamperedPointers, [pointerPath]);
  assert.equal(await readFile(pointerPath, "utf8"), corrupt);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("audit rejects a sealed index pointer whose state is missing", async (t) => {
  const { root, source } = await fixture(t, "index-dangling");
  await preparePremortemRequirement({ root, binding: goalBinding });
  const statePath = await deliveryPremortemPath({ root, binding: goalBinding });
  const indexed = await inspectPremortemLaneIndexes(dirname(statePath));
  assert.equal(indexed.pointers.length, 1);
  await unlink(statePath);

  const result = await runAudit(root);
  assert.equal(result.total, 10);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.deepEqual(result.premortemDiagnostics.index.crossReferenceErrors,
    [{ laneDigest: indexed.pointers[0].laneDigest,
      reason: "premortem index pointer has no state" }]);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("audit rejects a goal premortem state whose index pointer is missing", async (t) => {
  const { root, source } = await fixture(t, "index-missing");
  await preparePremortemRequirement({ root, binding: goalBinding });
  const statePath = await deliveryPremortemPath({ root, binding: goalBinding });
  const indexed = await inspectPremortemLaneIndexes(dirname(statePath));
  assert.equal(indexed.paths.length, 1);
  await unlink(indexed.paths[0]);

  const result = await runAudit(root);
  assert.equal(result.total, 10);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.deepEqual(result.premortemDiagnostics.index.crossReferenceErrors,
    [{ laneDigest: indexed.pointers[0].laneDigest,
      reason: "goal premortem state has no index pointer" }]);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("audit rejects tampered, malformed, or missing goal-scope finalization evidence", async (t) => {
  const { root } = await fixture(t, "finalization-integrity");
  const indexed = await finalizedGoalIndex(root);
  assert.equal(indexed.finalizations.length, 1);
  const finalizationPath = indexed.paths.find((path) => path.endsWith("finalized.json"));
  await writeFile(finalizationPath,
    "{\"schema\":\"agentspine.delivery-premortem-index-finalization/v1\"}\n");
  let result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.premortemDiagnostics.index.tamperedFinalizations,
    [finalizationPath]);
  await writeFile(finalizationPath, "{not-json\n");
  result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.premortemDiagnostics.index.errors.length > 0, true);
  await unlink(finalizationPath);
  result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.premortemDiagnostics.index.crossReferenceErrors.some((finding) =>
    finding.reason === "consumed goal premortem state has no scope finalization"), true);
});

test("audit rejects resealed semantic changes and orphaned closed finalizations", async (t) => {
  const { root } = await fixture(t, "finalization-semantics");
  const indexed = await finalizedGoalIndex(root);
  const finalizationPath = indexed.paths.find((path) => path.endsWith("finalized.json"));
  const pointerPath = indexed.paths.find((path) => path !== finalizationPath);
  const original = JSON.parse(await readFile(finalizationPath, "utf8"));
  for (const [field, value, reason] of [
    ["pointerDigest", "b".repeat(64), "wrong pointer digest"],
    ["attachmentDigest", "c".repeat(64), "wrong attachment digest"],
    ["host", "claude", "wrong binding evidence"],
    ["taskId", "task:forged", "wrong binding evidence"]
  ]) {
    await writeFile(finalizationPath, `${JSON.stringify(reseal({ ...original, [field]: value }), null, 2)}\n`);
    const result = await runAudit(root);
    assert.equal(result.ok, false);
    assert.equal(result.premortemDiagnostics.index.crossReferenceErrors.some((finding) =>
      finding.reason.includes(reason)), true, field);
  }
  await writeFile(finalizationPath, `${JSON.stringify(original, null, 2)}\n`);
  await unlink(pointerPath);
  await unlink(await deliveryPremortemPath({ root, binding: goalBinding }));
  const orphaned = await runAudit(root);
  assert.equal(orphaned.premortemDiagnostics.index.crossReferenceErrors.some((finding) =>
    finding.reason === "closed premortem finalization is orphaned"), true);
});

test("audit rejects read-only finalization that retains an exact state or pointer", async (t) => {
  const { root } = await fixture(t, "read-only-finalization-semantics");
  const fenced = await finalizeReadOnlyPremortemForGoal({ root,
    goalId: goalBinding.goalId, goalStepId: goalBinding.goalStepId,
    queueId: goalBinding.queueId, gatewayAttempt: goalBinding.gatewayAttempt,
    dispositionDigest: "d".repeat(64), context: goalBinding, bindingSummaryDigests: [] });
  assert.equal(fenced.status, "finalized");
  const statePath = await deliveryPremortemPath({ root, binding: goalBinding });
  let indexed = await inspectPremortemLaneIndexes(dirname(statePath));
  const finalizationPath = indexed.paths.find((path) => path.endsWith("finalized.json"));
  const finalizationBytes = await readFile(finalizationPath, "utf8");
  await unlink(finalizationPath);
  assert.equal((await preparePremortemRequirement({ root, binding: goalBinding })).status, "required");
  await writeFile(finalizationPath, finalizationBytes);
  indexed = await inspectPremortemLaneIndexes(dirname(statePath));
  assert.equal(indexed.pointers.length, 1);
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.premortemDiagnostics.index.crossReferenceErrors.some((finding) =>
    finding.reason === "read-only premortem finalization retains state or index evidence"), true);
});

test("bounded index truncation is diagnostic and does not fail the audit", async (t) => {
  const { root, source } = await fixture(t, "index-bounded");
  await preparePremortemRequirement({ root, binding: goalBinding });
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: goalBinding }));
  const indexed = await inspectPremortemLaneIndexes(stateDirectory);
  await Promise.all(Array.from({ length: 257 }, (_, index) => mkdir(join(indexed.directory,
    index.toString(16).padStart(64, "0")), { recursive: true })));

  const result = await runAudit(root);
  assert.equal(result.total, 10);
  assert.equal(result.ok, true);
  assert.equal(result.premortemDiagnostics.index.errors.length, 0);
  assert.equal(result.premortemDiagnostics.index.truncations.length > 0, true);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});
