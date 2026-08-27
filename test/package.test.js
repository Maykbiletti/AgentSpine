import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

test("package and host manifests keep one release version", async () => {
  const [pkg, lock, claude, codex, marketplace] = await Promise.all([
    json("package.json"), json("package-lock.json"), json(".claude-plugin/plugin.json"),
    json(".codex-plugin/plugin.json"), json(".claude-plugin/marketplace.json")
  ]);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(claude.version, pkg.version);
  assert.equal(codex.version, pkg.version);
  assert.equal(marketplace.plugins[0].version, pkg.version);
  assert.equal(pkg.engines.node, ">=20.9.0");
});

test("host registrations launch the same provider-neutral MCP implementation", async () => {
  const [claudeMcp, codex] = await Promise.all([
    json(".mcp.json"), json(".codex-plugin/plugin.json")
  ]);
  assert.deepEqual(claudeMcp.mcpServers["agent-spine"].args, ["${CLAUDE_PLUGIN_ROOT}/src/mcp.js"]);
  assert.deepEqual(codex.mcpServers["agent-spine"].args, ["${PLUGIN_ROOT}/src/mcp.js"]);
});
