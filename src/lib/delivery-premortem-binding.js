import { createHash } from "node:crypto";

const DIGEST_RE = /^[a-f0-9]{64}$/;
const REQUIREMENT_RE = /^premortem-requirement:([a-f0-9]{64}):([a-f0-9]{64})$/;
const VALUE_LIMIT = 512;

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function bounded(value, name, limit = VALUE_LIMIT, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value || value.length > limit || /[\0\r\n]/.test(value)) {
    throw new Error(`premortem ${name} is invalid`);
  }
  return value;
}

export function normalizePremortemBinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("premortem binding is missing");
  const suppliedTask = input.taskId ?? input.currentTaskId ?? null;
  if (input.taskId && input.currentTaskId && input.taskId !== input.currentTaskId) {
    throw new Error("premortem task binding is inconsistent");
  }
  const binding = {
    host: bounded(input.host, "host"), sessionId: bounded(input.sessionId, "sessionId"),
    projectId: bounded(input.projectId, "projectId"),
    entityId: bounded(input.entityId, "entityId", VALUE_LIMIT, true),
    groupId: bounded(input.groupId, "groupId", VALUE_LIMIT, true),
    taskId: bounded(suppliedTask, "taskId", VALUE_LIMIT, true),
    assignmentId: bounded(input.assignmentId, "assignmentId", VALUE_LIMIT, true),
    goalId: bounded(input.goalId, "goalId", VALUE_LIMIT, true),
    goalStepId: bounded(input.goalStepId, "goalStepId", VALUE_LIMIT, true),
    queueId: bounded(input.queueId, "queueId", VALUE_LIMIT, true),
    gatewayAttempt: input.gatewayAttempt ?? null,
    planDefinitionsDigest: bounded(input.planDefinitionsDigest, "planDefinitionsDigest", 64, true)?.toLowerCase() ?? null
  };
  if (Boolean(binding.goalId) !== Boolean(binding.goalStepId)) throw new Error("premortem goal and step must be paired");
  if (binding.planDefinitionsDigest && !binding.goalId) throw new Error("premortem plan digest requires a goal step");
  if (binding.gatewayAttempt !== null && (!Number.isInteger(binding.gatewayAttempt)
    || binding.gatewayAttempt < 1 || !binding.queueId)) {
    throw new Error("premortem gatewayAttempt must be a positive integer bound to a queue");
  }
  if (binding.planDefinitionsDigest && !DIGEST_RE.test(binding.planDefinitionsDigest)) {
    throw new Error("premortem planDefinitionsDigest must be a SHA-256 digest");
  }
  return binding;
}

export function premortemLaneDigest(binding) {
  const { assignmentId, ...legacyBinding } = binding;
  const exact = binding.queueId || binding.goalId ? legacyBinding
    : assignmentId ? binding
      : { host: binding.host, sessionId: binding.sessionId, projectId: binding.projectId };
  return sha256({ schema: "agentspine.delivery-premortem-lane/v1", binding: exact });
}

export function validPremortemStateBinding(state, expectedDigest) {
  try {
    return premortemLaneDigest(normalizePremortemBinding(state?.binding)) === expectedDigest;
  } catch {
    return false;
  }
}

export function formatPremortemRequirementId(laneDigest, generationDigest = null) {
  return generationDigest
    ? `premortem-requirement:${laneDigest}:${generationDigest}`
    : `premortem-requirement:${laneDigest}`;
}

export function parsePremortemRequirementId(value) {
  const match = typeof value === "string" ? value.match(REQUIREMENT_RE) : null;
  if (!match) throw new Error("premortem requirementId is invalid");
  return { laneDigest: match[1], generationDigest: match[2] };
}

export function deliveryWriteIdDigest(input) {
  const supplied = input?.tool_use_id ?? input?.event_id ?? input?.hook_event_id;
  return sha256(typeof supplied === "string" && supplied ? supplied : canonical(input ?? null));
}

export function premortemWriteIdentity(input, phase) {
  const toolInput = input?.tool_input ?? input?.toolInput;
  const material = { schema: "agentspine.delivery-premortem-write/v1",
    idDigest: deliveryWriteIdDigest(input),
    inputDigest: sha256(toolInput ?? null), inputKnown: toolInput !== undefined,
    phase, authority: "context-only" };
  return { ...material, digest: sha256(material) };
}

export function premortemGoalBindingSummary(state) {
  const { binding } = state;
  const value = { goalId: binding.goalId, goalStepId: binding.goalStepId,
    queueId: binding.queueId, gatewayAttempt: binding.gatewayAttempt,
    planDefinitionsDigest: binding.planDefinitionsDigest, host: binding.host,
    projectId: binding.projectId, entityId: binding.entityId, groupId: binding.groupId,
    taskId: binding.taskId, laneDigest: state.laneDigest,
    sessionDigest: sha256(binding.sessionId), authority: "context-only" };
  return { ...value, digest: sha256(value) };
}
