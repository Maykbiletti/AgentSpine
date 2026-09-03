import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { inspectDeliveryPremortems,
  recordDeliveryPremortem } from "../src/lib/delivery-premortem.js";
import { hookScanAuditPath } from "../src/lib/hook-audit.js";
import { registeredWriteContext } from "./premortem-write-fixture.js";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-artifact-guards-"));
  const root = join(workspace, "project");
  const exchange = join(workspace, "exchange");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(exchange), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic project rules\n", "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  return { root, exchange, state };
}

function preWrite(root, exchange, assignment, context) {
  return {
    ...context,
    hook_event_name: "PreToolUse", host: "codex", cwd: root, tool_name: "Write",
    tool_use_id: "tool:artifact-baseline-write",
    tool_input: { file_path: "output.js", content: "export const ok = true;\n" },
    agent_spine_exchange_directory: exchange, agent_spine_assignment: assignment
  };
}

function guardWriteContext(root, suffix) {
  return registeredWriteContext({ root, sessionId: `session:artifact:${suffix}`,
    projectId: "project:artifact-guards" });
}

const PREMORTEM_ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the frozen synthetic baseline." },
  { category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regressed",
    check: "Run the focused synthetic test." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact is missing",
    check: "Hash the synthetic delivered artifact." }
];

function premortemClosure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — verified ${item.category}`)].join("\n");
}

async function writeLifecycle(root, path, before, after, id, context) {
  if (before !== null) await writeFile(path, before, "utf8");
  const toolName = before === null ? "Write" : "Edit";
  const toolInput = before === null
    ? { file_path: path, content: after }
    : { file_path: path, old_string: before, new_string: after };
  const pre = await runHook({
    ...context,
    hook_event_name: "PreToolUse", host: "codex", cwd: root, tool_name: toolName,
    tool_use_id: id, tool_input: toolInput
  });
  assert.equal(pre.blocked, false);
  await writeFile(path, after, "utf8");
  return runHook({
    ...context,
    hook_event_name: "PostToolUse", host: "codex", cwd: root, tool_name: toolName,
    tool_use_id: id, tool_input: toolInput, success: true
  });
}

test("baseline guard blocks only a verified stand mismatch and names both digests", async (t) => {
  const { root, exchange } = await fixture(t);
  const snapshot = "a".repeat(64);
  await writeFile(join(root, ".blun-snapshot-stand.json"), `${JSON.stringify({
    schema: "blun.snapshot-stand/v1", projectId: "project:synthetic", snapshotSha256: snapshot
  })}\n`);
  const mismatch = await runHook(preWrite(root, exchange,
    `Basis: synthetic sha256 ${"b".repeat(16)}`));
  assert.equal(mismatch.blocked, true);
  assert.match(mismatch.reason, new RegExp(`required sha256 ${"b".repeat(16)}`));
  assert.match(mismatch.reason, new RegExp(`snapshot stand sha256 ${snapshot}`));

  const context = await guardWriteContext(root, "baseline");
  await writeFile(join(exchange, "AUFTRAG-001.md"), `# Synthetic assignment\n\nBasis: snapshot sha256 ${snapshot.slice(0, 16)}\n`);
  const matching = await runHook(preWrite(root, exchange,
    "Continue the current synthetic assignment.", context));
  assert.equal(matching.blocked, false);
  assert.equal(matching.artifactGuard.status, "verified");
});

test("missing baseline evidence allows the write and is audited once", async (t) => {
  const { root, exchange, state } = await fixture(t);
  const context = await guardWriteContext(root, "missing-baseline");
  await writeFile(join(root, ".blun-snapshot-stand.json"), `${JSON.stringify({
    schema: "blun.snapshot-stand/v1", projectId: "project:synthetic", snapshotSha256: "c".repeat(64)
  })}\n`);
  const input = preWrite(root, exchange, "Synthetic assignment without a baseline.", context);
  assert.equal((await runHook(input)).blocked, false);
  assert.equal((await runHook(input)).blocked, false);
  const records = (await readFile(hookScanAuditPath({ ...process.env, AGENTSPINE_STATE_DIR: state }), "utf8"))
    .trim().split("\n").map(JSON.parse)
    .filter((item) => item.phase === "baseline-guard" && item.code === "no-baseline");
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "allow");
});

test("editing around a pre-existing undeclared call passes with an exact warning", async (t) => {
  const { root } = await fixture(t);
  const context = await guardWriteContext(root, "legacy-call");
  const before = [
    "const first = () => 1,",
    "  second = () => 2;",
    "function execute(value) {",
    "  first();",
    "  second();",
    "  legacyAction(value);",
    "}",
    "execute(1);",
    ""
  ].join("\n");
  const path = join(root, "output.mjs");
  const after = before.replace("  first();", "  first();\n  const changed = value + 1;");
  const result = await writeLifecycle(root, path, before, after, "tool:identifier:legacy", context);
  assert.equal(result.blocked, false);
  assert.equal(result.artifactGuard.status, "pre-existing-undeclared-identifiers");
  assert.deepEqual(result.artifactGuard.newFindings, []);
  assert.match(result.artifactGuard.reason, /output\.mjs:7: legacyAction/);
  assert.doesNotMatch(result.artifactGuard.reason, /second/);
});

test("adding a new undeclared call blocks with only the new name", async (t) => {
  const { root } = await fixture(t);
  const context = await guardWriteContext(root, "new-call");
  const path = join(root, "output.js");
  const before = "legacyAction();\n";
  const result = await writeLifecycle(root, path, before,
    `${before}newAction();\n`, "tool:identifier:new", context);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.artifactGuard.newFindings.map((item) => item.name), ["newAction"]);
  assert.match(result.reason, /new undeclared calls:[\s\S]*newAction/);
  assert.match(result.reason, /Pre-existing warnings:[\s\S]*legacyAction/);
});

test("removing an undeclared call is accepted", async (t) => {
  const { root } = await fixture(t);
  const context = await guardWriteContext(root, "remove-call");
  const path = join(root, "output.cjs");
  const result = await writeLifecycle(root, path, "legacyAction();\n",
    "module.exports = 1;\n", "tool:identifier:remove", context);
  assert.equal(result.blocked, false);
  assert.equal(result.artifactGuard.status, "clean");
  assert.deepEqual(result.artifactGuard.findings, []);
});

test("a brand-new file with an undeclared call blocks", async (t) => {
  const { root } = await fixture(t);
  const context = await guardWriteContext(root, "new-file");
  const path = join(root, "new-output.js");
  const result = await writeLifecycle(root, path, null,
    "brandNewAction();\n", "tool:identifier:new-file", context);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.artifactGuard.newFindings.map((item) => item.name), ["brandNewAction"]);
  assert.match(result.reason, /new-output\.js:1: brandNewAction/);
});

test("the last audited identifier set remains a restart-safe comparison baseline", async (t) => {
  const { root } = await fixture(t);
  const context = await guardWriteContext(root, "restart");
  const path = join(root, "restart.js");
  const before = "legacyAction();\n";
  const first = await writeLifecycle(root, path, before,
    `${before}const checkpoint = true;\n`, "tool:identifier:audit", context);
  assert.equal(first.blocked, false);
  await writeFile(path, `${before}const checkpoint = true;\nafterRestart();\n`, "utf8");
  const restarted = await runHook({
    ...context,
    hook_event_name: "PostToolUse", host: "codex", cwd: root, tool_name: "Edit",
    tool_use_id: "tool:identifier:after-restart", tool_input: { file_path: path }, success: true
  });
  assert.equal(restarted.blocked, true);
  assert.deepEqual(restarted.artifactGuard.newFindings.map((item) => item.name), ["afterRestart"]);
  assert.deepEqual(restarted.artifactGuard.existingFindings.map((item) => item.name), ["legacyAction"]);
});

test("delivery guard blocks a missing claim and allows a matching digest prefix", async (t) => {
  const { root, exchange } = await fixture(t);
  const missing = await runHook({
    hook_event_name: "Stop", host: "codex", cwd: root,
    agent_spine_exchange_directory: exchange,
    final_assistant_message: `Delivered \`missing.zip\` sha256 ${"d".repeat(16)}`
  });
  assert.equal(missing.deliveryVerification.status, "not-applicable");
  assert.equal(missing.blocked, true);
  assert.match(missing.reason, /missing\.zip.*actual missing/s);

  const content = Buffer.from("synthetic artifact\n");
  const actual = digest(content);
  await writeFile(join(exchange, "artifact.bin"), content);
  const matching = await runHook({
    hook_event_name: "SubagentStop", host: "codex", cwd: root,
    agent_spine_exchange_directory: exchange,
    final_assistant_message: `Delivered \`artifact.bin\` sha256 ${actual.slice(0, 16)}`
  });
  assert.equal(matching.blocked, false);
  assert.equal(matching.artifactGuard.status, "verified");
});

test("a downstream artifact denial cannot replay a persisted premortem closure", async (t) => {
  const { root, exchange } = await fixture(t);
  const session = "session:artifact-retry";
  const common = { host: "codex", cwd: root, session_id: session,
    agent_spine_exchange_directory: exchange,
    agent_spine_scope: { project_id: "project:artifact-retry" } };
  const prompted = await runHook({ ...common, hook_event_name: "UserPromptSubmit",
    event_id: "prompt:artifact-retry", prompt: "Write the synthetic artifact." });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: prompted.preflight.premortem.requirementId, items: PREMORTEM_ITEMS });
  const toolInput = { file_path: "output.js", content: "export const ok = true;\n" };
  assert.equal((await runHook({ ...common, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "write:artifact-retry", tool_input: toolInput })).blocked, false);
  await writeFile(join(root, "output.js"), toolInput.content);
  const written = await runHook({ ...common, hook_event_name: "PostToolUse", tool_name: "Write",
    tool_use_id: "write:artifact-retry", tool_input: toolInput, success: true });
  await runHook({ ...common, hook_event_name: "PostToolUse", tool_name: "exec_command",
    tool_use_id: "test:artifact-retry", tool_input: { cmd: "node --test test/synthetic.test.js" },
    success: true, tool_response: { ok: true } });
  const denied = await runHook({ ...common, hook_event_name: "Stop",
    final_assistant_message: `Delivered \`missing.zip\` sha256 ${"d".repeat(16)}\n${
      premortemClosure(recorded.artifact, written.premortem.writeDigest)}` });
  assert.equal(denied.artifactGuard.status, "mismatch");
  assert.equal(denied.blocked, true);
  const [persisted] = (await inspectDeliveryPremortems(root)).states;
  assert.match(persisted.closure.digest, /^[a-f0-9]{64}$/);

  const bytes = Buffer.from("synthetic retry artifact\n");
  const actual = digest(bytes);
  await writeFile(join(exchange, "artifact.bin"), bytes);
  const retry = await runHook({ ...common, hook_event_name: "Stop",
    final_assistant_message: `Delivered \`artifact.bin\` sha256 ${actual.slice(0, 16)}` });
  assert.equal(retry.premortem.status, "unchecked");
  assert.equal(retry.blocked, true);
});
