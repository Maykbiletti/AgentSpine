#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCodexMcp, stripManagedCodexBlock } from "../src/lib/codex-installation.js";
import { VERSION } from "../src/version.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function copyFilter(source) {
  const name = basename(source);
  return !new Set([".git", "node_modules"]).has(name) && !name.endsWith(".tgz");
}

function toolValue(response) {
  const text = response.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function invokeLauncher(launcher, cwd, env, requests, timeoutMs = 10000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [launcher], {
      cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"]
    });
    const expected = new Set(requests.map((request) => request.id));
    const responses = new Map();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolveResult(responses);
    };
    const timer = setTimeout(() => finish(new Error(`Codex launcher probe timed out${stderr ? `: ${stderr}` : ""}`)), timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); } catch (error) { return finish(error); }
        if (expected.has(response.id)) responses.set(response.id, response);
        if (responses.size === expected.size) finish(null);
      }
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Codex launcher exited with ${code}${stderr ? `: ${stderr}` : ""}`));
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function hookRequirement(packageRoot, projectRoot, stateRoot) {
  const input = {
    host: "codex", cwd: projectRoot, session_id: "session:synthetic-codex-install",
    hook_event_name: "UserPromptSubmit", event_id: "prompt:synthetic-codex-install",
    prompt: "Continue the synthetic installed delivery.",
    agent_spine_scope: { project_id: "project:synthetic-codex-install" }
  };
  const result = spawnSync(process.execPath, [join(packageRoot, "src", "hook.js")], {
    cwd: projectRoot, env: { ...process.env, AGENTSPINE_STATE_DIR: stateRoot },
    encoding: "utf8", input: JSON.stringify(input)
  });
  if (result.status !== 0) throw new Error(`installed Codex hook failed: ${result.stderr}`);
  const context = JSON.parse(JSON.parse(result.stdout).hookSpecificOutput.additionalContext);
  const requirementId = context.preflight?.premortem?.requirementId;
  if (!requirementId) throw new Error("installed Codex hook did not issue a delivery requirement");
  return requirementId;
}

async function oldPackage(root, target) {
  await cp(root, target, { recursive: true, filter: copyFilter });
  const pkgPath = join(target, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.version = "0.72.5";
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  await writeFile(join(target, "src", "version.js"), 'export const VERSION = "0.72.5";\n', "utf8");
}

export async function checkCodexInstall(root, workspace) {
  root = resolve(root);
  const codexHome = join(workspace, "codex-home");
  const projectRoot = join(workspace, "project");
  const stateRoot = join(workspace, "state");
  const previousRoot = join(workspace, "cache-0.72.5");
  await Promise.all([
    mkdir(codexHome, { recursive: true }), mkdir(join(projectRoot, ".git"), { recursive: true }),
    mkdir(stateRoot, { recursive: true }), oldPackage(root, previousRoot)
  ]);
  const foreignConfig = [
    'model = "gpt-synthetic"',
    "[mcp_servers.foreign]",
    'command = "foreign-server"',
    'args = ["--keep-byte-exact"]',
    ""
  ].join("\r\n");
  const source = "# Synthetic Codex project\n\nKeep this source byte-exact.\n";
  const unknown = '{"schema":"external.unknown-event/v99","decision":"not-authority"}\n';
  const configPath = join(codexHome, "config.toml");
  const sourcePath = join(projectRoot, "AGENTS.md");
  const unknownPath = join(stateRoot, "external-event.json");
  await Promise.all([
    writeFile(configPath, foreignConfig, "utf8"),
    writeFile(sourcePath, source, "utf8"),
    writeFile(unknownPath, unknown, "utf8")
  ]);
  const initial = await installCodexMcp({ codexHome, packageRoot: previousRoot });
  const requirementId = hookRequirement(previousRoot, projectRoot, stateRoot);
  const oldResponses = await invokeLauncher(initial.launcherPath, projectRoot, {
    AGENTSPINE_STATE_DIR: stateRoot, PLUGIN_ROOT: join(workspace, "wrong-plugin-root")
  }, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_briefing",
      arguments: { root: projectRoot, cwd: projectRoot, host: "codex", maxBytes: 4096,
        includeSourceContent: false } } }
  ]);
  if (oldResponses.get(1)?.result?.serverInfo?.version !== "0.72.5"
    || (oldResponses.get(2)?.result?.tools || []).length < 3 || oldResponses.get(3)?.result?.isError) {
    throw new Error("pre-update Codex process did not load the registered reader");
  }

  const updated = await installCodexMcp({ codexHome, packageRoot: root });
  await rm(previousRoot, { recursive: true, force: true });
  const requests = [
    { jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "read_document",
      arguments: { root: projectRoot, host: "codex", path: "AGENTS.md", offset: 0, length: 4096 } } },
    { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "session_briefing",
      arguments: { root: projectRoot, cwd: projectRoot, host: "codex", projectId: "project:synthetic-codex-install",
        requirementId, maxBytes: 4096, includeSourceContent: false } } },
    { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "delivery_knowledge_query",
      arguments: { root: projectRoot, requirementId, targetPaths: ["artifact.txt"], contractPaths: ["AGENTS.md"],
        recentErrorTerms: ["stale reader", "missing registration"], maxBytes: 8192 } } },
    { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "record_delivery_premortem",
      arguments: { root: projectRoot, requirementId, items: [
        { category: "baseline-environment", failure: "this delivery fails because the installed reader is stale", check: "Check the loaded reader version." },
        { category: "contract-tests", failure: "this delivery fails because required tools are missing", check: "List and call the required tools." },
        { category: "delivery-path", failure: "this delivery fails because configuration bytes changed", check: "Hash unmanaged configuration and sources." }
      ] } } }
  ];
  const responses = await invokeLauncher(updated.launcherPath, projectRoot, {
    AGENTSPINE_STATE_DIR: stateRoot, PLUGIN_ROOT: join(workspace, "wrong-plugin-root")
  }, requests);
  const toolNames = new Set((responses.get(11)?.result?.tools || []).map((tool) => tool.name));
  const read = toolValue(responses.get(12));
  const briefing = toolValue(responses.get(13));
  const knowledge = toolValue(responses.get(14));
  const premortem = toolValue(responses.get(15));
  for (const name of ["session_briefing", "delivery_knowledge_query", "record_delivery_premortem"]) {
    if (!toolNames.has(name)) throw new Error(`updated Codex reader is missing ${name}`);
  }
  if (responses.get(10)?.result?.serverInfo?.version !== VERSION || read?.content !== source
    || briefing?.deliveryUseReceipt?.blocked || knowledge?.deliveryUseReceipt?.blocked
    || premortem?.blocked || premortem?.status !== "recorded") {
    throw new Error("updated Codex reader did not preserve the existing session and required calls");
  }
  const config = await readFile(configPath, "utf8");
  if (stripManagedCodexBlock(config) !== foreignConfig
    || (config.match(/^\[mcp_servers\.agent-spine\]$/gm) || []).length !== 1
    || await readFile(sourcePath, "utf8") !== source || await readFile(unknownPath, "utf8") !== unknown) {
    throw new Error("Codex installation changed foreign configuration, source bytes, or unknown state");
  }
  return {
    ok: true,
    version: VERSION,
    oldVersion: "0.72.5",
    configuredOnce: true,
    foreignConfigDigest: sha256(foreignConfig),
    unmanagedConfigDigest: updated.unmanagedAfterDigest,
    sourceDigest: sha256(source),
    unknownStateDigest: sha256(unknown),
    tools: [...toolNames].filter((name) => REQUIRED_TOOL_NAMES.has(name)).sort(),
    existingSessionReadable: true,
    boundRequiredCalls: true,
    wrongPluginRootIgnored: true,
    authority: "installation-check-only"
  };
}

const REQUIRED_TOOL_NAMES = new Set([
  "session_briefing", "delivery_knowledge_query", "record_delivery_premortem", "read_document"
]);

async function main() {
  const root = resolve(process.argv[2] || process.cwd());
  const workspace = resolve(process.argv[3] || join(root, ".synthetic-codex-install"));
  await mkdir(workspace, { recursive: true });
  try {
    process.stdout.write(`${JSON.stringify(await checkCodexInstall(root, workspace), null, 2)}\n`);
  } finally {
    if (!process.argv[3]) await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`AgentSpine Codex install check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
