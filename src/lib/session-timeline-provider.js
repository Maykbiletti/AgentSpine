export const TIMELINE_HOSTS = Object.freeze(["claude", "codex", "king"]);
export const KING_TIMELINE_SOURCE_ENV = "AGENTSPINE_KING_TIMELINE_SOURCE";
export const KING_WIRE_PROTOCOL_ENV = "AGENTSPINE_KING_WIRE_PROTOCOL_VERSION";
export const TIMELINE_CROSS_PROVIDER_ENV = "AGENTSPINE_TIMELINE_CROSS_PROVIDER";

export function validTimelineHost(value) {
  return TIMELINE_HOSTS.includes(value);
}

export function crossProviderTimelineEnabled(environment = process.env) {
  return environment?.[TIMELINE_CROSS_PROVIDER_ENV] === "1";
}

// BLUN currently shares the Codex-compatible AGENTS.md hierarchy, but its
// persisted agent wire is a distinct provider contract. Keep those identities
// separate so a passing Codex adapter can never stand in for King history.
export function timelineHostForRuntime(host, environment = process.env) {
  if (environment?.BLUN_HOME || environment?.BLUN_PLUGIN_ROOT) return "king";
  return validTimelineHost(host) ? host : null;
}

export function runtimeHostForTimeline(host) {
  return host === "king" ? "codex" : host;
}

export function timelineHostHome(host, environment = process.env) {
  if (host === "king") return environment?.BLUN_HOME ?? null;
  if (host === "codex") return environment?.CODEX_HOME ?? null;
  return host === "claude" ? environment?.CLAUDE_CONFIG_DIR ?? null : null;
}

export function timelineSourceFromRuntime(host, input, environment = process.env) {
  if (host === "king") return environment?.[KING_TIMELINE_SOURCE_ENV] ?? null;
  return input?.transcript_path ?? input?.transcriptPath ?? null;
}

export function timelineProtocolFromRuntime(host, environment = process.env) {
  return host === "king" ? environment?.[KING_WIRE_PROTOCOL_ENV] ?? null : null;
}
