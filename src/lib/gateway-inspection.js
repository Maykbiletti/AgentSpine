import { gatewayHostHealthFindings } from "./gateway-host-lifecycle.js";
import { emptyPolicy, emptyRuntime, exactId } from "./gateway-common.js";
import { executionAttemptForStep } from "./gateway-execution.js";
import {
  conflictingResources, currentPlanStep, gatewayRuntimeFindings, normalizePolicy,
  normalizeRuntime, pathsFor, planStepAgentId, readJson, withLock
} from "./gateway-state.js";

export async function loadGatewayRuntime(root = process.cwd(), catalog = null) {
  const paths = await pathsFor(root, catalog);
  return withLock(paths, async () => {
    const [policy, runtime] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
    ]);
    return { policy, runtime, ...paths };
  });
}

export async function inspectGatewayRuntime(root = process.cwd(), catalog = null) {
  const paths = await pathsFor(root, catalog); const errors = [];
  let policy = emptyPolicy(paths.catalog.root); let runtime = emptyRuntime(paths.catalog.root);
  try {
    await withLock(paths, async () => {
      try { policy = await readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy); }
      catch (error) { errors.push("policy:" + error.message); }
      try { runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime); }
      catch (error) { errors.push("runtime:" + error.message); }
    });
  } catch (error) { errors.push("transaction:" + error.message); }
  return { policy, runtime, errors, ...paths };
}


export { gatewayRuntimeFindings } from "./gateway-state.js";

export function gatewayHealthFindings(policy, runtime, { now = new Date(), staleAfterMs = 180000 } = {}) {
  if (!policy.enabled || policy.killSwitch) return [];
  const findings = [];
  if (runtime.health.gateway !== "running") findings.push("gateway-not-running");
  if (runtime.health.scheduler !== "healthy") findings.push("scheduler-not-healthy");
  if (runtime.health.queue !== "healthy") findings.push("queue-not-healthy");
  if (!new Set(["healthy", "degraded"]).has(runtime.health.worker)) findings.push("worker-not-healthy");
  if (!new Set(["healthy", "degraded"]).has(runtime.health.adapter)) findings.push("adapter-not-healthy");
  findings.push(...gatewayHostHealthFindings(runtime));
  const current = now instanceof Date ? now : new Date(now);
  const tick = runtime.health.lastTickAt === null ? null : new Date(runtime.health.lastTickAt);
  const reconciliation = runtime.health.lastReconciledAt === null ? null : new Date(runtime.health.lastReconciledAt);
  if (!tick || current.getTime() - tick.getTime() > staleAfterMs) findings.push("worker-heartbeat-stale");
  if (!reconciliation || current.getTime() - reconciliation.getTime() > staleAfterMs) findings.push("scheduler-heartbeat-stale");
  return findings;
}

export async function gatewayContext({ root = process.cwd(), agentId = null } = {}) {
  const { policy, runtime } = await loadGatewayRuntime(root);
  const findings = gatewayRuntimeFindings(policy, runtime);
  if (findings.length) throw new Error("gateway runtime failed closed: " + findings.join(", "));
  const exactAgentId = agentId === null ? null : exactId(agentId, "agentId");
  const goals = policy.goals.filter((item) => exactAgentId === null || item.agentId === exactAgentId
    || item.plan?.steps.some((step) => planStepAgentId(item, step) === exactAgentId));
  const executionAttempts = goals.map((goal) => {
    const step = currentPlanStep(goal); const attempt = executionAttemptForStep(step);
    return attempt && (exactAgentId === null || planStepAgentId(goal, step) === exactAgentId)
      ? { goalId: goal.goalId, goalStepId: step.stepId, ...attempt } : null;
  }).filter(Boolean);
  const queue = runtime.queue.filter((item) => exactAgentId === null || item.agentId === exactAgentId);
  const queueIds = new Set(queue.map((item) => item.queueId));
  const leased = runtime.queue.filter((item) => item.status === "leased");
  const resourceWaits = queue.filter((item) => item.status === "pending").map((item) => {
    const blockers = leased.map((entry) => ({ entry, resources: conflictingResources(policy, item, entry) }))
      .filter(({ resources }) => resources.length > 0);
    return blockers.length ? {
      queueId: item.queueId,
      resources: [...new Set(blockers.flatMap(({ resources }) => resources))].sort(),
      blockedByQueueIds: blockers.map(({ entry }) => entry.queueId).sort(),
      authority: "execution-state-only"
    } : null;
  }).filter(Boolean);
  return { schema: "agentspine.gateway-context/v1", enabled: policy.enabled, killSwitch: policy.killSwitch,
    goals: structuredClone(goals), queue: structuredClone(queue),
    outbox: structuredClone(runtime.outbox.filter((item) => queueIds.has(item.queueId))),
    resourceWaits, executionAttempts,
    health: structuredClone(runtime.health), healthFindings: gatewayHealthFindings(policy, runtime),
    authority: "execution-state-only" };
}
