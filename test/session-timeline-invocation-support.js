import { createTask } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import { runHook } from "../src/hook.js";
import { authorizeSessionTimelineInvocation, bootstrapSessionTimelineEnrollment } from "../src/lib/session-timeline.js";
import {
  currentHostTranscriptReceipt, enrollPrivateSessionTimeline, LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION,
  resolvePrivateSessionTimelineEnrollment
} from "../src/lib/session-timeline-enrollment.js";
import { timelineInvocationRequest } from "../src/lib/mcp-timeline-tools.js";
import { timelineTransportDigest } from "../src/lib/session-timeline-transport.js";

function scopeFromBinding(binding, visibility) {
  return {
    entityId: binding.entityId, userId: binding.userId, tenantId: binding.tenantId,
    projectId: binding.projectId, groupId: null, currentTaskId: binding.taskId,
    goalId: binding.goalId, goalStepId: binding.goalStepId, timelineVisibility: visibility
  };
}

function requestInput(root, binding, visibility, enrollmentDigest, fields) {
  return {
    root, sessionId: binding.sessionId, entityId: binding.entityId, userId: binding.userId,
    tenantId: binding.tenantId, projectId: binding.projectId, taskId: binding.taskId,
    groupId: null, goalId: binding.goalId, goalStepId: binding.goalStepId,
    timelineVisibility: visibility, enrollmentDigest, ...fields
  };
}

let receiptSequence = 0;

function unavailable(reason) {
  return { schema: "agentspine.session-timeline-host-receipt/v1", status: "unavailable", reason,
    receipt: null, expiresAt: null, authority: "context-only" };
}

function entityKind(id) { return id?.startsWith("person:") ? "person" : "agent"; }
function completePrivateScope(scope) {
  return scope?.groupId === null && [scope.entityId, scope.userId, scope.tenantId, scope.projectId, scope.currentTaskId]
    .every((value) => typeof value === "string" && value.length > 0);
}

async function prepareHostPromptScope(root, scope) {
  await upsertEntity({ root, id: scope.entityId, kind: entityKind(scope.entityId), privacy: "private" });
  await upsertEntity({ root, id: scope.projectId, kind: "project", privacy: "private" });
  try {
    await createTask({ root, id: scope.currentTaskId, actorId: scope.entityId, assigneeId: scope.entityId,
      projectId: scope.projectId, title: "Synthetic timeline host receipt", privacy: "private" });
  } catch (error) {
    if (error.message !== "task IDs are immutable") throw error;
  }
}

function hostPrompt({ root, host, sessionId, scope, transcriptPath, eventId, clock, prompt }) {
  return {
    hook_event_name: "UserPromptSubmit", host, cwd: root, session_id: sessionId, event_id: eventId,
    entity_id: scope.entityId, user_id: scope.userId, tenant_id: scope.tenantId, project_id: scope.projectId,
    task_id: scope.currentTaskId, goal_id: scope.goalId, goal_step_id: scope.goalStepId, group_id: scope.groupId,
    profile_id: "profile:synthetic-timeline-host", transcript_path: transcriptPath,
    prompt, ...(clock ? { timestamp: clock().toISOString() } : {})
  };
}

export async function requestTimelineHostReceipt({
  root, host = "claude", sessionId, scope, transcriptPath, hostHome, eventId = undefined,
  clock = null, environment = process.env, prompt = "Prepare the synthetic timeline enrollment."
}) {
  if (host !== "claude" || process.env.CLAUDE_CONFIG_DIR !== hostHome) return unavailable("test-host-profile-mismatch");
  if (!completePrivateScope(scope)) return unavailable("test-host-scope-invalid");
  await prepareHostPromptScope(root, scope);
  const result = await runHook(hostPrompt({ root, host, sessionId, scope, transcriptPath,
    eventId: eventId === undefined ? `test-timeline-receipt:${sessionId}:${++receiptSequence}` : eventId, clock, prompt }));
  if (result.blocked) return unavailable("host-prompt-rejected");
  return currentHostTranscriptReceipt({ root, clock, environment });
}

export async function enrollTimelineWithHostReceipt({
  root, host = "claude", sessionId, scope, transcriptPath, hostHome, eventId = undefined,
  clock = null, environment = process.env, ttlMs, bootstrap = true, prompt
}) {
  const receipt = await requestTimelineHostReceipt({ root, host, sessionId, scope, transcriptPath, hostHome,
    eventId, clock, environment, ...(prompt === undefined ? {} : { prompt }) });
  if (receipt.status !== "pending") return receipt;
  const enrolled = await enrollPrivateSessionTimeline({
    root, hostReceipt: receipt.receipt, confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION,
    ...(ttlMs === undefined ? {} : { ttlMs }), clock, environment
  });
  if (enrolled.status !== "enrolled" || !bootstrap) return enrolled;
  const initial = await bootstrapSessionTimelineEnrollment({ root, enrollmentDigest: enrolled.enrollmentDigest,
    environment, now: clock ? clock() : new Date() });
  return initial.status === "registered" ? enrolled : initial;
}

export async function boundTimelineInvocation({
  root, host = "claude", sessionId, hostHome, tool, fields, toolUseId, environment = process.env
}) {
  const enrollment = await resolvePrivateSessionTimelineEnrollment({ root, host, sessionId, hostHome });
  if (enrollment.status !== "enrolled") return null;
  const transportDigest = timelineTransportDigest({ root, binding: enrollment.binding, environment });
  if (!transportDigest) return null;
  const input = requestInput(root, enrollment.binding, enrollment.timelineVisibility, enrollment.enrollmentDigest, fields);
  const request = timelineInvocationRequest(tool, input, root);
  if (!request) return null;
  const authorization = await authorizeSessionTimelineInvocation({
    root, host, sessionId: enrollment.binding.sessionId, scope: scopeFromBinding(enrollment.binding, enrollment.timelineVisibility),
    hostHome, tool, request, toolUseId, transportDigest, enrollmentDigest: enrollment.enrollmentDigest
  });
  if (!authorization) return null;
  return {
    invocationRequest: request, transportDigest, enrollmentDigest: enrollment.enrollmentDigest,
    binding: enrollment.binding
  };
}
