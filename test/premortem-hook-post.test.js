import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDeliveryPremortem } from "../src/lib/delivery-premortem.js";
import {
  prepareHookPremortem, recordHookPremortemWrite, verifyHookPremortemStop
} from "../src/lib/hook-premortem.js";

const ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the synthetic baseline." },
  { category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regressed",
    check: "Run the synthetic contract test." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic output is misplaced",
    check: "Verify the synthetic output path." }
];

test("a failed direct PostToolUse does not record an actual premortem write", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-premortem-failed-post-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(root), mkdir(state)]);
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  const scope = { host: "codex", projectId: "project:failed-post" };
  const input = {
    host: "codex", cwd: root, session_id: "session:failed-post",
    hook_event_name: "PostToolUse", tool_name: "Write",
    tool_use_id: "write:failed-post",
    tool_input: { file_path: "artifact.txt", content: "synthetic\n" },
    success: false, tool_error: "synthetic write failure"
  };
  const requirement = await prepareHookPremortem({ input, root, scope });
  assert.equal((await recordDeliveryPremortem({
    root, requirementId: requirement.requirementId, items: ITEMS
  })).blocked, false);

  const failed = await recordHookPremortemWrite({ input, root, scope, success: false });
  assert.deepEqual(failed, { status: "write-failed", blocked: false });
  const stopped = await verifyHookPremortemStop({
    input: { ...input, hook_event_name: "Stop", final_assistant_message: "" },
    root, scope
  });
  assert.equal(stopped.status, "no-write");
  assert.equal(stopped.blocked, false);
});
