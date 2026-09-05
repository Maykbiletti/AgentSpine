import { join } from "node:path";

// Numeric FileSystemRights values are stable across Windows display languages.
const FULL_CONTROL = 0x1f01ff;
const WRITE_MASK = 0x000d0156;
const SID = /^S-1-\d+(?:-\d+)+$/i;

export function windowsSidAclCommand(path) {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$acl = Get-Acl -LiteralPath $target",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {",
    "  @{ sid = $_.IdentityReference.Value; mask = [int]$_.FileSystemRights;",
    "     inherited = [bool]$_.IsInherited; propagation = [int]$_.PropagationFlags;",
    "     inheritance = [int]$_.InheritanceFlags; type = [int]$_.AccessControlType }",
    "})",
    "ConvertTo-Json -InputObject $rules -Compress"
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")];
}

export function readWindowsSidAcl(path, env, runCommand, run) {
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
