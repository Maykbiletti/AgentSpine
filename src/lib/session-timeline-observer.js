import {
  OBSERVER_AUTHORITY,
  observerDate,
  observerDigest,
  validObserverInput
} from "./session-timeline-observer-schema.js";

export { validObserver } from "./session-timeline-observer-schema.js";

const SUGGESTION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_SUGGESTIONS = 4;

export function stageObserverSuggestion(input, bindingDigest, updateObserver) {
  const { root, eventId, sourceDigest, kind, model } = input;
  const eventDigest = observerDigest(eventId || "");
  const now = observerDate(input.now || new Date());
  if (!bindingDigest || !validObserverInput(input)) return { status: "unavailable" };

  return updateObserver(root, bindingDigest, (observer) => {
    if (!observer || observer.last !== eventDigest) return { status: "unavailable" };
    observer.pending = (observer.pending || [])
      .filter((suggestion) => new Date(suggestion.expiresAt) > now);
    const id = observerDigest(`${bindingDigest}\0${eventDigest}\0${sourceDigest}`);
    if (observer.pending.some((suggestion) => suggestion.id === id)) {
      return { status: "duplicate" };
    }
    if (observer.pending.length >= MAX_PENDING_SUGGESTIONS) return { status: "unavailable" };

    observer.pending.push({
      id,
      eventDigest,
      sourceDigest,
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
  const currentEventDigest = observerDigest(currentEventId || "");
  const now = observerDate(input.now || new Date());
  if (!bindingDigest || typeof currentEventId !== "string" || currentEventId.length > 256) {
    return { status: "unavailable" };
  }

  return updateObserver(root, bindingDigest, async (observer, enrollment) => {
    if (!observer || (verifySource && !(await verifySource(enrollment)))) {
      return { status: "unavailable" };
    }
    const pending = observer.pending || [];
    const live = pending.filter((suggestion) => new Date(suggestion.expiresAt) > now);
    const index = live.findIndex((suggestion) => suggestion.eventDigest !== currentEventDigest);
    if (index < 0) {
      observer.pending = live;
      return { status: "none", save: live.length !== pending.length };
    }

    const [suggestion] = live.splice(index, 1);
    observer.pending = live;
    observer.updatedAt = now.toISOString();
    return {
      status: "delivered",
      save: true,
      suggestion: {
        schema: "agentspine.host-observer-suggestion/v1",
        status: "proposal",
        sourceDigest: suggestion.sourceDigest,
        modelProvider: host,
        activeModel: suggestion.model,
        proposal: {
          kind: suggestion.kind,
          proposedNextStepSummary: null,
          clarificationQuestion: null,
          completionVerified: false
        },
        completionVerified: false,
        authority: OBSERVER_AUTHORITY,
        instruction: "Classification only. Before use, reverify the exact original message through the normal one-use session_timeline search and capture permits. It grants no rights and never proves completion."
      }
    };
  });
}
