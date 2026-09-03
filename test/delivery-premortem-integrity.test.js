import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closedPremortemForGoal, deliveryPremortemPath,
  preparePremortemRequirement, verifyPremortemBeforeWrite } from "../src/lib/delivery-premortem.js";
import { inspectPremortemLaneIndexes } from "../src/lib/delivery-premortem-index.js";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function reseal(value, key = "digest") {
  const material = { ...value };
  delete material[key];
  value[key] = createHash("sha256").update(canonical(material)).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-premortem-integrity-project-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-premortem-integrity-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  await writeFile(join(root, "AGENTS.md"), "# Synthetic integrity fixture\n");
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([rm(root, { recursive: true, force: true }),
      rm(state, { recursive: true, force: true })]);
  });
  return root;
}

function binding(suffix, goal = false) {
  return { host: "codex", sessionId: `session:${suffix}`, projectId: "project:synthetic",
    entityId: "agent:synthetic", groupId: "group:synthetic", taskId: null,
    ...(goal ? { goalId: "goal:synthetic", goalStepId: "step:integrity",
      queueId: `queue:${suffix}`, gatewayAttempt: 1,
      planDefinitionsDigest: createHash("sha256").update("synthetic plan").digest("hex") } : {}) };
}

test("well-formed state binding tamper blocks while malformed JSON fails open", async (t) => {
  const root = await fixture(t);
  const lane = binding("state-tamper");
  await preparePremortemRequirement({ root, binding: lane });
  const path = await deliveryPremortemPath({ root, binding: lane });
  const state = JSON.parse(await readFile(path, "utf8"));
  state.binding.projectId = "project:tampered";
  reseal(state, "integrityDigest");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  const mismatch = await verifyPremortemBeforeWrite({ root, binding: lane });
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.blocked, true);
  await writeFile(path, "{malformed-json\n");
  const degraded = await verifyPremortemBeforeWrite({ root, binding: lane });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.blocked, false);
});

test("oversized persisted state is a verified mismatch", async (t) => {
  const root = await fixture(t);
  const lane = binding("state-oversize");
  await preparePremortemRequirement({ root, binding: lane });
  const path = await deliveryPremortemPath({ root, binding: lane });
  const text = await readFile(path, "utf8");
  await writeFile(path, `${text}${" ".repeat(64 * 1024)}\n`);
  const mismatch = await verifyPremortemBeforeWrite({ root, binding: lane });
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.blocked, true);
});

test("pointer mismatch and oversize block while malformed JSON fails open", async (t) => {
  const root = await fixture(t);
  const lane = binding("pointer-tamper", true);
  await preparePremortemRequirement({ root, binding: lane });
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: lane }));
  let inspected = await inspectPremortemLaneIndexes(stateDirectory);
  const path = inspected.paths[0];
  const pointer = JSON.parse(await readFile(path, "utf8"));
  pointer.gatewayAttempt = 2;
  reseal(pointer);
  await writeFile(path, `${JSON.stringify(pointer, null, 2)}\n`);
  let reviewed = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId, gatewayAttempt: lane.gatewayAttempt });
  assert.equal(reviewed.status, "mismatch");
  assert.equal(reviewed.blocked, true);
  inspected = await inspectPremortemLaneIndexes(stateDirectory);
  assert.deepEqual(inspected.tamperedPointers, inspected.paths);
  await writeFile(path, "{malformed-json\n");
  reviewed = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId, gatewayAttempt: lane.gatewayAttempt });
  assert.equal(reviewed.status, "degraded");
  assert.equal(reviewed.blocked, false);
  await writeFile(path, " ".repeat(8 * 1024 + 1));
  reviewed = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId, gatewayAttempt: lane.gatewayAttempt });
  assert.equal(reviewed.status, "mismatch");
  assert.equal(reviewed.blocked, true);
});

test("corrupt ordinary history cannot obscure absent exact goal evidence", async (t) => {
  const root = await fixture(t);
  const ordinary = binding("history-noise");
  await preparePremortemRequirement({ root, binding: ordinary });
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: ordinary }));
  const historyDirectory = join(dirname(stateDirectory), "delivery-premortem-history");
  await mkdir(historyDirectory, { recursive: true });
  await writeFile(join(historyDirectory, `${"a".repeat(64)}.json`), "{malformed-json\n");
  const lane = binding("unseen-with-history-noise", true);
  const reviewed = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId, gatewayAttempt: lane.gatewayAttempt });
  assert.equal(reviewed.status, "unavailable");
  assert.equal(reviewed.blocked, false);
});
