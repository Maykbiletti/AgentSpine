import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsTimelineAclVerifier, createWindowsTimelineFileAclVerifier }
  from "../src/lib/session-timeline-windows-acl.js";
import { parseWindowsSidAcl, windowsSidAclCommand } from "../src/lib/session-timeline-sid-acl.js";

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
  assert.deepEqual(await readFile(path), original);
});
