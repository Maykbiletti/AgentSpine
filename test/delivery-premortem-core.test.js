import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closedPremortemForGoal,
  deliveryPremortemPath,
  inspectDeliveryPremortems,
  preparePremortemRequirement,
  recordDeliveryPremortem,
  recordPremortemWrite,
  verifyPremortemBeforeWrite,
  verifyPremortemStop
} from "../src/lib/delivery-premortem.js";
import { inspectPremortemLaneIndexes } from "../src/lib/delivery-premortem-index.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function reseal(value, key) {
  const material = { ...value };
  delete material[key];
  value[key] = hash(canonical(material));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-premortem-project-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-premortem-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  const source = "# Synthetic instructions\n\nRemain byte-exact.\n";
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
  });
  return { root, source };
}

function binding(suffix = "main", goal = false) {
  return {
    host: "codex",
    sessionId: `session:${suffix}`,
    projectId: "project:synthetic",
    entityId: "agent:synthetic",
    groupId: "group:synthetic",
    taskId: "task:synthetic",
    ...(goal ? {
      goalId: "goal:synthetic",
      goalStepId: "step:build",
      queueId: "queue:build",
      gatewayAttempt: 1,
      planDefinitionsDigest: hash("synthetic plan")
    } : {})
  };
}

function items(changed = "") {
  return [
    { category: "baseline-environment",
      failure: `this delivery fails because the baseline is stale${changed}`,
      check: "Compare the frozen snapshot digest before editing." },
    { category: "contract-tests",
      failure: "This delivery fails because the contract regresses",
      check: "Run the named synthetic regression suite after the final write." },
    { category: "delivery-path",
      failure: "THIS DELIVERY FAILS BECAUSE the artifact misses its destination",
      check: "Hash the delivered artifact at the configured exchange path." }
  ];
}

function closure(artifact, writeDigest, overrides = {}) {
  const lines = artifact.items.map((item) => {
    const status = overrides[item.category] || "PASS";
    return `- ${item.category} ${item.checkId}: ${status} — verified ${item.category}`;
  });
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`, ...lines].join("\n");
}

test("a verified missing premortem blocks, while a blocked attempt is not a write", async (t) => {
  const { root, source } = await fixture(t);
  const lane = binding("missing");
  const prepared = await preparePremortemRequirement({ root, binding: lane,
    now: "2034-01-01T00:00:00.000Z" });
  assert.equal(prepared.blocked, false);
  assert.match(prepared.requirementId,
    /^premortem-requirement:[a-f0-9]{64}:[a-f0-9]{64}$/);
  const missing = await verifyPremortemBeforeWrite({ root, binding: lane });
  assert.equal(missing.blocked, true);
  assert.match(missing.reason, new RegExp(prepared.requirementId));

  const incomplete = items();
  incomplete[0].failure = "this delivery fails because ";
  assert.equal((await recordDeliveryPremortem({ root,
    requirementId: prepared.requirementId, items: incomplete })).status, "degraded");
  assert.equal((await verifyPremortemBeforeWrite({ root, binding: lane })).status, "missing");
  const recorded = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId,
    items: items(), now: "2034-01-01T00:00:01.000Z" });
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.artifact.items.every((item) => /^check-[a-f0-9]{20}$/.test(item.checkId)), true);
  assert.equal((await verifyPremortemBeforeWrite({ root, binding: lane })).blocked, false);
  const falsePositive = await verifyPremortemStop({ root, binding: lane,
    message: "No delivery was written.", hasWrite: true });
  assert.equal(falsePositive.status, "no-write", "an unrelated write hint cannot block this exact lane");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("non-goal gateway deliveries bind an exact queue attempt", async (t) => {
  const { root } = await fixture(t);
  const lane = { ...binding("gateway-task"), queueId: "queue:task", gatewayAttempt: 3 };
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  assert.equal(prepared.status, "required");
  const nextAttempt = await preparePremortemRequirement({ root,
    binding: { ...lane, gatewayAttempt: 4 } });
  assert.notEqual(nextAttempt.requirementId, prepared.requirementId);
  const unbound = await preparePremortemRequirement({ root,
    binding: { ...binding("unbound-attempt"), gatewayAttempt: 1 } });
  assert.equal(unbound.status, "degraded");
});

test("ordinary delivery scope follows its session within one project only", async (t) => {
  const { root } = await fixture(t);
  const firstScope = binding("scope-drift");
  const secondScope = { ...firstScope,
    entityId: "agent:other", groupId: "group:other", taskId: "task:other" };
  const prepared = await preparePremortemRequirement({ root, binding: firstScope });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: prepared.requirementId, items: items() });
  const write = await recordPremortemWrite({ root, binding: firstScope,
    input: { tool_use_id: "write:scope-a" }, success: true });
  const escaped = await verifyPremortemStop({ root, binding: secondScope,
    message: "Delivery complete without a closure." });
  assert.equal(escaped.status, "unchecked");
  assert.equal(escaped.blocked, true);
  const closed = await verifyPremortemStop({ root, binding: secondScope,
    message: closure(recorded.artifact, write.writeDigest) });
  assert.equal(closed.status, "closed");
  const otherProject = { ...secondScope, projectId: "project:other" };
  assert.equal((await verifyPremortemBeforeWrite({ root,
    binding: otherProject })).status, "missing");
  const isolated = await preparePremortemRequirement({ root, binding: otherProject });
  assert.notEqual(isolated.requirementId, prepared.requirementId);
});

test("three closed checks pass and produce a sealed goal attachment", async (t) => {
  const { root, source } = await fixture(t);
  const lane = binding("goal", true);
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  const recorded = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId, items: items() });
  const write = await recordPremortemWrite({ root, binding: lane,
    input: { tool_name: "apply_patch", tool_use_id: "write:goal" }, success: true });
  const cannotBypass = await verifyPremortemStop({ root, binding: lane,
    message: "No closure supplied.", hasWrite: false });
  assert.equal(cannotBypass.blocked, true, "an unrelated read-only hint cannot bypass an exact-lane write");
  const stopped = await verifyPremortemStop({ root, binding: lane,
    message: closure(recorded.artifact, write.writeDigest), hasWrite: true });
  assert.equal(stopped.status, "closed");
  assert.equal(stopped.outcomeReceiptAttachment.premortemDigest, recorded.digest);
  assert.equal(stopped.outcomeReceiptAttachment.planDefinitionsDigest, lane.planDefinitionsDigest);
  assert.equal(stopped.outcomeReceiptAttachment.gatewayAttempt, lane.gatewayAttempt);
  assert.equal(stopped.outcomeReceiptAttachment.laneDigest, prepared.laneDigest);
  assert.match(stopped.outcomeReceiptAttachment.sessionDigest, /^[a-f0-9]{64}$/);
  assert.match(stopped.outcomeReceiptAttachment.attachmentDigest, /^[a-f0-9]{64}$/);
  assert.equal("binding" in stopped.outcomeReceiptAttachment, false);
  assert.equal(JSON.stringify(stopped.outcomeReceiptAttachment).includes(lane.sessionId), false);
  const omitted = await verifyPremortemStop({ root, binding: lane,
    message: "A retry omitted the current closure block." });
  assert.equal(omitted.status, "unchecked");
  assert.equal(omitted.blocked, true);
  const changed = closure(recorded.artifact, write.writeDigest)
    .replace("verified contract-tests", "changed contract-tests result");
  assert.equal((await verifyPremortemStop({ root, binding: lane,
    message: changed })).status, "conflict");

  const goal = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId,
    gatewayAttempt: lane.gatewayAttempt });
  assert.equal(goal.status, "closed");
  assert.equal(goal.attachment.premortemDigest, recorded.digest);
  assert.equal((await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId,
    gatewayAttempt: lane.gatewayAttempt + 1 })).status, "unavailable");

  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: lane }));
  await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(
    join(stateDirectory, `${hash(`unrelated lane ${index}`)}.json`), "{}\n")));
  const stillExact = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId,
    gatewayAttempt: lane.gatewayAttempt });
  assert.equal(stillExact.status, "mismatch",
    "a finalized scope cannot certify closure while its bounded state scan is uncertain");
  assert.equal(stillExact.blocked, true);
  const inspected = await inspectDeliveryPremortems(root);
  assert.equal(inspected.errors.length > 0, true, "the separate audit scan remains bounded");
  assert.equal((await verifyPremortemStop({ root, binding: binding("read-only"),
    message: "A read-only answer.", hasWrite: false })).blocked, false);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("goal lookup blocks only an exact written queue without closure", async (t) => {
  const { root } = await fixture(t);
  const readOnly = { ...binding("goal-read", true), queueId: "queue:read-only" };
  await preparePremortemRequirement({ root, binding: readOnly });
  const readOnlyProof = await closedPremortemForGoal({ root, goalId: readOnly.goalId,
    goalStepId: readOnly.goalStepId, queueId: readOnly.queueId,
    gatewayAttempt: readOnly.gatewayAttempt });
  assert.equal(readOnlyProof.status, "read-only");
  assert.equal(readOnlyProof.bindings[0].groupId, readOnly.groupId);
  assert.match(readOnlyProof.bindings[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(readOnlyProof.bindings).includes(readOnly.sessionId), false);
  assert.equal((await closedPremortemForGoal({ root, goalId: readOnly.goalId,
    goalStepId: readOnly.goalStepId, queueId: "queue:unseen",
    gatewayAttempt: readOnly.gatewayAttempt })).status, "unavailable");

  const written = { ...binding("goal-written", true), queueId: "queue:written" };
  const prepared = await preparePremortemRequirement({ root, binding: written });
  await recordDeliveryPremortem({ root, requirementId: prepared.requirementId, items: items() });
  await recordPremortemWrite({ root, binding: written,
    input: { tool_name: "Write", tool_use_id: "write:goal-open" }, success: true });
  const missing = await closedPremortemForGoal({ root, goalId: written.goalId,
    goalStepId: written.goalStepId, queueId: written.queueId,
    gatewayAttempt: written.gatewayAttempt });
  assert.equal(missing.status, "missing");
  assert.equal(missing.blocked, true);
});

test("no exact premortem index evidence remains explicitly unavailable", async (t) => {
  const { root } = await fixture(t);
  const unseen = binding("unseen-goal", true);
  const unavailable = await closedPremortemForGoal({ root, goalId: unseen.goalId,
    goalStepId: unseen.goalStepId, queueId: "queue:no-evidence", gatewayAttempt: 9 });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.blocked, false);
  assert.equal(unavailable.attachment, null);
});

test("a sealed index pointer without its lane state fails closed", async (t) => {
  const { root } = await fixture(t);
  const unseen = binding("dangling-goal", true);
  const prepared = await preparePremortemRequirement({ root, binding: unseen });
  await unlink(await deliveryPremortemPath({ root, binding: unseen }));
  const dangling = await closedPremortemForGoal({ root, goalId: unseen.goalId,
    goalStepId: unseen.goalStepId, queueId: unseen.queueId,
    gatewayAttempt: unseen.gatewayAttempt });
  assert.equal(dangling.status, "mismatch");
  assert.equal(dangling.blocked, true);
  assert.match(prepared.requirementId, /^premortem-requirement:/);
});

test("a written lane whose exact index was lost is reconciled without bypassing closure", async (t) => {
  const { root } = await fixture(t);
  const lane = { ...binding("orphan-written", true), queueId: "queue:orphan" };
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: prepared.requirementId, items: items() });
  const write = await recordPremortemWrite({ root, binding: lane,
    input: { tool_use_id: "write:orphan" }, success: true });
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding: lane }));
  const index = await inspectPremortemLaneIndexes(stateDirectory);
  await unlink(index.paths[0]);
  const orphan = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId, gatewayAttempt: lane.gatewayAttempt });
  assert.equal(orphan.status, "missing");
  assert.equal(orphan.blocked, true);
  assert.equal((await inspectPremortemLaneIndexes(stateDirectory)).pointers.length, 1);
  assert.equal((await verifyPremortemStop({ root, binding: lane,
    message: closure(recorded.artifact, write.writeDigest) })).status, "closed");
});

test("a later write invalidates closure until checks bind the latest write", async (t) => {
  const { root } = await fixture(t);
  const lane = { ...binding("goal-rewrite", true), queueId: "queue:rewrite" };
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  const recorded = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId, items: items() });
  const first = await recordPremortemWrite({ root, binding: lane,
    input: { tool_name: "Edit", tool_use_id: "write:first" }, success: true });
  const oldMessage = closure(recorded.artifact, first.writeDigest);
  assert.equal((await verifyPremortemStop({ root, binding: lane, message: oldMessage })).blocked, false);

  const second = await recordPremortemWrite({ root, binding: lane,
    input: { tool_name: "Edit", tool_use_id: "write:second" }, success: true });
  assert.notEqual(second.writeDigest, first.writeDigest);
  const missing = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId,
    gatewayAttempt: lane.gatewayAttempt });
  assert.equal(missing.status, "missing");
  assert.equal((await verifyPremortemStop({ root, binding: lane, message: oldMessage })).blocked, true);

  const refreshed = await verifyPremortemStop({ root, binding: lane,
    message: closure(recorded.artifact, second.writeDigest) });
  assert.equal(refreshed.blocked, false);
  assert.equal(refreshed.closure.lastWriteDigest, second.writeDigest);
  const closed = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId,
    gatewayAttempt: lane.gatewayAttempt });
  assert.equal(closed.attachment.lastWriteDigest, second.writeDigest);
  const state = (await inspectDeliveryPremortems(root)).states[0];
  assert.equal(state.firstWrite.digest, first.writeDigest);
  assert.equal(state.lastWrite.digest, second.writeDigest);
});

test("gateway attempts isolate retries and finalized attempts reject late competitors", async (t) => {
  const { root } = await fixture(t);
  const firstLane = { ...binding("attempt-one", true), queueId: "queue:retry", gatewayAttempt: 1 };
  const firstPrepared = await preparePremortemRequirement({ root, binding: firstLane });
  await recordDeliveryPremortem({ root, requirementId: firstPrepared.requirementId, items: items() });
  await recordPremortemWrite({ root, binding: firstLane,
    input: { tool_use_id: "write:attempt-one" }, success: true });

  const secondLane = { ...binding("attempt-two", true), queueId: "queue:retry", gatewayAttempt: 2 };
  const secondPrepared = await preparePremortemRequirement({ root, binding: secondLane });
  const secondArtifact = await recordDeliveryPremortem({ root,
    requirementId: secondPrepared.requirementId, items: items() });
  const secondWrite = await recordPremortemWrite({ root, binding: secondLane,
    input: { tool_use_id: "write:attempt-two" }, success: true });
  await verifyPremortemStop({ root, binding: secondLane,
    message: closure(secondArtifact.artifact, secondWrite.writeDigest) });
  assert.equal((await closedPremortemForGoal({ root, goalId: secondLane.goalId,
    goalStepId: secondLane.goalStepId, queueId: secondLane.queueId,
    gatewayAttempt: 2 })).status, "closed");
  assert.equal((await closedPremortemForGoal({ root, goalId: firstLane.goalId,
    goalStepId: firstLane.goalStepId, queueId: firstLane.queueId,
    gatewayAttempt: 1 })).status, "missing");

  const competing = { ...binding("attempt-two-competing", true),
    queueId: "queue:retry", gatewayAttempt: 2 };
  const competingPrepared = await preparePremortemRequirement({ root, binding: competing });
  assert.equal(competingPrepared.status, "finalized");
  assert.equal(competingPrepared.blocked, true);
  const active = await inspectDeliveryPremortems(root, { includeHistory: false });
  assert.equal(active.states.some((state) => state.binding.sessionId === competing.sessionId), false);
  assert.deepEqual(active.errors, []);
  const stillClosed = await closedPremortemForGoal({ root, goalId: competing.goalId,
    goalStepId: competing.goalStepId, queueId: competing.queueId, gatewayAttempt: 2 });
  assert.equal(stillClosed.status, "closed");
  assert.equal(stillClosed.blocked, false);
});

test("a premortem recorded after a successful write remains blocked", async (t) => {
  const { root } = await fixture(t);
  const lane = binding("late");
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  const write = await recordPremortemWrite({ root, binding: lane,
    input: { tool_name: "Write", tool_use_id: "write:late" }, success: true });
  const late = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId, items: items() });
  assert.equal(late.status, "late");
  assert.equal(late.blocked, true);
  assert.equal((await verifyPremortemBeforeWrite({ root, binding: lane })).status, "late");
  assert.equal((await verifyPremortemStop({ root, binding: lane,
    message: closure(late.artifact, write.writeDigest), hasWrite: true })).blocked, true);
});

test("registration is concurrent-idempotent and a changed artifact is rejected without poisoning", async (t) => {
  const { root } = await fixture(t);
  const lane = binding("parallel");
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  const calls = await Promise.all(Array.from({ length: 6 }, () => recordDeliveryPremortem({
    root, requirementId: prepared.requirementId, items: items(), now: "2034-02-01T00:00:00.000Z"
  })));
  assert.equal(calls.filter((entry) => entry.status === "recorded").length, 1);
  assert.equal(calls.filter((entry) => entry.status === "duplicate").length, 5);
  assert.equal(new Set(calls.map((entry) => entry.digest)).size, 1);

  const conflict = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId,
    items: items(" after drift") });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.blocked, true);
  assert.equal((await verifyPremortemBeforeWrite({ root, binding: lane })).status, "verified");
});

test("a conflicting registration after closure preserves the exact closed goal attempt", async (t) => {
  const { root } = await fixture(t);
  const lane = binding("closed-then-conflicted", true);
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: prepared.requirementId, items: items() });
  const write = await recordPremortemWrite({ root, binding: lane,
    input: { tool_use_id: "write:before-conflict" }, success: true });
  assert.equal((await verifyPremortemStop({ root, binding: lane,
    message: closure(recorded.artifact, write.writeDigest) })).status, "closed");
  assert.equal((await recordDeliveryPremortem({ root,
    requirementId: prepared.requirementId, items: items(" after closure") })).status, "conflict");
  const lookup = await closedPremortemForGoal({ root, goalId: lane.goalId,
    goalStepId: lane.goalStepId, queueId: lane.queueId,
    gatewayAttempt: lane.gatewayAttempt });
  assert.equal(lookup.status, "closed");
  assert.equal(lookup.blocked, false);
  assert.equal(lookup.attachment.premortemDigest, recorded.digest);
});

test("secret-shaped premortem text and closure results are never persisted", async (t) => {
  const { root } = await fixture(t);
  const secret = "token=syntheticcredential123456789";
  const registrationLane = binding("secret-registration");
  const prepared = await preparePremortemRequirement({ root, binding: registrationLane });
  const unsafeItems = items();
  unsafeItems[0].failure = `this delivery fails because a fixture exposed ${secret}`;
  const rejected = await recordDeliveryPremortem({ root,
    requirementId: prepared.requirementId, items: unsafeItems });
  assert.equal(rejected.status, "unsafe");
  assert.equal(rejected.blocked, true);
  assert.equal(JSON.stringify(rejected).includes(secret), false);
  const registrationPath = await deliveryPremortemPath({ root, binding: registrationLane });
  assert.equal((await readFile(registrationPath, "utf8")).includes(secret), false);

  const closureLane = binding("secret-closure");
  const closureRequirement = await preparePremortemRequirement({ root, binding: closureLane });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: closureRequirement.requirementId, items: items() });
  const write = await recordPremortemWrite({ root, binding: closureLane,
    input: { tool_name: "Edit", tool_use_id: "write:secret-closure" }, success: true });
  const unsafeClosure = closure(recorded.artifact, write.writeDigest)
    .replace("verified contract-tests", `verified ${secret}`);
  const stopped = await verifyPremortemStop({ root, binding: closureLane,
    message: unsafeClosure });
  assert.equal(stopped.status, "unchecked");
  assert.deepEqual(stopped.unchecked, ["contract-tests"]);
  assert.equal(JSON.stringify(stopped).includes(secret), false);
  const closurePath = await deliveryPremortemPath({ root, binding: closureLane });
  assert.equal((await readFile(closurePath, "utf8")).includes(secret), false);
});

test("unchecked categories block", async (t) => {
  const { root } = await fixture(t);
  const lane = binding("tamper");
  const prepared = await preparePremortemRequirement({ root, binding: lane });
  const recorded = await recordDeliveryPremortem({ root, requirementId: prepared.requirementId, items: items() });
  const write = await recordPremortemWrite({ root, binding: lane,
    input: { tool_name: "Edit", tool_use_id: "write:tamper" }, success: true });
  const unchecked = await verifyPremortemStop({ root, binding: lane,
    message: closure(recorded.artifact, write.writeDigest,
      { "contract-tests": "PENDING" }), hasWrite: true });
  assert.equal(unchecked.blocked, true);
  assert.deepEqual(unchecked.unchecked, ["contract-tests"]);
});
