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
import { runWorkerTick } from "../src/worker.js";
import { fixture } from "./gateway-runtime-fixture.js";

test("plan steps choose the safest sufficient strategy and require an objective post-action gate", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const steps = [{
    stepId: "step:bounded-inspection", title: "Inspect the bounded synthetic fixture.",
    successCriterion: "The objective fixture score reaches the precommitted threshold.", dependsOn: [],
    execution: {
      requiredCapabilities: ["capability:inspect"],
      strategies: [
        { strategyId: "strategy:write-and-inspect", capabilities: ["capability:inspect", "capability:write"], risk: 40, cost: 10 },
        { strategyId: "strategy:read-only", capabilities: ["capability:inspect"], risk: 5, cost: 20 }
      ],
      verification: { evaluatorId: "evaluator:synthetic-fixture", metric: "metric:quality", operator: "gte",
        threshold: 0.9, minCases: 12 }
    }
  }];
  await assignGoal({
    root, goalId: "goal:execution-reflection", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The safest sufficient strategy passes objective verification.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });

  let seenDecision;
  const unsupportedSelfReport = await runWorkerTick({ root, workerId: "worker:reflection:missing",
    now: "2032-01-01T00:00:02.000Z", hostRunner: async (item) => {
      seenDecision = item.goalStep.execution;
      return { checkpoint: { inspected: true }, completed: true, readOnly: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(seenDecision.selectedStrategyId, "strategy:read-only");
  assert.equal(unsupportedSelfReport.status, "blocked");
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].plan.steps[0].executionOutcomes.length, 0);
  assert.equal(loaded.runtime.receipts.some((receipt) => receipt.kind === "execution-proof-invalid"), true);

  await assignGoal({ root, goalId: "goal:execution-reflection", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The safest sufficient strategy passes objective verification.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:03.000Z" });
  const failedGate = await runWorkerTick({ root, workerId: "worker:reflection:defect",
    now: "2032-01-01T00:00:04.000Z", hostRunner: async () => ({ checkpoint: { inspected: true }, completed: true, readOnly: true,
      execution: { strategyId: "strategy:read-only", capabilitiesUsed: ["capability:inspect"], outcome: {
        evaluatorId: "evaluator:synthetic-fixture", metric: "metric:quality", value: 0.98, cases: 12,
        blockingDefect: true, sourceDigest: "a".repeat(64), observedAt: "2032-01-01T00:00:03.900Z"
      } }
    }), adapter: { send: async () => ({ ok: true }) } });
  assert.equal(failedGate.status, "blocked");
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].plan.steps[0].executionOutcomes[0].passed, false);

  await assignGoal({ root, goalId: "goal:execution-reflection", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The safest sufficient strategy passes objective verification.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:05.000Z" });
  // Lose the resumed wake and prove restart reconciliation recreates exactly one.
  loaded = await loadGatewayRuntime(root);
  const lostQueueIds = new Set(loaded.runtime.queue.filter((item) => item.status === "pending").map((item) => item.queueId));
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => !lostQueueIds.has(item.queueId));
  loaded.runtime.receipts = loaded.runtime.receipts.filter((receipt) => !lostQueueIds.has(receipt.objectId));
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:05.500Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:05.750Z" });
  const raced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimReadOnlyGatewayWork({
    root, workerId: `worker:reflection:pass:${index}`, now: "2032-01-01T00:00:06.000Z"
  })));
  assert.equal(raced.filter((claim) => claim.item).length, 1);
  const claim = raced.find((entry) => entry.item);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts, now: "2032-01-01T00:00:07.000Z",
    result: { checkpoint: { verified: true }, completed: true, readOnly: true,
      execution: { strategyId: "strategy:read-only", capabilitiesUsed: ["capability:inspect"], outcome: {
        evaluatorId: "evaluator:synthetic-fixture", metric: "metric:quality", value: 0.93, cases: 12,
        blockingDefect: false, sourceDigest: "b".repeat(64), observedAt: "2032-01-01T00:00:06.900Z"
      } }
    }
  });
  assert.equal(completed.executionReview.passed, true);
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps[0].executionOutcomes.map((outcome) => outcome.passed), [false, true]);
  const foreignExplorationContext = await gatewayContext({ root, agentId: "agent:foreign" });
  assert.deepEqual(foreignExplorationContext.goals, []);
  assert.deepEqual(foreignExplorationContext.executionAttempts, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  loaded.policy.goals[0].plan.steps[0].execution.strategies[1].risk = 99;
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});

test("a bounded reflection explores one equally safe alternative and stops on defects or budget exhaustion", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const verification = { evaluatorId: "evaluator:synthetic-exploration", metric: "metric:quality",
    operator: "gte", threshold: 0.9, minCases: 10 };
  const execution = {
    requiredCapabilities: ["capability:inspect"],
    strategies: [
      { strategyId: "strategy:cheap-first", capabilities: ["capability:inspect"], risk: 5, cost: 10 },
      { strategyId: "strategy:safe-alternative", capabilities: ["capability:inspect"], risk: 5, cost: 20 },
      { strategyId: "strategy:third-safe", capabilities: ["capability:inspect"], risk: 5, cost: 30 },
      { strategyId: "strategy:risky-shortcut", capabilities: ["capability:inspect"], risk: 40, cost: 1 }
    ],
    verification,
    exploration: { maxAttempts: 2 }
  };
  const assign = (goalId, now) => assignGoal({
    root, goalId, agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: `Bounded exploration for ${goalId} passes.`, confirmation: "local-owner-confirmed", now,
    steps: [{ stepId: `step:${goalId.split(":").at(-1)}`, title: `Explore ${goalId}.`,
      successCriterion: "The objective exploration evaluator passes.", dependsOn: [], execution }]
  });

  const assignments = await Promise.all(Array.from({ length: 6 }, () =>
    assign("goal:bounded-exploration", "2032-01-01T00:00:01.000Z")));
  assert.equal(assignments.filter((item) => item.duplicate !== true).length, 1);
  const attempts = [];
  const first = await runWorkerTick({
    root, workerId: "worker:exploration:first", now: "2032-01-01T00:00:02.000Z",
    hostRunner: async (item) => {
      attempts.push(item.goalStep.executionAttempt);
      return { completed: true, readOnly: true, execution: {
        strategyId: item.goalStep.executionAttempt.strategyId,
        capabilitiesUsed: ["capability:inspect"], outcome: {
          ...verification, value: 0.4, cases: 10, blockingDefect: false,
          sourceDigest: "a".repeat(64), observedAt: "2032-01-01T00:00:01.900Z"
        }
      } };
    },
    adapter: { send: async () => ({ ok: true }) }
  });
  assert.equal(first.status, "exploring");
  assert.deepEqual(attempts[0], {
    schema: "agentspine.execution-attempt/v1",
    attempt: 1, maxAttempts: 2, strategyId: "strategy:cheap-first",
    previousOutcomeDigest: null, decisionDigest: attempts[0].decisionDigest,
    authority: "context-only-attempt"
  });
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "active");
  assert.equal(loaded.policy.goals[0].plan.steps[0].executionOutcomes.length, 1);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 1);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "execution-exploration-continued").length, 1);
  assert.equal((await gatewayContext({ root, agentId })).executionAttempts[0].strategyId,
    "strategy:safe-alternative");

  // Lose the automatically scheduled alternative and prove restart reconciliation restores it once.
  const lost = loaded.runtime.queue.find((item) => item.status === "pending");
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => item.queueId !== lost.queueId);
  loaded.runtime.receipts = loaded.runtime.receipts.filter((item) => item.objectId !== lost.queueId);
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.250Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.500Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 1);

  const second = await runWorkerTick({
    root, workerId: "worker:exploration:second", now: "2032-01-01T00:00:03.000Z",
    hostRunner: async (item) => {
      attempts.push(item.goalStep.executionAttempt);
      return { completed: true, readOnly: true, execution: {
        strategyId: item.goalStep.executionAttempt.strategyId,
        capabilitiesUsed: ["capability:inspect"], outcome: {
          ...verification, value: 0.94, cases: 10, blockingDefect: false,
          sourceDigest: "b".repeat(64), observedAt: "2032-01-01T00:00:02.900Z"
        }
      } };
    },
    adapter: { send: async () => ({ ok: true }) }
  });
  assert.equal(second.status, "completed");
  assert.equal(attempts[1].attempt, 2);
  assert.equal(attempts[1].strategyId, "strategy:safe-alternative");
  assert.equal(attempts[1].previousOutcomeDigest,
    (await loadGatewayRuntime(root)).policy.goals[0].plan.steps[0].executionOutcomes[0].digest);
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps[0].executionOutcomes.map((item) => item.passed), [false, true]);

  // A blocking defect cannot be averaged away and never opens the alternative attempt.
  await assign("goal:blocking-exploration", "2032-01-01T00:00:04.000Z");
  const defect = await runWorkerTick({
    root, workerId: "worker:exploration:defect", now: "2032-01-01T00:00:05.000Z",
    hostRunner: async (item) => ({ completed: true, readOnly: true, execution: {
      strategyId: item.goalStep.executionAttempt.strategyId,
      capabilitiesUsed: ["capability:inspect"], outcome: {
        ...verification, value: 0.99, cases: 10, blockingDefect: true,
        sourceDigest: "c".repeat(64), observedAt: "2032-01-01T00:00:04.900Z"
      }
    } }), adapter: { send: async () => ({ ok: true }) }
  });
  assert.equal(defect.status, "blocked");
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals.find((goal) => goal.goalId === "goal:blocking-exploration").status, "blocked");
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 0);
  await assert.rejects(assign("goal:blocking-exploration", "2032-01-01T00:00:06.000Z"),
    /exploration.*exhausted|blocking defect/i);

  // Two ordinary failures consume the frozen budget; a third safe or riskier option is never attempted.
  await assign("goal:budget-exploration", "2032-01-01T00:00:07.000Z");
  const budgetAttempts = [];
  for (const [index, sourceDigest] of ["d".repeat(64), "e".repeat(64)].entries()) {
    const result = await runWorkerTick({
      root, workerId: `worker:exploration:budget:${index}`,
      now: `2032-01-01T00:00:0${8 + index}.000Z`,
      hostRunner: async (item) => {
        budgetAttempts.push(item.goalStep.executionAttempt.strategyId);
        return { completed: true, readOnly: true, execution: {
          strategyId: item.goalStep.executionAttempt.strategyId,
          capabilitiesUsed: ["capability:inspect"], outcome: {
            ...verification, value: 0.5 + index / 10, cases: 10, blockingDefect: false,
            sourceDigest, observedAt: `2032-01-01T00:00:0${7 + index}.900Z`
          }
        } };
      }, adapter: { send: async () => ({ ok: true }) }
    });
    assert.equal(result.status, index === 0 ? "exploring" : "blocked");
  }
  loaded = await loadGatewayRuntime(root);
  const exhausted = loaded.policy.goals.find((goal) => goal.goalId === "goal:budget-exploration");
  assert.equal(exhausted.status, "blocked");
  assert.deepEqual(budgetAttempts, ["strategy:cheap-first", "strategy:safe-alternative"]);
  assert.equal(exhausted.plan.steps[0].executionOutcomes.length, 2);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 0);
  await assert.rejects(assign("goal:budget-exploration", "2032-01-01T00:00:10.000Z"),
    /exploration.*exhausted/i);

  const foreignBoundedContext = await gatewayContext({ root, agentId: "agent:foreign" });
  assert.deepEqual(foreignBoundedContext.goals, []);
  assert.deepEqual(foreignBoundedContext.executionAttempts, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  // Recomputing local digests cannot expand the immutable exploration order into a riskier strategy.
  const completedGoal = loaded.policy.goals.find((goal) => goal.goalId === "goal:bounded-exploration");
  const decision = completedGoal.plan.steps[0].execution;
  decision.explorationOrder[1] = "strategy:risky-shortcut";
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  decision.decisionDigest = digest({ requiredCapabilities: decision.requiredCapabilities,
    strategies: decision.strategies, verification: decision.verification,
    selectedStrategyId: decision.selectedStrategyId,
    explorationMaxAttempts: decision.explorationMaxAttempts, explorationOrder: decision.explorationOrder,
    authority: "context-only-decision" });
  completedGoal.plan.definitionsDigest = digest(completedGoal.plan.steps.map(({ stepId, agentId: assignedAgent,
    resources, execution: exactExecution, title, successCriterion, dependsOn }) => ({
    stepId, agentId: assignedAgent, resources, execution: exactExecution, title, successCriterion, dependsOn
  })));
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});

