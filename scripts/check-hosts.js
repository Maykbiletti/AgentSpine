#!/usr/bin/env node
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHostContract,
  initializeServer,
  readHostJson,
  validateEntrypoint
} from "./host-check-runtime.js";

const COMMON_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PreCompact", "PostCompact", "Stop", "SubagentStop"
];
const CLAUDE_PRE_TOOL_MATCHER =
  "^(?:Edit|Write|apply_patch|Bash|PowerShell|mcp__plugin_agent-spine_agent-spine__session_timeline_(?:index|search|capture))$";
const CODEX_PRE_TOOL_MATCHER =
  "^(?:Edit|Write|apply_patch|Bash|PowerShell|mcp__(?:plugin_agent-spine_agent-spine|agent-spine)__session_timeline_(?:index|search|capture))$";
const BLUN_PRE_TOOL_MATCHER =
  "^(?:Edit|Write|apply_patch|Bash|PowerShell|exec_command|mcp__agent-spine__session_timeline_(?:index|search|capture))$";

function validateHooks(root, hooks, {
  required,
  commandRoot,
  matcher = CLAUDE_PRE_TOOL_MATCHER,
  asyncObserver = false
}) {
  assertHostContract(hooks && typeof hooks === "object" && !Array.isArray(hooks),
    "hook bundle is missing");
  assertHostContract(Object.keys(hooks).every((key) => ["description", "hooks"].includes(key)),
    "hook bundle contains unsupported top-level metadata");
  assertHostContract(typeof hooks.description === "string" && hooks.description,
    "hook bundle description is missing");

  for (const event of required) {
    const registrations = hooks.hooks?.[event];
    assertHostContract(Array.isArray(registrations) && registrations.length === 1,
      `${event} must have exactly one registration`);
    const expectedCount = asyncObserver && event === "UserPromptSubmit" ? 2 : 1;
    assertHostContract(Array.isArray(registrations[0].hooks)
      && registrations[0].hooks.length === expectedCount,
    `${event} has an unsafe hook command count`);
    const command = registrations[0].hooks[0];
    assertHostContract(command.type === "command", `${event} must use a command hook`);
    const expected = `node "\${${commandRoot}}/src/hook.js"${event === "PostToolUse"
      ? " --silent-oversize-post-tool-use" : ""}`;
    assertHostContract(command.command === expected,
      `${event} must use the bundled lifecycle adapter`);
    assertHostContract(Number.isInteger(command.timeout) && command.timeout > 0
      && command.timeout <= 15, `${event} timeout is unsafe`);

    if (expectedCount === 2) {
      const observer = registrations[0].hooks[1];
      assertHostContract(observer.type === "command"
        && observer.command === `node "\${${commandRoot}}/src/claude-observer-hook.js"`
        && observer.async === true && Object.keys(observer).length === 3,
      "UserPromptSubmit observer must be one bundled async command");
    }
    if (event === "PreToolUse") {
      assertHostContract(registrations[0].matcher === matcher,
        "PreToolUse must route only exact mutations and timeline MCP calls through one guard");
    }
  }

  const extras = Object.keys(hooks.hooks || {}).filter((event) => !required.includes(event));
  assertHostContract(extras.length === 0, `unknown hook events: ${extras.join(", ")}`);
  return {
    events: required,
    commands: required.length + (asyncObserver ? 1 : 0),
    entrypoint: relative(root, resolve(root, "src/hook.js"))
  };
}

function validateBlunHooks(root, hooks) {
  assertHostContract(Array.isArray(hooks), "BLUN hook bundle is missing");
  assertHostContract(hooks.length === COMMON_EVENTS.length,
    "BLUN must register exactly one command per lifecycle event");
  assertHostContract(JSON.stringify(hooks.map(({ event }) => event))
    === JSON.stringify(COMMON_EVENTS), "BLUN lifecycle events must remain complete and ordered");

  for (const event of COMMON_EVENTS) {
    const registrations = hooks.filter((hook) => hook.event === event);
    assertHostContract(registrations.length === 1,
      `${event} must have exactly one BLUN registration`);
    const command = registrations[0];
    const expected = `node "./src/hook.js"${event === "PostToolUse"
      ? " --silent-oversize-post-tool-use" : ""}`;
    assertHostContract(command.command === expected,
      `${event} must use the bundled BLUN lifecycle adapter`);
    assertHostContract(Number.isInteger(command.timeout) && command.timeout > 0
      && command.timeout <= 15, `${event} BLUN timeout is unsafe`);
    if (event === "PreToolUse") {
      assertHostContract(command.matcher === BLUN_PRE_TOOL_MATCHER,
        "BLUN PreToolUse must route only exact mutations and timeline MCP calls through one guard");
    }
  }
  return { events: COMMON_EVENTS, commands: COMMON_EVENTS.length,
    entrypoint: relative(root, resolve(root, "src/hook.js")) };
}

export async function checkHosts(root = process.cwd()) {
  root = resolve(root);
  const [pkg, blun, claude, claudeMcp, codex, claudeHooks, codexHooks, hookVersion]
    = await Promise.all([
      readHostJson(root, "package.json"), readHostJson(root, "blun.plugin.json"),
      readHostJson(root, ".claude-plugin/plugin.json"), readHostJson(root, ".mcp.json"),
      readHostJson(root, ".codex-plugin/plugin.json"), readHostJson(root, "hooks/hooks.json"),
      readHostJson(root, "hooks/codex.json"), readHostJson(root, "hooks/version.json")
    ]);

  assertHostContract(blun.version === pkg.version && claude.version === pkg.version
    && codex.version === pkg.version, "host manifests must use the package cache version");
  assertHostContract(hookVersion.schema === "agentspine.hook-bundle/v1"
    && hookVersion.version === pkg.version, "hook bundle version must match the package cache version");
  assertHostContract(hookVersion.contract === "agentspine.preflight/v2",
    "hook bundle preflight contract is missing");
  assertHostContract(pkg.bin?.["agentspine-worker"] === "./src/worker.js",
    "package must register exactly one gateway worker entrypoint");
  await validateEntrypoint(root, resolve(root, pkg.bin["agentspine-worker"]));
  assertHostContract(claude.mcpServers === "./.mcp.json",
    "Claude manifest must explicitly reference ./.mcp.json");
  assertHostContract(claude.hooks === undefined,
    "default hooks/hooks.json must not also be registered through a supplemental manifest path");
  assertHostContract(codex.hooks === "./hooks/codex.json",
    "Codex manifest must select its host-specific hook adapter");
  assertHostContract(claudeMcp.mcpServers && Object.keys(claudeMcp.mcpServers).length === 1,
    "Claude MCP file must contain one mcpServers registration");
  assertHostContract(codex.mcpServers && Object.keys(codex.mcpServers).length === 1,
    "Codex manifest must contain one MCP registration");

  const inventories = {
    blun: validateBlunHooks(root, blun.hooks),
    claude: validateHooks(root, claudeHooks, {
      required: [...COMMON_EVENTS, "InstructionsLoaded", "PostModelSwitch"],
      commandRoot: "CLAUDE_PLUGIN_ROOT", asyncObserver: true
    }),
    codex: validateHooks(root, codexHooks, {
      required: COMMON_EVENTS, commandRoot: "PLUGIN_ROOT",
      matcher: CODEX_PRE_TOOL_MATCHER, asyncObserver: true
    })
  };
  const registrations = await Promise.all([
    initializeServer({ label: "blun", root, variable: "BLUN_PLUGIN_ROOT",
      server: blun.mcpServers["agent-spine"], version: pkg.version }),
    initializeServer({ label: "claude", root, variable: "CLAUDE_PLUGIN_ROOT",
      server: claudeMcp.mcpServers["agent-spine"], version: pkg.version }),
    initializeServer({ label: "codex", root, variable: "PLUGIN_ROOT",
      server: codex.mcpServers["agent-spine"], version: pkg.version })
  ]);

  return {
    ok: true, root, version: pkg.version, registrations, hooks: inventories,
    hookDiscovery: { blun: "plugin-manifest", claude: "default-hooks-directory",
      codex: "plugin-manifest", trust: "host-user-required", liveTrustVerified: false },
    worker: { entrypoint: pkg.bin["agentspine-worker"], setsPerInstall: 1 },
    exactlyOnce: { mcpServersPerHost: 1, hookSetsPerHost: 1, workerSetsPerInstall: 1 },
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
