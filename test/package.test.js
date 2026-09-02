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
  const [pkg, lock, blun, claude, codex, marketplace, hooks, codexHooks, hookVersion] = await Promise.all([
    json("package.json"), json("package-lock.json"), json("blun.plugin.json"),
    json(".claude-plugin/plugin.json"), json(".codex-plugin/plugin.json"), json(".claude-plugin/marketplace.json"),
    json("hooks/hooks.json"), json("hooks/codex.json"), json("hooks/version.json")
  ]);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(claude.version, pkg.version);
  assert.equal(blun.version, pkg.version);
  assert.equal(codex.version, pkg.version);
  assert.equal(marketplace.plugins[0].version, pkg.version);
  assert.equal(hookVersion.version, pkg.version);
  assert.deepEqual(Object.keys(hooks).sort(), ["description", "hooks"]);
  assert.deepEqual(Object.keys(codexHooks).sort(), ["description", "hooks"]);
  assert.equal(Object.hasOwn(codexHooks.hooks, "InstructionsLoaded"), false);
  assert.notEqual(pkg.version, "0.1.0");
  assert.equal(pkg.engines.node, ">=20.9.0");
});

test("host registrations launch the same provider-neutral MCP implementation", async () => {
  const [blun, claude, claudeMcp, codex] = await Promise.all([
    json("blun.plugin.json"), json(".claude-plugin/plugin.json"), json(".mcp.json"), json(".codex-plugin/plugin.json")
  ]);
  assert.equal(claude.mcpServers, "./.mcp.json");
  assert.equal(claude.hooks, undefined);
  assert.equal(codex.hooks, undefined);
  assert.deepEqual(claudeMcp.mcpServers["agent-spine"].args, ["${CLAUDE_PLUGIN_ROOT}/src/mcp.js"]);
  assert.deepEqual(blun.mcpServers["agent-spine"].args, ["./src/mcp.js"]);
  assert.deepEqual(codex.mcpServers["agent-spine"].args, ["${PLUGIN_ROOT}/src/mcp.js"]);
  assert.equal(blun.hooks.length, 8);
  assert.deepEqual(blun.hooks.map(({ event }) => event), [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PreCompact", "PostCompact", "Stop", "SubagentStop"
  ]);
});

test("BLUN, Claude, and Codex registrations complete a real MCP initialize handshake", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await checkHosts(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.registrations.map(({ label, server }) => ({ label, server })), [
    { label: "blun", server: "agent-spine" },
    { label: "claude", server: "agent-spine" },
    { label: "codex", server: "agent-spine" }
  ]);
  assert.equal(result.version, "0.38.0");
  assert.deepEqual(result.exactlyOnce, { mcpServersPerHost: 1, hookSetsPerHost: 1, workerSetsPerInstall: 1 });
  assert.deepEqual(result.hookDiscovery, {
    blun: "plugin-manifest", claude: "default-hooks-directory", codex: "bundled-host-adapter",
    trust: "host-user-required", liveTrustVerified: false
  });
  assert.equal(result.hooks.blun.events.includes("PreToolUse"), true);
  assert.equal(result.hooks.claude.events.includes("PostCompact"), true);
  assert.equal(result.hooks.codex.events.includes("UserPromptSubmit"), true);
});

test("staged install, stale-cache upgrade, and uninstall preserve one bundle and user sources", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await checkInstall(root);
  assert.equal(result.ok, true);
  assert.equal(result.previousCacheRejected, true);
  assert.deepEqual(result.fresh, { mcpServersPerHost: 1, hookSetsPerHost: 1, workerSetsPerInstall: 1 });
  assert.deepEqual(result.upgrade, { mcpServersPerHost: 1, hookSetsPerHost: 1, workerSetsPerInstall: 1 });
  assert.deepEqual(
    { event: result.automaticBriefing.fresh.event, host: result.automaticBriefing.fresh.host },
    { event: "SessionStart", host: "claude" }
  );
  assert.ok(result.automaticBriefing.fresh.sources >= 1, "the staged project source is included");
  assert.deepEqual(
    { event: result.automaticBriefing.upgrade.event, host: result.automaticBriefing.upgrade.host },
    { event: "SessionStart", host: "codex" }
  );
  assert.ok(result.automaticBriefing.upgrade.sources >= 1, "the staged project source is included");
  for (const installed of [result.automaticAttention.fresh, result.automaticAttention.upgrade]) {
    assert.equal(installed.captured, "promise");
    assert.deepEqual(installed.restarted, ["promise"]);
    assert.equal(installed.preflight.schema, "agentspine.preflight/v2");
    assert.match(installed.preflight.receiptId, /^preflight:/);
    assert.equal(installed.preflight.instructions >= 1, true);
  }
  assert.deepEqual(result.automaticSelfstarter.fresh, { started: "start", resumed: "resume", checkpointSequence: 1, mcpCalls: 0 });
  assert.deepEqual(result.automaticSelfstarter.upgrade, { started: "start", resumed: "resume", checkpointSequence: 1, mcpCalls: 0 });
  for (const installed of [result.automaticChannelWake.fresh, result.automaticChannelWake.upgrade]) {
    assert.equal(installed.eventId, "telegram:update:install");
    assert.equal(installed.provider, "telegram");
    assert.deepEqual(installed.route, ["chat:install", "topic:install"]);
    assert.equal(installed.voice.displayName, "Franz");
    assert.equal(installed.voice.profile.warmth, "warm");
    assert.equal(installed.mcpCalls, 0);
  }
  for (const installed of [result.automaticGateway.fresh, result.automaticGateway.upgrade]) {
    assert.equal(installed.status, "delivered");
    assert.equal(installed.eventId, "telegram:update:installed-gateway");
    assert.deepEqual(installed.route, ["-1001234567890", "77", "990"]);
    assert.match(installed.agentId, /^agent:runtime:/);
    assert.equal(installed.mcpCalls, 0);
  }
  for (const installed of [result.visibleAcceptance.fresh, result.visibleAcceptance.upgrade]) {
    assert.equal(installed.passed, 15);
    assert.equal(installed.total, 15);
    assert.equal(installed.mcpCalls, 0);
    assert.deepEqual(installed.hosts, ["claude", "codex"]);
    assert.deepEqual(installed.languages, ["sv-SE", "es-ES"]);
    assert.match(installed.receiptDigest, /^[a-f0-9]{64}$/);
  }
  for (const installed of [result.liveRootResolution.fresh, result.liveRootResolution.upgrade]) {
    assert.equal(installed.mcpCalls, 0);
    assert.equal(installed.claude.project.includes("claude:memory/style.md"), true);
    assert.equal(installed.claude.project.includes("claude:memory/unindexed.md"), false);
    assert.deepEqual(installed.claude.indexedMemory, {
      indexed: 1, relevant: 1, loaded: 1, cacheHits: 0, cacheMisses: 2, missing: 0,
      rejected: { scope: 0, path: 0, symlink: 0, race: 0, size: 0 }, directoryEnumeration: 0
    });
  }
  assert.equal(result.canonicalAliasLaunch, true);
  assert.equal(result.uninstallPreservedSources, true);
});
