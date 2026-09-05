const STOP_WORDS = new Set([
  "about", "after", "before", "diese", "dieser", "einem", "einen", "einer", "eines", "haben", "heute",
  "ihrem", "ihren", "immer", "nicht", "schon", "sollte", "the", "this", "that", "with", "without", "what",
  "when", "where", "which", "would"
]);

export function timelineTerms(value) {
  return [...new Set((String(value || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{3,}/gu) || [])
    .filter((item) => !STOP_WORDS.has(item)))].slice(0, 24);
}

export function exactTimelineUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) {
    throw new Error("timeline timestamp must be exact UTC ISO-8601");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("timeline timestamp must be exact UTC ISO-8601");
  const canonical = value.includes(".") ? parsed.toISOString() : parsed.toISOString().replace(".000Z", "Z");
  if (canonical !== value) throw new Error("timeline timestamp must be exact UTC ISO-8601");
  return parsed;
}

export function timelineQuery({ at, query }) {
  const target = at === undefined || at === null || at === "" ? null : exactTimelineUtc(at);
  if (query === undefined || query === null || query === "") {
    if (!target) throw new Error("timeline search requires an exact UTC timestamp or two specific terms");
    return { target, wanted: [] };
  }
  if (typeof query !== "string" || query.length < 3 || query.length > 512) throw new Error("timeline query is invalid");
  const wanted = timelineTerms(query);
  if (wanted.length < 2) throw new Error("timeline query requires at least two specific terms");
  return { target, wanted: wanted.slice(0, 16) };
}

export function matchesTimelineEvent(event, wanted, target, windowMs) {
  return (!target || Math.abs(new Date(event.at).getTime() - target.getTime()) <= windowMs)
    && (!wanted.length || wanted.filter((term) => event.terms.includes(term)).length >= 2);
}

export function rankTimelineEvents(events, wanted, target) {
  return [...events].sort((left, right) => {
    if (target) {
      const distance = Math.abs(new Date(left.at).getTime() - target.getTime())
        - Math.abs(new Date(right.at).getTime() - target.getTime());
      if (distance) return distance;
    }
    const overlap = wanted.filter((term) => right.terms.includes(term)).length
      - wanted.filter((term) => left.terms.includes(term)).length;
    return overlap || right.at.localeCompare(left.at) || left.offset - right.offset;
  });
}

export function timelineRoomId(sourceDigest, offset, roomBytes) {
  return `room:${sourceDigest.slice(0, 24)}:${Math.floor(offset / roomBytes) + 1}`;
}
