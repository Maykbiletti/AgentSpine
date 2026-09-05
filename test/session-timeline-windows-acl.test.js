import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSessionTimelineTrust, readAuthenticatedTimelineState, sessionTimelinePrivatePaths
} from "../src/lib/session-timeline-auth.js";
import {
  indexSessionTimeline, searchSessionTimeline, sessionTimelineStatus
} from "../src/lib/session-timeline.js";
import {
  createWindowsTimelineAclVerifier, createWindowsTimelineFileAclVerifier, parseWindowsIcaclsEntries
} from "../src/lib/session-timeline-windows-acl.js";
import { boundTimelineInvocation, enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

const SID = "S-1-5-21-111-222-333-1001";
const ACCOUNT = "SYNTHETIC\\TimelineAgent";

function runner(query) {
  const calls = [];
  return {
    calls,
    run(binary, args, options) {
      calls.push({ binary, args, options });
      if (binary.endsWith("whoami.exe")) return { status: 0, stdout: `"${ACCOUNT}","${SID}"\r\n` };
      if (args.includes("/verify")) return { status: 0, stdout: "Successfully processed 1 files; Failed processing 0 files\r\n" };
      if (args.length === 1) return { status: 0, stdout: query(args[0]) };
      return { status: 0, stdout: "Successfully processed 1 files; Failed processing 0 files\r\n" };
    }
  };
}

function verifier(run) {
  return createWindowsTimelineAclVerifier({ platform: "win32", env: { SystemRoot: "/Windows" }, run });
}

function fileVerifier(run) {
  return createWindowsTimelineFileAclVerifier({ platform: "win32", env: { SystemRoot: "/Windows" }, run });
}

test("a newly created timeline integrity directory receives a SID-only ACL through trusted system binaries", async () => {
  const path = "/synthetic/timeline-integrity";
  const probe = runner((value) => `${value} ${ACCOUNT}:(OI)(CI)(F)\r\n`);
  await verifier(probe.run)(path, { created: true, role: "integrity" });
  assert.deepEqual(probe.calls.map((call) => call.args), [
    ["/user", "/fo", "csv", "/nh"],
    [path, "/inheritance:r", "/grant:r", `*${SID.toLowerCase()}:(OI)(CI)(F)`],
    [path, "/verify"], [path]
  ]);
  for (const call of probe.calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 1_500);
  }
  assert.equal(probe.calls[0].binary, join("/Windows", "System32", "whoami.exe"));
  assert.equal(probe.calls[1].binary, join("/Windows", "System32", "icacls.exe"));
});

test("trusted Windows system principals do not make a private timeline ACL unavailable", async () => {
  const path = "/synthetic/system-owned-integrity";
  const privateAcl = runner((value) => [
    `${value} ${ACCOUNT}:(F)`,
    "        NT AUTHORITY\\SYSTEM:(F)",
    "        BUILTIN\\Administrators:(F)",
    "        Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)"
  ].join("\r\n"));
  await verifier(privateAcl.run)(path, { role: "integrity" });
  await fileVerifier(privateAcl.run)(`${path}/state.json`, { role: "state" });
});

test("a foreign read-only ACE is not private timeline access", async () => {
  const path = "/synthetic/foreign-reader";
  const foreign = runner((value) => `${value} ${ACCOUNT}:(F)\r\n        BUILTIN\\Users:(RX)\r\n`);
  await assert.rejects(verifier(foreign.run)(path, { role: "integrity" }), /not private to the current SID/);
  await assert.rejects(fileVerifier(foreign.run)(`${path}/state.json`, { role: "state" }), /not private to the current SID/);
});

test("an existing integrity directory with a broad or foreign ACL fails closed and is never rewritten", async () => {
  const path = "/synthetic/broad-integrity";
  const probe = runner((value) => `${value} Everyone:(F)\r\n`);
  await assert.rejects(verifier(probe.run)(path, { role: "integrity" }), /not private to the current SID/);
  assert.equal(probe.calls.some((call) => call.args.includes("/grant:r")), false);
  assert.deepEqual(probe.calls.map((call) => call.args), [["/user", "/fo", "csv", "/nh"], [path, "/verify"], [path]]);
});

test("a newly created signing key receives a SID-only file ACL through trusted system binaries", async () => {
  const path = "/synthetic/timeline-signing.key";
  const probe = runner((value) => `${value} ${ACCOUNT}:(F)\r\n`);
  await fileVerifier(probe.run)(path, { created: true, role: "key" });
  assert.deepEqual(probe.calls.map((call) => call.args), [
    ["/user", "/fo", "csv", "/nh"],
    [path, "/inheritance:r", "/grant:r", `*${SID.toLowerCase()}:(F)`],
    [path, "/verify"], [path]
  ]);
});

test("a foreign write ACE on a state, head, or inherited private file fails closed without repair", async () => {
  for (const role of ["state", "head"]) {
    const broad = runner((value) => `${value} ${ACCOUNT}:(I)(F)\r\n        Everyone:(M)\r\n`);
    await assert.rejects(fileVerifier(broad.run)(`/synthetic/timeline-${role}.json`, { role }), new RegExp(`${role} ACL is not private`));
    assert.equal(broad.calls.some((call) => call.args.includes("/grant:r")), false);
  }

  const privatePath = "/synthetic/timeline-private.json";
  const inherited = runner((value) => `${value} ${ACCOUNT}:(I)(F)\r\n`);
  await fileVerifier(inherited.run)(privatePath, { role: "private" });
});

test("a parent with a foreign write ACE fails closed while a read-only observer cannot replace the integrity directory", async () => {
  const badPath = "/synthetic/foreign-parent";
  const bad = runner((value) => `${value} ${ACCOUNT}:(F)\r\n        Everyone:(M)\r\n`);
  await assert.rejects(verifier(bad.run)(badPath, { role: "parent" }), /grants write access to everyone/);

  const safePath = "/synthetic/read-only-parent";
  const safe = runner((value) => `${value} ${ACCOUNT}:(F)\r\n        Everyone:(RX)\r\n        CREATOR OWNER:(OI)(CI)(IO)(F)\r\n`);
  await verifier(safe.run)(safePath, { role: "parent" });
});

test("icacls parsing preserves a drive-letter path and extracts only ACL entries", () => {
  const path = "C:\\Synthetic\\Timeline";
  assert.deepEqual(parseWindowsIcaclsEntries(`${path} ${ACCOUNT}:(OI)(CI)(F)\r\n        Everyone:(RX)\r\nSuccessfully processed 1 files\r\n`, path), [
    { principal: "synthetic\\timelineagent", rights: ["OI", "CI", "F"] },
    { principal: "everyone", rights: ["RX"] }
  ]);
});

test("Windows rejects a later Everyone read/write ACL on the private integrity directory", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only ACL red probe");
    return;
  }
  const root = process.env.SystemRoot;
  assert.ok(root);
  const whoami = join(root, "System32", "whoami.exe");
  const icacls = join(root, "System32", "icacls.exe");
  const sidResult = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", shell: false });
  const sid = sidResult.stdout.match(/S-\d+(?:-\d+)+/)?.[0];
  assert.equal(sidResult.status, 0, sidResult.stderr);
  assert.ok(sid);
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-acl-"));
  const state = join(workspace, "state");
  const prior = process.env.AGENTSPINE_STATE_DIR;
  await mkdir(state);
  const privateParent = spawnSync(icacls, [state, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)(F)`], {
    encoding: "utf8", shell: false
  });
  assert.equal(privateParent.status, 0, privateParent.stderr || privateParent.stdout);
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (prior === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = prior;
    await rm(workspace, { recursive: true, force: true });
  });
  await ensureSessionTimelineTrust({ create: true });
  const stateFile = await sessionTimelinePrivatePaths("C:\\synthetic\\timeline-acl", "state");
  await writeFile(stateFile.path, "{}\n", { mode: 0o600 });
  await readAuthenticatedTimelineState(stateFile.path, 1024, stateFile.assertStable);
  const broadenedState = spawnSync(icacls, [stateFile.path, "/grant", "*S-1-1-0:(M)"], { encoding: "utf8", shell: false });
  assert.equal(broadenedState.status, 0, broadenedState.stderr || broadenedState.stdout);
  await assert.rejects(readAuthenticatedTimelineState(stateFile.path, 1024, stateFile.assertStable), /private ACL is not private/);

  const key = join(state, "integrity", "session-timeline-signing.key");
  const broadenedKey = spawnSync(icacls, [key, "/grant", "*S-1-1-0:(M)"], { encoding: "utf8", shell: false });
  assert.equal(broadenedKey.status, 0, broadenedKey.stderr || broadenedKey.stdout);
  await assert.rejects(ensureSessionTimelineTrust(), /key ACL is not private/);

  const broadened = spawnSync(icacls, [join(state, "integrity"), "/grant", "*S-1-1-0:(M)"], { encoding: "utf8", shell: false });
  assert.equal(broadened.status, 0, broadened.stderr || broadened.stdout);
  await assert.rejects(ensureSessionTimelineTrust(), /integrity ACL is not private to the current SID/);
});

test("Windows state ACL tampering yields no timeline status or evidence cards", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only state ACL red probe");
    return;
  }
  const systemRoot = process.env.SystemRoot;
  const whoami = join(systemRoot, "System32", "whoami.exe");
  const icacls = join(systemRoot, "System32", "icacls.exe");
  const sidResult = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", shell: false });
  const sid = sidResult.stdout.match(/S-\d+(?:-\d+)+/)?.[0];
  assert.equal(sidResult.status, 0, sidResult.stderr);
  assert.ok(sid);
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-state-acl-"));
  const state = join(workspace, "state");
  const project = join(workspace, "project");
  const profile = join(workspace, "profile");
  const transcript = join(profile, "projects", "windows", "session.jsonl");
  const previous = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  await Promise.all([mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "windows"), { recursive: true })]);
  await writeFile(join(project, "AGENTS.md"), "# Windows timeline ACL test\n");
  await writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:00.000Z", message: {
    role: "tool", content: "Measured Windows Suite 0; result: PASS 1/1." } })}\n`);
  const privateParent = spawnSync(icacls, [state, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)(F)`], {
    encoding: "utf8", shell: false
  });
  assert.equal(privateParent.status, 0, privateParent.stderr || privateParent.stdout);
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:windows";
  t.after(async () => {
    if (previous.state === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous.state;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    if (previous.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = previous.capability;
    if (previous.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = previous.transportSession;
    await rm(workspace, { recursive: true, force: true });
  });
  const scope = { entityId: "agent:windows", userId: "person:windows", tenantId: "tenant:windows",
    projectId: "project:windows", currentTaskId: "task:windows", goalId: null, goalStepId: null,
    groupId: null, timelineVisibility: "private-verified" };
  assert.equal((await enrollTimelineWithHostReceipt({ root: project, sessionId: "session:windows", scope,
    transcriptPath: transcript, hostHome: profile })).status, "enrolled");
  const opened = await sessionTimelineStatus({ root: project, host: "claude", sessionId: "session:windows", scope, hostHome: profile });
  assert.equal(opened.status, "partial");
  assert.equal("accessProof" in opened, false);
  const indexPermit = await boundTimelineInvocation({ root: project, sessionId: "session:windows", hostHome: profile,
    tool: "index", fields: { maxBytes: 65_536 }, toolUseId: "tool:windows:index" });
  assert.ok(indexPermit);
  assert.equal((await indexSessionTimeline({ root: project, host: "claude", sessionId: "session:windows",
    scope, maxBytes: 65_536, hostHome: profile, invocationRequest: indexPermit.invocationRequest,
    transportDigest: indexPermit.transportDigest, enrollmentDigest: indexPermit.enrollmentDigest })).status, "indexed");
  const searchPermit = await boundTimelineInvocation({ root: project, sessionId: "session:windows", hostHome: profile,
    tool: "search", fields: { at: "2026-09-04T12:40:00.000Z", query: "Suite PASS", windowSeconds: 0 },
    toolUseId: "tool:windows:search" });
  assert.ok(searchPermit);
  const before = await searchSessionTimeline({ root: project, host: "claude", sessionId: "session:windows",
    scope, hostHome: profile, at: "2026-09-04T12:40:00.000Z", query: "Suite PASS", windowSeconds: 0,
    invocationRequest: searchPermit.invocationRequest, transportDigest: searchPermit.transportDigest,
    enrollmentDigest: searchPermit.enrollmentDigest });
  assert.equal(before.events.length, 1);
  const paths = await sessionTimelinePrivatePaths(project, "state");
  const broadened = spawnSync(icacls, [paths.path, "/grant", "*S-1-1-0:(M)"], { encoding: "utf8", shell: false });
  assert.equal(broadened.status, 0, broadened.stderr || broadened.stdout);
  const unavailable = await sessionTimelineStatus({ root: project, host: "claude", sessionId: "session:windows", scope, hostHome: profile });
  assert.equal(unavailable.status, "unavailable");
  const blocked = await searchSessionTimeline({ root: project, host: "claude", sessionId: "session:windows",
    scope, at: "2026-09-04T12:40:00.000Z", query: "Suite PASS", windowSeconds: 0 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.events, undefined);
});
