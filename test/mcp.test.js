import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "../src/mcp.js";
import { grantDelegation } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import { initDirectoryAdapter, publishLearning, pullShared, reviewShared } from "../src/lib/sharing.js";

test("MCP server initializes and lists its read and graph tools", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  startMcpServer(input, output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP response timeout")), 1000);
    const check = () => {
      if (response.trim().split("\n").length >= 2) {
        clearTimeout(timeout);
        resolve();
      } else setTimeout(check, 5);
    };
    check();
  });
  const messages = response.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.name, "agent-spine");
  const names = messages[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "scan", "resolve_context", "session_briefing", "read_document", "verify",
    "link_documents", "annotate_document", "upsert_entity",
    "link_entities", "relationship_context", "upsert_attention",
    "record_activity", "attention_context", "resolve_attention",
    "configure_attention", "delete_attention", "propose_learning",
    "add_learning_evidence", "review_learning", "learning_context",
    "evaluate_learning", "rollback_learning", "configure_learning",
    "delete_learning", "check_delegation", "create_task", "update_task",
    "task_context", "shared_context", "audit"
  ]);
  assert.equal(names.includes("grant_delegation"), false);
  assert.equal(names.includes("revoke_delegation"), false);
  assert.equal(names.includes("publish_learning"), false);
  assert.equal(names.includes("pull_shared"), false);
  assert.equal(names.includes("review_shared"), false);
  assert.equal(names.includes("generate_signing_identity"), false);
  assert.equal(names.includes("trust_signer"), false);
  assert.equal(names.includes("revoke_trusted_signer"), false);
  assert.equal(names.includes("pull_https_snapshot"), false);
  assert.equal(names.includes("export_https_snapshot"), false);
  assert.equal(names.includes("publish_https_snapshot"), false);
  assert.equal(names.includes("put_https_snapshot"), false);
  assert.equal(names.includes("publish_https_feed"), false);
  assert.equal(names.includes("pull_https_feed"), false);
  assert.equal(names.includes("fetch_https_feed"), false);
  assert.equal(names.includes("reset_https_feed"), false);
  assert.equal(names.includes("serve_peer"), false);
  assert.equal(names.includes("pull_peer"), false);
  assert.equal(names.includes("execute_peer_command"), false);
  assert.equal(names.includes("grant_execution"), false);
  assert.equal(names.includes("revoke_execution"), false);
  assert.equal(names.includes("register_job"), false);
  assert.equal(names.includes("start_job"), false);
  assert.equal(names.includes("checkpoint_job"), false);
  assert.equal(names.includes("cancel_job"), false);
  assert.equal(names.includes("grant_channel_binding"), false);
  assert.equal(names.includes("revoke_channel_binding"), false);
  assert.equal(names.includes("ingest_channel_event"), false);
  assert.equal(names.includes("claim_channel_event"), false);
  assert.equal(names.includes("complete_channel_event"), false);
  for (const forbidden of [
    "apply_persona_roster", "sync_persona_roster", "assign_gateway_goal", "set_gateway_control",
    "enqueue_gateway_wake", "claim_gateway_work", "complete_gateway_run", "deliver_gateway_reply",
    "poll_telegram", "send_telegram", "start_worker"
  ]) assert.equal(names.includes(forbidden), false, `${forbidden} must remain outside MCP`);
});

test("agentspine mcp CLI launches the stdio server", async (t) => {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })}\n`);
  const response = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("CLI MCP response timeout")), 2000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && !buffer.includes("\n")) reject(new Error(`CLI MCP exited with ${code}`));
    });
  });
  assert.equal(response.id, 7);
  assert.equal(response.result.serverInfo.name, "agent-spine");
});

test("MCP session briefing is read-only, scoped, and byte-budgeted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-mcp-briefing-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-mcp-briefing-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n", "utf8");
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  startMcpServer(input, output);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "session_briefing", arguments: { root, host: "codex", maxBytes: 4096 } }
  })}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP briefing response timeout")), 2000);
    const check = () => {
      if (response.includes("\n")) { clearTimeout(timeout); resolve(); } else setTimeout(check, 5);
    };
    check();
  });
  const message = JSON.parse(response.trim());
  const briefing = JSON.parse(message.result.content[0].text);
  assert.equal(message.result.isError, false);
  assert.equal(briefing.schema, "agentspine.session-briefing/v1");
  assert.equal(briefing.host, "codex");
  assert.equal(briefing.budget.usedBytes <= 4096, true);
  assert.equal(briefing.authority, "context-only");
});

test("MCP attention tools persist and resolve a shared cue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-mcp-attention-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-mcp-attention-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  startMcpServer(input, output);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 11, method: "tools/call",
    params: { name: "upsert_attention", arguments: { root, id: "signal:mcp", kind: "promise", summary: "MCP promise", privacy: "shared" } }
  })}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 12, method: "tools/call",
    params: { name: "attention_context", arguments: { root } }
  })}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP attention response timeout")), 2000);
    const check = () => {
      if (response.trim().split("\n").length >= 2) {
        clearTimeout(timeout);
        resolve();
      } else setTimeout(check, 5);
    };
    check();
  });
  const messages = response.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.isError, false);
  const context = JSON.parse(messages[1].result.content[0].text);
  assert.equal(context.items[0].key, "cue:signal:mcp");
});

test("MCP learning tools keep candidates hidden until confirmed and support rollback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-mcp-learning-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-mcp-learning-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  startMcpServer(input, output);
  const calls = [
    {
      id: 21, name: "propose_learning", arguments: {
        root, id: "learning:mcp", kind: "correction", claim: "The synthetic answer should be shorter.", privacy: "shared",
        evidence: { id: "evidence:mcp", type: "user-statement", summary: "User corrected the answer.", confidence: 1 }
      }
    },
    { id: 22, name: "learning_context", arguments: { root } },
    {
      id: 23, name: "review_learning", arguments: {
        root, id: "learning:mcp", decision: "accept", reason: "Explicitly confirmed.", confirmedByUser: true
      }
    },
    { id: 24, name: "learning_context", arguments: { root } },
    { id: 25, name: "rollback_learning", arguments: { root, id: "learning:mcp", reason: "Synthetic rollback." } },
    { id: 26, name: "learning_context", arguments: { root } }
  ];
  for (const call of calls) {
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: call.id, method: "tools/call",
      params: { name: call.name, arguments: call.arguments }
    })}\n`);
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP learning response timeout")), 3000);
    const check = () => {
      if (response.trim().split("\n").length >= calls.length) {
        clearTimeout(timeout);
        resolve();
      } else setTimeout(check, 5);
    };
    check();
  });
  const messages = response.trim().split("\n").map(JSON.parse);
  assert.equal(JSON.parse(messages[1].result.content[0].text).items.length, 0);
  assert.equal(JSON.parse(messages[3].result.content[0].text).items[0].id, "learning:mcp");
  assert.equal(JSON.parse(messages[5].result.content[0].text).items.length, 0);
  assert.equal(messages.every((message) => message.result.isError === false), true);
});

test("MCP coordination tools enforce separately configured delegation and retain task context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-mcp-coordination-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-mcp-coordination-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  await upsertEntity({ root, id: "agent:mcp-lead", kind: "agent", privacy: "shared" });
  await upsertEntity({ root, id: "agent:mcp-worker", kind: "agent", privacy: "shared" });
  await grantDelegation({
    root, id: "grant:mcp", actorId: "agent:mcp-lead", actions: ["assign"], targetIds: ["agent:mcp-worker"],
    reason: "The local owner approved the synthetic MCP assignment.", confirmation: "local-owner-confirmed"
  });
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  startMcpServer(input, output);
  const calls = [
    { id: 31, name: "check_delegation", arguments: { root, actorId: "agent:mcp-lead", action: "assign", targetId: "agent:mcp-worker" } },
    {
      id: 32, name: "create_task", arguments: {
        root, id: "task:mcp", actorId: "agent:mcp-lead", assigneeId: "agent:mcp-worker",
        title: "Synthetic MCP handoff", kind: "handoff", privacy: "shared"
      }
    },
    { id: 33, name: "update_task", arguments: { root, id: "task:mcp", actorId: "agent:mcp-worker", patch: { status: "completed" } } },
    { id: 34, name: "task_context", arguments: { root, includeClosed: true } }
  ];
  for (const call of calls) input.write(`${JSON.stringify({
    jsonrpc: "2.0", id: call.id, method: "tools/call", params: { name: call.name, arguments: call.arguments }
  })}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP coordination response timeout")), 3000);
    const check = () => {
      if (response.trim().split("\n").length >= calls.length) {
        clearTimeout(timeout);
        resolve();
      } else setTimeout(check, 5);
    };
    check();
  });
  const messages = response.trim().split("\n").map(JSON.parse);
  assert.equal(JSON.parse(messages[0].result.content[0].text).allowed, true);
  assert.equal(JSON.parse(messages[3].result.content[0].text).items[0].status, "completed");
  assert.equal(messages.every((message) => message.result.isError === false), true);
});

test("MCP exposes only locally reviewed shared context and no adapter administration", async (t) => {
  const rootA = await mkdtemp(join(tmpdir(), "agentspine-mcp-share-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "agentspine-mcp-share-b-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-mcp-share-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-mcp-share-adapter-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    await rm(rootA, { recursive: true }); await rm(rootB, { recursive: true });
    await rm(state, { recursive: true }); await rm(adapter, { recursive: true });
  });
  await writeFile(join(rootA, "AGENTS.md"), "# Rules A\n", "utf8");
  await writeFile(join(rootB, "AGENTS.md"), "# Rules B\n", "utf8");
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:mcp", adapterId: "adapter:mcp",
    confirmation: "local-share-confirmed"
  });
  await proposeLearning({
    root: rootA, id: "learning:mcp-share", kind: "project-fact", claim: "The synthetic MCP shared context is reviewed.",
    privacy: "shared", evidence: { id: "evidence:mcp-share", type: "test", summary: "Synthetic MCP proof.", confidence: 1 }
  });
  await reviewLearning({ root: rootA, id: "learning:mcp-share", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:mcp-share", eventId: "shared:mcp",
    confirmation: "local-share-confirmed"
  });
  await pullShared({ root: rootB, directory: adapter });
  await reviewShared({ root: rootB, id: "shared:mcp", decision: "accept", reason: "Confirmed locally.", confirmedByUser: true });
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  startMcpServer(input, output);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 41, method: "tools/call",
    params: { name: "shared_context", arguments: { root: rootB, scopeId: "team:mcp" } }
  })}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP shared context timeout")), 2000);
    const check = () => {
      if (response.includes("\n")) { clearTimeout(timeout); resolve(); } else setTimeout(check, 5);
    };
    check();
  });
  const message = JSON.parse(response.trim());
  const context = JSON.parse(message.result.content[0].text);
  assert.equal(context.items[0].id, "shared:mcp");
  assert.equal(context.items[0].authority, "context-only");
});
