import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSessionTimelineLifecycle } from "../src/lib/hook-timeline.js";
import { sessionTimelineStatePaths } from "../src/lib/session-timeline-auth.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function privateScope() {
  return {
    host: "claude", entityId: "agent:timeline-scope", userId: "person:timeline-scope",
    tenantId: "tenant:timeline-scope", projectId: "project:timeline-scope",
    currentTaskId: "task:timeline-scope", goalId: "goal:timeline-scope",
    goalStepId: "step:timeline-scope", groupId: null, timelineVisibility: "private-verified"
  };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-hook-timeline-scope-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const root = join(workspace, "project");
  const transcript = join(profile, "projects", "scope", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(join(root, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "scope"), { recursive: true })
  ]);
  await writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:00.000Z", message: {
    role: "tool", content: "Measured synthetic scope Suite 0; result: PASS 1/1." } })}\n`);
  const prior = {
    state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID
  };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${"a".repeat(43)}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:timeline-scope";
  t.after(async () => {
    if (prior.state === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = prior.state;
    if (prior.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior.claude;
    if (prior.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = prior.capability;
    if (prior.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = prior.transportSession;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  const scope = privateScope();
  const enrollment = await enrollTimelineWithHostReceipt({ root, sessionId: "session:timeline-scope",
    scope, transcriptPath: transcript, hostHome: profile });
  assert.equal(enrollment.status, "enrolled");
  return { root, profile, transcript, scope };
}

test("raw top-level and nested group claims suppress private lifecycle capture", async (t) => {
  const item = await fixture(t);
  const before = digest(await readFile(item.transcript));
  const state = await sessionTimelineStatePaths(item.root, { create: false });
  const sidecarBefore = await readFile(state.path);
  const cases = [
    { groupId: "group:top-camel" },
    { group_id: "group:top-snake" },
    { agent_spine_scope: { groupId: "group:nested-camel" } },
    { agent_spine_scope: { group_id: "group:nested-snake" } }
  ];
  for (const rawScope of cases) {
    const result = await captureSessionTimelineLifecycle({ root: item.root, event: "PreCompact", hostHome: item.profile,
      catalog: { documents: [] }, scope: item.scope, input: {
        session_id: "session:timeline-scope", transcript_path: item.transcript, ...rawScope
      } });
    assert.deepEqual(result, {
      schema: "agentspine.session-timeline/v1", status: "group-suppressed", reason: "raw-group-scope",
      authority: "context-only"
    });
  }
  assert.deepEqual(await readFile(state.path), sidecarBefore, "group claims never alter a private timeline sidecar");
  assert.equal(digest(await readFile(item.transcript)), before, "group-suppressed lifecycle capture preserves transcript bytes");
});

test("computed group scope remains suppressed when raw hook scope is absent", async (t) => {
  const item = await fixture(t);
  const result = await captureSessionTimelineLifecycle({ root: item.root, event: "SessionStart", hostHome: item.profile,
    catalog: { documents: [] }, scope: { ...item.scope, groupId: "group:computed" }, input: {
      session_id: "session:timeline-scope", transcript_path: item.transcript
    } });
  assert.deepEqual(result, {
    schema: "agentspine.session-timeline/v1", status: "group-suppressed", reason: "computed-group-scope",
    authority: "context-only"
  });
});
