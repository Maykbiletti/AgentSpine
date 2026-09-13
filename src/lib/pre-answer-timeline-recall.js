import { createHash } from "node:crypto";
import { authorizeSessionTimelineInvocation, searchSessionTimeline } from "./session-timeline.js";
import { resolvePrivateSessionTimelineEnrollment } from "./session-timeline-enrollment.js";
import { timelineTransportDigest } from "./session-timeline-transport.js";

const SCHEMA = "agentspine.pre-answer-timeline-recall/v1", AUTHORITY = "context-only";
const LANES = [["objective", "objective result", 1], ["natural-feedback", "user message", 3]];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const unavailable = (reason, sourceReads = 0) => ({ schema: SCHEMA, status: "unavailable", reason,
  awaited: true, sourceReads, events: [], omittedEvents: 0, completionVerified: false, authority: AUTHORITY });

function exactScope(binding, visibility) {
  return { entityId: binding.entityId, userId: binding.userId, tenantId: binding.tenantId,
    projectId: binding.projectId, groupId: null, currentTaskId: binding.taskId, goalId: binding.goalId,
    goalStepId: binding.goalStepId, portalRef: binding.portalRef ?? null,
    threadRef: binding.threadRef ?? null, timelineVisibility: visibility };
}

function prefix(values) {
  let value = values[0] || "";
  for (const item of values.slice(1)) while (value && !item.startsWith(value)) value = value.slice(0, -1);
  return value;
}

function compact(events) {
  const sources = [], indices = new Map(), messagePrefix = prefix(events.map((item) => item.messageRef));
  const timePrefix = prefix(events.map((item) => item.at));
  const rows = events.map((item) => {
    const key = `${item.sourceDigest}\0${item.sourceProvider}\0${item.sessionRef}`;
    if (!indices.has(key)) {
      indices.set(key, sources.length);
      sources.push({ digest: item.sourceDigest, provider: item.sourceProvider, session: item.sessionRef });
    }
    const value = item.kind === "objective-result"
      ? [item.outcome, item.count?.value ?? null, item.count?.total ?? null, item.testLabel, item.excerpt]
      : item.kind === "explicit-next-step-correction" ? item.nextStepSummary : item.sourceText;
    return [indices.get(key), item.messageRef.slice(messagePrefix.length), item.at.slice(timePrefix.length),
      item.kind === "objective-result" ? "result" : item.kind === "user-message-candidate" ? "user" : "correction",
      value];
  });
  const fields = ["source", "message", "at", "kind", "value"], prefixes = [messagePrefix, timePrefix];
  return sources.length === 1 ? { source: sources[0], prefixes, fields: fields.slice(1),
    events: rows.map((row) => row.slice(1)) } : { sources, prefixes, fields, events: rows };
}

async function lane({ root, enrollment, hostHome, transport, turnId, name, query, environment }) {
  const binding = enrollment.binding, scope = exactScope(binding, enrollment.timelineVisibility);
  const request = { root, tool: "search", sessionId: binding.sessionId, entityId: binding.entityId,
    userId: binding.userId, tenantId: binding.tenantId, projectId: binding.projectId, groupId: null,
    taskId: binding.taskId, goalId: binding.goalId, goalStepId: binding.goalStepId,
    timelineVisibility: enrollment.timelineVisibility, portalRef: binding.portalRef ?? null,
    threadRef: binding.threadRef ?? null, enrollmentDigest: enrollment.enrollmentDigest,
    at: null, query, windowSeconds: 0, includePriorSessions: true, includePriorProviders: false };
  const authorized = await authorizeSessionTimelineInvocation({ root, host: binding.host,
    sessionId: binding.sessionId, scope, hostHome, tool: "search", request,
    toolUseId: `automatic-pre-answer:${hash(`${turnId}\0${name}\0${enrollment.enrollmentDigest}`)}`,
    transportDigest: transport, enrollmentDigest: enrollment.enrollmentDigest, environment });
  return authorized && searchSessionTimeline({ root, host: binding.host, sessionId: binding.sessionId, scope,
    query, windowSeconds: 0, includePriorSessions: true, includePriorProviders: false, environment,
    invocationRequest: request, invocationTool: "search", transportDigest: transport,
    enrollmentDigest: enrollment.enrollmentDigest, hostHome });
}

export async function automaticPreAnswerTimelineRecall({
  root, host, sessionId, scope, hostHome, eventId, turnId = null, environment = process.env
}) {
  if (!scope || scope.groupId !== null || !scope.currentTaskId) return unavailable("private-task-scope-unavailable");
  try {
    const enrollment = await resolvePrivateSessionTimelineEnrollment({ root, host, sessionId, hostHome });
    if (enrollment.status !== "enrolled") return unavailable("private-enrollment-unavailable");
    const transport = timelineTransportDigest({ root, binding: enrollment.binding, environment });
    if (!transport) return unavailable("timeline-transport-unavailable");
    const events = [];
    for (const [name, query, maximum] of LANES) {
      const result = await lane({ root, enrollment, hostHome, transport,
        turnId: turnId || eventId || "turn-without-host-event-id", name, query, environment });
      if (!result || result.blocked) return unavailable("timeline-search-unavailable", events.length);
      events.push(...result.events.slice(0, maximum));
    }
    const unique = [...new Map(events.map((item) => [`${item.sourceDigest}\0${item.id}`, item])).values()];
    return { schema: SCHEMA, status: unique.length ? "recalled" : "not-found", awaited: true,
      sourceReads: LANES.length, ...compact(unique), omittedEvents: 0, completionVerified: false,
      naturalMessages: "unresolved", trust: "untrusted-session-history", authority: AUTHORITY };
  } catch { return unavailable("timeline-search-unavailable"); }
}

const removeLast = (recall) => ({ ...recall, events: recall.events.slice(0, -1),
  omittedEvents: (recall.omittedEvents || 0) + 1 });
export const timelineRecallNotFound = () => ({ ...unavailable(null), status: "not-found" });

export function fitTimelineRecallToHostContext({ timeline, render, maximumBytes }) {
  let fitted = timeline, recall = timeline?.preAnswerRecall, context = render(fitted);
  while (Buffer.byteLength(context) > maximumBytes && recall?.events?.length) {
    recall = removeLast(recall); fitted = { ...fitted, preAnswerRecall: recall }; context = render(fitted);
  }
  if (Buffer.byteLength(context) > maximumBytes && recall) {
    fitted = { ...fitted, preAnswerRecall: unavailable("host-context-budget") }; context = render(fitted);
  }
  if (Buffer.byteLength(context) > maximumBytes) {
    fitted = { schema: "agentspine.session-timeline/v1", status: "unavailable",
      reason: "host-context-budget", authority: AUTHORITY }; context = render(fitted);
  }
  return { timeline: fitted, context };
}
