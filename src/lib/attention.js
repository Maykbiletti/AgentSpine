import { randomUUID } from "node:crypto";
import { loadGraph } from "./graph.js";
import { ACTIVITY_KINDS, ID_RE, PRIVACY, SIGNAL_KINDS, STATUSES, normalizeDate, normalizeInteger, normalizeNumber, normalizeRelativePath, validConfig } from "./attention-schema.js";
import { attentionMutation, preservePrevious } from "./attention-storage.js";
import { validateGroupScope } from "./attention-privacy.js";

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

export { attentionFindings } from "./attention-schema.js";
export { inspectAttention, loadAttention } from "./attention-storage.js";
export { recordAttentionEvent } from "./attention-events.js";
export { attentionContext } from "./attention-context.js";
