import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createWindowsTimelineAclVerifier, createWindowsTimelineFileAclVerifier }
  from "../src/lib/session-timeline-windows-acl.js";
import { createWindowsSidAclReader, parseWindowsSidAcl, windowsSidAclCommand }
  from "../src/lib/session-timeline-sid-acl.js";

const SELF = "S-1-5-21-111-222-333-1001";
const FOREIGN = "S-1-5-21-111-222-333-1002";
function ace(sid, extra = {}) {
  return { sid, mask: 0x1f01ff, inherited: false, propagation: 0,
    inheritance: 0, type: 0, ...extra };
}
function verifiers(rows) {
  const calls = [];
  const options = { platform: "win32", env: { SystemRoot: "/Windows" },
    run(binary, args, config) {
      calls.push({ binary, args, config });
      if (binary.endsWith("whoami.exe")) {
        return { status: 0, stdout: `"SYNTHETIC\\Agent","${SELF}"` };
      }
      assert.ok(binary.endsWith("powershell.exe"));
      return { status: 0, stdout: JSON.stringify(rows) };
    } };
  return { calls, directory: createWindowsTimelineAclVerifier(options),
    file: createWindowsTimelineFileAclVerifier(options) };
}

test("localized display names cannot affect SYSTEM and administrator SID access", async () => {
  for (const displayName of ["NT AUTHORITY\\SYSTEM", "NT-AUTORITÄT\\SYSTEM",
    "AUTORITE NT\\SYSTEM", "untrusted display text"]) {
    const v = verifiers([ace(SELF), ace("S-1-5-18", { displayName }), ace("S-1-5-32-544")]);
    await v.directory("/synthetic/state", { role: "integrity" });
    await v.directory("/synthetic", { role: "parent" });
    await v.file("/synthetic/state/key", { role: "key" });
    assert.ok(v.calls.every(c => c.config.shell === false && c.config.timeout === 1500));
    assert.ok(v.calls.every(c => !c.args.includes("/grant:r")));
  }
});

test("SYSTEM display names cannot authorize a foreign SID or any foreign write bit", async () => {
  for (const mask of [2, 4, 16, 64, 256, 65536, 262144, 524288]) {
    const v = verifiers([ace(SELF), ace(FOREIGN, { mask, displayName: "NT-AUTORITÄT\\SYSTEM" })]);
    await assert.rejects(v.directory("/synthetic", { role: "parent" }), /grants write access/);
    await assert.rejects(v.file("/synthetic/state", { role: "state" }), /not private/);
  }
});

test("deny and inherit-only ACEs cannot stand in for an effective owner grant", async () => {
  for (const patch of [{ type: 1 }, { propagation: 2 }]) {
    const v = verifiers([ace(SELF, patch)]);
    await assert.rejects(v.directory("/synthetic", { role: "integrity" }), /not private/);
    await assert.rejects(v.file("/synthetic/state", { role: "state" }), /not private/);
  }
});

test("empty, localized-name, malformed and oversized ACL responses grant nothing", () => {
  for (const rows of [[], {}, [ace("NT-AUTORITÄT\\SYSTEM")], [ace(SELF, { type: 2 })],
    [ace(SELF, { mask: -1 })], [ace(SELF, { mask: "2032127" })],
    [ace(SELF, { inherited: "false" })], Array.from({ length: 2049 }, () => ace(SELF))]) {
    assert.throws(() => parseWindowsSidAcl(JSON.stringify(rows)));
  }
  assert.throws(() => parseWindowsSidAcl("unparseable"));
});

test("path metacharacters stay encoded data and both inherited and explicit SIDs are queried", () => {
  const path = "/synthetic/ä '$(); [literal]/state";
  const args = windowsSidAclCommand(path);
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  assert.match(script, /\[IO.Directory\]::GetAccessControl\(\$target\)/);
  assert.match(script, /\[IO.File\]::GetAccessControl\(\$target\)/);
  assert.match(script, /GetAccessRules\(\$true, \$true, \[Security.Principal.SecurityIdentifier\]\)/);
  assert.ok(!script.includes(path));
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), path);
});

function worker({ respond = true, ready = true } = {}) {
  const state = { spawns: [], paths: [], children: [], kills: 0, respond, ready };
  state.spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.killed = false;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      state.paths.push(Buffer.from(String(chunk).trim(), "base64").toString("utf8"));
      if (state.respond) {
        queueMicrotask(() => child.stdout.write(`ACE ${SELF} 2032127 0 0 0 0\nEND\n`));
      }
      done();
    } });
    child.kill = () => {
      if (child.killed) return false;
      child.killed = true;
      state.kills += 1;
      queueMicrotask(() => child.emit("close", 0, null));
      return true;
    };
    state.spawns.push({ binary, args, options });
    state.children.push(child);
    queueMicrotask(() => {
      if (state.ready && !child.killed) child.stdout.write("READY\n");
    });
    return child;
  };
  return state;
}

test("bounded SID reader serializes a burst through one trusted PowerShell process", async () => {
  const fake = worker();
  const reader = createWindowsSidAclReader({ env: { SystemRoot: "/Windows" },
    spawnProcess: fake.spawn, idleMs: 10 });
  const results = await Promise.all([reader.read("/synthetic/first"), reader.read("/synthetic/second")]);
  assert.equal(fake.spawns.length, 1);
  assert.deepEqual(fake.paths, ["/synthetic/first", "/synthetic/second"]);
  assert.ok(results.every(result => parseWindowsSidAcl(result).length === 1));
  const [{ binary, args, options }] = fake.spawns;
  assert.equal(binary, join("/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  assert.match(script, /PSModuleAutoLoadingPreference = 'None'/);
  assert.match(script, /\[Console\]::Out.WriteLine\('READY'\)/);
  assert.match(script, /while \(\(\$line = \[Console\]::In.ReadLine\(\)\) -ne \$null\)/);
  assert.match(script, /\[Console\]::Out.WriteLine\('ACE '/);
  assert.ok(!script.includes("ConvertTo-Json"));
  assert.ok(!script.includes("/synthetic/first"));
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  reader.close();
  assert.equal(fake.kills, 1);
});

test("a stalled SID worker fails closed at its own unchanged query deadline", async () => {
  const fake = worker({ respond: false });
  const reader = createWindowsSidAclReader({ env: { SystemRoot: "/Windows" },
    spawnProcess: fake.spawn, timeoutMs: 10, idleMs: 10 });
  await assert.rejects(reader.read("/synthetic/stalled"), /deadline exceeded/);
  assert.equal(fake.kills, 1);
});

test("a stalled SID worker startup fails closed at its own unchanged deadline", async () => {
  const fake = worker({ ready: false });
  const reader = createWindowsSidAclReader({ env: { SystemRoot: "/Windows" },
    spawnProcess: fake.spawn, timeoutMs: 10, idleMs: 10 });
  await assert.rejects(reader.read("/synthetic/startup-stalled"), /startup deadline exceeded/);
  assert.equal(fake.paths.length, 0);
  assert.equal(fake.kills, 1);
});

test("a crashed SID worker rejects its request and a later request starts cleanly", async () => {
  const fake = worker({ respond: false });
  const reader = createWindowsSidAclReader({ env: { SystemRoot: "/Windows" },
    spawnProcess: fake.spawn, timeoutMs: 100, idleMs: 10 });
  const interrupted = reader.read("/synthetic/interrupted");
  await new Promise(resolve => setImmediate(resolve));
  fake.children[0].emit("close", 17, null);
  await assert.rejects(interrupted, /process closed \(17\)/);
  fake.respond = true;
  assert.equal(parseWindowsSidAcl(await reader.read("/synthetic/recovered")).length, 1);
  assert.equal(fake.spawns.length, 2);
  reader.close();
});

test("native Windows SID reads need no PowerShell modules and preserve source bytes", async t => {
  if (process.platform !== "win32") return t.skip("requires inbox Windows PowerShell");
  const root = await mkdtemp(join(tmpdir(), "agentspine-sid-module-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source '[literal].txt");
  const original = Buffer.from("Synthetic source\r\nunchanged ä\r\n");
  await writeFile(path, original);
  const binary = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  for (const target of [root, path]) {
    const args = windowsSidAclCommand(target);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    args[args.length - 1] = Buffer.from("$PSModuleAutoLoadingPreference = 'None'\n" + script, "utf16le").toString("base64");
    const result = spawnSync(binary, args, { encoding: "utf8", shell: false, windowsHide: true,
      timeout: 1500, env: { ...process.env, PSModulePath: join(root, "missing-modules") } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(parseWindowsSidAcl(result.stdout).length > 0);
  }
  const reader = createWindowsSidAclReader({ env: { ...process.env,
    PSModulePath: join(root, "missing-worker-modules") } });
  try {
    const results = await Promise.all([reader.read(root), reader.read(path)]);
    assert.ok(results.every(result => parseWindowsSidAcl(result).length > 0));
  } finally {
    reader.close();
  }
  assert.deepEqual(await readFile(path), original);
});
