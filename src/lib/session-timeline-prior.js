import { createHash } from "node:crypto";
import { matchesTimelineEvent, rankTimelineEvents } from "./session-timeline-query.js";

const CONTINUITY_FIELDS = ["entityId", "userId", "tenantId", "projectId", "taskId"];
const REFERENCE_FIELDS = ["host", ...CONTINUITY_FIELDS, "sessionId"];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameContinuationScope(candidate, current, includePriorProviders) {
  return candidate.groupId === null && current.groupId === null
    && (candidate.host !== current.host || candidate.sessionId !== current.sessionId)
    && (includePriorProviders || candidate.host === current.host)
    && CONTINUITY_FIELDS.every((field) => candidate[field] === current[field])
    && (!candidate.goalId || !current.goalId || candidate.goalId === current.goalId);
}

export function timelineSessionReference(binding) {
  const material = REFERENCE_FIELDS
    .map((field) => `${field}:${binding[field] || ""}`).join("\0");
  return `session-ref:${digest(material).slice(0, 32)}`;
}

export function priorTimelineSources(state, scoped, { includePriorProviders = false } = {}) {
  return state.sources.filter((source) => sameContinuationScope(source.binding, scoped, includePriorProviders))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function selectPriorTimelineSource(state, scoped, { target, wanted, windowMs, includePriorProviders = false }) {
  const eligible = priorTimelineSources(state, scoped, { includePriorProviders });
  const indexed = eligible.flatMap((source, sourceIndex) => rankTimelineEvents(source.events
    .filter((event) => matchesTimelineEvent(event, wanted, target, windowMs)), wanted, target)
    .slice(0, 8).map((event) => ({ ...event, sourceIndex })));
  const ranked = rankTimelineEvents(indexed, wanted, target);
  return eligible[ranked[0]?.sourceIndex ?? 0] || null;
}

export function priorTimelineHint(state, scoped, sourceDigest, { includePriorProviders = false } = {}) {
  const sources = priorTimelineSources(state, scoped, { includePriorProviders });
  const latest = sources.flatMap((source) => source.events.map((event) => ({ source, event })))
    .sort((left, right) => right.event.at.localeCompare(left.event.at))[0] || null;
  return {
    available: sources.length > 0,
    sessions: sources.length,
    indexedEvents: sources.reduce((total, source) => total + source.events.length, 0),
    latest: latest ? {
      sessionRef: timelineSessionReference(latest.source.binding),
      messageRef: latest.event.id,
      sourceProvider: latest.source.binding.host,
      sourceDigest: sourceDigest(latest.source),
      at: latest.event.at,
      outcome: latest.event.outcome,
      testLabel: latest.event.testLabel
    } : null,
    instruction: sources.length
      ? `Use session_timeline_search with includePriorSessions${includePriorProviders ? " and includePriorProviders" : ""} only for a relevant exact-time or two-term question.`
      : null,
    freshness: "source-not-read",
    authority: "context-only"
  };
}
