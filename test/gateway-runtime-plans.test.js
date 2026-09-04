import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPersonaRoster, loadPersonaRuntime } from "../src/lib/persona-runtime.js";
import {
  assignGoal, claimGatewayWork, completeGatewayRun, gatewayContext,
  gatewayRuntimeFindings, loadGatewayRuntime, reconcileGateway
} from "../src/lib/gateway-runtime.js";
import { claimReadOnlyGatewayWork } from "./gateway-claim-fixture.js";
import { runWorkerTick } from "../src/worker.js";
import { addSyntheticPersona, fixture } from "./gateway-runtime-fixture.js";

test("authenticated goal assignment remains idle-safe without a goal and checkpointed with one", async (t) => {
  const { root, agentId } = await fixture(t);
  assert.equal((await claimReadOnlyGatewayWork({ root, workerId: "worker:idle" })).reason, "idle/needs-goal");
  await assignGoal({
    root, goalId: "goal:alpha", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Synthetic acceptance is green.", nextSafeStep: "Run the synthetic check.",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });
  const claim = await claimReadOnlyGatewayWork({ root, workerId: "worker:goal", now: "2032-01-01T00:00:02.000Z" });
  await completeGatewayRun({
    root, queueId: claim.item.queueId, workerId: "worker:goal", claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { checkpoint: { gate: 1 }, completed: false, readOnly: true }, now: "2032-01-01T00:00:03.000Z"
  });
  const { policy, runtime } = await loadGatewayRuntime(root);
  assert.deepEqual(policy.goals[0].checkpoint, { gate: 1 });
  assert.equal(runtime.queue.some((item) => item.kind === "follow-up" && item.status === "pending"), true);
});

test("dependency-bound goal plans resume after a torn write and complete three objective steps in order", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const planSteps = [
    { stepId: "step:observe", title: "Observe the synthetic state.",
      successCriterion: "The observed digest is recorded.", dependsOn: [] },
    { stepId: "step:act", title: "Apply the bounded synthetic action.",
      successCriterion: "The bounded action reports success.", dependsOn: ["step:observe"] },
    { stepId: "step:verify", title: "Verify the synthetic outcome.",
      successCriterion: "The independent outcome check is green.", dependsOn: ["step:act"] }
  ];
  await assignGoal({
    root, goalId: "goal:vertical", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Three synthetic acceptance gates pass in dependency order.",
    steps: planSteps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });

  // Simulate the policy write surviving while the matching runtime write is lost.
  let loaded = await loadGatewayRuntime(root);
  loaded.runtime.queue = [];
  loaded.runtime.receipts = [];
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.000Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.500Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.goalStepId === "step:observe" && item.status === "pending").length, 1);

  const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => claimReadOnlyGatewayWork({
    root, workerId: `worker:plan:${index}`, now: "2032-01-01T00:00:03.000Z"
  })));
  assert.equal(claims.filter((claim) => claim.item).length, 1);
  const observe = claims.find((claim) => claim.item);
  assert.equal(observe.item.goalStepId, "step:observe");
  await completeGatewayRun({ root, queueId: observe.item.queueId, workerId: observe.item.lease.workerId, claimedAt: observe.item.lease.claimedAt, attempt: observe.item.attempts,
    result: { checkpoint: { observed: true }, completed: true, readOnly: true }, now: "2032-01-01T00:00:04.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "active", "pending"]);
  assert.equal(loaded.policy.goals[0].status, "active");

  const act = await claimReadOnlyGatewayWork({ root, workerId: "worker:plan:act", now: "2032-01-01T00:00:05.000Z" });
  assert.equal(act.item.goalStepId, "step:act");
  await completeGatewayRun({ root, queueId: act.item.queueId, workerId: "worker:plan:act", claimedAt: act.item.lease.claimedAt, attempt: act.item.attempts,
    result: { checkpoint: { dependency: "offline" }, blocked: true, blocker: "Synthetic dependency is unavailable.", readOnly: true },
    now: "2032-01-01T00:00:05.500Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "blocked");
  const resumed = await assignGoal({
    root, goalId: "goal:vertical", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Three synthetic acceptance gates pass in dependency order.",
    steps: planSteps, confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:05.750Z"
  });
  assert.equal(resumed.resumed, true);
  const resumedAct = await claimReadOnlyGatewayWork({ root, workerId: "worker:plan:act-resumed", now: "2032-01-01T00:00:05.900Z" });
  assert.equal(resumedAct.item.goalStepId, "step:act");
  await completeGatewayRun({ root, queueId: resumedAct.item.queueId, workerId: "worker:plan:act-resumed", claimedAt: resumedAct.item.lease.claimedAt, attempt: resumedAct.item.attempts,
    result: { checkpoint: { acted: true }, completed: true, readOnly: true }, now: "2032-01-01T00:00:06.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "completed", "active"]);

  const verify = await claimReadOnlyGatewayWork({ root, workerId: "worker:plan:verify", now: "2032-01-01T00:00:07.000Z" });
  assert.equal(verify.item.goalStepId, "step:verify");
  await completeGatewayRun({ root, queueId: verify.item.queueId, workerId: "worker:plan:verify", claimedAt: verify.item.lease.claimedAt, attempt: verify.item.attempts,
    result: { checkpoint: { verified: true }, completed: true, readOnly: true }, now: "2032-01-01T00:00:08.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "completed", "completed"]);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);
});

test("provider-neutral goal plans hand dependent steps to exact authenticated teammates", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const teammateId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:linnea", subjectId: "subject:linnea", host: "claude",
    profileId: "profile:linnea", displayName: "Linnea", now: "2032-01-01T00:00:00.750Z"
  });
  const steps = [
    { stepId: "step:observe", agentId, title: "Observe the synthetic input.",
      successCriterion: "The input digest is recorded.", dependsOn: [] },
    { stepId: "step:analyze", agentId: teammateId, title: "Analyze the bounded synthetic input.",
      successCriterion: "The analysis fixture reports green.", dependsOn: ["step:observe"] },
    { stepId: "step:verify", agentId, title: "Verify the independent synthetic result.",
      successCriterion: "The independent verification reports green.", dependsOn: ["step:analyze"] }
  ];
  await assignGoal({
    root, goalId: "goal:team-handoff", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Two providers complete three dependent synthetic gates.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });

  // Simulate a torn policy/runtime write before the first team step is claimed.
  let loaded = await loadGatewayRuntime(root);
  loaded.runtime.queue = []; loaded.runtime.receipts = [];
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:01.500Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:01.750Z" });

  const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => claimReadOnlyGatewayWork({
    root, workerId: `worker:team:${index}`, now: "2032-01-01T00:00:02.000Z"
  })));
  assert.equal(claims.filter((claim) => claim.item).length, 1);
  const first = claims.find((claim) => claim.item);
  assert.equal(first.item.agentId, agentId);
  await completeGatewayRun({ root, queueId: first.item.queueId, workerId: first.item.lease.workerId, claimedAt: first.item.lease.claimedAt, attempt: first.item.attempts,
    result: { checkpoint: { observed: true }, completed: true, readOnly: true }, now: "2032-01-01T00:00:03.000Z" });

  const routes = [];
  const second = await runWorkerTick({ root, workerId: "worker:team:claude", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async (item) => {
      routes.push([item.goalStep.stepId, item.agentId, item.host, item.profileId]);
      return { checkpoint: { analyzed: true }, completed: true, readOnly: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(second.status, "completed");
  const third = await runWorkerTick({ root, workerId: "worker:team:codex", now: "2032-01-01T00:00:05.000Z",
    hostRunner: async (item) => {
      routes.push([item.goalStep.stepId, item.agentId, item.host, item.profileId]);
      return { checkpoint: { verified: true }, completed: true, readOnly: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(third.status, "completed");
  assert.deepEqual(routes, [
    ["step:analyze", teammateId, "claude", "profile:linnea"],
    ["step:verify", agentId, "codex", "profile:alpha"]
  ]);

  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "completed", "completed"]);
  assert.equal((await gatewayContext({ root, agentId: teammateId })).goals[0].goalId, "goal:team-handoff");
  const foreignContext = await gatewayContext({ root, agentId: "agent:foreign" });
  assert.deepEqual(foreignContext.goals, []);
  assert.deepEqual(foreignContext.executionAttempts, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  loaded.policy.goals[0].plan.steps[1].agentId = agentId;
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});

test("team plans reject foreign groups and pause safely when an assignee leaves", async (t) => {
  const { root, agentId } = await fixture(t);
  const teammateId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:solveig", subjectId: "subject:solveig", host: "claude",
    profileId: "profile:solveig", displayName: "Solveig", now: "2032-01-01T00:00:00.700Z"
  });
  const outsiderId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:outsider", subjectId: "subject:outsider", host: "codex",
    profileId: "profile:outsider", displayName: "Outsider", groupId: "group:beta",
    now: "2032-01-01T00:00:00.800Z"
  });
  const base = {
    root, agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The exact synthetic team completes its assigned gate.", confirmation: "local-owner-confirmed"
  };
  await assert.rejects(assignGoal({ ...base, goalId: "goal:foreign-team", steps: [{
    stepId: "step:foreign", agentId: outsiderId, title: "Run foreign step.", successCriterion: "Foreign step passes.", dependsOn: []
  }] }), /group does not match/i);

  const teamSteps = [{ stepId: "step:teammate", agentId: teammateId, title: "Run teammate step.",
    successCriterion: "Teammate step passes.", dependsOn: [] }];
  await assignGoal({ ...base, goalId: "goal:member-leaves", steps: teamSteps, now: "2032-01-01T00:00:01.000Z" });
  const personas = await loadPersonaRuntime(root);
  const binding = personas.policy.bindings.find((item) => item.id === "persona-binding:solveig");
  await applyPersonaRoster({ root, bindings: [{ ...binding, active: false }],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:02.000Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:03.000Z" });
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "blocked");
  assert.equal(loaded.policy.goals[0].plan.steps[0].status, "blocked");
  assert.equal(loaded.runtime.queue.filter((item) => ["pending", "leased"].includes(item.status)).length, 0);
  assert.equal((await claimReadOnlyGatewayWork({ root, workerId: "worker:departed", now: "2032-01-01T00:00:04.000Z" })).item, null);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
});

test("shared plan resources serialize conflicting agents by immutable goal priority", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const highAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:high", subjectId: "subject:high", host: "claude",
    profileId: "profile:high", displayName: "High Agent", now: "2032-01-01T00:00:00.600Z"
  });
  const independentAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:independent", subjectId: "subject:independent", host: "codex",
    profileId: "profile:independent", displayName: "Independent Agent", now: "2032-01-01T00:00:00.700Z"
  });
  const foreignAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:foreign-resource", subjectId: "subject:foreign-resource", host: "claude",
    profileId: "profile:foreign-resource", displayName: "Foreign Agent", groupId: "group:beta",
    tenantId: "tenant:beta", now: "2032-01-01T00:00:00.800Z"
  });
  const assignResourceGoal = ({ goalId, lead, groupId = "group:alpha", priority, resource, now }) => assignGoal({
    root, goalId, agentId: lead, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId, priority,
    successCriterion: `Synthetic resource goal ${goalId} passes.`,
    steps: [{ stepId: `step:${goalId.split(":").at(-1)}`, agentId: lead, resources: [resource],
      title: `Run ${goalId}.`, successCriterion: `The ${resource} fixture reports success.`, dependsOn: [] }],
    confirmation: "local-owner-confirmed", now
  });

  await assignResourceGoal({ goalId: "goal:resource-low", lead: agentId, priority: 20,
    resource: "resource:synthetic-ledger", now: "2032-01-01T00:00:01.000Z" });
  await assignResourceGoal({ goalId: "goal:resource-high", lead: highAgentId, priority: 90,
    resource: "resource:synthetic-ledger", now: "2032-01-01T00:00:01.100Z" });

  // Runtime priority is not trusted: invert it and prove policy priority still wins.
  let loaded = await loadGatewayRuntime(root);
  loaded.runtime.queue.find((item) => item.goalId === "goal:resource-low").priority = 100;
  loaded.runtime.queue.find((item) => item.goalId === "goal:resource-high").priority = 0;
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  const raced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:resource:${index}`, leaseSeconds: 15, executionMode: "read-only",
    now: "2032-01-01T00:00:02.000Z"
  })));
  assert.equal(raced.filter((claim) => claim.item).length, 1);
  const firstHigh = raced.find((claim) => claim.item);
  assert.equal(firstHigh.item.goalId, "goal:resource-high");
  const waiting = await gatewayContext({ root, agentId });
  assert.deepEqual(waiting.resourceWaits.map((item) => item.resources), [["resource:synthetic-ledger"]]);
  assert.deepEqual(waiting.resourceWaits[0].blockedByQueueIds, [firstHigh.item.queueId]);

  // Simulate a worker crash. Expiry releases the resource without duplicating either wake.
  await reconcileGateway({ root, now: "2032-01-01T00:00:17.000Z" });
  const reraced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimReadOnlyGatewayWork({
    root, workerId: `worker:resource:retry:${index}`, leaseSeconds: 15, now: "2032-01-01T00:00:18.000Z"
  })));
  assert.equal(reraced.filter((claim) => claim.item).length, 1);
  const high = reraced.find((claim) => claim.item);
  assert.equal(high.item.goalId, "goal:resource-high");

  await assignResourceGoal({ goalId: "goal:resource-independent", lead: independentAgentId, priority: 50,
    resource: "resource:synthetic-cache", now: "2032-01-01T00:00:19.000Z" });
  await assignResourceGoal({ goalId: "goal:resource-foreign", lead: foreignAgentId, groupId: "group:beta", priority: 80,
    resource: "resource:synthetic-ledger", now: "2032-01-01T00:00:20.000Z" });
  assert.deepEqual((await gatewayContext({ root, agentId: foreignAgentId })).resourceWaits, []);

  const foreign = await claimReadOnlyGatewayWork({ root, workerId: "worker:resource:foreign", now: "2032-01-01T00:00:21.000Z" });
  assert.equal(foreign.item.goalId, "goal:resource-foreign");
  const independent = await claimReadOnlyGatewayWork({ root, workerId: "worker:resource:independent", now: "2032-01-01T00:00:22.000Z" });
  assert.equal(independent.item.goalId, "goal:resource-independent");
  await completeGatewayRun({ root, queueId: high.item.queueId, workerId: high.item.lease.workerId, claimedAt: high.item.lease.claimedAt, attempt: high.item.attempts,
    result: { checkpoint: { high: true }, completed: true, readOnly: true }, now: "2032-01-01T00:00:23.000Z" });
  const low = await claimReadOnlyGatewayWork({ root, workerId: "worker:resource:low", now: "2032-01-01T00:00:24.000Z" });
  assert.equal(low.item.goalId, "goal:resource-low");

  for (const claim of [foreign, independent, low]) {
    await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
      result: { checkpoint: { completed: claim.item.goalId }, completed: true, readOnly: true }, now: "2032-01-01T00:00:25.000Z" });
  }
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals.filter((goal) => goal.status === "completed").length, 4);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  loaded.policy.goals.find((goal) => goal.goalId === "goal:resource-low").plan.steps[0].resources = ["resource:tampered"];
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});

