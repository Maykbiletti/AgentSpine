import { createHash } from "node:crypto";
import * as goalPremortem from "./gateway-premortem.js";

export const GATEWAY_POLICY_SCHEMA = "agentspine.gateway-policy/v2";
export const GATEWAY_RUNTIME_SCHEMA = "agentspine.gateway-runtime/v1";
export const GATEWAY_EVENT_SCHEMA = "agentspine.gateway-event/v1";
export const GOAL_PLAN_SCHEMA = "agentspine.goal-plan/v1";
export { KNOWLEDGE_GAP_SCHEMA } from "./knowledge-evidence.js";
export const EXECUTION_OUTCOME_SCHEMA = "agentspine.execution-outcome/v1";
export const EXECUTION_ATTEMPT_SCHEMA = "agentspine.execution-attempt/v1";
export const STRATEGY_TRANSFER_PROOF_SCHEMA = "agentspine.strategy-transfer-proof/v1";

export const CONFIRMATION = "local-owner-confirmed";
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
export const ROUTE_RE = /^-?[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
export const GOAL_STATUSES = new Set(["active", "blocked", "completed", "cancelled"]);
export const PLAN_STEP_STATUSES = new Set(["pending", "active", "blocked", "completed", "cancelled"]);
export const QUEUE_STATUSES = new Set(["pending", "leased", "awaiting-delivery", "completed", "blocked", "dead-letter", "cancelled"]);
export const OUTBOX_STATUSES = new Set(["prepared", "sending", "delivered", "failed", "dead-letter", "delivery-unknown", "acknowledged"]);
export const WAKE_KINDS = new Set(["direct-message", "deadline", "promise", "resolved-blocker", "assignment", "follow-up", "relationship"]);
export const PRIORITY = { "direct-message": 100, deadline: 90, promise: 90, "resolved-blocker": 80, assignment: 70, "follow-up": 60, relationship: 50 };
export const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;
export const SECRET_KEY_RE = /"(?:api[-_ ]?key|token|password|secret|credential)"\s*:/i;
export const AUTHORITY_RE = /\b(?:permission|rights?|roles?|owner|trusted|delegat|authorized|approval|production|payment|spending|tool capability|send capability)\b/i;
export const HEALTH_VALUES = new Set(["stopped", "running", "unknown", "healthy", "degraded", "failed"]);
export const METRIC_OPERATORS = new Set(["gte", "lte", "eq"]);

export function emptyPolicy(root) {
  return { schema: GATEWAY_POLICY_SCHEMA, root, revision: 0, enabled: false, killSwitch: false, goals: [], history: [],
    premortemContractRegistry: goalPremortem.emptyGoalPremortemRegistry(root) };
}

export function emptyRuntime(root) {
  return { schema: GATEWAY_RUNTIME_SCHEMA, root, revision: 0, queue: [], lanes: [], outbox: [], receipts: [], history: [],
    health: { gateway: "stopped", adapter: "unknown", scheduler: "unknown", queue: "healthy", worker: "unknown", host: "unknown", lastTickAt: null, lastReconciledAt: null } };
}

export function exactId(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("*")) throw new Error(field + " must be an exact stable ID without wildcards");
  return value;
}

export function safeText(value, field, maximum = 1000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " is required");
  const text = value.trim().replace(/\s+/g, " ").slice(0, maximum);
  if (SECRET_RE.test(text)) throw new Error(field + " appears to contain a secret");
  return text;
}

export function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("timestamp is invalid");
  return date.toISOString();
}

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function safeCheckpoint(value) {
  if (value === null || value === undefined) return null;
  let content;
  try { content = JSON.stringify(value); } catch { throw new Error("checkpoint must be JSON serializable"); }
  if (!content || Buffer.byteLength(content) > 16384) throw new Error("checkpoint exceeds 16 KiB");
  if (SECRET_RE.test(content) || SECRET_KEY_RE.test(content) || AUTHORITY_RE.test(content)) {
    throw new Error("checkpoint contains secret- or authority-shaped content");
  }
  return JSON.parse(content);
}
