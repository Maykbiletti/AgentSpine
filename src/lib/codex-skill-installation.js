import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { replaceFileWithRetry } from "./filesystem-retry.js";

const MARKER_SCHEMA = "agentspine.codex-skill-installation/v1";
const AUTHORITY = "host-registration-only";
const SKILL_NAME = "agent-spine";
const MAX_SKILL_BYTES = 256 * 1024;

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

function verifySeal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.digest !== "string") return false;
  const { digest, ...payload } = value;
  return digest === sha256(canonical(payload));
}

async function exactDirectory(path, label, { create = false } = {}) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const target = resolve(path);
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return realpath(target);
}

async function regularOrMissing(path, label) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
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

async function sourceSkill(packageRoot) {
  const root = await exactDirectory(packageRoot, "AgentSpine package root");
  const packagePath = join(root, "package.json");
  const skillPath = join(root, "skills", SKILL_NAME, "SKILL.md");
  if (!await regularOrMissing(packagePath, "AgentSpine package manifest")) {
    throw new Error("AgentSpine package manifest is missing");
  }
  if (!await regularOrMissing(skillPath, "AgentSpine skill source")) {
    throw new Error("AgentSpine skill source is missing");
  }
  const [packageText, content] = await Promise.all([
    readFile(packagePath, "utf8"), readFile(skillPath)
  ]);
  if (content.length === 0 || content.length > MAX_SKILL_BYTES) {
    throw new Error("AgentSpine skill source size is outside the install limit");
  }
  const version = JSON.parse(packageText).version;
  if (typeof version !== "string" || !version) throw new Error("AgentSpine package version is missing");
  if (!content.toString("utf8").startsWith("---\nname: agent-spine\n")) {
    throw new Error("AgentSpine skill source has invalid frontmatter");
  }
  return { packageRoot: root, sourcePath: skillPath, version, content, digest: sha256(content) };
}

async function readMarker(path) {
  if (!await regularOrMissing(path, "Codex AgentSpine skill marker")) return null;
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error("Codex AgentSpine skill marker is malformed", { cause: error }); }
  if (!verifySeal(value) || value.schema !== MARKER_SCHEMA || !["updating", "installed"].includes(value.state)) {
    throw new Error("Codex AgentSpine skill marker is invalid");
  }
  return value;
}

async function digestOrNull(path) {
  return await regularOrMissing(path, "Codex AgentSpine SKILL.md") ? sha256(await readFile(path)) : null;
}

async function recoverMarker(marker, markerPath, skillPath, assertOwned) {
  if (!marker) return null;
  const actual = await digestOrNull(skillPath);
  if (marker.state === "installed") {
    if (actual !== marker.skillDigest) throw new Error("installed Codex AgentSpine skill was changed outside its managed update");
    return marker;
  }
  if (actual === marker.targetDigest) {
    const recovered = seal({
      schema: MARKER_SCHEMA, state: "installed", skillName: SKILL_NAME,
      skillDigest: marker.targetDigest, version: marker.targetVersion,
      packageRoot: marker.targetPackageRoot, authority: AUTHORITY
    });
    await atomicWrite(markerPath, `${JSON.stringify(recovered, null, 2)}\n`, assertOwned);
    return recovered;
  }
  if (actual === marker.previousDigest) {
    if (actual === null) {
      await assertOwned();
      await rm(markerPath, { force: true });
      return null;
    }
    const recovered = seal({
      schema: MARKER_SCHEMA, state: "installed", skillName: SKILL_NAME,
      skillDigest: marker.previousDigest, version: marker.previousVersion,
      packageRoot: marker.previousPackageRoot, authority: AUTHORITY
    });
    await atomicWrite(markerPath, `${JSON.stringify(recovered, null, 2)}\n`, assertOwned);
    return recovered;
  }
  throw new Error("Codex AgentSpine skill update has an unrecognized partial state");
}

export function defaultCodexSkillsRoot(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return resolve(env.AGENTSPINE_CODEX_SKILLS_ROOT || join(home, ".agents", "skills"));
}

export async function installCodexSkill({
  skillsRoot = defaultCodexSkillsRoot(), packageRoot,
  faultAfter = null
} = {}) {
  const source = await sourceSkill(packageRoot);
  const root = await exactDirectory(skillsRoot, "Codex user skills root", { create: true });
  const skillDirectoryPath = join(root, SKILL_NAME);
  const lockPath = join(root, ".agent-spine-install.lock");
  if (await regularOrMissing(lockPath, "Codex AgentSpine skill install lock")) {
    // withOwnedFileLock owns regular stale/current lock handling.
  }
  return withOwnedFileLock(lockPath, async ({ assertOwned, recovered: lockRecovered }) => {
    let created = false;
    try { await exactDirectory(skillDirectoryPath, "Codex AgentSpine skill directory"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(skillDirectoryPath, { mode: 0o700 });
      created = true;
    }
    const skillDirectory = await realpath(skillDirectoryPath);
    const markerPath = join(skillDirectory, ".agentspine-install.json");
    const skillPath = join(skillDirectory, "SKILL.md");
    let marker = await readMarker(markerPath);
    if (!marker && !created) {
      throw new Error("Codex already has an unmanaged agent-spine skill directory");
    }
    marker = await recoverMarker(marker, markerPath, skillPath, assertOwned);
    if (marker?.skillDigest === source.digest && marker.version === source.version
      && marker.packageRoot === source.packageRoot) {
      return {
        schema: "agentspine.codex-skill-install-result/v1", status: "unchanged",
        version: source.version, packageRoot: source.packageRoot, skillPath, skillDigest: source.digest,
        markerPath, markerDigest: marker.digest, recovered: lockRecovered, authority: AUTHORITY
      };
    }
    const updating = seal({
      schema: MARKER_SCHEMA, state: "updating", skillName: SKILL_NAME,
      previousDigest: marker?.skillDigest ?? null, previousVersion: marker?.version ?? null,
      previousPackageRoot: marker?.packageRoot ?? null,
      targetDigest: source.digest, targetVersion: source.version,
      targetPackageRoot: source.packageRoot, authority: AUTHORITY
    });
    await atomicWrite(markerPath, `${JSON.stringify(updating, null, 2)}\n`, assertOwned);
    if (faultAfter === "marker") throw new Error("synthetic crash after Codex skill update marker");
    await atomicWrite(skillPath, source.content, assertOwned);
    if (faultAfter === "skill") throw new Error("synthetic crash after Codex skill publication");
    const installed = seal({
      schema: MARKER_SCHEMA, state: "installed", skillName: SKILL_NAME,
      skillDigest: source.digest, version: source.version,
      packageRoot: source.packageRoot, authority: AUTHORITY
    });
    await atomicWrite(markerPath, `${JSON.stringify(installed, null, 2)}\n`, assertOwned);
    return {
      schema: "agentspine.codex-skill-install-result/v1",
      status: marker ? "updated" : "installed", version: source.version, packageRoot: source.packageRoot,
      skillPath, skillDigest: source.digest, markerPath, markerDigest: installed.digest,
      recovered: lockRecovered, authority: AUTHORITY
    };
  });
}
