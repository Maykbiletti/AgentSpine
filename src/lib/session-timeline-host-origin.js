import { verifyPreflightReceipt } from "./preflight.js";

const verifiedOrigins = new WeakSet();
const USER_PROMPT_SUBMIT = "UserPromptSubmit";

function timelineBinding(input, scope) {
  return {
    host: scope?.host, sessionId: input?.session_id ?? input?.sessionId,
    entityId: scope?.entityId, userId: scope?.userId, tenantId: scope?.tenantId,
    projectId: scope?.projectId, groupId: scope?.groupId,
    taskId: scope?.currentTaskId, goalId: scope?.goalId, goalStepId: scope?.goalStepId
  };
}

function sameBinding(left, right) {
  return ["host", "sessionId", "entityId", "userId", "tenantId", "projectId", "groupId", "taskId", "goalId", "goalStepId"]
    .every((key) => left?.[key] === right?.[key]);
}

function sameInput(left, right) {
  return (left?.transcript_path ?? left?.transcriptPath) === (right?.transcript_path ?? right?.transcriptPath)
    && (left?.event_id ?? left?.hook_event_id ?? null) === (right?.event_id ?? right?.hook_event_id ?? null);
}

function consumedResult(origin = null) { return { consumed: true, origin }; }

function eligibleTimelineOrigin(binding, input) {
  const transcriptPath = input?.transcript_path ?? input?.transcriptPath;
  return binding.host === "claude" && binding.groupId === null
    && typeof transcriptPath === "string" && transcriptPath.length > 0;
}

// The opaque object is process-local and recorded in a WeakSet only after the
// exact preflight receipt was atomically consumed for this UserPromptSubmit.
// It is never serialized, persisted, returned to a model, or accepted from a
// raw CLI/API object. A raw issuer can therefore not simulate host origin.
export async function consumeTimelineHostOrigin({
  event, input, scope, resolvedSources, preflight, prompt, environment = process.env, now = new Date()
}) {
  if (event !== USER_PROMPT_SUBMIT || !input || !scope || !resolvedSources || typeof prompt !== "string") return null;
  const receipt = preflight?.receipt;
  try {
    if (!await verifyPreflightReceipt({ receipt, input, scope, resolvedSources, prompt, now,
      env: environment, consume: true })) return null;
  } catch {
    return null;
  }
  const binding = timelineBinding(input, scope);
  if (receipt.host !== "claude" || receipt.hookEvent !== USER_PROMPT_SUBMIT || receipt.sessionId !== binding.sessionId
    || receipt.agentId !== binding.entityId || receipt.userId !== binding.userId || receipt.tenantId !== binding.tenantId
    || receipt.projectId !== binding.projectId || receipt.groupId !== binding.groupId || receipt.taskId !== binding.taskId) {
    return consumedResult();
  }
  if (!eligibleTimelineOrigin(binding, input)) return consumedResult();
  const origin = Object.freeze({ binding, input: Object.freeze({
    transcript_path: input.transcript_path ?? input.transcriptPath,
    event_id: input.event_id ?? input.hook_event_id ?? null
  }), root: resolvedSources.projectRoot, hostHome: resolvedSources.hostHome, event });
  verifiedOrigins.add(origin);
  return consumedResult(origin);
}

export function validVerifiedTimelineHostOrigin({ origin, root, input, binding, hostHome, event }) {
  return verifiedOrigins.has(origin) && origin.event === USER_PROMPT_SUBMIT && event === USER_PROMPT_SUBMIT
    && origin.root === root && origin.hostHome === hostHome && sameInput(origin.input, input)
    && sameBinding(origin.binding, binding);
}
