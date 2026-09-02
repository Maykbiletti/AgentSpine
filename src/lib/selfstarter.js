import { createHash, randomUUID } from "node:crypto";
import { lstat, open, opendir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { loadCoordination } from "./coordination.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";

const POLICY_SCHEMA = "agentspine.execution-policy/v1";
const JOB_SCHEMA = "agentspine.selfstarter/v1";
const ACTIONS = new Set(["start", "resume", "effect"]);
const JOB_STATUSES = new Set(["waiting", "running", "blocked", "completed", "cancelled", "exhausted"]);
const HOSTS = new Set(["claude", "codex"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const CAPABILITY_RE = /^tool:[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 10000;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const CONFIRMATION = "local-owner-confirmed";
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;

function workspaceScanError(error) { error.agentSpineScan = true; return error; }

function emptyPolicy(root) {
  return { schema: POLICY_SCHEMA, root, revision: 0, grants: [], history: [] };
}

function emptyJobs(root) {
  return { schema: JOB_SCHEMA, root, jobs: [], history: [], receipts: [] };
}

function timestamp(value, field = "date", nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function stableId(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${field} must be a stable whitespace-free ID`);
  return value;
}

function safeText(value, field, maximum, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const result = value.trim().slice(0, maximum);
  if (SECRET_RE.test(result)) throw new Error(`${field} appears to contain a secret and cannot enter self-starter state`);
  return result;
}

function integer(value, field, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function capabilities(value) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !CAPABILITY_RE.test(item))) {
    throw new Error("capabilities must contain exact tool:<name> values and cannot use wildcards");
  }
  const unique = [...new Set(value)].sort();
  if (unique.some((item) => item.includes("*"))) throw new Error("capability wildcards are forbidden");
  return unique;
}

function normalizePolicy(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== POLICY_SCHEMA || value.root !== root
    || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.grants) || !Array.isArray(value.history)) {
    throw new Error("execution policy structure is invalid; self-starter is disabled until repaired");
  }
  return value;
}

function normalizeJobs(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== JOB_SCHEMA || value.root !== root
    || !Array.isArray(value.jobs) || !Array.isArray(value.history) || !Array.isArray(value.receipts)) {
    throw new Error("self-starter checkpoint structure is invalid; automatic execution is disabled until repaired");
  }
  return value;
}

async function readJson(path, root, normalize, empty) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("self-starter state exceeds the 5 MiB read limit");
    return normalize(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return empty(root);
  }
}

async function saveJson(value, path) {
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

async function acquireLock(path) {
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

async function withLock(path, read, operation, save = true) {
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

async function pathsFor(root, providedCatalog = null) {
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

function skippableTraversalError(error) {
  return ["EPERM", "EACCES", "ENOENT"].includes(error?.code);
}

function skippedPath(skipped, path, error, operation) {
  skipped.push({ path, code: error.code, operation });
}

export async function collectWorkspaceFiles(root) {
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  async function walk(directory) {
    let stream;
    try {
      stream = await opendir(directory);
    } catch (error) {
      if (!skippableTraversalError(error)) throw workspaceScanError(error);
      skippedPath(skipped, error.path || directory, error, "opendir");
      return;
    }
    const entries = [];
    try {
      for await (const entry of stream) entries.push(entry);
    } catch (error) {
      if (!skippableTraversalError(error)) throw workspaceScanError(error);
      skippedPath(skipped, directory, error, "readdir");
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (!skippableTraversalError(error)) throw workspaceScanError(error);
        skippedPath(skipped, error.path || path, error, "lstat");
        continue;
      }
      if (metadata.isSymbolicLink()) {
        try {
          await realpath(path);
        } catch (error) {
          if (!skippableTraversalError(error)) throw workspaceScanError(error);
          skippedPath(skipped, error.path || path, error, "realpath");
          continue;
        }
        throw new Error(`workspace fingerprint rejects symbolic link: ${relative(root, path)}`);
      }
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) {
        files.push({ path, relativePath: relative(root, path).split(sep).join("/"), size: metadata.size });
        totalBytes += metadata.size;
        if (files.length > MAX_WORKSPACE_FILES || totalBytes > MAX_WORKSPACE_BYTES) {
          throw new Error("workspace exceeds the self-starter fingerprint limit");
        }
      }
    }
  }
  await walk(root);
  return { files, skipped: skipped.sort((a, b) => a.path.localeCompare(b.path) || a.operation.localeCompare(b.operation)) };
}

export async function workspaceFingerprint(inputRoot = process.cwd()) {
  const root = resolve(inputRoot);
  const collected = await collectWorkspaceFiles(root);
  const files = [];
  const skipped = [...collected.skipped];
  const hash = createHash("sha256");
  for (const file of collected.files) {
    let content;
    try {
      content = await readFile(file.path);
    } catch (error) {
      if (!skippableTraversalError(error)) throw workspaceScanError(error);
      skippedPath(skipped, error.path || file.path, error, "readFile");
      continue;
    }
    files.push(file);
    hash.update(file.relativePath).update("\0").update(String(file.size)).update("\0");
    hash.update(content).update("\0");
  }
  return {
    digest: hash.digest("hex"), files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0),
    skipped: skipped.sort((a, b) => a.path.localeCompare(b.path) || a.operation.localeCompare(b.operation))
  };
}

function incompleteWorkspaceScan(skipped) {
  const first = skipped[0];
  const error = new Error(`workspace scan skipped ${skipped.length} inaccessible path${skipped.length === 1 ? "" : "s"}: ${first.path}`);
  error.code = "AGENTSPINE_SCAN_INCOMPLETE";
  error.path = first.path;
  error.syscall = first.operation;
  error.skipped = skipped;
  return error;
}

function knownActor(graph, id) {
  return graph.entities.find((entity) => entity.id === id && ["person", "agent"].includes(entity.kind));
}

function currentTask(coordination, id) {
  return coordination.tasks.find((task) => task.id === id);
}

async function referenceState(catalog) {
  const [{ graph }, { coordination }] = await Promise.all([
    loadGraph(catalog.root, catalog), loadCoordination(catalog.root, catalog)
  ]);
  return { graph, coordination };
}

function validateGrantReferences(grant, graph, coordination) {
  const task = currentTask(coordination, grant.taskId);
  return Boolean(knownActor(graph, grant.actorId) && knownActor(graph, grant.targetId) && task
    && task.assigneeId === grant.actorId && task.projectId === grant.projectId && task.groupId === grant.groupId
    && ["open", "in-progress"].includes(task.status));
}

function executionPolicyFindingsInternal(policy, graph, coordination, { checkCurrentReferences = true } = {}) {
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

function receiptDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validLease(value) {
  return value === null || (value && ID_RE.test(value.sessionId || "") && HOSTS.has(value.host)
    && Number.isFinite(new Date(value.acquiredAt).getTime()) && Number.isFinite(new Date(value.expiresAt).getTime())
    && new Date(value.expiresAt) > new Date(value.acquiredAt) && DIGEST_RE.test(value.workspaceDigest || ""));
}

function validPending(value) {
  return value === null || (value && ID_RE.test(value.toolUseId || "") && CAPABILITY_RE.test(value.capability || "")
    && DIGEST_RE.test(value.beforeDigest || "") && Number.isFinite(new Date(value.authorizedAt).getTime())
    && ID_RE.test(value.sessionId || ""));
}

function validBlocker(value) {
  return value === null || (value && typeof value.code === "string" && value.code.length > 0 && value.code.length <= 128
    && Number.isFinite(new Date(value.at).getTime()) && value.authority === "execution-state-only");
}

function validJobRecord(job) {
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

function validReceipt(receipt) {
  if (!receipt || !ID_RE.test(receipt.id || "") || !ID_RE.test(receipt.jobId || "") || typeof receipt.event !== "string"
    || !Number.isFinite(new Date(receipt.at).getTime()) || !receipt.details || typeof receipt.details !== "object"
    || Array.isArray(receipt.details) || !DIGEST_RE.test(receipt.digest || "") || receipt.authority !== "execution-state-only") return false;
  const { digest, ...material } = receipt;
  return receiptDigest(material) === digest;
}

function selfstarterFindingsInternal(state, policy, graph, coordination) {
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

export async function inspectSelfstarter(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  let policy = emptyPolicy(paths.catalog.root);
  let state = emptyJobs(paths.catalog.root);
  const errors = [];
  try { policy = await readJson(paths.executionPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy); } catch (error) { errors.push(`policy:${error.message}`); }
  try { state = await readJson(paths.selfstarterPath, paths.catalog.root, normalizeJobs, emptyJobs); } catch (error) { errors.push(`state:${error.message}`); }
  return { policy, state, errors, ...paths };
}

function requireOwnerConfirmation(confirmation) {
  if (confirmation !== CONFIRMATION) throw new Error("self-starter policy changes require explicit local owner confirmation");
}

function preservePolicy(policy, grant, at) {
  policy.history.push({ kind: "execution-grant", recordId: grant.id, supersededAt: at, value: { ...grant }, authority: "explicit-local-execution-policy" });
}

function preserveJob(state, job, event, at) {
  state.history.push({ kind: "selfstarter-job", event, recordId: job.id, supersededAt: at, value: structuredClone(job), authority: "execution-state-only" });
}

function appendReceipt(state, job, id, event, at, details = {}) {
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

function exactGrant(policy, job, action, at) {
  const grant = policy.grants.find((item) => item.id === job.grantId);
  if (!grant || !grant.active || !grant.actions.includes(action)) throw new Error(`default deny: no current exact ${action} grant for ${job.id}`);
  if (grant.expiresAt && new Date(grant.expiresAt) <= new Date(at)) throw new Error(`execution grant expired for ${job.id}`);
  const matches = grant.actorId === job.actorId && grant.jobId === job.id && grant.taskId === job.taskId
    && grant.targetId === job.targetId && grant.projectId === job.projectId && grant.groupId === job.groupId
    && grant.host === job.host && JSON.stringify(grant.capabilities) === JSON.stringify(job.capabilities);
  if (!matches) throw new Error(`execution grant scope mismatch for ${job.id}`);
  return grant;
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

function ensureScope(job, scope) {
  const matches = job.actorId === scope.actorId && job.projectId === scope.projectId
    && job.groupId === (scope.groupId ?? null) && job.host === scope.host
    && (!scope.taskId || job.taskId === scope.taskId) && (!scope.jobId || job.id === scope.jobId);
  if (!matches) throw new Error(`self-starter scope mismatch for ${job.id}`);
}

function currentTaskValid(job, coordination) {
  const task = currentTask(coordination, job.taskId);
  return task && task.assigneeId === job.actorId && task.projectId === job.projectId && task.groupId === job.groupId
    && ["open", "in-progress"].includes(task.status);
}

function leaseExpired(job, at) {
  return job.lease && new Date(job.lease.expiresAt) <= new Date(at);
}

function blocker(job, code, at) {
  job.status = code === "retry-budget-exhausted" ? "exhausted" : "blocked";
  job.lastBlocker = { code, at, authority: "execution-state-only" };
  job.lease = null;
  job.updatedAt = at;
}

async function lockedStates(root, operation) {
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

function resultHash(value) {
  let encoded;
  try { encoded = JSON.stringify(value ?? null); } catch { encoded = "unserializable-result"; }
  return createHash("sha256").update(encoded.slice(0, 65536)).digest("hex");
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
