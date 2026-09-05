import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCodexInstall } from "../scripts/check-codex-install.js";
import { installCodexMcp, stripManagedCodexBlock } from "../src/lib/codex-installation.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-codex-install-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function launchResult(launcher, cwd, env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [launcher], {
      cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("synthetic launcher timed out"));
    }, 3000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      child.kill();
      resolveResult(JSON.parse(stdout.slice(0, newline)));
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  });
}

test("Codex install updates a stable launcher and verifies the loaded reader before existing state", async (t) => {
  const workspace = await fixture(t);
  const result = await checkCodexInstall(ROOT, workspace);
  assert.equal(result.ok, true);
  assert.equal(result.configuredOnce, true);
  assert.equal(result.existingSessionReadable, true);
  assert.equal(result.boundRequiredCalls, true);
  assert.equal(result.wrongPluginRootIgnored, true);
  assert.deepEqual(result.tools, [
    "delivery_knowledge_query", "read_document",
    "record_delivery_premortem", "session_briefing"
  ]);
  assert.equal(result.foreignConfigDigest, result.unmanagedConfigDigest);
});

test("Codex install rejects unmanaged registrations, aliases, and symlinked files", async (t) => {
  const workspace = await fixture(t);
  const unmanaged = join(workspace, "unmanaged");
  await mkdir(unmanaged);
  const unmanagedText = '[mcp_servers.agent-spine]\ncommand = "other"\n';
  await writeFile(join(unmanaged, "config.toml"), unmanagedText, "utf8");
  await assert.rejects(installCodexMcp({ codexHome: unmanaged, packageRoot: ROOT }), /unmanaged AgentSpine/);
  assert.equal(await readFile(join(unmanaged, "config.toml"), "utf8"), unmanagedText);

  const quoted = join(workspace, "quoted-unmanaged");
  await mkdir(quoted);
  await writeFile(join(quoted, "config.toml"), "[mcp_servers.'agent-spine']\n", "utf8");
  await assert.rejects(installCodexMcp({ codexHome: quoted, packageRoot: ROOT }), /unmanaged AgentSpine/);

  const targetHome = join(workspace, "target-home");
  const aliasHome = join(workspace, "alias-home");
  await mkdir(targetHome);
  await symlink(targetHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installCodexMcp({ codexHome: aliasHome, packageRoot: ROOT }), /symlink/);

  if (process.platform !== "win32") {
    const parentTarget = join(workspace, "parent-target");
    const parentAlias = join(workspace, "parent-alias");
    await mkdir(join(parentTarget, "nested-home"), { recursive: true });
    await symlink(parentTarget, parentAlias, "dir");
    const canonicalized = await installCodexMcp({
      codexHome: join(parentAlias, "nested-home"), packageRoot: ROOT
    });
    assert.equal(canonicalized.configPath, join(parentTarget, "nested-home", "config.toml"));
  }

  const targetPackage = join(workspace, "target-package");
  const aliasPackage = join(workspace, "alias-package");
  await mkdir(targetPackage);
  await symlink(ROOT, aliasPackage, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installCodexMcp({ codexHome: targetHome, packageRoot: aliasPackage }), /symlink/);

  const linkedConfigHome = join(workspace, "linked-config-home");
  const foreign = join(workspace, "foreign.toml");
  await mkdir(linkedConfigHome);
  await writeFile(foreign, "foreign = true\n", "utf8");
  await symlink(foreign, join(linkedConfigHome, "config.toml"));
  await assert.rejects(installCodexMcp({ codexHome: linkedConfigHome, packageRoot: ROOT }), /regular non-symlink/);
  assert.equal(await readFile(foreign, "utf8"), "foreign = true\n");
});

test("Codex host-install CLI requires local confirmation and reaches the stable registration path", async (t) => {
  const workspace = await fixture(t);
  const codexHome = join(workspace, "codex-home");
  const args = ["bin/agentspine.js", "host-install", "codex", "--codex-home", codexHome,
    "--package-root", ROOT, "--json"];
  const denied = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /confirm-local-host-install/);
  const installed = spawnSync(process.execPath, [...args, "--confirm-local-host-install"], {
    cwd: ROOT, encoding: "utf8"
  });
  assert.equal(installed.status, 0, installed.stderr);
  const result = JSON.parse(installed.stdout);
  assert.equal(result.version, "0.72.6");
  assert.equal(result.restartRequired, true);
  assert.equal((await readFile(result.configPath, "utf8")).includes(result.launcherPath), true);
});

test("Codex install recovers after a staged crash and serializes parallel updates", async (t) => {
  const workspace = await fixture(t);
  const codexHome = join(workspace, "codex-home");
  await mkdir(codexHome);
  const foreign = 'model = "synthetic"';
  await writeFile(join(codexHome, "config.toml"), foreign, "utf8");
  await assert.rejects(installCodexMcp({
    codexHome, packageRoot: ROOT, faultAfter: "registration"
  }), /synthetic crash/);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), foreign);

  const [left, right] = await Promise.all([
    installCodexMcp({ codexHome, packageRoot: ROOT }),
    installCodexMcp({ codexHome, packageRoot: ROOT })
  ]);
  assert.equal(left.registrationDigest, right.registrationDigest);
  const config = await readFile(join(codexHome, "config.toml"), "utf8");
  assert.equal((config.match(/^\[mcp_servers\.agent-spine\]$/gm) || []).length, 1);
  assert.equal(stripManagedCodexBlock(config), foreign);

  await writeFile(join(codexHome, "config.toml"), config.replace(
    `command = ${JSON.stringify(process.execPath)}`, 'command = "/synthetic/wrong-node"'
  ), "utf8");
  await installCodexMcp({ codexHome, packageRoot: ROOT });
  const repaired = await readFile(join(codexHome, "config.toml"), "utf8");
  assert.doesNotMatch(repaired, /synthetic\/wrong-node/);
  assert.equal(stripManagedCodexBlock(repaired), foreign);
});

test("Codex install refuses tampered registration without touching unrelated state", async (t) => {
  const workspace = await fixture(t);
  const codexHome = join(workspace, "codex-home");
  const state = join(workspace, "state");
  await Promise.all([mkdir(codexHome), mkdir(state)]);
  const unknownPath = join(state, "unknown.json");
  const unknown = '{"schema":"external.event/v77"}\n';
  await writeFile(unknownPath, unknown, "utf8");
  const installed = await installCodexMcp({ codexHome, packageRoot: ROOT });
  const registration = await readFile(installed.registrationPath, "utf8");
  await writeFile(installed.registrationPath, registration.replace('"expectedName": "agent-spine"', '"expectedName": "foreign"'), "utf8");
  const result = spawnSync(process.execPath, [installed.launcherPath], {
    cwd: workspace, env: { ...process.env, AGENTSPINE_STATE_DIR: state },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    encoding: "utf8", timeout: 3000
  });
  assert.match(result.stdout, /loaded-reader verification failed/);
  assert.equal(await readFile(unknownPath, "utf8"), unknown);
});

test("Codex launcher rejects a stale cache path and an incompatible tool inventory before state access", async (t) => {
  const workspace = await fixture(t);
  const state = join(workspace, "state");
  const staleRoot = join(workspace, "stale-package");
  const staleHome = join(workspace, "stale-home");
  await Promise.all([
    mkdir(state), mkdir(staleHome),
    cp(ROOT, staleRoot, { recursive: true,
      filter: (source) => ![".git", "node_modules"].includes(source.split(/[\\/]/).at(-1)) })
  ]);
  const unknownPath = join(state, "unknown.json");
  const unknown = '{"schema":"external.event/v88"}\n';
  await writeFile(unknownPath, unknown, "utf8");
  const stale = await installCodexMcp({ codexHome: staleHome, packageRoot: staleRoot });
  await rm(staleRoot, { recursive: true, force: true });
  const staleResult = await launchResult(stale.launcherPath, workspace, { AGENTSPINE_STATE_DIR: state });
  assert.equal(staleResult.error.code, -32091);
  assert.match(staleResult.error.data.reason, /package root|ENOENT/);
  assert.equal(await readFile(unknownPath, "utf8"), unknown);

  const incompatibleRoot = join(workspace, "incompatible-package");
  const incompatibleHome = join(workspace, "incompatible-home");
  await Promise.all([mkdir(join(incompatibleRoot, "src"), { recursive: true }), mkdir(incompatibleHome)]);
  await writeFile(join(incompatibleRoot, "package.json"), '{"name":"agent-spine","version":"0.72.6","type":"module"}\n', "utf8");
  await writeFile(join(incompatibleRoot, "src", "version.js"), 'export const VERSION = "0.72.6";\n', "utf8");
  await writeFile(join(incompatibleRoot, "src", "mcp.js"), [
    "process.stdin.setEncoding('utf8'); let buffer = '';",
    "process.stdin.on('data', chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf('\\n')) >= 0) {",
    "const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;",
    "const message = JSON.parse(line); const result = message.method === 'initialize'",
    "? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-spine', version: '0.72.6' } }",
    ": { tools: [] }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n'); } });",
    ""
  ].join("\n"), "utf8");
  const incompatible = await installCodexMcp({ codexHome: incompatibleHome, packageRoot: incompatibleRoot });
  const incompatibleResult = await launchResult(incompatible.launcherPath, workspace, { AGENTSPINE_STATE_DIR: state });
  assert.equal(incompatibleResult.error.code, -32091);
  assert.match(incompatibleResult.error.data.reason, /missing required delivery tools/);
  assert.equal(await readFile(unknownPath, "utf8"), unknown);
});
