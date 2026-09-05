import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { enrollTimelineWithHostReceipt } from "./session-timeline-invocation-support.js";

function scope(overrides = {}) {
  return {
    entityId: "agent:guard", userId: "person:guard", tenantId: "tenant:guard",
    projectId: "project:guard", currentTaskId: "task:guard", goalId: "goal:guard",
    goalStepId: "step:guard", groupId: null, timelineVisibility: "private-verified", ...overrides
  };
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-guard-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const transcript = join(profile, "projects", "guard", "session.jsonl");
  await Promise.all([
    mkdir(state), mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(profile, "projects", "guard"), { recursive: true })
  ]);
  await writeFile(join(project, "AGENTS.md"), "# Synthetic timeline guard project\n");
  await writeFile(transcript, `${JSON.stringify({ timestamp: "2026-09-04T12:40:00.000Z", message: {
    role: "tool", content: "Measured synthetic Suite 0; result: PASS 1/1." } })}\n`);
  const before = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    capability: process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY,
    transportSession: process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = `astc_${randomBytes(32).toString("base64url")}`;
  process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = "session:guard";
  t.after(async () => {
    if (before.state === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = before.state;
    if (before.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before.claude;
    if (before.capability === undefined) delete process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY;
    else process.env.AGENTSPINE_TIMELINE_SESSION_CAPABILITY = before.capability;
    if (before.transportSession === undefined) delete process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID;
    else process.env.AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID = before.transportSession;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { profile, project, transcript };
}

function toolInput(item, overrides = {}) {
  return {
    hook_event_name: "PreToolUse", host: "claude", cwd: item.project, session_id: "session:guard",
    tool_use_id: "tool:guard", tool_name: "mcp__plugin_agent-spine_agent-spine__session_timeline_search",
    tool_input: { root: item.project, at: "2026-09-04T12:40:00.000Z", query: "Suite PASS" }, ...scope(), ...overrides
  };
}

test("timeline guard evaluates enrollment expiry from its real clock, not host input time", async (t) => {
  const item = await fixture(t);
  const expiredAt = new Date(Date.now() - 120_000);
  const enrollment = await enrollTimelineWithHostReceipt({ root: item.project, sessionId: "session:guard", scope: scope(),
    transcriptPath: item.transcript, hostHome: item.profile, ttlMs: 60_000, clock: () => expiredAt, bootstrap: false });
  assert.equal(enrollment.status, "enrolled");
  const forgedPast = new Date(Date.now() - 90_000).toISOString();
  const guarded = await runHook(toolInput(item, { timestamp: forgedPast }));
  assert.equal(guarded.blocked, true);
  assert.equal(guarded.updatedInput, undefined);
});

test("timeline guard refuses authenticated gateway groups and mismatched gateway bindings", async (t) => {
  const item = await fixture(t);
  assert.equal((await enrollTimelineWithHostReceipt({ root: item.project, sessionId: "session:guard", scope: scope(),
    transcriptPath: item.transcript, hostHome: item.profile })).status, "enrolled");
  const names = ["AGENTSPINE_GATEWAY_CONTEXT", "AGENTSPINE_HOST", "AGENTSPINE_ENTITY_ID", "AGENTSPINE_GROUP_ID"];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });
  process.env.AGENTSPINE_GATEWAY_CONTEXT = "agentspine.gateway-start/v1";
  process.env.AGENTSPINE_HOST = "claude";
  process.env.AGENTSPINE_ENTITY_ID = "agent:guard";
  process.env.AGENTSPINE_GROUP_ID = "group:synthetic";
  const grouped = await runHook(toolInput(item));
  assert.equal(grouped.blocked, true);
  delete process.env.AGENTSPINE_GROUP_ID;
  process.env.AGENTSPINE_ENTITY_ID = "agent:foreign";
  const foreign = await runHook(toolInput(item));
  assert.equal(foreign.blocked, true);
});
