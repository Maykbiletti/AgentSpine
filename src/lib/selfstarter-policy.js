import { randomUUID } from "node:crypto";
import {
  ACTIONS, HOSTS, capabilities, emptyJobs, emptyPolicy, executionPolicyFindingsInternal,
  normalizeJobs, normalizePolicy, pathsFor, preservePolicy, readJson, referenceState,
  requireOwnerConfirmation, safeText, selfstarterFindingsInternal, stableId, timestamp,
  validateGrantReferences, withLock
} from "./selfstarter-core.js";

export function executionPolicyFindings(policy, graph, coordination) {
  return executionPolicyFindingsInternal(policy, graph, coordination);
}

export function selfstarterFindings(state, policy, graph, coordination) {
  return selfstarterFindingsInternal(state, policy, graph, coordination);
}

export async function loadExecutionPolicy(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  return { policy: await readJson(paths.executionPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy), ...paths };
}

export async function loadSelfstarter(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  return { state: await readJson(paths.selfstarterPath, paths.catalog.root, normalizeJobs, emptyJobs), ...paths };
}

export async function inspectSelfstarter(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  let policy = emptyPolicy(paths.catalog.root);
  let state = emptyJobs(paths.catalog.root);
  const errors = [];
  try { policy = await readJson(paths.executionPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy); } catch (error) { errors.push(`policy:${error.message}`); }
  try { state = await readJson(paths.selfstarterPath, paths.catalog.root, normalizeJobs, emptyJobs); } catch (error) { errors.push(`state:${error.message}`); }
  return { policy, state, errors, ...paths };
}

export async function grantExecution({
  root = process.cwd(), id = `execution-grant:${randomUUID()}`, actorId, actions = ["start", "resume", "effect"],
  jobId, taskId, targetId, projectId, groupId = null, host, capabilities: requestedCapabilities,
  reason, expiresAt = null, confirmation, now = new Date()
}) {
  requireOwnerConfirmation(confirmation);
  const grant = {
    id: stableId(id, "grantId"), actorId: stableId(actorId, "actorId"),
    actions: [...new Set(actions)].sort(), jobId: stableId(jobId, "jobId"), taskId: stableId(taskId, "taskId"),
    targetId: stableId(targetId, "targetId"), projectId: stableId(projectId, "projectId"),
    groupId: stableId(groupId, "groupId", true), host, capabilities: capabilities(requestedCapabilities),
    reason: safeText(reason, "reason", 500), active: true, expiresAt: timestamp(expiresAt, "expiresAt", true)
  };
  if (grant.actions.length !== 3 || grant.actions.some((action) => !ACTIONS.has(action))) throw new Error("a self-starter grant must explicitly include start, resume, and effect");
  if (!HOSTS.has(host)) throw new Error("host must be claude or codex");
  const at = timestamp(now, "now");
  if (grant.expiresAt && new Date(grant.expiresAt) <= new Date(at)) throw new Error("execution grant expiry must be in the future");
  const { catalog, executionPolicyPath } = await pathsFor(root);
  const { graph, coordination } = await referenceState(catalog);
  if (!validateGrantReferences(grant, graph, coordination)) throw new Error("execution grant must match a current assigned task and its exact scope");
  return withLock(executionPolicyPath, () => readJson(executionPolicyPath, catalog.root, normalizePolicy, emptyPolicy), (policy) => {
    const findings = executionPolicyFindingsInternal(policy, graph, coordination, { checkCurrentReferences: false });
    if (findings.length) throw new Error(`execution policy failed closed: ${findings.join(", ")}`);
    if (policy.grants.some((item) => item.id === grant.id || item.jobId === grant.jobId)) throw new Error("execution grant and job IDs are immutable and unique");
    policy.revision += 1;
    Object.assign(grant, {
      revision: policy.revision, createdAt: at, updatedAt: at,
      source: "explicit-local-owner-policy", authority: "explicit-local-execution-policy"
    });
    policy.grants.push(grant);
    policy.grants.sort((a, b) => a.id.localeCompare(b.id));
    return { grant, policyRevision: policy.revision, executionPolicyPath };
  });
}

export async function revokeExecution({ root = process.cwd(), id, reason, confirmation, now = new Date() }) {
  requireOwnerConfirmation(confirmation);
  stableId(id, "grantId");
  const at = timestamp(now, "now");
  const revokeReason = safeText(reason, "reason", 500);
  const { catalog, executionPolicyPath } = await pathsFor(root);
  const { graph, coordination } = await referenceState(catalog);
  return withLock(executionPolicyPath, () => readJson(executionPolicyPath, catalog.root, normalizePolicy, emptyPolicy), (policy) => {
    const findings = executionPolicyFindingsInternal(policy, graph, coordination);
    if (findings.length) throw new Error(`execution policy failed closed: ${findings.join(", ")}`);
    const previous = policy.grants.find((grant) => grant.id === id);
    if (!previous || !previous.active) throw new Error("execution grant is unknown or already revoked");
    preservePolicy(policy, previous, at);
    policy.revision += 1;
    const grant = { ...previous, active: false, revokedAt: at, revokeReason, revision: policy.revision, updatedAt: at };
    policy.grants = policy.grants.map((item) => item.id === id ? grant : item);
    return { grant, policyRevision: policy.revision, executionPolicyPath };
  });
}
