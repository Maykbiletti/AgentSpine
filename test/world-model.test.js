import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  recordWorldAssertion, worldContext, worldModelStatePath
} from "../src/lib/world-model.js";

const OBSERVED = "2026-09-01T10:00:00.000Z";
const NOW = "2026-09-04T10:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-world-project-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-world-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  await mkdir(join(root, ".git"));
  const source = Buffer.from("# Synthetic world fixture\n\nThese bytes remain user-owned.\n");
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  return { root, state, source };
}

function assertion(root, id, value, extra = {}) {
  return {
    root, id, subjectId: "service:synthetic-checkout", predicate: "release.health",
    value, evidenceKind: "objective-measurement", evidenceId: `measurement:${id.split(":")[1]}`,
    evidenceDigest: digest(JSON.stringify(value)), observedAt: OBSERVED,
    privacy: "shared", now: NOW, ...extra
  };
}

test("measured facts persist across reads without touching user sources", async (t) => {
  const { root, state, source } = await fixture(t);
  const recorded = await recordWorldAssertion(assertion(root, "assertion:green", { suite: 0, status: "green" }));
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.assertion.authority, "context-only");
  const restarted = await worldContext({ root, now: NOW });
  assert.equal(restarted.facts.length, 1);
  assert.deepEqual(restarted.facts[0].value, { status: "green", suite: 0 });
  assert.equal(restarted.uncertainty.requiresResolution, false);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
  assert.equal((await worldModelStatePath(root)).startsWith(state), true);
  assert.equal((await worldModelStatePath(root)).startsWith(root), false);
});

test("model suggestions, stale evidence, and contradictions never become facts", async (t) => {
  const { root } = await fixture(t);
  await recordWorldAssertion(assertion(root, "assertion:green", "green"));
  await recordWorldAssertion(assertion(root, "assertion:proposal", "red", {
    evidenceKind: "model-suggestion", evidenceId: "model-output:proposal"
  }));
  await recordWorldAssertion(assertion(root, "assertion:stale", "old", {
    predicate: "release.channel", evidenceId: "measurement:stale",
    expiresAt: "2026-09-02T10:00:00.000Z"
  }));
  let context = await worldContext({ root, now: NOW });
  assert.deepEqual(context.facts.map((item) => item.value), ["green"]);
  assert.equal(context.proposals[0].status, "proposed");
  assert.equal(context.stale[0].id, "assertion:stale");

  await recordWorldAssertion(assertion(root, "assertion:red", "red", { evidenceId: "measurement:red" }));
  context = await worldContext({ root, now: NOW });
  assert.equal(context.facts.length, 0);
  assert.equal(context.conflicts.length, 1);
  assert.deepEqual(context.conflicts[0].assertions.map((item) => item.id).sort(), ["assertion:green", "assertion:red"]);
  assert.equal(context.uncertainty.requiresResolution, true);

  await recordWorldAssertion(assertion(root, "assertion:resolved", "red", {
    evidenceKind: "explicit-user-feedback", evidenceId: "user-turn:resolution",
    supersedes: ["assertion:green", "assertion:red"], reason: "Synthetic explicit correction."
  }));
  context = await worldContext({ root, now: NOW });
  assert.deepEqual(context.facts.map((item) => item.value), ["red"]);
  assert.equal(context.conflicts.length, 0);
});

test("group and private scopes remain exact", async (t) => {
  const { root } = await fixture(t);
  await recordWorldAssertion(assertion(root, "assertion:alpha", "alpha", {
    predicate: "team.marker", groupId: "group:alpha", privacy: "group"
  }));
  await recordWorldAssertion(assertion(root, "assertion:beta", "beta", {
    predicate: "team.marker", evidenceId: "measurement:beta", groupId: "group:beta", privacy: "group"
  }));
  await recordWorldAssertion(assertion(root, "assertion:private", "private", {
    predicate: "user.preference", evidenceId: "measurement:private", privacy: "private"
  }));
  const alpha = await worldContext({ root, groupId: "group:alpha", now: NOW });
  assert.deepEqual(alpha.facts.map((item) => item.value), ["alpha"]);
  const unscoped = await worldContext({ root, now: NOW });
  assert.equal(unscoped.facts.length, 0);
  const personal = await worldContext({ root, includePrivate: true, now: NOW });
  assert.deepEqual(personal.facts.map((item) => item.value), ["private"]);
  await assert.rejects(worldContext({ root, groupId: "group:alpha", includePrivate: true }), /private world context/);
});

test("concurrent writes serialize, duplicate retries deduplicate, and id reuse fails", async (t) => {
  const { root } = await fixture(t);
  const writes = Array.from({ length: 20 }, (_, index) => recordWorldAssertion(assertion(
    root, `assertion:parallel-${index}`, index, {
      subjectId: `service:parallel-${index}`, predicate: "measurement.value",
      evidenceId: `measurement:parallel-${index}`
    }
  )));
  await Promise.all(writes);
  const context = await worldContext({ root, now: NOW, maxItems: 50 });
  assert.equal(context.facts.length, 20);
  const duplicate = await recordWorldAssertion(assertion(root, "assertion:parallel-0", 0, {
    subjectId: "service:parallel-0", predicate: "measurement.value", evidenceId: "measurement:parallel-0"
  }));
  assert.equal(duplicate.status, "duplicate");
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:parallel-0", 99, {
    subjectId: "service:parallel-0", predicate: "measurement.value", evidenceId: "measurement:parallel-0"
  })), /already used/);
});

test("future, authority-shaped, oversized, and tampered assertions fail closed", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:future", true, {
    observedAt: "2026-09-05T10:00:00.000Z"
  })), /future/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:right", true, {
    predicate: "permissions.admin"
  })), /authority predicates/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:nested", { token: "synthetic" })), /authority data/);
  await assert.rejects(recordWorldAssertion(assertion(root, "assertion:large", "x".repeat(9000))), /8 KiB/);
  await recordWorldAssertion(assertion(root, "assertion:valid", true));
  const path = await worldModelStatePath(root);
  const state = JSON.parse(await readFile(path, "utf8"));
  state.assertions[0].value = false;
  await writeFile(path, `${JSON.stringify(state)}\n`);
  await assert.rejects(worldContext({ root, now: NOW }), /world model state is invalid/);
  assert.equal(dirname(path).startsWith(root), false);
});
