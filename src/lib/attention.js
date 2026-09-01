import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { loadCoordination } from "./coordination.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";

const SIGNAL_KINDS = new Set(["unanswered-question", "promise", "check-in", "meaningful-change"]);
const ACTIVITY_KINDS = new Set(["message", "interaction", "task", "check-in"]);
const EVENT_KINDS = new Set(["heartbeat", "promise", "blocker"]);
const PRIVACY = new Set(["private", "shared", "group"]);
const STATUSES = new Set(["open", "completed", "dismissed"]);
const EVENT_STATUSES = {
  heartbeat: new Set(["active", "stopped"]),
  promise: new Set(["open", "completed", "dismissed"]),
  blocker: new Set(["open", "resolved", "dismissed"])
};
const HOOK_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"]);
const TEAM_RELATIONS = new Set(["works-with", "member-of", "reports-to", "responsible-for"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const UNSAFE_EVENT_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret|passwort|geheimnis)\s*[:=]\s*\S{8,}|\b(?:permission|permissions|rights?|roles?|delegat|authorized|authorization|berechtigt|rechte|rolle|freigabe|approval|approve|admin|deploy|production|produktion|billing|payment|zahlung|spending|network access|netzwerkzugriff|database access|datenbankzugriff|tool access|dateizugriff|file access|same person|same identity|alias of|merge identit|identit(?:y|ät)|private group|private gruppe|private chat|privater chat|permisos?|derechos?|autorizad[oa]|delegación|aprobación|producción|pagos?|acceso (?:a la )?red|acceso (?:a la )?base de datos|misma persona|misma identidad|grupo privado|chat privado|rättigheter|behörighet|delegering|godkännande|produktion|betalning|nätverksåtkomst|databasåtkomst|samma person|samma identitet|privat grupp|privat chatt)\b/i;

function defaultConfig() {
  return {
    enabled: true,
    minIntervalHours: 24,
    entitySilenceDays: 14,
    heartbeatStaleMinutes: 30,
    maxItems: 3,
    quietHours: null
  };
}

function emptyAttention(root) {
  return {
    schema: "agentspine.attention/v2",
    root,
    config: defaultConfig(),
    signals: [],
    activities: [],
    events: [],
    receipts: [],
    history: [],
    presentations: {}
  };
}

function normalizeAttention(value, root) {
  const state = value && typeof value === "object" ? value : emptyAttention(root);
  const originalSchema = state.schema;
  if (!["agentspine.attention/v1", "agentspine.attention/v2"].includes(state.schema) || state.root !== root) {
    throw new Error("attention state structure is invalid; automatic attention is disabled until repaired");
  }
  state.schema = "agentspine.attention/v2";
  state.config = { ...defaultConfig(), ...(state.config && typeof state.config === "object" ? state.config : {}) };
  for (const key of ["signals", "activities", "history"]) {
    if (!Array.isArray(state[key])) throw new Error("attention state structure is invalid; automatic attention is disabled until repaired");
  }
  for (const key of ["events", "receipts"]) {
    if (state[key] === undefined && originalSchema === "agentspine.attention/v1") state[key] = [];
    if (!Array.isArray(state[key])) throw new Error("attention state structure is invalid; automatic attention is disabled until repaired");
  }
  if (!state.presentations || Array.isArray(state.presentations) || typeof state.presentations !== "object") {
    throw new Error("attention state structure is invalid; automatic attention is disabled until repaired");
  }
  if (state.events.some((event) => !validEventRecord(event)) || state.receipts.some((receipt) => !validReceipt(receipt))) {
    throw new Error("attention lifecycle state is invalid; automatic attention is disabled until repaired");
  }
  return state;
}

function validEventRecord(event) {
  return event && ID_RE.test(event.id || "") && EVENT_KINDS.has(event.kind)
    && EVENT_STATUSES[event.kind]?.has(event.status) && PRIVACY.has(event.privacy)
    && (event.entityId === null || ID_RE.test(event.entityId))
    && (event.groupId === null || ID_RE.test(event.groupId))
    && ID_RE.test(event.projectId || "") && ID_RE.test(event.taskId || "")
    && typeof event.summary === "string" && event.summary.length > 0 && event.summary.length <= 280
    && Number.isInteger(event.occurrenceCount) && event.occurrenceCount >= 1
    && event.authority === "context-only"
    && Number.isFinite(new Date(event.createdAt).getTime())
    && Number.isFinite(new Date(event.updatedAt).getTime())
    && (event.dueAt === null || Number.isFinite(new Date(event.dueAt).getTime()))
    && !UNSAFE_EVENT_RE.test(event.summary)
    && event.provenance?.source === "native-lifecycle-hook"
    && ID_RE.test(event.provenance?.receiptId || "")
    && HOOK_EVENTS.has(event.provenance?.hookEvent)
    && new Set(["claude", "codex", "generic"]).has(event.provenance?.host)
    && /^[a-f0-9]{64}$/.test(event.provenance?.digest || "");
}

function validReceipt(receipt) {
  return receipt && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.eventId || "")
    && EVENT_KINDS.has(receipt.kind) && receipt.authority === "context-only"
    && /^[a-f0-9]{64}$/.test(receipt.digest || "")
    && Number.isFinite(new Date(receipt.at).getTime());
}

function normalizeDate(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

function normalizeNumber(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function normalizeInteger(value, field, minimum, maximum) {
  const number = normalizeNumber(value, field, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${field} must be an integer`);
  return number;
}

function validConfig(config) {
  const quiet = config.quietHours;
  const quietValid = quiet === null || (
    quiet && typeof quiet === "object"
    && Number.isInteger(quiet.start) && quiet.start >= 0 && quiet.start <= 23
    && Number.isInteger(quiet.end) && quiet.end >= 0 && quiet.end <= 23
    && Number.isFinite(quiet.utcOffsetMinutes) && quiet.utcOffsetMinutes >= -720 && quiet.utcOffsetMinutes <= 840
  );
  return typeof config.enabled === "boolean"
    && Number.isFinite(config.minIntervalHours) && config.minIntervalHours >= 1 && config.minIntervalHours <= 720
    && Number.isFinite(config.entitySilenceDays) && config.entitySilenceDays >= 1 && config.entitySilenceDays <= 3650
    && Number.isInteger(config.heartbeatStaleMinutes) && config.heartbeatStaleMinutes >= 1 && config.heartbeatStaleMinutes <= 10080
    && Number.isInteger(config.maxItems) && config.maxItems >= 1 && config.maxItems <= 20
    && quietValid;
}

function normalizeRelativePath(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a project-relative path`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must be a project-relative path`);
  }
  return normalized;
}

async function readAttentionFile(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("attention state exceeds the 5 MiB read limit");
    return normalizeAttention(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyAttention(root);
  }
}

export async function loadAttention(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const attentionPath = join(directory, "attention.json");
  return { attention: await readAttentionFile(attentionPath, catalog.root), attentionPath, catalog };
}

export async function inspectAttention(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const attentionPath = join(directory, "attention.json");
  try {
    return { attention: await readAttentionFile(attentionPath, catalog.root), attentionPath, catalog, error: null };
  } catch (error) {
    return { attention: emptyAttention(catalog.root), attentionPath, catalog, error: error.message };
  }
}

export function attentionFindings(attention) {
  const findings = [];
  if (!attention || attention.schema !== "agentspine.attention/v2") findings.push("invalid-schema");
  if (!validConfig(attention?.config || {})) findings.push("invalid-config");
  const ids = new Set();
  for (const event of attention?.events || []) {
    if (!validEventRecord(event)) findings.push(`invalid-event:${event?.id || "unknown"}`);
    if (ids.has(event.id)) findings.push(`duplicate-event:${event.id}`);
    ids.add(event.id);
  }
  const receiptIds = new Set();
  for (const receipt of attention?.receipts || []) {
    if (!validReceipt(receipt)) findings.push(`invalid-receipt:${receipt?.id || "unknown"}`);
    if (receiptIds.has(receipt.id)) findings.push(`duplicate-receipt:${receipt.id}`);
    if (!ids.has(receipt.eventId)) findings.push(`orphan-receipt:${receipt.id}`);
    receiptIds.add(receipt.id);
  }
  for (const event of attention?.events || []) {
    const receipt = (attention.receipts || []).find((item) => item.id === event.provenance?.receiptId);
    if (!receipt || receipt.eventId !== event.id || receipt.digest !== event.provenance.digest) {
      findings.push(`event-provenance-receipt-mismatch:${event.id}`);
    }
  }
  return findings;
}

async function saveAttention(state, path) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("attention state exceeds 5 MiB; resolve or delete old cues first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await replaceFileWithRetry(temporary, path);
}

async function withAttentionLock(path, task) {
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("attention state is busy; retry shortly");
  try {
    const state = await readAttentionFile(path, task.root);
    const result = await task.run(state);
    await saveAttention(state, path);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function preservePrevious(state, kind, value, now) {
  if (!value) return;
  state.history.push({
    kind,
    recordId: value.id,
    entityId: value.entityId || null,
    supersededAt: now,
    value: { ...value, authority: "context-only" },
    privacy: value.privacy || "private",
    authority: "context-only"
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function eventIdentity(kind, scope, summary) {
  const canonical = [kind, scope.entityId || "", scope.groupId || "", scope.projectId || "", scope.taskId || "", summary.trim().toLowerCase()].join("\0");
  return `event:${kind}:${digest(canonical).slice(0, 24)}`;
}

function validateKnownScope(graph, { entityId, groupId, projectId, taskId, privacy }) {
  if (!entityId) throw new Error("attention events require an exact known actor identity");
  if (!projectId || !taskId) throw new Error("attention events require exact project and task scope");
  if (entityId && !graph.entities.some((entity) => entity.id === entityId && ["person", "agent"].includes(entity.kind))) {
    throw new Error(`unknown person or agent entity: ${entityId}`);
  }
  if (!graph.entities.some((entity) => entity.id === projectId && entity.kind === "project")) {
    throw new Error(`unknown project entity: ${projectId}`);
  }
  validateGroupScope(privacy, groupId, graph, entityId);
}

function validateEventSummary(summary) {
  if (!summary || typeof summary !== "string") throw new Error("event summary is required");
  const compact = summary.trim().replace(/\s+/g, " ").slice(0, 280);
  if (!compact) throw new Error("event summary is required");
  if (UNSAFE_EVENT_RE.test(compact)) throw new Error("secret, identity, authority, or operational-rights content was rejected");
  return compact;
}

/** Record or transition a minimal provider-neutral lifecycle event. */
export async function recordAttentionEvent({
  root = process.cwd(), id = null, kind, summary, status = null,
  entityId = null, groupId = null, projectId = null, taskId = null,
  privacy = "private", dueAt = null, receiptId, host, hookEvent,
  observedAt = new Date(), catalog: providedCatalog = null
}) {
  if (!EVENT_KINDS.has(kind)) throw new Error(`unsupported attention event kind: ${kind}`);
  if (!PRIVACY.has(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  if (!ID_RE.test(receiptId || "")) throw new Error("receiptId is required for idempotent lifecycle recording");
  if (!new Set(["claude", "codex", "generic"]).has(host)) throw new Error("event host is invalid");
  if (!HOOK_EVENTS.has(hookEvent)) throw new Error("event provenance must name a supported lifecycle hook");
  for (const [field, value] of Object.entries({ entityId, groupId, projectId, taskId })) {
    if (value !== null && !ID_RE.test(value)) throw new Error(`${field} is invalid`);
  }
  const at = normalizeDate(observedAt, "observedAt");
  const normalizedDueAt = normalizeDate(dueAt, "dueAt", true);
  const normalizedSummary = validateEventSummary(summary);
  const nextStatus = status || (kind === "heartbeat" ? "active" : "open");
  if (!EVENT_STATUSES[kind].has(nextStatus)) throw new Error(`unsupported ${kind} status: ${nextStatus}`);
  const scope = { entityId, groupId, projectId, taskId };
  const eventId = id || eventIdentity(kind, scope, normalizedSummary);
  if (!ID_RE.test(eventId)) throw new Error("event id must be stable and whitespace-free");
  const provenanceDigest = digest(JSON.stringify({ kind, summary: normalizedSummary, status: nextStatus, ...scope }));
  return attentionMutation(root, async (state, catalog, attentionPath) => {
    const duplicate = state.receipts.find((receipt) => receipt.id === receiptId);
    if (duplicate) {
      if (duplicate.eventId !== eventId || duplicate.kind !== kind || duplicate.digest !== provenanceDigest) {
        throw new Error("attention receipt collision detected");
      }
      const event = state.events.find((item) => item.id === duplicate.eventId) || null;
      return { event, duplicate: true, receipt: duplicate, attentionPath };
    }
    const { graph } = await loadGraph(catalog.root, catalog);
    validateKnownScope(graph, { ...scope, privacy });
    const { coordination } = await loadCoordination(catalog.root, catalog);
    const task = coordination.tasks.find((item) => item.id === taskId);
    if (!task || task.projectId !== projectId) throw new Error("attention event task must exist in the exact project scope");
    if (![task.createdBy, task.assigneeId].includes(entityId)) {
      throw new Error("attention event actor must be the task creator or assignee");
    }
    if (task.groupId !== groupId && (task.groupId !== null || groupId !== null)) {
      throw new Error("attention event group scope must match the task");
    }
    if (stricterPrivacy(privacy, task.privacy) !== privacy) {
      throw new Error("attention event privacy cannot be broader than the task");
    }
    const previous = state.events.find((item) => item.id === eventId);
    if (previous && (previous.kind !== kind || previous.entityId !== entityId || previous.groupId !== groupId
      || previous.projectId !== projectId || previous.taskId !== taskId || previous.privacy !== privacy)) {
      throw new Error("stable attention event identity cannot change kind, scope, or privacy");
    }
    preservePrevious(state, "attention-event", previous, at);
    const provenance = {
      source: "native-lifecycle-hook", host, hookEvent, receiptId,
      observedAt: at,
      digest: provenanceDigest
    };
    const event = {
      id: eventId, kind, summary: normalizedSummary, status: nextStatus,
      entityId, groupId, projectId, taskId, privacy,
      dueAt: normalizedDueAt,
      createdAt: previous?.createdAt || at,
      updatedAt: at,
      occurrenceCount: (previous?.occurrenceCount || 0) + 1,
      provenance,
      authority: "context-only"
    };
    state.events = state.events.filter((item) => item.id !== eventId);
    state.events.push(event);
    state.events.sort((left, right) => left.id.localeCompare(right.id));
    const receipt = { id: receiptId, eventId, kind, digest: provenanceDigest, at, authority: "context-only" };
    state.receipts.push(receipt);
    state.receipts.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
    return { event, duplicate: false, receipt, attentionPath };
  }, providedCatalog);
}

function isGroupMember(graph, groupId, entityId) {
  if (!entityId || entityId === groupId) return true;
  return graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
    (edge.from === entityId && edge.to === groupId) || (edge.to === entityId && edge.from === groupId)
  ));
}

function validateGroupScope(privacy, groupId, graph, entityId = null) {
  if (privacy === "group") {
    if (!groupId) throw new Error("group privacy requires groupId");
    const group = graph.entities.find((entity) => entity.id === groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
    if (!isGroupMember(graph, groupId, entityId)) throw new Error(`entity is not a visible member of group: ${groupId}`);
  } else if (groupId !== null && groupId !== undefined) {
    throw new Error("groupId is only valid with group privacy");
  }
}

async function attentionMutation(root, operation, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { attentionPath } = await loadAttention(catalog.root, catalog);
  return withAttentionLock(attentionPath, { root: catalog.root, run: (state) => operation(state, catalog, attentionPath) });
}

export async function upsertAttention({
  root = process.cwd(), id = `signal:${randomUUID()}`, kind, summary, entityId = null,
  dueAt = null, priority = 50, privacy = "private", groupId = null, sourceDocument = null,
  confidence = 0.5, now = new Date()
}) {
  if (!ID_RE.test(id)) throw new Error("id must be a stable, whitespace-free identifier");
  if (!SIGNAL_KINDS.has(kind)) throw new Error(`unsupported attention kind: ${kind}`);
  if (!summary || typeof summary !== "string") throw new Error("summary is required");
  if (!PRIVACY.has(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  const timestamp = normalizeDate(now, "now");
  const normalizedDueAt = normalizeDate(dueAt, "dueAt", true);
  sourceDocument = normalizeRelativePath(sourceDocument, "sourceDocument");
  return attentionMutation(root, async (state, catalog, attentionPath) => {
    const { graph } = await loadGraph(catalog.root, catalog);
    if (entityId !== null && !graph.entities.some((entity) => entity.id === entityId)) throw new Error(`unknown entity: ${entityId}`);
    validateGroupScope(privacy, groupId, graph, entityId);
    if (sourceDocument !== null && !catalog.documents.some((document) => document.relativePath === sourceDocument)) {
      throw new Error(`unknown source document: ${sourceDocument}`);
    }
    const previous = state.signals.find((signal) => signal.id === id);
    const signal = {
      id,
      kind,
      summary: summary.slice(0, 500),
      entityId,
      dueAt: normalizedDueAt,
      priority: normalizeNumber(priority, "priority", 0, 100),
      privacy,
      groupId,
      sourceDocument,
      confidence: normalizeNumber(confidence, "confidence", 0, 1),
      status: "open",
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp,
      authority: "context-only"
    };
    preservePrevious(state, "attention-signal", previous, timestamp);
    state.signals = state.signals.filter((item) => item.id !== id);
    state.signals.push(signal);
    state.signals.sort((a, b) => a.id.localeCompare(b.id));
    return { signal, attentionPath };
  });
}

export async function resolveAttention({ root = process.cwd(), id, status = "completed", now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  if (!STATUSES.has(status)) throw new Error(`unsupported attention status: ${status}`);
  const timestamp = normalizeDate(now, "now");
  return attentionMutation(root, (state, _catalog, attentionPath) => {
    const previous = state.signals.find((signal) => signal.id === id);
    if (!previous) throw new Error(`unknown attention signal: ${id}`);
    preservePrevious(state, "attention-signal", previous, timestamp);
    const signal = { ...previous, status, updatedAt: timestamp, authority: "context-only" };
    state.signals = state.signals.map((item) => item.id === id ? signal : item);
    return { signal, attentionPath };
  });
}

export async function recordActivity({
  root = process.cwd(), entityId, kind = "interaction", at = new Date(), privacy = "private", groupId = null
}) {
  if (!ID_RE.test(entityId || "")) throw new Error("entityId is required");
  if (!ACTIVITY_KINDS.has(kind)) throw new Error(`unsupported activity kind: ${kind}`);
  if (!PRIVACY.has(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  const timestamp = normalizeDate(at, "at");
  return attentionMutation(root, async (state, catalog, attentionPath) => {
    const { graph } = await loadGraph(catalog.root, catalog);
    if (!graph.entities.some((entity) => entity.id === entityId)) throw new Error(`unknown entity: ${entityId}`);
    validateGroupScope(privacy, groupId, graph, entityId);
    const activity = {
      id: `activity:${randomUUID()}`,
      entityId,
      kind,
      at: timestamp,
      privacy,
      groupId,
      authority: "context-only"
    };
    state.activities.push(activity);
    state.activities.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return { activity, attentionPath };
  });
}

function normalizeQuietHours(value) {
  if (value === null || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("quietHours must be an object or null");
  return {
    start: normalizeInteger(value.start, "quietHours.start", 0, 23),
    end: normalizeInteger(value.end, "quietHours.end", 0, 23),
    utcOffsetMinutes: normalizeInteger(value.utcOffsetMinutes ?? 0, "quietHours.utcOffsetMinutes", -720, 840)
  };
}

export async function configureAttention({ root = process.cwd(), config = {}, now = new Date() }) {
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("config must be an object");
  if (!Object.keys(config).length) throw new Error("config must change at least one attention setting");
  const allowed = new Set(["enabled", "minIntervalHours", "entitySilenceDays", "heartbeatStaleMinutes", "maxItems", "quietHours"]);
  const unknown = Object.keys(config).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unsupported attention config: ${unknown.join(", ")}`);
  const timestamp = normalizeDate(now, "now");
  return attentionMutation(root, (state, _catalog, attentionPath) => {
    preservePrevious(state, "attention-config", { id: "config", ...state.config, privacy: "private" }, timestamp);
    if ("enabled" in config) {
      if (typeof config.enabled !== "boolean") throw new Error("enabled must be boolean");
      state.config.enabled = config.enabled;
    }
    if ("minIntervalHours" in config) state.config.minIntervalHours = normalizeNumber(config.minIntervalHours, "minIntervalHours", 1, 720);
    if ("entitySilenceDays" in config) state.config.entitySilenceDays = normalizeNumber(config.entitySilenceDays, "entitySilenceDays", 1, 3650);
    if ("heartbeatStaleMinutes" in config) state.config.heartbeatStaleMinutes = normalizeInteger(config.heartbeatStaleMinutes, "heartbeatStaleMinutes", 1, 10080);
    if ("maxItems" in config) state.config.maxItems = normalizeInteger(config.maxItems, "maxItems", 1, 20);
    if ("quietHours" in config) state.config.quietHours = normalizeQuietHours(config.quietHours);
    if (!validConfig(state.config)) throw new Error("resulting attention configuration is invalid");
    return { config: state.config, attentionPath };
  });
}

function isQuiet(now, quietHours) {
  if (!quietHours) return false;
  const shifted = new Date(now.getTime() + quietHours.utcOffsetMinutes * 60000);
  const hour = shifted.getUTCHours();
  if (quietHours.start === quietHours.end) return true;
  if (quietHours.start < quietHours.end) return hour >= quietHours.start && hour < quietHours.end;
  return hour >= quietHours.start || hour < quietHours.end;
}

function recentlyPresented(state, key, now) {
  const value = state.presentations[key];
  if (!value) return false;
  return now.getTime() - new Date(value).getTime() < state.config.minIntervalHours * 3600000;
}

function groupEntityIds(graph, groupId, includePrivate) {
  const ids = new Set();
  if (!groupId) return ids;
  ids.add(groupId);
  for (const edge of graph.entityEdges) {
    if (edge.relation !== "member-of" || (!includePrivate && edge.privacy === "private")) continue;
    if (edge.to === groupId) ids.add(edge.from);
    if (edge.from === groupId) ids.add(edge.to);
  }
  return ids;
}

function entityVisible(entity, includePrivate, groupEntities) {
  if (!entity) return true;
  if (entity.privacy === "group") return groupEntities.has(entity.id);
  if (entity.privacy === "private") return includePrivate;
  return true;
}

function visible(record, entities, includePrivate, groupId, groupEntities) {
  if (!includePrivate && record.privacy === "private") return false;
  if (record.privacy === "group" && (!groupId || record.groupId !== groupId)) return false;
  if (record.privacy === "group" && record.entityId && !groupEntities.has(record.entityId)) return false;
  if (record.entityId) {
    const entity = entities.get(record.entityId);
    if (!entityVisible(entity, includePrivate, groupEntities)) return false;
  }
  return true;
}

function stricterPrivacy(left, right) {
  const rank = { shared: 0, group: 1, private: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function looserPrivacy(left, right) {
  const rank = { shared: 0, group: 1, private: 2 };
  return rank[left] <= rank[right] ? left : right;
}

export async function attentionContext({
  root = process.cwd(), includePrivate = false, focusActive = false,
  markPresented = false, maxItems = null, entityId = null, groupId = null,
  projectId = null, currentTaskId = null, now = new Date(), catalog: providedCatalog = null
} = {}) {
  const timestamp = normalizeDate(now, "now");
  const current = new Date(timestamp);
  const catalog = providedCatalog || await buildCatalog(root);
  const { attention, attentionPath } = await loadAttention(catalog.root, catalog);
  if (!validConfig(attention.config)) throw new Error("attention configuration is invalid; inspect or reset the external attention state");
  const { graph } = await loadGraph(catalog.root, catalog);
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  if (groupId !== null) {
    const group = entities.get(groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
  }
  const groupEntities = groupEntityIds(graph, groupId, includePrivate);
  let suppressed = null;
  if (!attention.config.enabled) suppressed = "disabled";
  else if (isQuiet(current, attention.config.quietHours)) suppressed = "quiet-hours";
  else if (focusActive) suppressed = "focus-active";

  const candidates = [];
  if (!suppressed) {
    for (const signal of attention.signals) {
      if (signal.status !== "open" || !visible(signal, entities, includePrivate, groupId, groupEntities)) continue;
      if (!SIGNAL_KINDS.has(signal.kind) || !Number.isFinite(signal.priority) || !Number.isFinite(signal.confidence)) continue;
      if (signal.dueAt && new Date(signal.dueAt) > current) continue;
      if (signal.dueAt && !Number.isFinite(new Date(signal.dueAt).getTime())) continue;
      const key = `cue:${signal.id}`;
      if (recentlyPresented(attention, key, current)) continue;
      const weights = { "unanswered-question": 30, promise: 25, "meaningful-change": 15, "check-in": 5 };
      candidates.push({
        key,
        source: "signal",
        score: signal.priority + weights[signal.kind],
        kind: signal.kind,
        summary: signal.summary,
        entityId: signal.entityId,
        dueAt: signal.dueAt,
        privacy: signal.privacy,
        groupId: signal.groupId || null,
        confidence: signal.confidence,
        authority: "context-only"
      });
    }

    const teamEdges = graph.entityEdges
      .filter((edge) => TEAM_RELATIONS.has(edge.relation))
      .filter((edge) => includePrivate || edge.privacy !== "private")
      .filter((edge) => edge.privacy !== "group" || (
        groupId && [edge.from, edge.to].every((id) => groupEntities.has(id))
      ))
      .filter((edge) => [edge.from, edge.to].every((id) => {
        return entityVisible(entities.get(id), includePrivate, groupEntities);
      }));
    const teamIds = new Set(teamEdges.flatMap((edge) => [edge.from, edge.to]));
    for (const entity of graph.entities) {
      if (!teamIds.has(entity.id) || !["person", "agent"].includes(entity.kind)) continue;
      if (!visible({ entityId: entity.id, privacy: entity.privacy, groupId }, entities, includePrivate, groupId, groupEntities)) continue;
      const latestActivity = attention.activities
        .filter((activity) => activity.entityId === entity.id && visible(activity, entities, includePrivate, groupId, groupEntities))
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      const baseline = new Date(latestActivity?.at || entity.updatedAt);
      const silenceDays = (current.getTime() - baseline.getTime()) / 86400000;
      if (silenceDays < attention.config.entitySilenceDays) continue;
      const key = `neglected:${entity.id}`;
      if (recentlyPresented(attention, key, current)) continue;
      const edgePrivacy = teamEdges
        .filter((edge) => edge.from === entity.id || edge.to === entity.id)
        .map((edge) => [edge.from, edge.to].reduce(
          (scope, id) => stricterPrivacy(scope, entities.get(id)?.privacy || "private"),
          edge.privacy
        ))
        .reduce((scope, privacy) => scope === null ? privacy : looserPrivacy(scope, privacy), null);
      const privacy = stricterPrivacy(entity.privacy, edgePrivacy || "private");
      candidates.push({
        key,
        source: "relationship",
        score: 40 + Math.min(30, Math.floor(silenceDays - attention.config.entitySilenceDays)),
        kind: "check-in",
        summary: `No recorded interaction with ${entity.displayName || entity.id} for ${Math.floor(silenceDays)} days.`,
        entityId: entity.id,
        dueAt: null,
        privacy,
        groupId: privacy === "group" ? groupId : null,
        confidence: entity.confidence,
        authority: "context-only"
      });
    }
  }

  // Focus suppresses unrelated reminders but not a blocker or due promise for
  // the exact task already in focus. Quiet hours and the global switch still
  // suppress every presentation while retaining durable state.
  if (attention.config.enabled && suppressed !== "quiet-hours") {
    for (const event of attention.events) {
      if (!EVENT_KINDS.has(event.kind) || !EVENT_STATUSES[event.kind]?.has(event.status)) continue;
      if (!visible(event, entities, includePrivate, groupId, groupEntities)) continue;
      if (event.entityId !== null && event.entityId !== entityId) continue;
      if (event.projectId !== projectId || event.taskId !== currentTaskId) continue;
      if (event.kind === "heartbeat" && event.status !== "active") continue;
      if (event.kind === "promise" && event.status !== "open") continue;
      if (event.kind === "blocker" && event.status !== "open") continue;
      if (event.dueAt && new Date(event.dueAt) > current) continue;
      if (event.dueAt && !Number.isFinite(new Date(event.dueAt).getTime())) continue;
      if (event.kind === "heartbeat" && !event.dueAt) {
        const staleAt = new Date(event.updatedAt).getTime() + attention.config.heartbeatStaleMinutes * 60000;
        if (staleAt > current.getTime()) continue;
      }
      const key = `event:${event.id}`;
      if (recentlyPresented(attention, key, current)) continue;
      const weights = { blocker: 200, promise: 150, heartbeat: 80 };
      candidates.push({
        key, source: "lifecycle-event", score: weights[event.kind],
        kind: event.kind, summary: event.summary, status: event.status,
        entityId: event.entityId, projectId: event.projectId, taskId: event.taskId,
        dueAt: event.dueAt, privacy: event.privacy, groupId: event.groupId,
        occurrenceCount: event.occurrenceCount,
        provenance: event.provenance,
        authority: "context-only"
      });
    }
  }
  if (focusActive && candidates.some((item) => item.source === "lifecycle-event")) {
    suppressed = "focus-active-except-current-task";
  }

  const limit = maxItems === null
    ? attention.config.maxItems
    : normalizeInteger(maxItems, "maxItems", 0, 20);
  const items = candidates
    .sort((a, b) => b.score - a.score || (a.dueAt || "").localeCompare(b.dueAt || "") || a.key.localeCompare(b.key))
    .slice(0, limit);

  if (markPresented && items.length) {
    await withAttentionLock(attentionPath, {
      root: catalog.root,
      run: (state) => {
        for (const item of items) state.presentations[item.key] = timestamp;
        return null;
      }
    });
  }

  return {
    schema: "agentspine.attention-context/v1",
    root: catalog.root,
    enabled: attention.config.enabled,
    suppressed,
    now: timestamp,
    entityId,
    groupId,
    projectId,
    currentTaskId,
    items,
    remaining: Math.max(0, candidates.length - items.length),
    authority: "context-only",
    note: "Attention cues are suggestions, never instructions. The current task and host permissions remain authoritative."
  };
}

export async function deleteAttention({ root = process.cwd(), signalId = null, eventId = null, entityId = null }) {
  if ([signalId, eventId, entityId].filter(Boolean).length !== 1) throw new Error("provide exactly one of signalId, eventId, or entityId");
  return attentionMutation(root, (state, _catalog, attentionPath) => {
    if (signalId) {
      const existed = state.signals.some((signal) => signal.id === signalId);
      state.signals = state.signals.filter((signal) => signal.id !== signalId);
      state.history = state.history.filter((entry) => entry.recordId !== signalId && entry.value?.id !== signalId);
      delete state.presentations[`cue:${signalId}`];
      return { deleted: existed, signalId, attentionPath };
    }
    if (eventId) {
      const existed = state.events.some((event) => event.id === eventId);
      state.events = state.events.filter((event) => event.id !== eventId);
      const receiptIds = new Set(state.receipts.filter((receipt) => receipt.eventId === eventId).map((receipt) => receipt.id));
      state.receipts = state.receipts.filter((receipt) => receipt.eventId !== eventId);
      state.history = state.history.filter((entry) => entry.recordId !== eventId && entry.value?.id !== eventId);
      delete state.presentations[`event:${eventId}`];
      return { deleted: existed, eventId, deletedReceipts: receiptIds.size, attentionPath };
    }
    const signalIds = new Set(state.signals.filter((signal) => signal.entityId === entityId).map((signal) => signal.id));
    const deletedSignals = signalIds.size;
    const deletedActivities = state.activities.filter((activity) => activity.entityId === entityId).length;
    const eventIds = new Set(state.events.filter((event) => event.entityId === entityId).map((event) => event.id));
    const deletedEvents = eventIds.size;
    state.signals = state.signals.filter((signal) => signal.entityId !== entityId);
    state.activities = state.activities.filter((activity) => activity.entityId !== entityId);
    state.events = state.events.filter((event) => event.entityId !== entityId);
    state.receipts = state.receipts.filter((receipt) => !eventIds.has(receipt.eventId));
    state.history = state.history.filter((entry) => entry.entityId !== entityId && entry.value?.entityId !== entityId && !signalIds.has(entry.recordId) && !eventIds.has(entry.recordId));
    for (const key of Object.keys(state.presentations)) {
      if (key === `neglected:${entityId}` || [...signalIds].some((id) => key === `cue:${id}`)) delete state.presentations[key];
      if ([...eventIds].some((id) => key === `event:${id}`)) delete state.presentations[key];
    }
    return { deletedSignals, deletedActivities, deletedEvents, entityId, attentionPath };
  });
}
