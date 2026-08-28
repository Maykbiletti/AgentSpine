import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkHosts } from "../scripts/check-hosts.js";
import { checkInstall } from "../scripts/check-install.js";

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
  assert.notEqual(pkg.version, "0.1.0");
  assert.equal(pkg.engines.node, ">=20.9.0");
});

test("host registrations launch the same provider-neutral MCP implementation", async () => {
  const [claude, claudeMcp, codex] = await Promise.all([
    json(".claude-plugin/plugin.json"), json(".mcp.json"), json(".codex-plugin/plugin.json")
  ]);
  assert.equal(claude.mcpServers, "./.mcp.json");
  assert.equal(claude.hooks, undefined);
  assert.deepEqual(claudeMcp.mcpServers["agent-spine"].args, ["${CLAUDE_PLUGIN_ROOT}/src/mcp.js"]);
  assert.deepEqual(codex.mcpServers["agent-spine"].args, ["${PLUGIN_ROOT}/src/mcp.js"]);
});

test("Claude and Codex registrations complete a real MCP initialize handshake", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await checkHosts(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.registrations.map(({ label, server }) => ({ label, server })), [
    { label: "claude", server: "agent-spine" },
    { label: "codex", server: "agent-spine" }
  ]);
  assert.deepEqual(result.exactlyOnce, { mcpServersPerHost: 1, hookSetsPerHost: 1 });
  assert.equal(result.hooks.claude.events.includes("PostCompact"), true);
  assert.equal(result.hooks.codex.events.includes("UserPromptSubmit"), true);
});

test("fresh install, stale-cache upgrade, and uninstall keep exactly one runtime and preserve user sources", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await checkInstall(root);
  assert.equal(result.ok, true);
  assert.equal(result.legacyCacheRejected, true);
  assert.deepEqual(result.fresh, { mcpServersPerHost: 1, hookSetsPerHost: 1 });
  assert.deepEqual(result.upgrade, { mcpServersPerHost: 1, hookSetsPerHost: 1 });
  assert.deepEqual(result.automaticBriefing.fresh, { event: "SessionStart", host: "claude", sources: 1 });
  assert.deepEqual(result.automaticBriefing.upgrade, { event: "SessionStart", host: "codex", sources: 1 });
  assert.equal(result.uninstallPreservedSources, true);
});
