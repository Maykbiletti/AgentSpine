import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { recordDeliveryPremortem } from "../src/lib/delivery-premortem.js";
import { seedDeliveryAgentUse } from "./delivery-agent-use-fixture.js";

const ITEMS = [
  { category: "baseline-environment", failure: "this delivery fails because the baseline is stale",
    check: "Compare the synthetic baseline digest." },
  { category: "contract-tests", failure: "this delivery fails because the contract regresses",
    check: "Run the focused synthetic test." },
  { category: "delivery-path", failure: "this delivery fails because the path is wrong",
    check: "Check the synthetic output path." }
];

test("an ordinary session derives one project-bound premortem without project_id", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-premortem-default-project-"));
  const root = join(workspace, "project");
  const nested = join(root, "nested");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }),
    mkdir(nested, { recursive: true }), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n", "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  const base = { host: "codex", session_id: "session:derived-project" };
  const prompted = await runHook({ ...base, cwd: root, hook_event_name: "UserPromptSubmit",
    prompt: "Change the synthetic artifact safely." });
  const requirement = prompted.preflight.premortem;
  assert.equal(requirement.status, "required");
  assert.equal(requirement.requirement.binding.projectId, prompted.preflight.receipt.projectId);
  const write = { ...base, cwd: nested, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_use_id: "write:derived-project", tool_input: { file_path: "artifact.txt", content: "synthetic\n" } };
  const denied = await runHook(write);
  assert.equal(denied.blocked, true);
  assert.equal(denied.premortem.requirementId, requirement.requirementId);
  assert.match(denied.reason, new RegExp(requirement.requirementId));
  await seedDeliveryAgentUse(root, requirement.requirementId);
  assert.equal((await recordDeliveryPremortem({ root, requirementId: requirement.requirementId,
    items: ITEMS })).blocked, false);
  const allowed = await runHook(write);
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.premortem.requirementId, requirement.requirementId);
});
