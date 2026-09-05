import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTimelinePrivatePaths } from "../src/lib/session-timeline-auth.js";
import { sessionTimelineRootDigest } from "../src/lib/session-timeline-root.js";
import { timelineTransportDigest } from "../src/lib/session-timeline-transport.js";

test("timeline identity is stable across an operating-system path alias", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-timeline-root-"));
  const project = join(workspace, "project");
  const alias = join(workspace, "project-alias");
  const state = join(workspace, "state");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  await Promise.all([mkdir(project), mkdir(state)]);
  try { await symlink(project, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code)) throw error;
    t.skip("the platform cannot create the required synthetic path alias");
    return;
  }
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  const binding = {
    host: "claude", sessionId: "session:root-alias", entityId: "agent:synthetic",
    userId: "person:synthetic", tenantId: "tenant:synthetic", projectId: "project:synthetic",
    taskId: "task:synthetic", groupId: null, goalId: null, goalStepId: null
  };
  const environment = {
    AGENTSPINE_TIMELINE_SESSION_CAPABILITY: `astc_${randomBytes(32).toString("base64url")}`,
    AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID: binding.sessionId
  };
  assert.equal(sessionTimelineRootDigest(alias), sessionTimelineRootDigest(project));
  assert.equal((await sessionTimelinePrivatePaths(alias, "state")).path,
    (await sessionTimelinePrivatePaths(project, "state")).path);
  assert.equal(timelineTransportDigest({ root: alias, binding, environment }),
    timelineTransportDigest({ root: project, binding, environment }));
});
