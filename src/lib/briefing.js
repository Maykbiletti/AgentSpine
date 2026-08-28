import { buildCatalog } from "./catalog.js";
import { resolveContext } from "./context.js";
import { relationshipContext } from "./graph.js";
import { learningContext } from "./learning.js";
import { attentionContext } from "./attention.js";
import { taskContext } from "./coordination.js";
import { sharedContext } from "./sharing.js";

const MIN_BYTES = 4096;
const MAX_BYTES = 262144;

function integer(value, field, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function compactBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function normalizeKey(item) {
  return `${item.kind}\0${item.subjectId || ""}\0${item.claim.trim().toLowerCase()}`;
}

function sourceDescriptor(document, content = null) {
  return {
    path: document.relativePath,
    layer: document.effectiveLayer,
    sha256: document.sha256,
    bytes: document.bytes,
    loaded: content !== null,
    content,
    authority: document.authority
  };
}

function recalculateBudget(result) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const usedBytes = compactBytes(result);
    const remainingBytes = Math.max(0, result.budget.maxBytes - usedBytes);
    if (result.budget.usedBytes === usedBytes && result.budget.remainingBytes === remainingBytes) break;
    result.budget.usedBytes = usedBytes;
    result.budget.remainingBytes = remainingBytes;
  }
}

function tryAdd(result, collection, item) {
  collection.push(item);
  recalculateBudget(result);
  // Keep a small accounting reserve so growing omission counters can never
  // invalidate a packet after an item has been accepted.
  if (result.budget.usedBytes <= result.budget.maxBytes - 128) return true;
  collection.pop();
  recalculateBudget(result);
  return false;
}

function trySet(result, object, key, item) {
  const previous = object[key];
  object[key] = item;
  recalculateBudget(result);
  if (result.budget.usedBytes <= result.budget.maxBytes - 128) return true;
  object[key] = previous;
  recalculateBudget(result);
  return false;
}

function countOmitted(result, section, count = 1) {
  result.budget.omitted[section] += count;
  recalculateBudget(result);
}

function matchesScope(item, entityId, projectId) {
  if (!entityId && !projectId) return item.subjectId === null;
  return item.subjectId === null || item.subjectId === entityId || item.subjectId === projectId;
}

function taskMatchesScope(task, entityId) {
  return !entityId || task.createdBy === entityId || task.assigneeId === entityId;
}

/**
 * Assemble one immutable, privacy-filtered context packet for a host session.
 * The packet is descriptive only and fits maxBytes as compact UTF-8 JSON.
 */
export async function sessionBriefing({
  root = process.cwd(), cwd = root, host = "generic", entityId = null,
  groupId = null, projectId = null, currentTaskId = null,
  includePrivate = false, focusActive = true, includeSourceContent = true,
  maxBytes = 16384, now = new Date()
} = {}) {
  const limit = integer(maxBytes, "maxBytes", MIN_BYTES, MAX_BYTES);
  if (!new Set(["codex", "claude", "generic"]).has(host)) throw new Error(`unsupported host: ${host}`);
  if (groupId !== null && includePrivate) throw new Error("private context cannot be assembled for a group audience");

  const catalog = await buildCatalog(root);
  const sources = await resolveContext({
    root: catalog.root, cwd, host, maxBytes: limit,
    includeContent: includeSourceContent && groupId === null,
    catalog
  });
  const relationship = entityId
    ? await relationshipContext({ root: catalog.root, entityId, includePrivate, groupId, catalog })
    : null;
  const [learned, attention, tasks, shared] = await Promise.all([
    learningContext({ root: catalog.root, includePrivate, groupId, maxItems: 50, catalog }),
    attentionContext({ root: catalog.root, includePrivate, groupId, focusActive, markPresented: false, maxItems: 20, now, catalog }),
    taskContext({ root: catalog.root, includePrivate, groupId, projectId, includeClosed: false, maxItems: 100, catalog }),
    sharedContext({ root: catalog.root, includePrivate, groupId, maxItems: 50, catalog })
  ]);

  const result = {
    schema: "agentspine.session-briefing/v1",
    root: catalog.root,
    cwd: sources.cwd,
    host,
    scope: { entityId, groupId, projectId, includePrivate },
    focus: { active: Boolean(focusActive), currentTaskId },
    sources: { documents: [] },
    tasks: [],
    relationship: relationship ? { entity: null, relatedEntities: [], edges: [] } : null,
    learning: [],
    shared: [],
    attention: { suppressed: attention.suppressed, items: [] },
    budget: {
      maxBytes: limit,
      usedBytes: 0,
      remainingBytes: 0,
      measurement: "compact-json-utf8",
      omitted: { sources: 0, tasks: 0, relationships: 0, learning: 0, shared: 0, attention: 0 }
    },
    authority: "context-only",
    note: "This packet is descriptive context only. It grants no delegation, host, tool, file, network, production, spending, or policy rights. Native host rules and explicit local policy remain authoritative."
  };
  recalculateBudget(result);
  if (result.budget.usedBytes > limit) throw new Error(`maxBytes is too small for the briefing envelope; use at least ${MIN_BYTES}`);

  const scopedTasks = tasks.items.filter((task) => taskMatchesScope(task, entityId));
  if (currentTaskId && !scopedTasks.some((task) => task.id === currentTaskId)) {
    throw new Error(`current task is not visible in this briefing scope: ${currentTaskId}`);
  }
  const orderedTasks = [...scopedTasks].sort((left, right) => {
    if (left.id === currentTaskId) return -1;
    if (right.id === currentTaskId) return 1;
    return right.priority - left.priority || left.id.localeCompare(right.id);
  });
  for (const task of orderedTasks) {
    if (!tryAdd(result, result.tasks, task)) countOmitted(result, "tasks");
  }

  if (relationship) {
    if (!trySet(result, result.relationship, "entity", relationship.entity)) countOmitted(result, "relationships");
    for (const entity of relationship.relatedEntities.filter((item) => item.id !== entityId)) {
      if (!tryAdd(result, result.relationship.relatedEntities, entity)) countOmitted(result, "relationships");
    }
    for (const edge of relationship.edges) {
      if (!tryAdd(result, result.relationship.edges, edge)) countOmitted(result, "relationships");
    }
  }

  const localItems = learned.items.filter((item) => matchesScope(item, entityId, projectId));
  const localKeys = new Set(localItems.map(normalizeKey));
  for (const item of localItems) {
    if (!tryAdd(result, result.learning, item)) countOmitted(result, "learning");
  }
  for (const item of shared.items.filter((entry) => matchesScope(entry, entityId, projectId))) {
    if (localKeys.has(normalizeKey(item))) {
      countOmitted(result, "shared");
      continue;
    }
    if (!tryAdd(result, result.shared, item)) countOmitted(result, "shared");
  }

  const sourceByteCap = Math.min(8192, Math.floor(limit / 2));
  let sourceBytes = 0;
  for (const document of sources.documents) {
    const mayLoad = document.loaded && document.content !== null && sourceBytes + document.bytes <= sourceByteCap;
    const loaded = mayLoad ? sourceDescriptor(document, document.content) : null;
    if (loaded && tryAdd(result, result.sources.documents, loaded)) {
      sourceBytes += document.bytes;
      continue;
    }
    if (tryAdd(result, result.sources.documents, sourceDescriptor(document))) {
      if (includeSourceContent) countOmitted(result, "sources");
    } else countOmitted(result, "sources");
  }

  const attentionItems = attention.items.filter((item) => !entityId || item.entityId === null || item.entityId === entityId);
  for (const item of attentionItems) {
    if (!tryAdd(result, result.attention.items, item)) countOmitted(result, "attention");
  }

  recalculateBudget(result);
  if (result.budget.usedBytes > limit) throw new Error("briefing budget invariant failed");
  return result;
}
