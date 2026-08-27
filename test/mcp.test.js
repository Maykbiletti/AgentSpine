import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "../src/mcp.js";

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
    "scan", "resolve_context", "read_document", "verify",
    "link_documents", "annotate_document", "upsert_entity",
    "link_entities", "relationship_context", "upsert_attention",
    "record_activity", "attention_context", "resolve_attention",
    "configure_attention", "delete_attention", "audit"
  ]);
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
