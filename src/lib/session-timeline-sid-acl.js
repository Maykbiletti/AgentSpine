import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

// Numeric FileSystemRights values are stable across Windows display languages.
const FULL_CONTROL = 0x1f01ff;
const WRITE_MASK = 0x000d0156;
const SID = /^S-1-\d+(?:-\d+)+$/i;

function aclScript(targetLine) {
  return [
    targetLine,
    "if ([IO.Directory]::Exists($target)) { $acl = [IO.Directory]::GetAccessControl($target) }",
    "else { $acl = [IO.File]::GetAccessControl($target) }",
    "$rules = @(foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {",
    // Only OS-generated SIDs, integers and booleans enter this fixed JSON wire
    // format. Avoid module autoload entirely: a pwsh host may export module
    // paths whose assemblies cannot load in inbox Windows PowerShell 5.1.
    "  '{\"sid\":\"' + $rule.IdentityReference.Value + '\",\"mask\":' + [int]$rule.FileSystemRights +",
    "  ',\"inherited\":' + $rule.IsInherited.ToString().ToLowerInvariant() +",
    "  ',\"propagation\":' + [int]$rule.PropagationFlags +",
    "  ',\"inheritance\":' + [int]$rule.InheritanceFlags + ',\"type\":' + [int]$rule.AccessControlType + '}'",
    "})",
    "$json = '[' + ($rules -join ',') + ']'"
  ];
}

export function windowsSidAclCommand(path) {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    ...aclScript(`$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`),
    "[Console]::Out.WriteLine($json)"
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")];
}

function windowsSidAclWorkerCommand() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$PSModuleAutoLoadingPreference = 'None'",
    "while (($line = [Console]::In.ReadLine()) -ne $null) {",
    "  try {",
    ...aclScript("    $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))")
      .map(line => `  ${line}`),
    "    $reply = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))",
    "    [Console]::Out.WriteLine('OK ' + $reply)",
    "  } catch {",
    "    $errorReply = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))",
    "    [Console]::Out.WriteLine('ERR ' + $errorReply)",
    "  }",
    "}"
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")];
}

export function createWindowsSidAclReader({ env = process.env, spawnProcess = spawn,
  timeoutMs = 1_500, idleMs = 500 } = {}) {
  let child = null;
  let active = null;
  let buffer = "";
  let diagnostics = "";
  let idleTimer = null;
  const pending = [];

  function rejectAll(error) {
    if (active) { clearTimeout(active.timer); active.reject(error); active = null; }
    while (pending.length) pending.shift().reject(error);
  }
  function stop(error = null) {
    const current = child;
    child = null;
    buffer = "";
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (error) rejectAll(error);
    if (current && !current.killed) current.kill();
  }
  function scheduleIdle() {
    if (pending.length || active || !child) return;
    idleTimer = setTimeout(() => stop(), idleMs);
    idleTimer.unref?.();
  }
  function fail(message) {
    stop(new Error(`session timeline Windows SID ACL reader failed: ${message}${diagnostics ? `: ${diagnostics}` : ""}`));
  }
  function consume(line) {
    if (!active) return fail("unexpected response");
    const request = active;
    active = null;
    clearTimeout(request.timer);
    try {
      const match = line.replace(/^\uFEFF/, "").match(/^(OK|ERR) ([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error("malformed response");
      const value = Buffer.from(match[2], "base64").toString("utf8");
      if (match[1] === "ERR") throw new Error(value.slice(0, 240));
      request.resolve(value);
    } catch (error) {
      request.reject(new Error(`session timeline Windows SID ACL is unavailable: ${error.message}`));
    }
    pump();
  }
  function start() {
    const binary = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const current = spawnProcess(binary, windowsSidAclWorkerCommand(), {
      encoding: "utf8", env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    child = current;
    diagnostics = "";
    current.stdout.setEncoding("utf8");
    current.stderr.setEncoding("utf8");
    current.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return fail("response exceeded limit");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        consume(line);
      }
    });
    current.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-240); });
    current.once("error", error => { if (child === current) fail(error.message); });
    current.once("close", (code, signal) => {
      if (child === current) fail(`process closed (${code ?? signal ?? "unknown"})`);
    });
  }
  function pump() {
    if (active || !pending.length) return scheduleIdle();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!child) start();
    active = pending.shift();
    active.timer = setTimeout(() => fail("deadline exceeded"), timeoutMs);
    child.stdin.write(`${Buffer.from(active.path, "utf8").toString("base64")}\n`, error => {
      if (error) fail(error.message);
    });
  }
  return {
    read(path) {
      if (pending.length >= 64) return Promise.reject(new Error("session timeline Windows SID ACL queue is full"));
      return new Promise((resolve, reject) => { pending.push({ path, resolve, reject, timer: null }); pump(); });
    },
    close() { stop(new Error("session timeline Windows SID ACL reader closed")); }
  };
}

let sharedReader = null;
let sharedSystemRoot = null;

export async function readWindowsSidAcl(path, env, runCommand, run) {
  const binary = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (run !== spawnSync) return parseWindowsSidAcl(runCommand(run, binary, windowsSidAclCommand(path), env));
  if (!sharedReader || sharedSystemRoot !== env.SystemRoot) {
    sharedReader?.close();
    sharedReader = createWindowsSidAclReader({ env });
    sharedSystemRoot = env.SystemRoot;
  }
  return parseWindowsSidAcl(await sharedReader.read(path));
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
