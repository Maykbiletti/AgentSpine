import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureAutonomyProject, evaluateAutonomyAction, loadAutonomy, revokeAutonomyProject
} from "../src/lib/autonomy.js";
import { createTask } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import { grantExecution } from "../src/lib/selfstarter.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-autonomy-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-autonomy-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n\nKeep project sources unchanged.\n");
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
  });
  return { root };
}

const base = {
  id: "autonomy:alpha", projectId: "project:alpha", tenantId: "tenant:one", groupId: null,
  confirmation: "local-owner-confirmed", goal: "Maintain synthetic alpha safely."
};

test("four autonomy levels are cumulative while publish requires a separate confirmation", async (t) => {
  const { root } = await fixture(t);
  await configureAutonomyProject({ root, ...base, localRoot: root, mode: "observe" });
  assert.equal((await evaluateAutonomyAction({ root, registrationId: base.id, tenantId: base.tenantId,
    action: "observe" })).allowed, true);
  assert.equal((await evaluateAutonomyAction({ root, registrationId: base.id, tenantId: base.tenantId,
    action: "advise" })).reason, "autonomy-mode-insufficient");
  await configureAutonomyProject({ root, ...base, localRoot: root, mode: "advise" });
  assert.equal((await evaluateAutonomyAction({ root, registrationId: base.id, tenantId: base.tenantId,
    action: "advise" })).allowed, true);
  await assert.rejects(configureAutonomyProject({ root, ...base, localRoot: root, mode: "execute" }), /exact capabilities/);
  await assert.rejects(configureAutonomyProject({ root, ...base, localRoot: root, mode: "publish",
    capabilities: ["tool:Write"] }), /separate explicit local publish/);
  await configureAutonomyProject({ root, ...base, localRoot: root, mode: "publish", capabilities: ["tool:Write"],
    publishConfirmation: "local-owner-publish-confirmed" });
  const noGrant = await evaluateAutonomyAction({ root, registrationId: base.id, tenantId: base.tenantId,
    action: "publish", capability: "tool:Write", actorId: "agent:worker", jobId: "job:alpha",
    taskId: "task:alpha", targetId: "person:owner", projectId: "project:alpha", host: "codex" });
  assert.equal(noGrant.allowed, false);
  assert.equal(noGrant.reason, "execution-grant-unavailable");
  assert.equal(noGrant.grantsAuthority, false);
});

test("execute and publish require the current exact execution grant and exact scope", async (t) => {
  const { root } = await fixture(t);
  for (const [id, kind] of [["agent:worker", "agent"], ["person:owner", "person"], ["project:alpha", "project"]]) {
    await upsertEntity({ root, id, kind, privacy: "shared" });
  }
  await createTask({ root, id: "task:alpha", actorId: "agent:worker", assigneeId: "agent:worker",
    projectId: "project:alpha", title: "Synthetic alpha task", privacy: "shared" });
  await grantExecution({ root, id: "grant:alpha", jobId: "job:alpha", actorId: "agent:worker",
    taskId: "task:alpha", targetId: "person:owner", projectId: "project:alpha", groupId: null,
    host: "codex", capabilities: ["tool:Write"], reason: "Exact synthetic local owner grant.",
    expiresAt: "2030-01-01T00:00:00.000Z", confirmation: "local-owner-confirmed",
    now: "2029-01-01T00:00:00.000Z" });
  await configureAutonomyProject({ root, ...base, localRoot: root, mode: "publish", capabilities: ["tool:Write"],
    publishConfirmation: "local-owner-publish-confirmed", now: "2029-01-01T00:00:01.000Z" });
  const input = { root, registrationId: base.id, tenantId: base.tenantId, action: "publish",
    capability: "tool:Write", actorId: "agent:worker", jobId: "job:alpha", taskId: "task:alpha",
    targetId: "person:owner", projectId: "project:alpha", groupId: null, host: "codex",
    now: "2029-01-01T00:00:02.000Z" };
  const allowed = await evaluateAutonomyAction(input);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.grantId, "grant:alpha");
  assert.equal((await evaluateAutonomyAction({ ...input, tenantId: "tenant:foreign" })).allowed, false);
  assert.equal((await evaluateAutonomyAction({ ...input, capability: "tool:Bash" })).reason, "capability-not-configured");
  assert.equal((await evaluateAutonomyAction({ ...input, projectId: "project:foreign" })).reason, "action-project-mismatch");
  assert.equal((await evaluateAutonomyAction({ ...input, jobId: "job:foreign" })).reason, "execution-grant-unavailable");
});

test("registration identity, URL safety, revocation, restart and tamper checks fail closed", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(configureAutonomyProject({ root, ...base, publicUrl: "https://user@example.test/repo?token=x",
    mode: "observe" }), /credential-free HTTPS URL/);
  await configureAutonomyProject({ root, ...base, publicUrl: "https://example.test/public.git", mode: "observe" });
  await assert.rejects(configureAutonomyProject({ root, ...base, projectId: "project:other",
    publicUrl: "https://example.test/public.git", mode: "observe" }), /immutable/);
  assert.equal((await loadAutonomy(root)).state.projects.length, 1);
  await revokeAutonomyProject({ root, id: base.id, reason: "Synthetic project retired.",
    confirmation: "local-owner-confirmed" });
  assert.equal((await evaluateAutonomyAction({ root, registrationId: base.id, tenantId: base.tenantId,
    action: "observe" })).allowed, false);
  const loaded = await loadAutonomy(root);
  const raw = JSON.parse(await readFile(loaded.autonomyPath, "utf8"));
  raw.projects[0].mode = "publish";
  await writeFile(loaded.autonomyPath, `${JSON.stringify(raw, null, 2)}\n`);
  await assert.rejects(loadAutonomy(root), /failed closed/);
});
