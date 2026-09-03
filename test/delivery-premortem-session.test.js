import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectDeliveryPremortems,
  preparePremortemRequirement,
  recordDeliveryPremortem,
  recordPremortemWrite,
  verifyPremortemBeforeWrite,
  verifyPremortemStop
} from "../src/lib/delivery-premortem.js";

const ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the frozen synthetic baseline." },
  { category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regressed",
    check: "Run the synthetic contract suite." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact went elsewhere",
    check: "Hash the synthetic artifact at its destination." }
];

async function fixture(t, suffix) {
  const root = await mkdtemp(join(tmpdir(), `agentspine-premortem-session-${suffix}-`));
  const state = await mkdtemp(join(tmpdir(), `agentspine-premortem-session-state-${suffix}-`));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([rm(root, { recursive: true, force: true }),
      rm(state, { recursive: true, force: true })]);
  });
  return { root, binding: { host: "claude", sessionId: `session:${suffix}`,
    projectId: "project:synthetic", entityId: "agent:synthetic" } };
}

function closure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map((item) =>
      `- ${item.category} ${item.checkId}: PASS — verified ${item.category}`)].join("\n");
}

test("multiple Claude prompts in one session reuse one premortem and re-close only after writes", async (t) => {
  const { root, binding } = await fixture(t, "reuse");
  const first = await preparePremortemRequirement({ root, binding });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: first.requirementId, items: ITEMS });
  const firstWrite = await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:first", tool_input: { file_path: "synthetic.js" } } });
  const firstClosure = closure(recorded.artifact, firstWrite.writeDigest);
  assert.equal((await verifyPremortemStop({ root, binding, message: firstClosure })).status, "closed");

  const nextPrompt = await preparePremortemRequirement({ root, binding });
  assert.equal(nextPrompt.requirementId, first.requirementId);
  assert.equal(nextPrompt.requirement.digest, first.requirement.digest);
  assert.equal((await verifyPremortemBeforeWrite({ root, binding })).status, "verified");
  assert.equal((await verifyPremortemStop({ root, binding,
    message: firstClosure })).status, "closed");

  const secondWrite = await recordPremortemWrite({ root, binding,
    input: { tool_use_id: "write:second", tool_input: { file_path: "synthetic.js" } } });
  assert.equal((await verifyPremortemStop({ root, binding,
    message: firstClosure })).status, "unchecked");
  const reclosed = await verifyPremortemStop({ root, binding,
    message: closure(recorded.artifact, secondWrite.writeDigest) });
  assert.equal(reclosed.status, "closed");
  assert.equal(reclosed.closure.lastWriteDigest, secondWrite.writeDigest);
  assert.equal((await inspectDeliveryPremortems(root)).states.length, 1);
});

test("a new Claude session gets an independent missing premortem", async (t) => {
  const { root, binding } = await fixture(t, "new-session");
  const first = await preparePremortemRequirement({ root, binding });
  await recordDeliveryPremortem({ root, requirementId: first.requirementId, items: ITEMS });
  const other = { ...binding, sessionId: "session:new-session-other" };
  const second = await preparePremortemRequirement({ root, binding: other });
  assert.notEqual(second.requirementId, first.requirementId);
  const missing = await verifyPremortemBeforeWrite({ root, binding: other });
  assert.equal(missing.status, "missing");
  assert.equal(missing.blocked, true);
});

test("a deleted read-only generation rejects its delayed registration", async (t) => {
  const { root, binding } = await fixture(t, "aba");
  const oldRequirement = await preparePremortemRequirement({ root, binding });
  assert.equal((await verifyPremortemStop({ root, binding,
    message: "Read-only first answer." })).status, "no-write");
  const current = await preparePremortemRequirement({ root, binding });
  assert.notEqual(current.requirementId, oldRequirement.requirementId);
  const delayed = await recordDeliveryPremortem({ root,
    requirementId: oldRequirement.requirementId, items: ITEMS });
  assert.equal(delayed.status, "stale");
  assert.equal(delayed.blocked, true);
  assert.equal((await verifyPremortemBeforeWrite({ root, binding })).status, "missing");
  assert.equal((await recordDeliveryPremortem({ root,
    requirementId: current.requirementId, items: ITEMS })).status, "recorded");
});
