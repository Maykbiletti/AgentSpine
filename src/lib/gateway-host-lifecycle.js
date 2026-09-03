export const AMBIGUOUS_HOST_OUTCOME =
  "Host execution may have produced an effect before restart; manual owner review is required.";

const EXECUTION_MODES = new Set(["host-effect", "read-only"]);

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

export function normalizeGatewayExecutionMode(value = "host-effect") {
  if (!EXECUTION_MODES.has(value)) {
    throw new Error("executionMode must be host-effect or read-only");
  }
  return value;
}

export function newGatewayLease(workerId, current, seconds, executionMode) {
  return { workerId, claimedAt: current, executionMode,
    expiresAt: new Date(new Date(current).getTime() + seconds * 1000).toISOString(),
    ...(executionMode === "host-effect" ? { effectMayStartAt: current } : {}) };
}

export function assertGatewayCompletionMode(lease, result) {
  if (lease.executionMode === "read-only") {
    if (result?.readOnly !== true) {
      throw new Error("read-only gateway lease completion requires result.readOnly: true");
    }
    return false;
  }
  if (!validTimestamp(lease?.hostStartedAt)) {
    throw new Error("gateway lease with possible host effects requires markGatewayHostStarted before completion");
  }
  return true;
}

export function matchesGatewayLaneLease(lane, queue) {
  return queue?.status === "leased" && queue.lease?.workerId === lane.workerId
    && queue.lease.claimedAt === lane.claimedAt && queue.lease.expiresAt === lane.expiresAt;
}

export function exactGatewayLeaseGeneration(claimedAt, attempt, action) {
  if (!validTimestamp(claimedAt) || !Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`${action} requires claimedAt and attempt from the exact active queue lease`);
  }
  return new Date(claimedAt).toISOString();
}

export function requireExactGatewayLease(runtime, item, { workerId, claimedAt, attempt, current, action }) {
  if (!item || item.status !== "leased" || item.attempts !== attempt
    || item.lease?.workerId !== workerId || item.lease.claimedAt !== claimedAt
    || new Date(item.lease.expiresAt) <= new Date(current)) {
    throw new Error(`${action} requires the exact active queue lease`);
  }
  const lane = runtime.lanes.find((entry) => entry.queueId === item.queueId && entry.workerId === workerId
    && entry.claimedAt === claimedAt && entry.expiresAt === item.lease.expiresAt && entry.status === "leased");
  if (!lane) throw new Error("agent lane lease is missing");
  return lane;
}

export function validGatewayLeaseExecution(lease) {
  if (lease?.executionMode === undefined) {
    return lease?.effectMayStartAt === undefined
      && (lease.hostStartedAt === undefined || validTimestamp(lease.hostStartedAt));
  }
  if (lease.executionMode === "host-effect") {
    return validTimestamp(lease.effectMayStartAt)
      && (lease.hostStartedAt === undefined || validTimestamp(lease.hostStartedAt));
  }
  return lease.executionMode === "read-only" && lease.effectMayStartAt === undefined
    && lease.hostStartedAt === undefined;
}

export function leaseMayHaveHostEffect(lease) {
  return lease?.executionMode !== "read-only";
}

export function hasAmbiguousHostOutcome(runtime) {
  return runtime.receipts.some((receipt) => receipt.kind === "host-outcome-ambiguous");
}

export function gatewayHostHealthFindings(runtime) {
  if (runtime.health.host !== "failed") return [];
  return ["host-not-healthy", ...(hasAmbiguousHostOutcome(runtime) ? ["host-outcome-ambiguous"] : [])];
}

function markAmbiguousHostHealth(runtime, current) {
  runtime.health.host = "failed";
  runtime.health.worker = "degraded";
  runtime.health.lastTickAt = current;
}

export function requireExactHostLease(runtime, item, { workerId, claimedAt, attempt, current }) {
  const lane = requireExactGatewayLease(runtime, item,
    { workerId, claimedAt, attempt, current, action: "host start" });
  if (item.lease.executionMode !== "host-effect") {
    throw new Error("host start requires a host-effect lease");
  }
  if (item.lease.hostStartedAt) throw new Error("the exact queue lease already started host execution");
  return lane;
}

export function markHostStarted(runtime, item, lane, workerId, current, { preserve, appendReceipt }) {
  preserve(runtime, "queue", item, "host-started", current);
  item.lease.hostStartedAt = current;
  item.updatedAt = current;
  lane.updatedAt = current;
  runtime.revision += 1;
  return appendReceipt(runtime, "host-started", item.queueId, current,
    { workerId, attempt: item.attempts });
}

function blockBoundGoal(policy, item, current) {
  const goal = item.goalId ? policy.goals.find((entry) => entry.goalId === item.goalId) : null;
  if (!goal || goal.status !== "active") return false;
  const step = item.goalStepId && goal.plan
    ? goal.plan.steps.find((entry) => entry.stepId === item.goalStepId) : null;
  if (goal.plan && (step?.stepId !== goal.plan.currentStepId || step.status !== "active")) return false;
  policy.history.push({ kind: "goal", at: current, value: structuredClone(goal),
    authority: "authenticated-goal-policy" });
  goal.status = "blocked";
  goal.blocker = AMBIGUOUS_HOST_OUTCOME;
  goal.heartbeatAt = current;
  goal.updatedAt = current;
  if (step) {
    step.status = "blocked";
    step.blocker = AMBIGUOUS_HOST_OUTCOME;
    step.updatedAt = current;
    goal.plan.revision += 1;
  }
  policy.revision += 1;
  return true;
}

export function expireGatewayLane(policy, runtime, lane, current, { preserve, appendReceipt }) {
  const item = runtime.queue.find((entry) => entry.queueId === lane.queueId && entry.status === "leased");
  if (item?.lease && leaseMayHaveHostEffect(item.lease)) {
    const { hostStartedAt = null, effectMayStartAt = null, executionMode = "legacy-unknown" } = item.lease;
    preserve(runtime, "queue", item, "host-outcome-ambiguous", current);
    item.status = "blocked";
    item.lease = null;
    item.lastError = AMBIGUOUS_HOST_OUTCOME;
    item.completedAt = current;
    item.updatedAt = current;
    appendReceipt(runtime, "host-outcome-ambiguous", item.queueId, current,
      { attempt: item.attempts, hostStartedAt, effectMayStartAt, executionMode });
    lane.status = "expired";
    lane.updatedAt = current;
    markAmbiguousHostHealth(runtime, current);
    return blockBoundGoal(policy, item, current);
  }
  if (item) {
    preserve(runtime, "queue", item, "lease-expired", current);
    item.status = item.attempts >= 3 ? "dead-letter" : "pending";
    item.lease = null;
    item.updatedAt = current;
  }
  lane.status = "expired";
  lane.updatedAt = current;
  return false;
}

export function failGatewayLane(policy, runtime, item, lane, current,
  { error, retryAfterMs, preserve, appendReceipt }) {
  if (leaseMayHaveHostEffect(item.lease)) {
    expireGatewayLane(policy, runtime, lane, current, { preserve, appendReceipt });
    runtime.revision += 1;
    return { ambiguous: true, receipt: runtime.receipts.at(-1) };
  }
  preserve(runtime, "queue", item, "run-failed", current);
  item.status = item.attempts >= 3 ? "dead-letter" : "pending";
  item.lease = null;
  item.lastError = error;
  item.updatedAt = current;
  item.availableAt = new Date(new Date(current).getTime() + retryAfterMs).toISOString();
  if (item.status === "dead-letter") item.completedAt = current;
  lane.status = "completed";
  lane.updatedAt = current;
  runtime.health.host = "failed";
  runtime.health.worker = "degraded";
  runtime.health.lastTickAt = current;
  runtime.revision += 1;
  return { ambiguous: false, receipt: appendReceipt(runtime,
    item.status === "dead-letter" ? "run-dead-letter" : "run-retry",
    item.queueId, current, { attempt: item.attempts }) };
}
