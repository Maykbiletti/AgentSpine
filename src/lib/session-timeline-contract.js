import { validTimelineHost } from "./session-timeline-provider.js";

export const TIMELINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;

export function safeTimelineId(value) {
  return typeof value === "string" && TIMELINE_ID_RE.test(value) ? value : null;
}

export function sessionTimelineBinding({ host, sessionId, scope }) {
  const binding = {
    host: validTimelineHost(host) ? host : null,
    sessionId: safeTimelineId(sessionId),
    entityId: safeTimelineId(scope?.entityId),
    userId: safeTimelineId(scope?.userId),
    tenantId: safeTimelineId(scope?.tenantId),
    projectId: safeTimelineId(scope?.projectId),
    groupId: safeTimelineId(scope?.groupId),
    taskId: safeTimelineId(scope?.currentTaskId),
    goalId: safeTimelineId(scope?.goalId),
    goalStepId: safeTimelineId(scope?.goalStepId)
  };
  if (scope?.portalRef || scope?.threadRef) {
    binding.portalRef = safeTimelineId(scope?.portalRef);
    binding.threadRef = safeTimelineId(scope?.threadRef);
  }
  return binding;
}

export function hasTimelineGroupScope(scope) {
  return scope?.groupId !== undefined && scope.groupId !== null && scope.groupId !== "";
}

export function hasVerifiedTimelinePrivateScope(scope) {
  return scope?.timelineVisibility === "private-verified";
}

export function completeTimelineBinding(value) {
  return validTimelineHost(value.host) && !value.groupId
    && Boolean(value.portalRef) === Boolean(value.threadRef)
    && ["sessionId", "entityId", "userId", "tenantId", "projectId", "taskId"].every((key) => value[key]);
}

export function sameTimelineBinding(left, right) {
  return ["host", "sessionId", "entityId", "userId", "tenantId", "projectId", "groupId", "taskId", "goalId", "goalStepId",
    "portalRef", "threadRef"].every((key) => (left[key] ?? null) === (right[key] ?? null));
}

export function validTimelineBinding(value) {
  return value && validTimelineHost(value.host)
    && [value.sessionId, value.entityId, value.userId, value.tenantId, value.projectId, value.taskId]
      .every((item) => typeof item === "string" && TIMELINE_ID_RE.test(item))
    && [value.groupId, value.goalId, value.goalStepId]
      .every((item) => item === null || (typeof item === "string" && TIMELINE_ID_RE.test(item)))
    && ((value.portalRef === undefined && value.threadRef === undefined)
      || [value.portalRef, value.threadRef].every((item) => typeof item === "string" && TIMELINE_ID_RE.test(item)));
}
