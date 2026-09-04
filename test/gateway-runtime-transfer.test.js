import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assignGoal, completeGatewayRun, gatewayContext, gatewayRuntimeFindings,
  loadGatewayRuntime, reconcileGateway
} from "../src/lib/gateway-runtime.js";
import { claimReadOnlyGatewayWork } from "./gateway-claim-fixture.js";
import { addSyntheticPersona, fixture } from "./gateway-runtime-fixture.js";

test("objective strategy evidence transfers to a matching task and rolls back after one regression", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const targetAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-target", subjectId: "subject:transfer-target", host: "claude",
    profileId: "profile:transfer-target", displayName: "Transfer Target", now: "2032-01-01T00:00:00.600Z"
  });
  const fallbackAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-fallback", subjectId: "subject:transfer-fallback", host: "codex",
    profileId: "profile:transfer-fallback", displayName: "Transfer Fallback", now: "2032-01-01T00:00:00.700Z"
  });
  const staleAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-stale", subjectId: "subject:transfer-stale", host: "claude",
    profileId: "profile:transfer-stale", displayName: "Transfer Stale", now: "2032-01-01T00:00:00.800Z"
  });
  const foreignAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-foreign", subjectId: "subject:transfer-foreign", host: "codex",
    profileId: "profile:transfer-foreign", displayName: "Transfer Foreign", groupId: "group:beta",
    tenantId: "tenant:beta", now: "2032-01-01T00:00:00.900Z"
  });
  const verification = { evaluatorId: "evaluator:synthetic-transfer", metric: "metric:quality",
    operator: "gte", threshold: 0.9, minCases: 10 };
  const transferred = { strategyId: "strategy:proven-inspection", capabilities: ["capability:inspect"], risk: 5, cost: 20 };
  const sourceExecution = {
    requiredCapabilities: ["capability:inspect"],
    strategies: [transferred, { strategyId: "strategy:broad-write", capabilities: ["capability:inspect", "capability:write"], risk: 40, cost: 5 }],
    verification, transfer: { transferKey: "transfer:synthetic-inspection", maxAgeDays: 30 }
  };
  const targetExecution = {
    requiredCapabilities: ["capability:inspect"],
    strategies: [{ strategyId: "strategy:cheap-unproven", capabilities: ["capability:inspect"], risk: 5, cost: 10 }, transferred],
    verification, transfer: { transferKey: "transfer:synthetic-inspection", maxAgeDays: 30 }
  };
  const assign = ({ goalId, lead, execution, groupId = "group:alpha", now }) => assignGoal({
    root, goalId, agentId: lead, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId,
    successCriterion: `Objective transfer fixture ${goalId} passes.`, confirmation: "local-owner-confirmed", now,
    steps: [{ stepId: `step:${goalId.split(":").at(-1)}`, title: `Run ${goalId}.`,
      successCriterion: "The independent transfer evaluator passes.", dependsOn: [], execution }]
  });
  const finishSource = async (goalId, now, digest) => {
    await assign({ goalId, lead: agentId, execution: sourceExecution, now });
    const claim = await claimReadOnlyGatewayWork({ root, workerId: `worker:${goalId}`, now: new Date(new Date(now).getTime() + 1000) });
    assert.equal(claim.item.goalId, goalId);
    const completedAt = new Date(new Date(now).getTime() + 2000).toISOString();
    await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, now: completedAt,
      result: { checkpoint: { verified: goalId }, completed: true, readOnly: true, execution: {
        strategyId: transferred.strategyId, capabilitiesUsed: ["capability:inspect"], outcome: {
          ...verification, value: 0.94, cases: 10, blockingDefect: false,
          sourceDigest: digest, observedAt: new Date(new Date(now).getTime() + 1500).toISOString()
        }
      } }
    });
  };

  await finishSource("goal:transfer-source-one", "2032-01-01T00:00:01.000Z", "a".repeat(64));
  await assign({ goalId: "goal:transfer-before-evidence", lead: agentId, execution: targetExecution,
    now: "2032-01-01T00:00:03.250Z" });
  let control = await loadGatewayRuntime(root);
  const beforeEvidence = control.policy.goals.find((goal) => goal.goalId === "goal:transfer-before-evidence");
  assert.equal(beforeEvidence.plan.steps[0].execution.selectedStrategyId, "strategy:cheap-unproven");
  assert.equal(beforeEvidence.plan.steps[0].execution.transferProof, null);
  const controlClaim = await claimReadOnlyGatewayWork({ root, workerId: "worker:transfer:before",
    now: "2032-01-01T00:00:03.500Z" });
  await completeGatewayRun({ root, queueId: controlClaim.item.queueId, workerId: controlClaim.item.lease.workerId, claimedAt: controlClaim.item.lease.claimedAt, attempt: controlClaim.item.attempts,
    now: "2032-01-01T00:00:03.750Z", result: { completed: true, readOnly: true, execution: {
      strategyId: "strategy:cheap-unproven", capabilitiesUsed: ["capability:inspect"], outcome: {
        ...verification, value: 0.92, cases: 10, blockingDefect: false,
        sourceDigest: "d".repeat(64), observedAt: "2032-01-01T00:00:03.700Z"
      }
    } }
  });
  await finishSource("goal:transfer-source-two", "2032-01-01T00:00:04.000Z", "b".repeat(64));

  const assignments = await Promise.all(Array.from({ length: 6 }, () => assign({
    goalId: "goal:transfer-target", lead: targetAgentId, execution: targetExecution,
    now: "2032-01-02T00:00:00.000Z"
  })));
  assert.equal(assignments.filter((item) => item.duplicate !== true).length, 1);
  let loaded = await loadGatewayRuntime(root);
  const target = loaded.policy.goals.find((goal) => goal.goalId === "goal:transfer-target");
  assert.equal(target.plan.steps[0].execution.selectedStrategyId, transferred.strategyId);
  assert.equal(target.plan.steps[0].execution.transferProof.evidence.length, 2);
  assert.equal(loaded.runtime.queue.filter((item) => item.goalId === target.goalId && item.status === "pending").length, 1);

  // Lose the transfer wake, recover once, then prove six workers still obtain one exact lease.
  const lost = loaded.runtime.queue.find((item) => item.goalId === target.goalId && item.status === "pending");
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => item.queueId !== lost.queueId);
  loaded.runtime.receipts = loaded.runtime.receipts.filter((item) => item.objectId !== lost.queueId);
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-02T00:00:00.250Z" });
  await reconcileGateway({ root, now: "2032-01-02T00:00:00.500Z" });
  const raced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimReadOnlyGatewayWork({
    root, workerId: `worker:transfer:${index}`, now: "2032-01-02T00:00:01.000Z"
  })));
  assert.equal(raced.filter((entry) => entry.item).length, 1);
  const claim = raced.find((entry) => entry.item);
  assert.equal(claim.item.goalId, target.goalId);

  // The same evidence is too old after its frozen 30-day window and never crosses a group boundary.
  await assign({ goalId: "goal:transfer-stale", lead: staleAgentId, execution: targetExecution,
    now: "2032-02-05T00:00:00.000Z" });
  await assign({ goalId: "goal:transfer-foreign", lead: foreignAgentId, execution: targetExecution,
    groupId: "group:beta", now: "2032-01-02T00:00:01.250Z" });
  loaded = await loadGatewayRuntime(root);
  for (const goalId of ["goal:transfer-stale", "goal:transfer-foreign"]) {
    const execution = loaded.policy.goals.find((goal) => goal.goalId === goalId).plan.steps[0].execution;
    assert.equal(execution.selectedStrategyId, "strategy:cheap-unproven");
    assert.equal(execution.transferProof, null);
  }

  // One blocking defect overrides both earlier successes and removes transfer from every future matching task.
  await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    now: "2032-01-02T00:00:02.000Z", result: { checkpoint: { inspected: true }, completed: true, readOnly: true, execution: {
      strategyId: transferred.strategyId, capabilitiesUsed: ["capability:inspect"], outcome: {
        ...verification, value: 0.99, cases: 10, blockingDefect: true,
        sourceDigest: "c".repeat(64), observedAt: "2032-01-02T00:00:01.900Z"
      }
    } }
  });
  await assign({ goalId: "goal:transfer-after-regression", lead: fallbackAgentId, execution: targetExecution,
    now: "2032-01-03T00:00:00.000Z" });
  loaded = await loadGatewayRuntime(root);
  const afterRegression = loaded.policy.goals.find((goal) => goal.goalId === "goal:transfer-after-regression");
  assert.equal(afterRegression.plan.steps[0].execution.selectedStrategyId, "strategy:cheap-unproven");
  assert.equal(afterRegression.plan.steps[0].execution.transferProof, null);
  assert.deepEqual((await gatewayContext({ root, agentId: "agent:foreign" })).goals, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  // Recomputing every local digest cannot turn a fabricated source into valid transfer evidence.
  const targetForTamper = loaded.policy.goals.find((goal) => goal.goalId === "goal:transfer-target");
  const proof = targetForTamper.plan.steps[0].execution.transferProof;
  proof.evidence[0].sourceDigest = "f".repeat(64);
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  proof.proofDigest = digest({ transferKey: proof.transferKey, strategyId: proof.strategyId,
    maxAgeDays: proof.maxAgeDays, evidence: proof.evidence, authority: "context-only-transfer" });
  proof.proofId = "strategy-transfer:" + proof.proofDigest.slice(0, 32);
  const execution = targetForTamper.plan.steps[0].execution;
  execution.decisionDigest = digest({ requiredCapabilities: execution.requiredCapabilities,
    strategies: execution.strategies, verification: execution.verification,
    selectedStrategyId: execution.selectedStrategyId, transferKey: execution.transferKey,
    transferMaxAgeDays: execution.transferMaxAgeDays, transferProof: execution.transferProof,
    authority: "context-only-decision" });
  targetForTamper.plan.definitionsDigest = digest(targetForTamper.plan.steps.map(({ stepId, agentId, resources, execution: decision,
    title, successCriterion, dependsOn }) => ({ stepId, agentId, resources, execution: decision,
    title, successCriterion, dependsOn })));
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});

