import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Numeric FileSystemRights values and SDDL tokens are stable across Windows
// display languages. Friendly account names never enter the authorization path.
const FULL_CONTROL = 0x001f01ff;
const WRITE_MASK = 0x000d0156;
const GENERIC_WRITE_MASK = 0x50000000;
const MAX_ACL_BYTES = 1024 * 1024;
const SID = /^S-1-\d+(?:-\d+)+$/i;
const DACL_FLAGS = /^(?:(?:P|AR|AI))*$/;
const ACE_FLAGS = new Set(["CI", "OI", "NP", "IO", "ID"]);
const RIGHT_TOKENS = new Set([
  "GA", "GR", "GW", "GX", "RC", "SD", "WD", "WO",
  "RP", "WP", "CC", "DC", "LC", "SW", "LO", "DT", "CR",
  "FA", "FR", "FW", "FX", "KA", "KR", "KW", "KX",
  "NR", "NW", "NX"
]);
const WRITE_TOKENS = new Set([
  "GA", "GW", "SD", "WD", "WO", "WP", "CC", "DC", "SW", "DT", "CR",
  "FA", "FW", "KA", "KW"
]);
const TRUSTEE_ALIASES = new Map([
  ["SY", "s-1-5-18"],
  ["BA", "s-1-5-32-544"],
  ["CO", "s-1-3-0"],
  ["LA", "sddl:la"]
]);

function splitTokens(value, allowed, label) {
  if (value.length % 2 !== 0) {
    throw new Error(`session timeline Windows SDDL ${label} is malformed`);
  }
  const tokens = value.match(/../g) || [];
  if (tokens.some(token => !allowed.has(token))) {
    throw new Error(`session timeline Windows SDDL ${label} is unsupported`);
  }
  return tokens;
}

function principalFromSddl(value, localAdministratorSid) {
  if (SID.test(value)) return value.toLowerCase();
  if (value === "LA" && SID.test(localAdministratorSid || "")
    && localAdministratorSid.toLowerCase().endsWith("-500")) {
    return localAdministratorSid.toLowerCase();
  }
  if (TRUSTEE_ALIASES.has(value)) return TRUSTEE_ALIASES.get(value);
  if (/^[A-Z]{2}$/.test(value)) return `sddl:${value.toLowerCase()}`;
  throw new Error("session timeline Windows SDDL trustee is malformed");
}

function numericRights(value) {
  if (!/^0x[0-9a-f]{1,8}$/i.test(value)) return null;
  return Number.parseInt(value.slice(2), 16) >>> 0;
}

function rightsFromSddl(value, type, flags) {
  const rights = [];
  if (flags.includes("ID")) rights.push("I");
  if (flags.includes("IO")) rights.push("IO");
  if (type === "D") return [...rights, "DENY"];
  const mask = numericRights(value);
  if (mask === null) {
    const tokens = splitTokens(value, RIGHT_TOKENS, "rights");
    if (tokens.includes("FA") || tokens.includes("GA")) rights.push("F");
    if (tokens.some(token => WRITE_TOKENS.has(token))) rights.push("W");
    return rights;
  }
  if ((mask & FULL_CONTROL) === FULL_CONTROL || (mask & 0x10000000) !== 0) rights.push("F");
  if ((mask & WRITE_MASK) !== 0 || (mask & GENERIC_WRITE_MASK) !== 0) rights.push("W");
  return rights;
}

export function parseWindowsSddlAcl(sddl, { localAdministratorSid = null } = {}) {
  if (typeof sddl !== "string" || sddl.length > MAX_ACL_BYTES) {
    throw new Error("session timeline Windows SDDL is unavailable");
  }
  const value = sddl.replace(/^\uFEFF/, "").trim();
  if (!value.startsWith("D:")) throw new Error("session timeline Windows SDDL has no DACL");
  const firstAce = value.indexOf("(", 2);
  if (firstAce < 0 || !DACL_FLAGS.test(value.slice(2, firstAce))) {
    throw new Error("session timeline Windows SDDL flags are malformed");
  }
  const entries = [];
  let offset = firstAce;
  while (offset < value.length) {
    const match = /^\(([^()]*)\)/.exec(value.slice(offset));
    if (!match) throw new Error("session timeline Windows SDDL ACE is malformed");
    const fields = match[1].split(";");
    if (fields.length !== 6 || !["A", "D"].includes(fields[0]) || fields[3] || fields[4]) {
      throw new Error("session timeline Windows SDDL ACE is unsupported");
    }
    const flags = splitTokens(fields[1], ACE_FLAGS, "ACE flags");
    const principal = principalFromSddl(fields[5], localAdministratorSid);
    entries.push({ principal, rights: rightsFromSddl(fields[2], fields[0], flags) });
    if (entries.length > 2048) throw new Error("session timeline Windows SDDL exceeds ACE limit");
    offset += match[0].length;
  }
  if (!entries.length) throw new Error("session timeline Windows SDDL has no ACEs");
  return entries;
}

export function parseWindowsAclSave(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ACL_BYTES || bytes.length % 2 !== 0) {
    throw new Error("session timeline Windows ACL save is unavailable");
  }
  const lines = bytes.toString("utf16le").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length !== 2 || !lines[0].trim() || !lines[1].trim().startsWith("D:")) {
    throw new Error("session timeline Windows ACL save is malformed");
  }
  return parseWindowsSddlAcl(lines[1].trim(), options);
}

export function windowsAclSaveCommand(path, outputPath) {
  return [path, "/save", outputPath, "/q"];
}

async function readStableAclFile(path, options) {
  const pathname = await lstat(path, { bigint: true });
  if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.nlink !== 1n
    || pathname.size <= 0n || pathname.size > BigInt(MAX_ACL_BYTES)) {
    throw new Error("session timeline Windows ACL save is unsafe");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) {
      throw new Error("session timeline Windows ACL save changed while reading");
    }
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[field] !== after[field] || after[field] !== current[field]) {
        throw new Error("session timeline Windows ACL save changed while reading");
      }
    }
    return parseWindowsAclSave(bytes, options);
  } finally {
    await handle.close();
  }
}

export function windowsLocalAdministratorSid(identity, env) {
  if (!identity || !SID.test(identity.sid || "") || typeof identity.account !== "string") return null;
  const computer = typeof env?.COMPUTERNAME === "string" ? env.COMPUTERNAME.trim().toLowerCase() : "";
  const [domain] = identity.account.trim().toLowerCase().split("\\");
  if (!computer || domain !== computer || !identity.sid.toLowerCase().endsWith("-500")) return null;
  return identity.sid.toLowerCase();
}

async function readNativeWindowsAcl(path, env, runCommand, run, identity) {
  const directory = await mkdtemp(join(tmpdir(), "agentspine-timeline-sddl-"));
  const outputPath = join(directory, `${randomUUID()}.acl`);
  try {
    const claim = await open(outputPath, "wx", 0o600);
    await claim.close();
    const binary = join(env.SystemRoot, "System32", "icacls.exe");
    runCommand(run, binary, windowsAclSaveCommand(path, outputPath), env);
    return await readStableAclFile(outputPath, {
      localAdministratorSid: windowsLocalAdministratorSid(identity, env)
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Retained only for dependency-injected compatibility tests. Production uses
// icacls /save and parses its SID/SDDL export without starting PowerShell.
export function windowsSidAclCommand(path) {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "if ([IO.Directory]::Exists($target)) { $acl = [IO.Directory]::GetAccessControl($target) }",
    "else { $acl = [IO.File]::GetAccessControl($target) }",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {",
    "  [PSCustomObject]@{ sid=$_.IdentityReference.Value; mask=[int]$_.FileSystemRights; inherited=$_.IsInherited; propagation=[int]$_.PropagationFlags; inheritance=[int]$_.InheritanceFlags; type=[int]$_.AccessControlType }",
    "})",
    "$rules | ConvertTo-Json -Compress -AsArray"
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")];
}

export async function readWindowsSidAcl(path, env, runCommand, run, identity = null) {
  if (run === spawnSync) return readNativeWindowsAcl(path, env, runCommand, run, identity);
  const binary = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return parseWindowsSidAcl(runCommand(run, binary, windowsSidAclCommand(path), env));
}

export function parseWindowsSidAcl(output) {
  const rows = JSON.parse(output);
  if (!Array.isArray(rows) || !rows.length || rows.length > 2048) {
    throw new Error("session timeline Windows SID ACL is unavailable");
  }
  return rows.map(row => {
    if (!row || !SID.test(row.sid) || typeof row.inherited !== "boolean"
      || !Number.isInteger(row.mask) || row.mask < 0 || row.mask > 0x1fffff
      || ![0, 1].includes(row.type) || ![0, 1, 2, 3].includes(row.propagation)
      || ![0, 1, 2, 3].includes(row.inheritance)) {
      throw new Error("session timeline Windows SID ACL is malformed");
    }
    const rights = [];
    if (row.inherited) rights.push("I");
    if (row.propagation & 2) rights.push("IO");
    if (row.type === 1) rights.push("DENY");
    else {
      if ((row.mask & FULL_CONTROL) === FULL_CONTROL) rights.push("F");
      if (row.mask & WRITE_MASK) rights.push("W");
    }
    return { principal: row.sid.toLowerCase(), rights };
  });
}
