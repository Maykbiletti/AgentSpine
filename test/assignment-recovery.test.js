import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/hook.js";
import { beginDeliveryAssignment, resolveDeliveryAssignment } from "../src/lib/delivery-assignment.js";
import { deliveryPremortemPath, inspectPremortemState,
  preparePremortemRequirement } from "../src/lib/delivery-premortem.js";
import { inspectPremortemRegistrationRejection } from "../src/lib/delivery-premortem-rejection.js";
import { client, fixture } from "./mcp-bounded-fixture.js";

const PROJECT = "project:assignment-recovery";
const CLI = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
const ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the assignment baseline moved",
    check: "Compare the frozen assignment baseline." },
  { category: "contract-tests",
    failure: "this delivery fails because assignment isolation regressed",
    check: "Run the assignment recovery regression." },
  { category: "delivery-path",
    failure: "this delivery fails because the corrected delivery cannot finish",
    check: "Exercise Hook, MCP, and CLI recovery." }
];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function reseal(value, key = "digest") {
  const material = { ...value };
  delete material[key];
  value[key] = hash(material);
}

function context(root, session, taskId) {
  return { host: "codex", cwd: root, session_id: session,
    agent_spine_scope: { project_id: PROJECT,
      ...(taskId ? { task_id: taskId } : {}) } };
}

async function prompt(root, session, taskId, eventId) {
  return runHook({ ...context(root, session, taskId),
    hook_event_name: "UserPromptSubmit", event_id: eventId,
    prompt: `Complete ${taskId} with measured checks.` });
}

async function register(call, root, requirementId, items = ITEMS) {
  const briefing = await call("session_briefing", { root, host: "codex", requirementId,
    includeSourceContent: false, maxBytes: 4096 });
  assert.equal(briefing.isError, false, JSON.stringify(briefing));
  assert.equal(briefing.deliveryUseReceipt.blocked, false);
  const knowledge = await call("delivery_knowledge_query", { root, requirementId,
    targetPaths: ["target.js"], contractPaths: ["AGENTS.md"],
    recentErrorTerms: ["assignment", "recovery"], maxBytes: 4096 });
  assert.equal(knowledge.isError, false, JSON.stringify(knowledge));
  assert.equal(knowledge.deliveryUseReceipt.blocked, false);
  return call("record_delivery_premortem", { root, requirementId, items });
}

function closure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map(item => `- ${item.category} ${item.checkId}: PASS — synthetic recovery check passed`)
  ].join("\n");
}

async function complete(root, session, taskId, registered, suffix) {
  const writeInput = { file_path: "artifact.txt", content: `${suffix}\n` };
  const pre = await runHook({ ...context(root, session, taskId),
    hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: `write:${suffix}`, tool_input: writeInput });
  assert.equal(pre.blocked, false);
  await writeFile(`${root}/artifact.txt`, `${suffix}\n`);
  const post = await runHook({ ...context(root, session, taskId),
    hook_event_name: "PostToolUse", tool_name: "Write",
    tool_use_id: `write:${suffix}`, tool_input: writeInput,
    success: true, tool_response: { ok: true } });
  await runHook({ ...context(root, session, taskId),
    hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: `test:${suffix}`, tool_input: { cmd: "node --test test/synthetic.test.js" },
    success: true, tool_response: { ok: true } });
  const stopped = await runHook({ ...context(root, session, taskId),
    hook_event_name: "Stop", event_id: `stop:${suffix}`,
    final_assistant_message: closure(registered.artifact, post.premortem.writeDigest) });
  assert.equal(stopped.blocked, false);
  assert.equal(stopped.premortem.status, "closed");
}

test("new assignments isolate receipts and a rejected registration cannot poison either delivery", async t => {
  const f = await fixture(t, { homeRoot: false });
  const call = client();
  const session = "session:two-assignments";
  const a = await prompt(f.root, session, null, "prompt:a");
  const registeredA = await register(call, f.root, a.preflight.premortem.requirementId);
  assert.equal(registeredA.blocked, false);
  await complete(f.root, session, null, registeredA, "a");
  const preservedA = await inspectPremortemState({ root: f.root,
    requirementId: a.preflight.premortem.requirementId });

  const b = await prompt(f.root, session, null, "prompt:b");
  assert.notEqual(b.preflight.premortem.assignmentId, a.preflight.premortem.assignmentId);
  assert.notEqual(b.preflight.premortem.requirementId, a.preflight.premortem.requirementId);
  const registeredB = await register(call, f.root, b.preflight.premortem.requirementId);
  const changed = structuredClone(ITEMS);
  changed[1].check = "A contradictory synthetic check must be rejected.";
  const wrong = await call("record_delivery_premortem", { root: f.root,
    requirementId: b.preflight.premortem.requirementId, items: changed });
  assert.equal(wrong.status, "conflict");
  assert.equal(wrong.isError, true);
  const currentB = await inspectPremortemState({ root: f.root,
    requirementId: b.preflight.premortem.requirementId });
  assert.equal(currentB.conflicted, false);
  assert.equal(currentB.artifactDigest, registeredB.artifact.digest);
  const rejection = await inspectPremortemRegistrationRejection({ root: f.root,
    laneDigest: currentB.laneDigest, digest: wrong.rejection.digest });
  assert.equal(rejection.priorArtifactDigest, registeredB.artifact.digest);
  const corrected = await call("record_delivery_premortem", { root: f.root,
    requirementId: b.preflight.premortem.requirementId, items: ITEMS });
  assert.equal(corrected.status, "duplicate");
  assert.deepEqual(await inspectPremortemState({ root: f.root,
    requirementId: a.preflight.premortem.requirementId }), preservedA);
  await complete(f.root, session, null, registeredB, "b");
  await f.preserve();
});

test("CLI recovers a preserved 0.72 conflict into a fresh assignment and MCP can continue", async t => {
  const f = await fixture(t, { homeRoot: false });
  const call = client();
  const binding = { host: "codex", sessionId: "session:legacy-conflict",
    projectId: PROJECT };
  const prepared = await preparePremortemRequirement({ root: f.root, binding });
  const registered = await register(call, f.root, prepared.requirementId);
  assert.equal(registered.blocked, false);
  const path = await deliveryPremortemPath({ root: f.root, binding });
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.conflict = hash({ prior: legacy.artifact.digest, proposed: hash("legacy-wrong") });
  const event = { schema: "agentspine.delivery-premortem-event/v1", type: "artifact-conflict",
    at: "2034-01-01T00:00:00.000Z", sequence: legacy.revision + 1,
    payloadDigest: hash({ conflict: legacy.conflict }), authority: "context-only" };
  reseal(event);
  legacy.events.push(event);
  legacy.revision += 1;
  reseal(legacy, "integrityDigest");
  await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);
  const frozenLegacy = await readFile(path);

  const result = spawnSync(process.execPath, [CLI, "premortem-recover", prepared.requirementId,
    "--root", f.root, "--json"],
  { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr);
  const recovered = JSON.parse(result.stdout);
  assert.equal(recovered.status, "recovered");
  assert.notEqual(recovered.requirementId, prepared.requirementId);
  assert.deepEqual(await readFile(path), frozenLegacy);
  const newRegistration = await register(call, f.root, recovered.requirementId);
  assert.equal(newRegistration.blocked, false);
  const allowed = await runHook({ ...context(f.root, binding.sessionId, null),
    hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "write:recovered",
    tool_input: { file_path: "artifact.txt", content: "recovered\n" } });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.requirementId, recovered.requirementId);
  const replay = spawnSync(process.execPath, [CLI, "premortem-recover", prepared.requirementId,
    "--root", f.root, "--json"],
  { encoding: "utf8", env: process.env });
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).requirementId, recovered.requirementId);
  await f.preserve();
});

test("assignment replay, foreign scope, parallel prompts, restart, and compaction stay isolated", async t => {
  const f = await fixture(t, { homeRoot: false });
  const binding = { host: "codex", sessionId: "session:assignment-race",
    projectId: PROJECT, entityId: "agent:synthetic", taskId: "task:synthetic" };
  const [left, right] = await Promise.all([
    beginDeliveryAssignment({ root: f.root, binding, eventId: "prompt:parallel:left" }),
    beginDeliveryAssignment({ root: f.root, binding, eventId: "prompt:parallel:right" })
  ]);
  assert.equal(left.blocked, false);
  assert.equal(right.blocked, false);
  assert.notEqual(left.assignmentId, right.assignmentId);
  const restarted = await resolveDeliveryAssignment({ root: f.root, binding });
  assert.equal(restarted.blocked, false);
  assert.ok([left.assignmentId, right.assignmentId].includes(restarted.assignmentId));
  const inactive = restarted.assignmentId === left.assignmentId ? right.assignmentId : left.assignmentId;
  const replay = await resolveDeliveryAssignment({ root: f.root, binding, assignmentId: inactive });
  assert.equal(replay.status, "foreign-assignment");
  assert.equal(replay.blocked, true);
  const foreignSession = await resolveDeliveryAssignment({ root: f.root,
    binding: { ...binding, sessionId: "session:foreign" } });
  assert.equal(foreignSession.status, "legacy");
  const foreignTask = await resolveDeliveryAssignment({ root: f.root,
    binding: { ...binding, taskId: "task:foreign" } });
  assert.equal(foreignTask.status, "foreign-assignment");

  const compact = await runHook({ ...context(f.root, binding.sessionId, null),
    hook_event_name: "PostCompact", event_id: "compact:assignment-race" });
  assert.equal(compact.blocked, false);
  assert.equal((await resolveDeliveryAssignment({ root: f.root, binding })).assignmentId,
    restarted.assignmentId);
  await f.preserve();
});
