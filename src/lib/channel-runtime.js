import {
  createHash, createHmac, randomUUID, timingSafeEqual
} from "node:crypto";
import {
  open, readFile, rename, stat, unlink, writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention } from "./filesystem-retry.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";

const POLICY_SCHEMA = "agentspine.channel-policy/v1";
const RUNTIME_SCHEMA = "agentspine.channel-runtime/v1";
const EVENT_SCHEMA = "agentspine.channel-event/v1";
const CONFIRMATION = "local-owner-confirmed";
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const ROUTE_ID_RE = /^[A-Za-z0-9_+~-][A-Za-z0-9:_.@/+~-]{0,255}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{2,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SIGNATURE_RE = /^sha256=([a-f0-9]{64})$/;
const PRIVACY = new Set(["private", "shared", "group"]);
const CAPABILITIES = new Set(["receive", "reply"]);
const BINDING_STATUSES = new Set(["active", "revoked"]);
const EVENT_STATUSES = new Set(["pending", "leased", "completed", "failed", "cancelled"]);
const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
const INBOUND_FIELDS = new Set([
  "schema", "eventId", "provider", "tenantId", "accountId", "chatId", "threadId",
  "senderId", "replyTo", "observedAt", "privacy", "text"
]);
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret|passwort|geheimnis)\s*[:=]\s*\S{8,}/i;

function emptyPolicy(root) {
  return { schema: POLICY_SCHEMA, root, revision: 0, bindings: [], history: [] };
}

function emptyRuntime(root) {
  return { schema: RUNTIME_SCHEMA, root, events: [], history: [], receipts: [] };
}

function stableId(value, field, { nullable = false, route = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const expression = route ? ROUTE_ID_RE : ID_RE;
  if (typeof value !== "string" || !expression.test(value) || value.includes("*")) {
    throw new Error(`${field} must be an exact stable ID without wildcards`);
  }
  return value;
}

function timestamp(value, field = "timestamp") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function safeText(value, field, maximumBytes = MAX_TEXT_BYTES) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim().replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(normalized) > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} bytes`);
  if (SECRET_RE.test(normalized)) throw new Error(`${field} appears to contain a secret and cannot enter channel state`);
  return normalized;
}

function exactCapabilities(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("channel capabilities are required");
  const unique = [...new Set(value)].sort();
  if (unique.some((item) => !CAPABILITIES.has(item))) throw new Error("channel capabilities may contain only receive and reply");
  if (!unique.includes("receive")) throw new Error("channel bindings must include receive");
  return unique;
}

function exactSenderIds(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("senderIds must contain exact authenticated sender IDs");
  return [...new Set(value.map((item) => stableId(item, "senderId", { route: true })))].sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bindingRoute(binding) {
  return [binding.provider, binding.tenantId, binding.accountId, binding.chatId, binding.threadId || ""].join("\0");
}

function normalizeInboundEvent(value, { inspectContent = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("channel event must be one object");
  const unknown = Object.keys(value).filter((key) => !INBOUND_FIELDS.has(key));
  if (unknown.length) throw new Error(`channel event contains unknown field: ${unknown.sort()[0]}`);
  if (value.schema !== EVENT_SCHEMA) throw new Error(`channel event schema must be ${EVENT_SCHEMA}`);
  if (!PRIVACY.has(value.privacy)) throw new Error("channel event privacy must be private, shared, or group");
  const text = inspectContent ? safeText(value.text, "channel event text") : String(value.text ?? "").trim().replace(/\r\n?/g, "\n");
  if (!text || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error(`channel event text must be 1-${MAX_TEXT_BYTES} bytes`);
  return {
    schema: EVENT_SCHEMA,
    eventId: stableId(value.eventId, "eventId"),
    provider: stableId(value.provider, "provider", { route: true }),
    tenantId: stableId(value.tenantId, "tenantId", { route: true }),
    accountId: stableId(value.accountId, "accountId", { route: true }),
    chatId: stableId(value.chatId, "chatId", { route: true }),
    threadId: stableId(value.threadId, "threadId", { nullable: true, route: true }),
    senderId: stableId(value.senderId, "senderId", { route: true }),
    replyTo: stableId(value.replyTo, "replyTo", { nullable: true, route: true }),
    observedAt: timestamp(value.observedAt, "observedAt"),
    privacy: value.privacy,
    text
  };
}

export function channelEventSigningPayload(event) {
  return JSON.stringify(normalizeInboundEvent(event));
}

function validBinding(binding) {
  return binding && ID_RE.test(binding.id || "") && BINDING_STATUSES.has(binding.status)
    && ROUTE_ID_RE.test(binding.provider || "") && ROUTE_ID_RE.test(binding.tenantId || "")
    && ROUTE_ID_RE.test(binding.accountId || "") && ROUTE_ID_RE.test(binding.chatId || "")
    && (binding.threadId === null || ROUTE_ID_RE.test(binding.threadId || ""))
    && Array.isArray(binding.senderIds) && binding.senderIds.length > 0
    && binding.senderIds.every((id) => ROUTE_ID_RE.test(id) && !id.includes("*"))
    && ID_RE.test(binding.agentId || "") && ID_RE.test(binding.projectId || "")
    && (binding.groupId === null || ID_RE.test(binding.groupId || ""))
    && ID_RE.test(binding.sessionKey || "") && ENV_RE.test(binding.secretEnv || "")
    && (binding.outboundSecretEnv === null || ENV_RE.test(binding.outboundSecretEnv || ""))
    && Array.isArray(binding.capabilities) && binding.capabilities.includes("receive")
    && binding.capabilities.every((item) => CAPABILITIES.has(item))
    && binding.authority === "explicit-local-channel-policy"
    && Number.isFinite(new Date(binding.createdAt).getTime())
    && Number.isFinite(new Date(binding.updatedAt).getTime())
    && (binding.revokedAt === null || Number.isFinite(new Date(binding.revokedAt).getTime()));
}

function validEvent(event) {
  return event && event.schema === EVENT_SCHEMA && ID_RE.test(event.eventId || "")
    && ID_RE.test(event.bindingId || "") && ROUTE_ID_RE.test(event.provider || "")
    && ROUTE_ID_RE.test(event.tenantId || "") && ROUTE_ID_RE.test(event.accountId || "")
    && ROUTE_ID_RE.test(event.chatId || "") && (event.threadId === null || ROUTE_ID_RE.test(event.threadId || ""))
    && ROUTE_ID_RE.test(event.senderId || "") && (event.replyTo === null || ROUTE_ID_RE.test(event.replyTo || ""))
    && ID_RE.test(event.agentId || "") && ID_RE.test(event.projectId || "")
    && (event.groupId === null || ID_RE.test(event.groupId || "")) && ID_RE.test(event.sessionKey || "")
    && PRIVACY.has(event.privacy) && typeof event.text === "string" && event.text.length > 0
    && Buffer.byteLength(event.text) <= MAX_TEXT_BYTES && !SECRET_RE.test(event.text)
    && EVENT_STATUSES.has(event.status) && Number.isInteger(event.attempts) && event.attempts >= 0
    && event.authority === "execution-state-only" && DIGEST_RE.test(event.payloadDigest || "")
    && Number.isFinite(new Date(event.observedAt).getTime()) && Number.isFinite(new Date(event.receivedAt).getTime())
    && (event.completedAt === null || Number.isFinite(new Date(event.completedAt).getTime()))
    && (event.lease === null || (
      event.status === "leased" && ID_RE.test(event.lease.workerId || "")
      && Number.isFinite(new Date(event.lease.claimedAt).getTime())
      && Number.isFinite(new Date(event.lease.expiresAt).getTime())
    ));
}

function validReceipt(receipt) {
  if (!(receipt && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.eventId || "")
    && typeof receipt.event === "string" && DIGEST_RE.test(receipt.digest || "")
    && Number.isFinite(new Date(receipt.at).getTime()) && receipt.authority === "execution-state-only")) return false;
  const { id, digest, ...material } = receipt;
  return id === `channel-receipt:${digest.slice(0, 24)}` && sha256(JSON.stringify(material)) === digest;
}

function validPolicyHistory(record) {
  return record && record.kind === "channel-binding" && ID_RE.test(record.recordId || "")
    && record.recordId === record.value?.id && validBinding(record.value)
    && Number.isFinite(new Date(record.supersededAt).getTime())
    && record.authority === "explicit-local-channel-policy";
}

function validRuntimeHistory(record) {
  return record && record.kind === "channel-event" && ID_RE.test(record.recordId || "")
    && record.recordId === record.value?.eventId && validEvent(record.value)
    && typeof record.transition === "string" && record.transition.length > 0
    && Number.isFinite(new Date(record.supersededAt).getTime())
    && record.authority === "execution-state-only";
}

function validPayloadDigest(event) {
  if (!validEvent(event)) return false;
  const inbound = Object.fromEntries([...INBOUND_FIELDS].map((field) => [field, event[field]]));
  return sha256(channelEventSigningPayload(inbound)) === event.payloadDigest;
}

function normalizePolicy(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== POLICY_SCHEMA
    || value.root !== root || !Number.isInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.bindings) || !Array.isArray(value.history)) {
    throw new Error("channel policy structure is invalid; channel runtime is disabled until repaired");
  }
  return value;
}

function normalizeRuntime(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== RUNTIME_SCHEMA
    || value.root !== root || !Array.isArray(value.events) || !Array.isArray(value.history)
    || !Array.isArray(value.receipts)) {
    throw new Error("channel runtime structure is invalid; channel processing is disabled until repaired");
  }
  return value;
}

async function readJson(path, root, normalize, empty) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("channel state exceeds the 5 MiB read limit");
    return normalize(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return empty(root);
  }
}

async function writeJson(path, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("channel state exceeds 5 MiB; purge terminal events first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (attempt >= 5 || !["EACCES", "EPERM"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function pathsFor(root, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return {
    catalog, directory,
    channelPolicyPath: join(directory, "channel-policy.json"),
    channelRuntimePath: join(directory, "channel-runtime.json")
  };
}

async function withChannelLock(paths, task) {
  const lockPath = join(paths.directory, "channel-runtime.lock");
  let handle;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 90000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("channel state is busy; retry later");
  try {
    return await task();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function requireConfirmation(value) {
  if (value !== CONFIRMATION) throw new Error("channel policy changes require explicit local owner confirmation");
}

function referenceFindings(policy, runtime, graph) {
  const findings = [];
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const bindings = new Map();
  const routes = new Map();
  for (const binding of policy.bindings) {
    if (!validBinding(binding)) findings.push(`invalid-binding:${binding?.id || "unknown"}`);
    if (bindings.has(binding.id)) findings.push(`duplicate-binding:${binding.id}`);
    bindings.set(binding.id, binding);
    if (binding.status === "active") {
      const route = bindingRoute(binding);
      if (routes.has(route)) findings.push(`duplicate-active-route:${binding.id}`);
      routes.set(route, binding.id);
    }
    if (entities.get(binding.agentId)?.kind !== "agent") findings.push(`binding-agent-mismatch:${binding.id}`);
    if (entities.get(binding.projectId)?.kind !== "project") findings.push(`binding-project-mismatch:${binding.id}`);
    if (binding.groupId !== null) {
      if (entities.get(binding.groupId)?.kind !== "group") findings.push(`binding-group-mismatch:${binding.id}`);
      const member = graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private"
        && ((edge.from === binding.agentId && edge.to === binding.groupId)
          || (edge.to === binding.agentId && edge.from === binding.groupId)));
      if (!member) findings.push(`binding-group-membership-mismatch:${binding.id}`);
    }
  }
  for (const record of policy.history) {
    if (!validPolicyHistory(record)) findings.push(`invalid-binding-history:${record?.recordId || "unknown"}`);
  }
  const eventIds = new Set();
  for (const event of runtime.events) {
    if (!validEvent(event)) findings.push(`invalid-channel-event:${event?.eventId || "unknown"}`);
    else if (!validPayloadDigest(event)) findings.push(`channel-event-digest-mismatch:${event.eventId}`);
    if (eventIds.has(event.eventId)) findings.push(`duplicate-channel-event:${event.eventId}`);
    eventIds.add(event.eventId);
    const binding = bindings.get(event.bindingId);
    if (!binding || [event.provider, event.tenantId, event.accountId, event.chatId, event.threadId || ""].join("\0") !== bindingRoute(binding)
      || event.agentId !== binding?.agentId || event.projectId !== binding?.projectId
      || event.groupId !== binding?.groupId || event.sessionKey !== binding?.sessionKey
      || !binding?.senderIds.includes(event.senderId)) findings.push(`event-binding-mismatch:${event.eventId}`);
  }
  for (const record of runtime.history) {
    if (!validRuntimeHistory(record)) findings.push(`invalid-channel-history:${record?.recordId || "unknown"}`);
    else if (!validPayloadDigest(record.value)) findings.push(`channel-history-digest-mismatch:${record.recordId}`);
  }
  const receiptIds = new Set();
  for (const receipt of runtime.receipts) {
    if (!validReceipt(receipt)) findings.push(`invalid-channel-receipt:${receipt?.id || "unknown"}`);
    if (receiptIds.has(receipt.id)) findings.push(`duplicate-channel-receipt:${receipt.id}`);
    if (!eventIds.has(receipt.eventId)) findings.push(`orphan-channel-receipt:${receipt.id}`);
    receiptIds.add(receipt.id);
  }
  return findings;
}

export function channelPolicyFindings(policy, graph) {
  return referenceFindings(policy, emptyRuntime(policy.root), graph).filter((item) => item.includes("binding") || item.includes("route"));
}

export function channelRuntimeFindings(runtime, policy, graph) {
  return referenceFindings(policy, runtime, graph);
}

export async function loadChannelPolicy(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  return { policy: await readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy), ...paths };
}

export async function loadChannelRuntime(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  return { runtime: await readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime), ...paths };
}

export async function inspectChannelRuntime(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  let policy = emptyPolicy(paths.catalog.root);
  let runtime = emptyRuntime(paths.catalog.root);
  const errors = [];
  try { policy = await readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy); } catch (error) { errors.push(`policy:${error.message}`); }
  try { runtime = await readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime); } catch (error) { errors.push(`runtime:${error.message}`); }
  return { policy, runtime, errors, ...paths };
}

function preserveBinding(policy, binding, at) {
  policy.history.push({
    kind: "channel-binding", recordId: binding.id, supersededAt: at,
    value: structuredClone(binding), authority: "explicit-local-channel-policy"
  });
}

function preserveEvent(runtime, event, transition, at) {
  runtime.history.push({
    kind: "channel-event", recordId: event.eventId, transition, supersededAt: at,
    value: structuredClone(event), authority: "execution-state-only"
  });
}

function appendReceipt(runtime, eventId, event, at, details = {}) {
  const material = { eventId, event, at, details, authority: "execution-state-only" };
  const digest = sha256(JSON.stringify(material));
  const id = `channel-receipt:${digest.slice(0, 24)}`;
  const existing = runtime.receipts.find((receipt) => receipt.id === id);
  if (existing) return { receipt: existing, duplicate: true };
  const receipt = { id, ...material, digest };
  runtime.receipts.push(receipt);
  return { receipt, duplicate: false };
}

function ensureHealthy(policy, runtime, graph) {
  const findings = referenceFindings(policy, runtime, graph);
  if (findings.length) throw new Error(`channel runtime failed closed: ${findings.join(", ")}`);
}

export async function grantChannelBinding({
  root = process.cwd(), id = `channel-binding:${randomUUID()}`, provider, tenantId, accountId,
  chatId, threadId = null, senderIds, agentId, projectId, groupId = null, sessionKey,
  secretEnv, outboundSecretEnv = null, capabilities = ["receive"], confirmation, now = new Date()
}) {
  requireConfirmation(confirmation);
  const paths = await pathsFor(root);
  return withChannelLock(paths, async () => {
    const [policy, runtime, { graph }] = await Promise.all([
      readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    ensureHealthy(policy, runtime, graph);
    const at = timestamp(now, "now");
    const binding = {
      id: stableId(id, "bindingId"),
      provider: stableId(provider, "provider", { route: true }),
      tenantId: stableId(tenantId, "tenantId", { route: true }),
      accountId: stableId(accountId, "accountId", { route: true }),
      chatId: stableId(chatId, "chatId", { route: true }),
      threadId: stableId(threadId, "threadId", { nullable: true, route: true }),
      senderIds: exactSenderIds(senderIds),
      agentId: stableId(agentId, "agentId"), projectId: stableId(projectId, "projectId"),
      groupId: stableId(groupId, "groupId", { nullable: true }),
      sessionKey: stableId(sessionKey, "sessionKey"),
      secretEnv: ENV_RE.test(secretEnv || "") ? secretEnv : (() => { throw new Error("secretEnv must be an uppercase environment variable name"); })(),
      outboundSecretEnv: outboundSecretEnv === null ? null : (ENV_RE.test(outboundSecretEnv || "")
        ? outboundSecretEnv : (() => { throw new Error("outboundSecretEnv must be an uppercase environment variable name"); })()),
      capabilities: exactCapabilities(capabilities), status: "active", createdAt: at, updatedAt: at,
      revokedAt: null, revokeReason: null, authority: "explicit-local-channel-policy"
    };
    const agent = graph.entities.find((entity) => entity.id === binding.agentId && entity.kind === "agent");
    const project = graph.entities.find((entity) => entity.id === binding.projectId && entity.kind === "project");
    if (binding.capabilities.includes("reply") && !binding.outboundSecretEnv) {
      throw new Error("reply capability requires an environment-only outbound adapter credential name");
    }
    if (!agent) throw new Error(`unknown agent entity: ${binding.agentId}`);
    if (!project) throw new Error(`unknown project entity: ${binding.projectId}`);
    if (binding.groupId !== null) {
      if (!graph.entities.some((entity) => entity.id === binding.groupId && entity.kind === "group")) throw new Error(`unknown group entity: ${binding.groupId}`);
      const member = graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private"
        && ((edge.from === binding.agentId && edge.to === binding.groupId)
          || (edge.to === binding.agentId && edge.from === binding.groupId)));
      if (!member) throw new Error("channel binding agent must be a visible member of its exact group");
    }
    const activeRoute = policy.bindings.find((item) => item.status === "active" && bindingRoute(item) === bindingRoute(binding) && item.id !== binding.id);
    if (activeRoute) throw new Error(`channel route is already bound by ${activeRoute.id}`);
    const previous = policy.bindings.find((item) => item.id === binding.id);
    if (previous) preserveBinding(policy, previous, at);
    policy.bindings = policy.bindings.filter((item) => item.id !== binding.id);
    policy.bindings.push(binding);
    policy.bindings.sort((left, right) => left.id.localeCompare(right.id));
    policy.revision += 1;
    ensureHealthy(policy, runtime, graph);
    await writeJson(paths.channelPolicyPath, policy);
    return { binding, revision: policy.revision, channelPolicyPath: paths.channelPolicyPath };
  });
}

export async function revokeChannelBinding({ root = process.cwd(), id, reason, confirmation, now = new Date() }) {
  requireConfirmation(confirmation);
  const paths = await pathsFor(root);
  return withChannelLock(paths, async () => {
    const [policy, runtime, { graph }] = await Promise.all([
      readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    ensureHealthy(policy, runtime, graph);
    const binding = policy.bindings.find((item) => item.id === stableId(id, "bindingId"));
    if (!binding) throw new Error(`unknown channel binding: ${id}`);
    const at = timestamp(now, "now");
    if (binding.status === "revoked") return { binding, duplicate: true };
    preserveBinding(policy, binding, at);
    binding.status = "revoked";
    binding.revokedAt = at;
    binding.updatedAt = at;
    binding.revokeReason = safeText(reason, "revoke reason", 1000);
    for (const event of runtime.events.filter((item) => item.bindingId === binding.id && !TERMINAL_STATUSES.has(item.status))) {
      preserveEvent(runtime, event, "binding-revoked", at);
      event.status = "cancelled";
      event.lease = null;
      event.completedAt = at;
      appendReceipt(runtime, event.eventId, "cancelled", at, { reason: "binding-revoked" });
    }
    policy.revision += 1;
    ensureHealthy(policy, runtime, graph);
    await Promise.all([writeJson(paths.channelPolicyPath, policy), writeJson(paths.channelRuntimePath, runtime)]);
    return { binding, duplicate: false, revision: policy.revision };
  });
}

function verifySignature(event, signature, binding, env) {
  const match = String(signature || "").match(SIGNATURE_RE);
  if (!match) throw new Error("channel event signature is missing or invalid");
  const secret = env?.[binding.secretEnv];
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error(`channel adapter secret ${binding.secretEnv} is unavailable or too short`);
  const expected = createHmac("sha256", secret).update(channelEventSigningPayload(event)).digest();
  const supplied = Buffer.from(match[1], "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("channel event signature verification failed");
}

export async function ingestChannelEvent({ root = process.cwd(), event, signature, env = process.env, now = new Date() }) {
  const normalized = normalizeInboundEvent(event, { inspectContent: true });
  const paths = await pathsFor(root);
  return withChannelLock(paths, async () => {
    const [policy, runtime, { graph }] = await Promise.all([
      readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    ensureHealthy(policy, runtime, graph);
    const route = [normalized.provider, normalized.tenantId, normalized.accountId, normalized.chatId, normalized.threadId || ""].join("\0");
    const routeBindings = policy.bindings.filter((binding) => binding.status === "active" && bindingRoute(binding) === route);
    if (!routeBindings.length) throw new Error("no active exact channel binding matches this event");
    const binding = routeBindings.find((item) => item.senderIds.includes(normalized.senderId));
    if (!binding) throw new Error("channel sender is not permitted by the exact binding");
    if (!binding.capabilities.includes("receive")) throw new Error("channel binding lacks receive capability");
    verifySignature(event, signature, binding, env);
    const payloadDigest = sha256(channelEventSigningPayload(event));
    const existing = runtime.events.find((item) => item.eventId === normalized.eventId);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest || existing.bindingId !== binding.id) throw new Error("channel event ID collision; processing stopped");
      return { event: existing, duplicate: true, receipt: runtime.receipts.find((item) => item.eventId === existing.eventId && item.event === "ingested") || null };
    }
    const at = timestamp(now, "now");
    const stored = {
      ...normalized, bindingId: binding.id, agentId: binding.agentId, projectId: binding.projectId,
      groupId: binding.groupId, sessionKey: binding.sessionKey, status: "pending", attempts: 0,
      lease: null, receivedAt: at, completedAt: null, payloadDigest,
      authority: "execution-state-only"
    };
    runtime.events.push(stored);
    runtime.events.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.eventId.localeCompare(right.eventId));
    const { receipt } = appendReceipt(runtime, stored.eventId, "ingested", at, { bindingId: binding.id, payloadDigest });
    ensureHealthy(policy, runtime, graph);
    await writeJson(paths.channelRuntimePath, runtime);
    return { event: stored, duplicate: false, receipt };
  });
}

function activeBinding(policy, event) {
  const binding = policy.bindings.find((item) => item.id === event.bindingId && item.status === "active");
  return binding && binding.capabilities.includes("receive") ? binding : null;
}

export async function claimChannelEvent({
  root = process.cwd(), agentId, projectId, groupId = null, provider, workerId,
  eventId = null, leaseSeconds = 120, now = new Date()
}) {
  agentId = stableId(agentId, "agentId");
  projectId = stableId(projectId, "projectId");
  groupId = stableId(groupId, "groupId", { nullable: true });
  provider = stableId(provider, "provider", { route: true });
  workerId = stableId(workerId, "workerId");
  eventId = stableId(eventId, "eventId", { nullable: true });
  const seconds = Number(leaseSeconds);
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 900) throw new Error("leaseSeconds must be an integer between 15 and 900");
  const paths = await pathsFor(root);
  return withChannelLock(paths, async () => {
    const [policy, runtime, { graph }] = await Promise.all([
      readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    ensureHealthy(policy, runtime, graph);
    const at = timestamp(now, "now");
    for (const event of runtime.events) {
      if (event.status === "leased" && new Date(event.lease.expiresAt) <= new Date(at)) {
        preserveEvent(runtime, event, "lease-expired", at);
        event.status = "pending";
        event.lease = null;
        appendReceipt(runtime, event.eventId, "lease-expired", at);
      }
    }
    const candidates = runtime.events.filter((event) => !TERMINAL_STATUSES.has(event.status)
      && event.status !== "leased" && event.agentId === agentId && event.projectId === projectId
      && event.groupId === groupId && event.provider === provider
      && (eventId === null || event.eventId === eventId) && activeBinding(policy, event));
    candidates.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.eventId.localeCompare(right.eventId));
    const event = candidates[0] || null;
    if (!event) {
      await writeJson(paths.channelRuntimePath, runtime);
      return { event: null, receipt: null };
    }
    preserveEvent(runtime, event, "leased", at);
    event.status = "leased";
    event.attempts += 1;
    event.lease = {
      workerId, claimedAt: at,
      expiresAt: new Date(new Date(at).getTime() + seconds * 1000).toISOString()
    };
    const { receipt } = appendReceipt(runtime, event.eventId, "leased", at, { workerId, attempt: event.attempts });
    ensureHealthy(policy, runtime, graph);
    await writeJson(paths.channelRuntimePath, runtime);
    return { event, receipt };
  });
}

export async function completeChannelEvent({ root = process.cwd(), eventId, workerId, status, now = new Date() }) {
  eventId = stableId(eventId, "eventId");
  workerId = stableId(workerId, "workerId");
  if (!new Set(["completed", "failed"]).has(status)) throw new Error("channel completion status must be completed or failed");
  const paths = await pathsFor(root);
  return withChannelLock(paths, async () => {
    const [policy, runtime, { graph }] = await Promise.all([
      readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    ensureHealthy(policy, runtime, graph);
    const event = runtime.events.find((item) => item.eventId === eventId);
    if (!event) throw new Error(`unknown channel event: ${eventId}`);
    if (event.status === status && event.completedAt) return { event, duplicate: true };
    if (event.status !== "leased" || event.lease?.workerId !== workerId) throw new Error("channel event completion requires its exact active worker lease");
    if (!activeBinding(policy, event)) throw new Error("channel binding was revoked before completion");
    const at = timestamp(now, "now");
    preserveEvent(runtime, event, status, at);
    event.status = status;
    event.lease = null;
    event.completedAt = status === "completed" ? at : null;
    const { receipt } = appendReceipt(runtime, event.eventId, status, at, { workerId, attempt: event.attempts });
    ensureHealthy(policy, runtime, graph);
    await writeJson(paths.channelRuntimePath, runtime);
    return { event, receipt, duplicate: false };
  });
}

export async function acknowledgeChannelDelivery({ root = process.cwd(), eventId, bindingId, deliveryReceiptId, now = new Date() }) {
  eventId = stableId(eventId, "eventId");
  bindingId = stableId(bindingId, "bindingId");
  deliveryReceiptId = stableId(deliveryReceiptId, "deliveryReceiptId");
  const paths = await pathsFor(root);
  return withChannelLock(paths, async () => {
    const [policy, runtime, { graph }] = await Promise.all([
      readJson(paths.channelPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.channelRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    ensureHealthy(policy, runtime, graph);
    const event = runtime.events.find((item) => item.eventId === eventId && item.bindingId === bindingId);
    if (!event) throw new Error("delivered channel event is unavailable in the exact binding");
    if (event.status === "completed") return { event, duplicate: true };
    if (!activeBinding(policy, event)?.capabilities.includes("reply")) throw new Error("channel reply capability was revoked before delivery acknowledgement");
    const completedAt = timestamp(now, "now");
    preserveEvent(runtime, event, "delivery-acknowledged", completedAt);
    event.status = "completed"; event.lease = null; event.completedAt = completedAt;
    const { receipt } = appendReceipt(runtime, event.eventId, "completed", completedAt, { deliveryReceiptId });
    ensureHealthy(policy, runtime, graph);
    await writeJson(paths.channelRuntimePath, runtime);
    return { event, receipt, duplicate: false };
  });
}

export async function channelRuntimeContext({
  root = process.cwd(), agentId = null, projectId = null, groupId = undefined,
  provider = null, includeTerminal = false, maxItems = 20
} = {}) {
  const [{ policy }, { runtime }, { graph }] = await Promise.all([
    loadChannelPolicy(root), loadChannelRuntime(root), loadGraph(root)
  ]);
  ensureHealthy(policy, runtime, graph);
  const limit = Number(maxItems);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("maxItems must be an integer between 1 and 100");
  const items = runtime.events.filter((event) => {
    if (!includeTerminal && TERMINAL_STATUSES.has(event.status)) return false;
    if (agentId !== null && event.agentId !== stableId(agentId, "agentId")) return false;
    if (projectId !== null && event.projectId !== stableId(projectId, "projectId")) return false;
    if (groupId !== undefined && event.groupId !== stableId(groupId, "groupId", { nullable: true })) return false;
    if (provider !== null && event.provider !== stableId(provider, "provider", { route: true })) return false;
    return true;
  }).slice(0, limit).map((event) => structuredClone(event));
  return {
    schema: "agentspine.channel-context/v1", items,
    pending: items.filter((event) => !TERMINAL_STATUSES.has(event.status)).length,
    authority: "execution-state-only"
  };
}

export { EVENT_SCHEMA as CHANNEL_EVENT_SCHEMA, POLICY_SCHEMA as CHANNEL_POLICY_SCHEMA, RUNTIME_SCHEMA as CHANNEL_RUNTIME_SCHEMA };
