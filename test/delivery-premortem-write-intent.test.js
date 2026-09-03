import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preparePremortemRequirement,
  recordDeliveryPremortem,
  recordPremortemWrite,
  recordPremortemWriteIntent,
  verifyPremortemStop
} from "../src/lib/delivery-premortem.js";

const ITEMS = [
  { category: "baseline-environment", failure: "this delivery fails because the baseline moved",
    check: "Compare the exact synthetic baseline." },
  { category: "contract-tests", failure: "this delivery fails because tests did not run",
    check: "Run the synthetic contract test." },
  { category: "delivery-path", failure: "this delivery fails because output went elsewhere",
    check: "Verify the synthetic delivery path." }
];

async function fixture(t, sessionId) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-write-intent-project-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-write-intent-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
  });
  return { root, binding: { host: "codex", sessionId,
    projectId: "project:synthetic", entityId: "agent:synthetic" } };
}

function closure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — verified ${item.category}`)].join("\n");
}

test("Pre write intent and matching Post share one stable write receipt", async (t) => {
  const { root, binding } = await fixture(t, "session:intent-dedupe");
  const requirement = await preparePremortemRequirement({ root, binding });
  const artifact = await recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  const pre = await recordPremortemWriteIntent({ root, binding,
    input: { hook_event_name: "PreToolUse", tool_use_id: "write:stable", tool_input: { path: "out.js" } } });
  assert.equal(pre.status, "write-intent-recorded");
  const post = await recordPremortemWrite({ root, binding, success: false,
    input: { hook_event_name: "PostToolUse", tool_use_id: "write:stable", tool_response: null } });
  assert.equal(post.status, "duplicate");
  assert.equal(post.writeDigest, pre.writeDigest);
  const stopped = await verifyPremortemStop({ root, binding,
    message: closure(artifact.artifact, pre.writeDigest) });
  assert.equal(stopped.status, "closed");
});

test("a Post-only ambiguous direct write is tracked conservatively", async (t) => {
  const { root, binding } = await fixture(t, "session:post-only");
  const requirement = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: requirement.requirementId, items: ITEMS });
  const post = await recordPremortemWrite({ root, binding, success: false,
    input: { hook_event_name: "PostToolUse", tool_use_id: "write:post-only" } });
  assert.equal(post.status, "write-recorded");
  const stopped = await verifyPremortemStop({ root, binding, message: "No closure." });
  assert.equal(stopped.status, "unchecked");
  assert.equal(stopped.blocked, true);
});
