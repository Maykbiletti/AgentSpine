import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";

const ACTIONS = new Set(["assign", "reassign", "manage", "complete", "cancel"]);
const TASK_KINDS = new Set(["task", "open-thread", "handoff"]);
const STATUSES = new Set(["open", "in-progress", "blocked", "completed", "cancelled"]);
const PRIVACY = new Set(["private", "shared", "group"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const CONFIRMATION = "local-owner-confirmed";
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;

function emptyPolicy(root) {
  return {
    schema: "agentspine.delegation-policy/v1",
    root,
    revision: 0,
    grants: [],
    history: []
  };
}

function emptyCoordination(root) {
  return {
    schema: "agentspine.coordination/v1",
    root,
    tasks: [],
    history: []
  };
}

function validateStateShape(value, root, schema, arrays) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== schema || value.root !== root
    || arrays.some((key) => !Array.isArray(value[key]) || !value[key].every((item) => item && typeof item === "object"))) {
    throw new Error(`${schema} state structure is invalid; run the audit before coordination`);
  }
  return value;
}

function normalizePolicy(value, root) {
  const policy = validateStateShape(value, root, "agentspine.delegation-policy/v1", ["grants", "history"]);
  if (!Number.isInteger(policy.revision) || policy.revision < 0) throw new Error("delegation policy revision is invalid");
  return policy;
}

function normalizeCoordination(value, root) {
  return validateStateShape(value, root, "agentspine.coordination/v1", ["tasks", "history"]);
}

function timestamp(value, field = "date", nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function numeric(value, field, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function text(value, field, maximum, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (!value || typeof value !== "string") throw new Error(`${field} is required`);
  const result = value.trim().slice(0, maximum);
  if (!result) {
    if (nullable) return null;
    throw new Error(`${field} is required`);
  }
  if (SECRET_RE.test(result)) throw new Error(`${field} appears to contain a secret and cannot enter coordination state`);
  return result;
}

async function readJson(path, root, normalize, empty) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("coordination state exceeds the 5 MiB read limit");
    return normalize(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return empty(root);
  }
}

async function saveJson(value, path) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("coordination state exceeds 5 MiB; archive old tasks first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return { handle: await open(lockPath, "wx", 0o600), lockPath };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("coordination state is busy; retry shortly");
}

async function withStateLock(path, read, task, save = true) {
  const { handle, lockPath } = await acquireLock(path);
  try {
    const state = await read();
    const result = await task(state);
    if (save) await saveJson(state, path);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function pathsFor(root, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return {
    catalog,
    policyPath: join(directory, "delegation-policy.json"),
    coordinationPath: join(directory, "coordination.json")
  };
}

export async function loadDelegationPolicy(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  const policy = await readJson(paths.policyPath, paths.catalog.root, normalizePolicy, emptyPolicy);
  return { policy, ...paths };
}

export async function loadCoordination(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  const coordination = await readJson(paths.coordinationPath, paths.catalog.root, normalizeCoordination, emptyCoordination);
  return { coordination, ...paths };
}

export async function inspectCoordination(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  let policy = emptyPolicy(paths.catalog.root);
  let coordination = emptyCoordination(paths.catalog.root);
  const errors = [];
  try { policy = await readJson(paths.policyPath, paths.catalog.root, normalizePolicy, emptyPolicy); } catch (error) { errors.push(`policy:${error.message}`); }
  try { coordination = await readJson(paths.coordinationPath, paths.catalog.root, normalizeCoordination, emptyCoordination); } catch (error) { errors.push(`coordination:${error.message}`); }
  return { policy, coordination, errors, ...paths };
}

function knownActor(graph, id) {
  return graph.entities.find((entity) => entity.id === id && ["person", "agent"].includes(entity.kind));
}

function validateEntity(graph, id, field, nullable = false) {
  if ((id === null || id === undefined) && nullable) return null;
  if (!ID_RE.test(id || "") || !knownActor(graph, id)) throw new Error(`${field} must reference a known person or agent`);
  return id;
}

function policyDecision(policy, actorId, action, targetId) {
  const grant = policy.grants.find((item) => item.active === true && item.actorId === actorId
    && item.actions.includes(action) && (item.targetIds.includes("*") || (targetId && item.targetIds.includes(targetId))));
  return grant ? {
    allowed: true,
    action,
    actorId,
    targetId,
    grantId: grant.id,
    policyRevision: policy.revision,
    reason: "matched explicit local delegation policy",
    authority: "explicit-local-delegation-policy"
  } : {
    allowed: false,
    action,
    actorId,
    targetId,
    grantId: null,
    policyRevision: policy.revision,
    reason: "default deny: no matching explicit local delegation grant",
    authority: "explicit-local-delegation-policy"
  };
}

export async function checkDelegation({ root = process.cwd(), actorId, action, targetId = null }) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported delegation action: ${action}`);
  const { policy, catalog } = await loadDelegationPolicy(root);
  const { graph } = await loadGraph(catalog.root, catalog);
  const findings = delegationPolicyFindings(policy, graph);
  if (findings.length) throw new Error(`delegation policy failed closed: ${findings.join(", ")}`);
  validateEntity(graph, actorId, "actorId");
  if (targetId !== null) validateEntity(graph, targetId, "targetId");
  return {
    ...policyDecision(policy, actorId, action, targetId),
    note: "This decision covers AgentSpine task coordination only. It grants no host, tool, file, network, production, or spending rights."
  };
}

function requireOwnerConfirmation(confirmation) {
  if (confirmation !== CONFIRMATION) throw new Error("delegation policy changes require explicit local owner confirmation");
}

function preservePolicy(policy, value, now) {
  policy.history.push({
    kind: "delegation-grant",
    recordId: value.id,
    supersededAt: now,
    value: { ...value, authority: "explicit-local-delegation-policy" },
    authority: "explicit-local-delegation-policy"
  });
}

export async function grantDelegation({
  root = process.cwd(), id = `grant:${randomUUID()}`, actorId, actions, targetIds = ["*"],
  reason, confirmation, now = new Date()
}) {
  requireOwnerConfirmation(confirmation);
  if (!ID_RE.test(id)) throw new Error("grant id must be stable and whitespace-free");
  if (!Array.isArray(actions) || !actions.length || actions.some((action) => !ACTIONS.has(action))) throw new Error("actions contains an unsupported delegation action");
  if (!Array.isArray(targetIds) || !targetIds.length) throw new Error("targetIds is required");
  const policyReason = text(reason, "reason", 500);
  const at = timestamp(now, "now");
  const { catalog, policyPath } = await pathsFor(root);
  const { graph } = await loadGraph(catalog.root, catalog);
  validateEntity(graph, actorId, "actorId");
  for (const targetId of targetIds) if (targetId !== "*") validateEntity(graph, targetId, "targetId");
  return withStateLock(policyPath, () => readJson(policyPath, catalog.root, normalizePolicy, emptyPolicy), (policy) => {
    const findings = delegationPolicyFindings(policy, graph);
    if (findings.length) throw new Error(`delegation policy failed closed: ${findings.join(", ")}`);
    if (policy.grants.some((grant) => grant.id === id)) throw new Error("delegation grant IDs are immutable; revoke the old grant and create a new one");
    policy.revision += 1;
    const grant = {
      id,
      actorId,
      actions: [...new Set(actions)].sort(),
      targetIds: [...new Set(targetIds)].sort(),
      reason: policyReason,
      active: true,
      createdAt: at,
      updatedAt: at,
      revision: policy.revision,
      source: "explicit-local-owner-policy",
      authority: "explicit-local-delegation-policy"
    };
    policy.grants.push(grant);
    policy.grants.sort((a, b) => a.id.localeCompare(b.id));
    return { grant, policyRevision: policy.revision, policyPath };
  });
}

export async function revokeDelegation({ root = process.cwd(), id, reason, confirmation, now = new Date() }) {
  requireOwnerConfirmation(confirmation);
  if (!ID_RE.test(id || "")) throw new Error("grant id is required");
  const revokeReason = text(reason, "reason", 500);
  const at = timestamp(now, "now");
  const { catalog, policyPath } = await pathsFor(root);
  const { graph } = await loadGraph(catalog.root, catalog);
  return withStateLock(policyPath, () => readJson(policyPath, catalog.root, normalizePolicy, emptyPolicy), (policy) => {
    const findings = delegationPolicyFindings(policy, graph);
    if (findings.length) throw new Error(`delegation policy failed closed: ${findings.join(", ")}`);
    const previous = policy.grants.find((grant) => grant.id === id);
    if (!previous) throw new Error(`unknown delegation grant: ${id}`);
    if (!previous.active) throw new Error(`delegation grant is already revoked: ${id}`);
    preservePolicy(policy, previous, at);
    policy.revision += 1;
    const grant = {
      ...previous,
      active: false,
      revokedAt: at,
      revokeReason,
      updatedAt: at,
      revision: policy.revision,
      authority: "explicit-local-delegation-policy"
    };
    policy.grants = policy.grants.map((item) => item.id === id ? grant : item);
    return { grant, policyRevision: policy.revision, policyPath };
  });
}

function isGroupMember(graph, groupId, entityId) {
  if (!entityId || entityId === groupId) return true;
  return graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
    (edge.from === entityId && edge.to === groupId) || (edge.to === entityId && edge.from === groupId)
  ));
}

function validatePrivacy(graph, privacy, groupId, actorId, assigneeId) {
  if (!PRIVACY.has(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  if (privacy === "group") {
    const group = graph.entities.find((entity) => entity.id === groupId && entity.kind === "group");
    if (!group) throw new Error("group privacy requires a known groupId");
    for (const entityId of [actorId, assigneeId].filter(Boolean)) {
      if (!isGroupMember(graph, groupId, entityId)) throw new Error(`${entityId} is not a visible member of ${groupId}`);
    }
  } else if (groupId !== null && groupId !== undefined) {
    throw new Error("groupId is only valid with group privacy");
  }
}

function preserveTask(coordination, value, now) {
  coordination.history.push({
    kind: "coordination-task",
    recordId: value.id,
    actorId: value.createdBy,
    assigneeId: value.assigneeId,
    supersededAt: now,
    privacy: value.privacy,
    value: { ...value, authority: "context-only" },
    authority: "context-only"
  });
}

async function coordinationMutation(root, operation) {
  const { catalog, policyPath, coordinationPath } = await pathsFor(root);
  const { graph } = await loadGraph(catalog.root, catalog);
  return withStateLock(
    policyPath,
    () => readJson(policyPath, catalog.root, normalizePolicy, emptyPolicy),
    (policy) => withStateLock(
      coordinationPath,
      () => readJson(coordinationPath, catalog.root, normalizeCoordination, emptyCoordination),
      (coordination) => {
        const findings = [
          ...delegationPolicyFindings(policy, graph),
          ...coordinationFindings(coordination, policy, graph)
        ];
        if (findings.length) throw new Error(`coordination state failed closed: ${findings.join(", ")}`);
        return operation({ policy, coordination, graph, catalog, policyPath, coordinationPath });
      }
    ),
    false
  );
}

function decisionSnapshot(decision, at) {
  return { ...decision, decidedAt: at };
}

export async function createTask({
  root = process.cwd(), id = `task:${randomUUID()}`, actorId, assigneeId = null,
  kind = "task", title, summary = null, projectId = null, privacy = "private", groupId = null,
  priority = 50, dueAt = null, now = new Date()
}) {
  if (!ID_RE.test(id)) throw new Error("task id must be stable and whitespace-free");
  if (!TASK_KINDS.has(kind)) throw new Error(`unsupported task kind: ${kind}`);
  const taskTitle = text(title, "title", 200);
  const taskSummary = text(summary, "summary", 1000, true);
  const at = timestamp(now, "now");
  const due = timestamp(dueAt, "dueAt", true);
  return coordinationMutation(root, async ({ policy, coordination, graph, coordinationPath }) => {
    if (coordination.tasks.some((task) => task.id === id)) throw new Error("task IDs are immutable");
    validateEntity(graph, actorId, "actorId");
    if (assigneeId !== null) validateEntity(graph, assigneeId, "assigneeId");
    if (projectId !== null && !graph.entities.some((entity) => entity.id === projectId && entity.kind === "project")) throw new Error("projectId must reference a known project");
    validatePrivacy(graph, privacy, groupId, actorId, assigneeId);
    let assignment;
    if (!assigneeId || assigneeId === actorId) {
      assignment = { allowed: true, action: "assign", actorId, targetId: assigneeId, grantId: null, policyRevision: policy.revision, reason: "self-assignment or unassigned thread", authority: "self-coordination" };
    } else {
      assignment = policyDecision(policy, actorId, "assign", assigneeId);
      if (!assignment.allowed) throw new Error(assignment.reason);
    }
    const task = {
      id,
      kind,
      title: taskTitle,
      summary: taskSummary,
      createdBy: actorId,
      assigneeId,
      projectId,
      privacy,
      groupId,
      priority: numeric(priority, "priority", 0, 100),
      dueAt: due,
      status: "open",
      note: null,
      assignment: decisionSnapshot(assignment, at),
      createdAt: at,
      updatedAt: at,
      authority: "context-only"
    };
    coordination.tasks.push(task);
    coordination.tasks.sort((a, b) => a.id.localeCompare(b.id));
    return { task, coordinationPath };
  });
}

function canManageTask(policy, task, actorId, action, targetId) {
  if (actorId === task.assigneeId || (task.assigneeId === null && actorId === task.createdBy)) {
    return { allowed: true, action, actorId, targetId, grantId: null, policyRevision: policy.revision, reason: "assignee self-management", authority: "self-coordination" };
  }
  return policyDecision(policy, actorId, action, targetId);
}

export async function updateTask({ root = process.cwd(), id, actorId, patch = {}, now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("task id is required");
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) throw new Error("patch must change at least one task field");
  const allowedFields = new Set(["status", "assigneeId", "title", "summary", "priority", "dueAt", "note"]);
  const unknown = Object.keys(patch).filter((key) => !allowedFields.has(key));
  if (unknown.length) throw new Error(`unsupported task patch: ${unknown.join(", ")}`);
  const at = timestamp(now, "now");
  return coordinationMutation(root, async ({ policy, coordination, graph, coordinationPath }) => {
    const previous = coordination.tasks.find((task) => task.id === id);
    if (!previous) throw new Error(`unknown coordination task: ${id}`);
    validateEntity(graph, actorId, "actorId");
    let assignment = previous.assignment;
    const nextAssignee = "assigneeId" in patch ? patch.assigneeId : previous.assigneeId;
    if (nextAssignee !== null) validateEntity(graph, nextAssignee, "assigneeId");
    if (nextAssignee !== previous.assigneeId) {
      const decision = policyDecision(policy, actorId, "reassign", nextAssignee);
      if (!decision.allowed) throw new Error(decision.reason);
      validatePrivacy(graph, previous.privacy, previous.groupId, actorId, nextAssignee);
      assignment = decisionSnapshot(decision, at);
    }
    if (patch.status && !STATUSES.has(patch.status)) throw new Error(`unsupported task status: ${patch.status}`);
    if (patch.status && patch.status !== previous.status) {
      const action = patch.status === "cancelled" ? "cancel" : patch.status === "completed" ? "complete" : "manage";
      const decision = canManageTask(policy, previous, actorId, action, previous.assigneeId);
      if (!decision.allowed) throw new Error(decision.reason);
    }
    const changesContent = ["title", "summary", "priority", "dueAt", "note"].some((key) => key in patch);
    if (changesContent && actorId !== previous.createdBy && actorId !== previous.assigneeId) {
      const decision = policyDecision(policy, actorId, "manage", previous.assigneeId);
      if (!decision.allowed) throw new Error(decision.reason);
    }
    preserveTask(coordination, previous, at);
    const task = {
      ...previous,
      assigneeId: nextAssignee,
      assignment,
      status: patch.status || previous.status,
      title: "title" in patch ? text(patch.title, "title", 200) : previous.title,
      summary: "summary" in patch ? text(patch.summary, "summary", 1000, true) : previous.summary,
      priority: "priority" in patch ? numeric(patch.priority, "priority", 0, 100) : previous.priority,
      dueAt: "dueAt" in patch ? timestamp(patch.dueAt, "dueAt", true) : previous.dueAt,
      note: "note" in patch ? text(patch.note, "note", 1000, true) : previous.note,
      updatedAt: at,
      authority: "context-only"
    };
    coordination.tasks = coordination.tasks.map((entry) => entry.id === id ? task : entry);
    return { task, coordinationPath };
  });
}

function audienceIds(graph, groupId, includePrivate) {
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

function taskVisible(task, entities, audience, includePrivate, groupId) {
  if (task.privacy === "private" && !includePrivate) return false;
  if (task.privacy === "group" && (!groupId || task.groupId !== groupId)) return false;
  for (const id of [task.createdBy, task.assigneeId].filter(Boolean)) {
    const entity = entities.get(id);
    if (entity?.privacy === "private" && !includePrivate) return false;
    if (entity?.privacy === "group" && !audience.has(id)) return false;
  }
  return true;
}

export async function taskContext({
  root = process.cwd(), includePrivate = false, groupId = null, actorId = null,
  assigneeId = null, projectId = null, includeClosed = false, maxItems = 20,
  catalog: providedCatalog = null
} = {}) {
  const { coordination, catalog } = await loadCoordination(root, providedCatalog);
  const { policy } = await loadDelegationPolicy(catalog.root, catalog);
  const { graph } = await loadGraph(catalog.root, catalog);
  const findings = [
    ...delegationPolicyFindings(policy, graph),
    ...coordinationFindings(coordination, policy, graph)
  ];
  if (findings.length) throw new Error(`coordination state failed closed: ${findings.join(", ")}`);
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  if (groupId !== null && !graph.entities.some((entity) => entity.id === groupId && entity.kind === "group")) throw new Error(`unknown group entity: ${groupId}`);
  const audience = audienceIds(graph, groupId, includePrivate);
  const limit = numeric(maxItems, "maxItems", 0, 100);
  if (!Number.isInteger(limit)) throw new Error("maxItems must be an integer");
  const items = coordination.tasks
    .filter((task) => includeClosed || !["completed", "cancelled"].includes(task.status))
    .filter((task) => !actorId || task.createdBy === actorId)
    .filter((task) => !assigneeId || task.assigneeId === assigneeId)
    .filter((task) => !projectId || task.projectId === projectId)
    .filter((task) => taskVisible(task, entities, audience, includePrivate, groupId))
    .sort((a, b) => b.priority - a.priority || (a.dueAt || "9999").localeCompare(b.dueAt || "9999") || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ assignment: _assignment, ...task }) => ({ ...task, authority: "context-only" }));
  return {
    schema: "agentspine.task-context/v1",
    root: catalog.root,
    groupId,
    items,
    authority: "context-only",
    note: "Tasks describe coordination only. They grant no host, tool, file, network, production, or spending rights."
  };
}

export async function deleteTask({ root = process.cwd(), id, confirmation }) {
  requireOwnerConfirmation(confirmation);
  if (!ID_RE.test(id || "")) throw new Error("task id is required");
  return coordinationMutation(root, ({ coordination, coordinationPath }) => {
    const existed = coordination.tasks.some((task) => task.id === id);
    coordination.tasks = coordination.tasks.filter((task) => task.id !== id);
    coordination.history = coordination.history.filter((entry) => entry.recordId !== id && entry.value?.id !== id);
    return { deleted: existed, id, coordinationPath };
  });
}

export function delegationPolicyFindings(policy, graph) {
  const findings = [];
  if (policy.schema !== "agentspine.delegation-policy/v1" || !Number.isInteger(policy.revision) || policy.revision < 0) findings.push("invalid-policy");
  const grants = [...policy.grants, ...policy.history.map((entry) => entry.value).filter(Boolean)];
  if (new Set(policy.grants.map((grant) => grant.id)).size !== policy.grants.length) findings.push("duplicate-active-grant-id");
  for (const grant of grants) {
    if (!ID_RE.test(grant.id || "") || grant.authority !== "explicit-local-delegation-policy" || grant.source !== "explicit-local-owner-policy"
      || !knownActor(graph, grant.actorId) || !Array.isArray(grant.actions) || grant.actions.some((action) => !ACTIONS.has(action))
      || !Array.isArray(grant.targetIds) || grant.targetIds.some((id) => id !== "*" && !knownActor(graph, id))
      || typeof grant.active !== "boolean" || typeof grant.reason !== "string" || !grant.reason
      || SECRET_RE.test(grant.reason || "") || !Number.isInteger(grant.revision) || grant.revision < 1 || grant.revision > policy.revision) {
      findings.push(`invalid-grant:${grant.id || "unknown"}`);
    }
  }
  if (policy.history.some((entry) => entry.authority !== "explicit-local-delegation-policy")) findings.push("invalid-policy-history");
  return findings;
}

export function coordinationFindings(coordination, policy, graph) {
  const findings = [];
  const allGrants = new Map([...policy.grants, ...policy.history.map((entry) => entry.value).filter(Boolean)].map((grant) => [grant.id, grant]));
  const records = [
    ...coordination.tasks.map((task) => ({ task, current: true })),
    ...coordination.history.map((entry) => entry.value).filter(Boolean).map((task) => ({ task, current: false }))
  ];
  for (const { task, current } of records) {
    if (!ID_RE.test(task.id || "") || task.authority !== "context-only" || !TASK_KINDS.has(task.kind) || !STATUSES.has(task.status) || !PRIVACY.has(task.privacy)
      || typeof task.title !== "string" || !task.title || task.title.length > 200
      || (task.summary !== null && typeof task.summary !== "string") || (task.note !== null && typeof task.note !== "string")
      || !Number.isFinite(task.priority) || task.priority < 0 || task.priority > 100
      || !knownActor(graph, task.createdBy) || (task.assigneeId && !knownActor(graph, task.assigneeId))) {
      findings.push(`invalid-task:${task.id || "unknown"}`);
    }
    const grant = allGrants.get(task.assignment?.grantId);
    if (task.assignment?.authority === "explicit-local-delegation-policy" && (
      !grant || grant.actorId !== task.assignment.actorId || !grant.actions.includes(task.assignment.action)
      || (!grant.targetIds.includes("*") && !grant.targetIds.includes(task.assignment.targetId))
    )) findings.push(`missing-policy-snapshot:${task.id}`);
    if (task.assignment?.allowed !== true || !new Set(["explicit-local-delegation-policy", "self-coordination"]).has(task.assignment?.authority)
      || task.assignment?.targetId !== task.assigneeId || !Number.isInteger(task.assignment?.policyRevision)
      || task.assignment.policyRevision < 0 || task.assignment.policyRevision > policy.revision) findings.push(`invalid-assignment:${task.id}`);
    if (task.assignment?.authority === "self-coordination" && task.assigneeId && task.assigneeId !== task.createdBy) findings.push(`invalid-self-assignment:${task.id}`);
    if (SECRET_RE.test(`${task.title || ""} ${task.summary || ""} ${task.note || ""}`)) findings.push(`unsafe-task:${task.id}`);
    const knownGroup = graph.entities.some((entity) => entity.id === task.groupId && entity.kind === "group");
    if (task.privacy === "group" && (!knownGroup || (current && (!isGroupMember(graph, task.groupId, task.createdBy) || !isGroupMember(graph, task.groupId, task.assigneeId))))) findings.push(`invalid-task-group:${task.id}`);
    if (task.privacy !== "group" && task.groupId) findings.push(`unexpected-task-group:${task.id}`);
  }
  if (coordination.history.some((entry) => entry.authority !== "context-only")) findings.push("invalid-task-history");
  return findings;
}
