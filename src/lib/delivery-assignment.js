import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { canonicalPath, projectStateDir } from "./paths.js";
import { writePremortemFile } from "./delivery-premortem-file.js";
import { inspectPremortemState } from "./delivery-premortem.js";
import { canonicalPremortem as canonical, premortemSha256 as sha256,
  premortemTime as at, sealPremortem as seal,
  validPremortemSeal as validSeal, validPremortemTime as validTime } from "./delivery-premortem-codec.js";

const ASSIGNMENT_SCHEMA = "agentspine.delivery-assignment/v1";
const POINTER_SCHEMA = "agentspine.delivery-assignment-pointer/v1";
const AUTHORITY = "context-only";
const MAX_BYTES = 16 * 1024;
const ID_RE = /^assignment:[a-f0-9]{64}$/;

function sessionBinding(binding) {
  return {
    host: binding.host,
    sessionId: binding.sessionId,
    projectId: binding.projectId
  };
}

function sessionDigest(binding) {
  return sha256({ schema: "agentspine.delivery-assignment-session/v1",
    binding: sessionBinding(binding) });
}

function eventDigest(binding, eventId) {
  return sha256({ schema: "agentspine.delivery-assignment-event/v1",
    binding: sessionBinding(binding), eventId });
}

function validAssignment(value, expectedSessionDigest = null) {
  return value && value.schema === ASSIGNMENT_SCHEMA && value.authority === AUTHORITY
    && ID_RE.test(value.assignmentId || "")
    && /^[a-f0-9]{64}$/.test(value.sessionDigest || "")
    && /^[a-f0-9]{64}$/.test(value.eventDigest || "")
    && (value.predecessorAssignmentId === null || ID_RE.test(value.predecessorAssignmentId || ""))
    && value.binding && canonical(sessionBinding(value.binding)) === canonical(sessionBinding(value))
    && (!expectedSessionDigest || value.sessionDigest === expectedSessionDigest)
    && validTime(value.createdAt) && validSeal(value);
}

function validPointer(value, digest) {
  return value && value.schema === POINTER_SCHEMA && value.authority === AUTHORITY
    && value.sessionDigest === digest && validAssignment(value.assignment, digest)
    && value.assignmentId === value.assignment.assignmentId
    && Number.isInteger(value.revision) && value.revision > 0
    && validTime(value.updatedAt) && validSeal(value);
}

async function pathsFor(root, binding) {
  const digest = sessionDigest(binding);
  const directory = join(await projectStateDir(await canonicalPath(root)),
    "delivery-assignments", digest);
  await mkdir(join(directory, "events"), { recursive: true, mode: 0o700 });
  return { digest, directory, pointer: join(directory, "active.json"),
    lock: join(directory, "active.lock") };
}

async function readJson(path, maxBytes = MAX_BYTES) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > maxBytes) throw new Error("delivery assignment state exceeds 16 KiB");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("delivery assignment state is not valid JSON");
    throw error;
  }
}

async function readPointer(paths) {
  const value = await readJson(paths.pointer);
  if (value && !validPointer(value, paths.digest)) {
    throw new Error("delivery assignment pointer failed integrity validation");
  }
  return value;
}

function assignmentFor(binding, eventId, digest, predecessor, now) {
  const event = eventDigest(binding, eventId);
  return seal({ schema: ASSIGNMENT_SCHEMA,
    assignmentId: `assignment:${sha256({ sessionDigest: digest, eventDigest: event })}`,
    sessionDigest: digest, eventDigest: event,
    host: binding.host, sessionId: binding.sessionId, projectId: binding.projectId,
    binding: { host: binding.host, sessionId: binding.sessionId,
      projectId: binding.projectId, entityId: binding.entityId || null,
      groupId: binding.groupId || null, taskId: binding.taskId || null,
      goalId: binding.goalId || null, goalStepId: binding.goalStepId || null,
      queueId: binding.queueId || null, gatewayAttempt: binding.gatewayAttempt ?? null,
      planDefinitionsDigest: binding.planDefinitionsDigest || null },
    predecessorAssignmentId: predecessor?.assignmentId || null,
    createdAt: at(now), authority: AUTHORITY });
}

function pointerFor(paths, assignment, previous, now) {
  return seal({ schema: POINTER_SCHEMA, sessionDigest: paths.digest,
    assignmentId: assignment.assignmentId, assignment,
    revision: (previous?.revision || 0) + 1,
    updatedAt: at(now), authority: AUTHORITY });
}

async function publishEvent(path, assignment, assertOwned) {
  const existing = await readJson(path);
  if (existing) {
    if (!validAssignment(existing, assignment.sessionDigest)
      || existing.assignmentId !== assignment.assignmentId
      || existing.eventDigest !== assignment.eventDigest) {
      throw new Error("delivery assignment event conflicts with stored history");
    }
    return existing;
  }
  await writePremortemFile(path, assignment, assertOwned, MAX_BYTES);
  return assignment;
}

export async function beginDeliveryAssignment({ root, binding, eventId, now = new Date() }) {
  if (typeof eventId !== "string" || !eventId || eventId.length > 512 || /[\0\r\n]/.test(eventId)) {
    throw new Error("delivery assignment requires an exact prompt eventId");
  }
  const paths = await pathsFor(root, binding);
  return withOwnedFileLock(paths.lock, async ({ assertOwned }) => {
    const previous = await readPointer(paths);
    const proposed = assignmentFor(binding, eventId, paths.digest, previous?.assignment || null, now);
    const path = join(paths.directory, "events", `${proposed.eventDigest}.json`);
    const assignment = await publishEvent(path, proposed, assertOwned);
    if (previous?.assignmentId === assignment.assignmentId) {
      return { status: "duplicate", blocked: false, assignmentId: assignment.assignmentId,
        assignment: structuredClone(assignment) };
    }
    if (assignment.predecessorAssignmentId !== (previous?.assignmentId || null)) {
      return { status: "stale-assignment", blocked: true,
        reason: "A replayed prompt cannot replace the current delivery assignment." };
    }
    await writePremortemFile(paths.pointer, pointerFor(paths, assignment, previous, now),
      assertOwned, MAX_BYTES);
    return { status: "started", blocked: false, assignmentId: assignment.assignmentId,
      assignment: structuredClone(assignment) };
  });
}

export async function resolveDeliveryAssignment({ root, binding, assignmentId = null }) {
  const paths = await pathsFor(root, binding);
  const pointer = await readPointer(paths);
  if (!pointer) return { status: "legacy", blocked: false, assignmentId: null, assignment: null };
  if (assignmentId && assignmentId !== pointer.assignmentId) {
    return { status: "foreign-assignment", blocked: true,
      reason: "The supplied delivery assignment is not active for this exact session and project." };
  }
  const stored = pointer.assignment.binding;
  for (const key of ["entityId", "groupId", "taskId"]) {
    if (stored[key] && binding[key] && stored[key] !== binding[key]) {
      return { status: "foreign-assignment", blocked: true,
        reason: `The active delivery assignment is bound to a different ${key}.` };
    }
  }
  return { status: "resolved", blocked: false, assignmentId: pointer.assignmentId,
    assignment: structuredClone(pointer.assignment) };
}

export async function continueDeliveryAssignment({ root, binding, assignmentId }) {
  if (!ID_RE.test(assignmentId || "")) {
    return { status: "foreign-assignment", blocked: true,
      reason: "Continuation requires the exact active assignmentId returned by this host session." };
  }
  const paths = await pathsFor(root, binding);
  // Serialize the check with new assignments. Continuation never advances the pointer
  // or rewrites history, including when a process exits during this inspection.
  return withOwnedFileLock(paths.lock, async () => {
    const current = await resolveDeliveryAssignment({ root, binding, assignmentId });
    if (current.blocked) return current;
    if (!current.assignment) return { status: "foreign-assignment", blocked: true,
      reason: "This session has no active assignment matching the continuation." };
    for (const key of ["entityId", "groupId", "taskId", "goalId", "goalStepId", "queueId",
      "gatewayAttempt", "planDefinitionsDigest"]) {
      if ((current.assignment.binding[key] || null) !== (binding[key] || null)) {
        return { status: "foreign-assignment", blocked: true,
          reason: `Continuation requires the same explicit ${key} binding, including absence.` };
      }
    }
    const exact = assignmentPremortemBinding(binding, current);
    const inspected = await inspectPremortemState({ root, binding: exact });
    if (inspected.blocked || inspected.status === "degraded") return inspected;
    if (!inspected.requirement) return { status: "missing", blocked: true,
      reason: "The exact continuation scope has no existing premortem requirement." };
    if (inspected.closed || inspected.consumed) return { status: "finalized", blocked: true,
      reason: "A completed assignment cannot be continued; a new delivery needs fresh preflight calls." };
    if (inspected.conflicted) return { status: "conflict", blocked: true,
      requirementId: inspected.requirementId,
      reason: "Continuation cannot repair a conflicted registration or bypass its recovery checks." };
    return { ...current, status: "continued", requirement: inspected.requirement,
      requirementId: inspected.requirementId, binding: exact };
  });
}

export async function withActiveDeliveryAssignment({ root, binding }, action) {
  const paths = await pathsFor(root, binding);
  return withOwnedFileLock(paths.lock, async ({ assertOwned }) => {
    const current = await resolveDeliveryAssignment({ root, binding,
      assignmentId: binding.assignmentId });
    if (current.blocked) return current;
    if (!current.assignment || current.assignmentId !== binding.assignmentId) {
      return { status: "foreign-assignment", blocked: true,
        reason: "Completion requires the active assignment for this session and project." };
    }
    const result = await action(assertOwned);
    await assertOwned();
    return result;
  });
}

export function assignmentPremortemBinding(binding, result) {
  if (binding.goalId || binding.queueId) return { ...binding, assignmentId: null };
  if (!result?.assignment) return { ...binding, assignmentId: null };
  return { ...binding, ...result.assignment.binding,
    assignmentId: result.assignment.assignmentId };
}
