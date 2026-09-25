const MAX_STDIN_BYTES = 64 * 1024;
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);

export const OVERSIZE_CONTEXT_INPUT = Symbol("oversize-context-input");

export const SILENT_OVERSIZE_POST_TOOL_USE = Symbol("silent-oversize-post-tool-use");
export const SILENT_OVERSIZE_POST_TOOL_USE_ARG = "--silent-oversize-post-tool-use";

export function hookInputOptions(args) {
  if (!args.length) return {};
  if (args.length === 1 && args[0] === SILENT_OVERSIZE_POST_TOOL_USE_ARG) {
    return { silentOversizePostToolUse: true };
  }
  const contextEvent = args.length === 1 && args[0].startsWith("--context-event=")
    ? args[0].slice("--context-event=".length) : null;
  if (CONTEXT_EVENTS.has(contextEvent)) return { contextEvent };
  throw new Error(`unsupported hook argument: ${args[0]}`);
}

export function oversizedContextOutput(event) {
  if (!CONTEXT_EVENTS.has(event)) throw new Error("invalid context hook binding");
  return { hookSpecificOutput: {
    hookEventName: event,
    additionalContext: JSON.stringify({
      schema: "agentspine.hook-context/v1", event, loaded: false,
      sourceResolution: { status: "unavailable", reason: "hook-input-budget" },
      instruction: "AgentSpine recall and capture are unverified for this event. Continue the original request under native host rules. No input prefix was processed or stored; do not claim memory was updated.",
      authority: "context-only"
    }),
    message: "AgentSpine input budget exceeded: memory processing was skipped for this event; the original request can continue."
  } };
}

export async function readHookInput({ silentOversizePostToolUse = false, contextEvent = null,
  stream = process.stdin } = {}) {
  if (contextEvent !== null && !CONTEXT_EVENTS.has(contextEvent)) throw new Error("invalid context hook binding");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, MAX_STDIN_BYTES - bytes);
    if (remaining) chunks.push(Buffer.from(buffer.subarray(0, remaining)));
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) {
      // The host may still be streaming a much larger payload. Stop reading as
      // soon as the budget is exceeded; no prefix is parsed or retained.
      chunks.length = 0;
      if (silentOversizePostToolUse) return SILENT_OVERSIZE_POST_TOOL_USE;
      // Only a host-bound command option selects this lane, never a JSON prefix.
      if (contextEvent) return OVERSIZE_CONTEXT_INPUT;
      throw new Error("hook input exceeds the 64 KiB limit");
    }
  }
  const value = Buffer.concat(chunks, bytes).toString("utf8");
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook input must be one JSON object");
  }
  if (contextEvent && (parsed.hook_event_name || parsed.event_name) !== contextEvent) {
    throw new Error("context hook event does not match its host binding");
  }
  return parsed;
}
