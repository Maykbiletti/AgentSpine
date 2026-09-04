import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { loadCoordination } from "./coordination.js";
import { loadGraph } from "./graph.js";
import { comparablePath, projectStateDir } from "./paths.js";

export const POLICY_SCHEMA = "agentspine.execution-policy/v1";
export const JOB_SCHEMA = "agentspine.selfstarter/v1";
export const ACTIONS = new Set(["start", "resume", "effect"]);
export const JOB_STATUSES = new Set(["waiting", "running", "blocked", "completed", "cancelled", "exhausted"]);
export const HOSTS = new Set(["claude", "codex"]);
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
export const CAPABILITY_RE = /^tool:[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
export const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const CONFIRMATION = "local-owner-confirmed";
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;

export function workspaceScanError(error) { error.agentSpineScan = true; return error; }

export function configuredHostProfileRoots(env = process.env) {
  return [env.CODEX_HOME, env.BLUN_HOME, env.CLAUDE_CONFIG_DIR, join(homedir(), ".codex"), join(homedir(), ".claude")]
    .filter((value) => typeof value === "string" && value)
    .map((value) => comparablePath(value));
}

export function isConfiguredHostProfileRoot(root, env = process.env) {
  const target = comparablePath(root);
  return configuredHostProfileRoots(env).some((profile) => process.platform === "win32"
    ? profile.toLowerCase() === target.toLowerCase() : profile === target);
}

export function emptyPolicy(root) {
  return { schema: POLICY_SCHEMA, root, revision: 0, grants: [], history: [] };
}

export function emptyJobs(root) {
  return { schema: JOB_SCHEMA, root, jobs: [], history: [], receipts: [] };
}

export function timestamp(value, field = "date", nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

export function stableId(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${field} must be a stable whitespace-free ID`);
  return value;
}

export function safeText(value, field, maximum, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const result = value.trim().slice(0, maximum);
  if (SECRET_RE.test(result)) throw new Error(`${field} appears to contain a secret and cannot enter self-starter state`);
  return result;
}

export function integer(value, field, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

export function capabilities(value) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !CAPABILITY_RE.test(item))) {
    throw new Error("capabilities must contain exact tool:<name> values and cannot use wildcards");
  }
  const unique = [...new Set(value)].sort();
  if (unique.some((item) => item.includes("*"))) throw new Error("capability wildcards are forbidden");
  return unique;
}

export function normalizePolicy(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== POLICY_SCHEMA || value.root !== root
    || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.grants) || !Array.isArray(value.history)) {
    throw new Error("execution policy structure is invalid; self-starter is disabled until repaired");
  }
  return value;
}

export function normalizeJobs(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== JOB_SCHEMA || value.root !== root
    || !Array.isArray(value.jobs) || !Array.isArray(value.history) || !Array.isArray(value.receipts)) {
    throw new Error("self-starter checkpoint structure is invalid; automatic execution is disabled until repaired");
  }
  return value;
}

export async function readJson(path, root, normalize, empty) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("self-starter state exceeds the 5 MiB read limit");
    return normalize(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return empty(root);
  }
}

export async function saveJson(value, path) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("self-starter state exceeds 5 MiB; purge completed jobs first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      return { handle: await open(lockPath, "wx", 0o600), lockPath };
    } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 90000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("self-starter state is busy; retry later");
}

export async function withLock(path, read, operation, save = true) {
  const { handle, lockPath } = await acquireLock(path);
  try {
    const state = await read();
    const result = await operation(state);
    if (save) await saveJson(state, path);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function pathsFor(root, providedCatalog = null) {
  if (isConfiguredHostProfileRoot(root)) {
    throw new Error("self-starter cannot use a host profile as its workspace root");
  }
  let catalog = providedCatalog;
  if (!catalog) {
    try {
      catalog = await buildCatalog(root);
    } catch (error) {
      if (typeof error?.code === "string" && (error.path || error.syscall)) throw workspaceScanError(error);
      throw error;
    }
  }
  const directory = await projectStateDir(catalog.root);
  return {
    catalog,
    executionPolicyPath: join(directory, "execution-policy.json"),
    selfstarterPath: join(directory, "selfstarter.json")
  };
}

export function knownActor(graph, id) {
  return graph.entities.find((entity) => entity.id === id && ["person", "agent"].includes(entity.kind));
}

export function currentTask(coordination, id) {
  return coordination.tasks.find((task) => task.id === id);
}

export async function referenceState(catalog) {
  const [{ graph }, { coordination }] = await Promise.all([
    loadGraph(catalog.root, catalog), loadCoordination(catalog.root, catalog)
  ]);
  return { graph, coordination };
}

export function validateGrantReferences(grant, graph, coordination) {
  const task = currentTask(coordination, grant.taskId);
  return Boolean(knownActor(graph, grant.actorId) && knownActor(graph, grant.targetId) && task
    && task.assigneeId === grant.actorId && task.projectId === grant.projectId && task.groupId === grant.groupId
    && ["open", "in-progress"].includes(task.status));
}

export function executionPolicyFindingsInternal(policy, graph, coordination, { checkCurrentReferences = true } = {}) {
  const findings = [];
  if (policy.schema !== POLICY_SCHEMA || !Number.isInteger(policy.revision) || policy.revision < 0) findings.push("invalid-execution-policy");
  if (new Set(policy.grants.map((grant) => grant.id)).size !== policy.grants.length) findings.push("duplicate-execution-grant-id");
  const records = [
    ...policy.grants.map((grant) => ({ grant, current: true })),
    ...policy.history.map((entry) => entry.value).filter(Boolean).map((grant) => ({ grant, current: false }))
  ];
  for (const { grant, current } of records) {
    const valid = ID_RE.test(grant.id || "") && ID_RE.test(grant.jobId || "") && ID_RE.test(grant.taskId || "")
      && ID_RE.test(grant.actorId || "") && ID_RE.test(grant.targetId || "") && ID_RE.test(grant.projectId || "")
      && (grant.groupId === null || ID_RE.test(grant.groupId || "")) && HOSTS.has(grant.host)
      && JSON.stringify(grant.actions) === JSON.stringify(["effect", "resume", "start"])
      && Array.isArray(grant.capabilities) && grant.capabilities.length > 0
      && JSON.stringify(grant.capabilities) === JSON.stringify([...new Set(grant.capabilities)].sort())
      && grant.capabilities.every((item) => CAPABILITY_RE.test(item) && !item.includes("*"))
      && typeof grant.active === "boolean" && typeof grant.reason === "string" && !SECRET_RE.test(grant.reason)
      && Number.isInteger(grant.revision) && grant.revision > 0 && grant.revision <= policy.revision
      && grant.source === "explicit-local-owner-policy" && grant.authority === "explicit-local-execution-policy"
      && typeof grant.createdAt === "string" && typeof grant.updatedAt === "string"
      && (grant.expiresAt === null || Number.isFinite(new Date(grant.expiresAt).getTime()));
    if (!valid) findings.push(`invalid-execution-grant:${grant.id || "unknown"}`);
    if (checkCurrentReferences && current && grant.active && !validateGrantReferences(grant, graph, coordination)) {
      findings.push(`stale-execution-grant:${grant.id || "unknown"}`);
    }
  }
  if (policy.history.some((entry) => entry.kind !== "execution-grant" || !ID_RE.test(entry.recordId || "")
    || !Number.isFinite(new Date(entry.supersededAt).getTime())
    || entry.authority !== "explicit-local-execution-policy" || !entry.value)) findings.push("invalid-execution-policy-history");
  return findings;
}

export function receiptDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validLease(value) {
  return value === null || (value && ID_RE.test(value.sessionId || "") && HOSTS.has(value.host)
    && Number.isFinite(new Date(value.acquiredAt).getTime()) && Number.isFinite(new Date(value.expiresAt).getTime())
    && new Date(value.expiresAt) > new Date(value.acquiredAt) && DIGEST_RE.test(value.workspaceDigest || ""));
}

export function validPending(value) {
  return value === null || (value && ID_RE.test(value.toolUseId || "") && CAPABILITY_RE.test(value.capability || "")
    && DIGEST_RE.test(value.beforeDigest || "") && Number.isFinite(new Date(value.authorizedAt).getTime())
    && ID_RE.test(value.sessionId || ""));
}

export function validBlocker(value) {
  return value === null || (value && typeof value.code === "string" && value.code.length > 0 && value.code.length <= 128
    && Number.isFinite(new Date(value.at).getTime()) && value.authority === "execution-state-only");
}

export function validJobRecord(job) {
  return job && ID_RE.test(job.id || "") && ID_RE.test(job.taskId || "") && ID_RE.test(job.actorId || "")
    && ID_RE.test(job.targetId || "") && ID_RE.test(job.projectId || "")
    && (job.groupId === null || ID_RE.test(job.groupId || "")) && HOSTS.has(job.host) && JOB_STATUSES.has(job.status)
    && Array.isArray(job.capabilities) && job.capabilities.length > 0
    && JSON.stringify(job.capabilities) === JSON.stringify([...new Set(job.capabilities)].sort())
    && job.capabilities.every((item) => CAPABILITY_RE.test(item) && !item.includes("*"))
    && ID_RE.test(job.grantId || "") && DIGEST_RE.test(job.checkpoint?.workspaceDigest || "")
    && Number.isInteger(job.checkpoint?.sequence) && job.checkpoint.sequence >= 0
    && Number.isInteger(job.checkpoint?.workspaceFiles) && job.checkpoint.workspaceFiles >= 0
    && Number.isInteger(job.checkpoint?.workspaceBytes) && job.checkpoint.workspaceBytes >= 0
    && (job.checkpoint?.lastToolUseId === null || ID_RE.test(job.checkpoint?.lastToolUseId || ""))
    && (job.checkpoint?.resultDigest === null || DIGEST_RE.test(job.checkpoint?.resultDigest || ""))
    && Number.isInteger(job.checkpoint?.retryCount) && job.checkpoint.retryCount >= 0
    && (job.checkpoint?.nextRetryAt === null || Number.isFinite(new Date(job.checkpoint?.nextRetryAt).getTime()))
    && Number.isFinite(new Date(job.checkpoint?.updatedAt).getTime())
    && Number.isInteger(job.maxRetries) && job.maxRetries >= 0 && job.maxRetries <= 10
    && Number.isInteger(job.leaseSeconds) && job.leaseSeconds >= 15 && job.leaseSeconds <= 900
    && Number.isInteger(job.baseRetrySeconds) && job.baseRetrySeconds >= 1 && job.baseRetrySeconds <= 3600
    && validLease(job.lease) && validPending(job.pendingEffect) && validBlocker(job.lastBlocker)
    && job.authority === "execution-state-only" && Number.isFinite(new Date(job.createdAt).getTime())
    && Number.isFinite(new Date(job.updatedAt).getTime());
}

export function validReceipt(receipt) {
  if (!receipt || !ID_RE.test(receipt.id || "") || !ID_RE.test(receipt.jobId || "") || typeof receipt.event !== "string"
    || !Number.isFinite(new Date(receipt.at).getTime()) || !receipt.details || typeof receipt.details !== "object"
    || Array.isArray(receipt.details) || !DIGEST_RE.test(receipt.digest || "") || receipt.authority !== "execution-state-only") return false;
  const { digest, ...material } = receipt;
  return receiptDigest(material) === digest;
}

export function selfstarterFindingsInternal(state, policy, graph, coordination) {
  const findings = [];
  const grants = new Map(policy.grants.map((grant) => [grant.id, grant]));
  if (state.schema !== JOB_SCHEMA) findings.push("invalid-selfstarter-state");
  if (new Set(state.jobs.map((job) => job.id)).size !== state.jobs.length) findings.push("duplicate-job-id");
  for (const job of state.jobs) {
    const grant = grants.get(job.grantId);
    const task = currentTask(coordination, job.taskId);
    if (!validJobRecord(job)) findings.push(`invalid-job:${job.id || "unknown"}`);
    if (!grant || grant.jobId !== job.id || grant.taskId !== job.taskId || grant.actorId !== job.actorId
      || grant.targetId !== job.targetId || grant.projectId !== job.projectId || grant.groupId !== job.groupId
      || grant.host !== job.host || JSON.stringify(grant.capabilities) !== JSON.stringify(job.capabilities)) findings.push(`job-grant-mismatch:${job.id || "unknown"}`);
    if (!task || task.assigneeId !== job.actorId || task.projectId !== job.projectId || task.groupId !== job.groupId) findings.push(`job-task-mismatch:${job.id || "unknown"}`);
  }
  if (state.history.some((entry) => entry.kind !== "selfstarter-job" || !ID_RE.test(entry.recordId || "")
    || typeof entry.event !== "string" || !Number.isFinite(new Date(entry.supersededAt).getTime())
    || entry.authority !== "execution-state-only" || !validJobRecord(entry.value))) findings.push("invalid-job-history");
  if (state.receipts.some((receipt) => !validReceipt(receipt))) findings.push("invalid-job-receipt");
  return findings;
}

export function requireOwnerConfirmation(confirmation) {
  if (confirmation !== CONFIRMATION) throw new Error("self-starter policy changes require explicit local owner confirmation");
}

export function preservePolicy(policy, grant, at) {
  policy.history.push({ kind: "execution-grant", recordId: grant.id, supersededAt: at, value: { ...grant }, authority: "explicit-local-execution-policy" });
}

export function preserveJob(state, job, event, at) {
  state.history.push({ kind: "selfstarter-job", event, recordId: job.id, supersededAt: at, value: structuredClone(job), authority: "execution-state-only" });
}

export function appendReceipt(state, job, id, event, at, details = {}) {
  const existing = state.receipts.find((receipt) => receipt.id === id);
  const material = { id, jobId: job.id, event, at, details, authority: "execution-state-only" };
  const digest = receiptDigest(material);
  if (existing) {
    if (existing.digest !== digest) throw new Error("self-starter receipt collision; execution stopped");
    return { receipt: existing, duplicate: true };
  }
  const receipt = { ...material, digest };
  state.receipts.push(receipt);
  return { receipt, duplicate: false };
}

export function exactGrant(policy, job, action, at) {
  const grant = policy.grants.find((item) => item.id === job.grantId);
  if (!grant || !grant.active || !grant.actions.includes(action)) throw new Error(`default deny: no current exact ${action} grant for ${job.id}`);
  if (grant.expiresAt && new Date(grant.expiresAt) <= new Date(at)) throw new Error(`execution grant expired for ${job.id}`);
  const matches = grant.actorId === job.actorId && grant.jobId === job.id && grant.taskId === job.taskId
    && grant.targetId === job.targetId && grant.projectId === job.projectId && grant.groupId === job.groupId
    && grant.host === job.host && JSON.stringify(grant.capabilities) === JSON.stringify(job.capabilities);
  if (!matches) throw new Error(`execution grant scope mismatch for ${job.id}`);
  return grant;
}

export function ensureScope(job, scope) {
  const matches = job.actorId === scope.actorId && job.projectId === scope.projectId
    && job.groupId === (scope.groupId ?? null) && job.host === scope.host
    && (!scope.taskId || job.taskId === scope.taskId) && (!scope.jobId || job.id === scope.jobId);
  if (!matches) throw new Error(`self-starter scope mismatch for ${job.id}`);
}

export function currentTaskValid(job, coordination) {
  const task = currentTask(coordination, job.taskId);
  return task && task.assigneeId === job.actorId && task.projectId === job.projectId && task.groupId === job.groupId
    && ["open", "in-progress"].includes(task.status);
}

export function leaseExpired(job, at) {
  return job.lease && new Date(job.lease.expiresAt) <= new Date(at);
}

export function blocker(job, code, at) {
  job.status = code === "retry-budget-exhausted" ? "exhausted" : "blocked";
  job.lastBlocker = { code, at, authority: "execution-state-only" };
  job.lease = null;
  job.updatedAt = at;
}

export async function lockedStates(root, operation) {
  const paths = await pathsFor(root);
  const { graph, coordination } = await referenceState(paths.catalog);
  return withLock(paths.executionPolicyPath, () => readJson(paths.executionPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy), (policy) => withLock(
    paths.selfstarterPath,
    () => readJson(paths.selfstarterPath, paths.catalog.root, normalizeJobs, emptyJobs),
    (state) => {
      const findings = [
        ...executionPolicyFindingsInternal(policy, graph, coordination, { checkCurrentReferences: false }),
        ...selfstarterFindingsInternal(state, policy, graph, coordination)
      ];
      if (findings.length) throw new Error(`self-starter failed closed: ${findings.join(", ")}`);
      return operation({ paths, policy, state, graph, coordination });
    }
  ), false);
}

export function resultHash(value) {
  let encoded;
  try { encoded = JSON.stringify(value ?? null); } catch { encoded = "unserializable-result"; }
  return createHash("sha256").update(encoded.slice(0, 65536)).digest("hex");
}
