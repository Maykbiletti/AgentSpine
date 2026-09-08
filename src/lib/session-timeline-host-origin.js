import { consumeHookBriefingOrigin } from "./hook-briefing-use.js";
import { runtimeHostForTimeline, timelineHostForRuntime, timelineHostHome, timelineProtocolFromRuntime, timelineSourceFromRuntime,
  validTimelineHost } from "./session-timeline-provider.js";

const verifiedOrigins = new WeakSet();
const USER_PROMPT_SUBMIT = "UserPromptSubmit";

function timelineBinding(input, scope) {
  const binding = {
    host: scope?.host, sessionId: input?.session_id ?? input?.sessionId,
    entityId: scope?.entityId, userId: scope?.userId, tenantId: scope?.tenantId,
    projectId: scope?.projectId, groupId: scope?.groupId,
    taskId: scope?.currentTaskId, goalId: scope?.goalId, goalStepId: scope?.goalStepId
  };
  if (scope?.portalRef || scope?.threadRef) {
    binding.portalRef = scope?.portalRef;
    binding.threadRef = scope?.threadRef;
  }
  return binding;
}

function sameBinding(left, right) {
  return ["host", "sessionId", "entityId", "userId", "tenantId", "projectId", "groupId", "taskId", "goalId", "goalStepId",
    "portalRef", "threadRef"].every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}

function sameInput(left, right) {
  return (left?.transcript_path ?? left?.transcriptPath) === (right?.transcript_path ?? right?.transcriptPath)
    && (left?.event_id ?? left?.hook_event_id ?? null) === (right?.event_id ?? right?.hook_event_id ?? null)
    && (left?.protocol_version ?? null) === (right?.protocol_version ?? null);
}

function consumedResult(origin, briefingOrigin) { return { consumed: true, origin, briefingOrigin }; }

function eligibleTimelineOrigin(binding, input) {
  const transcriptPath = input?.transcript_path ?? input?.transcriptPath;
  return validTimelineHost(binding.host) && binding.groupId === null
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
  const briefingOrigin = await consumeHookBriefingOrigin({ event, input, scope,
    resolvedSources, preflight, prompt, environment, now });
  if (!briefingOrigin) return null;
  const receipt = preflight.receipt;
  const timelineHost = timelineHostForRuntime(scope.host, environment);
  const binding = timelineBinding(input, { ...scope, host: timelineHost });
  const expectedReceiptHost = runtimeHostForTimeline(timelineHost);
  if (receipt.host !== expectedReceiptHost
    || receipt.hookEvent !== USER_PROMPT_SUBMIT || receipt.sessionId !== binding.sessionId
    || receipt.agentId !== binding.entityId || receipt.userId !== binding.userId || receipt.tenantId !== binding.tenantId
    || receipt.projectId !== binding.projectId || receipt.groupId !== binding.groupId || receipt.taskId !== binding.taskId) {
    return consumedResult(null, briefingOrigin);
  }
  const sourceInput = { transcript_path: timelineSourceFromRuntime(timelineHost, input, environment),
    event_id: input.event_id ?? input.hook_event_id ?? null,
    protocol_version: timelineProtocolFromRuntime(timelineHost, environment) };
  if (!eligibleTimelineOrigin(binding, sourceInput)) return consumedResult(null, briefingOrigin);
  const origin = Object.freeze({ binding, input: Object.freeze({
    ...sourceInput,
  }), root: resolvedSources.projectRoot, hostHome: timelineHostHome(timelineHost, environment), event });
  verifiedOrigins.add(origin);
  return consumedResult(origin, briefingOrigin);
}

export function validVerifiedTimelineHostOrigin({ origin, root, input, binding, hostHome, event }) {
  return verifiedOrigins.has(origin) && origin.event === USER_PROMPT_SUBMIT && event === USER_PROMPT_SUBMIT
    && origin.root === root && origin.hostHome === hostHome && sameInput(origin.input, input)
    && sameBinding(origin.binding, binding);
}
