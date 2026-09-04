import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { matchesGatewayLaneLease, validGatewayLeaseExecution } from "./gateway-host-lifecycle.js";
import * as goalPremortem from "./gateway-premortem.js";
import {
  readGatewayStateJson, withGatewayStateLock, writeGatewayStateJson
} from "./gateway-state-transaction.js";
import { validStepKnowledgeState } from "./knowledge-evidence.js";
import { projectStateDir } from "./paths.js";
import {
  GATEWAY_POLICY_SCHEMA, GATEWAY_RUNTIME_SCHEMA, GOAL_PLAN_SCHEMA, GOAL_STATUSES,
  HEALTH_VALUES, ID_RE, OUTBOX_STATUSES, PLAN_STEP_STATUSES, QUEUE_STATUSES,
  ROUTE_RE, SECRET_RE, WAKE_KINDS, emptyPolicy, emptyRuntime, exactId,
  safeCheckpoint, safeText, sha256
} from "./gateway-common.js";
import {
  createExecutionDecision, validExecutionDecision, validExecutionOutcomeSequence,
  validGoalTransferProofs
} from "./gateway-execution.js";

export function validGoalPlan(plan, goal = null, root = null, premortemContractVersion = undefined) {
  if (!(plan && plan.schema === GOAL_PLAN_SCHEMA && plan.authority === "context-only-plan"
    && Number.isInteger(plan.revision) && plan.revision >= 0 && Array.isArray(plan.steps)
    && plan.steps.length > 0 && plan.steps.length <= 32 && /^[a-f0-9]{64}$/.test(plan.definitionsDigest || "")
    && (plan.currentStepId === null || ID_RE.test(plan.currentStepId || ""))
    && goalPremortem.validPlanPremortemContract(plan, premortemContractVersion))) return false;
  const ids = new Set(plan.steps.map((step) => step?.stepId));
  if (ids.size !== plan.steps.length || ids.has(undefined)) return false;
  for (const step of plan.steps) {
    if (!(ID_RE.test(step.stepId || "") && typeof step.title === "string" && step.title.length > 0 && step.title.length <= 500
      && (step.agentId === undefined || ID_RE.test(step.agentId || ""))
      && (step.resources === undefined || (Array.isArray(step.resources) && step.resources.length <= 16
        && new Set(step.resources).size === step.resources.length && step.resources.every((resource) => ID_RE.test(resource || ""))))
      && (step.execution === undefined || step.execution === null || validExecutionDecision(step.execution))
      && (step.executionOutcomes === undefined || (Array.isArray(step.executionOutcomes) && step.executionOutcomes.length <= 8
        && new Set(step.executionOutcomes.map((outcome) => outcome.outcomeId)).size === step.executionOutcomes.length
        && (step.executionOutcomes.length === 0 || (step.execution
          && validExecutionOutcomeSequence(step.execution, step.executionOutcomes)))))
      && typeof step.successCriterion === "string" && step.successCriterion.length > 0 && step.successCriterion.length <= 1000
      && Array.isArray(step.dependsOn) && new Set(step.dependsOn).size === step.dependsOn.length
      && step.dependsOn.every((dependency) => ids.has(dependency) && dependency !== step.stepId)
      && PLAN_STEP_STATUSES.has(step.status)
      && (step.checkpoint === null || (() => { try { safeCheckpoint(step.checkpoint); return true; } catch { return false; } })())
      && (step.blocker === null || (typeof step.blocker === "string" && step.blocker.length <= 500 && !SECRET_RE.test(step.blocker)))
      && (step.completedAt === null || Number.isFinite(new Date(step.completedAt).getTime()))
      && (step.completedByQueueId === null || ID_RE.test(step.completedByQueueId || ""))
      && goalPremortem.validGoalPremortemAttachments(step, goal, root, plan.definitionsDigest)
      && validStepKnowledgeState(step, plan.definitionsDigest)
      && Number.isFinite(new Date(step.updatedAt).getTime())
      && (step.executionOutcomes || []).every((outcome) => new Date(outcome.observedAt) <= new Date(step.updatedAt)))) return false;
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (stepId) => {
    if (visiting.has(stepId)) return false;
    if (visited.has(stepId)) return true;
    visiting.add(stepId);
    const step = plan.steps.find((entry) => entry.stepId === stepId);
    if (!step.dependsOn.every(visit)) return false;
    visiting.delete(stepId); visited.add(stepId); return true;
  };
  if (!plan.steps.every((step) => visit(step.stepId))) return false;
  const completed = new Set(plan.steps.filter((step) => step.status === "completed").map((step) => step.stepId));
  if (plan.steps.some((step) => ["completed", "active", "blocked"].includes(step.status)
    && !step.dependsOn.every((dependency) => completed.has(dependency)))) return false;
  if (plan.steps.some((step) => (step.status === "completed") !== (step.completedAt !== null && step.completedByQueueId !== null))) return false;
  if (plan.steps.some((step) => (step.status === "blocked") !== (step.blocker !== null))) return false;
  if (plan.steps.some((step) => (step.knowledgeGaps || []).filter((gap) => gap.status === "open").length > 1)) return false;
  if (plan.steps.some((step) => (step.knowledgeGaps || []).some((gap) => gap.status === "open")
    && step.status !== "blocked")) return false;
  if (plan.steps.some((step) => step.execution && step.status === "completed"
    && !(step.executionOutcomes || []).some((outcome) => outcome.passed))) return false;
  if (plan.definitionsDigest !== sha256(JSON.stringify(goalPremortem.planDefinitionMaterial(plan.steps)))) return false;
  const current = plan.steps.filter((step) => ["active", "blocked"].includes(step.status));
  return current.length <= 1 && (plan.currentStepId === null
    ? current.length === 0 : current.length === 1 && current[0].stepId === plan.currentStepId);
}
export function activateNextPlanStep(plan, now) {
  const completed = new Set(plan.steps.filter((step) => step.status === "completed").map((step) => step.stepId));
  const next = plan.steps.find((step) => step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency)));
  if (!next) { plan.currentStepId = null; return null; }
  next.status = "active"; next.updatedAt = now; plan.currentStepId = next.stepId; plan.revision += 1;
  return next;
}
export function createGoalPlan(steps, now, defaultAgentId, transferContext) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 32) throw new Error("goal plan requires 1-32 steps");
  const normalized = steps.map((step, index) => ({
    stepId: exactId(step?.stepId ?? step?.id, `steps[${index}].stepId`),
    agentId: exactId(step?.agentId ?? defaultAgentId, `steps[${index}].agentId`),
    resources: Array.isArray(step?.resources)
      ? step.resources.map((resource) => exactId(resource, `steps[${index}].resources`)) : [],
    execution: createExecutionDecision(step?.execution, `steps[${index}].execution`, transferContext),
    ...(transferContext.premortemContractVersion === 1 ? { premortemContractVersion: 1 } : {}),
    title: safeText(step?.title, `steps[${index}].title`, 500),
    successCriterion: safeText(step?.successCriterion, `steps[${index}].successCriterion`),
    dependsOn: Array.isArray(step?.dependsOn) ? step.dependsOn.map((dependency) => exactId(dependency, `steps[${index}].dependsOn`)) : [],
    status: "pending", checkpoint: null, blocker: null, completedAt: null, completedByQueueId: null,
    knowledgeGaps: [], selfHelpReports: [], selfHelpRequirements: [], executionOutcomes: [], updatedAt: now
  }));
  const plan = { schema: GOAL_PLAN_SCHEMA, ...(transferContext.premortemContractVersion === 1
    ? { premortemContractVersion: 1, premortemContract: goalPremortem.GOAL_PREMORTEM_CONTRACT } : {}),
    revision: 0, currentStepId: null, steps: normalized,
    definitionsDigest: sha256(JSON.stringify(goalPremortem.planDefinitionMaterial(normalized))), authority: "context-only-plan" };
  if (!validGoalPlan(plan, null, null, transferContext.premortemContractVersion)) throw new Error("goal plan must be an acyclic dependency graph with exact unique step IDs");
  activateNextPlanStep(plan, now);
  return plan;
}
export function currentPlanStep(goal) {
  return goal.plan?.steps.find((step) => step.stepId === goal.plan.currentStepId) || null;
}
export function planStepAgentId(goal, step) {
  return step?.agentId ?? goal.agentId;
}
export function planStepResources(step) {
  return Array.isArray(step?.resources) ? step.resources : [];
}
export function queuePlanStep(policy, item) {
  if (!item.goalStepId) return null;
  return policy.goals.find((goal) => goal.goalId === item.goalId)?.plan?.steps
    .find((step) => step.stepId === item.goalStepId) || null;
}
export function conflictingResources(policy, candidate, leased) {
  const wanted = new Set(planStepResources(queuePlanStep(policy, candidate)));
  if (!wanted.size || candidate.projectId !== leased.projectId || candidate.groupId !== leased.groupId) return [];
  return planStepResources(queuePlanStep(policy, leased)).filter((resource) => wanted.has(resource));
}
export function effectiveQueuePriority(policy, item) {
  if (!item.goalId) return item.priority;
  return policy.goals.find((goal) => goal.goalId === item.goalId)?.priority ?? item.priority;
}
export function planQueueKey(goalId, stepId, phase, suffix = "") {
  return ["goal", goalId, "step", stepId, phase, suffix].filter(Boolean).join(":");
}

export function newGoalQueue(goal, step, kind, key, current, availableAt = current) {
  return { queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind,
    agentId: planStepAgentId(goal, step), projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
    goalStepId: step?.stepId || null, channelEventId: null, priority: goal.priority, status: "pending",
    attempts: 0, lease: null, availableAt, createdAt: current, updatedAt: current,
    completedAt: null, lastError: null, authority: "execution-state-only" };
}

export function validGoal(goal, root = null, premortemContractVersion = undefined) {
  return goal && ID_RE.test(goal.goalId || "") && ID_RE.test(goal.agentId || "")
    && ID_RE.test(goal.ownerSubjectId || "") && ID_RE.test(goal.projectId || "")
    && (goal.groupId === null || ID_RE.test(goal.groupId || "")) && GOAL_STATUSES.has(goal.status)
    && typeof goal.successCriterion === "string" && goal.successCriterion.length > 0
    && typeof goal.nextSafeStep === "string" && goal.nextSafeStep.length > 0
    && (goal.deadline === null || Number.isFinite(new Date(goal.deadline).getTime()))
    && Number.isInteger(goal.priority) && goal.priority >= 0 && goal.priority <= 100
    && (goal.checkpoint === null || (() => { try { safeCheckpoint(goal.checkpoint); return true; } catch { return false; } })())
    && (goal.blocker === null || (typeof goal.blocker === "string" && goal.blocker.length <= 500 && !SECRET_RE.test(goal.blocker)))
    && (goal.heartbeatAt === null || Number.isFinite(new Date(goal.heartbeatAt).getTime()))
    && goal.authority === "authenticated-goal-policy" && Number.isFinite(new Date(goal.createdAt).getTime())
    && Number.isFinite(new Date(goal.updatedAt).getTime())
    && (goal.plan === undefined || goal.plan === null
      || (validGoalPlan(goal.plan, goal, root, premortemContractVersion)
      && goal.plan.steps.every((step) => ["knowledgeGaps", "selfHelpReports", "selfHelpRequirements"]
        .every((field) => (step[field] || []).every((entry) => entry.goalId === goal.goalId)))
      && (goal.status !== "active" || (currentPlanStep(goal)?.status === "active" && goal.nextSafeStep === currentPlanStep(goal).title))
      && (goal.status !== "blocked" || currentPlanStep(goal)?.status === "blocked")
      && (goal.status !== "completed" || goal.plan.steps.every((step) => step.status === "completed"))));
}

export function validPolicyHistory(item, root = null) {
  if (!item || item.authority !== "authenticated-goal-policy" || !Number.isFinite(new Date(item.at).getTime())) return false;
  if (item.kind === "goal") return validGoal(item.value, root);
  return item.kind === "control" && item.value && typeof item.value.enabled === "boolean" && typeof item.value.killSwitch === "boolean";
}

export function validQueue(item) {
  return item && ID_RE.test(item.queueId || "") && WAKE_KINDS.has(item.kind)
    && ID_RE.test(item.dedupeKey || "") && item.queueId === "gateway-queue:" + sha256(item.dedupeKey).slice(0, 32)
    && ID_RE.test(item.agentId || "") && ID_RE.test(item.projectId || "")
    && (item.groupId === null || ID_RE.test(item.groupId || ""))
    && (item.goalId === null || ID_RE.test(item.goalId || ""))
    && (item.goalStepId === undefined || item.goalStepId === null || (item.goalId !== null && ID_RE.test(item.goalStepId || "")))
    && (item.channelEventId === null || ID_RE.test(item.channelEventId || ""))
    && QUEUE_STATUSES.has(item.status) && Number.isInteger(item.priority) && item.priority >= 0 && item.priority <= 100
    && Number.isInteger(item.attempts) && item.attempts >= 0 && item.attempts <= 20
    && item.authority === "execution-state-only" && Number.isFinite(new Date(item.createdAt).getTime())
    && Number.isFinite(new Date(item.availableAt).getTime()) && Number.isFinite(new Date(item.updatedAt).getTime())
    && (item.completedAt === null || Number.isFinite(new Date(item.completedAt).getTime()))
    && (item.lastError === null || (typeof item.lastError === "string" && item.lastError.length <= 500 && !SECRET_RE.test(item.lastError)))
    && (item.lease === null || (item.status === "leased" && ID_RE.test(item.lease.workerId || "")
      && Number.isFinite(new Date(item.lease.claimedAt).getTime())
      && Number.isFinite(new Date(item.lease.expiresAt).getTime())
      && validGatewayLeaseExecution(item.lease)));
}

export function validOutbox(item) {
  return item && ID_RE.test(item.outboxId || "") && ID_RE.test(item.queueId || "")
    && ID_RE.test(item.idempotencyKey || "") && ID_RE.test(item.bindingId || "")
    && item.outboxId === "gateway-outbox:" + sha256(item.idempotencyKey).slice(0, 32)
    && ID_RE.test(item.eventId || "") && ROUTE_RE.test(item.provider || "") && ROUTE_RE.test(item.tenantId || "")
    && ROUTE_RE.test(item.accountId || "") && ROUTE_RE.test(item.chatId || "")
    && (item.threadId === null || ROUTE_RE.test(item.threadId || "")) && (item.replyTo === null || ROUTE_RE.test(item.replyTo || ""))
    && OUTBOX_STATUSES.has(item.status)
    && typeof item.text === "string" && item.text.length > 0 && item.text.length <= 16000 && !SECRET_RE.test(item.text)
    && Number.isInteger(item.attempts) && item.attempts >= 0 && item.attempts <= 20
    && item.authority === "delivery-state-only" && Number.isFinite(new Date(item.createdAt).getTime())
    && Number.isFinite(new Date(item.updatedAt).getTime()) && Number.isFinite(new Date(item.nextAttemptAt).getTime())
    && (item.deliveredAt === null || Number.isFinite(new Date(item.deliveredAt).getTime()))
    && (item.adapterReceipt === null || (typeof item.adapterReceipt === "string" && item.adapterReceipt.length <= 500))
    && (item.lastError === null || (typeof item.lastError === "string" && item.lastError.length <= 500 && !SECRET_RE.test(item.lastError)));
}

export function validLane(item) {
  return item && ID_RE.test(item.agentId || "") && ID_RE.test(item.queueId || "") && ID_RE.test(item.workerId || "")
    && new Set(["leased", "completed", "expired"]).has(item.status)
    && Number.isFinite(new Date(item.claimedAt).getTime()) && Number.isFinite(new Date(item.expiresAt).getTime())
    && Number.isFinite(new Date(item.updatedAt).getTime()) && item.authority === "execution-state-only";
}

export function validReceipt(item) {
  if (!(item && ID_RE.test(item.id || "") && ID_RE.test(item.kind || "") && ID_RE.test(item.objectId || "")
    && Number.isFinite(new Date(item.at).getTime()) && item.details && typeof item.details === "object"
    && !Array.isArray(item.details) && !SECRET_RE.test(JSON.stringify(item.details))
    && item.authority === "execution-state-only" && /^[a-f0-9]{64}$/.test(item.digest || ""))) return false;
  const material = { kind: item.kind, objectId: item.objectId, at: item.at, details: item.details, authority: "execution-state-only" };
  return item.digest === sha256(JSON.stringify(material)) && item.id === "gateway-receipt:" + item.digest.slice(0, 24);
}

export function validHistory(item) {
  if (!(item && new Set(["queue", "outbox"]).has(item.kind) && ID_RE.test(item.objectId || "")
    && ID_RE.test(item.transition || "") && Number.isFinite(new Date(item.at).getTime())
    && item.value && item.authority === "execution-state-only")) return false;
  return item.kind === "queue" ? validQueue(item.value) && item.objectId === item.value.queueId
    : validOutbox(item.value) && item.objectId === item.value.outboxId;
}

export function validHealth(health) {
  return health && ["gateway", "adapter", "scheduler", "queue", "worker", "host"].every((key) => HEALTH_VALUES.has(health[key]))
    && (health.lastTickAt === null || Number.isFinite(new Date(health.lastTickAt).getTime()))
    && (health.lastReconciledAt === null || Number.isFinite(new Date(health.lastReconciledAt).getTime()));
}

export function normalizePolicy(value, root, provenance = null, staged = false) {
  const contractValid = staged ? value?.schema === GATEWAY_POLICY_SCHEMA
    && goalPremortem.ensureGoalPremortemRegistry(value) : goalPremortem.ensureGoalPremortemPolicy(value, GATEWAY_POLICY_SCHEMA, provenance);
  if (!value || !contractValid || value.root !== root
    || !Number.isInteger(value.revision) || typeof value.enabled !== "boolean" || typeof value.killSwitch !== "boolean"
    || !Array.isArray(value.goals) || !Array.isArray(value.history)
    || value.goals.some((item) => !validGoal(item, root, goalPremortem.goalPremortemContractVersion(value, item.goalId)))
    || value.goals.some((item) => !validGoalTransferProofs(item, value.goals))
    || value.history.some((item) => !validPolicyHistory(item, root))) {
    throw new Error("gateway policy is invalid; autonomous runtime is disabled");
  }
  return value;
}

export function normalizeRuntime(value, root) {
  const baseValid = value && value.schema === GATEWAY_RUNTIME_SCHEMA && value.root === root && Number.isInteger(value.revision)
    && Array.isArray(value.queue) && Array.isArray(value.lanes) && Array.isArray(value.outbox)
    && Array.isArray(value.receipts) && Array.isArray(value.history);
  if (!baseValid) throw new Error("gateway runtime structure is invalid; worker is disabled");
  const invalid = [];
  if (!validHealth(value.health)) invalid.push("health");
  const queueIndex = value.queue.findIndex((item) => !validQueue(item));
  const laneIndex = value.lanes.findIndex((item) => !validLane(item));
  const outboxIndex = value.outbox.findIndex((item) => !validOutbox(item));
  const receiptIndex = value.receipts.findIndex((item) => !validReceipt(item));
  const historyIndex = value.history.findIndex((item) => !validHistory(item));
  const leaseBindingMismatch = value.lanes.some((lane) => lane?.status === "leased"
    && !matchesGatewayLaneLease(lane, value.queue.find((item) => item.queueId === lane.queueId)));
  if (queueIndex >= 0) invalid.push("queue:" + queueIndex);
  if (laneIndex >= 0) invalid.push("lanes:" + laneIndex);
  if (leaseBindingMismatch) invalid.push("lane-lease-binding");
  if (outboxIndex >= 0) invalid.push("outbox:" + outboxIndex);
  if (receiptIndex >= 0) invalid.push("receipts:" + receiptIndex);
  if (historyIndex >= 0) invalid.push("history:" + historyIndex);
  if (invalid.length) throw new Error("gateway runtime is invalid (" + invalid.join(",") + "); worker is disabled");
  return value;
}

export async function pathsFor(root, catalog = null) {
  catalog ||= await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return { catalog, directory, gatewayPolicyPath: join(directory, "gateway-policy.json"), gatewayRuntimePath: join(directory, "gateway-runtime.json") };
}

export const readJson = readGatewayStateJson;
export const writeJson = writeGatewayStateJson;

export async function withLock(paths, task) {
  return withGatewayStateLock(paths, task, { validatePair: (policy, runtime) => {
    normalizePolicy(policy, paths.catalog.root, null, true); normalizeRuntime(runtime, paths.catalog.root);
    const findings = gatewayRuntimeFindings(policy, runtime);
    if (findings.length) throw new Error("gateway state pair is invalid (" + findings.slice(0, 16).join(",") + ")");
  } });
}


export function gatewayRuntimeFindings(policy, runtime) {
  const findings = [];
  const active = new Set();
  const goalIds = new Set();
  for (const goal of policy.goals) {
    if (!validGoal(goal, policy.root)) findings.push("invalid-goal:" + (goal?.goalId || "unknown"));
    else if (!validGoalTransferProofs(goal, policy.goals)) findings.push("invalid-strategy-transfer:" + goal.goalId);
    if (goalIds.has(goal.goalId)) findings.push("duplicate-goal:" + goal.goalId);
    goalIds.add(goal.goalId);
    if (goal.status === "active" && active.has(goal.agentId)) findings.push("multiple-active-goals:" + goal.agentId);
    if (goal.status === "active") active.add(goal.agentId);
  }
  for (const item of policy.history) if (!validPolicyHistory(item, policy.root)) findings.push("invalid-gateway-policy-history");
  const queueIds = new Set(); const dedupeKeys = new Set();
  for (const item of runtime.queue) {
    if (!validQueue(item)) findings.push("invalid-queue-item:" + (item?.queueId || "unknown"));
    if (queueIds.has(item.queueId)) findings.push("duplicate-queue-item:" + item.queueId);
    if (dedupeKeys.has(item.dedupeKey)) findings.push("duplicate-queue-dedupe:" + item.dedupeKey);
    queueIds.add(item.queueId); dedupeKeys.add(item.dedupeKey);
    if (item.goalStepId) {
      const goal = policy.goals.find((entry) => entry.goalId === item.goalId);
      const step = goal?.plan?.steps.find((entry) => entry.stepId === item.goalStepId);
      if (!step) findings.push("orphan-goal-step:" + item.queueId);
      else if (item.agentId !== planStepAgentId(goal, step)) findings.push("goal-step-agent-mismatch:" + item.queueId);
    }
  }
  const outboxIds = new Set(); const idempotencyKeys = new Set();
  for (const item of runtime.outbox) {
    if (!validOutbox(item)) findings.push("invalid-outbox-item:" + (item?.outboxId || "unknown"));
    if (!queueIds.has(item.queueId)) findings.push("orphan-outbox-item:" + item.outboxId);
    if (outboxIds.has(item.outboxId)) findings.push("duplicate-outbox-item:" + item.outboxId);
    if (idempotencyKeys.has(item.idempotencyKey)) findings.push("duplicate-outbox-idempotency:" + item.idempotencyKey);
    outboxIds.add(item.outboxId); idempotencyKeys.add(item.idempotencyKey);
  }
  for (const item of runtime.receipts) if (!validReceipt(item)
    || (!queueIds.has(item.objectId) && !outboxIds.has(item.objectId))) findings.push("invalid-gateway-receipt:" + (item?.id || "unknown"));
  for (const item of runtime.history) if (!validHistory(item)) findings.push("invalid-gateway-history:" + (item?.objectId || "unknown"));
  const leased = runtime.lanes.filter((item) => item.status === "leased");
  for (const lane of runtime.lanes) {
    if (!validLane(lane)) findings.push("invalid-agent-lane:" + (lane?.queueId || "unknown"));
    const queue = runtime.queue.find((item) => item.queueId === lane.queueId);
    if (!queue || (lane.status === "leased" && !matchesGatewayLaneLease(lane, queue))) {
      findings.push("agent-lane-queue-mismatch:" + (lane.queueId || "unknown"));
    }
  }
  if (new Set(leased.map((item) => item.agentId)).size !== leased.length) findings.push("duplicate-agent-lane");
  if (!validHealth(runtime.health)) findings.push("invalid-gateway-health");
  return findings;
}

