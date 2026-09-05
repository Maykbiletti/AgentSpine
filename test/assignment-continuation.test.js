import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { runHook } from "../src/hook.js";
import { deliveryPremortemPath, inspectPremortemState } from "../src/lib/delivery-premortem.js";
import { fixture, processCall } from "./mcp-bounded-fixture.js";
import { context, prompt, register, closure } from "./assignment-continuation-fixture.js";
import { prepareHookPremortem } from "../src/lib/hook-premortem.js";
import { resolveDeliveryAssignment } from "../src/lib/delivery-assignment.js";

test("explicit continuation keeps one obligation across turns, compaction and MCP restart", async t => {
  const f = await fixture(t, { homeRoot: false });
  await writeFile(`${f.root}/continuation-check.cjs`,
    "const assert = require('node:assert/strict');\n"
    + "const fs = require('node:fs');\n"
    + "require('node:test')('artifact matches expected output', () => {\n"
    + "  assert.equal(fs.readFileSync('artifact.txt', 'utf8'), process.env.EXPECTED_CONTENT);\n"
    + "});\n");
  const measuredTest = async (expected, id) => {
    const env = { ...process.env, EXPECTED_CONTENT: expected };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "continuation-check.cjs"],
      { cwd: f.root, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 1\b/);
    assert.match(result.stdout, /# fail 0\b/);
    return runHook({ ...context(f.root), hook_event_name: "PostToolUse", tool_name: "exec_command",
      tool_use_id: id, tool_input: { cmd: "node --test --test-reporter=tap continuation-check.cjs" },
      tool_response: { exit_code: result.status, output: result.stdout } });
  };
  const first = await prompt(f.root, "prompt:first");
  const artifact = await register(f.root, first.requirementId);
  const inspection = await inspectPremortemState({ root: f.root, requirementId: first.requirementId });
  const statePath = await deliveryPremortemPath({ root: f.root, binding: inspection.binding });
  const frozen = await readFile(statePath);
  const continued = await prompt(f.root, "prompt:second", { assignment_id: first.assignmentId });
  assert.equal(continued.requirementId, first.requirementId);
  assert.equal(continued.assignmentId, first.assignmentId);
  assert.deepEqual(await readFile(statePath), frozen);
  await runHook({ ...context(f.root), hook_event_name: "PostCompact" });
  const restarted = await processCall(f.root, "record_delivery_premortem",
    { root: f.root, requirementId: first.requirementId, items: artifact.items.map(({ checkId, ...item }) => item) });
  assert.equal(restarted.status, "duplicate");
  const third = await prompt(f.root, "prompt:third", { assignmentId: first.assignmentId });
  assert.equal(third.requirementId, first.requirementId);
  const input = { ...context(f.root), tool_name: "Write", tool_use_id: "write:continued",
    tool_input: { file_path: "artifact.txt", content: "continued\n" } };
  const allowed = await runHook({ ...input, hook_event_name: "PreToolUse" });
  assert.equal(allowed.blocked, false);
  await writeFile(`${f.root}/artifact.txt`, "continued\n");
  const post = await runHook({ ...input, hook_event_name: "PostToolUse", success: true });
  const openWriteState = await readFile(statePath);
  const supplement = await prompt(f.root, "prompt:supplement-after-write", { assignment_id: first.assignmentId });
  assert.equal(supplement.requirementId, first.requirementId);
  assert.deepEqual(await readFile(statePath), openWriteState);
  const untested = await runHook({ ...context(f.root), hook_event_name: "Stop",
    final_assistant_message: closure(artifact, post.premortem.writeDigest) });
  assert.equal(untested.blocked, true, "supplement must preserve the open test obligation");
  await measuredTest("continued\n", "test:continued");
  const stopped = await runHook({ ...context(f.root), hook_event_name: "Stop",
    final_assistant_message: closure(artifact, post.premortem.writeDigest) });
  assert.equal(stopped.blocked, false);
  assert.equal(stopped.premortem.status, "closed");
  const replay = await prompt(f.root, "prompt:completed-replay", { assignment_id: first.assignmentId });
  assert.equal(replay.blocked, true);
  assert.equal(replay.status, "finalized");
  const next = await prompt(f.root, "prompt:new-delivery");
  assert.notEqual(next.requirementId, first.requirementId);
  const blocked = await runHook({ ...input, hook_event_name: "PreToolUse", tool_use_id: "write:new" });
  assert.equal(blocked.blocked, true);
  const secondArtifact = await register(f.root, next.requirementId);
  const secondInput = { ...input, tool_use_id: "write:second-delivery",
    tool_input: { file_path: "artifact.txt", content: "second delivery\n" } };
  assert.equal((await runHook({ ...secondInput, hook_event_name: "PreToolUse" })).blocked, false);
  await writeFile(`${f.root}/artifact.txt`, "second delivery\n");
  const secondPost = await runHook({ ...secondInput, hook_event_name: "PostToolUse", success: true });
  const premature = await runHook({ ...context(f.root), hook_event_name: "Stop",
    final_assistant_message: closure(secondArtifact, secondPost.premortem.writeDigest) });
  assert.equal(premature.blocked, true, "first delivery's test must not satisfy the second write");
  await measuredTest("second delivery\n", "test:second-delivery");
  const secondStop = await runHook({ ...context(f.root), hook_event_name: "Stop",
    final_assistant_message: closure(secondArtifact, secondPost.premortem.writeDigest) });
  assert.equal(secondStop.blocked, false);
  assert.equal(secondStop.premortem.status, "closed");
  await f.preserve();
});

test("foreign, omitted and contradictory continuation scope cannot replace the valid assignment", async t => {
  const f = await fixture(t, { homeRoot: false });
  const scope = { host: "codex", projectId: "project:scope", entityId: "agent:synthetic",
    groupId: "group:synthetic", currentTaskId: "task:synthetic" };
  const input = { session_id: "session:scope", event_id: "prompt:scope" };
  const prepared = await prepareHookPremortem({ root: f.root, scope, input });
  const path = await deliveryPremortemPath({ root: f.root, binding: prepared.requirement.binding });
  const frozen = await readFile(path);
  for (const key of ["host", "projectId", "entityId", "groupId", "currentTaskId"]) {
    for (const value of ["foreign:synthetic", null]) {
      const result = await prepareHookPremortem({ root: f.root, scope: { ...scope, [key]: value },
        input: { ...input, event_id: `prompt:${key}:${value}`, assignment_id: prepared.assignmentId } });
      // Missing host is parser uncertainty; it must still produce no requirement.
      assert.ok(result.blocked || result.status === "degraded", JSON.stringify(result));
      assert.equal(result.requirement, undefined);
    }
  }
  const foreign = await prepareHookPremortem({ root: f.root, scope,
    input: { ...input, session_id: "session:foreign", assignment_id: prepared.assignmentId } });
  assert.equal(foreign.blocked, true);
  const aliases = await prepareHookPremortem({ root: f.root, scope,
    input: { ...input, assignment_id: prepared.assignmentId, assignmentId: `assignment:${"a".repeat(64)}` } });
  assert.equal(aliases.blocked, true);
  const valid = await prepareHookPremortem({ root: f.root, scope,
    input: { ...input, event_id: "prompt:valid-continuation", assignment_id: prepared.assignmentId } });
  assert.equal(valid.requirementId, prepared.requirementId);
  assert.deepEqual(await readFile(path), frozen);
  await f.preserve();
});

test("a goal continuation cannot select another step, queue or plan", async t => {
  const f = await fixture(t, { homeRoot: false });
  const scope = { host: "codex", projectId: "project:goal", goalId: "goal:synthetic",
    goalStepId: "step:first", queueId: "queue:synthetic", gatewayAttempt: 1,
    planDefinitionsDigest: "a".repeat(64) };
  const input = { session_id: "session:goal", event_id: "prompt:goal" };
  const first = await prepareHookPremortem({ root: f.root, scope, input });
  assert.equal(first.blocked, false);
  const same = await prepareHookPremortem({ root: f.root, scope,
    input: { ...input, event_id: "prompt:goal-continue", assignment_id: first.assignmentId } });
  assert.equal(same.requirementId, first.requirementId);
  for (const [key, value] of Object.entries({ goalId: "goal:other", goalStepId: "step:other",
    queueId: "queue:other", gatewayAttempt: 2, planDefinitionsDigest: "b".repeat(64) })) {
    const rejected = await prepareHookPremortem({ root: f.root, scope: { ...scope, [key]: value },
      input: { ...input, assignment_id: first.assignmentId } });
    assert.equal(rejected.blocked, true, key);
    assert.equal(rejected.status, "foreign-assignment", key);
  }
  await f.preserve();
});

test("parallel continuation and a new prompt serialize without reactivating old receipts", async t => {
  const f = await fixture(t, { homeRoot: false });
  const a = await prompt(f.root, "prompt:race-a");
  const [continued, next] = await Promise.all([
    prompt(f.root, "prompt:race-continue", { assignment_id: a.assignmentId }),
    prompt(f.root, "prompt:race-new")
  ]);
  assert.equal(next.blocked, false);
  assert.ok(continued.blocked || continued.requirementId === a.requirementId);
  const current = await resolveDeliveryAssignment({ root: f.root, binding: next.requirement.binding });
  assert.equal(current.assignmentId, next.assignmentId);
  const stale = await prompt(f.root, "prompt:race-replay", { assignment_id: a.assignmentId });
  assert.equal(stale.blocked, true);
  const missing = await prompt(f.root, "prompt:no-artifact", { assignment_id: next.assignmentId });
  assert.equal(missing.requirementId, next.requirementId);
  const blocked = await runHook({ ...context(f.root), hook_event_name: "PreToolUse",
    tool_name: "Write", tool_use_id: "write:missing-artifact",
    tool_input: { file_path: "target.js", content: "synthetic" } });
  assert.equal(blocked.blocked, true);
  await f.preserve();
});
