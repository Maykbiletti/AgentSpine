import { createHash } from "node:crypto";
import { searchSessionTimeline } from "./session-timeline.js";
import { recordWorldAssertion } from "./world-model.js";

const AUTHORITY = "context-only";
const EVENT_ID = /^timeline-event:[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set(["pass", "fail", "blocked", "timeout", "error", "skipped"]);
const PROVIDERS = new Set(["claude", "codex", "king"]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validCount(value) {
  return value === null || Boolean(value && typeof value === "object"
    && Object.keys(value).sort().join("\0") === "total\0value"
    && Number.isSafeInteger(value.value) && value.value >= 0
    && Number.isSafeInteger(value.total) && value.total > 0 && value.value <= value.total);
}

function validEvent(event, result, scope) {
  if (!event || !EVENT_ID.test(event.id || "") || event.kind !== "objective-result"
    || !OUTCOMES.has(event.outcome) || !validCount(event.count)
    || !DIGEST.test(event.sourceDigest || "") || !DIGEST.test(event.messageDigest || "")
    || event.sourceDigest !== result.sourceDigest || !PROVIDERS.has(event.sourceProvider)
    || typeof event.sessionRef !== "string" || typeof event.messageRef !== "string"
    || event.messageRef !== event.id || event.authority !== AUTHORITY
    || !Number.isFinite(new Date(event.at).getTime())) return false;
  return (event.portalRef ?? null) === (scope.portalRef ?? null)
    && (event.threadRef ?? null) === (scope.threadRef ?? null)
    && (result.portalRef ?? null) === (scope.portalRef ?? null)
    && (result.threadRef ?? null) === (scope.threadRef ?? null);
}

function capturedValue(event) {
  return {
    schema: "agentspine.timeline-objective-result/v1",
    outcome: event.outcome,
    count: event.count ? { value: event.count.value, total: event.count.total } : null,
    testLabel: event.testLabel ?? null,
    sourceProvider: event.sourceProvider,
    sourceDigest: event.sourceDigest
  };
}

function assertionFromEvent({ event, scope, root, now }) {
  const value = capturedValue(event);
  const material = canonical({ taskId: scope.currentTaskId, projectId: scope.projectId,
    portalRef: scope.portalRef ?? null, threadRef: scope.threadRef ?? null,
    sourceDigest: event.sourceDigest, messageDigest: event.messageDigest, eventId: event.id });
  const label = event.testLabel || "unlabeled";
  return {
    root, id: `assertion:timeline-${digest(material).slice(0, 32)}`,
    subjectId: scope.currentTaskId, predicate: `task.timeline-result.${label}`,
    value, evidenceKind: "objective-measurement", evidenceId: event.id,
    evidenceDigest: event.messageDigest, observedAt: new Date(event.at).toISOString(),
    projectId: scope.projectId, groupId: null, privacy: "private", knowledgeKind: "task-state",
    sessionRef: event.sessionRef, messageRef: event.messageRef, now,
    ...(scope.portalRef && scope.threadRef
      ? { portalRef: scope.portalRef, threadRef: scope.threadRef } : {})
  };
}

function unavailable(reason, timeline = null) {
  return { schema: "agentspine.timeline-world-capture/v1", status: "unavailable", reason,
    timeline, captured: null, authority: AUTHORITY,
    instruction: "Continue normally without claiming that historical evidence entered structured knowledge." };
}

export async function captureSessionTimelineEvidence({
  root, host, sessionId, scope, eventId, at, query, windowSeconds = undefined,
  includePriorSessions = false, includePriorProviders = false, environment = process.env,
  invocationRequest = null, transportDigest = null, enrollmentDigest = null, hostHome = null,
  now = new Date()
}) {
  if (!EVENT_ID.test(eventId || "") || !scope?.currentTaskId || scope.groupId !== null) {
    return unavailable("timeline-capture-target-invalid");
  }
  const timeline = await searchSessionTimeline({ root, host, sessionId, scope, at, query, windowSeconds,
    includePriorSessions, includePriorProviders, environment, invocationRequest, invocationTool: "capture",
    transportDigest, enrollmentDigest, hostHome });
  if (timeline.blocked) return unavailable(timeline.reason || "timeline-capture-source-unavailable", timeline);
  const event = timeline.events?.find((item) => item.id === eventId);
  if (!event) return unavailable("timeline-capture-event-not-found", timeline);
  if (!validEvent(event, timeline, scope)) return unavailable("timeline-capture-evidence-invalid", timeline);
  try {
    const recorded = await recordWorldAssertion(assertionFromEvent({ event, scope, root, now }));
    return {
      schema: "agentspine.timeline-world-capture/v1",
      status: recorded.status === "duplicate" ? "duplicate" : "captured",
      timeline: { schema: timeline.schema, sourceDigest: timeline.sourceDigest,
        sourceProvider: timeline.sourceProvider, sessionRef: event.sessionRef, messageRef: event.messageRef,
        portalRef: event.portalRef ?? null, threadRef: event.threadRef ?? null },
      captured: {
        assertionId: recorded.assertion.id, subjectId: recorded.assertion.subjectId,
        predicate: recorded.assertion.predicate, value: structuredClone(recorded.assertion.value),
        source: { kind: recorded.assertion.evidenceKind, id: recorded.assertion.evidenceId,
          digest: recorded.assertion.evidenceDigest, sessionRef: recorded.assertion.sessionRef,
          messageRef: recorded.assertion.messageRef },
        observedAt: recorded.assertion.observedAt,
        scope: { projectId: recorded.assertion.projectId, portalRef: recorded.assertion.portalRef ?? null,
          threadRef: recorded.assertion.threadRef ?? null },
        status: "confirmed", authority: AUTHORITY
      },
      completionVerified: false, deliveryConfirmed: false, authority: AUTHORITY,
      instruction: "This is source-verified descriptive task context only. It grants no permission or action authority; conflicting measurements remain unresolved."
    };
  } catch {
    return unavailable("timeline-capture-world-state-unavailable", timeline);
  }
}
