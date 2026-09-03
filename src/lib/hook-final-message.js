const FINAL_MESSAGE_KEYS = [
  "last_assistant_message", "assistant_message", "final_assistant_message", "final_message", "response"
];

export function resolveFinalAssistantMessage(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const candidates = [];
  const malformed = [];
  for (const key of FINAL_MESSAGE_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] === "string") candidates.push({ key, text: source[key] });
    else malformed.push(key);
  }
  if (new Set(candidates.map(({ text }) => text)).size > 1) return {
    status: "conflict", known: false, text: "", aliases: candidates.map(({ key }) => key),
    reason: `final assistant message aliases conflict: ${candidates.map(({ key }) => key).join(", ")}`
  };
  if (malformed.length) return {
    status: "malformed", known: false, text: "", aliases: malformed,
    reason: `final assistant message aliases are non-string: ${malformed.join(", ")}`
  };
  if (candidates.length) return { status: "known", known: true, text: candidates[0].text,
    aliases: candidates.map(({ key }) => key), reason: null };
  return { status: "unavailable", known: false, text: "", aliases: [],
    reason: "final assistant message is unavailable to this hook" };
}
