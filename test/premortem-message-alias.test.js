import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookScanAuditPath } from "../src/lib/hook-audit.js";
import { verifyHookPremortemStop } from "../src/lib/hook-premortem.js";

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-premortem-alias-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(root), mkdir(state)]);
  const prior = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (prior === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = prior;
    await rm(workspace, { recursive: true, force: true });
  });
  return { root, state };
}

const scope = { host: "codex", projectId: "project:synthetic" };

test("conflicting recognized final-message aliases degrade and fail open", async (t) => {
  const { root, state } = await fixture(t);
  const result = await verifyHookPremortemStop({ root, scope, input: {
    hook_event_name: "Stop", session_id: "session:alias-conflict",
    final_assistant_message: "Synthetic result A.", final_message: "Synthetic result B."
  } });
  assert.equal(result.blocked, false);
  assert.equal(result.status, "degraded");
  assert.match(result.reason, /aliases conflict: final_assistant_message, final_message/);
  const records = (await readFile(hookScanAuditPath({
    ...process.env, AGENTSPINE_STATE_DIR: state
  }), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.some((record) => record.phase === "premortem-stop"
    && /aliases conflict/.test(record.error) && record.decision === "allow"), true);
});

test("identical recognized final-message aliases are accepted", async (t) => {
  const { root } = await fixture(t);
  const text = "Synthetic read-only result.";
  const result = await verifyHookPremortemStop({ root, scope, input: {
    hook_event_name: "Stop", session_id: "session:alias-identical",
    last_assistant_message: text, response: text
  } });
  assert.equal(result.blocked, false);
  assert.equal(result.status, "no-write");
});

test("a malformed recognized alias beside a string degrades and fails open", async (t) => {
  const { root, state } = await fixture(t);
  const result = await verifyHookPremortemStop({ root, scope, input: {
    hook_event_name: "Stop", session_id: "session:alias-malformed",
    final_assistant_message: "Synthetic result.", response: { text: "Synthetic result." }
  } });
  assert.equal(result.blocked, false);
  assert.equal(result.status, "degraded");
  assert.match(result.reason, /aliases are non-string: response/);
  const records = (await readFile(hookScanAuditPath({
    ...process.env, AGENTSPINE_STATE_DIR: state
  }), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.some((record) => record.phase === "premortem-stop"
    && /aliases are non-string/.test(record.error) && record.decision === "allow"), true);
});
