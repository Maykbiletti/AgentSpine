import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { attentionFindings, loadAttention } from "./attention.js";
import {
  channelRuntimeFindings, loadChannelPolicy, loadChannelRuntime
} from "./channel-runtime.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";
import { loadPersonaRuntime, personaRuntimeFindings } from "./persona-runtime.js";
import { evaluateVoiceOutput } from "./voice-runtime.js";

export const GATEWAY_POLICY_SCHEMA = "agentspine.gateway-policy/v1";
export const GATEWAY_RUNTIME_SCHEMA = "agentspine.gateway-runtime/v1";
export const GATEWAY_EVENT_SCHEMA = "agentspine.gateway-event/v1";

const CONFIRMATION = "local-owner-confirmed";
const MAX_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const ROUTE_RE = /^-?[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const GOAL_STATUSES = new Set(["active", "blocked", "completed", "cancelled"]);
const QUEUE_STATUSES = new Set(["pending", "leased", "awaiting-delivery", "completed", "blocked", "dead-letter", "cancelled"]);
const OUTBOX_STATUSES = new Set(["prepared", "sending", "delivered", "failed", "dead-letter", "delivery-unknown", "acknowledged"]);
const WAKE_KINDS = new Set(["direct-message", "deadline", "promise", "resolved-blocker", "assignment", "follow-up", "relationship"]);
const PRIORITY = { "direct-message": 100, deadline: 90, promise: 90, "resolved-blocker": 80, assignment: 70, "follow-up": 60, relationship: 50 };
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;
const SECRET_KEY_RE = /"(?:api[-_ ]?key|token|password|secret|credential)"\s*:/i;
const AUTHORITY_RE = /\b(?:permission|rights?|roles?|owner|trusted|delegat|authorized|approval|production|payment|spending|tool capability|send capability)\b/i;
const HEALTH_VALUES = new Set(["stopped", "running", "unknown", "healthy", "degraded", "failed"]);

function emptyPolicy(root) {
  return { schema: GATEWAY_POLICY_SCHEMA, root, revision: 0, enabled: false, killSwitch: false, goals: [], history: [] };
}

function emptyRuntime(root) {
  return { schema: GATEWAY_RUNTIME_SCHEMA, root, revision: 0, queue: [], lanes: [], outbox: [], receipts: [], history: [],
    health: { gateway: "stopped", adapter: "unknown", scheduler: "unknown", queue: "healthy", worker: "unknown", host: "unknown", lastTickAt: null, lastReconciledAt: null } };
}

function exactId(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("*")) throw new Error(field + " must be an exact stable ID without wildcards");
  return value;
}

function safeText(value, field, maximum = 1000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " is required");
  const text = value.trim().replace(/\s+/g, " ").slice(0, maximum);
  if (SECRET_RE.test(text)) throw new Error(field + " appears to contain a secret");
  return text;
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("timestamp is invalid");
  return date.toISOString();
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function safeCheckpoint(value) {
  if (value === null || value === undefined) return null;
  let content;
  try { content = JSON.stringify(value); } catch { throw new Error("checkpoint must be JSON serializable"); }
  if (!content || Buffer.byteLength(content) > 16384) throw new Error("checkpoint exceeds 16 KiB");
  if (SECRET_RE.test(content) || SECRET_KEY_RE.test(content) || AUTHORITY_RE.test(content)) {
    throw new Error("checkpoint contains secret- or authority-shaped content");
  }
  return JSON.parse(content);
}

function validGoal(goal) {
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
    && Number.isFinite(new Date(goal.updatedAt).getTime());
}

function validPolicyHistory(item) {
  if (!item || item.authority !== "authenticated-goal-policy" || !Number.isFinite(new Date(item.at).getTime())) return false;
  if (item.kind === "goal") return validGoal(item.value);
  return item.kind === "control" && item.value && typeof item.value.enabled === "boolean" && typeof item.value.killSwitch === "boolean";
}

function validQueue(item) {
  return item && ID_RE.test(item.queueId || "") && WAKE_KINDS.has(item.kind)
    && ID_RE.test(item.dedupeKey || "") && item.queueId === "gateway-queue:" + sha256(item.dedupeKey).slice(0, 32)
    && ID_RE.test(item.agentId || "") && ID_RE.test(item.projectId || "")
    && (item.groupId === null || ID_RE.test(item.groupId || ""))
    && (item.goalId === null || ID_RE.test(item.goalId || ""))
    && (item.channelEventId === null || ID_RE.test(item.channelEventId || ""))
    && QUEUE_STATUSES.has(item.status) && Number.isInteger(item.priority) && item.priority >= 0 && item.priority <= 100
    && Number.isInteger(item.attempts) && item.attempts >= 0 && item.attempts <= 20
    && item.authority === "execution-state-only" && Number.isFinite(new Date(item.createdAt).getTime())
    && Number.isFinite(new Date(item.availableAt).getTime()) && Number.isFinite(new Date(item.updatedAt).getTime())
    && (item.completedAt === null || Number.isFinite(new Date(item.completedAt).getTime()))
    && (item.lastError === null || (typeof item.lastError === "string" && item.lastError.length <= 500 && !SECRET_RE.test(item.lastError)))
    && (item.lease === null || (item.status === "leased" && ID_RE.test(item.lease.workerId || "")
      && Number.isFinite(new Date(item.lease.expiresAt).getTime())));
}

function validOutbox(item) {
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

function validLane(item) {
  return item && ID_RE.test(item.agentId || "") && ID_RE.test(item.queueId || "") && ID_RE.test(item.workerId || "")
    && new Set(["leased", "completed", "expired"]).has(item.status)
    && Number.isFinite(new Date(item.claimedAt).getTime()) && Number.isFinite(new Date(item.expiresAt).getTime())
    && Number.isFinite(new Date(item.updatedAt).getTime()) && item.authority === "execution-state-only";
}

function validReceipt(item) {
  if (!(item && ID_RE.test(item.id || "") && ID_RE.test(item.kind || "") && ID_RE.test(item.objectId || "")
    && Number.isFinite(new Date(item.at).getTime()) && item.details && typeof item.details === "object"
    && !Array.isArray(item.details) && !SECRET_RE.test(JSON.stringify(item.details))
    && item.authority === "execution-state-only" && /^[a-f0-9]{64}$/.test(item.digest || ""))) return false;
  const material = { kind: item.kind, objectId: item.objectId, at: item.at, details: item.details, authority: "execution-state-only" };
  return item.digest === sha256(JSON.stringify(material)) && item.id === "gateway-receipt:" + item.digest.slice(0, 24);
}

function validHistory(item) {
  if (!(item && new Set(["queue", "outbox"]).has(item.kind) && ID_RE.test(item.objectId || "")
    && ID_RE.test(item.transition || "") && Number.isFinite(new Date(item.at).getTime())
    && item.value && item.authority === "execution-state-only")) return false;
  return item.kind === "queue" ? validQueue(item.value) && item.objectId === item.value.queueId
    : validOutbox(item.value) && item.objectId === item.value.outboxId;
}

function validHealth(health) {
  return health && ["gateway", "adapter", "scheduler", "queue", "worker", "host"].every((key) => HEALTH_VALUES.has(health[key]))
    && (health.lastTickAt === null || Number.isFinite(new Date(health.lastTickAt).getTime()))
    && (health.lastReconciledAt === null || Number.isFinite(new Date(health.lastReconciledAt).getTime()));
}

function normalizePolicy(value, root) {
  if (!value || value.schema !== GATEWAY_POLICY_SCHEMA || value.root !== root
    || !Number.isInteger(value.revision) || typeof value.enabled !== "boolean" || typeof value.killSwitch !== "boolean"
    || !Array.isArray(value.goals) || !Array.isArray(value.history) || value.goals.some((item) => !validGoal(item))
    || value.history.some((item) => !validPolicyHistory(item))) {
    throw new Error("gateway policy is invalid; autonomous runtime is disabled");
  }
  return value;
}

function normalizeRuntime(value, root) {
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
  if (queueIndex >= 0) invalid.push("queue:" + queueIndex);
  if (laneIndex >= 0) invalid.push("lanes:" + laneIndex);
  if (outboxIndex >= 0) invalid.push("outbox:" + outboxIndex);
  if (receiptIndex >= 0) invalid.push("receipts:" + receiptIndex);
  if (historyIndex >= 0) invalid.push("history:" + historyIndex);
  if (invalid.length) throw new Error("gateway runtime is invalid (" + invalid.join(",") + "); worker is disabled");
  return value;
}

async function pathsFor(root, catalog = null) {
  catalog ||= await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return { catalog, directory, gatewayPolicyPath: join(directory, "gateway-policy.json"), gatewayRuntimePath: join(directory, "gateway-runtime.json") };
}

async function readJson(path, root, normalize, empty) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_BYTES) throw new Error("gateway state exceeds 8 MiB");
    return normalize(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return empty(root);
  }
}

async function writeJson(path, value) {
  const content = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("gateway state exceeds 8 MiB");
  const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
  try { await writeFile(temporary, content, { mode: 0o600 }); await replaceFileWithRetry(temporary, path); }
  finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function withLock(paths, task) {
  const lockPath = join(paths.directory, "gateway-runtime.lock");
  let handle;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { handle = await open(lockPath, "wx", 0o600); break; } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try { const metadata = await stat(lockPath); if (Date.now() - metadata.mtimeMs > 120000) await unlink(lockPath); }
      catch (lockError) { if (lockError.code !== "ENOENT") throw lockError; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("gateway state is busy; retry later");
  try { return await task(); } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function appendReceipt(runtime, kind, objectId, now, details = {}) {
  const material = { kind, objectId, at: now, details, authority: "execution-state-only" };
  const digest = sha256(JSON.stringify(material));
  const id = "gateway-receipt:" + digest.slice(0, 24);
  const previous = runtime.receipts.find((item) => item.id === id);
  if (previous) return previous;
  const receipt = { id, ...material, digest };
  runtime.receipts.push(receipt);
  return receipt;
}

function preserve(runtime, kind, value, transition, now) {
  runtime.history.push({ kind, objectId: kind === "outbox" ? value.outboxId : value.queueId, transition, at: now,
    value: structuredClone(value), authority: "execution-state-only" });
}

function currentLane(runtime, agentId) {
  return runtime.lanes.find((item) => item.agentId === agentId && item.status === "leased") || null;
}

function assertActivePersona(personaPolicy, personaRuntime, agentId, projectId, groupId) {
  const findings = personaRuntimeFindings(personaPolicy, personaRuntime);
  if (findings.length) throw new Error("persona runtime is unhealthy: " + findings.join(", "));
  const persona = personaRuntime.personas.find((item) => item.personaId === agentId && item.status === "active");
  if (!persona || !["agent", "bot"].includes(persona.kind)) throw new Error("gateway work requires an active authenticated agent or bot");
  if (groupId !== null && persona.groupId !== groupId) throw new Error("gateway work group does not match authenticated persona membership");
  const binding = personaPolicy.bindings.find((item) => item.id === persona.bindingId && item.active);
  if (!binding || !binding.tenantId || !binding.profileId || !projectId) throw new Error("gateway work lacks an active authenticated identity binding");
  return { persona, binding };
}

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
  priority = 70, successCriterion, nextSafeStep, deadline = null, confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("goal assignment requires explicit local owner confirmation");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    agentId = exactId(agentId, "agentId"); projectId = exactId(projectId, "projectId"); groupId = exactId(groupId, "groupId", true);
    assertActivePersona(personas.policy, personas.runtime, agentId, projectId, groupId);
    const createdAt = timestamp(now);
    const active = policy.goals.find((item) => item.agentId === agentId && item.status === "active" && item.goalId !== goalId);
    if (active) throw new Error("an agent may have only one active focused goal");
    const goal = { goalId: exactId(goalId, "goalId"), agentId, ownerSubjectId: exactId(ownerSubjectId, "ownerSubjectId"),
      projectId, groupId, priority: Number(priority), successCriterion: safeText(successCriterion, "successCriterion"),
      nextSafeStep: safeText(nextSafeStep, "nextSafeStep"), deadline: deadline === null ? null : timestamp(deadline),
      status: "active", checkpoint: null, heartbeatAt: null, blocker: null, createdAt, updatedAt: createdAt,
      authority: "authenticated-goal-policy" };
    if (!validGoal(goal)) throw new Error("goal assignment is invalid");
    const previous = policy.goals.find((item) => item.goalId === goal.goalId);
    if (previous && [previous.agentId, previous.ownerSubjectId, previous.projectId, previous.groupId].join("\0")
      !== [goal.agentId, goal.ownerSubjectId, goal.projectId, goal.groupId].join("\0")) throw new Error("goal scope is immutable");
    if (previous) {
      policy.history.push({ kind: "goal", at: createdAt, value: structuredClone(previous), authority: "authenticated-goal-policy" });
      goal.createdAt = previous.createdAt;
    }
    policy.goals = policy.goals.filter((item) => item.goalId !== goal.goalId);
    policy.goals.push(goal);
    policy.revision += 1;
    const key = "goal:" + goal.goalId + ":assignment";
    if (!runtime.queue.some((item) => item.dedupeKey === key)) {
      runtime.queue.push({ queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind: "assignment",
        agentId, projectId, groupId, goalId: goal.goalId, channelEventId: null, priority: PRIORITY.assignment,
        status: "pending", attempts: 0, lease: null, availableAt: createdAt, createdAt, updatedAt: createdAt,
        completedAt: null, lastError: null, authority: "execution-state-only" });
      runtime.revision += 1;
      appendReceipt(runtime, "queued", "gateway-queue:" + sha256(key).slice(0, 32), createdAt, { kind: "assignment", dedupeKey: key });
    }
    await Promise.all([writeJson(paths.gatewayPolicyPath, policy), writeJson(paths.gatewayRuntimePath, runtime)]);
    return { goal, gatewayPolicyPath: paths.gatewayPolicyPath };
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
      goalId, channelEventId, priority: PRIORITY[kind], status: "pending", attempts: 0, lease: null,
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
    for (const lane of runtime.lanes.filter((item) => item.status === "leased" && new Date(item.expiresAt) <= new Date(current))) {
      const item = runtime.queue.find((entry) => entry.queueId === lane.queueId && entry.status === "leased");
      if (item) { preserve(runtime, "queue", item, "lease-expired", current); item.status = item.attempts >= 3 ? "dead-letter" : "pending"; item.lease = null; item.updatedAt = current; }
      lane.status = "expired"; lane.updatedAt = current;
    }
    for (const outbox of runtime.outbox.filter((item) => item.status === "sending")) {
      preserve(runtime, "outbox", outbox, "ambiguous-send-recovery", current);
      outbox.status = "delivery-unknown"; outbox.updatedAt = current;
      appendReceipt(runtime, "delivery-unknown", outbox.outboxId, current, { reason: "crash-during-send" });
    }
    if (policy.enabled && !policy.killSwitch) {
      for (const goal of policy.goals.filter((item) => item.status === "active" && item.deadline
        && new Date(item.deadline) <= new Date(current))) {
        try { assertActivePersona(personas.policy, personas.runtime, goal.agentId, goal.projectId, goal.groupId); }
        catch { continue; }
        const key = "goal:" + goal.goalId + ":deadline:" + goal.deadline;
        if (!runtime.queue.some((item) => item.dedupeKey === key)) runtime.queue.push({
          queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind: "deadline",
          agentId: goal.agentId, projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
          channelEventId: null, priority: PRIORITY.deadline, status: "pending", attempts: 0, lease: null,
          availableAt: current, createdAt: current, updatedAt: current, completedAt: null, lastError: null,
          authority: "execution-state-only"
        });
      }
      for (const event of channel.runtime.events.filter((item) => item.status === "pending")) {
        if (!personas.runtime.personas.some((persona) => persona.personaId === event.agentId && persona.status === "active")) continue;
        const key = "channel:" + event.eventId;
        if (!runtime.queue.some((item) => item.dedupeKey === key)) runtime.queue.push({ queueId: "gateway-queue:" + sha256(key).slice(0, 32),
          dedupeKey: key, kind: "direct-message", agentId: event.agentId, projectId: event.projectId, groupId: event.groupId,
          goalId: null, channelEventId: event.eventId, priority: PRIORITY["direct-message"], status: "pending", attempts: 0,
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
          goalId: null, channelEventId: null, priority: PRIORITY[kind], status: "pending", attempts: 0, lease: null,
          availableAt: event.dueAt || current, createdAt: current, updatedAt: current, completedAt: null, lastError: null, authority: "execution-state-only" });
      }
    }
    runtime.health.gateway = policy.enabled && !policy.killSwitch ? "running" : "stopped";
    runtime.health.scheduler = "healthy"; runtime.health.queue = "healthy"; runtime.health.lastReconciledAt = current;
    runtime.revision += 1;
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { policy, runtime, recovered: true };
  });
}

export async function claimGatewayWork({ root = process.cwd(), workerId, leaseSeconds = 120, now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) return { item: null, reason: "disabled" };
    const current = timestamp(now); workerId = exactId(workerId, "workerId");
    const seconds = Number(leaseSeconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 900) throw new Error("leaseSeconds must be 15-900");
    const items = runtime.queue.filter((item) => item.status === "pending" && new Date(item.availableAt) <= new Date(current)
      && !currentLane(runtime, item.agentId));
    items.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.queueId.localeCompare(b.queueId));
    let item = null; let revoked = false;
    for (const candidate of items) {
      try {
        assertActivePersona(personas.policy, personas.runtime, candidate.agentId, candidate.projectId, candidate.groupId);
        item = candidate;
        break;
      } catch {
        preserve(runtime, "queue", candidate, "identity-revoked", current);
        candidate.status = "cancelled"; candidate.completedAt = current; candidate.updatedAt = current;
        appendReceipt(runtime, "identity-revoked", candidate.queueId, current, {});
        runtime.revision += 1; revoked = true;
      }
    }
    if (!item && revoked) await writeJson(paths.gatewayRuntimePath, runtime);
    if (!item) return { item: null, reason: runtime.queue.some((entry) => entry.status === "pending") ? "waiting" : "idle/needs-goal" };
    preserve(runtime, "queue", item, "leased", current);
    item.status = "leased"; item.attempts += 1; item.updatedAt = current;
    item.lease = { workerId, claimedAt: current, expiresAt: new Date(new Date(current).getTime() + seconds * 1000).toISOString() };
    runtime.lanes = runtime.lanes.filter((lane) => lane.agentId !== item.agentId || lane.status !== "leased");
    runtime.lanes.push({ agentId: item.agentId, queueId: item.queueId, workerId, status: "leased", claimedAt: current,
      expiresAt: item.lease.expiresAt, updatedAt: current, authority: "execution-state-only" });
    runtime.health.worker = "healthy"; runtime.health.lastTickAt = current; runtime.revision += 1;
    const receipt = appendReceipt(runtime, "leased", item.queueId, current, { workerId, attempt: item.attempts });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item: structuredClone(item), receipt };
  });
}

function exactReplyBinding(channelPolicy, event) {
  const binding = channelPolicy.bindings.find((item) => item.id === event.bindingId && item.status === "active"
    && item.agentId === event.agentId && item.projectId === event.projectId && item.groupId === event.groupId
    && item.provider === event.provider && item.tenantId === event.tenantId && item.accountId === event.accountId
    && item.chatId === event.chatId && item.threadId === event.threadId && item.capabilities.includes("reply"));
  if (!binding) throw new Error("current exact channel reply capability is unavailable");
  return binding;
}

export async function completeGatewayRun({ root = process.cwd(), queueId, workerId, result, now = new Date() }) {
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
    if (!item || item.status !== "leased" || item.lease?.workerId !== workerId) throw new Error("run completion requires the exact active queue lease");
    assertActivePersona(personas.policy, personas.runtime, item.agentId, item.projectId, item.groupId);
    const current = timestamp(now);
    const lane = runtime.lanes.find((entry) => entry.queueId === item.queueId && entry.workerId === workerId && entry.status === "leased");
    if (!lane) throw new Error("agent lane lease is missing");
    const text = result?.text ? safeText(result.text, "result.text", 16000) : null;
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
      item.status = result?.blocked ? "blocked" : "completed"; item.completedAt = current;
      const goal = item.goalId ? policy.goals.find((entry) => entry.goalId === item.goalId) : null;
      if (goal) {
        policy.history.push({ kind: "goal", at: current, value: structuredClone(goal), authority: "authenticated-goal-policy" });
        goal.checkpoint = result?.checkpoint === undefined ? goal.checkpoint : safeCheckpoint(result.checkpoint); goal.heartbeatAt = current;
        goal.blocker = result?.blocked ? safeText(result.blocker || "Run blocked.", "blocker", 500) : null;
        goal.status = result?.completed ? "completed" : result?.blocked ? "blocked" : "active"; goal.updatedAt = current;
        policy.revision += 1;
        if (goal.status === "active") {
          const checkpointDigest = sha256(JSON.stringify(goal.checkpoint || { heartbeatAt: current })).slice(0, 20);
          const key = "goal:" + goal.goalId + ":follow-up:" + checkpointDigest;
          if (!runtime.queue.some((entry) => entry.dedupeKey === key)) runtime.queue.push({
            queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind: "follow-up",
            agentId: goal.agentId, projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
            channelEventId: null, priority: PRIORITY["follow-up"], status: "pending", attempts: 0, lease: null,
            availableAt: new Date(new Date(current).getTime() + 60000).toISOString(), createdAt: current, updatedAt: current,
            completedAt: null, lastError: null, authority: "execution-state-only"
          });
        }
      }
    }
    item.lease = null; item.updatedAt = current; lane.status = "completed"; lane.updatedAt = current;
    runtime.health.host = "healthy"; runtime.health.worker = "healthy"; runtime.health.lastTickAt = current;
    appendReceipt(runtime, "run-terminal", item.queueId, current, { status: item.status }); runtime.revision += 1;
    await Promise.all([writeJson(paths.gatewayPolicyPath, policy), writeJson(paths.gatewayRuntimePath, runtime)]);
    return { item, outbox: runtime.outbox.find((entry) => entry.queueId === item.queueId) || null };
  });
}

export async function failGatewayRun({ root = process.cwd(), queueId, workerId, error, retryAfterMs = 5000,
  now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
    ]);
    const item = runtime.queue.find((entry) => entry.queueId === exactId(queueId, "queueId"));
    workerId = exactId(workerId, "workerId");
    if (!item || item.status !== "leased" || item.lease?.workerId !== workerId) {
      throw new Error("run failure requires the exact active queue lease");
    }
    const lane = runtime.lanes.find((entry) => entry.queueId === item.queueId && entry.workerId === workerId
      && entry.status === "leased");
    if (!lane) throw new Error("agent lane lease is missing");
    const current = timestamp(now);
    const message = safeText(String(error || "host runtime unavailable"), "runError", 500);
    const delay = Number(retryAfterMs);
    if (!Number.isFinite(delay) || delay < 250 || delay > 300000) throw new Error("retryAfterMs must be 250-300000");
    preserve(runtime, "queue", item, "run-failed", current);
    item.status = item.attempts >= 3 ? "dead-letter" : "pending";
    item.lease = null; item.lastError = message; item.updatedAt = current;
    item.availableAt = new Date(new Date(current).getTime() + delay).toISOString();
    if (item.status === "dead-letter") item.completedAt = current;
    lane.status = "completed"; lane.updatedAt = current;
    runtime.health.host = "failed"; runtime.health.worker = "degraded"; runtime.health.lastTickAt = current;
    runtime.revision += 1;
    const receipt = appendReceipt(runtime, item.status === "dead-letter" ? "run-dead-letter" : "run-retry",
      item.queueId, current, { attempt: item.attempts });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item, receipt, policyEnabled: policy.enabled && !policy.killSwitch };
  });
}

export async function deliverPrepared({ root = process.cwd(), outboxId, adapter, now = new Date() }) {
  if (!adapter || typeof adapter.send !== "function") throw new Error("delivery adapter is unavailable");
  const paths = await pathsFor(root);
  let prepared;
  await withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channelRuntime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway was disabled before delivery");
    const outbox = runtime.outbox.find((item) => item.outboxId === exactId(outboxId, "outboxId"));
    if (!outbox) throw new Error("unknown outbox item");
    if (["delivered", "acknowledged"].includes(outbox.status)) { prepared = { duplicate: true, outbox: structuredClone(outbox) }; return; }
    if (outbox.status !== "prepared" && outbox.status !== "failed") throw new Error("outbox item is not safely retryable");
    if (new Date(outbox.nextAttemptAt) > new Date(timestamp(now))) throw new Error("outbox retry is not due");
    const event = channelRuntime.runtime.events.find((item) => item.eventId === outbox.eventId);
    if (!event) throw new Error("outbox channel event is missing");
    try {
      assertActivePersona(personas.policy, personas.runtime, event.agentId, event.projectId, event.groupId);
      exactReplyBinding(channelPolicy.policy, event);
    }
    catch (error) {
      const current = timestamp(now);
      preserve(runtime, "outbox", outbox, "capability-revoked", current);
      outbox.status = "dead-letter"; outbox.lastError = safeText(error.message, "adapterError", 500);
      outbox.updatedAt = current;
      const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
      if (queue) { queue.status = "dead-letter"; queue.completedAt = current; queue.updatedAt = current; }
      runtime.health.adapter = "failed"; runtime.revision += 1;
      const receipt = appendReceipt(runtime, "dead-letter", outbox.outboxId, current, { reason: "identity-or-capability-revoked" });
      await writeJson(paths.gatewayRuntimePath, runtime);
      prepared = { duplicate: false, terminal: true, outbox: structuredClone(outbox), receipt };
      return;
    }
    preserve(runtime, "outbox", outbox, "sending", timestamp(now));
    outbox.status = "sending"; outbox.attempts += 1; outbox.updatedAt = timestamp(now); runtime.revision += 1;
    appendReceipt(runtime, "sending", outbox.outboxId, outbox.updatedAt, { attempt: outbox.attempts });
    await writeJson(paths.gatewayRuntimePath, runtime);
    prepared = { duplicate: false, outbox: structuredClone(outbox) };
  });
  if (prepared.duplicate || prepared.terminal) return prepared;
  let outcome;
  try { outcome = await adapter.send(structuredClone(prepared.outbox)); }
  catch (error) { outcome = { ok: false, effect: "unknown", error: error.message }; }
  return withLock(paths, async () => {
    const runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime);
    const outbox = runtime.outbox.find((item) => item.outboxId === prepared.outbox.outboxId);
    if (!outbox || outbox.status !== "sending") throw new Error("outbox sending state changed unexpectedly");
    const current = timestamp(now);
    preserve(runtime, "outbox", outbox, outcome?.ok ? "delivered" : "send-failed", current);
    if (outcome?.ok) {
      outbox.status = "delivered"; outbox.deliveredAt = current; outbox.adapterReceipt = safeText(String(outcome.receipt || "delivered"), "adapterReceipt", 500);
      runtime.health.adapter = "healthy";
      const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
      if (queue) { queue.status = "completed"; queue.completedAt = current; queue.updatedAt = current; }
    } else if (outcome?.effect === "none") {
      outbox.status = outbox.attempts < 3 ? "failed" : "dead-letter";
      outbox.lastError = safeText(String(outcome.error || "adapter failure"), "adapterError", 500);
      runtime.health.adapter = outbox.status === "failed" ? "degraded" : "failed";
      if (outbox.status === "failed") {
        const delay = Math.min(300000, Number(outcome.retryAfterMs) || 1000 * (2 ** outbox.attempts));
        outbox.nextAttemptAt = new Date(new Date(current).getTime() + delay).toISOString();
      } else {
        const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
        if (queue) { queue.status = "dead-letter"; queue.completedAt = current; queue.updatedAt = current; }
      }
    } else {
      outbox.status = "delivery-unknown"; outbox.lastError = safeText(String(outcome?.error || "delivery outcome is ambiguous"), "adapterError", 500);
      runtime.health.adapter = "failed";
    }
    outbox.updatedAt = current; runtime.revision += 1;
    const receipt = appendReceipt(runtime, outbox.status, outbox.outboxId, current, { adapterReceipt: outbox.adapterReceipt });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { outbox, receipt, duplicate: false };
  });
}

export async function updateGatewayHealth({ root = process.cwd(), worker = null, adapter = null, host = null,
  now = new Date() } = {}) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime);
    for (const [key, value] of Object.entries({ worker, adapter, host })) {
      if (value !== null) {
        if (!HEALTH_VALUES.has(value)) throw new Error("unsupported gateway health value");
        runtime.health[key] = value;
      }
    }
    runtime.health.lastTickAt = timestamp(now); runtime.revision += 1;
    await writeJson(paths.gatewayRuntimePath, runtime);
    return structuredClone(runtime.health);
  });
}

export async function loadGatewayRuntime(root = process.cwd(), catalog = null) {
  const paths = await pathsFor(root, catalog);
  const [policy, runtime] = await Promise.all([
    readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
    readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
  ]);
  return { policy, runtime, ...paths };
}

export async function inspectGatewayRuntime(root = process.cwd(), catalog = null) {
  const paths = await pathsFor(root, catalog); const errors = [];
  let policy = emptyPolicy(paths.catalog.root); let runtime = emptyRuntime(paths.catalog.root);
  try { policy = await readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy); } catch (error) { errors.push("policy:" + error.message); }
  try { runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime); } catch (error) { errors.push("runtime:" + error.message); }
  return { policy, runtime, errors, ...paths };
}

export function gatewayRuntimeFindings(policy, runtime) {
  const findings = [];
  const active = new Set();
  const goalIds = new Set();
  for (const goal of policy.goals) {
    if (!validGoal(goal)) findings.push("invalid-goal:" + (goal?.goalId || "unknown"));
    if (goalIds.has(goal.goalId)) findings.push("duplicate-goal:" + goal.goalId);
    goalIds.add(goal.goalId);
    if (goal.status === "active" && active.has(goal.agentId)) findings.push("multiple-active-goals:" + goal.agentId);
    if (goal.status === "active") active.add(goal.agentId);
  }
  for (const item of policy.history) if (!validPolicyHistory(item)) findings.push("invalid-gateway-policy-history");
  const queueIds = new Set(); const dedupeKeys = new Set();
  for (const item of runtime.queue) {
    if (!validQueue(item)) findings.push("invalid-queue-item:" + (item?.queueId || "unknown"));
    if (queueIds.has(item.queueId)) findings.push("duplicate-queue-item:" + item.queueId);
    if (dedupeKeys.has(item.dedupeKey)) findings.push("duplicate-queue-dedupe:" + item.dedupeKey);
    queueIds.add(item.queueId); dedupeKeys.add(item.dedupeKey);
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
    if (!queue || (lane.status === "leased" && (queue.status !== "leased" || queue.lease?.workerId !== lane.workerId))) {
      findings.push("agent-lane-queue-mismatch:" + (lane.queueId || "unknown"));
    }
  }
  if (new Set(leased.map((item) => item.agentId)).size !== leased.length) findings.push("duplicate-agent-lane");
  if (!validHealth(runtime.health)) findings.push("invalid-gateway-health");
  return findings;
}

export function gatewayHealthFindings(policy, runtime, { now = new Date(), staleAfterMs = 180000 } = {}) {
  if (!policy.enabled || policy.killSwitch) return [];
  const findings = [];
  if (runtime.health.gateway !== "running") findings.push("gateway-not-running");
  if (runtime.health.scheduler !== "healthy") findings.push("scheduler-not-healthy");
  if (runtime.health.queue !== "healthy") findings.push("queue-not-healthy");
  if (!new Set(["healthy", "degraded"]).has(runtime.health.worker)) findings.push("worker-not-healthy");
  if (!new Set(["healthy", "degraded"]).has(runtime.health.adapter)) findings.push("adapter-not-healthy");
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
  const goals = policy.goals.filter((item) => agentId === null || item.agentId === exactId(agentId, "agentId"));
  const queue = runtime.queue.filter((item) => agentId === null || item.agentId === exactId(agentId, "agentId"));
  const queueIds = new Set(queue.map((item) => item.queueId));
  return { schema: "agentspine.gateway-context/v1", enabled: policy.enabled, killSwitch: policy.killSwitch,
    goals: structuredClone(goals), queue: structuredClone(queue),
    outbox: structuredClone(runtime.outbox.filter((item) => queueIds.has(item.queueId))),
    health: structuredClone(runtime.health), healthFindings: gatewayHealthFindings(policy, runtime),
    authority: "execution-state-only" };
}
