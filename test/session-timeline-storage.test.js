import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  indexSessionTimeline, searchSessionTimeline, sessionTimelineStatus
} from "../src/lib/session-timeline.js";
import { sessionTimelineStatePaths } from "../src/lib/session-timeline-auth.js";
import { projectId } from "../src/lib/paths.js";
import { boundTimelineInvocation, enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function scope() {
  return { entityId: "agent:storage", userId: "person:storage", tenantId: "tenant:storage",
    projectId: "project:storage", currentTaskId: "task:storage", groupId: null, timelineVisibility: "private-verified" };
}

test("timeline state stays in the anchored integrity directory when legacy project state is redirected", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-storage-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const root = join(workspace, "project");
  const session = join(profile, "projects", "storage", "session.jsonl");
  const redirected = join(workspace, "redirected");
  const sentinel = join(redirected, "sentinel.json");
  await Promise.all([
    mkdir(state), mkdir(join(root, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "storage"), { recursive: true }), mkdir(redirected)
  ]);
  const transcript = `${JSON.stringify({ timestamp: "2026-09-04T12:40:11.000Z", message: { role: "tool",
    content: "Measured storage Suite 0; result: PASS 15/15." } })}\n`;
  await Promise.all([writeFile(session, transcript), writeFile(sentinel, "synthetic sentinel\n")]);
  await mkdir(join(state, "projects"));
  try {
    await symlink(redirected, join(state, "projects", projectId(root)), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code)) throw error;
    t.skip("the platform cannot create the required synthetic directory redirect");
    return;
  }
  const before = { sentinel: digest(await readFile(sentinel)), transcript: digest(await readFile(session)) };
  const prior = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:storage";
  t.after(async () => {
    if (prior.state === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = prior.state;
    if (prior.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior.claude;
    if (prior.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = prior.capability;
    if (prior.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = prior.transportSession;
    await rm(workspace, { recursive: true, force: true });
  });
  const bound = scope();
  assert.equal((await enrollTimelineWithHostReceipt({ root, sessionId: "session:storage", scope: bound,
    transcriptPath: session, hostHome: profile })).status, "enrolled");
  const indexPermit = await boundTimelineInvocation({ root, sessionId: "session:storage", hostHome: profile,
    tool: "index", fields: { maxBytes: 65_536 }, toolUseId: "tool:storage:index" });
  assert.ok(indexPermit);
  const indexed = await indexSessionTimeline({ root, host: "claude", sessionId: "session:storage", scope: bound,
    maxBytes: 65_536, invocationRequest: indexPermit.invocationRequest,
    transportDigest: indexPermit.transportDigest, enrollmentDigest: indexPermit.enrollmentDigest, hostHome: profile });
  assert.equal(indexed.status, "indexed");
  const searchPermit = await boundTimelineInvocation({ root, sessionId: "session:storage", hostHome: profile,
    tool: "search", fields: { at: "2026-09-04T12:40:11.000Z", query: "Suite PASS", windowSeconds: 0 },
    toolUseId: "tool:storage:search" });
  assert.ok(searchPermit);
  const found = await searchSessionTimeline({ root, host: "claude", sessionId: "session:storage", scope: bound,
    at: "2026-09-04T12:40:11.000Z", query: "Suite PASS", windowSeconds: 0,
    invocationRequest: searchPermit.invocationRequest, transportDigest: searchPermit.transportDigest,
    enrollmentDigest: searchPermit.enrollmentDigest, hostHome: profile });
  assert.equal(found.status, "found");
  const names = await sessionTimelineStatePaths(root);
  assert.equal(names.path.startsWith(join(state, "integrity")), true);
  assert.equal(digest(await readFile(sentinel)), before.sentinel);
  const redirectedEntries = await readdir(redirected);
  assert.equal(redirectedEntries.includes("sentinel.json"), true);
  assert.equal(redirectedEntries.some((entry) => entry === "integrity" || entry.startsWith("session-timeline-")), false,
    "timeline state never follows the legacy redirected project-state location");
  assert.equal(digest(await readFile(session)), before.transcript);
});

test("post-compaction continues with the sealed enrollment profile, never ambient host configuration", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-profile-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile-a");
  const home = join(workspace, "home-b");
  const root = join(workspace, "project");
  const session = join(profile, "projects", "profile", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(root), mkdir(join(profile, "projects", "profile"), { recursive: true }),
    mkdir(join(home, ".claude", "projects"), { recursive: true })
  ]);
  await writeFile(session, `${JSON.stringify({ timestamp: "2026-09-04T12:40:11.000Z", message: { role: "tool",
    content: "Measured profile Suite 0; result: PASS 15/15." } })}\n`);
  const prior = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:profile";
  t.after(async () => {
    if (prior.state === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = prior.state;
    if (prior.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior.claude;
    if (prior.home === undefined) delete process.env.HOME; else process.env.HOME = prior.home;
    if (prior.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = prior.capability;
    if (prior.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = prior.transportSession;
    await rm(workspace, { recursive: true, force: true });
  });
  const bound = scope();
  assert.equal((await enrollTimelineWithHostReceipt({ root, sessionId: "session:profile", scope: bound,
    transcriptPath: session, hostHome: profile })).status, "enrolled");
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  const continued = await sessionTimelineStatus({ root, host: "claude", sessionId: "session:profile", scope: bound });
  assert.equal(continued.status, "partial");
  const searched = await searchSessionTimeline({ root, host: "claude", sessionId: "session:profile", scope: bound,
    at: "2026-09-04T12:40:11.000Z", query: "profile Suite", windowSeconds: 0 });
  assert.equal(searched.blocked, true);
});

test("a missing timeline sidecar with a signed head cannot be silently re-bootstrapped", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-missing-state-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const root = join(workspace, "project");
  const session = join(profile, "projects", "missing-state", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(join(root, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "missing-state"), { recursive: true })
  ]);
  await writeFile(session, `${JSON.stringify({ timestamp: "2026-09-04T12:40:11.000Z", message: {
    role: "tool", content: "Measured missing-state Suite 0; result: PASS 15/15." } })}\n`);
  const prior = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:missing-state";
  t.after(async () => {
    if (prior.state === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = prior.state;
    if (prior.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior.claude;
    if (prior.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = prior.capability;
    if (prior.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = prior.transportSession;
    await rm(workspace, { recursive: true, force: true });
  });
  const bound = scope();
  assert.equal((await enrollTimelineWithHostReceipt({ root, sessionId: "session:missing-state", scope: bound,
    transcriptPath: session, hostHome: profile })).status, "enrolled");
  const names = await sessionTimelineStatePaths(root);
  const before = digest(await readFile(session));
  await rm(names.path);
  const repeated = await enrollTimelineWithHostReceipt({ root, sessionId: "session:missing-state", scope: bound,
    transcriptPath: session, hostHome: profile, eventId: "test:missing-sidecar:renewal" });
  assert.equal(repeated.status, "unavailable");
  assert.equal(repeated.reason, "timeline-state-unavailable");
  assert.equal(digest(await readFile(session)), before);
});
