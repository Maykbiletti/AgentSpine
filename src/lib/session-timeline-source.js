import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isInside } from "./paths.js";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function metadataValue(metadata, key) {
  return String(metadata[key] ?? BigInt(Math.floor(Number(metadata[`${key.slice(0, -2)}Ms`]) * 1_000_000)));
}

function sourceIdentity(metadata) { return [metadata.dev, metadata.ino].join(":"); }

const SOURCE_LOCATION_KEYS = ["path", "profileRoot", "projectsRoot", "pathDigest", "identity"];

export function validSessionTimelineSourceMetadata(value) {
  return value && typeof value.path === "string" && isAbsolute(value.path) && value.path.length <= 4096
    && typeof value.profileRoot === "string" && isAbsolute(value.profileRoot) && value.profileRoot.length <= 4096
    && typeof value.projectsRoot === "string" && isAbsolute(value.projectsRoot) && value.projectsRoot.length <= 4096
    && value.pathDigest === digest(value.path) && typeof value.identity === "string" && value.identity.length > 0
    && Number.isSafeInteger(value.size) && value.size >= 0
    && /^[0-9]+$/.test(value.mtimeNs || "") && /^[0-9]+$/.test(value.ctimeNs || "");
}

export function sameSessionTimelineSourceLocation(left, right) {
  return validSessionTimelineSourceMetadata(left) && validSessionTimelineSourceMetadata(right)
    && SOURCE_LOCATION_KEYS.every((key) => left[key] === right[key]);
}

export async function sourcePath(value, hostHome) {
  if (typeof value !== "string" || !isAbsolute(value)) return { status: "unavailable", reason: "no-validated-transcript" };
  let profileRoot; let projectsRoot;
  try {
    if (!isAbsolute(hostHome || "")) throw new Error("invalid-host-root");
    const profile = await lstat(hostHome);
    if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error("invalid-host-root");
    profileRoot = await realpath(hostHome);
    const projectsPath = join(profileRoot, "projects");
    const projects = await lstat(projectsPath);
    if (!projects.isDirectory() || projects.isSymbolicLink()) throw new Error("invalid-host-root");
    projectsRoot = await realpath(projectsPath);
    if (!isInside(profileRoot, projectsRoot)) throw new Error("invalid-host-root");
  }
  catch (error) { return { status: "unavailable", reason: error.code === "ENOENT" ? "no-validated-transcript" : "transcript-root-unavailable" }; }
  let metadata;
  try { metadata = await lstat(value, { bigint: true }); }
  catch (error) { return { status: "unavailable", reason: error.code === "ENOENT" ? "transcript-missing" : "transcript-unreadable" }; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    return { status: "unavailable", reason: "transcript-not-regular" };
  }
  let canonical;
  try { canonical = await realpath(value); }
  catch { return { status: "unavailable", reason: "transcript-unreadable" }; }
  if (!isInside(projectsRoot, canonical)) return { status: "unavailable", reason: "transcript-outside-host-projects" };
  return { status: "registered", path: canonical, profileRoot, projectsRoot, pathDigest: digest(canonical),
    identity: [metadata.dev, metadata.ino].join(":"), size: Number(metadata.size),
    mtimeNs: metadataValue(metadata, "mtimeNs"), ctimeNs: metadataValue(metadata, "ctimeNs") };
}

export function matchesSourceMetadata(metadata, source) {
  const identity = [metadata.dev, metadata.ino].join(":");
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n && identity === source.identity
    && Number(metadata.size) === source.size && metadataValue(metadata, "mtimeNs") === source.mtimeNs
    && metadataValue(metadata, "ctimeNs") === source.ctimeNs;
}

export async function pathMatchesSource(source, hostHome = null) {
  // A post-compaction read may not have a fresh host root. The persisted
  // enrollment root is the sealed authority in that case; ambient process
  // configuration must never redirect a previously bound transcript.
  const trustedHome = isAbsolute(hostHome || "") ? hostHome : source?.profileRoot;
  if (!isAbsolute(trustedHome || "")) return false;
  const current = await sourcePath(source.path, trustedHome);
  return current.status === "registered" && current.profileRoot === source.profileRoot && current.projectsRoot === source.projectsRoot
    && current.pathDigest === source.pathDigest && current.identity === source.identity
    && current.size === source.size && current.mtimeNs === source.mtimeNs && current.ctimeNs === source.ctimeNs;
}
