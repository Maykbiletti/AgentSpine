import { createHash } from "node:crypto";
import { loadCoordination } from "./coordination.js";
import { loadGraph } from "./graph.js";
import { EVENT_KINDS, EVENT_STATUSES, HOOK_EVENTS, ID_RE, PRIVACY, UNSAFE_EVENT_RE, normalizeDate } from "./attention-schema.js";
import { attentionMutation, preservePrevious } from "./attention-storage.js";
import { stricterPrivacy, validateGroupScope } from "./attention-privacy.js";

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
