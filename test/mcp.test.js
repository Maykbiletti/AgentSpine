import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
  assert.deepEqual(names, ["scan", "resolve_context", "read_document", "verify", "link_documents", "annotate_document"]);
});
