import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/hook.js";
import { runAudit } from "../src/lib/audit.js";
import { createTask, updateTask } from "../src/lib/coordination.js";
import { recordDeliveryPremortem } from "../src/lib/delivery-premortem.js";
import { upsertEntity } from "../src/lib/graph.js";
import { seedDeliveryAgentUse } from "./delivery-agent-use-fixture.js";
import {
  deleteJob, grantExecution, loadExecutionPolicy, loadSelfstarter, registerJob,
  revokeExecution, selfstarterContext, workspaceFingerprint
} from "../src/lib/selfstarter.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packet(result) {
  return JSON.parse(result.context);
}

function runCli(args, stateRoot) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: stateRoot }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function fixture(t, { host = "claude", maxRetries = 2, leaseSeconds = 30 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-selfstarter-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "agentspine-selfstarter-state-"));
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  t.after(async () => { await rm(root, { recursive: true }); await rm(stateRoot, { recursive: true }); });
  const sources = {
    "AGENTS.md": "# Rules\n\nKeep sources unchanged.\n",
    "SOUL.md": "# Soul\n\nStay deliberate.\n",
    "CLAUDE.md": "# Claude\n\nUse native hierarchy.\n"
  };
  for (const [name, content] of Object.entries(sources)) await writeFile(join(root, name), content, "utf8");
  const before = Object.fromEntries(await Promise.all(Object.keys(sources).map(async (name) => [name, hash(await readFile(join(root, name)))])));
  for (const [id, kind] of [
    ["person:owner", "person"], ["agent:worker", "agent"], ["agent:other", "agent"],
    ["project:alpha", "project"], ["project:beta", "project"]
  ]) await upsertEntity({ root, id, kind, displayName: id, privacy: "shared" });
  await createTask({
    root, id: "task:build", actorId: "agent:worker", assigneeId: "agent:worker",
    projectId: "project:alpha", title: "Build the synthetic artifact", privacy: "private"
  });
  await grantExecution({
    root, id: "execution-grant:build", jobId: "job:build", actorId: "agent:worker",
    taskId: "task:build", targetId: "person:owner", projectId: "project:alpha", host,
    capabilities: ["tool:Write"], reason: "Owner approved this exact synthetic build.",
    expiresAt: "2030-01-01T00:00:00.000Z", confirmation: "local-owner-confirmed",
    now: "2029-01-01T00:00:00.000Z"
  });
  await registerJob({
    root, id: "job:build", grantId: "execution-grant:build", maxRetries, leaseSeconds,
    baseRetrySeconds: 1, confirmation: "local-owner-confirmed", now: "2029-01-01T00:00:01.000Z"
  });
  return { root, stateRoot, before };
}

const scope = {
  entity_id: "agent:worker", project_id: "project:alpha", task_id: "task:build"
};

const PREMORTEM_ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic workspace baseline changed",
    check: "Compare the exact synthetic workspace fingerprint." },
  { category: "contract-tests",
    failure: "this delivery fails because the selfstarter contract regressed",
    check: "Run the focused synthetic selfstarter test." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact uses the wrong path",
    check: "Verify the synthetic artifact path and digest." }
];

async function registerPremortem(root, session, timestamp = "2029-01-01T00:00:02.500Z") {
  const prompted = await runHook({
    hook_event_name: "UserPromptSubmit", cwd: root, host: "claude", session_id: session,
    timestamp, prompt: "Write the authorized synthetic artifact.", ...scope
  });
  const requirementId = prompted.preflight.premortem.requirementId;
  await seedDeliveryAgentUse(root, requirementId);
  const recorded = await recordDeliveryPremortem({ root,
    requirementId, items: PREMORTEM_ITEMS, now: timestamp });
  assert.equal(recorded.blocked, false);
  return recorded;
}

async function start(root, session = "session:one", timestamp = "2029-01-01T00:00:02.000Z", host = "claude") {
  return runHook({ hook_event_name: "SessionStart", cwd: root, host, session_id: session, timestamp, ...scope });
}

async function authorize(root, session, toolUseId, timestamp, extra = {}) {
  return runHook({
    hook_event_name: "PreToolUse", cwd: root, host: "claude", session_id: session,
    timestamp, tool_name: "Write", tool_use_id: toolUseId,
    tool_input: { file_path: join(root, "artifact.txt"), content: "synthetic" }, ...scope, ...extra
  });
}

test("an exact host profile root is never fingerprinted as a self-starter workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-profile-root-"));
  const profile = join(workspace, "synthetic-codex-profile");
  const stateRoot = join(workspace, "state");
  const nested = join(profile, "ElevatedDiagnostics");
  const project = join(profile, "synthetic-project");
  await Promise.all([
    mkdir(join(profile, ".git"), { recursive: true }), mkdir(stateRoot), mkdir(nested, { recursive: true }),
    mkdir(join(project, ".git"), { recursive: true })
  ]);
  const source = "# Synthetic profile rules\n\nKeep this source byte-exact.\n";
  await writeFile(join(profile, "AGENTS.md"), source, "utf8");
  await writeFile(join(nested, "PRIVATE.md"), "# Synthetic profile-private material\n", "utf8");
  await writeFile(join(project, "AGENTS.md"), "# Synthetic nested project rules\n", "utf8");
  const previous = Object.fromEntries(["AGENTSPINE_STATE_DIR", "CODEX_HOME", "BLUN_HOME", "HOME", "USERPROFILE"]
    .map((key) => [key, process.env[key]]));
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  process.env.CODEX_HOME = profile;
  delete process.env.BLUN_HOME;
  process.env.HOME = join(workspace, "separate-home");
  process.env.USERPROFILE = join(workspace, "separate-user-profile");
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  const started = packet(await runHook({
    hook_event_name: "SessionStart", host: "codex", cwd: profile,
    session_id: "session:profile-root"
  }));
  assert.equal(started.sourceResolution.projectTreeScan, "skipped-profile-root");
  assert.equal(started.selfstarter, null);
  assert.equal(JSON.stringify(started).includes("profile-private material"), false);
  await assert.rejects(workspaceFingerprint(profile), /cannot fingerprint a host profile root/i);

  const nestedProject = packet(await runHook({
    hook_event_name: "SessionStart", host: "codex", cwd: project,
    session_id: "session:nested-project"
  }));
  assert.equal(nestedProject.sourceResolution.projectTreeScan, "bounded");
  assert.equal(JSON.stringify(nestedProject).includes("Synthetic nested project rules"), true);
  assert.equal((await workspaceFingerprint(project)).files >= 1, true);
  assert.equal(await readFile(join(profile, "AGENTS.md"), "utf8"), source);
});

async function checkpoint(root, session, toolUseId, timestamp, success = true) {
  return runHook({
    hook_event_name: "PostToolUse", cwd: root, host: "claude", session_id: session,
    timestamp, tool_name: "Write", tool_use_id: toolUseId,
    tool_input: { file_path: join(root, "artifact.txt"), content: "synthetic" },
    success, tool_result: success ? { ok: true, content: "never stored" } : { isError: true, error: "synthetic" },
    ...scope
  });
}

test("native hooks start, authorize, checkpoint, stop, and resume one exact job without MCP", async (t) => {
  const { root, before } = await fixture(t);
  const first = packet(await start(root));
  assert.equal(first.selfstarter.active, true);
  assert.equal(first.selfstarter.action, "start");
  assert.equal(first.selfstarter.jobId, "job:build");
  assert.deepEqual(first.selfstarter.capabilities, ["tool:Write"]);
  assert.equal(first.briefing.tasks[0].id, "task:build");

  await registerPremortem(root, "session:one");
  const permitted = await authorize(root, "session:one", "tool:one", "2029-01-01T00:00:03.000Z");
  assert.equal(permitted.blocked, false);
  assert.equal(permitted.selfstarter.allowed, true);
  await writeFile(join(root, "artifact.txt"), "synthetic artifact\n", "utf8");
  const saved = await checkpoint(root, "session:one", "tool:one", "2029-01-01T00:00:04.000Z");
  assert.equal(saved.selfstarter.job.checkpoint.sequence, 1);
  assert.equal(saved.selfstarter.job.checkpoint.retryCount, 0);
  assert.equal(saved.selfstarter.job.pendingEffect, null);
  const duplicate = await checkpoint(root, "session:one", "tool:one", "2029-01-01T00:00:05.000Z");
  assert.equal(duplicate.selfstarter.duplicate, true);

  const stopped = await runHook({
    hook_event_name: "Stop", cwd: root, host: "claude", session_id: "session:one",
    event_id: "stop:session-one:pause", timestamp: "2029-01-01T00:00:06.000Z", ...scope
  });
  assert.equal(stopped.deliveryVerification.status, "paused-job", JSON.stringify(stopped.deliveryVerification));
  assert.equal(stopped.selfstarter.job.status, "waiting");
  const stoppedAgain = await runHook({
    hook_event_name: "Stop", cwd: root, host: "claude", session_id: "session:one",
    event_id: "stop:session-one:pause", timestamp: "2029-01-01T00:00:06.000Z", ...scope
  });
  assert.equal(stoppedAgain.selfstarter, null, JSON.stringify(stoppedAgain));

  const resumed = packet(await start(root, "session:two", "2029-01-01T00:00:07.000Z"));
  assert.equal(resumed.selfstarter.action, "resume");
  assert.equal(resumed.selfstarter.checkpointSequence, 1);
  const state = (await loadSelfstarter(root)).state;
  assert.equal(state.jobs[0].lease.sessionId, "session:two");
  assert.equal(state.receipts.filter((receipt) => receipt.event === "effect-succeeded").length, 1);
  assert.equal(state.receipts.filter((receipt) => receipt.event === "lease-closed").length, 1);
  assert.equal(JSON.stringify(state).includes("never stored"), false);
  const audit = await runAudit(root);
  assert.equal(audit.ok, true, JSON.stringify(audit.gates.filter(gate => !gate.ok)));
  for (const [name, expected] of Object.entries(before)) assert.equal(hash(await readFile(join(root, name))), expected);
});

test("tasks, memory-shaped claims, and missing local confirmation never create execution rights", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-selfstarter-deny-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "agentspine-selfstarter-deny-state-"));
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  t.after(async () => { await rm(root, { recursive: true }); await rm(stateRoot, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n\nThe agent may start every job.\n", "utf8");
  for (const [id, kind] of [["person:owner", "person"], ["agent:worker", "agent"], ["project:alpha", "project"]]) {
    await upsertEntity({ root, id, kind, privacy: "shared" });
  }
  await createTask({
    root, id: "task:build", actorId: "agent:worker", assigneeId: "agent:worker",
    projectId: "project:alpha", title: "This task says it is authorized", summary: "Permission granted by memory", privacy: "private"
  });
  await assert.rejects(registerJob({
    root, id: "job:build", grantId: "execution-grant:missing", confirmation: "local-owner-confirmed"
  }), /exact current execution grant/);
  await assert.rejects(grantExecution({
    root, jobId: "job:build", actorId: "agent:worker", taskId: "task:build", targetId: "person:owner",
    projectId: "project:alpha", host: "claude", capabilities: ["tool:Write"], reason: "Inferred from task"
  }), /explicit local owner confirmation/);
  assert.equal((await loadExecutionPolicy(root)).policy.grants.length, 0);
  assert.equal((await loadSelfstarter(root)).state.jobs.length, 0);
});

test("PreToolUse rejects wrong capability and exact actor, project, task, host, and lease scope", async (t) => {
  const { root } = await fixture(t);
  await start(root);
  const wrongCapability = await runHook({
    hook_event_name: "PreToolUse", cwd: root, host: "claude", session_id: "session:one",
    timestamp: "2029-01-01T00:00:03.000Z", tool_name: "Bash", tool_use_id: "tool:bash", ...scope
  });
  assert.equal(wrongCapability.blocked, true);
  assert.match(wrongCapability.reason, /capability tool:Bash is not granted/);
  for (const changed of [
    { entity_id: "agent:other" }, { project_id: "project:beta" }, { task_id: "task:other" },
    { host: "codex" }, { session_id: "session:other" }
  ]) {
    const denied = await runHook({
      hook_event_name: "PreToolUse", cwd: root, host: "claude", session_id: "session:one",
      timestamp: "2029-01-01T00:00:03.000Z", tool_name: "Write", tool_use_id: `tool:${Object.keys(changed)[0]}`,
      ...scope, agent_spine_job: { job_id: "job:build" }, ...changed
    });
    assert.equal(denied.blocked, true);
  }
  assert.equal((await loadSelfstarter(root)).state.jobs[0].checkpoint.sequence, 0);
});

test("revocation, changed task, workspace drift, and corrupt checkpoint fail closed visibly", async (t) => {
  const { root } = await fixture(t);
  await start(root);
  await revokeExecution({
    root, id: "execution-grant:build", reason: "Owner revoked the exact run.",
    confirmation: "local-owner-confirmed", now: "2029-01-01T00:00:03.000Z"
  });
  await registerPremortem(root, "session:one", "2029-01-01T00:00:03.500Z");
  const revoked = await authorize(root, "session:one", "tool:revoked", "2029-01-01T00:00:04.000Z");
  assert.equal(revoked.blocked, true);
  assert.match(revoked.reason, /no current exact effect grant/);

  const second = await fixture(t);
  await updateTask({ root: second.root, id: "task:build", actorId: "agent:worker", patch: { status: "cancelled" } });
  const changedTask = await start(second.root);
  assert.equal(changedTask.failedClosed, true);
  assert.match(changedTask.error, /stale-execution-grant|task/);

  const third = await fixture(t);
  await writeFile(join(third.root, "foreign-change.txt"), "changed outside checkpoint\n", "utf8");
  const drift = packet(await start(third.root));
  assert.equal(drift.selfstarter.blocked, true);
  assert.equal(drift.selfstarter.reason, "workspace-changed-outside-checkpoint");

  const fourth = await fixture(t);
  const loaded = await loadSelfstarter(fourth.root);
  await writeFile(loaded.selfstarterPath, "{\"schema\":\"broken\"}\n", "utf8");
  const corrupt = await start(fourth.root);
  assert.equal(corrupt.failedClosed, true);
  assert.match(corrupt.error, /checkpoint structure is invalid/);
  const corruptAudit = await runAudit(fourth.root);
  assert.equal(corruptAudit.ok, false);
  assert.equal(corruptAudit.gates.find((gate) => gate.name === "Context privacy").ok, false);

  const fifth = await fixture(t);
  const tampered = await loadSelfstarter(fifth.root);
  tampered.state.receipts[0].details.checkpoint = "0".repeat(64);
  await writeFile(tampered.selfstarterPath, `${JSON.stringify(tampered.state)}\n`, "utf8");
  const tamperedStart = await start(fifth.root);
  assert.equal(tamperedStart.failedClosed, true);
  assert.match(tamperedStart.error, /invalid-job-receipt/);
});

test("leases prevent duplicate effects and recover a crash only when the workspace is unchanged", async (t) => {
  const { root } = await fixture(t, { leaseSeconds: 15 });
  const simultaneous = await Promise.all([
    start(root, "session:first", "2029-01-01T00:00:02.000Z"),
    start(root, "session:second", "2029-01-01T00:00:02.000Z")
  ]);
  assert.equal(simultaneous.filter((result) => packet(result).selfstarter?.active).length, 1);
  assert.equal(simultaneous.filter((result) => result.failedClosed).length, 1);
  const activeSession = (await loadSelfstarter(root)).state.jobs[0].lease.sessionId;
  await registerPremortem(root, activeSession);
  await authorize(root, activeSession, "tool:crash", "2029-01-01T00:00:03.000Z");
  const recovered = packet(await start(root, "session:recovered", "2029-01-01T00:00:18.000Z"));
  assert.equal(recovered.selfstarter.action, "resume");
  const recoveredState = (await loadSelfstarter(root)).state.jobs[0];
  assert.equal(recoveredState.checkpoint.retryCount, 1);
  assert.equal(recoveredState.pendingEffect, null);

  const changed = await fixture(t, { leaseSeconds: 15 });
  await start(changed.root, "session:crash", "2029-01-01T00:00:02.000Z");
  await registerPremortem(changed.root, "session:crash");
  await authorize(changed.root, "session:crash", "tool:unknown", "2029-01-01T00:00:03.000Z");
  await writeFile(join(changed.root, "unknown-effect.txt"), "possibly written before the crash\n", "utf8");
  const blocked = packet(await start(changed.root, "session:after-crash", "2029-01-01T00:00:18.000Z"));
  assert.equal(blocked.selfstarter.blocked, true);
  assert.equal(blocked.selfstarter.reason, "workspace-changed-after-uncheckpointed-effect");
});

test("retry budget, exponential checkpoint backoff, cancellation, and purge are durable", async (t) => {
  const { root } = await fixture(t, { maxRetries: 1 });
  await start(root);
  await registerPremortem(root, "session:one");
  await authorize(root, "session:one", "tool:fail-one", "2029-01-01T00:00:03.000Z");
  const failed = await checkpoint(root, "session:one", "tool:fail-one", "2029-01-01T00:00:04.000Z", false);
  assert.equal(failed.selfstarter.job.status, "blocked");
  assert.equal(failed.selfstarter.job.checkpoint.retryCount, 1);
  const early = packet(await start(root, "session:early", "2029-01-01T00:00:04.500Z"));
  assert.equal(early.selfstarter.reason, "retry-backoff-active");
  const resumed = packet(await start(root, "session:retry", "2029-01-01T00:00:05.000Z"));
  assert.equal(resumed.selfstarter.action, "resume");
  await registerPremortem(root, "session:retry", "2029-01-01T00:00:05.500Z");
  await authorize(root, "session:retry", "tool:fail-two", "2029-01-01T00:00:06.000Z");
  const exhausted = await checkpoint(root, "session:retry", "tool:fail-two", "2029-01-01T00:00:07.000Z", false);
  assert.equal(exhausted.selfstarter.job.status, "exhausted");
  assert.equal((await selfstarterContext({ root })).items[0].status, "exhausted");

  const cancellable = await fixture(t);
  const context = await selfstarterContext({ root: cancellable.root });
  assert.equal(context.items.length, 1);
  await deleteJob({ root: cancellable.root, id: "job:build", confirmation: "local-owner-confirmed" });
  const state = (await loadSelfstarter(cancellable.root)).state;
  assert.equal(state.jobs.length, 0);
  assert.equal(state.history.length, 0);
  assert.equal(state.receipts.length, 0);
});

test("workspace fingerprints are content-bound and reject symlink escapes", async (t) => {
  const { root } = await fixture(t);
  const before = await workspaceFingerprint(root);
  await writeFile(join(root, "ordinary.txt"), "one\n", "utf8");
  const after = await workspaceFingerprint(root);
  assert.notEqual(after.digest, before.digest);
  if (process.platform !== "win32") {
    const { symlink } = await import("node:fs/promises");
    const broken = join(root, "broken-link");
    await symlink(join(root, "missing-target"), broken);
    const withBrokenLink = await workspaceFingerprint(root);
    assert.ok(withBrokenLink.skipped.some((item) => item.path === broken && item.code === "ENOENT"));
    await symlink("/tmp", join(root, "outside-link"));
    await assert.rejects(workspaceFingerprint(root), /rejects symbolic link/);
  }
});

test("CLI keeps execution policy and job administration local and explicitly confirmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-selfstarter-cli-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "agentspine-selfstarter-cli-state-"));
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  t.after(async () => { await rm(root, { recursive: true }); await rm(stateRoot, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  for (const [id, kind] of [["person:owner", "person"], ["agent:worker", "agent"], ["project:cli", "project"]]) {
    await upsertEntity({ root, id, kind, privacy: "shared" });
  }
  await createTask({
    root, id: "task:cli", actorId: "agent:worker", assigneeId: "agent:worker",
    projectId: "project:cli", title: "CLI self-starter check", privacy: "private"
  });
  runCli([
    "execution-grant", "job:cli", "--id", "execution-grant:cli", "--actor", "agent:worker",
    "--task", "task:cli", "--target", "person:owner", "--project", "project:cli",
    "--host", "codex", "--capabilities", "tool:Write", "--reason", "Exact local CLI approval.",
    "--confirm-local-execution", "--root", root, "--json"
  ], stateRoot);
  runCli([
    "job-register", "job:cli", "--grant", "execution-grant:cli",
    "--confirm-local-execution", "--root", root, "--json"
  ], stateRoot);
  assert.equal(runCli(["jobs", root, "--json"], stateRoot).items[0].status, "waiting");
  assert.equal(runCli(["execution-policy", root, "--json"], stateRoot).grants[0].authority, "explicit-local-execution-policy");
  runCli([
    "execution-revoke", "execution-grant:cli", "--reason", "Owner stopped the run.",
    "--confirm-local-execution", "--root", root, "--json"
  ], stateRoot);
  runCli([
    "job-cancel", "job:cli", "--reason", "The job is no longer needed.",
    "--confirm-local-execution", "--root", root, "--json"
  ], stateRoot);
  runCli(["job-delete", "job:cli", "--confirm-local-execution", "--root", root, "--json"], stateRoot);
  assert.equal(runCli(["jobs", root, "--include-terminal", "--json"], stateRoot).items.length, 0);
});
