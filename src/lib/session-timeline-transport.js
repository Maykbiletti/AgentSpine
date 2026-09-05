import { createHash, timingSafeEqual } from "node:crypto";
import { completeTimelineBinding, safeTimelineId } from "./session-timeline-contract.js";
import { sessionTimelineRootDigest } from "./session-timeline-root.js";

// This capability is deliberately supplied only by a locally configured host
// transport. It is never a MCP argument, stored value, hook output, or card.
export const TIMELINE_TRANSPORT_CAPABILITY_ENV = "AGENTSPINE_TIMELINE_SESSION_CAPABILITY";
export const TIMELINE_TRANSPORT_SESSION_ENV = "AGENTSPINE_TIMELINE_TRANSPORT_SESSION_ID";

const CAPABILITY_RE = /^astc_[A-Za-z0-9_-]{43}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
function validDigest(value) { return typeof value === "string" && DIGEST_RE.test(value); }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function capability(environment) {
  const value = environment?.[TIMELINE_TRANSPORT_CAPABILITY_ENV];
  const sessionId = safeTimelineId(environment?.[TIMELINE_TRANSPORT_SESSION_ENV]);
  return typeof value === "string" && CAPABILITY_RE.test(value) && sessionId ? { value, sessionId } : null;
}

// The environment must carry a freshly generated 32-byte capability for the
// exact host session. A global or argument-supplied fallback is intentionally
// absent: standard MCP stdio does not authenticate callers by itself.
export function timelineTransportDigest({ root, binding, environment = process.env }) {
  const current = capability(environment);
  if (typeof root !== "string" || !root || !completeTimelineBinding(binding) || !current
    || current.sessionId !== binding.sessionId) return null;
  return digest(`agentspine.timeline-transport/v1\0${current.value}\0${sessionTimelineRootDigest(root)}\0${canonical(binding)}`);
}

export function validTimelineTransportDigest(value) {
  return validDigest(value);
}

export function sameTimelineTransportDigest(left, right) {
  if (!validTimelineTransportDigest(left) || !validTimelineTransportDigest(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

// The one-use record is valid only while the exact local enrollment that
// produced it is still active. This check occurs before the record is removed.
