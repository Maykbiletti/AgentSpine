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
    targetPaths: ["target.js"], contractPaths: ["AGENTS.md"],
    recentErrorTerms: ["failure", "foreign receipt"] });
  assert.equal(knowledge.isError, false);
  assert.equal(body(knowledge).targets[0].path, "target.js");
  const premortem = await call("record_delivery_premortem", { root, requirementId,
    items: items() });
  assert.equal(premortem.isError, false);
  return body(premortem);
}

test("real ordered MCP calls unlock only their exact delivery and are single-use", async (t) => {
  const { root, source } = await fixture(t);
  const session = "session:real-three-calls";
  const prompted = await runHook(hookInput(root, session, "UserPromptSubmit",
    { prompt: "Change the synthetic target." }));
  const requirementId = prompted.preflight.premortem.requirementId;
  const denied = await runHook(hookInput(root, session, "PreToolUse", {
    tool_name: "Write", tool_use_id: "write:before-calls",
    tool_input: { file_path: "target.js", content: "synthetic\n" }
  }));
  assert.equal(denied.premortem.status, "missing-briefing");
  const call = mcpClient();
  const recorded = await actualPreflight(call, root, requirementId);
  assert.match(recorded.agentSpineUse.briefingReceipt.digest, /^[a-f0-9]{64}$/);
  assert.match(recorded.agentSpineUse.knowledgeReceipt.digest, /^[a-f0-9]{64}$/);
  const allowed = await runHook(hookInput(root, session, "PreToolUse", {
    tool_name: "Write", tool_use_id: "write:after-calls",
    tool_input: { file_path: "target.js", content: "synthetic\n" }
  }));
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.agentSpineUse.status, "verified");
  const consumed = await consumeDeliveryAgentUse({ root, requirementId });
  assert.equal(consumed.status, "consumed");
  assert.equal((await verifyDeliveryAgentUse({ root, requirementId })).status, "reused");
  const replay = await call("session_briefing", { root, cwd: root, host: "codex",
    requirementId, includeSourceContent: false });
  assert.equal(replay.isError, true);
  assert.equal(body(replay).deliveryUseReceipt.status, "reused");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});

test("foreign session, foreign goal step, and text claims cannot satisfy the gate", async (t) => {
  const { root } = await fixture(t);
  const call = mcpClient();
  const first = await prepare(root, "session:first", "step:first");
  const second = await prepare(root, "session:second", "step:second");
  await actualPreflight(call, root, first.requirementId);
  const foreign = await call("record_delivery_premortem", {
    root, requirementId: second.requirementId, items: items(),
    claimedBriefingReceipt: first.requirementId
  });
  assert.equal(foreign.isError, true);
  assert.match(body(foreign).error || body(foreign).reason, /additional properties|session_briefing/);
  const textOnly = await call("record_delivery_premortem", {
    root, requirementId: second.requirementId, items: items()
  });
  assert.equal(textOnly.isError, true);
  assert.equal(body(textOnly).status, "missing-briefing");
});

test("concurrency deduplicates receipts, verification stays bounded, and uncertainty fails open", async (t) => {
  const { root, source } = await fixture(t);
  const requirement = await prepare(root, "session:concurrent");
  const args = { root, requirementId: requirement.requirementId,
    input: { root }, result: { schema: "synthetic-briefing" } };
  const results = await Promise.all(Array.from({ length: 16 }, () => recordDeliveryBriefingUse(args)));
  assert.equal(results.filter((result) => result.status === "recorded").length, 1);
  assert.equal(new Set(results.map((result) => result.digest)).size, 1);
  const started = performance.now();
  await Promise.all(Array.from({ length: 100 }, () => verifyDeliveryAgentUse({
    root, requirementId: requirement.requirementId
  })));
  assert.ok(performance.now() - started < 2000, "100 bounded preflight checks must finish below 2 seconds");
  const call = mcpClient();
  const uncertain = await prepare(root, "session:uncertain");
  await actualPreflight(call, root, uncertain.requirementId);
  const generation = uncertain.requirementId.split(":")[2];
  const usagePath = join(await projectStateDir(await realpath(root)),
    "delivery-agent-usage", `${generation}.json`);
  await writeFile(usagePath, "{not-json\n");
  const allowed = await runHook(hookInput(root, "session:uncertain", "PreToolUse", {
    tool_name: "Edit", tool_use_id: "write:uncertain",
    tool_input: { file_path: "target.js", old_string: "true", new_string: "false" }
  }));
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.agentSpineUse.status, "degraded");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
});
