import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startMcpServer } from "../src/mcp.js";

function client() {
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
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output);
  return (name, args) => {
    const requestId = ++id;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${name} timeout`)), 2000);
      pending.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId,
      method: "tools/call", params: { name, arguments: args } })}\n`);
    return response;
  };
}

test("provider-neutral MCP records and reads provenance-bound world context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-world-mcp-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-world-mcp-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "AGENTS.md"), "# Synthetic MCP instructions\n");
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  const call = client();
  const value = { failures: 0, suite: 0 };
  const written = await call("record_world_assertion", {
    root, id: "assertion:mcp", subjectId: "project:synthetic", predicate: "suite.outcome", value,
    evidenceKind: "objective-measurement", evidenceId: "measurement:mcp",
    evidenceDigest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    observedAt: "2026-09-04T09:00:00.000Z", privacy: "shared"
  });
  assert.equal(written.isError, false);
  const contextResult = await call("world_context", {
    root, now: "2026-09-04T10:00:00.000Z"
  });
  assert.equal(contextResult.isError, false);
  const context = JSON.parse(contextResult.content[0].text);
  assert.deepEqual(context.facts[0].value, { failures: 0, suite: 0 });
  assert.equal(context.authority, "context-only");
});
