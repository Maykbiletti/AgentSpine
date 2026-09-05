import { sessionTimelineLifecycleHint } from "./session-timeline.js";
import { issueHostTranscriptReceipt } from "./session-timeline-enrollment.js";
import { consumeTimelineHostOrigin } from "./session-timeline-host-origin.js";

const AUTHORITY = "context-only";

function unavailable(reason) {
  return { schema: "agentspine.session-timeline/v1", status: "unavailable", reason, authority: AUTHORITY };
}

function hasRawTimelineGroupSignal(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const nested = input.agent_spine_scope;
    const values = [input.groupId, input.group_id];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      values.push(nested.groupId, nested.group_id);
    }
    return values.some((value) => value !== undefined && value !== null && value !== "");
  } catch {
    // Parser-shaped uncertainty must not turn a lifecycle hint into a denial.
    return false;
  }
}

function groupSuppressed(reason) {
  return { schema: "agentspine.session-timeline/v1", status: "group-suppressed", reason, authority: AUTHORITY };
}

function receiptObservation(receipt) {
  return { schema: "agentspine.session-timeline-host-receipt/v1",
    status: receipt.status === "pending" ? "pending" : "unavailable", reason: receipt.reason || null,
    expiresAt: receipt.expiresAt || null, authority: AUTHORITY };
}

// This observes a host-provided Claude hook payload but never returns the
// opaque enrollment token through model-visible context.
export async function observeHostTranscriptReceipt({ root, event, input, scope, hostHome, hostOrigin = null, clock = null }) {
  if (event !== "UserPromptSubmit") return receiptObservation({ status: "not-applicable" });
  if (hasRawTimelineGroupSignal(input)) return receiptObservation({ status: "unavailable", reason: "raw-group-scope" });
  if (!scope || scope.groupId !== null) return receiptObservation({ status: "unavailable", reason: "computed-group-scope" });
  const receipt = await issueHostTranscriptReceipt({ root, host: scope.host, sessionId: input.session_id ?? input.sessionId,
    scope, transcriptPath: input.transcript_path ?? input.transcriptPath, hostHome, event, eventId: input.event_id ?? input.hook_event_id,
    hostOrigin, clock, environment: process.env });
  return receiptObservation(receipt);
}

export async function captureSessionTimelineLifecycle({ root, event, input, scope, hostHome, hostOrigin = null, clock = null }) {
  if (hasRawTimelineGroupSignal(input)) return groupSuppressed("raw-group-scope");
  if (!scope || scope.groupId !== null) return groupSuppressed("computed-group-scope");
  let hostReceipt = null;
  if (event === "UserPromptSubmit" && hostOrigin) {
    try { hostReceipt = await observeHostTranscriptReceipt({ root, event, input, scope, hostHome, hostOrigin, clock }); }
    catch (error) {
      hostReceipt = { schema: "agentspine.session-timeline-host-receipt/v1", status: "degraded", reason: error.message,
        expiresAt: null, authority: AUTHORITY };
    }
  }
  const result = (value) => hostReceipt ? { ...value, hostReceipt } : value;
  if (scope.host !== "claude") return unavailable("host-not-supported");
  return result(await sessionTimelineLifecycleHint({ root, host: "claude",
    sessionId: input.session_id ?? input.sessionId, scope, environment: process.env }));
}

// The calling hook performs this only at its final pre-answer boundary.  The
// origin helper consumes the exact signed preflight receipt before this can
// touch timeline receipt state. Failure to form a timeline origin is optional
// and yields no opaque receipt; failure to consume preflight remains blocking.
export async function finalizeUserPromptSessionTimeline({
  root, input, scope, resolvedSources, preflight, prompt, now = new Date()
}) {
  const consumed = await consumeTimelineHostOrigin({ event: "UserPromptSubmit", input, scope, resolvedSources,
    preflight, prompt, environment: process.env, now });
  if (!consumed?.consumed) return { preflightConsumed: false, timeline: unavailable("preflight-receipt-unavailable") };
  try {
    return { preflightConsumed: true, timeline: await captureSessionTimelineLifecycle({
      root, event: "UserPromptSubmit", input, scope, hostHome: resolvedSources.hostHome,
      hostOrigin: consumed.origin, clock: () => new Date(now)
    }) };
  } catch (error) {
    return { preflightConsumed: true, timeline: {
      schema: "agentspine.session-timeline/v1", status: "degraded", reason: error.message, authority: AUTHORITY
    } };
  }
}
