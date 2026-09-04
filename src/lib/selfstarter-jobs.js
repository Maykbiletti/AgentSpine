import {
  ACTIONS, HOSTS, appendReceipt, blocker, capabilities, currentTaskValid, emptyJobs, emptyPolicy,
  exactGrant, executionPolicyFindingsInternal, integer, leaseExpired, lockedStates, normalizeJobs,
  normalizePolicy, pathsFor, preserveJob, readJson, receiptDigest, referenceState,
  requireOwnerConfirmation, resultHash, safeText, selfstarterFindingsInternal, stableId, timestamp,
  validateGrantReferences, withLock
} from "./selfstarter-core.js";
import { workspaceFingerprint } from "./selfstarter-workspace.js";

export async function resolveSessionJob({
  root = process.cwd(), actorId = null, projectId = null, groupId = null, taskId = null,
  host, sessionId, action = "effect", now = new Date()
}) {
  if (!ACTIONS.has(action)) throw new Error("session job resolution requires start, resume, or effect");
  if (!HOSTS.has(host)) throw new Error("self-starter host must be claude or codex");
  const session = stableId(sessionId, "sessionId");
  const at = timestamp(now, "now");
  const paths = await pathsFor(root);
  const [policy, state] = await Promise.all([
    readJson(paths.executionPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
    readJson(paths.selfstarterPath, paths.catalog.root, normalizeJobs, emptyJobs)
  ]);
  const { graph, coordination } = await referenceState(paths.catalog);
  const findings = [
    ...executionPolicyFindingsInternal(policy, graph, coordination, { checkCurrentReferences: false }),
    ...selfstarterFindingsInternal(state, policy, graph, coordination)
  ];
  if (findings.length) throw new Error(`self-starter failed closed: ${findings.join(", ")}`);
  const candidates = state.jobs.filter((job) => job.lease?.sessionId === session);
  if (!candidates.length) return null;
  if (candidates.length !== 1) throw new Error("host session has multiple self-starter leases");
  const job = candidates[0];
  if (leaseExpired(job, at)) throw new Error(`job ${job.id} lease expired`);
  for (const [value, expected, label] of [
    [actorId, job.actorId, "actor"], [projectId, job.projectId, "project"],
    [taskId, job.taskId, "task"], [groupId, job.groupId, "group"], [host, job.host, "host"]
  ]) {
    if (value !== null && value !== undefined && value !== expected) throw new Error(`self-starter ${label} scope mismatch for ${job.id}`);
  }
  exactGrant(policy, job, action, at);
  if (!currentTaskValid(job, coordination)) throw new Error("self-starter task or assignment changed");
  return {
    jobId: job.id, actorId: job.actorId, projectId: job.projectId, groupId: job.groupId,
    taskId: job.taskId, host: job.host, sessionId: session
  };
}

export async function registerJob({
  root = process.cwd(), id, grantId, maxRetries = 3, leaseSeconds = 120,
  baseRetrySeconds = 5, confirmation, now = new Date()
}) {
  requireOwnerConfirmation(confirmation);
  const jobId = stableId(id, "jobId");
  const at = timestamp(now, "now");
  const paths = await pathsFor(root);
  const fingerprint = await workspaceFingerprint(paths.catalog.root);
  const { graph, coordination } = await referenceState(paths.catalog);
  return withLock(paths.executionPolicyPath, () => readJson(paths.executionPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy), (policy) => withLock(
    paths.selfstarterPath,
    () => readJson(paths.selfstarterPath, paths.catalog.root, normalizeJobs, emptyJobs),
    (state) => {
      const policyIssues = executionPolicyFindingsInternal(policy, graph, coordination);
      const stateIssues = selfstarterFindingsInternal(state, policy, graph, coordination);
      if (policyIssues.length || stateIssues.length) throw new Error(`self-starter registration failed closed: ${[...policyIssues, ...stateIssues].join(", ")}`);
      const grant = policy.grants.find((item) => item.id === grantId && item.jobId === jobId);
      if (!grant) throw new Error("registration requires the exact current execution grant");
      if (state.jobs.some((job) => job.id === jobId)) throw new Error("job IDs are immutable");
      const template = {
        id: jobId, taskId: grant.taskId, actorId: grant.actorId, targetId: grant.targetId,
        projectId: grant.projectId, groupId: grant.groupId, host: grant.host,
        capabilities: [...grant.capabilities], grantId: grant.id
      };
      exactGrant(policy, template, "start", at);
      if (!validateGrantReferences(grant, graph, coordination)) throw new Error("execution grant no longer matches the current task");
      const job = {
        ...template, status: "waiting",
        checkpoint: {
          sequence: 0, workspaceDigest: fingerprint.digest, workspaceFiles: fingerprint.files,
          workspaceBytes: fingerprint.bytes, lastToolUseId: null, resultDigest: null,
          retryCount: 0, nextRetryAt: null, updatedAt: at
        },
        lease: null, pendingEffect: null,
        maxRetries: integer(maxRetries, "maxRetries", 0, 10),
        leaseSeconds: integer(leaseSeconds, "leaseSeconds", 15, 900),
        baseRetrySeconds: integer(baseRetrySeconds, "baseRetrySeconds", 1, 3600),
        lastBlocker: null, createdAt: at, updatedAt: at, authority: "execution-state-only"
      };
      state.jobs.push(job);
      state.jobs.sort((a, b) => a.id.localeCompare(b.id));
      appendReceipt(state, job, `receipt:registered:${receiptDigest({ id: job.id, at }).slice(0, 20)}`, "registered", at, { checkpoint: job.checkpoint.workspaceDigest });
      return { job, selfstarterPath: paths.selfstarterPath, executionPolicyPath: paths.executionPolicyPath };
    }
  ), false);
}

export async function cancelJob({ root = process.cwd(), id, reason, confirmation, now = new Date() }) {
  requireOwnerConfirmation(confirmation);
  stableId(id, "jobId");
  const at = timestamp(now, "now");
  const cancelReason = safeText(reason, "reason", 500);
  return lockedStates(root, ({ state, paths }) => {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw new Error("unknown self-starter job");
    if (["completed", "cancelled"].includes(job.status)) throw new Error("self-starter job is already terminal");
    preserveJob(state, job, "cancelled", at);
    job.status = "cancelled";
    job.lease = null;
    job.pendingEffect = null;
    job.lastBlocker = { code: "owner-cancelled", at, authority: "execution-state-only" };
    job.cancelReason = cancelReason;
    job.updatedAt = at;
    appendReceipt(state, job, `receipt:cancel:${receiptDigest({ id, at }).slice(0, 20)}`, "cancelled", at, { reasonDigest: resultHash(cancelReason) });
    return { job, selfstarterPath: paths.selfstarterPath };
  });
}

export async function deleteJob({ root = process.cwd(), id, confirmation }) {
  requireOwnerConfirmation(confirmation);
  stableId(id, "jobId");
  return lockedStates(root, ({ state, paths }) => {
    const job = state.jobs.find((item) => item.id === id);
    if (job?.lease || job?.pendingEffect) throw new Error("cannot delete a leased or uncheckpointed job");
    const existed = Boolean(job);
    state.jobs = state.jobs.filter((item) => item.id !== id);
    state.history = state.history.filter((entry) => entry.recordId !== id && entry.value?.id !== id);
    state.receipts = state.receipts.filter((receipt) => receipt.jobId !== id);
    return { deleted: existed, id, selfstarterPath: paths.selfstarterPath };
  });
}

export async function selfstarterContext({ root = process.cwd(), actorId = null, projectId = null, taskId = null, includeTerminal = false } = {}) {
  const paths = await pathsFor(root);
  const [policy, state] = await Promise.all([
    readJson(paths.executionPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
    readJson(paths.selfstarterPath, paths.catalog.root, normalizeJobs, emptyJobs)
  ]);
  const { graph, coordination } = await referenceState(paths.catalog);
  const findings = [...executionPolicyFindingsInternal(policy, graph, coordination), ...selfstarterFindingsInternal(state, policy, graph, coordination)];
  if (findings.length) throw new Error(`self-starter failed closed: ${findings.join(", ")}`);
  const items = state.jobs.filter((job) => (!actorId || job.actorId === actorId) && (!projectId || job.projectId === projectId)
    && (!taskId || job.taskId === taskId) && (includeTerminal || !["completed", "cancelled"].includes(job.status)))
    .map((job) => ({
      id: job.id, taskId: job.taskId, actorId: job.actorId, targetId: job.targetId,
      projectId: job.projectId, groupId: job.groupId, host: job.host, status: job.status,
      checkpoint: { ...job.checkpoint }, leased: Boolean(job.lease), pendingEffect: Boolean(job.pendingEffect),
      lastBlocker: job.lastBlocker, updatedAt: job.updatedAt, authority: "execution-state-only"
    }));
  return { schema: "agentspine.selfstarter-context/v1", root: paths.catalog.root, items, authority: "execution-state-only" };
}
