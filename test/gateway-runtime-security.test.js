import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assignGoal, completeGatewayRun, gatewayRuntimeFindings, loadGatewayRuntime
} from "../src/lib/gateway-runtime.js";
import { claimReadOnlyGatewayWork } from "./gateway-claim-fixture.js";
import { runWorkerTick } from "../src/worker.js";
import { runAudit } from "../src/lib/audit.js";
import { fixture } from "./gateway-runtime-fixture.js";

test("gateway receipts and checkpoints reject tampering, secrets, and authority claims", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:secure", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Synthetic security gate passes.",
    nextSafeStep: "Run one bounded step.", confirmation: "local-owner-confirmed"
  });
  const claim = await claimReadOnlyGatewayWork({ root, workerId: "worker:secure" });
  await assert.rejects(completeGatewayRun({
    root, queueId: claim.item.queueId, workerId: "worker:secure", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { checkpoint: { token: "abcdefghijklmnopqrstuvwxyz1234567890" }, readOnly: true }
  }), /secret- or authority-shaped/i);
  const { policy, runtime } = await loadGatewayRuntime(root);
  const forged = structuredClone(runtime);
  forged.receipts[0].digest = "0".repeat(64);
  assert.match(gatewayRuntimeFindings(policy, forged).join(","), /invalid-gateway-receipt/);
});

test("the ten-gate audit fails closed on forged gateway state", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:audit", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Audit remains green.", nextSafeStep: "Inspect the receipt.",
    confirmation: "local-owner-confirmed"
  });
  await runWorkerTick({ root, workerId: "worker:audit",
    hostRunner: async () => ({ checkpoint: { audit: true }, completed: false }),
    adapter: { send: async () => ({ ok: true }) } });
  const before = await runAudit(root);
  assert.equal(before.ok, true, JSON.stringify(before.gates));
  const loaded = await loadGatewayRuntime(root);
  loaded.runtime.receipts[0].authority = "explicit-local-execution-policy";
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  const forged = await runAudit(root);
  assert.equal(forged.ok, false);
  assert.equal(forged.gates.find((gate) => gate.id === 8).ok, false);
});
