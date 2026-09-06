export const SIGNAL_KINDS = new Set(["unanswered-question", "promise", "check-in", "meaningful-change"]);
export const ACTIVITY_KINDS = new Set(["message", "interaction", "task", "check-in"]);
export const EVENT_KINDS = new Set(["heartbeat", "promise", "blocker"]);
export const PRIVACY = new Set(["private", "shared", "group"]);
export const STATUSES = new Set(["open", "completed", "dismissed"]);
export const EVENT_STATUSES = {
  heartbeat: new Set(["active", "stopped"]),
  promise: new Set(["open", "completed", "dismissed"]),
  blocker: new Set(["open", "resolved", "dismissed"])
};
export const HOOK_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"]);
export const TEAM_RELATIONS = new Set(["works-with", "member-of", "reports-to", "responsible-for"]);
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
export const MAX_STATE_BYTES = 5 * 1024 * 1024;
export const UNSAFE_EVENT_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret|passwort|geheimnis)\s*[:=]\s*\S{8,}|\b(?:permission|permissions|rights?|roles?|delegat|authorized|authorization|berechtigt|rechte|rolle|freigabe|approval|approve|admin|deploy|production|produktion|billing|payment|zahlung|spending|network access|netzwerkzugriff|database access|datenbankzugriff|tool access|dateizugriff|file access|same person|same identity|alias of|merge identit|identit(?:y|ät)|private group|private gruppe|private chat|privater chat|permisos?|derechos?|autorizad[oa]|delegación|aprobación|producción|pagos?|acceso (?:a la )?red|acceso (?:a la )?base de datos|misma persona|misma identidad|grupo privado|chat privado|rättigheter|behörighet|delegering|godkännande|produktion|betalning|nätverksåtkomst|databasåtkomst|samma person|samma identitet|privat grupp|privat chatt)\b/i;

export function defaultConfig() {
  return {
    enabled: true,
    minIntervalHours: 24,
    entitySilenceDays: 14,
    heartbeatStaleMinutes: 30,
    maxItems: 3,
    quietHours: null
  };
}

export function emptyAttention(root) {
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

export function normalizeAttention(value, root) {
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

export function validEventRecord(event) {
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

export function validReceipt(receipt) {
  return receipt && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.eventId || "")
    && EVENT_KINDS.has(receipt.kind) && receipt.authority === "context-only"
    && /^[a-f0-9]{64}$/.test(receipt.digest || "")
    && Number.isFinite(new Date(receipt.at).getTime());
}

export function normalizeDate(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

export function normalizeNumber(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

export function normalizeInteger(value, field, minimum, maximum) {
  const number = normalizeNumber(value, field, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${field} must be an integer`);
  return number;
}

export function validConfig(config) {
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

export function normalizeRelativePath(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a project-relative path`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must be a project-relative path`);
  }
  return normalized;
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
