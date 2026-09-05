import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { defaultCodexSkillsRoot, installCodexSkill } from "./codex-skill-installation.js";

const REGISTRATION_SCHEMA = "agentspine.codex-reader-registration/v1";
const AUTHORITY = "host-registration-only";
const START = "# BEGIN AGENTSPINE MANAGED MCP";
const END = "# END AGENTSPINE MANAGED MCP";
const MAX_CONFIG_BYTES = 1024 * 1024;
const EXPECTED_TOOLS = [
  "session_briefing", "delivery_knowledge_query",
  "record_delivery_premortem", "read_document"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function seal(value) {
  return { ...value, digest: sha256(canonical(value)) };
}

async function regularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return path;
}

async function exactDirectory(path, label, { create = false } = {}) {
  const target = resolve(path);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
  return realpath(target);
}

async function optionalText(path) {
  try {
    await regularFile(path, "Codex config.toml");
    const value = await readFile(path, "utf8");
    if (Buffer.byteLength(value) > MAX_CONFIG_BYTES) throw new Error("Codex config.toml exceeds 1 MiB");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function regularOrMissing(path, label) {
  try {
    await regularFile(path, label);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function managedRange(text) {
  const starts = [...text.matchAll(new RegExp(`^${START}$`, "gm"))];
  const ends = [...text.matchAll(new RegExp(`^${END}$`, "gm"))];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index) {
    throw new Error("Codex config contains a malformed AgentSpine managed block");
  }
  let end = ends[0].index + END.length;
  if (text.slice(end, end + 2) === "\r\n") end += 2;
  else if (text[end] === "\n") end += 1;
  const start = starts[0].index > 0 ? starts[0].index - 1 : starts[0].index;
  return { start, end };
}

function hasRegistration(text) {
  return /^\s*\[\s*mcp_servers\s*\.\s*(?:agent-spine|["']agent-spine["'])\s*\]\s*(?:#.*)?$/m.test(text);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function managedBlock(nodePath, launcherPath) {
  return [
    START,
    "[mcp_servers.agent-spine]",
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(launcherPath)}]`,
    "enabled = true",
    END,
    ""
  ].join("\n");
}

function updateConfig(text, block) {
  const range = managedRange(text);
  if (range) {
    const prefix = text.slice(0, range.start);
    const suffix = text.slice(range.end);
    const outside = prefix + suffix;
    if (hasRegistration(outside)) throw new Error("Codex config has an unmanaged AgentSpine MCP registration");
    return { text: prefix + (prefix.length ? "\n" : "") + block + suffix,
      outsideBefore: outside, outsideAfter: outside, status: "updated" };
  }
  if (hasRegistration(text)) throw new Error("Codex config has an unmanaged AgentSpine MCP registration");
  const separator = text.length ? "\n" : "";
  return { text: text + separator + block,
    outsideBefore: text, outsideAfter: text, status: "installed" };
}

async function atomicWrite(path, content, assertOwned) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertOwned });
  } finally {
    await handle?.close();
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function packageRegistration(packageRoot, nodePath) {
  const root = await exactDirectory(packageRoot, "AgentSpine package root");
  const entrypoint = await regularFile(join(root, "src", "mcp.js"), "AgentSpine MCP entrypoint");
  const versionSource = await regularFile(join(root, "src", "version.js"), "AgentSpine version source");
  const packageFile = await regularFile(join(root, "package.json"), "AgentSpine package manifest");
  const packageJson = await readFile(packageFile, "utf8");
  const pkg = JSON.parse(packageJson);
  const source = await readFile(versionSource, "utf8");
  const sourceVersion = source.match(/^export const VERSION = "([^"]+)";\s*$/)?.[1];
  if (!pkg.version || sourceVersion !== pkg.version) throw new Error("AgentSpine package and runtime versions differ");
  const canonicalNode = await realpath(await regularFile(nodePath, "Node.js runtime"));
  return seal({
    schema: REGISTRATION_SCHEMA,
    expectedName: "agent-spine",
    expectedVersion: pkg.version,
    expectedTools: EXPECTED_TOOLS,
    packageRoot: root,
    nodePath: canonicalNode,
    entrypoint,
    entrypointDigest: sha256(await readFile(entrypoint)),
    packageDigest: sha256(packageJson),
    versionSourceDigest: sha256(source),
    authority: AUTHORITY
  });
}

export function defaultCodexHome(env = process.env) {
  return resolve(env.CODEX_HOME || join(homedir(), ".codex"));
}

export async function installCodexMcp({
  codexHome = defaultCodexHome(),
  skillsRoot = defaultCodexSkillsRoot(),
  packageRoot = fileURLToPath(new URL("../..", import.meta.url)),
  nodePath = process.execPath,
  faultAfter = null
} = {}) {
  const home = await exactDirectory(codexHome, "Codex home", { create: true });
  const managed = join(home, "agentspine");
  await exactDirectory(managed, "Codex AgentSpine directory", { create: true });
  const configPath = join(home, "config.toml");
  const launcherPath = join(managed, "reader-launcher.mjs");
  const registrationPath = join(managed, "registration.json");
  const lockPath = join(managed, "install.lock");
  try {
    const lock = await lstat(lockPath);
    if (lock.isSymbolicLink()) throw new Error("Codex AgentSpine install lock must not be a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return withOwnedFileLock(lockPath, async ({ assertOwned }) => {
    await Promise.all([
      regularOrMissing(launcherPath, "Codex AgentSpine launcher"),
      regularOrMissing(registrationPath, "Codex AgentSpine registration")
    ]);
    const [before, registration, launcher] = await Promise.all([
      optionalText(configPath), packageRegistration(packageRoot, nodePath),
      readFile(fileURLToPath(new URL("../codex-reader-launcher.js", import.meta.url)))
    ]);
    const update = updateConfig(before, managedBlock(registration.nodePath, launcherPath));
    if (update.outsideBefore !== update.outsideAfter) throw new Error("unmanaged Codex configuration bytes changed");
    const skill = await installCodexSkill({
      skillsRoot, packageRoot,
      faultAfter: faultAfter === "skill-marker" ? "marker" : faultAfter === "skill" ? "skill" : null
    });
    if (skill.version !== registration.expectedVersion || skill.packageRoot !== registration.packageRoot) {
      throw new Error("Codex skill and MCP reader package identity differ");
    }
    await atomicWrite(launcherPath, launcher, assertOwned);
    if (faultAfter === "launcher") throw new Error("synthetic crash after launcher publication");
    await atomicWrite(registrationPath, `${JSON.stringify(registration, null, 2)}\n`, assertOwned);
    if (faultAfter === "registration") throw new Error("synthetic crash after registration publication");
    await atomicWrite(configPath, update.text, assertOwned);
    return {
      schema: "agentspine.codex-installation/v1",
      status: update.status,
      version: registration.expectedVersion,
      configPath,
      launcherPath,
      registrationPath,
      registrationDigest: registration.digest,
      unmanagedBeforeDigest: sha256(update.outsideBefore),
      unmanagedAfterDigest: sha256(update.outsideAfter),
      configDigest: sha256(update.text),
      skill,
      restartRequired: true,
      authority: AUTHORITY
    };
  });
}

export function stripManagedCodexBlock(text) {
  const range = managedRange(text);
  return range ? text.slice(0, range.start) + text.slice(range.end) : text;
}
