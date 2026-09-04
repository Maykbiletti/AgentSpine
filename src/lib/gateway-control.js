import { attentionFindings, loadAttention } from "./attention.js";
import { channelRuntimeFindings, loadChannelPolicy, loadChannelRuntime } from "./channel-runtime.js";
import { loadGraph } from "./graph.js";
import { expireGatewayLane } from "./gateway-host-lifecycle.js";
import * as goalPremortem from "./gateway-premortem.js";
import { resolveKnowledgeGapCandidate, sameKnowledgeGapResolution } from "./knowledge-evidence.js";
import { loadPersonaRuntime, personaRuntimeFindings } from "./persona-runtime.js";
import { assertActivePersona } from "./gateway-runtime-identity.js";
import { appendReceipt, preserve } from "./gateway-runtime-records.js";
import { writeGatewayStatePair } from "./gateway-state-transaction.js";
import {
  CONFIRMATION, PRIORITY, WAKE_KINDS, emptyPolicy, emptyRuntime, exactId,
  safeText, sha256, timestamp
} from "./gateway-common.js";
import { currentExecutionAttempt } from "./gateway-execution.js";
import {
  createGoalPlan, currentPlanStep, newGoalQueue, normalizePolicy, normalizeRuntime,
  pathsFor, planQueueKey, planStepAgentId, readJson, validGoal, withLock, writeJson
} from "./gateway-state.js";

export async function setGatewayControl({ root = process.cwd(), enabled, killSwitch, confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("gateway control changes require explicit local owner confirmation");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const policy = await readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy);
    const previous = { enabled: policy.enabled, killSwitch: policy.killSwitch };
    if (enabled !== undefined) policy.enabled = Boolean(enabled);
    if (killSwitch !== undefined) policy.killSwitch = Boolean(killSwitch);
    policy.revision += 1;
    policy.history.push({ kind: "control", at: timestamp(now), value: previous, authority: "authenticated-goal-policy" });
    await writeJson(paths.gatewayPolicyPath, policy);
    return { enabled: policy.enabled, killSwitch: policy.killSwitch, revision: policy.revision };
  });
}

export async function assignGoal({ root = process.cwd(), goalId, agentId, ownerSubjectId, projectId, groupId = null,
  priority = 70, successCriterion, nextSafeStep = null, steps = null, deadline = null, confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("goal assignment requires explicit local owner confirmation");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    goalId = exactId(goalId, "goalId"); agentId = exactId(agentId, "agentId");
    projectId = exactId(projectId, "projectId"); groupId = exactId(groupId, "groupId", true);
    const leadIdentity = assertActivePersona(personas.policy, personas.runtime, agentId, projectId, groupId);
    const createdAt = timestamp(now);
    const active = policy.goals.find((item) => item.agentId === agentId && item.status === "active" && item.goalId !== goalId);
    if (active) throw new Error("an agent may have only one active focused goal");
    const previous = policy.goals.find((item) => item.goalId === goalId);
    const premortemContractVersion = previous?.plan ? goalPremortem.goalPremortemContractVersion(policy, goalId) : 1;
    const plan = steps === null ? null : createGoalPlan(steps, createdAt, agentId, {
      goals: policy.goals, scope: { goalId, projectId, groupId, before: createdAt },
      premortemContractVersion
    });
    if (plan) {
      for (const stepAgentId of new Set(plan.steps.map((step) => step.agentId))) {
        const stepIdentity = assertActivePersona(personas.policy, personas.runtime, stepAgentId, projectId, groupId);
        if (stepIdentity.binding.tenantId !== leadIdentity.binding.tenantId) {
          throw new Error("goal-plan team members must share the authenticated tenant and exact project group");
        }
      }
    }
    const firstStep = plan ? plan.steps.find((step) => step.stepId === plan.currentStepId) : null;
    const goal = { goalId, agentId, ownerSubjectId: exactId(ownerSubjectId, "ownerSubjectId"),
      projectId, groupId, priority: Number(priority), successCriterion: safeText(successCriterion, "successCriterion"),
      nextSafeStep: safeText(firstStep?.title || nextSafeStep, "nextSafeStep"), deadline: deadline === null ? null : timestamp(deadline),
      status: "active", checkpoint: null, heartbeatAt: null, blocker: null,
      createdAt: previous?.createdAt || createdAt, updatedAt: createdAt,
      plan, authority: "authenticated-goal-policy" };
    if (!validGoal(goal, paths.catalog.root, plan ? premortemContractVersion : undefined)) throw new Error("goal assignment is invalid");
    if (previous && [previous.agentId, previous.ownerSubjectId, previous.projectId, previous.groupId].join("\0")
      !== [goal.agentId, goal.ownerSubjectId, goal.projectId, goal.groupId].join("\0")) throw new Error("goal scope is immutable");
    if (previous?.plan && previous.plan.definitionsDigest !== goal.plan?.definitionsDigest) {
      throw new Error("goal plan definitions are immutable; assign a new goal ID");
    }
    if (previous?.plan && previous.status === "blocked") {
      const blockedStep = currentPlanStep(previous);
      if (!blockedStep || blockedStep.status !== "blocked") throw new Error("blocked goal plan has no bound blocked step");
      if ((blockedStep.knowledgeGaps || []).some((gap) => gap.status === "open")) {
        throw new Error("blocked goal plan has an open knowledge gap; resolve it with goal-clarify");
      }
      if (blockedStep.execution?.explorationMaxAttempts !== undefined
        && currentExecutionAttempt(blockedStep.execution, blockedStep.executionOutcomes || []) === null) {
        throw new Error("bounded exploration is exhausted or stopped by a blocking defect; assign a new goal ID");
      }
      policy.history.push({ kind: "goal", at: createdAt, value: structuredClone(previous), authority: "authenticated-goal-policy" });
      blockedStep.status = "active"; blockedStep.blocker = null; blockedStep.updatedAt = createdAt;
      previous.status = "active"; previous.blocker = null; previous.updatedAt = createdAt; previous.plan.revision += 1;
      policy.revision += 1;
      const key = planQueueKey(previous.goalId, blockedStep.stepId, "owner-resume", String(previous.plan.revision));
      const queued = newGoalQueue(previous, blockedStep, "follow-up", key, createdAt);
      runtime.queue.push(queued); runtime.revision += 1;
      appendReceipt(runtime, "goal-step-resumed", queued.queueId, createdAt, { goalStepId: blockedStep.stepId });
      await writeGatewayStatePair(policy, runtime);
      return { goal: structuredClone(previous), gatewayPolicyPath: paths.gatewayPolicyPath, resumed: true };
    }
    if (previous?.plan) return { goal: structuredClone(previous), gatewayPolicyPath: paths.gatewayPolicyPath, duplicate: true };
    if (previous) {
      policy.history.push({ kind: "goal", at: createdAt, value: structuredClone(previous), authority: "authenticated-goal-policy" });
      goal.createdAt = previous.createdAt;
    }
    policy.goals = policy.goals.filter((item) => item.goalId !== goal.goalId);
    policy.goals.push(goal);
    if (plan) goalPremortem.registerGoalPremortemContract(policy, goal, premortemContractVersion, createdAt);
    policy.revision += 1;
    const key = firstStep ? planQueueKey(goal.goalId, firstStep.stepId, "assignment") : "goal:" + goal.goalId + ":assignment";
    if (!runtime.queue.some((item) => item.dedupeKey === key)) {
      runtime.queue.push(newGoalQueue(goal, firstStep, "assignment", key, createdAt));
      runtime.revision += 1;
      appendReceipt(runtime, "queued", "gateway-queue:" + sha256(key).slice(0, 32), createdAt, { kind: "assignment", dedupeKey: key });
    }
    await writeGatewayStatePair(policy, runtime);
    return { goal, gatewayPolicyPath: paths.gatewayPolicyPath };
  });
}

export async function resolveGoalKnowledgeGap({ root = process.cwd(), goalId, gapId, answer,
  answerSource = "owner-input", sourceDigest = null, confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("knowledge gap resolution requires explicit local owner confirmation");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    goalId = exactId(goalId, "goalId"); gapId = exactId(gapId, "gapId");
    const goal = policy.goals.find((item) => item.goalId === goalId);
    const step = goal && currentPlanStep(goal);
    if (!goal?.plan || !step) throw new Error("knowledge gap resolution requires the exact current goal-plan step");
    assertActivePersona(personas.policy, personas.runtime, goal.agentId, goal.projectId, goal.groupId);
    const gap = (step.knowledgeGaps || []).find((item) => item.gapId === gapId);
    if (!gap) throw new Error("knowledge gap is not bound to the current goal-plan step");
    if (gap.status === "resolved") {
      if (!sameKnowledgeGapResolution(gap, { answer, answerSource, sourceDigest })) {
        throw new Error("knowledge gap already has a different bound resolution");
      }
      return { goal: structuredClone(goal), gap: structuredClone(gap), duplicate: true };
    }
    if (goal.status !== "blocked" || step.status !== "blocked") {
      throw new Error("open knowledge gap resolution requires the exact blocked goal-plan step");
    }
    const resolvedAt = timestamp(now);
    const candidate = resolveKnowledgeGapCandidate(gap, { answer, answerSource, sourceDigest,
      resolvedAt, resolvedBySubjectId: goal.ownerSubjectId });
    policy.history.push({ kind: "goal", at: resolvedAt, value: structuredClone(goal), authority: "authenticated-goal-policy" });
    Object.assign(gap, candidate);
    step.status = "active"; step.blocker = null; step.updatedAt = resolvedAt;
    goal.status = "active"; goal.blocker = null; goal.updatedAt = resolvedAt; goal.nextSafeStep = step.title;
    goal.plan.revision += 1; policy.revision += 1;
    const key = planQueueKey(goal.goalId, step.stepId, "clarified", gap.resolutionDigest.slice(0, 20));
    let queued = runtime.queue.find((item) => item.dedupeKey === key);
    if (!queued) {
      queued = newGoalQueue(goal, step, "follow-up", key, resolvedAt);
      runtime.queue.push(queued); runtime.revision += 1;
      appendReceipt(runtime, "knowledge-gap-resolved", queued.queueId, resolvedAt, {
        goalStepId: step.stepId, gapId: gap.gapId, answerSource
      });
    }
    await writeGatewayStatePair(policy, runtime);
    return { goal: structuredClone(goal), gap: structuredClone(gap), queueId: queued.queueId, duplicate: false };
  });
}

export async function enqueueGatewayWake({ root = process.cwd(), kind, agentId, projectId, groupId = null, goalId = null,
  channelEventId = null, dedupeKey, availableAt = null, now = new Date() }) {
  if (!WAKE_KINDS.has(kind)) throw new Error("unsupported gateway wake kind");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway is disabled by local policy");
    agentId = exactId(agentId, "agentId"); projectId = exactId(projectId, "projectId"); groupId = exactId(groupId, "groupId", true);
    assertActivePersona(personas.policy, personas.runtime, agentId, projectId, groupId);
    goalId = exactId(goalId, "goalId", true); channelEventId = exactId(channelEventId, "channelEventId", true);
    const key = exactId(dedupeKey, "dedupeKey");
    const existing = runtime.queue.find((item) => item.dedupeKey === key);
    if (existing) return { item: existing, duplicate: true };
    const createdAt = timestamp(now);
    const item = { queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind, agentId, projectId, groupId,
      goalId, goalStepId: null, channelEventId, priority: PRIORITY[kind], status: "pending", attempts: 0, lease: null,
      availableAt: availableAt === null ? createdAt : timestamp(availableAt), createdAt, updatedAt: createdAt,
      completedAt: null, lastError: null, authority: "execution-state-only" };
    runtime.queue.push(item); runtime.revision += 1;
    appendReceipt(runtime, "queued", item.queueId, createdAt, { kind, dedupeKey: key });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item, duplicate: false };
  });
}

export async function reconcileGateway({ root = process.cwd(), now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channel, attention, personas, { graph }] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadAttention(paths.catalog.root, paths.catalog), loadPersonaRuntime(paths.catalog.root, paths.catalog),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    const current = timestamp(now);
    const findings = personaRuntimeFindings(personas.policy, personas.runtime, graph);
    if (findings.length) throw new Error("persona runtime is unhealthy: " + findings.join(", "));
    const channelFindings = channelRuntimeFindings(channel.runtime, channelPolicy.policy, graph);
    if (channelFindings.length) throw new Error("channel runtime is unhealthy: " + channelFindings.join(", "));
    const attentionIssues = attentionFindings(attention.attention);
    if (attentionIssues.length) throw new Error("attention runtime is unhealthy: " + attentionIssues.join(", "));
    let policyChanged = false;
    for (const lane of runtime.lanes.filter((item) => item.status === "leased" && new Date(item.expiresAt) <= new Date(current))) {
      policyChanged = expireGatewayLane(policy, runtime, lane, current,
        { preserve, appendReceipt }) || policyChanged;
    }
    for (const outbox of runtime.outbox.filter((item) => item.status === "sending")) {
      preserve(runtime, "outbox", outbox, "ambiguous-send-recovery", current);
      outbox.status = "delivery-unknown"; outbox.updatedAt = current;
      appendReceipt(runtime, "delivery-unknown", outbox.outboxId, current, { reason: "crash-during-send" });
    }
    if (policy.enabled && !policy.killSwitch) {
      for (const goal of policy.goals.filter((item) => item.status === "active" && item.plan)) {
        const step = currentPlanStep(goal);
        if (!step) throw new Error("active goal plan has no current step");
        try {
          assertActivePersona(personas.policy, personas.runtime, planStepAgentId(goal, step), goal.projectId, goal.groupId);
        } catch {
          policy.history.push({ kind: "goal", at: current, value: structuredClone(goal), authority: "authenticated-goal-policy" });
          const blocker = "Assigned team member is unavailable in this exact project group.";
          step.status = "blocked"; step.blocker = blocker; step.updatedAt = current;
          goal.status = "blocked"; goal.blocker = blocker; goal.updatedAt = current; goal.plan.revision += 1;
          for (const queued of runtime.queue.filter((item) => item.goalId === goal.goalId
            && item.goalStepId === step.stepId && ["pending", "leased"].includes(item.status))) {
            preserve(runtime, "queue", queued, "step-agent-unavailable", current);
            queued.status = "cancelled"; queued.lease = null; queued.completedAt = current; queued.updatedAt = current;
            for (const lane of runtime.lanes.filter((item) => item.queueId === queued.queueId && item.status === "leased")) {
              lane.status = "expired"; lane.updatedAt = current;
            }
            appendReceipt(runtime, "step-agent-unavailable", queued.queueId, current, { goalStepId: step.stepId });
          }
          policy.revision += 1; policyChanged = true;
          continue;
        }
        const runnable = runtime.queue.some((item) => item.goalId === goal.goalId && item.goalStepId === step.stepId
          && item.agentId === planStepAgentId(goal, step)
          && ["pending", "leased", "awaiting-delivery"].includes(item.status));
        if (!runnable) {
          const key = planQueueKey(goal.goalId, step.stepId, "recovery", String(goal.plan.revision));
          if (!runtime.queue.some((item) => item.dedupeKey === key)) {
            const queued = newGoalQueue(goal, step, "follow-up", key, current);
            runtime.queue.push(queued);
            appendReceipt(runtime, "queued", queued.queueId, current, { kind: "follow-up", goalStepId: step.stepId });
          }
        }
      }
      for (const goal of policy.goals.filter((item) => item.status === "active" && item.deadline
        && new Date(item.deadline) <= new Date(current))) {
        const step = currentPlanStep(goal);
        const deadlineAgentId = planStepAgentId(goal, step);
        try { assertActivePersona(personas.policy, personas.runtime, deadlineAgentId, goal.projectId, goal.groupId); }
        catch { continue; }
        const key = "goal:" + goal.goalId + ":deadline:" + goal.deadline;
        if (!runtime.queue.some((item) => item.dedupeKey === key)) runtime.queue.push({
          queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind: "deadline",
          agentId: deadlineAgentId, projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
          goalStepId: step?.stepId || null, channelEventId: null, priority: PRIORITY.deadline, status: "pending", attempts: 0, lease: null,
          availableAt: current, createdAt: current, updatedAt: current, completedAt: null, lastError: null,
          authority: "execution-state-only"
        });
      }
      for (const event of channel.runtime.events.filter((item) => item.status === "pending")) {
        if (!personas.runtime.personas.some((persona) => persona.personaId === event.agentId && persona.status === "active")) continue;
        const key = "channel:" + event.eventId;
        if (!runtime.queue.some((item) => item.dedupeKey === key)) runtime.queue.push({ queueId: "gateway-queue:" + sha256(key).slice(0, 32),
          dedupeKey: key, kind: "direct-message", agentId: event.agentId, projectId: event.projectId, groupId: event.groupId,
          goalId: null, goalStepId: null, channelEventId: event.eventId, priority: PRIORITY["direct-message"], status: "pending", attempts: 0,
          lease: null, availableAt: current, createdAt: current, updatedAt: current, completedAt: null, lastError: null, authority: "execution-state-only" });
      }
      for (const event of attention.attention.events.filter((item) => item.entityId
        && ((item.kind === "promise" && item.status === "open") || (item.kind === "blocker" && item.status === "resolved")))) {
        try { assertActivePersona(personas.policy, personas.runtime, event.entityId, event.projectId, event.groupId); }
        catch { continue; }
        const kind = event.kind === "promise" ? "promise" : "resolved-blocker";
        const key = "attention:" + event.id + ":" + event.status;
        if (!runtime.queue.some((entry) => entry.dedupeKey === key)) runtime.queue.push({ queueId: "gateway-queue:" + sha256(key).slice(0, 32),
          dedupeKey: key, kind, agentId: event.entityId, projectId: event.projectId, groupId: event.groupId,
          goalId: null, goalStepId: null, channelEventId: null, priority: PRIORITY[kind], status: "pending", attempts: 0, lease: null,
          availableAt: event.dueAt || current, createdAt: current, updatedAt: current, completedAt: null, lastError: null, authority: "execution-state-only" });
      }
    }
    runtime.health.gateway = policy.enabled && !policy.killSwitch ? "running" : "stopped";
    runtime.health.scheduler = "healthy"; runtime.health.queue = "healthy"; runtime.health.lastReconciledAt = current;
    runtime.revision += 1;
    if (policyChanged) await writeGatewayStatePair(policy, runtime);
    else await writeJson(paths.gatewayRuntimePath, runtime);
    return { policy, runtime, recovered: true };
  });
}

