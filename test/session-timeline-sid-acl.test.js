import test from "node:test";
import assert from "node:assert/strict";
import {
  createWindowsTimelineAclVerifier, createWindowsTimelineFileAclVerifier,
  isTrustedWindowsWriter
}
  from "../src/lib/session-timeline-windows-acl.js";
import {
  parseWindowsAclSave, parseWindowsSddlAcl, parseWindowsSidAcl,
  windowsAclSaveCommand, windowsSidAclCommand
} from "../src/lib/session-timeline-sid-acl.js";

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

test("empty, localized-name, malformed and oversized legacy responses grant nothing", () => {
  for (const rows of [[], {}, [ace("NT-AUTORITÄT\\SYSTEM")], [ace(SELF, { type: 2 })],
    [ace(SELF, { mask: -1 })], [ace(SELF, { mask: "2032127" })],
    [ace(SELF, { inherited: "false" })], Array.from({ length: 2049 }, () => ace(SELF))]) {
    assert.throws(() => parseWindowsSidAcl(JSON.stringify(rows)));
  }
  assert.throws(() => parseWindowsSidAcl("unparseable"));
});

test("path metacharacters stay encoded in the dependency-injected compatibility command", () => {
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

test("SDDL parsing maps trusted aliases to SIDs and retains inheritance semantics", () => {
  assert.deepEqual(parseWindowsSddlAcl(
    `D:PAI(A;;FA;;;${SELF})(A;ID;0x001f01ff;;;SY)(A;OICIIO;FA;;;CO)(A;;FA;;;LA)(D;;FW;;;WD)`
  ), [
    { principal: SELF.toLowerCase(), rights: ["F", "W"] },
    { principal: "s-1-5-18", rights: ["I", "F", "W"] },
    { principal: "s-1-3-0", rights: ["IO", "F", "W"] },
    { principal: "sddl:la", rights: ["F", "W"] },
    { principal: "sddl:wd", rights: ["DENY"] }
  ]);
});

test("only the documented local-administrator SDDL role joins trusted administrative SIDs", () => {
  const identity = { sid: SELF.toLowerCase() };
  assert.equal(isTrustedWindowsWriter("sddl:la", identity), true);
  assert.equal(isTrustedWindowsWriter("sddl:lg", identity), false);
  assert.equal(isTrustedWindowsWriter(FOREIGN.toLowerCase(), identity), false);
});

test("every SDDL write form remains visible to the foreign-writer guard", () => {
  const symbolic = ["GA", "GW", "SD", "WD", "WO", "WP", "CC", "DC", "SW", "DT", "CR",
    "FA", "FW", "KA", "KW"];
  for (const right of symbolic) {
    assert.ok(parseWindowsSddlAcl(`D:(A;;${right};;;${FOREIGN})`)[0].rights.includes("W"), right);
  }
  for (const bit of [2, 4, 16, 64, 256, 65536, 262144, 524288, 0x10000000, 0x40000000]) {
    assert.ok(parseWindowsSddlAcl(
      `D:(A;;0x${bit.toString(16)};;;${FOREIGN})`
    )[0].rights.includes("W"), bit.toString(16));
  }
  for (const right of ["FR", "FX", "GR", "GX", "RC", "KR", "KX"]) {
    assert.equal(parseWindowsSddlAcl(`D:(A;;${right};;;${FOREIGN})`)[0].rights.includes("W"), false);
  }
});

test("unsupported or malformed SDDL fails closed", () => {
  for (const value of ["", "D:", "O:SYG:SYD:(A;;FA;;;SY)", "D:SA(A;;FA;;;SY)",
    "D:(OA;;FA;00000000-0000-0000-0000-000000000000;;SY)",
    "D:(A;;QQ;;;SY)", "D:(A;SA;FA;;;SY)", "D:(A;;FA;;;localized name)",
    "D:(A;;FA;;;SY)trailing", "D:(XA;;FA;;;SY;(condition))"]) {
    assert.throws(() => parseWindowsSddlAcl(value), value);
  }
});

test("icacls save parsing is UTF-16LE, single-target and bounded", () => {
  const bytes = Buffer.from(`\uFEFFsynthetic\\state\r\nD:AI(A;;FA;;;${SELF})(A;ID;FR;;;SY)\r\n`, "utf16le");
  assert.deepEqual(parseWindowsAclSave(bytes), [
    { principal: SELF.toLowerCase(), rights: ["F", "W"] },
    { principal: "s-1-5-18", rights: ["I"] }
  ]);
  assert.throws(() => parseWindowsAclSave(Buffer.from("odd")));
  assert.throws(() => parseWindowsAclSave(Buffer.from("name\r\nD:(A;;FA;;;SY)\r\nextra\r\nD:(A;;FA;;;SY)", "utf16le")));
  assert.throws(() => parseWindowsAclSave(Buffer.alloc(1024 * 1024 + 2)));
});

test("native ACL export uses one literal target and a caller-owned save path", () => {
  const target = "C:\\Synthetic\\ä '[literal]\\state";
  const output = "C:\\Temp\\opaque.acl";
  assert.deepEqual(windowsAclSaveCommand(target, output), [target, "/save", output, "/q"]);
});
