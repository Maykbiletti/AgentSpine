import { loadChannelPolicy, loadChannelRuntime } from "./channel-runtime.js";
import {
  assertGatewayCompletionMode, exactGatewayLeaseGeneration, failGatewayLane,
  markHostStarted, newGatewayLease, normalizeGatewayExecutionMode,
  requireExactGatewayLease, requireExactHostLease
} from "./gateway-host-lifecycle.js";
import { handlePlanKnowledge } from "./gateway-knowledge.js";
import { assertActivePersona, currentLane, exactReplyBinding } from "./gateway-runtime-identity.js";
import { appendReceipt, preserve } from "./gateway-runtime-records.js";
import * as goalPremortem from "./gateway-premortem.js";
import { writeGatewayStatePair } from "./gateway-state-transaction.js";
import { loadPersonaRuntime } from "./persona-runtime.js";
import { evaluateVoiceOutput } from "./voice-runtime.js";
import {
  PRIORITY, emptyPolicy, emptyRuntime, exactId, safeCheckpoint, safeText,
  sha256, timestamp
} from "./gateway-common.js";
import { reviewExecutionResult } from "./gateway-execution.js";
import {
  activateNextPlanStep, conflictingResources, currentPlanStep, effectiveQueuePriority,
  newGoalQueue, normalizePolicy, normalizeRuntime, pathsFor, planQueueKey,
  planStepAgentId, readJson, withLock, writeJson
} from "./gateway-state.js";

export async function claimGatewayWork({ root = process.cwd(), workerId, leaseSeconds = 120,
  executionMode = "host-effect", now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) return { item: null, reason: "disabled" };
    const current = timestamp(now); workerId = exactId(workerId, "workerId");
    executionMode = normalizeGatewayExecutionMode(executionMode);
    const seconds = Number(leaseSeconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 900) throw new Error("leaseSeconds must be 15-900");
    const items = runtime.queue.filter((item) => item.status === "pending" && new Date(item.availableAt) <= new Date(current)
      && !currentLane(runtime, item.agentId));
    items.sort((a, b) => effectiveQueuePriority(policy, b) - effectiveQueuePriority(policy, a)
      || a.createdAt.localeCompare(b.createdAt) || a.queueId.localeCompare(b.queueId));
    let item = null; let revoked = false;
    for (const candidate of items) {
      try {
        assertActivePersona(personas.policy, personas.runtime, candidate.agentId, candidate.projectId, candidate.groupId);
      } catch {
        preserve(runtime, "queue", candidate, "identity-revoked", current);
        candidate.status = "cancelled"; candidate.completedAt = current; candidate.updatedAt = current;
        appendReceipt(runtime, "identity-revoked", candidate.queueId, current, {});
        runtime.revision += 1; revoked = true;
        continue;
      }
      if (candidate.goalStepId) {
        const goal = policy.goals.find((entry) => entry.goalId === candidate.goalId);
        const step = goal && currentPlanStep(goal);
        if (!goal?.plan || goal.status !== "active" || step?.stepId !== candidate.goalStepId || step.status !== "active"
          || candidate.agentId !== planStepAgentId(goal, step)) {
          preserve(runtime, "queue", candidate, "plan-step-stale", current);
          candidate.status = "cancelled"; candidate.completedAt = current; candidate.updatedAt = current;
          appendReceipt(runtime, "plan-step-stale", candidate.queueId, current, { goalStepId: candidate.goalStepId });
          runtime.revision += 1; revoked = true;
          continue;
        }
      }
      const resourceConflict = runtime.queue.some((leased) => leased.status === "leased"
        && leased.queueId !== candidate.queueId && conflictingResources(policy, candidate, leased).length > 0);
      if (resourceConflict) continue;
      item = candidate;
      break;
    }
    if (!item && revoked) await writeJson(paths.gatewayRuntimePath, runtime);
    if (!item) return { item: null, reason: runtime.queue.some((entry) => entry.status === "pending") ? "waiting" : "idle/needs-goal" };
    preserve(runtime, "queue", item, "leased", current);
    item.status = "leased"; item.attempts += 1; item.updatedAt = current;
    item.lease = newGatewayLease(workerId, current, seconds, executionMode);
    runtime.lanes = runtime.lanes.filter((lane) => lane.agentId !== item.agentId || lane.status !== "leased");
    runtime.lanes.push({ agentId: item.agentId, queueId: item.queueId, workerId, status: "leased", claimedAt: current,
      expiresAt: item.lease.expiresAt, updatedAt: current, authority: "execution-state-only" });
    runtime.health.worker = "healthy"; runtime.health.lastTickAt = current; runtime.revision += 1;
    const receipt = appendReceipt(runtime, "leased", item.queueId, current,
      { workerId, attempt: item.attempts, executionMode });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item: structuredClone(item), receipt };
  });
}

export async function markGatewayHostStarted({ root = process.cwd(), queueId, workerId, claimedAt, attempt,
  now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway was disabled before host execution");
    const item = runtime.queue.find((entry) => entry.queueId === exactId(queueId, "queueId"));
    workerId = exactId(workerId, "workerId"); claimedAt = exactGatewayLeaseGeneration(claimedAt, attempt, "host start");
    const current = timestamp(now);
    const lane = requireExactHostLease(runtime, item, { workerId, claimedAt, attempt, current });
    const receipt = markHostStarted(runtime, item, lane, workerId, current, { preserve, appendReceipt });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item: structuredClone(item), receipt };
  });
}

export async function completeGatewayRun({ root = process.cwd(), queueId, workerId, claimedAt, attempt,
  result, now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channelRuntime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway was disabled before run completion");
    const item = runtime.queue.find((entry) => entry.queueId === exactId(queueId, "queueId"));
    workerId = exactId(workerId, "workerId");
    claimedAt = exactGatewayLeaseGeneration(claimedAt, attempt, "run completion"); const current = timestamp(now);
    const lane = requireExactGatewayLease(runtime, item,
      { workerId, claimedAt, attempt, current, action: "run completion" });
    const markedHostRun = assertGatewayCompletionMode(item.lease, result);
    const runIdentity = assertActivePersona(personas.policy, personas.runtime, item.agentId, item.projectId, item.groupId);
    const boundGoal = item.goalId ? policy.goals.find((entry) => entry.goalId === item.goalId) : null;
    const boundStep = item.goalStepId ? boundGoal && currentPlanStep(boundGoal) : null;
    if (item.goalStepId) {
      if (!boundGoal?.plan || boundGoal.status !== "active" || boundStep?.stepId !== item.goalStepId
        || boundStep.status !== "active" || item.agentId !== planStepAgentId(boundGoal, boundStep)) {
        throw new Error("run completion is not bound to the current active goal step");
      }
    }
    const knowledgeGapRequest = result?.knowledgeGap === undefined || result?.knowledgeGap === null
      ? null : result.knowledgeGap;
    const selfHelpRequest = result?.selfHelp === undefined || result?.selfHelp === null ? null : result.selfHelp;
    if (knowledgeGapRequest && (item.channelEventId || !item.goalStepId || !boundGoal?.plan)) {
      throw new Error("knowledge gaps require an exact goal-plan step without a channel obligation");
    }
    if (selfHelpRequest && (item.channelEventId || !item.goalStepId || !boundGoal?.plan)) {
      throw new Error("self-help research requires an exact goal-plan step without a channel obligation");
    }
    if (knowledgeGapRequest && (result?.blocked || result?.completed)) {
      throw new Error("knowledge gap result cannot also complete or generically block a step");
    }
    if (selfHelpRequest && (knowledgeGapRequest || result?.blocked || result?.completed)) {
      throw new Error("self-help research cannot also complete, block, or open a knowledge gap");
    }
    const resultCheckpoint = boundGoal && result?.checkpoint !== undefined ? safeCheckpoint(result.checkpoint) : boundGoal?.checkpoint ?? null;
    const premortemReview = boundStep?.premortemContractVersion === 1 && result?.completed
      ? await goalPremortem.reviewGoalPremortem({ root: paths.catalog.root, goal: boundGoal, step: boundStep,
        item, checkpoint: resultCheckpoint, completedAt: current, host: runIdentity.binding.host, readOnly: result?.readOnly === true }) : null;
    let executionReview = boundStep?.execution && result?.completed
      ? reviewExecutionResult(boundStep.execution, boundStep.executionOutcomes || [],
        item.queueId, result.execution, current) : null;
    if (executionReview && (boundStep.executionOutcomes || []).length >= 8) {
      executionReview = { passed: false, outcome: null, reason: "Execution outcome history is full." };
    }
    const text = result?.text ? safeText(result.text, "result.text", 16000) : null;
    let clarification = null; let exploration = null; let selfHelp = null; let selfHelpRequired = null;
    preserve(runtime, "queue", item, "run-completed", current);
    if (item.channelEventId) {
      if (!text) throw new Error("a channel obligation requires a non-empty response");
      const voice = evaluateVoiceOutput(text);
      if (!voice.ok) throw new Error("channel response contains a prohibited attachment or consciousness claim");
      const event = channelRuntime.runtime.events.find((entry) => entry.eventId === item.channelEventId);
      if (!event) throw new Error("channel event disappeared before delivery preparation");
      const binding = exactReplyBinding(channelPolicy.policy, event);
      const idempotencyKey = "delivery:" + sha256([event.eventId, binding.id, event.chatId, event.threadId || "", event.replyTo || ""].join("\0")).slice(0, 32);
      let outbox = runtime.outbox.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (!outbox) {
        outbox = { outboxId: "gateway-outbox:" + sha256(idempotencyKey).slice(0, 32), queueId: item.queueId,
          idempotencyKey, bindingId: binding.id, eventId: event.eventId, provider: event.provider, tenantId: event.tenantId,
          accountId: event.accountId, chatId: event.chatId, threadId: event.threadId, replyTo: event.replyTo,
          text, status: "prepared", attempts: 0, nextAttemptAt: current, createdAt: current, updatedAt: current,
          deliveredAt: null, adapterReceipt: null, lastError: null, authority: "delivery-state-only" };
        runtime.outbox.push(outbox);
      }
      item.status = "awaiting-delivery";
    } else {
      item.status = result?.blocked || knowledgeGapRequest || premortemReview?.blocked || (executionReview && !executionReview.passed)
        ? "blocked" : "completed"; item.completedAt = current;
      const goal = boundGoal;
      if (goal) {
        policy.history.push({ kind: "goal", at: current, value: structuredClone(goal), authority: "authenticated-goal-policy" });
        const checkpoint = resultCheckpoint;
        goal.checkpoint = checkpoint; goal.heartbeatAt = current;
        goal.blocker = result?.blocked ? safeText(result.blocker || "Run blocked.", "blocker", 500)
          : premortemReview?.blocked ? premortemReview.reason : executionReview && !executionReview.passed ? executionReview.reason : null;
        if (goal.plan && item.goalStepId) {
          const step = currentPlanStep(goal);
          step.checkpoint = checkpoint; step.updatedAt = current;
          const knowledge = handlePlanKnowledge({ goal, step, item, runtime, current,
            selfHelpRequest, knowledgeGapRequest, appendReceipt, newGoalQueue, planQueueKey });
          if (knowledge) ({ clarification = null, selfHelp = null, selfHelpRequired = null } = knowledge);
          else if (result?.blocked || premortemReview?.blocked) {
            step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
          } else if (executionReview && !executionReview.passed) {
            if (executionReview.outcome) step.executionOutcomes.push(executionReview.outcome);
            if (executionReview.outcome && executionReview.nextAttempt) {
              item.status = "completed"; step.status = "active"; step.blocker = null;
              goal.status = "active"; goal.blocker = null; goal.nextSafeStep = step.title;
              goal.plan.revision += 1;
              const key = planQueueKey(goal.goalId, step.stepId, "explore",
                executionReview.outcome.digest.slice(0, 20));
              let queued = runtime.queue.find((entry) => entry.dedupeKey === key);
              if (!queued) {
                queued = newGoalQueue(goal, step, "follow-up", key, current);
                runtime.queue.push(queued);
              }
              exploration = { queueId: queued.queueId, ...executionReview.nextAttempt };
              appendReceipt(runtime, "execution-exploration-continued", queued.queueId, current, {
                goalStepId: step.stepId, failedOutcomeId: executionReview.outcome.outcomeId,
                attempt: executionReview.nextAttempt.attempt,
                strategyId: executionReview.nextAttempt.strategyId
              });
            } else {
              step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
              appendReceipt(runtime, executionReview.outcome ? "execution-gate-failed" : "execution-proof-invalid",
                item.queueId, current, { goalStepId: step.stepId,
                  outcomeId: executionReview.outcome?.outcomeId || null });
            }
          } else if (result?.completed) {
            if (premortemReview?.attachments) Object.assign(step, premortemReview.attachments);
            if (executionReview?.outcome) {
              step.executionOutcomes.push(executionReview.outcome);
              appendReceipt(runtime, "execution-gate-passed", item.queueId, current, {
                goalStepId: step.stepId, outcomeId: executionReview.outcome.outcomeId
              });
            }
            step.status = "completed"; step.completedAt = current; step.completedByQueueId = item.queueId; step.blocker = null;
            goal.plan.currentStepId = null; goal.plan.revision += 1;
            const next = activateNextPlanStep(goal.plan, current);
            if (next) {
              goal.status = "active"; goal.nextSafeStep = next.title; goal.blocker = null;
              const key = planQueueKey(goal.goalId, next.stepId, "ready", String(goal.plan.revision));
              if (!runtime.queue.some((entry) => entry.dedupeKey === key)) {
                const queued = newGoalQueue(goal, next, "follow-up", key, current);
                runtime.queue.push(queued);
                appendReceipt(runtime, "goal-step-ready", queued.queueId, current, { goalStepId: next.stepId });
              }
            } else {
              goal.status = "completed";
            }
          } else {
            goal.status = "active"; step.blocker = null;
          }
        } else if (!goal.plan) {
          goal.status = result?.completed ? "completed" : result?.blocked ? "blocked" : "active";
        }
        goal.updatedAt = current;
        policy.revision += 1;
        if (goal.status === "active" && (!goal.plan || !result?.completed) && !selfHelp && !selfHelpRequired) {
          const checkpointDigest = sha256(JSON.stringify(goal.checkpoint || { heartbeatAt: current })).slice(0, 20);
          const step = currentPlanStep(goal);
          const key = step ? planQueueKey(goal.goalId, step.stepId, "follow-up", checkpointDigest)
            : "goal:" + goal.goalId + ":follow-up:" + checkpointDigest;
          if (!runtime.queue.some((entry) => entry.dedupeKey === key)) runtime.queue.push({
            queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind: "follow-up",
            agentId: planStepAgentId(goal, step), projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
            goalStepId: step?.stepId || null, channelEventId: null, priority: goal.priority, status: "pending", attempts: 0, lease: null,
            availableAt: new Date(new Date(current).getTime() + 60000).toISOString(), createdAt: current, updatedAt: current,
            completedAt: null, lastError: null, authority: "execution-state-only"
          });
        }
      }
    }
    item.lease = null; item.updatedAt = current; lane.status = "completed"; lane.updatedAt = current;
    if (markedHostRun) runtime.health.host = "healthy";
    runtime.health.worker = "healthy"; runtime.health.lastTickAt = current;
    appendReceipt(runtime, "run-terminal", item.queueId, current, { status: item.status, goalStepId: item.goalStepId || null }); runtime.revision += 1;
    await writeGatewayStatePair(policy, runtime);
    return { item, outbox: runtime.outbox.find((entry) => entry.queueId === item.queueId) || null,
      clarification, exploration, selfHelp, selfHelpRequired, executionReview, premortemReview };
  });
}

export async function failGatewayRun({ root = process.cwd(), queueId, workerId, claimedAt, attempt, error, retryAfterMs = 5000,
  now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
    ]);
    const item = runtime.queue.find((entry) => entry.queueId === exactId(queueId, "queueId"));
    workerId = exactId(workerId, "workerId"); claimedAt = exactGatewayLeaseGeneration(claimedAt, attempt, "run failure");
    const current = timestamp(now);
    const lane = requireExactGatewayLease(runtime, item,
      { workerId, claimedAt, attempt, current, action: "run failure" });
    const message = safeText(String(error || "host runtime unavailable"), "runError", 500);
    const delay = Number(retryAfterMs);
    if (!Number.isFinite(delay) || delay < 250 || delay > 300000) throw new Error("retryAfterMs must be 250-300000");
    const failure = failGatewayLane(policy, runtime, item, lane, current,
      { error: message, retryAfterMs: delay, preserve, appendReceipt });
    if (failure.ambiguous) await writeGatewayStatePair(policy, runtime);
    else await writeJson(paths.gatewayRuntimePath, runtime);
    return { item, receipt: failure.receipt, policyEnabled: policy.enabled && !policy.killSwitch };
  });
}

