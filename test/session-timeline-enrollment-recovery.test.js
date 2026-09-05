import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentHostTranscriptReceipt, enrollPrivateSessionTimeline,
  LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, LOCAL_TIMELINE_ENROLLMENT_RECOVERY_CONFIRMATION,
  resetPrivateSessionTimelineEnrollment
} from "../src/lib/session-timeline-enrollment.js";
import { sessionTimelinePrivatePaths } from "../src/lib/session-timeline-auth.js";
import { requestTimelineHostReceipt } from "./session-timeline-invocation-support.js";
import {
  TIMELINE_TRANSPORT_CAPABILITY_ENV, TIMELINE_TRANSPORT_SESSION_ENV
} from "../src/lib/session-timeline-transport.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function clockAt(value) { return () => new Date(value); }
function scope() {
  return { entityId: "agent:recovery", userId: "person:recovery", tenantId: "tenant:recovery",
    projectId: "project:recovery", currentTaskId: "task:recovery", goalId: "goal:recovery",
    goalStepId: "step:recovery", groupId: null };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-recovery-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const transcript = join(profile, "projects", "recovery", "session.jsonl");
  await Promise.all([mkdir(state), mkdir(project), mkdir(join(profile, "projects", "recovery"), { recursive: true })]);
  await writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:00.000Z", message: {
    role: "tool", content: "Measured synthetic Suite 0; result PASS 15/15." } })}\n`);
  const before = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY, session: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(async () => {
    if (before.state === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = before.state;
    if (before.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before.claude;
    if (before.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = before.capability;
    if (before.session === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = before.session;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  const environment = {
    [TIMELINE_TRANSPORT_CAPABILITY_ENV]: `astc_${randomBytes(32).toString("base64url")}`,
    [TIMELINE_TRANSPORT_SESSION_ENV]: "session:recovery"
  };
  Object.assign(process.env, environment);
  return { project, profile, transcript, environment };
}

async function issue(item, current, eventId = undefined, prompt = undefined) {
  return requestTimelineHostReceipt({ root: item.project, host: "claude", sessionId: "session:recovery", scope: scope(),
    transcriptPath: item.transcript, hostHome: item.profile, eventId, clock: clockAt(current),
    environment: item.environment, ...(prompt === undefined ? {} : { prompt }) });
}

async function enroll(item, current, eventId = "event:initial") {
  const receipt = await issue(item, current, eventId);
  assert.equal(receipt.status, "pending");
  return enrollPrivateSessionTimeline({ root: item.project, hostReceipt: receipt.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, clock: clockAt(current), environment: item.environment });
}

test("enrollment head recovers only the authenticated one-step state replacement", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  const sourceHash = hash(await readFile(item.transcript));
  assert.equal((await enroll(item, current)).status, "enrolled");
  const state = await sessionTimelinePrivatePaths(item.project, "enrollment");
  const head = await sessionTimelinePrivatePaths(item.project, "enrollment-head");
  const priorHead = await readFile(head.path, "utf8");
  const next = await issue(item, current, "event:next");
  assert.equal(next.status, "pending");
  const successorState = await readFile(state.path, "utf8");
  const successorHead = await readFile(head.path, "utf8");
  const successor = JSON.parse(successorState);
  const previous = JSON.parse(priorHead);
  assert.equal(successor.generation, previous.generation + 1);
  assert.equal(successor.previousSignature, previous.stateSignature);
  await writeFile(head.path, priorHead, { mode: 0o600 });

  const recovered = await Promise.all([currentHostTranscriptReceipt({ root: item.project, clock: clockAt(current), environment: item.environment }),
    currentHostTranscriptReceipt({ root: item.project, clock: clockAt(current), environment: item.environment })]);
  assert.deepEqual(recovered.map((item) => item.status), ["pending", "pending"]);
  assert.equal(recovered[0].receipt, next.receipt);
  assert.equal(recovered[1].receipt, next.receipt);
  assert.equal(await readFile(state.path, "utf8"), successorState);
  assert.equal(await readFile(head.path, "utf8"), successorHead);
  assert.equal(hash(await readFile(item.transcript)), sourceHash);
});

test("rollback, malformed heads, and an unanchored first write return no receipt", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  const sourceHash = hash(await readFile(item.transcript));
  assert.equal((await enroll(item, current)).status, "enrolled");
  const state = await sessionTimelinePrivatePaths(item.project, "enrollment");
  const head = await sessionTimelinePrivatePaths(item.project, "enrollment-head");
  const oldState = await readFile(state.path, "utf8");
  assert.equal((await issue(item, current, "event:new")).status, "pending");
  const newHead = await readFile(head.path, "utf8");
  await writeFile(state.path, oldState, { mode: 0o600 });
  const rolledBack = await currentHostTranscriptReceipt({ root: item.project, clock: clockAt(current), environment: item.environment });
  assert.equal(rolledBack.status, "unavailable");
  assert.equal(await readFile(head.path, "utf8"), newHead);
  await writeFile(state.path, "{\"signature\":\"forged\"}\n", { mode: 0o600 });
  const forged = await currentHostTranscriptReceipt({ root: item.project, clock: clockAt(current), environment: item.environment });
  assert.equal(forged.status, "unavailable");
  await writeFile(state.path, oldState, { mode: 0o600 });
  await unlink(head.path);
  const missing = await currentHostTranscriptReceipt({ root: item.project, clock: clockAt(current), environment: item.environment });
  assert.equal(missing.status, "unavailable");
  assert.equal(await resetPrivateSessionTimelineEnrollment({ root: item.project, confirmation: "wrong" }), false);
  assert.equal(await resetPrivateSessionTimelineEnrollment({ root: item.project,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_RECOVERY_CONFIRMATION }), true);
  const resetState = JSON.parse(await readFile(state.path, "utf8"));
  const resetHead = JSON.parse(await readFile(head.path, "utf8"));
  assert.equal(resetState.generation, 1);
  assert.equal(resetHead.stateSignature, resetState.signature);
  assert.equal((await currentHostTranscriptReceipt({ root: item.project, clock: clockAt(current), environment: item.environment })).status,
    "unavailable");
  assert.equal((await issue(item, current, "event:after-reset")).status, "pending");
  assert.equal(hash(await readFile(item.transcript)), sourceHash);
});

test("opaque host receipts deduplicate missing host event ids and raw enrollment is rejected", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  const sourceHash = hash(await readFile(item.transcript));
  const first = await issue(item, current, null, "Prepare synthetic no-event receipt one.");
  assert.equal(first.status, "pending");
  for (let index = 0; index < 40; index += 1) {
    const repeated = await issue(item, current, null, `Prepare synthetic no-event receipt ${index + 2}.`);
    assert.equal(repeated.status, "pending");
    assert.equal(repeated.receipt, first.receipt);
  }
  const raw = await enrollPrivateSessionTimeline({ root: item.project, host: "claude", sessionId: "session:recovery",
    scope: scope(), transcriptPath: item.transcript, hostHome: item.profile,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, clock: clockAt(current), environment: item.environment });
  assert.equal(raw.status, "unavailable");
  assert.equal(raw.reason, "host-transcript-receipt-required");
  const enrolled = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: first.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, clock: clockAt(current), environment: item.environment });
  assert.equal(enrolled.status, "enrolled");
  const replay = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: first.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, clock: clockAt(current), environment: item.environment });
  assert.equal(replay.status, "unavailable");
  assert.equal(hash(await readFile(item.transcript)), sourceHash);
});

test("a receipt observed before a source mutation yields no enrollment or source data", async (t) => {
  const current = new Date("2026-09-04T12:45:00.000Z");
  const item = await fixture(t);
  const receipt = await issue(item, current, "event:mutation");
  assert.equal(receipt.status, "pending");
  await appendFile(item.transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:46:00.000Z", message: {
    role: "tool", content: "Measured a changed synthetic source." } })}\n`);
  const expectedHash = hash(await readFile(item.transcript));
  const denied = await enrollPrivateSessionTimeline({ root: item.project, hostReceipt: receipt.receipt,
    confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, clock: clockAt(current), environment: item.environment });
  assert.equal(denied.status, "unavailable");
  assert.equal(denied.reason, "transcript-snapshot-changed");
  assert.equal(denied.binding, null);
  assert.equal(denied.source, null);
  assert.equal((await currentHostTranscriptReceipt({ root: item.project, clock: clockAt(current), environment: item.environment })).status,
    "unavailable");
  assert.equal(hash(await readFile(item.transcript)), expectedHash);
});
