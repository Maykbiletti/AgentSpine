import { deliveryActorSession, recordDeliveryPause, verifyDeliveryStop } from "./delivery-verification.js";
import { blockStop } from "./hook-output.js";
import { verifyHookPremortemStop } from "./hook-premortem.js";

function explicitStopEventId(input) {
  for (const candidate of [input?.event_id, input?.hook_event_id]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

function stopArguments(input, root, scope) {
  return {
    root,
    host: scope.host,
    sessionId: deliveryActorSession(input),
    scope,
    // Timestamps identify neither a host event nor a pause: two distinct Stop
    // deliveries may share one. Only an explicit host-provided event id can
    // make a pause idempotent or be honored by a later completion.
    eventId: explicitStopEventId(input)
  };
}

function blockedResult(deliveryVerification, premortem = null) {
  return {
    blocked: true,
    reason: deliveryVerification.reason,
    deliveryVerification,
    premortem
  };
}

export function denyHookStop(payload, event, reason, details) {
  if (payload) return { blocked: true, reason, ...details };
  blockStop(event, reason);
}

export async function verifyHookStopContracts({ input, root, scope, recordPause = false,
  completionFence = false, afterDeliveryVerification = null,
  afterPremortemVerification = null }) {
  const argumentsForStop = stopArguments(input, root, scope);
  const deliveryVerification = recordPause
    ? await recordDeliveryPause(argumentsForStop)
    : await verifyDeliveryStop(argumentsForStop);
  if (deliveryVerification.blocked) return blockedResult(deliveryVerification);
  if (typeof afterDeliveryVerification === "function") await afterDeliveryVerification();

  const premortem = await verifyHookPremortemStop({
    input,
    root,
    scope,
    paused: deliveryVerification.status === "paused-job"
  });
  if (premortem.blocked) {
    return { blocked: true, reason: premortem.reason, deliveryVerification, premortem };
  }
  if (typeof afterPremortemVerification === "function") await afterPremortemVerification();

  const finalDeliveryVerification = completionFence
    ? await verifyDeliveryStop(argumentsForStop)
    : deliveryVerification;
  if (finalDeliveryVerification.blocked) {
    return blockedResult(finalDeliveryVerification, premortem);
  }
  const digestPattern = /^[a-f0-9]{64}$/;
  if (completionFence && digestPattern.test(deliveryVerification.stateDigest || "")
    && digestPattern.test(finalDeliveryVerification.stateDigest || "")
    && deliveryVerification.stateDigest !== finalDeliveryVerification.stateDigest) {
    return blockedResult({
      ...finalDeliveryVerification,
      status: "changed",
      blocked: true,
      reason: "AgentSpine delivery evidence changed during Stop; retry completion against the latest state."
    }, premortem);
  }
  return {
    blocked: false,
    reason: null,
    deliveryVerification: finalDeliveryVerification,
    premortem
  };
}
