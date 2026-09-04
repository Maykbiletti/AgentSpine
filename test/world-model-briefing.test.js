import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionBriefing } from "../src/lib/briefing.js";
import { upsertEntity } from "../src/lib/graph.js";
import { recordWorldAssertion } from "../src/lib/world-model.js";

const NOW = "2026-09-04T10:00:00.000Z";
const OBSERVED = "2026-09-01T10:00:00.000Z";
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-world-briefing-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-world-briefing-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  await mkdir(join(root, ".git"));
  const source = Buffer.from("# Synthetic instructions\n\nNever mutate this file.\n");
  await writeFile(join(root, "AGENTS.md"), source);
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  return { root, source };
}

function record(root, id, value, extra = {}) {
  return recordWorldAssertion({
    root, id, subjectId: "project:synthetic-atlas", predicate: "suite.zero-status", value,
    evidenceKind: "objective-measurement", evidenceId: `measurement:${id.split(":")[1]}`,
    evidenceDigest: hash(JSON.stringify(value)), observedAt: OBSERVED, privacy: "shared", now: NOW,
    projectId: "project:synthetic-atlas", ...extra
  });
}

test("session briefing carries durable facts while separating uncertainty", async (t) => {
  const { root, source } = await fixture(t);
  await record(root, "assertion:verified", "new-red");
  await record(root, "assertion:suggestion", "green", {
    predicate: "next.action", evidenceKind: "model-suggestion", evidenceId: "model-output:one"
  });
  await record(root, "assertion:expired", "old-red", {
    predicate: "archive.status", evidenceId: "measurement:expired",
    expiresAt: "2026-09-02T10:00:00.000Z"
  });
  let briefing = await sessionBriefing({
    root, host: "generic", projectId: "project:synthetic-atlas", now: NOW,
    includeSourceContent: false, maxBytes: 16384
  });
  assert.deepEqual(briefing.world.facts.map((item) => item.value), ["new-red"]);
  assert.equal(briefing.world.proposals[0].status, "proposed");
  assert.equal(briefing.world.stale[0].id, "assertion:expired");
  assert.equal(briefing.world.uncertainty.requiresResolution, false);

  await record(root, "assertion:conflict", "green", { evidenceId: "measurement:conflict" });
  briefing = await sessionBriefing({
    root, host: "generic", projectId: "project:synthetic-atlas", now: NOW,
    includeSourceContent: false, maxBytes: 16384
  });
  assert.equal(briefing.world.facts.some((item) => item.predicate === "suite.zero-status"), false);
  assert.equal(briefing.world.conflicts[0].predicate, "suite.zero-status");
  assert.equal(briefing.world.uncertainty.requiresResolution, true);
  assert.equal(briefing.budget.usedBytes, Buffer.byteLength(JSON.stringify(briefing)));
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("group briefing cannot observe another group's or private world assertions", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", privacy: "shared" });
  await record(root, "assertion:alpha", "alpha", {
    predicate: "team.handoff", projectId: null, groupId: "group:alpha", privacy: "group"
  });
  await record(root, "assertion:beta", "beta", {
    predicate: "team.handoff", evidenceId: "measurement:beta", projectId: null,
    groupId: "group:beta", privacy: "group"
  });
  await record(root, "assertion:private", "private", {
    predicate: "user.preference", evidenceId: "measurement:private", projectId: null, privacy: "private"
  });
  const briefing = await sessionBriefing({
    root, host: "generic", groupId: "group:alpha", now: NOW,
    includeSourceContent: false, maxBytes: 8192
  });
  assert.deepEqual(briefing.world.facts.map((item) => item.value), ["alpha"]);
});
