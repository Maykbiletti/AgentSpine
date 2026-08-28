#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(root, path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function expand(value, variable, root) {
  assert(typeof value === "string" && value.length > 0, "host command values must be non-empty strings");
  return value.split(`\${${variable}}`).join(root);
}

async function validateEntrypoint(root, value) {
  const target = resolve(value);
  const within = relative(root, target);
  assert(within && !within.startsWith("..") && !isAbsolute(within), "MCP entrypoint must remain inside the plugin");
  const metadata = await stat(target);
  assert(metadata.isFile(), "MCP entrypoint must be a regular file");
}

function validateHooks(root, hooks, version) {
  const required = [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PreCompact", "PostCompact", "Stop", "SubagentStop"
  ];
  assert(hooks && typeof hooks === "object" && !Array.isArray(hooks), "hook bundle is missing");
  assert(hooks.version === version, "hook bundle must use the package cache version");
  assert(hooks.contract === "agentspine.selfstarter/v1", "hook bundle is missing the current rights-bound self-starter contract");
  assert(hooks.description && typeof hooks.description === "string", "hook bundle description is missing");
  for (const event of required) {
    const registrations = hooks.hooks?.[event];
    assert(Array.isArray(registrations) && registrations.length === 1, `${event} must have exactly one registration`);
    assert(Array.isArray(registrations[0].hooks) && registrations[0].hooks.length === 1, `${event} must have exactly one hook command`);
    const command = registrations[0].hooks[0];
    assert(command.type === "command", `${event} must use a command hook`);
    assert(command.command === 'node "${CLAUDE_PLUGIN_ROOT}/src/hook.js"', `${event} must use the bundled lifecycle adapter`);
    assert(Number.isInteger(command.timeout) && command.timeout > 0 && command.timeout <= 15, `${event} timeout is unsafe`);
  }
  const extras = Object.keys(hooks.hooks || {}).filter((event) => !required.includes(event));
  assert(extras.length === 0, `unknown hook events: ${extras.join(", ")}`);
  return { events: required, commands: required.length, entrypoint: relative(root, resolve(root, "src/hook.js")) };
}

async function initializeServer({ label, root, variable, server, version }) {
  assert(server && typeof server === "object" && !Array.isArray(server), `${label} MCP registration is missing`);
  assert(server.command === "node", `${label} MCP registration must use the Node.js runtime`);
  assert(Array.isArray(server.args) && server.args.length === 1, `${label} MCP registration must name exactly one entrypoint`);
  const command = process.execPath;
  const args = server.args.map((value) => expand(value, variable, root));
  assert(!args.some((value) => value.includes("${")), `${label} MCP registration contains an unresolved variable`);
  await validateEntrypoint(root, args[0]);

  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const settle = () => {
        if (error) reject(error);
        else resolveResult(value);
      };
      if (child.exitCode !== null || child.signalCode !== null) return settle();
      child.once("close", settle);
      child.kill();
    };
    const timer = setTimeout(() => {
      finish(new Error(`${label} MCP initialize timed out${stderr ? `: ${stderr.trim()}` : ""}`));
    }, 3000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(stdout.slice(0, newline));
        assert(message.id === 1, `${label} MCP initialize returned the wrong request id`);
        assert(message.result?.serverInfo?.name === "agent-spine", `${label} MCP initialize returned the wrong server identity`);
        assert(message.result?.serverInfo?.version === version, `${label} MCP initialize returned a stale server version`);
        finish(null, { label, server: message.result.serverInfo.name, entrypoint: relative(root, args[0]) });
      } catch (error) {
        finish(error);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (!settled) finish(new Error(`${label} MCP server exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    // A real MCP host keeps stdio open after initialization. Closing stdin
    // here let macOS and Windows terminate the server before its queued reply.
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" }
    })}\n`);
  });
}

export async function checkHosts(root = process.cwd()) {
  root = resolve(root);
  const [pkg, claudeManifest, claudeMcp, codexManifest, hooks] = await Promise.all([
    json(root, "package.json"),
    json(root, ".claude-plugin/plugin.json"),
    json(root, ".mcp.json"),
    json(root, ".codex-plugin/plugin.json"),
    json(root, "hooks/hooks.json")
  ]);
  assert(claudeManifest.version === pkg.version && codexManifest.version === pkg.version, "host manifests must use the package cache version");
  assert(claudeManifest.mcpServers === "./.mcp.json", "Claude manifest must explicitly reference ./.mcp.json");
  assert(claudeManifest.hooks === undefined, "default hooks/hooks.json must not also be registered through a supplemental manifest path");
  assert(claudeMcp.mcpServers && Object.keys(claudeMcp.mcpServers).length === 1, "Claude MCP file must contain one mcpServers registration");
  assert(codexManifest.mcpServers && Object.keys(codexManifest.mcpServers).length === 1, "Codex manifest must contain one MCP registration");
  const hookInventory = validateHooks(root, hooks, pkg.version);
  const registrations = await Promise.all([
    initializeServer({ label: "claude", root, variable: "CLAUDE_PLUGIN_ROOT", server: claudeMcp.mcpServers["agent-spine"], version: pkg.version }),
    initializeServer({ label: "codex", root, variable: "PLUGIN_ROOT", server: codexManifest.mcpServers["agent-spine"], version: pkg.version })
  ]);
  return {
    ok: true, root, version: pkg.version, registrations,
    hooks: { claude: hookInventory, codex: hookInventory },
    exactlyOnce: { mcpServersPerHost: 1, hookSetsPerHost: 1 },
    authority: "registration-check-only"
  };
}

async function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let pretty = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root") root = args[++index];
    else if (args[index] === "--json") pretty = true;
    else throw new Error(`unknown host-check argument: ${args[index]}`);
  }
  process.stdout.write(`${JSON.stringify(await checkHosts(root), null, pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`AgentSpine host check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
