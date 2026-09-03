import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { withOwnedFileLock } from "../src/lib/owned-file-lock.js";
import { finalizePremortemScope, lookupPremortemLaneIndex, premortemScopeDigest,
  registerPremortemLaneIndex } from "../src/lib/delivery-premortem-index.js";

function binding(sessionId) {
  return { host: "codex", sessionId, projectId: "project:transaction",
    entityId: "agent:transaction", groupId: "group:transaction", taskId: null,
    goalId: "goal:transaction", goalStepId: "step:transaction",
    queueId: "queue:transaction", gatewayAttempt: 1,
    planDefinitionsDigest: "a".repeat(64) };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-premortem-transaction-"));
  const stateDirectory = join(root, "delivery-premortem");
  await mkdir(stateDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDirectory };
}

function state(stateDirectory, suffix) {
  return { statePath: join(stateDirectory, `${suffix}.json`),
    state: { laneDigest: suffix.repeat(64), binding: binding(`session:${suffix}`) } };
}

function finalizationInput(stateDirectory, laneDigest, status, commit = null) {
  const context = binding("session:context");
  return { stateDirectory, goalId: context.goalId, goalStepId: context.goalStepId,
    queueId: context.queueId, gatewayAttempt: context.gatewayAttempt, status,
    laneDigest, attachmentDigest: "f".repeat(64), context,
    bindingSummaryDigests: [], commit };
}

test("closed consumption and its scope fence exclude a competing lane", async (t) => {
  const { stateDirectory } = await fixture(t);
  const first = state(stateDirectory, "1");
  const second = state(stateDirectory, "2");
  await registerPremortemLaneIndex(first);
  let releaseCommit;
  let signalCommit;
  const entered = new Promise((resolve) => { signalCommit = resolve; });
  const release = new Promise((resolve) => { releaseCommit = resolve; });
  const finalized = finalizePremortemScope(finalizationInput(stateDirectory,
    first.state.laneDigest, "closed", async () => { signalCommit(); await release; }));
  await entered;
  let competitorCommitted = false;
  const competitor = registerPremortemLaneIndex({ ...second,
    commit: async () => { competitorCommitted = true; } }).then(
    (value) => ({ value }), (error) => ({ error }));
  await nextTurn();
  assert.equal(competitorCommitted, false);
  releaseCommit();
  assert.equal((await finalized).status, "finalized");
  const rejected = await competitor;
  assert.equal(rejected.error?.code, "AGENTSPINE_PREMORTEM_FINALIZED");
  assert.equal(competitorCommitted, false);
});

test("a read-only fence excludes a delayed first lane", async (t) => {
  const { stateDirectory } = await fixture(t);
  const delayed = state(stateDirectory, "3");
  let releaseCommit;
  let signalCommit;
  const entered = new Promise((resolve) => { signalCommit = resolve; });
  const release = new Promise((resolve) => { releaseCommit = resolve; });
  const finalized = finalizePremortemScope(finalizationInput(stateDirectory,
    null, "read-only", async () => { signalCommit(); await release; }));
  await entered;
  let competitorCommitted = false;
  const competitor = registerPremortemLaneIndex({ ...delayed,
    commit: async () => { competitorCommitted = true; } }).then(
    (value) => ({ value }), (error) => ({ error }));
  await nextTurn();
  assert.equal(competitorCommitted, false);
  releaseCommit();
  assert.equal((await finalized).status, "finalized");
  const rejected = await competitor;
  assert.equal(rejected.error?.code, "AGENTSPINE_PREMORTEM_FINALIZED");
  assert.equal(competitorCommitted, false);
});

test("registration recreates its scope directory only after owning the scope lock", async (t) => {
  const { root, stateDirectory } = await fixture(t);
  const pending = state(stateDirectory, "4");
  const bound = pending.state.binding;
  const digest = premortemScopeDigest(bound.goalId, bound.goalStepId,
    bound.queueId, bound.gatewayAttempt);
  const indexRoot = join(root, "delivery-premortem-index");
  const scopeDirectory = join(indexRoot, digest);
  await mkdir(indexRoot);
  let registration;
  await withOwnedFileLock(join(indexRoot, `${digest}.lock`), async () => {
    registration = registerPremortemLaneIndex(pending);
    await nextTurn();
    await rmdir(scopeDirectory).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
  assert.equal((await registration).status, "indexed");
  const indexed = await lookupPremortemLaneIndex({ stateDirectory,
    goalId: bound.goalId, goalStepId: bound.goalStepId,
    queueId: bound.queueId, gatewayAttempt: bound.gatewayAttempt });
  assert.equal(indexed.status, "available");
  assert.equal(indexed.pointers.length, 1);
  assert.equal(dirname(indexed.directory), indexRoot);
});
