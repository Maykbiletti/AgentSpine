import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrollPrivateSessionTimeline, LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION,
  resolvePrivateSessionTimelineEnrollment, DEFAULT_TIMELINE_ENROLLMENT_TTL_MS,
  MAX_TIMELINE_ENROLLMENT_TTL_MS
} from "../src/lib/session-timeline-enrollment.js";
import { sessionTimelinePrivatePaths } from "../src/lib/session-timeline-auth.js";
import { requestTimelineHostReceipt } from "./session-timeline-invocation-support.js";
import {
  TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV, timelineTransportDigest
} from "../src/lib/session-timeline-transport.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function clockAt(value) { return () => new Date(value); }
function scope(overrides = {}) {
  return { entityId: "agent:enrollment", userId: "person:enrollment", tenantId: "tenant:enrollment",
    projectId: "project:enrollment", currentTaskId: "task:enrollment", goalId: "goal:enrollment",
    goalStepId: "step:enrollment", groupId: null, ...overrides };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-enrollment-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const transcript = join(profile, "projects", "enrollment", "session.jsonl");
  const other = join(profile, "projects", "enrollment", "other.jsonl");
  await Promise.all([
    mkdir(state), mkdir(project), mkdir(join(profile, "projects", "enrollment"), { recursive: true })
  ]);
  await writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:11.000Z", message: { role: "tool",
    content: "Measured synthetic enrollment Suite 0; result: PASS 15/15." } })}\n`);
  await writeFile(other, "{}\n");
  const prior = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    session: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  const capability = `astc_${randomBytes(32).toString("base64url")}`;
  const transportEnvironment = {
    [TIMELINE_TRANSPORT_CAPABILITY_ENV]: capability,
    [TIMELINE_TRANSPORT_SESSION_ENV]: "session:enrollment"
  };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  Object.assign(process.env, transportEnvironment);
  t.after(async () => {
    if (prior.state === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = prior.state;
    if (prior.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior.claude;
    if (prior.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = prior.capability;
    if (prior.session === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = prior.session;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { state, profile, project, transcript, other, capability, transportEnvironment };
}

function request(fixture, overrides = {}) {
  return { root: fixture.project, host: "claude", sessionId: "session:enrollment", scope: scope(),
    transcriptPath: fixture.transcript, hostHome: fixture.profile, ...overrides };
}

function resolutionRequest(fixture, overrides = {}) {
  return { root: fixture.project, host: "claude", sessionId: "session:enrollment",
    transcriptPath: fixture.transcript, hostHome: fixture.profile, ...overrides };
}

async function issueReceipt(item, {
  host = "claude", sessionId = "session:enrollment", boundScope = scope(), transcriptPath = item.transcript,
  hostHome = item.profile, clock = null, eventId = null, environment = item.transportEnvironment
} = {}) {
  return requestTimelineHostReceipt({ root: item.project, host, sessionId, scope: boundScope, transcriptPath, hostHome,
    eventId, clock, environment });
}

async function enrollWithReceipt(item, {
  boundScope = scope(), transcriptPath = item.transcript, clock = null, eventId = null,
  confirmation = LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, environment = item.transportEnvironment, ttlMs
} = {}) {
  const receipt = await issueReceipt(item, { boundScope, transcriptPath, clock, eventId, environment });
  if (receipt.status !== "pending") return receipt;
  return enrollPrivateSessionTimeline({ root: item.project, hostReceipt: receipt.receipt, confirmation,
    environment, clock, ...(ttlMs === undefined ? {} : { ttlMs }) });
}

test("private timeline enrollment needs an explicit local owner confirmation and returns no proof", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  const before = hash(await readFile(item.transcript));
  const denied = await enrollPrivateSessionTimeline({ ...request(item), clock: clockAt(current) });
  assert.equal(denied.status, "unavailable");
  assert.equal(denied.reason, "host-transcript-receipt-required");
  const receipt = await issueReceipt(item, { clock: clockAt(current), eventId: "event:confirmation" });
  assert.equal(receipt.status, "pending");
  const noConfirmation = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: receipt.receipt,
    clock: clockAt(current), environment: item.transportEnvironment });
  assert.equal(noConfirmation.status, "unavailable");
  assert.equal(noConfirmation.reason, "local-owner-confirmation-required");
  const noTransport = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: receipt.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, clock: clockAt(current), environment: {} });
  assert.equal(noTransport.status, "unavailable");
  assert.equal(noTransport.reason, "local-transport-capability-required");
  const enrolled = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: receipt.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, clock: clockAt(current), environment: item.transportEnvironment });
  assert.equal(enrolled.status, "enrolled");
  assert.equal(enrolled.timelineVisibility, "private-verified");
  assert.equal("accessProof" in enrolled, false);
  assert.equal("transportDigest" in enrolled, false);
  assert.equal(enrolled.binding.groupId, null);
  assert.match(enrolled.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(enrolled.expiresAt, new Date(current.getTime() + DEFAULT_TIMELINE_ENROLLMENT_TTL_MS).toISOString());
  const names = await sessionTimelinePrivatePaths(item.project, "enrollment");
  assert.equal(names.path.startsWith(join(item.state, "integrity")), true);
  const persisted = JSON.parse(await readFile(names.path, "utf8"));
  assert.match(persisted.enrollments[0].transportDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(persisted).includes(item.capability), false);
  assert.equal(hash(await readFile(item.transcript)), before);
});

test("private enrollment resolves only the exact active Claude binding and current source", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  assert.equal((await enrollWithReceipt(item, { clock: clockAt(current), eventId: "event:resolve" })).status, "enrolled");
  const resolved = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(resolved.status, "enrolled");
  assert.equal(resolved.timelineVisibility, "private-verified");
  assert.equal("accessProof" in resolved, false);
  assert.equal("transportDigest" in resolved, false);
  assert.match(resolved.enrollmentDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(resolved.binding, {
    host: "claude", sessionId: "session:enrollment", entityId: "agent:enrollment",
    userId: "person:enrollment", tenantId: "tenant:enrollment", projectId: "project:enrollment",
    groupId: null, taskId: "task:enrollment", goalId: "goal:enrollment", goalStepId: "step:enrollment"
  });
  const foreignTransport = timelineTransportDigest({ root: item.project, binding: resolved.binding, environment: {
    ...item.transportEnvironment, [TIMELINE_TRANSPORT_CAPABILITY_ENV]: `astc_${randomBytes(32).toString("base64url")}`
  } });
  const transportMismatch = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item),
    expectedTransportDigest: foreignTransport, clock: clockAt(current) });
  assert.equal(transportMismatch.status, "unavailable");
  assert.equal(transportMismatch.reason, "private-enrollment-transport-mismatch");

  for (const changed of [
    { host: "codex" }, { sessionId: "session:foreign" }, { root: item.state }, { transcriptPath: item.other }
  ]) {
    const unavailable = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), ...changed, clock: clockAt(current) });
    assert.equal(unavailable.status, "unavailable", JSON.stringify(changed));
    assert.equal(unavailable.binding, null);
    assert.equal(unavailable.source, null);
  }

  const rawScopeIgnored = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item),
    scope: scope({ userId: "person:foreign", groupId: "group:foreign" }), clock: clockAt(current) });
  assert.equal(rawScopeIgnored.status, "enrolled");
  assert.equal(rawScopeIgnored.binding.userId, "person:enrollment");
  const postCompact = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item),
    transcriptPath: undefined, clock: clockAt(current) });
  assert.equal(postCompact.status, "enrolled");
  assert.equal(postCompact.sourceDigest, resolved.sourceDigest);
  const foreignProfile = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item),
    transcriptPath: undefined, hostHome: item.project, clock: clockAt(current) });
  assert.equal(foreignProfile.status, "unavailable");
  assert.equal(foreignProfile.source, null);
  await appendFile(item.transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:41:00.000Z" })}\n`);
  const pendingAppend = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(pendingAppend.status, "unavailable");
  assert.equal(pendingAppend.reason, "transcript-snapshot-renewal-required");
  const changedBinding = await enrollWithReceipt(item, {
    boundScope: scope({ userId: "person:append-bypass", goalStepId: "step:append-bypass" }),
    clock: clockAt(current), eventId: "event:changed" });
  assert.equal(changedBinding.status, "enrolled");
  await unlink(item.transcript);
  await writeFile(item.transcript, "replacement\n");
  const replaced = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(replaced.status, "unavailable");
  assert.equal(replaced.source, null);
  await unlink(item.transcript);
  try { await symlink(item.other, item.transcript); }
  catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    t.skip("the platform cannot create the required synthetic transcript symlink");
    return;
  }
  const redirected = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(redirected.status, "unavailable");
  assert.equal(redirected.source, null);
});

test("a locally confirmed conflicting binding replaces the same host session and transcript enrollment", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  assert.equal((await enrollWithReceipt(item, { clock: clockAt(current), eventId: "event:first" })).status, "enrolled");
  const replacement = await enrollWithReceipt(item, {
    boundScope: scope({ userId: "person:replacement", goalStepId: "step:replacement" }),
    clock: clockAt(current), eventId: "event:replacement" });
  assert.equal(replacement.status, "enrolled");
  const resolved = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(resolved.status, "enrolled");
  assert.equal(resolved.binding.userId, "person:replacement");
  assert.equal(resolved.binding.goalStepId, "step:replacement");
});

test("a separate signed enrollment head rejects state-only rollback and missing enrollment files", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  const first = await enrollWithReceipt(item, { clock: clockAt(current), eventId: "event:first" });
  assert.equal(first.status, "enrolled");
  const state = await sessionTimelinePrivatePaths(item.project, "enrollment");
  const head = await sessionTimelinePrivatePaths(item.project, "enrollment-head");
  const initialState = await readFile(state.path, "utf8");
  const initialHead = await readFile(head.path, "utf8");
  assert.match(JSON.parse(initialHead).signature, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(initialHead).stateSignature, JSON.parse(initialState).signature);

  const replacement = await enrollWithReceipt(item, { boundScope: scope({ userId: "person:replacement" }),
    clock: clockAt(current), eventId: "event:replacement" });
  assert.equal(replacement.status, "enrolled");
  const currentState = await readFile(state.path, "utf8");
  const currentHead = await readFile(head.path, "utf8");
  assert.notEqual(currentState, initialState);
  assert.notEqual(currentHead, initialHead);

  await writeFile(state.path, initialState);
  const replayed = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(replayed.status, "unavailable");
  assert.equal(replayed.binding, null);
  assert.equal(replayed.source, null);

  await writeFile(state.path, currentState, { mode: 0o600 });
  const restored = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(restored.status, "enrolled");
  await unlink(state.path);
  const missingState = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(missingState.status, "unavailable");
  assert.equal(missingState.source, null);

  await writeFile(state.path, currentState, { mode: 0o600 });
  await unlink(head.path);
  const missingHead = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(missingHead.status, "unavailable");
  assert.equal(missingHead.source, null);
  await writeFile(head.path, currentHead, { mode: 0o600 });
  assert.equal((await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) })).status, "enrolled");
});

test("missing, invalid, group, expired, and tampered private enrollments return no contents", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  for (const changed of [
    { host: "unknown" }, { sessionId: null }, { boundScope: scope({ currentTaskId: null }) },
    { boundScope: scope({ groupId: "group:synthetic" }) }, { transcriptPath: join(item.profile, "projects", "missing.jsonl") }
  ]) {
    const unavailable = await issueReceipt(item, { ...changed, clock: clockAt(current) });
    assert.equal(unavailable.status, "unavailable", JSON.stringify(changed));
    assert.equal(unavailable.receipt, null);
  }
  const enrolled = await enrollWithReceipt(item, { ttlMs: 60 * 1000, clock: clockAt(current), eventId: "event:ttl" });
  assert.equal(enrolled.status, "enrolled");
  assert.equal(enrolled.expiresAt, new Date(current.getTime() + 60 * 1000).toISOString());
  const next = await issueReceipt(item, { clock: clockAt(current), eventId: "event:invalid-ttl" });
  const invalidTtl = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: next.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, ttlMs: MAX_TIMELINE_ENROLLMENT_TTL_MS + 1,
    clock: clockAt(current), environment: item.transportEnvironment });
  assert.equal(invalidTtl.status, "unavailable");
  assert.equal(invalidTtl.reason, "invalid-enrollment-expiry");
  const expired = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item),
    timestamp: "2000-01-01T00:00:00.000Z", now: new Date("2000-01-01T00:00:00.000Z"),
    clock: clockAt(new Date(current.getTime() + 60 * 1000)) });
  assert.equal(expired.status, "unavailable");
  assert.equal(expired.reason, "private-enrollment-expired");
  const names = await sessionTimelinePrivatePaths(item.project, "enrollment");
  await writeFile(names.path, "{\"signature\":\"forged\"}\n");
  const tampered = await resolvePrivateSessionTimelineEnrollment({ ...resolutionRequest(item), clock: clockAt(current) });
  assert.equal(tampered.status, "unavailable");
  assert.equal(tampered.binding, null);
  assert.equal(tampered.source, null);
});
