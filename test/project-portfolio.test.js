import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAutonomyProject, loadAutonomy, projectPortfolioContext,
  recordProjectObservation, scanProjectPortfolio } from "../src/lib/autonomy.js";
import { sessionBriefing } from "../src/lib/briefing.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentspine-portfolio-")));
  const state = await mkdtemp(join(tmpdir(), "agentspine-portfolio-state-"));
  const alpha = join(root, "alpha");
  const quiet = join(root, "quiet");
  await Promise.all([mkdir(alpha), mkdir(quiet)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic portfolio rules\n");
  await writeFile(join(alpha, "package.json"), "{ invalid synthetic json\n");
  await writeFile(join(alpha, "AGENTS.md"), "# Alpha bytes must stay exact\n");
  await writeFile(join(quiet, "package.json"), '{"name":"quiet","version":"1.0.0"}\n');
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
  });
  return { root, alpha, quiet };
}

async function register(root, id, projectId, localRoot, mode = "advise", tenantId = "tenant:one") {
  return configureAutonomyProject({ root, id, projectId, tenantId, localRoot, mode,
    confirmation: "local-owner-confirmed", goal: `Track ${projectId}.` });
}

test("bounded scans cover only explicit projects, preserve bytes and create one deduplicated finding", async (t) => {
  const f = await fixture(t);
  const before = Buffer.from(await readFile(join(f.alpha, "AGENTS.md")));
  await register(f.root, "autonomy:alpha", "project:alpha", f.alpha);
  await register(f.root, "autonomy:quiet", "project:quiet", f.quiet, "observe");
  await configureAutonomyProject({ root: f.root, id: "autonomy:remote", projectId: "project:remote",
    tenantId: "tenant:one", publicUrl: "https://example.test/public.git", mode: "advise",
    confirmation: "local-owner-confirmed", goal: "Track public evidence without fetching it." });
  const first = await scanProjectPortfolio({ root: f.root, tenantId: "tenant:one",
    now: "2029-01-01T12:00:00.000Z" });
  assert.deepEqual(first.projects.map((item) => item.status).sort(), ["registered-unfetched", "scanned", "scanned"]);
  const second = await scanProjectPortfolio({ root: f.root, tenantId: "tenant:one",
    now: "2029-01-01T12:01:00.000Z" });
  assert.equal(second.projects.filter((item) => item.status === "scanned").every((item) => item.duplicate), true);
  assert.deepEqual(await readFile(join(f.alpha, "AGENTS.md")), before);
  const context = await projectPortfolioContext({ root: f.root, tenantId: "tenant:one",
    now: "2029-01-01T12:02:00.000Z" });
  assert.equal(context.notice.summary, "package.json is not valid JSON");
  assert.equal(context.observations.filter((item) => item.kind === "error").length, 1);
  assert.equal(context.projects.length, 3);
  assert.equal(context.authority, "context-only");
});

test("ideas are deduplicated, stale and observe-only findings stay silent, and notices are rate limited", async (t) => {
  const f = await fixture(t);
  await register(f.root, "autonomy:alpha", "project:alpha", f.alpha);
  await register(f.root, "autonomy:quiet", "project:quiet", f.quiet, "observe");
  const idea = { root: f.root, registrationId: "autonomy:alpha", tenantId: "tenant:one", kind: "idea",
    status: "open", evidenceClass: "model-suggestion", summary: "Add a deterministic synthetic cache probe.",
    sourceDigest: hash("idea"), observedAt: "2029-01-01T12:00:00.000Z" };
  assert.equal((await recordProjectObservation(idea)).duplicate, false);
  assert.equal((await recordProjectObservation(idea)).duplicate, true);
  await recordProjectObservation({ ...idea, registrationId: "autonomy:quiet", summary: "Quiet project idea.",
    sourceDigest: hash("quiet") });
  await recordProjectObservation({ ...idea, summary: "Expired idea.", sourceDigest: hash("expired"),
    observedAt: "2028-01-01T00:00:00.000Z", expiresAt: "2028-01-02T00:00:00.000Z" });
  const presented = await projectPortfolioContext({ root: f.root, tenantId: "tenant:one", markPresented: true,
    now: "2029-01-01T12:01:00.000Z" });
  assert.equal(presented.notice.summary, idea.summary);
  const limited = await projectPortfolioContext({ root: f.root, tenantId: "tenant:one",
    now: "2029-01-01T12:30:00.000Z" });
  assert.equal(limited.notice, null);
  assert.equal(limited.rateLimited, true);
  const later = await projectPortfolioContext({ root: f.root, tenantId: "tenant:one",
    now: "2029-01-01T14:00:00.000Z" });
  assert.equal(later.notice, null);
  assert.equal(later.observations.some((item) => item.summary === "Expired idea."), false);
});

test("tenant and group scopes, concurrency, restart, briefing and symlink rejection remain exact", async (t) => {
  const f = await fixture(t);
  await register(f.root, "autonomy:alpha", "project:alpha", f.alpha);
  await Promise.all(Array.from({ length: 12 }, (_, index) => recordProjectObservation({
    root: f.root, registrationId: "autonomy:alpha", tenantId: "tenant:one", kind: "state",
    status: "unknown", evidenceClass: "objective", summary: `Synthetic state ${index}.`,
    sourceDigest: hash(`state-${index}`), observedAt: `2029-01-01T12:${String(index).padStart(2, "0")}:00.000Z`
  })));
  assert.equal((await loadAutonomy(f.root)).state.observations.length, 12);
  const { autonomyPath } = await loadAutonomy(f.root);
  await writeFile(`${autonomyPath}.lock`, "abandoned synthetic lock\n");
  const stale = new Date(Date.now() - 100_000);
  await utimes(`${autonomyPath}.lock`, stale, stale);
  await recordProjectObservation({ root: f.root, registrationId: "autonomy:alpha", tenantId: "tenant:one",
    kind: "state", status: "unknown", evidenceClass: "objective", summary: "Recovered after stale lock.",
    sourceDigest: hash("recovered-lock") });
  assert.equal((await loadAutonomy(f.root)).state.observations.length, 13);
  assert.equal((await projectPortfolioContext({ root: f.root, tenantId: "tenant:foreign" })).projects.length, 0);
  assert.equal((await projectPortfolioContext({ root: f.root, tenantId: "tenant:one", groupId: "group:foreign" })).projects.length, 0);
  const briefing = await sessionBriefing({ root: f.root, tenantId: "tenant:one", includeSourceContent: false });
  assert.equal(briefing.portfolio.projects.length, 1);
  assert.equal(briefing.portfolio.observations.length, 13);
  assert.ok(briefing.budget.usedBytes <= briefing.budget.maxBytes);
  const link = join(f.root, "linked-alpha");
  try {
    await symlink(f.alpha, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(register(f.root, "autonomy:link", "project:link", link), /symlink/);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }
});
