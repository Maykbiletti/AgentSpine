import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDelegation, createTask, grantDelegation, loadCoordination, loadDelegationPolicy,
  revokeDelegation, taskContext, updateTask
} from "../src/lib/coordination.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-coordination-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-coordination-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n\nSynthetic rules remain unchanged.\n", "utf8");
  await upsertEntity({ root, id: "agent:lead", kind: "agent", privacy: "shared" });
  await upsertEntity({ root, id: "agent:worker", kind: "agent", privacy: "shared" });
  await upsertEntity({ root, id: "person:owner", kind: "person", privacy: "shared" });
  return { root, state };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runCli(args, state) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function grant(root, actions = ["assign"], targetIds = ["agent:worker"]) {
  return grantDelegation({
    root, id: `grant:${actions.join("-")}`, actorId: "agent:lead", actions, targetIds,
    reason: "The local owner explicitly approved this synthetic coordination scope.",
    confirmation: "local-owner-confirmed"
  });
}

test("relationship responsibility never becomes delegation authority", async (t) => {
  const { root } = await fixture(t);
  await linkEntities({ root, from: "agent:lead", to: "agent:worker", relation: "responsible-for", privacy: "shared" });
  const decision = await checkDelegation({ root, actorId: "agent:lead", action: "assign", targetId: "agent:worker" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /default deny/);
  await assert.rejects(
    createTask({ root, actorId: "agent:lead", assigneeId: "agent:worker", title: "Must stay denied" }),
    /default deny/
  );
});

test("explicit policy enables assignment, revocation blocks future assignments, and history remains", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    grantDelegation({ root, actorId: "agent:lead", actions: ["assign"], targetIds: ["agent:worker"], reason: "Missing confirmation." }),
    /explicit local owner confirmation/
  );
  const granted = await grant(root);
  assert.equal((await checkDelegation({ root, actorId: "agent:lead", action: "assign", targetId: "agent:worker" })).allowed, true);
  const created = await createTask({
    root, id: "task:before-revoke", actorId: "agent:lead", assigneeId: "agent:worker",
    title: "Synthetic delegated task", privacy: "shared"
  });
  assert.equal(created.task.assignment.grantId, granted.grant.id);
  await revokeDelegation({
    root, id: granted.grant.id, reason: "The synthetic delegation ended.", confirmation: "local-owner-confirmed"
  });
  assert.equal((await checkDelegation({ root, actorId: "agent:lead", action: "assign", targetId: "agent:worker" })).allowed, false);
  await assert.rejects(
    createTask({ root, actorId: "agent:lead", assigneeId: "agent:worker", title: "Must now fail" }),
    /default deny/
  );
  assert.equal((await taskContext({ root })).items[0].id, "task:before-revoke");
  assert.equal((await loadDelegationPolicy(root)).policy.history.length, 1);
});

test("task changes retain prior versions and never alter source Markdown", async (t) => {
  const { root } = await fixture(t);
  const before = hash(await readFile(join(root, "AGENTS.md")));
  await createTask({ root, id: "task:history", actorId: "agent:worker", assigneeId: "agent:worker", title: "First title", privacy: "shared" });
  await updateTask({ root, id: "task:history", actorId: "agent:worker", patch: { title: "Current title", status: "in-progress" } });
  const { coordination } = await loadCoordination(root);
  assert.equal(coordination.tasks[0].title, "Current title");
  assert.equal(coordination.history[0].value.title, "First title");
  assert.equal(coordination.history[0].authority, "context-only");
  assert.equal(hash(await readFile(join(root, "AGENTS.md"))), before);
});

test("assignees self-manage while unrelated actors need explicit management policy", async (t) => {
  const { root } = await fixture(t);
  await createTask({ root, id: "task:self", actorId: "agent:worker", assigneeId: "agent:worker", title: "Self-managed", privacy: "shared" });
  await updateTask({ root, id: "task:self", actorId: "agent:worker", patch: { status: "completed" } });
  await assert.rejects(
    updateTask({ root, id: "task:self", actorId: "agent:lead", patch: { status: "open" } }),
    /default deny/
  );
  await grant(root, ["manage"], ["agent:worker"]);
  assert.equal((await updateTask({ root, id: "task:self", actorId: "agent:lead", patch: { status: "open" } })).task.status, "open");
});

test("delegation actions are non-interchangeable across reassignment and terminal status", async (t) => {
  const { root } = await fixture(t);
  await grant(root, ["assign"], ["agent:worker"]);
  await createTask({
    root, id: "task:scoped-actions", actorId: "agent:lead", assigneeId: "agent:worker",
    title: "Scoped actions", privacy: "shared"
  });
  await assert.rejects(
    updateTask({ root, id: "task:scoped-actions", actorId: "agent:lead", patch: { assigneeId: "person:owner" } }),
    /default deny/
  );
  await grant(root, ["reassign"], ["person:owner"]);
  await updateTask({ root, id: "task:scoped-actions", actorId: "agent:lead", patch: { assigneeId: "person:owner" } });
  await assert.rejects(
    updateTask({ root, id: "task:scoped-actions", actorId: "agent:lead", patch: { status: "completed" } }),
    /default deny/
  );
  await grant(root, ["complete"], ["person:owner"]);
  assert.equal((await updateTask({ root, id: "task:scoped-actions", actorId: "agent:lead", patch: { status: "completed" } })).task.status, "completed");
});

test("group tasks require the exact audience even when private context is requested", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", privacy: "shared" });
  await linkEntities({ root, from: "agent:lead", to: "group:alpha", relation: "member-of", privacy: "group" });
  await createTask({
    root, id: "task:group", actorId: "agent:lead", title: "Alpha-only open thread",
    kind: "open-thread", privacy: "group", groupId: "group:alpha"
  });
  assert.equal((await taskContext({ root, includePrivate: true })).items.length, 0);
  assert.equal((await taskContext({ root, includePrivate: true, groupId: "group:beta" })).items.length, 0);
  assert.equal((await taskContext({ root, groupId: "group:alpha" })).items[0].id, "task:group");
});

test("concurrent task updates serialize without losing retained versions", async (t) => {
  const { root } = await fixture(t);
  await createTask({ root, id: "task:parallel", actorId: "agent:worker", assigneeId: "agent:worker", title: "Parallel", privacy: "shared" });
  await Promise.all(Array.from({ length: 8 }, (_, index) => updateTask({
    root, id: "task:parallel", actorId: "agent:worker", patch: { note: `Synthetic note ${index}` }
  })));
  const { coordination } = await loadCoordination(root);
  assert.equal(coordination.history.filter((entry) => entry.recordId === "task:parallel").length, 8);
  assert.match(coordination.tasks[0].note, /^Synthetic note [0-7]$/);
});

test("malformed policy fails closed, remains untouched, and does not break source indexing", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadDelegationPolicy(root);
  const corrupt = "{\"schema\":\"wrong\",\"grants\":[]}";
  await writeFile(loaded.policyPath, corrupt, "utf8");
  await assert.rejects(
    checkDelegation({ root, actorId: "agent:lead", action: "assign", targetId: "agent:worker" }),
    /structure is invalid/
  );
  await assert.rejects(
    createTask({ root, actorId: "agent:lead", title: "Must not overwrite state" }),
    /structure is invalid/
  );
  assert.equal(await readFile(loaded.policyPath, "utf8"), corrupt);
  const hook = await runHook({ hook_event_name: "SessionStart", cwd: root });
  assert.match(hook.context, /indexed 1 Markdown source/);
  assert.match(hook.context, /Coordination state needs review/);
});

test("CLI supports explicit policy, task lifecycle, context, and revocation", async (t) => {
  const { root, state } = await fixture(t);
  runCli([
    "delegation-grant", "agent:lead", "--root", root, "--id", "grant:cli", "--actions", "assign",
    "--targets", "agent:worker", "--reason", "Owner-approved CLI fixture.", "--confirm-local-policy", "--json"
  ], state);
  runCli([
    "task-create", "task:cli", "--root", root, "--actor", "agent:lead", "--assignee", "agent:worker",
    "--title", "CLI handoff", "--kind", "handoff", "--privacy", "shared", "--json"
  ], state);
  runCli(["task-update", "task:cli", "--root", root, "--actor", "agent:worker", "--status", "completed", "--json"], state);
  assert.equal(runCli(["tasks", root, "--closed", "--json"], state).items[0].status, "completed");
  runCli([
    "delegation-revoke", "grant:cli", "--root", root, "--reason", "CLI fixture ended.",
    "--confirm-local-policy", "--json"
  ], state);
  assert.equal(runCli([
    "delegation-check", "agent:lead", "--root", root, "--action", "assign", "--target", "agent:worker", "--json"
  ], state).allowed, false);
});

test("secrets are rejected from both dedicated policy and task state", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    grantDelegation({
      root, actorId: "agent:lead", actions: ["assign"], targetIds: ["agent:worker"],
      reason: "token=abcdefghijklmnopqrstuvwxyz123456", confirmation: "local-owner-confirmed"
    }),
    /secret/
  );
  await assert.rejects(
    createTask({ root, actorId: "agent:lead", title: "password=abcdefghijklmnopqrstuvwxyz123456" }),
    /secret/
  );
  assert.equal((await loadDelegationPolicy(root)).policy.grants.length, 0);
  assert.equal((await loadCoordination(root)).coordination.tasks.length, 0);
});

test("session hooks expose only coordination counts and kinds", async (t) => {
  const { root } = await fixture(t);
  await createTask({ root, actorId: "agent:worker", title: "Sensitive synthetic handoff wording", kind: "handoff", privacy: "shared" });
  const result = await runHook({ hook_event_name: "SessionStart", cwd: root });
  assert.match(result.context, /1 shared coordination item/);
  assert.match(result.context, /handoff/);
  assert.doesNotMatch(result.context, /Sensitive synthetic handoff wording/);
});
