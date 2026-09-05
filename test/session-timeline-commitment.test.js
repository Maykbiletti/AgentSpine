import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrollPrivateSessionTimeline, resolvePrivateSessionTimelineEnrollment
} from "../src/lib/session-timeline-enrollment.js";
import {
  TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV
} from "../src/lib/session-timeline-transport.js";
import {
  normalizePrivateTimelineSource, PRIVATE_TIMELINE_PREFIX_BYTES, privateTimelinePrefixDigest
} from "../src/lib/session-timeline-enrollment-source.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function clockAt(value) { return () => new Date(value); }

function scope() {
  return { entityId: "agent:snapshot", userId: "person:snapshot", tenantId: "tenant:snapshot",
    projectId: "project:snapshot", currentTaskId: "task:snapshot", groupId: null };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-snapshot-"));
  const state = join(workspace, "state");
  const project = join(workspace, "project");
  const profile = join(workspace, "profile");
  const transcript = join(profile, "projects", "snapshot", "session.jsonl");
  await Promise.all([mkdir(state), mkdir(project), mkdir(join(profile, "projects", "snapshot"), { recursive: true })]);
  const measurement = JSON.stringify({ timestamp: "2026-09-04T12:40:00.000Z", message: {
    role: "tool", content: "Measured synthetic Suite 0; result: PASS 15/15." } });
  await writeFile(transcript, `${measurement}\n${"x".repeat(4 * 1024 * 1024 + 12 * 1024)}\n`);
  const previous = {
    state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID
  };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(async () => {
    if (previous.state === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous.state;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    if (previous.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = previous.capability;
    if (previous.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = previous.transportSession;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  const environment = {
    [TIMELINE_TRANSPORT_CAPABILITY_ENV]: `astc_${randomBytes(32).toString("base64url")}`,
    [TIMELINE_TRANSPORT_SESSION_ENV]: "session:snapshot"
  };
  Object.assign(process.env, environment);
  return { project, profile, transcript, environment };
}

function request(item) {
  return { root: item.project, host: "claude", sessionId: "session:snapshot", scope: scope(),
    transcriptPath: item.transcript, hostHome: item.profile };
}

test("an immutable host receipt snapshot resolves unchanged and requires a renewed receipt after growth", async (t) => {
  const item = await fixture(t);
  const current = new Date("2026-09-04T12:45:00.000Z");
  const initialBytes = await readFile(item.transcript);
  const raw = await enrollPrivateSessionTimeline({ ...request(item), environment: item.environment,
    confirmation: "local-owner-confirmed", clock: clockAt(current) });
  assert.equal(raw.status, "unavailable");
  assert.equal(raw.reason, "host-transcript-receipt-required");

  const enrolled = await enrollTimelineWithHostReceipt({ ...request(item), environment: item.environment,
    clock: clockAt(current), bootstrap: false });
  assert.equal(enrolled.status, "enrolled");
  assert.equal(enrolled.source.commitmentDigest, null);
  assert.equal(enrolled.source.committedBytes, 0);
  const fixedPrefix = await normalizePrivateTimelineSource(enrolled.source);
  assert.equal(fixedPrefix?.prefixBytes, PRIVATE_TIMELINE_PREFIX_BYTES,
    "a multi-megabyte enrollment snapshot reads only the fixed 4 KiB prefix");
  assert.equal(fixedPrefix?.commitment, null);
  assert.equal(await privateTimelinePrefixDigest(enrolled.source, PRIVATE_TIMELINE_PREFIX_BYTES + 1), null,
    "the enrollment snapshot API refuses reads beyond its 4 KiB cap");
  assert.equal(hash(await readFile(item.transcript)), hash(initialBytes), "enrollment never changes source bytes");
  const unchanged = await resolvePrivateSessionTimelineEnrollment({ ...request(item), clock: clockAt(current) });
  assert.equal(unchanged.status, "enrolled");

  const mutation = await open(item.transcript, "r+");
  try { await mutation.write("Z", 4 * 1024 * 1024 + 6 * 1024, "utf8"); }
  finally { await mutation.close(); }
  const altered = await readFile(item.transcript);
  const stale = await resolvePrivateSessionTimelineEnrollment({ ...request(item), clock: clockAt(current) });
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.reason, "transcript-snapshot-renewal-required");
  assert.equal(stale.source, null);

  const renewed = await enrollTimelineWithHostReceipt({ ...request(item), environment: item.environment,
    clock: clockAt(current), eventId: "test:snapshot:renewal", bootstrap: false });
  assert.equal(renewed.status, "enrolled");
  assert.equal(hash(await readFile(item.transcript)), hash(altered), "renewal never rewrites the host source");
});
