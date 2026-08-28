#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkHosts } from "./check-hosts.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function copyFilter(source) {
  const name = basename(source);
  return !new Set([".git", "node_modules"]).has(name) && !name.endsWith(".tgz");
}

async function copyBundle(source, target) {
  await cp(source, target, { recursive: true, filter: copyFilter });
}

async function makePreviousCache(target) {
  for (const path of ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const file = join(target, path);
    const value = JSON.parse(await readFile(file, "utf8"));
    value.version = "0.2.0";
    delete value.lifecycleContract;
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  const marketplacePath = join(target, ".claude-plugin/marketplace.json");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  marketplace.plugins[0].version = "0.2.0";
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
  const hooksPath = join(target, "hooks/hooks.json");
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  hooks.version = "0.2.0";
  delete hooks.contract;
  await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
}

async function invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, payload = null) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "src/hook.js")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AGENTSPINE_HOST: host,
        AGENTSPINE_STATE_DIR: stateRoot,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PLUGIN_ROOT: pluginRoot
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${host} installed hook timed out`));
    }, 5000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${host} installed hook exited with ${code}: ${stderr.slice(0, 2048)}`));
      try {
        const protocol = JSON.parse(stdout.trim());
        const context = JSON.parse(protocol.hookSpecificOutput?.additionalContext || "null");
        if (context?.briefing?.host !== host || !Array.isArray(context?.briefing?.sources?.documents)) {
          throw new Error(`${host} installed hook did not inject a real session briefing`);
        }
        resolveResult({
          event: protocol.hookSpecificOutput.hookEventName, host,
          sources: context.briefing.sources.documents.length,
          attentionKinds: context.briefing.attention.items.map((item) => item.kind),
          capturedAttentionKind: context.attentionEvent?.kind || null
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify(payload || { hook_event_name: "SessionStart", cwd: projectRoot, host })}\n`);
  });
}

async function prepareInstalledAttention(pluginRoot, projectRoot, stateRoot) {
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  try {
    const graph = await import(pathToFileURL(join(pluginRoot, "src/lib/graph.js")).href);
    const coordination = await import(pathToFileURL(join(pluginRoot, "src/lib/coordination.js")).href);
    const continuity = await import(pathToFileURL(join(pluginRoot, "src/lib/continuity.js")).href);
    await graph.upsertEntity({ root: projectRoot, id: "person:install", kind: "person", privacy: "shared" });
    await graph.upsertEntity({ root: projectRoot, id: "project:install", kind: "project", privacy: "shared" });
    await coordination.createTask({
      root: projectRoot, id: "task:install", actorId: "person:install", assigneeId: "person:install",
      projectId: "project:install", title: "Installed lifecycle check", privacy: "private"
    });
    await continuity.configureContinuity({
      root: projectRoot, config: { enabled: true }, confirmation: "local-user-opt-in"
    });
  } finally {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
  }
}

async function invokeInstalledAttention(pluginRoot, projectRoot, stateRoot, host) {
  await prepareInstalledAttention(pluginRoot, projectRoot, stateRoot);
  const shared = {
    cwd: projectRoot, host, entity_id: "person:install",
    project_id: "project:install", task_id: "task:install"
  };
  const captured = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "UserPromptSubmit", event_id: "install:promise",
    prompt: "I promise to verify the installed lifecycle."
  });
  const restarted = await invokeInstalledHook(pluginRoot, projectRoot, stateRoot, host, {
    ...shared, hook_event_name: "SessionStart", session_id: "install:restart"
  });
  if (captured.capturedAttentionKind !== "promise" || !restarted.attentionKinds.includes("promise")) {
    throw new Error(`${host} installed hooks did not persist and inject an attention event`);
  }
  return { captured: captured.capturedAttentionKind, restarted: restarted.attentionKinds };
}

export async function checkInstall(root = process.cwd()) {
  root = resolve(root);
  const currentVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-install-check-"));
  try {
    const userProject = join(workspace, "user-project");
    const source = join(userProject, "SOUL.md");
    await mkdir(userProject, { recursive: true });
    await writeFile(source, "# Existing soul\n\nNever modify me.\n", "utf8");
    const sourceHash = hash(await readFile(source));

    const fresh = join(workspace, "fresh", "agent-spine");
    await copyBundle(root, fresh);
    const freshResult = await checkHosts(fresh);
    const aliasRoot = join(workspace, "fresh-alias");
    await symlink(join(workspace, "fresh"), aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliasResult = await checkHosts(join(aliasRoot, "agent-spine"));
    const freshState = join(workspace, "state-fresh");
    const freshHook = await invokeInstalledHook(fresh, userProject, freshState, "claude");
    const freshAttention = await invokeInstalledAttention(fresh, userProject, freshState, "claude");

    const installed = join(workspace, "cache", "agent-spine");
    await copyBundle(root, installed);
    await makePreviousCache(installed);
    let legacyFailed = false;
    try { await checkHosts(installed); } catch { legacyFailed = true; }
    if (!legacyFailed) throw new Error("legacy cache unexpectedly passed the current host inventory");

    const staging = `${installed}.${currentVersion}.staging`;
    await copyBundle(root, staging);
    await rm(installed, { recursive: true });
    await rename(staging, installed);
    const upgraded = await checkHosts(installed);
    const upgradeState = join(workspace, "state-upgrade");
    const upgradedHook = await invokeInstalledHook(installed, userProject, upgradeState, "codex");
    const upgradedAttention = await invokeInstalledAttention(installed, userProject, upgradeState, "codex");

    await rm(fresh, { recursive: true });
    await rm(installed, { recursive: true });
    if (hash(await readFile(source)) !== sourceHash) throw new Error("install or uninstall changed an existing source Markdown file");
    return {
      ok: true,
      version: upgraded.version,
      fresh: freshResult.exactlyOnce,
      upgrade: upgraded.exactlyOnce,
      automaticBriefing: { fresh: freshHook, upgrade: upgradedHook },
      automaticAttention: { fresh: freshAttention, upgrade: upgradedAttention },
      canonicalAliasLaunch: aliasResult.ok,
      previousCacheRejected: legacyFailed,
      uninstallPreservedSources: true,
      authority: "installation-check-only"
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let pretty = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root") root = args[++index];
    else if (args[index] === "--json") pretty = true;
    else throw new Error(`unknown install-check argument: ${args[index]}`);
  }
  process.stdout.write(`${JSON.stringify(await checkInstall(root), null, pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`AgentSpine install check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
