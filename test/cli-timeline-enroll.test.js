import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enrollPrivateSessionTimeline, LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION
} from "../src/lib/session-timeline-enrollment.js";
import { privateEnrollmentPaths } from "../src/lib/session-timeline-enrollment-storage.js";
import { sessionTimelineStatePaths } from "../src/lib/session-timeline-auth.js";
import { requestTimelineHostReceipt } from "./session-timeline-invocation-support.js";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function scope() {
  return {
    entityId: "agent:synthetic", userId: "person:synthetic", tenantId: "tenant:synthetic",
    projectId: "project:synthetic", currentTaskId: "task:synthetic", goalId: "goal:synthetic",
    goalStepId: "step:synthetic", groupId: null
  };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-cli-timeline-enroll-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  const profile = join(workspace, "claude-profile");
  const transcript = join(profile, "projects", "synthetic", "session.jsonl");
  await Promise.all([
    mkdir(join(root, ".git"), { recursive: true }), mkdir(state), mkdir(join(profile, "projects", "synthetic"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(root, "AGENTS.md"), "# Synthetic CLI timeline project\n"),
    writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:00.000Z", message: {
      role: "tool", content: "Synthetic Suite 0 measured: PASS 15/15." } })}\n`)
  ]);
  const previous = {
    state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID
  };
  const transportEnvironment = {
    AGENTSPINE_TIMELINE_SESSION_CAPABILITY: `astc_${randomBytes(32).toString("base64url")}`,
    AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID: "session:cli-timeline"
  };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = transportEnvironment.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = transportEnvironment.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
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
  return { root, state, profile, transcript, transportEnvironment };
}

function cli(args, state, environment = {}) {
  const bin = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state, ...environment }
  });
}

async function issueReceipt(item, eventId = "cli-timeline-receipt") {
  const receipt = await requestTimelineHostReceipt({
    root: item.root, host: "claude", sessionId: "session:cli-timeline", scope: scope(),
    transcriptPath: item.transcript, hostHome: item.profile, eventId,
    environment: item.transportEnvironment
  });
  assert.equal(receipt.status, "pending");
  return receipt;
}

function enrollArgs(item, receipt, extra = []) {
  return ["timeline-enroll", "--root", item.root, "--receipt", receipt, ...extra, "--json"];
}

test("timeline CLI accepts only an opaque host receipt and local owner confirmation", async (t) => {
  const item = await fixture(t);
  const raw = cli([
    "timeline-enroll", "--root", item.root, "--host", "claude", "--session", "session:cli-timeline", "--json"
  ], item.state, item.transportEnvironment);
  assert.equal(raw.status, 1);
  assert.match(raw.stderr, /accepts only --root, --receipt, --confirm-local-timeline/);

  const missingReceipt = cli(["timeline-enroll", "--root", item.root, "--confirm-local-timeline", "--json"], item.state);
  assert.equal(missingReceipt.status, 1);
  assert.match(missingReceipt.stderr, /requires --receipt/);

  const receipt = await issueReceipt(item);
  const unconfirmed = cli(enrollArgs(item, receipt.receipt), item.state, item.transportEnvironment);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /requires --confirm-local-timeline/);

  const inaccessible = cli(["timeline-receipt", "--root", item.root, "--json"], item.state, {
    AGENTSPINE_TIMELINE_SESSION_CAPABILITY: "", AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID: ""
  });
  assert.equal(inaccessible.status, 0, inaccessible.stderr);
  assert.equal(JSON.parse(inaccessible.stdout).status, "unavailable");
  assert.equal(JSON.parse(inaccessible.stdout).receipt, null);
});

test("timeline receipt and enrollment keep source bytes immutable and bootstrap metadata without indexing", async (t) => {
  const item = await fixture(t);
  const before = digest(await readFile(item.transcript));
  await issueReceipt(item);

  const current = cli(["timeline-receipt", "--root", item.root, "--json"], item.state, item.transportEnvironment);
  assert.equal(current.status, 0, current.stderr);
  const pending = JSON.parse(current.stdout);
  assert.equal(pending.status, "pending");
  assert.match(pending.receipt, /^asthr_[A-Za-z0-9_-]{43}$/);
  assert.equal("binding" in pending, false);
  assert.equal("source" in pending, false);
  assert.doesNotMatch(current.stdout, /astc_/);

  const result = cli(enrollArgs(item, pending.receipt, ["--confirm-local-timeline"]), item.state, item.transportEnvironment);
  assert.equal(result.status, 0, result.stderr);
  const enrolled = JSON.parse(result.stdout);
  assert.equal(enrolled.status, "enrolled");
  assert.equal(enrolled.authority, "context-only");
  assert.equal(enrolled.timelineVisibility, "private-verified");
  assert.equal(enrolled.binding.host, "claude");
  assert.equal(enrolled.binding.groupId, null);
  assert.equal(enrolled.binding.taskId, "task:synthetic");
  assert.equal("accessProof" in enrolled, false);
  assert.equal("transportDigest" in enrolled, false);
  assert.deepEqual(enrolled.stateBootstrap, { status: "registered", reason: null });
  assert.doesNotMatch(result.stdout, /astc_/);
  const paths = await sessionTimelineStatePaths(item.root, { create: false });
  const sidecar = JSON.parse(await readFile(paths.path, "utf8"));
  assert.equal(sidecar.sources[0].indexedBytes, 0, "bootstrap stores metadata, not extracted evidence");
  assert.doesNotMatch(JSON.stringify(sidecar), /Synthetic Suite 0|synthetic-secret-value/);
  assert.equal(digest(await readFile(item.transcript)), before);

  const reused = cli(enrollArgs(item, pending.receipt, ["--confirm-local-timeline"]), item.state, item.transportEnvironment);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).reason, "host-transcript-receipt-unavailable");
});

test("timeline enrollment recovery is explicit and never returns a source or receipt", async (t) => {
  const item = await fixture(t);
  const denied = cli(["timeline-enrollment-recover", "--root", item.root, "--json"], item.state);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /requires --confirm-local-timeline-recovery/);

  const receipt = await issueReceipt(item, "cli-timeline-recovery");
  const enrollment = await enrollPrivateSessionTimeline({
    root: item.root, hostReceipt: receipt.receipt, confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION,
    environment: item.transportEnvironment
  });
  assert.equal(enrollment.status, "enrolled");
  const privateState = await privateEnrollmentPaths(item.root, { create: false });
  await unlink(privateState.headPath);

  const recovered = cli([
    "timeline-enrollment-recover", "--root", item.root, "--confirm-local-timeline-recovery", "--json"
  ], item.state);
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.status, "recovered");
  assert.equal(result.authority, "context-only");
  assert.equal("source" in result, false);
  assert.equal("receipt" in result, false);
  const fresh = cli(["timeline-receipt", "--root", item.root, "--json"], item.state, item.transportEnvironment);
  assert.equal(JSON.parse(fresh.stdout).status, "unavailable", "recovery discards receipts and requires a fresh host event");
});
