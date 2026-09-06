import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { runHook } from "../src/hook.js";
import { startMcpServer } from "../src/mcp.js";
import {
  consumeDeliveryAgentUse, recordDeliveryBriefingUse,
  verifyDeliveryAgentUse
} from "../src/lib/delivery-agent-usage.js";
import { preparePremortemRequirement } from "../src/lib/delivery-premortem.js";
import { projectStateDir } from "../src/lib/paths.js";

import { consumeHookBriefingOrigin, recordHookBriefingUse } from "../src/lib/hook-briefing-use.js";

const PROJECT = "project:delivery-agent-usage";

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-delivery-use-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  const source = Buffer.from("# Synthetic delivery contract\n\nKeep bytes exact after failure.\n");
  await Promise.all([
    writeFile(join(root, "AGENTS.md"), source),
    writeFile(join(root, "target.js"), "export const synthetic = true;\n")
  ]);
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  return { root, source };
}

function binding(sessionId, goalStepId = null) {
  return { host: "codex", sessionId, projectId: PROJECT,
    goalId: goalStepId ? "goal:synthetic" : null, goalStepId };
}

function hookInput(root, sessionId, event, extra = {}) {
  return { hook_event_name: event, host: "codex", cwd: root, session_id: sessionId,
    agent_spine_scope: { project_id: PROJECT }, ...extra };
}

function items() {
  return [
    { category: "baseline-environment",
      failure: "this delivery fails because the synthetic baseline is stale",
      check: "Compare the current synthetic source bytes." },
    { category: "contract-tests",
      failure: "this delivery fails because the three-call contract regresses",
      check: "Run the delivery AgentSpine usage tests." },
    { category: "delivery-path",
      failure: "this delivery fails because a foreign receipt is accepted",
      check: "Verify the exact session and goal-step binding." }
  ];
}

function mcpClient() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let id = 0;
  let buffer = "";
  const pending = new Map();
  output.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output);
  return async (name, args) => {
    const requestId = ++id;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${name} response timeout`)), 2000);
      pending.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId,
      method: "tools/call", params: { name, arguments: args } })}\n`);
    return response;
  };
}

function body(result) {
  return JSON.parse(result.content[0].text);
}

async function prepare(root, sessionId, goalStepId = null) {
  return preparePremortemRequirement({ root, binding: binding(sessionId, goalStepId) });
}

async function actualPreflight(call, root, requirementId) {
  const briefing = await call("session_briefing", { root, cwd: root, host: "codex",
    projectId: PROJECT, includePrivate: false, includeSourceContent: false,
    requirementId });
  assert.equal(briefing.isError, false);
  assert.match(body(briefing).deliveryUseReceipt.digest, /^[a-f0-9]{64}$/);
  const knowledge = await call("delivery_knowledge_query", { root, requirementId,
    targetPaths: ["target.js"], contractPaths: ["AGENTS.md"], recentErrorTerms: ["synthetic"],
    recentErrorTerms: ["failure", "foreign receipt"] });
  assert.equal(knowledge.isError, false);
  assert.equal(body(knowledge).targets[0].path, "target.js");
  const premortem = await call("record_delivery_premortem", { root, requirementId,
    items: items() });
  assert.equal(premortem.isError, false);
  return body(premortem);
}

test("host-loaded Codex briefing feeds knowledge and premortem without MCP refetch", async (t) => {
  const { root, source } = await fixture(t);
  const session = "session:hook-context";
  const start = await runHook(hookInput(root, session, "SessionStart"));
  assert.equal(start.blocked, false);
  const prompted = await runHook(hookInput(root, session, "UserPromptSubmit",
    { prompt: "Change the synthetic target safely." }));
  assert.equal(prompted.blocked, false);
  const requirementId = prompted.preflight.premortem.requirementId;
  const call = mcpClient();
  const knowledge = await call("delivery_knowledge_query", { root, requirementId,
    targetPaths: ["target.js"], contractPaths: ["AGENTS.md"], recentErrorTerms: ["synthetic"] });
  assert.equal(knowledge.isError, false, JSON.stringify(body(knowledge)));
  assert.equal(body(knowledge).deliveryUseReceipt.verified, true);
  assert.equal(body(knowledge).targets[0].path, "target.js");
  // A new MCP runtime reads the stored, verified hook evidence after restart.
  const resumed = mcpClient();
  const premortem = await resumed("record_delivery_premortem", { root, requirementId, items: items() });
  assert.equal(premortem.isError, false, JSON.stringify(body(premortem)));
  assert.equal(body(premortem).agentSpineUse.status, "verified");
  const compact = await runHook(hookInput(root, session, "PostCompact"));
  assert.equal(compact.blocked, false);
  assert.equal((await verifyDeliveryAgentUse({ root, requirementId })).status, "verified");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("missing or consumed proof is honest useful context, never completion or a retry", async (t) => {
  const { root, source } = await fixture(t);
  const requirement = await prepare(root, "session:unloaded");
  const call = mcpClient();
  const args = { root, requirementId: requirement.requirementId,
    targetPaths: ["target.js"], contractPaths: ["AGENTS.md"], recentErrorTerms: ["synthetic"] };
  const knowledge = await call("delivery_knowledge_query", args);
  assert.equal(knowledge.isError, false);
  assert.equal(body(knowledge).targets[0].path, "target.js");
  assert.equal(body(knowledge).deliveryUseReceipt.status, "missing-briefing");
  assert.equal(body(knowledge).deliveryUseReceipt.verified, false);
  const draft = body(await call("record_delivery_premortem", {
    root, requirementId: requirement.requirementId, items: items() }));
  assert.equal(draft.status, "unverified");
  assert.equal(draft.completionVerified, false);
  assert.equal(draft.automaticRetry, false);
  await actualPreflight(call, root, requirement.requirementId);
  await consumeDeliveryAgentUse({ root, requirementId: requirement.requirementId });
  const replay = body(await call("delivery_knowledge_query", args));
  assert.equal(replay.deliveryUseReceipt.status, "reused");
  assert.equal(replay.deliveryUseReceipt.verified, false);
  assert.equal(replay.deliveryUseReceipt.automaticRetry, false);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("serialized loaded claims cannot create host evidence", async (t) => {
  const { root } = await fixture(t);
  const requirement = await prepare(root, "session:forged");
  for (const origin of [null, { loaded: true, root, requirementId: requirement.requirementId,
    receipt: { status: "ready", host: "codex" } }]) {
    const result = await recordHookBriefingUse({ root, origin });
    assert.equal(result.verified, false);
    assert.equal(result.automaticRetry, false);
  }
  assert.equal((await verifyDeliveryAgentUse({ root, requirementId: requirement.requirementId })).status,
    "missing-briefing");
});

async function hostPreparation(root, sessionId, suffix = "a") {
  const { resolveHostSourceCatalog } = await import("../src/lib/source-roots.js");
  const { runtimeScope } = await import("../src/lib/hook-context.js");
  const { runPreflight } = await import("../src/lib/preflight.js");
  const { prepareHookPremortem } = await import("../src/lib/hook-premortem.js");
  const input = hookInput(root, sessionId, "UserPromptSubmit", {
    prompt: "Use the current synthetic context.", event_id: `event:${suffix}` });
  const resolvedSources = await resolveHostSourceCatalog({ host: "codex", cwd: root, input });
  const scope = await runtimeScope(input, root, resolvedSources.userStateRoot, resolvedSources.catalog);
  const now = new Date();
  const preflight = await runPreflight({ input, scope, resolvedSources, prompt: input.prompt, now });
  preflight.premortem = await prepareHookPremortem({ input, root, scope });
  return { event: "UserPromptSubmit", input, scope, resolvedSources, preflight, prompt: input.prompt, now };
}

test("expired, foreign and changed-source snapshots cannot become hook usage", async (t) => {
  const { root } = await fixture(t);
  const args = await hostPreparation(root, "session:negative");
  assert.equal(await consumeHookBriefingOrigin({ ...args,
    now: new Date(Date.parse(args.preflight.receipt.expiresAt) + 1) }), null);
  assert.equal(await consumeHookBriefingOrigin({ ...args,
    input: { ...args.input, session_id: "session:foreign" } }), null);
  assert.equal(await consumeHookBriefingOrigin({ ...args,
    scope: { ...args.scope, currentTaskId: "task:foreign" } }), null);
  assert.equal(await consumeHookBriefingOrigin({ ...args,
    preflight: { ...args.preflight, receipt: { ...args.preflight.receipt, signature: "0".repeat(64) } } }), null);
  const updatedSource = Buffer.from("# Updated synthetic rules\nNever treat stale content as current.\n");
  await writeFile(join(root, "AGENTS.md"), updatedSource);
  assert.equal(await consumeHookBriefingOrigin(args), null);
  assert.equal((await verifyDeliveryAgentUse({ root,
    requirementId: args.preflight.premortem.requirementId })).status, "missing-briefing");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), updatedSource);
});

test("host proof is single-use under races and cannot select another requirement", async (t) => {
  const { root, source } = await fixture(t);
  const args = await hostPreparation(root, "session:race");
  const origins = await Promise.all([consumeHookBriefingOrigin(args), consumeHookBriefingOrigin(args)]);
  assert.equal(origins.filter(Boolean).length, 1);
  const origin = origins.find(Boolean);
  const results = await Promise.all([recordHookBriefingUse({ root, origin }), recordHookBriefingUse({ root, origin })]);
  assert.equal(results.filter(result => result.verified).length, 1);
  assert.equal(await consumeHookBriefingOrigin(args), null);
  const other = await prepare(root, "session:other");
  const fresh = await hostPreparation(root, "session:new", "new");
  fresh.preflight.premortem.requirementId = other.requirementId;
  const wrong = await recordHookBriefingUse({ root, origin: await consumeHookBriefingOrigin(fresh) });
  assert.equal(wrong.verified, false);
  assert.equal(wrong.reason, "host-briefing-binding-mismatch");
  assert.equal((await verifyDeliveryAgentUse({ root, requirementId: other.requirementId })).status, "missing-briefing");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("unavailable proof service keeps normal Write and Stop allowed and sources protected", async (t) => {
  const { root, source } = await fixture(t);
  const session = "session:unverified-work";
  const prepared = await prepare(root, session);
  const call = mcpClient();
  const draft = body(await call("record_delivery_premortem", {
    root, requirementId: prepared.requirementId, items: items() }));
  assert.equal(draft.agentSpineUse.verified, false);
  for (const event of ["PreToolUse", "Stop"]) {
    const result = await runHook(hookInput(root, session, event, {
      tool_name: "Write", tool_input: { file_path: "target.js", content: "synthetic" },
      last_assistant_message: "The result has not been independently checked." }));
    assert.equal(result.blocked, false);
    assert.notEqual(result.completionVerified, true);
    assert.equal(JSON.stringify(result).includes('"automaticRetry":true'), false);
  }
  const protectedWrite = await runHook(hookInput(root, session, "PreToolUse", {
    tool_name: "Write", tool_input: { file_path: "AGENTS.md", content: "replacement" } }));
  assert.equal(protectedWrite.blocked, true);
  const args = await hostPreparation(root, "session:service", "service");
  const origin = await consumeHookBriefingOrigin(args);
  const previous = process.env.AGENTSPINE_STATE_DIR;
  try {
    process.env.AGENTSPINE_STATE_DIR = join(root, "target.js");
    const failed = await recordHookBriefingUse({ root, origin });
    assert.equal(failed.verified, false);
    assert.equal(failed.automaticRetry, false);
  } finally { process.env.AGENTSPINE_STATE_DIR = previous; }
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});
