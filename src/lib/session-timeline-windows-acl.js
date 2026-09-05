import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { readWindowsSidAcl } from "./session-timeline-sid-acl.js";

const SID_RE = /\bS-\d+(?:-\d+)+\b/i;
const WRITE_RIGHTS = new Set(["AD", "D", "DC", "DE", "F", "GA", "GW", "M", "W", "WA", "WD", "WDAC", "WEA", "WO"]);
const SYSTEM_PRINCIPALS = new Set([
  "s-1-5-18", "s-1-5-32-544", "sddl:la"
]);
const MANDATORY_LABEL_PREFIX = "mandatory label\\";
const FILE_ROLES = new Set(["key", "state", "head", "private"]);

function failure(message, result = null) {
  const detail = result?.error?.message || result?.stderr || result?.stdout || "no diagnostic";
  throw new Error(`session timeline Windows ACL ${message}: ${String(detail).trim().slice(0, 240)}`);
}

function executable(name, env) {
  const root = env.SystemRoot;
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("session timeline Windows system root is unavailable");
  return join(root, "System32", name);
}

function runCommand(run, binary, args, env) {
  const result = run(binary, args, { encoding: "utf8", env, shell: false, timeout: 1_500, windowsHide: true });
  if (!result || result.status !== 0 || result.error || result.signal) failure(`${binary} failed`, result);
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function identityFrom(output) {
  const sid = output.match(SID_RE)?.[0]?.toLowerCase();
  const account = output.match(/^\s*"((?:[^"]|"")*)"\s*,/m)?.[1]?.replaceAll('""', '"').toLowerCase();
  if (!sid || !account) throw new Error("session timeline Windows identity is unavailable");
  return { sid, account };
}

function normalizedPrincipal(value) {
  return value.trim().replace(/^\*/, "").replaceAll("/", "\\").toLowerCase();
}

function entriesFrom(output, path) {
  const values = [];
  let first = true;
  for (const source of output.split(/\r?\n/)) {
    let line = source.trim();
    if (!line) continue;
    if (first && line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length).trim();
    first = false;
    const match = line.match(/^(.+?):((?:\([^)]*\))+)/);
    if (!match) continue;
    values.push({ principal: normalizedPrincipal(match[1]), rights: [...match[2].matchAll(/\(([^)]*)\)/g)].map((item) => item[1].toUpperCase()) });
  }
  return values;
}

function canWrite(entry) { return entry.rights.some((right) => WRITE_RIGHTS.has(right)); }
function isSelf(principal, identity) { return principal === identity.sid; }
export function isTrustedWindowsWriter(principal, identity) {
  return isSelf(principal, identity) || SYSTEM_PRINCIPALS.has(principal);
}
function isMandatoryLabel(entry) {
  return entry.principal.startsWith(MANDATORY_LABEL_PREFIX)
    && entry.rights.every((right) => new Set(["I", "IO", "OI", "CI", "NW"]).has(right));
}
function isPrivatePrincipal(entry, identity) {
  return isTrustedWindowsWriter(entry.principal, identity) || isMandatoryLabel(entry);
}
function isTrustedParentWriter(entry, identity) {
  return isTrustedWindowsWriter(entry.principal, identity)
    || (entry.principal === "s-1-3-0" && entry.rights.includes("IO"));
}

function verifyParent(entries, identity) {
  if (!entries.length) throw new Error("session timeline Windows parent ACL has no readable entries");
  const unsafe = entries.find((entry) => canWrite(entry) && !isTrustedParentWriter(entry, identity));
  if (unsafe) throw new Error(`session timeline Windows parent ACL grants write access to ${unsafe.principal}`);
}

function verifyIntegrity(entries, identity) {
  const owner = entries.find((entry) => isSelf(entry.principal, identity)
    && entry.rights.includes("F") && !entry.rights.includes("I") && !entry.rights.includes("IO"));
  if (!owner || entries.some((entry) => !isPrivatePrincipal(entry, identity))) {
    throw new Error("session timeline Windows integrity ACL is not private to the current SID");
  }
}

function verifyFile(entries, identity, role) {
  const owner = entries.find((entry) => isSelf(entry.principal, identity)
    && entry.rights.includes("F") && !entry.rights.includes("IO"));
  if (!owner || entries.some((entry) => !isPrivatePrincipal(entry, identity))) {
    throw new Error(`session timeline Windows ${role} ACL is not private to the current SID`);
  }
}

function fingerprint(metadata) {
  if (!metadata) return null;
  return [metadata.dev, metadata.ino, metadata.mtimeNs, metadata.ctimeNs].map(String).join(":");
}

export function createWindowsTimelineAclVerifier({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const cache = new Map();
  let identity = null;
  return async function verifyWindowsTimelineDirectoryAcl(path, { created = false, metadata = null, role = "integrity" } = {}) {
    if (platform !== "win32") return;
    if (!isAbsolute(path) || !["integrity", "parent"].includes(role)) {
      throw new Error("session timeline Windows ACL request is invalid");
    }
    const cached = `${role}:${path.toLowerCase()}:${fingerprint(metadata)}`;
    if (!created && fingerprint(metadata) && cache.has(cached)) return;
    const whoami = executable("whoami.exe", env);
    const icacls = executable("icacls.exe", env);
    identity ||= identityFrom(runCommand(run, whoami, ["/user", "/fo", "csv", "/nh"], env));
    if (role === "integrity" && created) {
      runCommand(run, icacls, [path, "/inheritance:r", "/grant:r", `*${identity.sid}:(OI)(CI)(F)`], env);
    }
    const entries = await readWindowsSidAcl(path, env, runCommand, run, identity);
    if (role === "integrity") verifyIntegrity(entries, identity); else verifyParent(entries, identity);
    if (!created && fingerprint(metadata)) cache.set(cached, true);
  };
}

// Every boundary supplies fresh file metadata. On Windows, changing a security
// descriptor changes ctime, so only an identical file identity/change-time can
// reuse a parsed ACL. A changed DACL therefore misses this cache and is denied.
export function createWindowsTimelineFileAclVerifier({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const cache = new Map();
  let identity = null;
  return async function verifyWindowsTimelineFileAcl(path, { created = false, metadata = null, role = "private" } = {}) {
    if (platform !== "win32") return;
    if (!isAbsolute(path) || !FILE_ROLES.has(role)) {
      throw new Error("session timeline Windows file ACL request is invalid");
    }
    const cached = `${role}:${path.toLowerCase()}:${fingerprint(metadata)}`;
    if (!created && fingerprint(metadata) && cache.has(cached)) return;
    const whoami = executable("whoami.exe", env);
    const icacls = executable("icacls.exe", env);
    identity ||= identityFrom(runCommand(run, whoami, ["/user", "/fo", "csv", "/nh"], env));
    if (created) runCommand(run, icacls, [path, "/inheritance:r", "/grant:r", `*${identity.sid}:(F)`], env);
    verifyFile(await readWindowsSidAcl(path, env, runCommand, run, identity), identity, role);
    if (!created && fingerprint(metadata)) cache.set(cached, true);
  };
}

const verifyWindowsTimelineDirectoryAcl = createWindowsTimelineAclVerifier();
const verifyWindowsTimelineFileAcl = createWindowsTimelineFileAclVerifier();

export { entriesFrom as parseWindowsIcaclsEntries };
export { verifyWindowsTimelineDirectoryAcl, verifyWindowsTimelineFileAcl };
