import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runAudit } from "../src/lib/audit.js";
import { withOwnedFileLock } from "../src/lib/owned-file-lock.js";
import {
  closedPremortemForGoal,
  deliveryPremortemPath,
  finalizeReadOnlyPremortemForGoal,
  inspectDeliveryPremortems,
  preparePremortemRequirement,
  recordDeliveryPremortem,
  recordPremortemWrite,
  verifyPremortemBeforeWrite,
  verifyPremortemStop
} from "../src/lib/delivery-premortem.js";
import { finalizePremortemScope,
  inspectPremortemLaneIndexes } from "../src/lib/delivery-premortem-index.js";
import { hasSecretShapedText } from "../src/lib/delivery-premortem-closure.js";
import { writePremortemFile } from "../src/lib/delivery-premortem-file.js";

const ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the frozen synthetic baseline." },
  { category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regressed",
    check: "Run the synthetic contract suite." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact went elsewhere",
    check: "Hash the synthetic artifact at its destination." }
];

async function fixture(t, suffix, goal = false) {
  const root = await mkdtemp(join(tmpdir(), `agentspine-premortem-security-${suffix}-`));
  const state = await mkdtemp(join(tmpdir(), `agentspine-premortem-security-state-${suffix}-`));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([rm(root, { recursive: true, force: true }),
      rm(state, { recursive: true, force: true })]);
  });
  return { root, binding: { host: "codex", sessionId: `session:${suffix}`,
    projectId: "project:synthetic", entityId: "agent:synthetic",
    ...(goal ? { goalId: "goal:synthetic", goalStepId: "step:synthetic",
      queueId: `queue:${suffix}`, gatewayAttempt: 1,
      planDefinitionsDigest: "a".repeat(64) } : {}) } };
}

function closure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — verified ${item.category}`)].join("\n");
}

test("secret-shaped context recognizes synthetic English and German labels", () => {
  assert.equal(hasSecretShapedText("password=syntheticcredential123"), true);
  assert.equal(hasSecretShapedText("passwort=syntheticcredential123"), true);
  assert.equal(hasSecretShapedText("geheimnis=syntheticcredential123"), true);
});

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("one write ID is idempotent only for the same known tool input", async (t) => {
  const { root, binding } = await fixture(t, "write-input");
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items: ITEMS });
  const firstInput = { tool_use_id: "write:same-id",
    tool_input: { file_path: "synthetic.js", content: "first" } };
  const first = await recordPremortemWrite({ root, binding, input: firstInput, phase: "intent" });
  const duplicate = await recordPremortemWrite({ root, binding, input: firstInput, phase: "intent" });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.writeDigest, first.writeDigest);
  const conflict = await recordPremortemWrite({ root, binding, phase: "intent",
    input: { ...firstInput, tool_input: { ...firstInput.tool_input, content: "second" } } });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.blocked, true);
  assert.equal((await verifyPremortemBeforeWrite({ root, binding })).status, "conflict");
});

test("a Post-only unknown input cannot absorb a reordered known Pre input", async (t) => {
  const { root, binding } = await fixture(t, "write-input-order");
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items: ITEMS });
  const post = await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:reordered" }, phase: "post" });
  assert.equal(post.status, "write-recorded");
  const pre = await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:reordered", tool_input: { file_path: "synthetic.js" } },
    phase: "intent" });
  assert.equal(pre.status, "conflict");
  assert.equal(pre.blocked, true);
  assert.equal((await verifyPremortemStop({ root, binding,
    message: "Cannot close ambiguity." })).status, "conflict");
});

test("event truncation cannot hide an old write ID input conflict", async (t) => {
  const { root, binding } = await fixture(t, "write-ledger");
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items: ITEMS });
  for (let index = 0; index < 56; index += 1) {
    const result = await recordPremortemWrite({ root, binding, phase: "intent",
      input: { tool_use_id: `write:ledger-${index}`,
        tool_input: { file_path: "synthetic.js", content: `version ${index}` } } });
    assert.equal(result.status, "write-recorded");
  }
  const [state] = (await inspectDeliveryPremortems(root)).states;
  assert.equal(state.events.length, 48);
  assert.ok(state.events[0].sequence > 3, "the earliest write event was evicted from the ring");
  const replay = await recordPremortemWrite({ root, binding, phase: "intent",
    input: { tool_use_id: "write:ledger-0",
      tool_input: { file_path: "synthetic.js", content: "changed after truncation" } } });
  assert.equal(replay.status, "conflict");
  assert.equal(replay.blocked, true);
});

test("closure evidence must be one contiguous terminal block", async (t) => {
  const { root, binding } = await fixture(t, "terminal-closure");
  const requirement = await preparePremortemRequirement({ root, binding });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  const write = await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:terminal-closure" } });
  const valid = closure(recorded.artifact, write.writeDigest);
  const trailing = await verifyPremortemStop({ root, binding,
    message: `${valid}\nTrailing prose.` });
  assert.equal(trailing.status, "unchecked");
  const lines = valid.split("\n");
  lines.splice(3, 0, "Interleaved prose.");
  const interleaved = await verifyPremortemStop({ root, binding, message: lines.join("\n") });
  assert.equal(interleaved.status, "unchecked");
  assert.equal((await verifyPremortemStop({ root, binding, message: valid })).status, "closed");
});

test("write intent revalidates after a concurrent read-only Stop deletes the lane", async (t) => {
  const { root, binding } = await fixture(t, "intent-delete-race");
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items: ITEMS });
  assert.equal((await verifyPremortemBeforeWrite({ root, binding })).status, "verified");
  assert.equal((await verifyPremortemStop({ root, binding, message: "Read-only." })).status, "no-write");
  const intent = await recordPremortemWrite({ root, binding, phase: "intent",
    input: { tool_use_id: "write:after-delete" } });
  assert.equal(intent.status, "missing");
  assert.equal(intent.blocked, true);
});

test("write intent keeps the first valid registration after a conflicting retry", async (t) => {
  const { root, binding } = await fixture(t, "intent-conflict-race");
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items: ITEMS });
  assert.equal((await verifyPremortemBeforeWrite({ root, binding })).status, "verified");
  assert.equal((await recordDeliveryPremortem({ root, requirementId: requirement.requirementId,
    items: ITEMS.map((item, index) => index ? item
      : { ...item, failure: `${item.failure} unexpectedly` }) })).status, "conflict");
  const intent = await recordPremortemWrite({ root, binding, phase: "intent",
    input: { tool_use_id: "write:after-conflict" } });
  assert.equal(intent.status, "write-recorded");
  assert.equal(intent.blocked, false);
});

test("a lane owner lost while waiting for the scope lock cannot replace state", async (t) => {
  const { root, binding } = await fixture(t, "stale-owner", true);
  const requirement = await preparePremortemRequirement({ root, binding });
  const statePath = await deliveryPremortemPath({ root, binding });
  const before = await readFile(statePath, "utf8");
  const indexes = await inspectPremortemLaneIndexes(dirname(statePath));
  const scopeDirectory = indexes.directories[0];
  const scopeLock = join(dirname(scopeDirectory), `${basename(scopeDirectory)}.lock`);
  let releaseScope;
  let scopeReady;
  const ready = new Promise((resolve) => { scopeReady = resolve; });
  const held = withOwnedFileLock(scopeLock, async () => {
    scopeReady();
    await new Promise((resolve) => { releaseScope = resolve; });
  });
  await ready;
  const pending = recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  const laneLock = `${statePath}.lock`;
  await waitForFile(laneLock);
  await new Promise((resolve) => setTimeout(resolve, 75));
  await writeFile(laneLock, `${JSON.stringify({
    schema: "agentspine.owned-file-lock/v1", token: "synthetic-new-owner",
    acquiredAt: new Date().toISOString(), leaseMs: 15000,
    authority: "state-coordination-only"
  })}\n`);
  releaseScope();
  await held;
  const result = await pending;
  assert.equal(result.status, "degraded");
  assert.match(result.reason, /ownership was lost/);
  assert.equal(await readFile(statePath, "utf8"), before,
    "the stale owner must not commit its prepared artifact");
  await unlink(laneLock);
});

test("a scope owner lost while waiting for a pointer lock cannot replace state", async (t) => {
  const { root, binding } = await fixture(t, "stale-scope-owner", true);
  const requirement = await preparePremortemRequirement({ root, binding });
  const statePath = await deliveryPremortemPath({ root, binding });
  const before = await readFile(statePath, "utf8");
  const indexes = await inspectPremortemLaneIndexes(dirname(statePath));
  const pointerPath = indexes.paths.find((path) => /^[a-f0-9]{64}\.json$/.test(basename(path)));
  const scopeDirectory = dirname(pointerPath);
  const scopeLock = join(dirname(scopeDirectory), `${basename(scopeDirectory)}.lock`);
  let releasePointer;
  let pointerReady;
  const ready = new Promise((resolve) => { pointerReady = resolve; });
  const held = withOwnedFileLock(`${pointerPath}.lock`, async () => {
    pointerReady();
    await new Promise((resolve) => { releasePointer = resolve; });
  });
  await ready;
  const pending = recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  await waitForFile(scopeLock);
  await writeFile(scopeLock, `${JSON.stringify({
    schema: "agentspine.owned-file-lock/v1", token: "synthetic-new-scope-owner",
    acquiredAt: new Date().toISOString(), leaseMs: 15000,
    authority: "state-coordination-only"
  })}\n`);
  releasePointer();
  await held;
  const result = await pending;
  assert.equal(result.status, "degraded");
  assert.match(result.reason, /ownership was lost/);
  assert.equal(await readFile(statePath, "utf8"), before);
  await unlink(scopeLock);
});

test("a scope directory removed while registration waits is recreated atomically", async (t) => {
  const { root, binding } = await fixture(t, "scope-directory-aba", true);
  const requirement = await preparePremortemRequirement({ root, binding });
  const statePath = await deliveryPremortemPath({ root, binding });
  const indexes = await inspectPremortemLaneIndexes(dirname(statePath));
  const scopeDirectory = indexes.directories[0];
  const scopeLock = join(dirname(scopeDirectory), `${basename(scopeDirectory)}.lock`);
  let releaseScope;
  let scopeReady;
  const ready = new Promise((resolve) => { scopeReady = resolve; });
  const held = withOwnedFileLock(scopeLock, async () => {
    scopeReady();
    await new Promise((resolve) => { releaseScope = resolve; });
  });
  await ready;
  const pending = recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  await new Promise((resolve) => setTimeout(resolve, 75));
  await rm(scopeDirectory, { recursive: true, force: true });
  releaseScope();
  await held;
  assert.equal((await pending).status, "recorded");
  const restored = await inspectPremortemLaneIndexes(dirname(statePath));
  assert.equal(restored.pointers.length, 1);
  assert.deepEqual(restored.errors, []);
});

test("read-only finalization and a late lane registration cannot both win", async (t) => {
  const { root, binding } = await fixture(t, "read-only-finalize-race", true);
  const statePath = await deliveryPremortemPath({ root, binding });
  const stateDirectory = dirname(statePath);
  let releaseFinalizer;
  let finalizerReady;
  const ready = new Promise((resolve) => { finalizerReady = resolve; });
  const finalizing = finalizePremortemScope({ stateDirectory,
    goalId: binding.goalId, goalStepId: binding.goalStepId,
    queueId: binding.queueId, gatewayAttempt: binding.gatewayAttempt,
    status: "read-only", attachmentDigest: "d".repeat(64),
    context: { ...binding, groupId: null, taskId: null }, bindingSummaryDigests: [],
    commit: async () => {
      finalizerReady();
      await new Promise((resolve) => { releaseFinalizer = resolve; });
    } });
  await ready;
  const lateRegistration = preparePremortemRequirement({ root, binding });
  await waitForFile(`${statePath}.lock`);
  releaseFinalizer();
  const finalized = await finalizing;
  const rejected = await lateRegistration;
  assert.equal(finalized.status, "finalized");
  assert.equal(rejected.status, "finalized");
  assert.equal(rejected.blocked, true);
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  const retry = await closedPremortemForGoal({ root, goalId: binding.goalId,
    goalStepId: binding.goalStepId, queueId: binding.queueId,
    gatewayAttempt: binding.gatewayAttempt });
  assert.equal(retry.status, "read-only-finalized");
  assert.equal(retry.finalization.digest, finalized.finalization.digest);

  const writer = { ...binding, queueId: "queue:writer-wins" };
  await preparePremortemRequirement({ root, binding: writer });
  const conflict = await finalizePremortemScope({ stateDirectory,
    goalId: writer.goalId, goalStepId: writer.goalStepId,
    queueId: writer.queueId, gatewayAttempt: writer.gatewayAttempt,
    status: "read-only", attachmentDigest: "e".repeat(64),
    context: { ...writer, groupId: null, taskId: null }, bindingSummaryDigests: [] });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.blocked, true);
});

test("read-only finalization blocks a crashed written state without its pointer", async (t) => {
  const { root, binding } = await fixture(t, "read-only-orphan", true);
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  await recordPremortemWrite({ root, binding, phase: "intent",
    input: { tool_use_id: "write:read-only-orphan", tool_input: { path: "synthetic.js" } } });
  const statePath = await deliveryPremortemPath({ root, binding });
  const before = await inspectPremortemLaneIndexes(dirname(statePath));
  const pointerPath = before.paths.find((path) => /^[a-f0-9]{64}\.json$/.test(basename(path)));
  await unlink(pointerPath);
  const fenced = await finalizeReadOnlyPremortemForGoal({ root,
    goalId: binding.goalId, goalStepId: binding.goalStepId,
    queueId: binding.queueId, gatewayAttempt: binding.gatewayAttempt,
    dispositionDigest: "f".repeat(64), context: { ...binding, groupId: null, taskId: null },
    bindingSummaryDigests: [] });
  assert.equal(fenced.status, "mismatch");
  assert.equal(fenced.blocked, true);
  const after = await inspectPremortemLaneIndexes(dirname(statePath));
  assert.equal(after.finalizations.length, 0);
});

test("a post-rename stale writer invalidates an already finalized read-only scope", async (t) => {
  const { root, binding } = await fixture(t, "post-rename-stale-writer", true);
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items: ITEMS });
  await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:post-rename-stale-writer" } });
  const statePath = await deliveryPremortemPath({ root, binding });
  const snapshot = JSON.parse(await readFile(statePath, "utf8"));
  const stateDirectory = dirname(statePath);
  const pointerPath = (await inspectPremortemLaneIndexes(stateDirectory)).paths
    .find((path) => path.endsWith(`${requirement.laneDigest}.json`));
  await unlink(pointerPath);
  await unlink(statePath);
  const finalized = await finalizeReadOnlyPremortemForGoal({ root,
    goalId: binding.goalId, goalStepId: binding.goalStepId,
    queueId: binding.queueId, gatewayAttempt: binding.gatewayAttempt,
    dispositionDigest: "b".repeat(64), context: { ...binding, groupId: null, taskId: null },
    bindingSummaryDigests: [] });
  assert.equal(finalized.status, "finalized");

  let ownershipChecks = 0;
  await assert.rejects(writePremortemFile(statePath, snapshot, async () => {
    ownershipChecks += 1;
    if (ownershipChecks > 1) throw new Error("state lock ownership was lost; mutation aborted");
  }, 64 * 1024), /ownership was lost/i);
  assert.equal(ownershipChecks, 2, "the writer rechecks ownership after rename");
  assert.equal((await inspectDeliveryPremortems(root)).states[0].firstWrite !== null, true);

  const lookup = await closedPremortemForGoal({ root, goalId: binding.goalId,
    goalStepId: binding.goalStepId, queueId: binding.queueId,
    gatewayAttempt: binding.gatewayAttempt });
  assert.equal(lookup.status, "mismatch");
  assert.equal(lookup.blocked, true);
});

test("a consumed goal premortem survives reload and blocks later writes", async (t) => {
  const { root, binding } = await fixture(t, "consumed", true);
  const requirement = await preparePremortemRequirement({ root, binding });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  const write = await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:consumed", tool_input: { file_path: "synthetic.js" } } });
  assert.equal((await verifyPremortemStop({ root, binding,
    message: closure(recorded.artifact, write.writeDigest) })).status, "closed");
  assert.equal((await closedPremortemForGoal({ root, goalId: binding.goalId,
    goalStepId: binding.goalStepId, queueId: binding.queueId,
    gatewayAttempt: binding.gatewayAttempt })).status, "closed");
  const verified = await verifyPremortemBeforeWrite({ root, binding });
  assert.equal(verified.status, "finalized");
  assert.equal(verified.blocked, true);
  assert.equal((await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:after-consumption" } })).status, "finalized");
  const competing = { ...binding, sessionId: "session:consumed-competitor" };
  const rejected = await preparePremortemRequirement({ root, binding: competing });
  assert.equal(rejected.status, "finalized");
  assert.equal(rejected.blocked, true);
  assert.equal((await inspectDeliveryPremortems(root)).states.length, 1,
    "a rejected post-finalization lane never reaches active state");
  assert.equal((await runAudit(root)).ok, true);
});

test("well-formed pointer tampering blocks exact lookup", async (t) => {
  const { root, binding } = await fixture(t, "pointer", true);
  await preparePremortemRequirement({ root, binding });
  const stateDirectory = dirname(await deliveryPremortemPath({ root, binding }));
  const indexed = await inspectPremortemLaneIndexes(stateDirectory);
  const pointer = JSON.parse(await readFile(indexed.paths[0], "utf8"));
  pointer.gatewayAttempt = 2;
  await writeFile(indexed.paths[0], `${JSON.stringify(pointer, null, 2)}\n`);
  const result = await closedPremortemForGoal({ root, goalId: binding.goalId,
    goalStepId: binding.goalStepId, queueId: binding.queueId,
    gatewayAttempt: binding.gatewayAttempt });
  assert.equal(result.status, "mismatch");
  assert.equal(result.blocked, true);
});

test("a prepared sibling session cannot become a second writer in one exact attempt", async (t) => {
  const first = await fixture(t, "competing", true);
  const secondBinding = { ...first.binding, sessionId: "session:competing-second" };
  const firstRequirement = await preparePremortemRequirement(first);
  const secondRequirement = await preparePremortemRequirement({ root: first.root,
    binding: secondBinding });
  const firstRecorded = await recordDeliveryPremortem({ root: first.root,
    requirementId: firstRequirement.requirementId, items: ITEMS });
  await recordDeliveryPremortem({ root: first.root,
    requirementId: secondRequirement.requirementId, items: ITEMS });
  const firstWrite = await recordPremortemWrite({ root: first.root, binding: first.binding,
    input: { tool_use_id: "write:competing-first" } });
  assert.equal((await verifyPremortemStop({ root: first.root, binding: first.binding,
    message: closure(firstRecorded.artifact, firstWrite.writeDigest) })).status, "closed");
  const secondWrite = await recordPremortemWrite({ root: first.root, binding: secondBinding,
    input: { tool_use_id: "write:competing-second" } });
  assert.equal(secondWrite.status, "mismatch");
  assert.equal(secondWrite.blocked, true);
  assert.match(secondWrite.reason, /different host session.*reclaim/is);
  const result = await closedPremortemForGoal({ root: first.root,
    goalId: first.binding.goalId, goalStepId: first.binding.goalStepId,
    queueId: first.binding.queueId, gatewayAttempt: first.binding.gatewayAttempt });
  assert.equal(result.status, "closed");
  assert.equal(result.blocked, false);
});

test("malformed JSON remains degraded fail-open at state boundaries", async (t) => {
  const ordinary = await fixture(t, "malformed-ordinary");
  await preparePremortemRequirement(ordinary);
  await writeFile(await deliveryPremortemPath(ordinary), "{not json\n");
  const before = await verifyPremortemBeforeWrite(ordinary);
  assert.equal(before.status, "degraded");
  assert.equal(before.blocked, false);
  const stop = await verifyPremortemStop({ ...ordinary, message: "Read-only." });
  assert.equal(stop.status, "degraded");
  assert.equal(stop.blocked, false);

  const goal = await fixture(t, "malformed-goal", true);
  await preparePremortemRequirement(goal);
  await writeFile(await deliveryPremortemPath(goal), "{not json\n");
  const lookup = await closedPremortemForGoal({ root: goal.root, goalId: goal.binding.goalId,
    goalStepId: goal.binding.goalStepId, queueId: goal.binding.queueId,
    gatewayAttempt: goal.binding.gatewayAttempt });
  assert.equal(lookup.status, "degraded");
  assert.equal(lookup.blocked, false);
});
