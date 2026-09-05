#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_PACKED_BYTES = 512 * 1024;
const MAX_UNPACKED_BYTES = 2304 * 1024;
const REQUIRED_PACKAGE_FILES = [
  "blun.plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".mcp.json",
  "CHANGELOG.md", "LICENSE", "README.md", "bin/agentspine.js", "bin/agentspine-mcp.js",
  "src/codex-reader-launcher.js", "src/lib/codex-installation.js", "src/cli-host.js",
  "docs/acceptance.md", "docs/source-roots.md", "docs/preflight-recall.md", "docs/preservation-contract.md",
  "docs/world-model.md", "scripts/run-acceptance.js", "skills/agent-spine/SKILL.md",
  "src/index.js", "src/mcp.js", "src/lib/mcp-world-tools.js", "src/lib/world-model.js", "src/worker.js",
  "hooks/hooks.json", "hooks/codex.json", "hooks/version.json"
];
const FORBIDDEN_PACKAGE_PATHS = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.git(?:$|\/)/i,
  /(?:^|\/)\.agentspine(?:$|\/)/i,
  /(?:^|\/)(?:AGENTS|CLAUDE|SOUL|MEMORY)\.md$/i,
  /(?:^|\/)(?:test|\.github)(?:$|\/)/,
  /\.(?:key|pem|p12|pfx)$/i,
  /(?:^|\/)state\.json$/i,
  /(?:^|\/)(?:catalog|graph|world-model|attention|learning|coordination|sharing|sharing-trust|delegation-policy)\.json$/
];

function parse(argv) {
  const options = { root: process.cwd(), tag: null, allowDirty: false, skipPack: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") options.root = argv[++index];
    else if (token === "--tag") options.tag = argv[++index];
    else if (token === "--allow-dirty") options.allowDirty = true;
    else if (token === "--skip-pack") options.skipPack = true;
    else if (token === "--json") options.json = true;
    else throw new Error(`unknown release-check argument: ${token}`);
  }
  options.root = resolve(options.root);
  return options;
}

async function json(root, path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function command(root, args) {
  const npmCli = process.env.npm_execpath;
  const executable = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return spawnSync(executable, commandArgs, { cwd: root, encoding: "utf8" });
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validatePackageReport(report, version) {
  assert(Array.isArray(report) && report.length === 1, "npm pack report must describe exactly one package");
  const item = report[0];
  assert(item.version === version, "npm pack version does not match package.json");
  assert(typeof item.filename === "string" && item.filename.endsWith(`-${version}.tgz`), "npm pack filename is not versioned correctly");
  assert(typeof item.integrity === "string" && item.integrity.startsWith("sha512-"), "npm pack did not report SHA-512 integrity");
  assert(Number.isInteger(item.entryCount) && item.entryCount > 0 && item.entryCount <= 500, "npm package file count is outside the release limit");
  assert(Number.isInteger(item.size) && item.size > 0 && item.size <= MAX_PACKED_BYTES, "npm package exceeds the 512 KiB packed release limit");
  assert(Number.isInteger(item.unpackedSize) && item.unpackedSize > 0 && item.unpackedSize <= MAX_UNPACKED_BYTES, "npm package exceeds the 2.25 MiB unpacked release limit");
  const paths = (item.files || []).map((file) => file.path);
  assert(paths.length === new Set(paths).size, "npm package contains duplicate paths");
  for (const path of REQUIRED_PACKAGE_FILES) assert(paths.includes(path), `npm package is missing required file: ${path}`);
  for (const path of paths) {
    assert(path && !path.startsWith("/") && !path.split("/").includes(".."), `npm package contains an unsafe path: ${path}`);
    assert(!FORBIDDEN_PACKAGE_PATHS.some((pattern) => pattern.test(path)), `npm package contains forbidden state or source material: ${path}`);
  }
  return {
    filename: item.filename, integrity: item.integrity, files: paths.length,
    packedSize: item.size, unpackedSize: item.unpackedSize
  };
}

export async function releaseCheck(options) {
  const [pkg, lock, blun, claude, codex, marketplace, hookVersion, changelog,
    runtimeVersionSource] = await Promise.all([
    json(options.root, "package.json"), json(options.root, "package-lock.json"),
    json(options.root, "blun.plugin.json"),
    json(options.root, ".claude-plugin/plugin.json"), json(options.root, ".codex-plugin/plugin.json"),
    json(options.root, ".claude-plugin/marketplace.json"), json(options.root, "hooks/version.json"),
    readFile(resolve(options.root, "CHANGELOG.md"), "utf8"),
    readFile(resolve(options.root, "src/version.js"), "utf8")
  ]);
  assert(SEMVER_RE.test(pkg.version || ""), "package version is not valid SemVer");
  const versions = [lock.version, lock.packages?.[""]?.version, blun.version, claude.version, codex.version, marketplace.plugins?.[0]?.version, hookVersion.version];
  assert(versions.every((version) => version === pkg.version), "release version differs across package and host manifests");
  const runtimeVersion = runtimeVersionSource.match(/^export const VERSION = "([^"]+)";\s*$/)?.[1];
  assert(runtimeVersion === pkg.version, "release version differs from src/version.js");
  assert(pkg.name === lock.name && pkg.name === lock.packages?.[""]?.name, "package name differs from package-lock.json");
  assert(codex.hooks === "./hooks/codex.json", "Codex release manifest must select hooks/codex.json");
  assert(pkg.repository?.url === "git+https://github.com/Maykbiletti/AgentSpine.git", "package repository must identify the public source repository exactly");
  if (options.tag) {
    assert(options.tag === `v${pkg.version}`, `release tag must be v${pkg.version}`);
    const escaped = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert(new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog), `CHANGELOG.md needs a dated ${pkg.version} section`);
  }
  if (!options.allowDirty) {
    const status = git(options.root, ["status", "--porcelain"]);
    assert(status.status === 0, status.stderr || "git status failed");
    assert(status.stdout.trim() === "", "release worktree must be clean");
  }
  let packageReport = null;
  if (!options.skipPack) {
    const packed = command(options.root, ["pack", "--dry-run", "--ignore-scripts", "--json"]);
    assert(packed.status === 0, packed.stderr || "npm pack --dry-run failed");
    packageReport = validatePackageReport(JSON.parse(packed.stdout), pkg.version);
  }
  return {
    ok: true,
    version: pkg.version,
    tag: options.tag,
    cleanRequired: !options.allowDirty,
    package: packageReport,
    authority: "release-metadata-only"
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const result = await releaseCheck(options);
  process.stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`AgentSpine release check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
