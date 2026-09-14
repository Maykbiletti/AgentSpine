#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  return { entrypoint: manifest.bin.agentspine, doctor: doctor.ok, sourceDigest: before };
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
