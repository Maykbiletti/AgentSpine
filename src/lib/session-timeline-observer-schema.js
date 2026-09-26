import { createHash } from "node:crypto";

export const OBSERVER_AUTHORITY = "context-only";
export const OBSERVER_KINDS = new Set([
  "next-step-correction",
  "completion-claim",
  "not-current-instruction",
  "ambiguous"
]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MODEL_PATTERN = /^[-A-Za-z0-9._:]{1,256}$/;

export function observerDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function observerDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("session timeline timestamp is invalid");
  }
  return date;
}

export function validObserverInput({ eventId, sourceDigest, enrollmentDigest, kind, model }) {
  return typeof eventId === "string"
    && eventId.length <= 256
    && DIGEST_PATTERN.test(sourceDigest || "")
    && DIGEST_PATTERN.test(enrollmentDigest || "")
    && OBSERVER_KINDS.has(kind)
    && MODEL_PATTERN.test(model || "");
}

function validPendingSuggestion(suggestion) {
  return suggestion
    && DIGEST_PATTERN.test(suggestion.id || "")
    && DIGEST_PATTERN.test(suggestion.eventDigest || "")
    && DIGEST_PATTERN.test(suggestion.sourceDigest || "")
    && (suggestion.enrollmentDigest === undefined
      || DIGEST_PATTERN.test(suggestion.enrollmentDigest || ""))
    && OBSERVER_KINDS.has(suggestion.kind)
    && MODEL_PATTERN.test(suggestion.model || "")
    && Number.isFinite(new Date(suggestion.createdAt).getTime())
    && Number.isFinite(new Date(suggestion.expiresAt).getTime())
    && new Date(suggestion.expiresAt) > new Date(suggestion.createdAt)
    && suggestion.authority === OBSERVER_AUTHORITY;
}

export function validObserver(observer) {
  return observer
    && DIGEST_PATTERN.test(observer.bindingDigest || "")
    && MODEL_PATTERN.test(observer.model || "")
    && Number.isFinite(new Date(observer.updatedAt).getTime())
    && Array.isArray(observer.prompts)
    && observer.prompts.length <= 32
    && observer.prompts.every((digest) => DIGEST_PATTERN.test(digest))
    && (!observer.last || DIGEST_PATTERN.test(observer.last))
    && (observer.pending === undefined
      || (Array.isArray(observer.pending)
        && observer.pending.length <= 4
        && observer.pending.every(validPendingSuggestion)))
    && observer.authority === OBSERVER_AUTHORITY;
}
