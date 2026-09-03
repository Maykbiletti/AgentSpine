import { createPremortemAttachment } from "./delivery-premortem-closure.js";

export function premortemBlock(status, reason, extra = {}) {
  return { status, blocked: true, reason, ...extra };
}

export function degradedPremortem(error) {
  return { status: "degraded", blocked: false,
    reason: String(error?.message || error).slice(0, 400) };
}

export function premortemBoundary(error) {
  if (error?.code === "AGENTSPINE_PREMORTEM_MISMATCH") {
    return premortemBlock("mismatch", String(error.message).slice(0, 400));
  }
  if (error?.code === "AGENTSPINE_PREMORTEM_FINALIZED") {
    return premortemBlock("finalized", String(error.message).slice(0, 400));
  }
  return degradedPremortem(error);
}

export function closedPremortemResult(state, requirementId) {
  const attachment = state.binding.goalId ? createPremortemAttachment(state) : null;
  return { status: "closed", blocked: false, requirementId,
    artifact: structuredClone(state.artifact), digest: state.artifact.digest,
    closure: structuredClone(state.closure), checkpointAttachment: attachment,
    outcomeReceiptAttachment: attachment ? structuredClone(attachment) : null };
}
