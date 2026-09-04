import {
  HOSTS, appendReceipt, blocker, currentTaskValid, ensureScope, exactGrant, leaseExpired,
  lockedStates, preserveJob, receiptDigest, resultHash, stableId, timestamp
} from "./selfstarter-core.js";
import { incompleteWorkspaceScan, workspaceFingerprint } from "./selfstarter-workspace.js";

export async function startOrResumeJob({ root = process.cwd(), actorId, projectId, groupId = null, taskId = null, jobId = null, host, sessionId, now = new Date() }) {
  const scope = {
    actorId: stableId(actorId, "actorId"), projectId: stableId(projectId, "projectId"),
    groupId: stableId(groupId, "groupId", true), taskId: stableId(taskId, "taskId", true),
    jobId: stableId(jobId, "jobId", true), host, sessionId: stableId(sessionId, "sessionId")
  };
  if (!HOSTS.has(host)) throw new Error("self-starter host must be claude or codex");
  const at = timestamp(now, "now");
  const fingerprint = await workspaceFingerprint(root);
  return lockedStates(root, ({ policy, state, coordination, paths }) => {
    const candidates = state.jobs.filter((job) => !["completed", "cancelled", "exhausted"].includes(job.status)
      && job.actorId === scope.actorId && job.projectId === scope.projectId && job.groupId === scope.groupId
      && job.host === host && (!scope.taskId || job.taskId === scope.taskId) && (!scope.jobId || job.id === scope.jobId));
    if (!candidates.length) return { job: null, reason: "no-exact-waiting-job", selfstarterPath: paths.selfstarterPath };
    if (candidates.length !== 1) throw new Error("multiple eligible self-starter jobs require an exact job or task scope");
    const job = candidates[0];
    ensureScope(job, scope);
    if (!currentTaskValid(job, coordination)) {
      preserveJob(state, job, "task-invalid", at);
      blocker(job, "task-or-assignment-changed", at);
      appendReceipt(state, job, `receipt:blocked:${receiptDigest({ id: job.id, at, code: job.lastBlocker.code }).slice(0, 20)}`, "blocked", at, { code: job.lastBlocker.code });
      return { job: null, blocked: true, reason: job.lastBlocker.code, selfstarterPath: paths.selfstarterPath };
    }
    if (job.lease && !leaseExpired(job, at) && job.lease.sessionId !== scope.sessionId) {
      throw new Error(`job ${job.id} has an active lease`);
    }
    const hasPriorRun = Boolean(job.lease) || state.receipts.some((receipt) => receipt.jobId === job.id && ["start", "resume"].includes(receipt.event));
    const action = job.checkpoint.sequence === 0 && !hasPriorRun ? "start" : "resume";
    exactGrant(policy, job, action, at);
    if (job.checkpoint.nextRetryAt && new Date(job.checkpoint.nextRetryAt) > new Date(at)) {
      return { job: null, blocked: true, reason: "retry-backoff-active", nextRetryAt: job.checkpoint.nextRetryAt, selfstarterPath: paths.selfstarterPath };
    }
    if (job.status === "blocked" && job.lastBlocker?.code === "host-reported-blocker") {
      return { job: null, blocked: true, reason: "host-reported-blocker", selfstarterPath: paths.selfstarterPath };
    }
    if (job.pendingEffect && leaseExpired(job, at)) {
      if (fingerprint.digest !== job.pendingEffect.beforeDigest) {
        preserveJob(state, job, "crash-workspace-unknown", at);
        blocker(job, "workspace-changed-after-uncheckpointed-effect", at);
        appendReceipt(state, job, `receipt:blocked:${receiptDigest({ id: job.id, at, code: job.lastBlocker.code }).slice(0, 20)}`, "blocked", at, { code: job.lastBlocker.code });
        return { job: null, blocked: true, reason: job.lastBlocker.code, selfstarterPath: paths.selfstarterPath };
      }
      preserveJob(state, job, "crash-recovered", at);
      job.pendingEffect = null;
      job.checkpoint.retryCount += 1;
      if (job.checkpoint.retryCount > job.maxRetries) {
        blocker(job, "retry-budget-exhausted", at);
        return { job: null, blocked: true, reason: job.lastBlocker.code, selfstarterPath: paths.selfstarterPath };
      }
    }
    if (fingerprint.digest !== job.checkpoint.workspaceDigest) {
      preserveJob(state, job, "workspace-drift", at);
      blocker(job, "workspace-changed-outside-checkpoint", at);
      appendReceipt(state, job, `receipt:blocked:${receiptDigest({ id: job.id, at, code: job.lastBlocker.code }).slice(0, 20)}`, "blocked", at, { code: job.lastBlocker.code });
      return { job: null, blocked: true, reason: job.lastBlocker.code, selfstarterPath: paths.selfstarterPath };
    }
    const receiptId = `receipt:${action}:${receiptDigest({ job: job.id, session: scope.sessionId }).slice(0, 20)}`;
    const existing = state.receipts.find((receipt) => receipt.id === receiptId);
    if (existing && job.lease?.sessionId === scope.sessionId) return { job, action, duplicate: true, receipt: existing, selfstarterPath: paths.selfstarterPath };
    if (existing) return {
      job: null, action, duplicate: true, blocked: true, reason: "session-lifecycle-already-closed",
      receipt: existing, selfstarterPath: paths.selfstarterPath
    };
    preserveJob(state, job, action, at);
    job.status = "running";
    job.lastBlocker = null;
    job.lease = {
      sessionId: scope.sessionId, host, acquiredAt: at,
      expiresAt: new Date(new Date(at).getTime() + job.leaseSeconds * 1000).toISOString(),
      workspaceDigest: fingerprint.digest
    };
    job.updatedAt = at;
    const { receipt } = appendReceipt(state, job, receiptId, action, at, { sessionId: scope.sessionId, workspaceDigest: fingerprint.digest });
    return { job, action, duplicate: false, receipt, selfstarterPath: paths.selfstarterPath, authority: "explicit-local-execution-policy" };
  });
}

export async function authorizeJobEffect({
  root = process.cwd(), jobId, actorId, projectId, groupId = null, taskId,
  host, sessionId, toolName, toolUseId, now = new Date()
}) {
  const scope = {
    jobId: stableId(jobId, "jobId"), actorId: stableId(actorId, "actorId"),
    projectId: stableId(projectId, "projectId"), groupId: stableId(groupId, "groupId", true),
    taskId: stableId(taskId, "taskId"), host, sessionId: stableId(sessionId, "sessionId")
  };
  const capability = `tool:${stableId(toolName, "toolName")}`;
  const deliveryId = stableId(toolUseId, "toolUseId");
  const at = timestamp(now, "now");
  const fingerprint = await workspaceFingerprint(root);
  if (fingerprint.skipped.length) throw incompleteWorkspaceScan(fingerprint.skipped);
  return lockedStates(root, ({ policy, state, coordination, paths }) => {
    const job = state.jobs.find((item) => item.id === scope.jobId);
    if (!job) throw new Error("unknown self-starter job");
    ensureScope(job, scope);
    exactGrant(policy, job, "effect", at);
    if (!currentTaskValid(job, coordination)) throw new Error("self-starter task or assignment changed");
    if (job.status !== "running" || !job.lease || leaseExpired(job, at) || job.lease.sessionId !== scope.sessionId) throw new Error("self-starter effect requires the current live lease");
    if (!job.capabilities.includes(capability)) throw new Error(`default deny: capability ${capability} is not granted for ${job.id}`);
    if (fingerprint.digest !== job.checkpoint.workspaceDigest || fingerprint.digest !== job.lease.workspaceDigest) throw new Error("workspace changed outside the current checkpoint");
    if (job.pendingEffect) {
      if (job.pendingEffect.toolUseId === deliveryId && job.pendingEffect.capability === capability) return { allowed: true, duplicate: true, job, pendingEffect: job.pendingEffect };
      throw new Error("another self-starter effect is already pending");
    }
    preserveJob(state, job, "effect-authorized", at);
    job.pendingEffect = { toolUseId: deliveryId, capability, beforeDigest: fingerprint.digest, authorizedAt: at, sessionId: scope.sessionId };
    job.updatedAt = at;
    const receiptId = `receipt:authorize:${receiptDigest({ job: job.id, toolUseId: deliveryId, capability }).slice(0, 20)}`;
    const { receipt } = appendReceipt(state, job, receiptId, "effect-authorized", at, { toolUseId: deliveryId, capability, beforeDigest: fingerprint.digest });
    return { allowed: true, duplicate: false, job, pendingEffect: job.pendingEffect, receipt, selfstarterPath: paths.selfstarterPath };
  });
}

export async function checkpointJobEffect({
  root = process.cwd(), jobId, actorId, projectId, groupId = null, taskId,
  host, sessionId, toolName, toolUseId, success = true, result = null, now = new Date()
}) {
  const scope = {
    jobId: stableId(jobId, "jobId"), actorId: stableId(actorId, "actorId"),
    projectId: stableId(projectId, "projectId"), groupId: stableId(groupId, "groupId", true),
    taskId: stableId(taskId, "taskId"), host, sessionId: stableId(sessionId, "sessionId")
  };
  const capability = `tool:${stableId(toolName, "toolName")}`;
  const deliveryId = stableId(toolUseId, "toolUseId");
  const at = timestamp(now, "now");
  const fingerprint = await workspaceFingerprint(root);
  return lockedStates(root, ({ policy, state, coordination, paths }) => {
    const job = state.jobs.find((item) => item.id === scope.jobId);
    if (!job) throw new Error("unknown self-starter job");
    ensureScope(job, scope);
    exactGrant(policy, job, "effect", at);
    if (!currentTaskValid(job, coordination)) throw new Error("self-starter task or assignment changed");
    const receiptId = `receipt:checkpoint:${receiptDigest({ job: job.id, toolUseId: deliveryId }).slice(0, 20)}`;
    const existing = state.receipts.find((receipt) => receipt.id === receiptId);
    if (existing && job.checkpoint.lastToolUseId === deliveryId) return { job, duplicate: true, receipt: existing, selfstarterPath: paths.selfstarterPath };
    if (!job.lease || job.lease.sessionId !== scope.sessionId || !job.pendingEffect
      || job.pendingEffect.toolUseId !== deliveryId || job.pendingEffect.capability !== capability) throw new Error("effect checkpoint does not match the pending authorization");
    preserveJob(state, job, success ? "effect-succeeded" : "effect-failed", at);
    job.checkpoint.sequence += 1;
    job.checkpoint.workspaceDigest = fingerprint.digest;
    job.checkpoint.workspaceFiles = fingerprint.files;
    job.checkpoint.workspaceBytes = fingerprint.bytes;
    job.checkpoint.lastToolUseId = deliveryId;
    job.checkpoint.resultDigest = resultHash(result);
    job.checkpoint.updatedAt = at;
    if (success) {
      job.checkpoint.retryCount = 0;
      job.checkpoint.nextRetryAt = null;
      job.lastBlocker = null;
      job.lease.workspaceDigest = fingerprint.digest;
      job.lease.expiresAt = new Date(new Date(at).getTime() + job.leaseSeconds * 1000).toISOString();
    } else {
      job.checkpoint.retryCount += 1;
      if (job.checkpoint.retryCount > job.maxRetries) blocker(job, "retry-budget-exhausted", at);
      else {
        const seconds = Math.min(3600, job.baseRetrySeconds * (2 ** (job.checkpoint.retryCount - 1)));
        job.checkpoint.nextRetryAt = new Date(new Date(at).getTime() + seconds * 1000).toISOString();
        blocker(job, "effect-failed", at);
      }
    }
    job.pendingEffect = null;
    job.updatedAt = at;
    const { receipt } = appendReceipt(state, job, receiptId, success ? "effect-succeeded" : "effect-failed", at, {
      toolUseId: deliveryId, capability, checkpointSequence: job.checkpoint.sequence,
      workspaceDigest: fingerprint.digest, resultDigest: job.checkpoint.resultDigest, retryCount: job.checkpoint.retryCount
    });
    return { job, duplicate: false, receipt, selfstarterPath: paths.selfstarterPath };
  });
}

export async function closeJobLease({ root = process.cwd(), jobId, actorId, projectId, groupId = null, taskId, host, sessionId, status = "waiting", now = new Date() }) {
  if (!["waiting", "blocked", "completed"].includes(status)) throw new Error("closing status must be waiting, blocked, or completed");
  const scope = {
    jobId: stableId(jobId, "jobId"), actorId: stableId(actorId, "actorId"),
    projectId: stableId(projectId, "projectId"), groupId: stableId(groupId, "groupId", true),
    taskId: stableId(taskId, "taskId"), host, sessionId: stableId(sessionId, "sessionId")
  };
  const at = timestamp(now, "now");
  return lockedStates(root, ({ policy, state, coordination, paths }) => {
    const job = state.jobs.find((item) => item.id === scope.jobId);
    if (!job) throw new Error("unknown self-starter job");
    ensureScope(job, scope);
    exactGrant(policy, job, "resume", at);
    if (!currentTaskValid(job, coordination) && status !== "completed") throw new Error("self-starter task or assignment changed");
    const receiptId = `receipt:close:${receiptDigest({ job: job.id, session: scope.sessionId, status }).slice(0, 20)}`;
    const existing = state.receipts.find((receipt) => receipt.id === receiptId);
    if (existing && !job.lease) return { job, duplicate: true, receipt: existing, selfstarterPath: paths.selfstarterPath };
    if (!job.lease || job.lease.sessionId !== scope.sessionId) throw new Error("only the current lease holder may close a job");
    if (job.pendingEffect) throw new Error("cannot close a job with an uncheckpointed effect");
    preserveJob(state, job, "lease-closed", at);
    job.status = status;
    job.lease = null;
    if (status === "blocked") job.lastBlocker = { code: "host-reported-blocker", at, authority: "execution-state-only" };
    job.updatedAt = at;
    const { receipt } = appendReceipt(state, job, receiptId, "lease-closed", at, { sessionId: scope.sessionId, status, checkpointSequence: job.checkpoint.sequence });
    return { job, duplicate: false, receipt, selfstarterPath: paths.selfstarterPath };
  });
}
