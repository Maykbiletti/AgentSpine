#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function run(file, args, options = {}) {
  return execute(file, args, {
    cwd: root,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...options
  });
}

async function npm(args, options = {}) {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return run(process.execPath, [candidate, ...args], options);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactRules(bytes, fill = "x") {
  const header = "# Synthetic packed rules\n\n";
  const remaining = bytes - Buffer.byteLength(header);
  return Buffer.from(`${header}${fill.repeat(Math.ceil(remaining / fill.length)).slice(0, remaining)}`);
}

function exactUtf8Rules(bytes) {
  const header = "# Synthetische Paketregeln: Größe\n\n";
  const remaining = bytes - Buffer.byteLength(header);
  return Buffer.from(`${header}${"ä".repeat(Math.floor(remaining / 2))}${remaining % 2 ? "x" : ""}`);
}

async function pack(cwd, destination) {
  const { stdout } = await npm([
    "pack", "--ignore-scripts", "--json", "--pack-destination", destination
  ], { cwd });
  const [result] = JSON.parse(stdout);
  assert(result?.filename, "npm pack did not report an artifact");
  return { ...result, path: join(destination, result.filename) };
}

async function install(tarball, prefix) {
  await npm([
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, tarball
  ]);
  return join(prefix, "node_modules", "agent-spine");
}

async function runInstalledHook(packageRoot, project, env, eventId, prompt, extra = {}) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "blun.plugin.json"), "utf8"));
  const command = manifest.hooks.find((hook) => hook.event === "UserPromptSubmit").command;
  const args = command.slice(command.lastIndexOf('"') + 1).trim().split(/\s+/).filter(Boolean);
  const input = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      host: "codex",
      cwd: project,
      session_id: `session:${eventId}`,
      event_id: `turn:${eventId}`,
      prompt, ...extra
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(packageRoot, "src", "hook.js"), ...args], {
      cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`installed hook exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

async function verifyPackedSizeContract(packageRoot, workspace, lane) {
  const project = join(workspace, `size-project-${lane}`);
  const state = join(workspace, `size-state-${lane}`);
  const hostHome = join(workspace, `size-host-${lane}`);
  await Promise.all([mkdir(join(project, ".git"), { recursive: true }), mkdir(state), mkdir(hostHome)]);
  const projectRules = join(project, "AGENTS.md");
  const userRules = join(hostHome, "AGENTS.md");
  const env = { ...process.env, HOME: hostHome, USERPROFILE: hostHome,
    AGENTSPINE_STATE_DIR: state, AGENTSPINE_ROOT: project,
    CODEX_HOME: hostHome, BLUN_HOME: hostHome, BLUN_PLUGIN_ROOT: packageRoot };
  const cases = [
    ...[8191, 8192, 8193, 17590, 32767, 32768, 32769, 65536, 131072]
      .map((bytes) => ({ name: `bytes-${bytes}`, project: exactRules(bytes) })),
    { name: "escaped-32768", project: exactRules(32768, "\"\\\\\n") },
    { name: "utf8-65537", project: exactUtf8Rules(65537) },
    { name: "combined-25000-19000", project: exactRules(25000), user: exactRules(19000) },
    { name: "reader-overflow", project: exactRules(4 * 1024 * 1024 + 1), unverified: true }
  ];
  for (const item of cases) {
    await writeFile(projectRules, item.project);
    if (item.user) await writeFile(userRules, item.user);
    else await rm(userRules, { force: true });
    const before = [sha256(item.project), item.user ? sha256(item.user) : null];
    for (const [kind, prompt] of [["ordinary", "Continue the current task."],
      ["cleanup", "Please clean up AGENTS.md without deleting any instructions."]]) {
      const output = await runInstalledHook(packageRoot, project, env, `${lane}-${item.name}-${kind}`, prompt);
      assert.equal(output.decision, undefined, JSON.stringify(output));
      if (item.unverified) assert.match(output.hookSpecificOutput.message, /did not load or verify/);
      else {
        assert.equal(Object.hasOwn(output.hookSpecificOutput, "message"), false);
        assert(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 1200);
      }
    }
    assert.equal(sha256(await readFile(projectRules)), before[0]);
    if (item.user) assert.equal(sha256(await readFile(userRules)), before[1]);
  }
  const beforeOverflow = sha256(await readFile(projectRules));
  for (const kind of ["text", "image"]) {
    const output = await runInstalledHook(packageRoot, project, env, `${lane}-input-${kind}`,
      kind === "text" ? "ü".repeat(70 * 1024) : "Read the synthetic image.",
      kind === "image" ? { images: [{ data: "A".repeat(2 * 1024 * 1024) }] } : {});
    assert.equal(output.decision, undefined);
    const context = JSON.parse(output.hookSpecificOutput.additionalContext);
    assert.equal(context.loaded, false);
    assert.equal(context.sourceResolution.reason, "hook-input-budget");
    assert.match(output.hookSpecificOutput.message, /input budget exceeded/);
    assert.equal(sha256(await readFile(projectRules)), beforeOverflow);
  }
  return { cases: cases.length, promptsPerCase: 2, inputOverflowCases: 2, sourceBytesPreserved: true };
}

async function verifyInstalled(packageRoot, workspace, lane, expectedVersion) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "agent-spine");
  assert.equal(manifest.version, expectedVersion);
  assert.deepEqual(Object.keys(manifest.bin).sort(), ["agentspine", "agentspine-mcp", "agentspine-worker"]);
  for (const [name, target] of Object.entries(manifest.bin)) {
    await access(join(packageRoot, target));
    const shim = process.platform === "win32" ? `${name}.cmd` : name;
    await access(join(packageRoot, "..", ".bin", shim));
  }

  const project = join(workspace, `project-${lane}`);
  const state = join(workspace, `state-${lane}`);
  const home = join(workspace, `home-${lane}`);
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  const instructions = join(project, "AGENTS.md");
  await writeFile(instructions, "# Synthetic installed-package rules\n\nPreserve these bytes: äöü.\n", "utf8");
  const before = sha256(await readFile(instructions));
  const { stdout } = await run(process.execPath, [
    join(packageRoot, manifest.bin.agentspine), "doctor", project, "--json"
  ], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENTSPINE_STATE_DIR: state }
  });
  const doctor = JSON.parse(stdout);
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal(sha256(await readFile(instructions)), before, "installed entrypoint changed AGENTS.md");
  const sizeContract = await verifyPackedSizeContract(packageRoot, workspace, lane);
  return { entrypoint: manifest.bin.agentspine, doctor: doctor.ok, sourceDigest: before, sizeContract };
}

async function gitIdentity() {
  const [{ stdout: commitOut }, { stdout: treeOut }] = await Promise.all([
    run("git", ["rev-parse", "HEAD"]),
    run("git", ["rev-parse", "HEAD^{tree}"])
  ]);
  const commit = commitOut.trim();
  const tree = treeOut.trim();
  if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(tree, /^[a-f0-9]{40}$/);
  return { commit, tree };
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-packed-install-"));
  try {
    const artifacts = join(workspace, "artifacts");
    await mkdir(artifacts);
    const current = await pack(root, artifacts);
    const tarball = await readFile(current.path);
    const sourceManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(current.name, sourceManifest.name);
    assert.equal(current.version, sourceManifest.version);
    assert(current.files.some(({ path }) => path === "bin/agentspine.js"));
    assert(!current.files.some(({ path }) => path.startsWith(".github/")));

    const freshPrefix = join(workspace, "fresh");
    const freshRoot = await install(current.path, freshPrefix);
    const fresh = await verifyInstalled(freshRoot, workspace, "fresh", sourceManifest.version);

    const previousSource = join(workspace, "previous-source");
    await mkdir(previousSource);
    await writeFile(join(previousSource, "package.json"), JSON.stringify({
      name: "agent-spine", version: "0.65.0", files: ["stale-only.js"]
    }), "utf8");
    await writeFile(join(previousSource, "stale-only.js"), "export const stale = true;\n", "utf8");
    const previous = await pack(previousSource, artifacts);
    const upgradePrefix = join(workspace, "upgrade");
    const upgradeRoot = await install(previous.path, upgradePrefix);
    await access(join(upgradeRoot, "stale-only.js"));
    await install(current.path, upgradePrefix);
    await assert.rejects(access(join(upgradeRoot, "stale-only.js")), { code: "ENOENT" });
    const upgrade = await verifyInstalled(upgradeRoot, workspace, "upgrade", sourceManifest.version);

    const identity = await gitIdentity();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      package: { name: current.name, version: current.version, filename: current.filename,
        bytes: tarball.length, sha256: sha256(tarball), integrity: current.integrity },
      identity,
      platform: process.platform,
      node: process.version,
      fresh,
      upgrade: { from: previous.version, ...upgrade },
      standaloneKingTested: false,
      authority: "packed-install-check-only"
    }, null, process.argv.includes("--json") ? 2 : 0)}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`AgentSpine packed install check failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
