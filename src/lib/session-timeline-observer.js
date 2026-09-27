import {
  OBSERVER_AUTHORITY,
  observerDate,
  observerDigest,
  validObserverInput
} from "./session-timeline-observer-schema.js";
import { safeTimelineId } from "./session-timeline-contract.js";

export { validObserver } from "./session-timeline-observer-schema.js";

const SUGGESTION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_SUGGESTIONS = 4;

export function stageObserverSuggestion(input, bindingDigest, updateObserver) {
  const { root, eventId, sourceDigest, enrollmentDigest, status, kind, model } = input;
  const eventDigest = observerDigest(eventId || "");
  const now = observerDate(input.now || new Date());
  if (!bindingDigest || !validObserverInput(input)) return { status: "unavailable" };

  return updateObserver(root, bindingDigest, (observer) => {
    if (!observer || observer.last !== eventDigest) return { status: "unavailable" };
    observer.pending = (observer.pending || [])
      .filter((suggestion) => new Date(suggestion.expiresAt) > now);
    const id = observerDigest(`${bindingDigest}\0${eventDigest}\0${sourceDigest}\0${enrollmentDigest}`);
    if (observer.pending.some((suggestion) => suggestion.id === id)) {
      return { status: "duplicate" };
    }
    if (observer.pending.length >= MAX_PENDING_SUGGESTIONS) return { status: "unavailable" };

    observer.pending.push({
      id,
      eventDigest,
      sourceDigest,
      enrollmentDigest,
      status,
      kind,
      model,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SUGGESTION_TTL_MS).toISOString(),
      authority: OBSERVER_AUTHORITY
    });
    observer.updatedAt = now.toISOString();
    return { status: "staged", save: true };
  });
}

export function consumeObserverSuggestion(input, bindingDigest, updateObserver, verifySource) {
  const { root, host, currentEventId } = input;
  const now = observerDate(input.now || new Date());
  if (!bindingDigest || !safeTimelineId(currentEventId)) {
    return { status: "unavailable" };
  }
  const currentEventDigest = observerDigest(currentEventId);

  return updateObserver(root, bindingDigest, async (observer) => {
    if (!observer) return { status: "unavailable" };
    const pending = observer.pending || [];
    const live = pending.filter((suggestion) => new Date(suggestion.expiresAt) > now);
    const candidates = live
      .map((suggestion, index) => ({ suggestion, index }))
      .filter(({ suggestion }) => suggestion.eventDigest !== currentEventDigest);
    let selected = null;
    for (const candidate of [...candidates].reverse()) {
      if (!verifySource || await verifySource(candidate.suggestion)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      observer.pending = live;
      return {
        status: candidates.length ? "unavailable" : "none",
        save: live.length !== pending.length
      };
    }

    const suggestion = selected.suggestion;
    observer.pending = live.filter((item, index) =>
      index > selected.index || item.eventDigest === currentEventDigest);
    observer.updatedAt = now.toISOString();
    const common = {
      sourceDigest: suggestion.sourceDigest,
      modelProvider: host,
      activeModel: suggestion.model,
      completionVerified: false,
      authority: OBSERVER_AUTHORITY
    };
    const handoff = suggestion.status === "none" ? {
      schema: "agentspine.host-observer-ack/v1",
      status: "none",
      ...common,
      instruction: "No source-bound observation was proposed for the prior turn. This acknowledgement is one-use, grants no rights, and proves no completion."
    } : {
      schema: "agentspine.host-observer-suggestion/v1",
      status: "proposal",
      ...common,
      proposal: {
        kind: suggestion.kind,
        proposedNextStepSummary: null,
        clarificationQuestion: null,
        completionVerified: false
      },
      instruction: "Classification only. Before use, reverify the exact original message through the normal one-use session_timeline search and capture permits. It grants no rights and never proves completion."
    };
    return {
      status: "delivered",
      save: true,
      suggestion: handoff
    };
  });
}
