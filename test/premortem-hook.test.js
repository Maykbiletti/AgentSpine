import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blunRuntimeContext, blunRuntimeMessage, runHook } from "../src/hook.js";
import { gatewayEnvironmentContext } from "../src/lib/hook-context.js";
import { createTask } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import {
  deliveryPremortemPath, inspectPremortemState, recordDeliveryPremortem
} from "../src/lib/delivery-premortem.js";
import {
  recordDeliveryBriefingUse, recordDeliveryKnowledgeUse
} from "../src/lib/delivery-agent-usage.js";
import { hookScanAuditPath } from "../src/lib/hook-audit.js";
import { premortemBinding } from "../src/lib/hook-premortem.js";
import { canonicalPath } from "../src/lib/paths.js";

const PROJECT_ID = "project:premortem-hook";
const HOOK_PATH = fileURLToPath(new URL("../src/hook.js", import.meta.url));

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-premortem-hook-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  const source = "# Synthetic delivery rules\n\nKeep this source byte-exact.\n";
  await writeFile(join(root, "AGENTS.md"), source, "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  return { root, source, state };
}

function common(root, session, scope = {}) {
  return {
    host: "codex", cwd: root, session_id: session,
    agent_spine_scope: { project_id: PROJECT_ID, ...scope }
  };
}

async function prepare(root, session) {
  return runHook({
    ...common(root, session), hook_event_name: "UserPromptSubmit",
    event_id: `prompt:${session}`, prompt: "Change the synthetic artifact safely."
  });
}

function items() {
  return [
    { category: "baseline-environment",
      failure: "this delivery fails because the baseline is stale",
      check: "Compare the current synthetic snapshot digest." },
    { category: "contract-tests",
      failure: "this delivery fails because the contract regresses",
      check: "Run the focused synthetic Node test." },
    { category: "delivery-path",
      failure: "this delivery fails because the artifact is misplaced",
      check: "Verify the synthetic artifact path and digest." }
  ];
}

async function recordPreparedPremortem(root, requirementId) {
  await recordDeliveryBriefingUse({ root, requirementId,
    input: { root }, result: { schema: "synthetic-briefing" } });
  await recordDeliveryKnowledgeUse({ root, requirementId,
    input: { targets: ["synthetic"] }, result: { schema: "synthetic-knowledge" } });
  return recordDeliveryPremortem({ root, requirementId, items: items() });
}

function preWrite(root, session, id = `write:${session}`) {
  return {
    ...common(root, session), hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: id, tool_input: { file_path: "artifact.txt", content: "synthetic\n" }
  };
}

async function post(root, session, toolName, toolInput, id, scope = {}) {
  return runHook({
    ...common(root, session, scope), hook_event_name: "PostToolUse", tool_name: toolName,
    tool_use_id: id, tool_input: toolInput, success: true,
    tool_response: toolName === "exec_command" ? { exit_code: 0 } : { ok: true }
  });
}

function closure(artifact, writeDigest) {
  return [
    `Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) => `- ${item.category} ${item.checkId}: PASS — synthetic check passed`)
  ].join("\n");
}

async function assertGatewayDenied(promise, expression) {
  const result = await promise;
  assert.equal(result.blocked, true);
  assert.match(result.reason, expression);
}

function installedHook(root, state, input) {
  const env = { ...process.env, AGENTSPINE_STATE_DIR: state };
  delete env.BLUN_PLUGIN_ROOT;
  delete env.AGENTSPINE_GATEWAY_CONTEXT;
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: root, env, encoding: "utf8", input: JSON.stringify(input)
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("gateway context carries the exact queue and goal-step binding", () => {
  const digest = "a".repeat(64);
  const context = gatewayEnvironmentContext({
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_HOST: "codex",
    AGENTSPINE_ENTITY_ID: "agent:synthetic", AGENTSPINE_PROJECT_ID: PROJECT_ID,
    AGENTSPINE_GATEWAY_QUEUE_ID: "queue:synthetic", AGENTSPINE_GOAL_ID: "goal:synthetic",
    AGENTSPINE_GOAL_STEP_ID: "step:synthetic", AGENTSPINE_PLAN_DEFINITIONS_DIGEST: digest,
    AGENTSPINE_GATEWAY_ATTEMPT: "2"
  });
  assert.equal(context.host, "codex");
  assert.equal(context.queueId, "queue:synthetic");
  assert.equal(context.goalId, "goal:synthetic");
  assert.equal(context.goalStepId, "step:synthetic");
  assert.equal(context.planDefinitionsDigest, digest);
  assert.equal(context.gatewayAttempt, 2);
  assert.throws(() => gatewayEnvironmentContext({
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_GATEWAY_ATTEMPT: "0"
  }), /AGENTSPINE_GATEWAY_ATTEMPT is invalid/);
  assert.throws(() => gatewayEnvironmentContext({
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_GATEWAY_ATTEMPT: "02"
  }), /AGENTSPINE_GATEWAY_ATTEMPT is invalid/);
});

test("authenticated gateway scope rejects every conflicting hook payload field", async (t) => {
  const { root } = await fixture(t);
  const values = {
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_HOST: "codex",
    AGENTSPINE_ENTITY_ID: "agent:trusted", AGENTSPINE_GROUP_ID: "group:trusted",
    AGENTSPINE_PROJECT_ID: PROJECT_ID, AGENTSPINE_TASK_ID: "task:trusted",
    AGENTSPINE_GATEWAY_QUEUE_ID: "queue:trusted", AGENTSPINE_GOAL_ID: "goal:trusted",
    AGENTSPINE_GOAL_STEP_ID: "step:trusted", AGENTSPINE_PLAN_DEFINITIONS_DIGEST: "b".repeat(64),
    AGENTSPINE_GATEWAY_ATTEMPT: "3"
  };
  const environmentKeys = Object.keys(values);
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const matching = {
    project_id: PROJECT_ID, entity_id: "agent:trusted", group_id: "group:trusted",
    task_id: "task:trusted",
    queue_id: "queue:trusted", goal_id: "goal:trusted", goal_step_id: "step:trusted",
    plan_definitions_digest: "b".repeat(64), gateway_attempt: 3
  };
  const matched = await runHook({
    ...preWrite(root, "session:gateway-matching"), agent_spine_scope: matching
  });
  assert.equal(matched.premortem.status, "missing-briefing");
  for (const [field, value, expected] of [
    ["entity_id", "agent:poisoned", "entityId"],
    ["group_id", "group:poisoned", "groupId"],
    ["project_id", "project:poisoned", "projectId"],
    ["task_id", "task:poisoned", "currentTaskId"],
    ["queue_id", "queue:poisoned", "queueId"],
    ["goal_id", "goal:poisoned", "goalId"],
    ["goal_step_id", "step:poisoned", "goalStepId"],
    ["plan_definitions_digest", "c".repeat(64), "planDefinitionsDigest"],
    ["gateway_attempt", 4, "gatewayAttempt"]
  ]) {
    await assertGatewayDenied(runHook({
      ...preWrite(root, `session:gateway-mismatch:${expected}`),
      agent_spine_scope: { ...matching, [field]: value }
    }), new RegExp(`${expected} does not match the authenticated gateway binding`));
  }
  await assertGatewayDenied(runHook({
    ...preWrite(root, "session:gateway-host-mismatch"), host: "claude",
    agent_spine_scope: matching
  }), /host does not match the authenticated gateway binding/);
  for (const key of ["AGENTSPINE_TASK_ID", "AGENTSPINE_GROUP_ID", "AGENTSPINE_GOAL_ID",
    "AGENTSPINE_GOAL_STEP_ID", "AGENTSPINE_PLAN_DEFINITIONS_DIGEST"]) delete process.env[key];
  const nonGoal = {
    project_id: PROJECT_ID, entity_id: "agent:trusted",
    queue_id: "queue:trusted", gateway_attempt: 3
  };
  for (const [field, value, expected] of [
    ["group_id", "group:injected", "groupId"],
    ["goal_id", "goal:injected", "goalId"],
    ["goal_step_id", "step:injected", "goalStepId"],
    ["plan_definitions_digest", "e".repeat(64), "planDefinitionsDigest"]
  ]) await assertGatewayDenied(runHook({
    ...preWrite(root, `session:gateway-absence:${expected}`),
    agent_spine_scope: { ...nonGoal, [field]: value }
  }), new RegExp(`${expected} does not match the authenticated gateway binding`));
  const hostTask = await runHook({
    ...preWrite(root, "session:gateway-host-task"),
    agent_spine_scope: { ...nonGoal, task_id: "task:host-supplied" }
  });
  assert.equal(hostTask.premortem.status, "missing-briefing",
    "a gateway field absent from the environment remains host-supplied");
});

test("goal retry attempt is immutable in the premortem lane", () => {
  const binding = premortemBinding({ session_id: "session:attempt" }, {
    host: "codex", projectId: PROJECT_ID, goalId: "goal:attempt",
    goalStepId: "step:attempt", queueId: "queue:attempt",
    planDefinitionsDigest: "d".repeat(64), gatewayAttempt: 5
  });
  assert.equal(binding.gatewayAttempt, 5);
});

test("first write blocks on a verified missing premortem", async (t) => {
  const { root, source } = await fixture(t);
  const result = await runHook(preWrite(root, "session:missing"));
  assert.equal(result.blocked, true);
  assert.equal(result.premortem.status, "missing-briefing");
  assert.match(result.reason, /stage 1: session_briefing/);
  const requirementId = result.premortem.requirementId;
  const recorded = await recordPreparedPremortem(root, requirementId);
  assert.equal(recorded.blocked, false, "the first-write denial must prepare a usable requirement");
  assert.equal((await runHook(preWrite(root, "session:missing", "write:missing:retry"))).blocked, false);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("a premortem follows its session across turns but not into another session", async (t) => {
  const { root } = await fixture(t);
  const session = "session:cross-turn";
  const prompted = await runHook({
    ...common(root, session), turn_id: "turn:prepare", hook_event_name: "UserPromptSubmit",
    event_id: "prompt:cross-turn", prompt: "Change the synthetic artifact safely."
  });
  const recorded = await recordPreparedPremortem(root,
    prompted.preflight.premortem.requirementId);
  assert.equal(recorded.blocked, false);
  const allowed = await runHook({
    ...preWrite(root, session), turn_id: "turn:write"
  });
  assert.equal(allowed.blocked, false);
  const foreign = await runHook({
    ...preWrite(root, "session:foreign"), turn_id: "turn:write"
  });
  assert.equal(foreign.blocked, true);
  assert.match(foreign.reason, /stage 1: session_briefing/);
});

test("premortem before the first write and three closed checks allow Stop", async (t) => {
  const { root, source } = await fixture(t);
  const session = "session:closed";
  const prompted = await prepare(root, session);
  assert.equal(prompted.blocked, false);
  const requirement = prompted.preflight.premortem;
  assert.match(requirement.instruction, /Premortem closure sha256 <64hex>/);
  const recorded = await recordPreparedPremortem(root, requirement.requirementId);
  assert.equal(recorded.blocked, false);
  assert.equal((await runHook(preWrite(root, session))).blocked, false);
  await writeFile(join(root, "artifact.txt"), "synthetic\n", "utf8");
  const written = await post(root, session, "Write",
    { file_path: "artifact.txt", content: "synthetic\n" }, `write:${session}`);
  assert.equal(written.premortem.status, "write-recorded");
  await post(root, session, "exec_command", { cmd: "node --test test/synthetic.test.js" }, `test:${session}`);
  const stopped = await runHook({
    ...common(root, session), hook_event_name: "Stop", event_id: `stop:${session}`,
    final_assistant_message: closure(recorded.artifact, written.premortem.writeDigest)
  });
  assert.equal(stopped.blocked, false);
  assert.equal(stopped.deliveryVerification.status, "verified");
  assert.equal(stopped.premortem.status, "closed");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("installed PostToolUse exposes the latest write digest beside identifier warnings", async (t) => {
  const { root, state } = await fixture(t);
  const session = "session:installed-receipt";
  const before = "legacyAction();\n";
  const after = `${before}const changed = true;\n`;
  await writeFile(join(root, "artifact.js"), before, "utf8");
  const prompted = await prepare(root, session);
  const recorded = await recordPreparedPremortem(root,
    prompted.preflight.premortem.requirementId);
  const edit = { file_path: "artifact.js", old_string: before, new_string: after };
  const commonInput = {
    ...common(root, session), tool_name: "Edit", tool_use_id: "write:installed-receipt", tool_input: edit
  };
  assert.equal((await runHook({ ...commonInput, hook_event_name: "PreToolUse" })).blocked, false);
  await writeFile(join(root, "artifact.js"), after, "utf8");
  const postOutput = installedHook(root, state, {
    ...commonInput, hook_event_name: "PostToolUse", success: true, tool_response: { ok: true }
  });
  const notice = postOutput.hookSpecificOutput.additionalContext;
  assert.match(notice, /pre-existing undeclared-call warning/);
  assert.match(notice, /artifact\.js:1: legacyAction/);
  const writeDigest = notice.match(/Premortem latest write sha256 ([a-f0-9]{64})/)?.[1];
  assert.equal(typeof writeDigest, "string");
  installedHook(root, state, {
    ...common(root, session), hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "test:installed-receipt", tool_input: { cmd: "node --test test/synthetic.test.js" },
    success: true, tool_response: { exit_code: 0 }
  });
  const stopped = installedHook(root, state, {
    ...common(root, session), hook_event_name: "Stop", event_id: "stop:installed-receipt",
    final_assistant_message: closure(recorded.artifact, writeDigest)
  });
  assert.equal(stopped.decision, undefined);
});

test("a premortem registered after the first actual write stays blocked", async (t) => {
  const { root } = await fixture(t);
  const session = "session:late";
  const prompted = await prepare(root, session);
  await post(root, session, "Write", { file_path: "artifact.txt", content: "late\n" }, `write:${session}`);
  const recorded = await recordPreparedPremortem(root,
    prompted.preflight.premortem.requirementId);
  assert.equal(recorded.status, "late");
  const denied = await runHook(preWrite(root, session, "write:late:second"));
  assert.equal(denied.blocked, true);
  assert.equal(denied.premortem.status, "late");
  assert.match(denied.reason, /recorded after the first write/);
});

test("read-only Stop passes without creating a premortem", async (t) => {
  const { root, source } = await fixture(t);
  const result = await runHook({
    ...common(root, "session:read-only"), hook_event_name: "Stop", event_id: "stop:read-only",
    final_assistant_message: "Synthetic read-only answer."
  });
  assert.equal(result.blocked, false);
  assert.equal(result.deliveryVerification.status, "no-write");
  assert.equal(result.premortem.status, "no-write");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("unknown final-message transport fails open but a known empty message blocks", async (t) => {
  const { root, state } = await fixture(t);
  const session = "session:message-transport";
  const prompted = await prepare(root, session);
  const recorded = await recordPreparedPremortem(root,
    prompted.preflight.premortem.requirementId);
  assert.equal(recorded.blocked, false);
  const writeInput = { file_path: "artifact.txt", content: "synthetic\n" };
  assert.equal((await runHook({
    ...preWrite(root, session), tool_input: writeInput, tool_use_id: "write:message-transport"
  })).blocked, false);
  await writeFile(join(root, "artifact.txt"), "synthetic\n", "utf8");
  await post(root, session, "Write", writeInput, "write:message-transport");
  await post(root, session, "exec_command",
    { cmd: "node --test test/synthetic.test.js" }, "test:message-transport");
  const uncertain = await runHook({
    ...common(root, session), hook_event_name: "Stop", event_id: "stop:unknown-message",
    unrecognized_completion_text: "Claims all premortem checks passed."
  });
  assert.equal(uncertain.blocked, false);
  assert.equal(uncertain.premortem.status, "degraded");
  assert.match(uncertain.premortem.reason, /final assistant message is unavailable/);
  const audit = (await readFile(hookScanAuditPath({ ...process.env, AGENTSPINE_STATE_DIR: state }), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(audit.some((item) => item.phase === "premortem-stop" && item.decision === "allow"), true);
  const verifiedEmpty = await runHook({
    ...common(root, session), hook_event_name: "Stop", event_id: "stop:known-empty",
    final_assistant_message: ""
  });
  assert.equal(verifiedEmpty.blocked, true);
  assert.equal(verifiedEmpty.premortem.status, "unchecked");
});

test("read-only Session B is not mistaken for Session A on the same task lane", async (t) => {
  const { root } = await fixture(t);
  const lane = { entity_id: "agent:synthetic", task_id: "task:shared" };
  await upsertEntity({ root, id: "agent:synthetic", kind: "agent", privacy: "shared" });
  await upsertEntity({ root, id: PROJECT_ID, kind: "project", privacy: "shared" });
  await createTask({ root, id: "task:shared", actorId: "agent:synthetic",
    assigneeId: "agent:synthetic", projectId: PROJECT_ID, title: "Synthetic shared task", privacy: "shared" });
  const session = "session:writer-a";
  const prompted = await runHook({
    ...common(root, session, { entity_id: lane.entity_id }), hook_event_name: "UserPromptSubmit",
    event_id: "prompt:writer-a", prompt: "Write the synthetic artifact."
  });
  const recorded = await recordPreparedPremortem(root,
    prompted.preflight.premortem.requirementId);
  const writeInput = { file_path: "artifact.txt", content: "synthetic\n" };
  assert.equal((await runHook({
    ...common(root, session, lane), hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "write:writer-a", tool_input: writeInput
  })).blocked, false);
  await post(root, session, "Write", writeInput, "write:writer-a", lane);
  await runHook({
    ...common(root, session, lane), hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "test:writer-a", tool_input: { cmd: "node --test test/synthetic.test.js" },
    success: true, tool_response: { exit_code: 0 }
  });
  const reader = await runHook({
    ...common(root, "session:reader-b", lane), hook_event_name: "Stop", event_id: "stop:reader-b",
    final_assistant_message: "Synthetic read-only answer."
  });
  assert.equal(reader.deliveryVerification.status, "no-write",
    "a read-only sibling session cannot reuse another session's write or test evidence");
  assert.equal(reader.premortem.status, "no-write");
  assert.equal(reader.blocked, false);
  assert.equal(recorded.blocked, false);
});

test("selfstarter task discovery cannot change the session premortem lane", async (t) => {
  const { root } = await fixture(t);
  const session = "session:task-drift";
  const prompted = await prepare(root, session);
  const recorded = await recordPreparedPremortem(root,
    prompted.preflight.premortem.requirementId);
  const allowed = await runHook({
    ...preWrite(root, session),
    agent_spine_scope: { project_id: PROJECT_ID, task_id: "task:discovered-after-prompt" }
  });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.requirementId, prompted.preflight.premortem.requirementId);
  assert.equal(recorded.blocked, false);
});

test("normal and condensed BLUN prompt context expose the exact requirement", async (t) => {
  const { root } = await fixture(t);
  const canonicalRoot = await canonicalPath(root);
  const result = await prepare(root, "session:visibility");
  const detailed = JSON.parse(result.context);
  assert.equal(detailed.preflight.premortem.requirementId,
    result.preflight.premortem.requirementId);
  assert.match(detailed.preflight.premortem.instruction,
    /- <category> <checkId>: PASS — <nonempty result>/);
  assert.deepEqual(detailed.preflight.premortem.registration, {
    tool: "record_delivery_premortem", root: canonicalRoot,
    requirementId: result.preflight.premortem.requirementId
  });
  const compact = blunRuntimeMessage(result.context);
  assert.match(compact, /Before the first Write\/Edit\/apply_patch/);
  assert.match(compact, new RegExp(result.preflight.premortem.requirementId));
  assert.equal(compact.includes(`root ${JSON.stringify(canonicalRoot)}`), true);
  assert.deepEqual(JSON.parse(blunRuntimeContext(result.context)).premortem.registration,
    detailed.preflight.premortem.registration);
});

test("nested cwd receives the project root needed to register and retry", async (t) => {
  const { root } = await fixture(t);
  const canonicalRoot = await canonicalPath(root);
  const nested = join(root, "packages", "synthetic");
  await mkdir(nested, { recursive: true });
  const session = "session:nested-cwd";
  const prompted = await runHook({
    ...common(root, session), cwd: nested, hook_event_name: "UserPromptSubmit",
    event_id: "prompt:nested-cwd", prompt: "Change the nested synthetic artifact."
  });
  const registration = prompted.preflight.premortem.registration;
  assert.deepEqual(registration, {
    tool: "record_delivery_premortem", root: canonicalRoot,
    requirementId: prompted.preflight.premortem.requirementId
  });
  const recorded = await recordPreparedPremortem(registration.root, registration.requirementId);
  assert.equal(recorded.blocked, false);
  const allowed = await runHook({
    ...common(root, session), cwd: nested, hook_event_name: "PreToolUse", tool_name: "Edit",
    tool_use_id: "write:nested-cwd", tool_input: {
      file_path: "artifact.txt", old_string: "before", new_string: "after"
    }
  });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.requirementId, registration.requirementId);
});

test("malformed premortem state is audited and fails open", async (t) => {
  const { root, state } = await fixture(t);
  const session = "session:uncertain";
  const result = await prepare(root, session);
  const binding = (await inspectPremortemState({ root,
    requirementId: result.preflight.premortem.requirementId })).binding;
  const path = await deliveryPremortemPath({ root, binding });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{not-json\n", "utf8");
  const allowed = await runHook(preWrite(root, session));
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.status, "degraded");
  assert.match(allowed.premortem.reason, /valid JSON/);
  const audit = (await readFile(hookScanAuditPath({ ...process.env, AGENTSPINE_STATE_DIR: state }), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(audit.some((item) => item.phase === "premortem-before-write"
    && item.decision === "allow"), true);
  assert.equal(result.blocked, false);
});
