import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const SID_RE = /\bS-\d+(?:-\d+)+\b/i;
const WRITE_RIGHTS = new Set(["AD", "D", "DC", "DE", "F", "GA", "GW", "M", "W", "WA", "WD", "WDAC", "WEA", "WO"]);
const SYSTEM_PRINCIPALS = new Set([
  "s-1-5-18", "nt authority\\system", "system", "s-1-5-32-544", "builtin\\administrators", "administrators"
]);
const FILE_ROLES = new Set(["key", "state", "head", "private"]);
const CACHE = new Map();

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
function isSelf(principal, identity) { return principal === identity.sid || principal === identity.account; }
function isTrustedWriter(principal, identity) { return isSelf(principal, identity) || SYSTEM_PRINCIPALS.has(principal); }
function isTrustedParentWriter(entry, identity) {
  return isTrustedWriter(entry.principal, identity) || (entry.principal === "creator owner" && entry.rights.includes("IO"));
}

function verifyParent(entries, identity) {
  if (!entries.length) throw new Error("session timeline Windows parent ACL has no readable entries");
  const unsafe = entries.find((entry) => canWrite(entry) && !isTrustedParentWriter(entry, identity));
  if (unsafe) throw new Error(`session timeline Windows parent ACL grants write access to ${unsafe.principal}`);
}

function verifyIntegrity(entries, identity) {
  if (entries.length !== 1 || !isSelf(entries[0].principal, identity) || entries[0].rights.includes("I")
    || !entries[0].rights.includes("F")) {
    throw new Error("session timeline Windows integrity ACL is not private to the current SID");
  }
}

function verifyFile(entries, identity, role) {
  if (!entries.length || entries.some((entry) => !isSelf(entry.principal, identity) || !entry.rights.includes("F"))) {
    throw new Error(`session timeline Windows ${role} ACL is not private to the current SID`);
  }
}

function fingerprint(metadata) {
  if (!metadata) return null;
  return [metadata.dev, metadata.ino, metadata.mtimeNs, metadata.ctimeNs].map(String).join(":");
}

export function createWindowsTimelineAclVerifier({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  return async function verifyWindowsTimelineDirectoryAcl(path, { created = false, metadata = null, role = "integrity" } = {}) {
    if (platform !== "win32") return;
    if (!isAbsolute(path) || !["integrity", "parent"].includes(role)) {
      throw new Error("session timeline Windows ACL request is invalid");
    }
    const cached = `${role}:${path.toLowerCase()}:${fingerprint(metadata)}`;
    if (!created && fingerprint(metadata) && CACHE.has(cached)) return;
    const whoami = executable("whoami.exe", env);
    const icacls = executable("icacls.exe", env);
    const identity = identityFrom(runCommand(run, whoami, ["/user", "/fo", "csv", "/nh"], env));
    if (role === "integrity" && created) {
      runCommand(run, icacls, [path, "/inheritance:r", "/grant:r", `*${identity.sid}:(OI)(CI)(F)`], env);
    }
    runCommand(run, icacls, [path, "/verify"], env);
    const entries = entriesFrom(runCommand(run, icacls, [path], env), path);
    if (role === "integrity") verifyIntegrity(entries, identity); else verifyParent(entries, identity);
    if (fingerprint(metadata)) CACHE.set(cached, true);
  };
}

// File ACLs are checked on every timeline integrity read/write boundary. The
// directory's SID-only ACL protects new children, while this denies a later
// direct ACL grant on a key, state, or authenticated head/sidecar.
export function createWindowsTimelineFileAclVerifier({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  return async function verifyWindowsTimelineFileAcl(path, { created = false, role = "private" } = {}) {
    if (platform !== "win32") return;
    if (!isAbsolute(path) || !FILE_ROLES.has(role)) {
      throw new Error("session timeline Windows file ACL request is invalid");
    }
    const whoami = executable("whoami.exe", env);
    const icacls = executable("icacls.exe", env);
    const identity = identityFrom(runCommand(run, whoami, ["/user", "/fo", "csv", "/nh"], env));
    if (created) runCommand(run, icacls, [path, "/inheritance:r", "/grant:r", `*${identity.sid}:(F)`], env);
    runCommand(run, icacls, [path, "/verify"], env);
    verifyFile(entriesFrom(runCommand(run, icacls, [path], env), path), identity, role);
  };
}

const verifyWindowsTimelineDirectoryAcl = createWindowsTimelineAclVerifier();
const verifyWindowsTimelineFileAcl = createWindowsTimelineFileAclVerifier();

export { entriesFrom as parseWindowsIcaclsEntries };
export { verifyWindowsTimelineDirectoryAcl, verifyWindowsTimelineFileAcl };
