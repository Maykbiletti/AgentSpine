import { join } from "node:path";
import { lookupPremortemLaneIndex } from "./delivery-premortem-index.js";
import { premortemSha256 as sha256,
  premortemMismatchError as mismatchError } from "./delivery-premortem-codec.js";

function sameIndexedLane(state, pointer) {
  const binding = state?.binding;
  return state?.laneDigest === pointer.laneDigest
    && binding?.goalId === pointer.goalId
    && binding?.goalStepId === pointer.goalStepId
    && binding?.queueId === pointer.queueId
    && binding?.gatewayAttempt === pointer.gatewayAttempt
    && binding?.planDefinitionsDigest === pointer.planDefinitionsDigest
    && sha256(binding?.sessionId || "") === pointer.sessionDigest;
}

function sessionConflict(binding) {
  return mismatchError(
    `A different host session already wrote in ${binding.goalId}/${binding.goalStepId}, `
    + `queue ${binding.queueId}, gateway attempt ${binding.gatewayAttempt}. This session cannot `
    + "continue that attempt; fail or expire the lease, reconcile, and reclaim the queue so "
    + "AGENTSPINE_GATEWAY_ATTEMPT advances before retrying."
  );
}

export function premortemGoalWriterScopeCheck({ stateDirectory, binding, laneDigest, readState }) {
  if (!binding.goalId || !binding.goalStepId || !binding.queueId || binding.gatewayAttempt === null) {
    return null;
  }
  return async () => {
    const indexed = await lookupPremortemLaneIndex({ stateDirectory,
      goalId: binding.goalId, goalStepId: binding.goalStepId,
      queueId: binding.queueId, gatewayAttempt: binding.gatewayAttempt });
    if (indexed.blocked) throw mismatchError(indexed.reason);
    if (indexed.status === "degraded") throw new Error(indexed.reason);
    for (const pointer of indexed.pointers || []) {
      if (pointer.laneDigest === laneDigest) continue;
      const state = await readState(join(stateDirectory, `${pointer.laneDigest}.json`),
        pointer.laneDigest);
      if (!state || !sameIndexedLane(state, pointer)) {
        throw mismatchError("A premortem session pointer does not match its exact lane state.");
      }
      if (state.firstWrite) throw sessionConflict(binding);
    }
  };
}
