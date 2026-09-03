import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { lookupPremortemLaneIndex,
  registerPremortemLaneIndex } from "./delivery-premortem-index.js";
import { premortemSha256 as sha256 } from "./delivery-premortem-codec.js";

const MAX_RECOVERY_SNAPSHOTS = 2;

export async function recoverPremortemLaneIndex({ stateDirectory, state, readState }) {
  const statePath = join(stateDirectory, `${state.laneDigest}.json`);
  return withOwnedFileLock(`${statePath}.lock`, async () => {
    const current = await readState(statePath, state.laneDigest);
    if (!current) return { status: "disappeared" };
    return registerPremortemLaneIndex({ statePath, state: current });
  });
}

export async function removePremortemStateFile(path, assertLaneOwned, assertIndexOwned) {
  await assertLaneOwned();
  await assertIndexOwned();
  await unlink(path);
}

async function resolvePointer({ stateDirectory, pointer, readState, expected }) {
  const statePath = join(stateDirectory, `${pointer.laneDigest}.json`);
  return withOwnedFileLock(`${statePath}.lock`, async () => {
    const state = await readState(statePath, pointer.laneDigest);
    if (!state) {
      const refreshed = await lookupPremortemLaneIndex({ stateDirectory, ...expected });
      const retained = refreshed.pointers?.some((item) => item.digest === pointer.digest);
      if (retained) return { status: "mismatch", blocked: true,
        reason: "A premortem index pointer has no state." };
      if (refreshed.blocked || refreshed.status === "degraded") return refreshed;
      return { status: "retry", blocked: false };
    }
    const binding = state.binding;
    if (binding.goalId !== expected.goalId || binding.goalStepId !== expected.goalStepId
      || binding.queueId !== expected.queueId || binding.gatewayAttempt !== expected.gatewayAttempt
      || binding.planDefinitionsDigest !== pointer.planDefinitionsDigest
      || sha256(binding.sessionId) !== pointer.sessionDigest) {
      return { status: "mismatch", blocked: true,
        reason: "The premortem index does not match its state." };
    }
    return { status: "resolved", blocked: false, state };
  });
}

export async function resolvePremortemGoalScope({ stateDirectory, expected,
  inspectStates, readState, removeReadOnlyState }) {
  for (let attempt = 0; attempt < MAX_RECOVERY_SNAPSHOTS; attempt += 1) {
    let indexed = await lookupPremortemLaneIndex({ stateDirectory, ...expected });
    if (indexed.status === "capacity") {
      const scanned = await inspectStates();
      if (scanned.errors.length || scanned.truncations.length) return indexed;
      const exact = scanned.states.filter((state) => state.binding.goalId === expected.goalId
        && state.binding.goalStepId === expected.goalStepId
        && state.binding.queueId === expected.queueId
        && state.binding.gatewayAttempt === expected.gatewayAttempt);
      let removed = false;
      for (const state of exact.filter((item) => !item.firstWrite)) {
        const result = await removeReadOnlyState(state);
        removed ||= result.removed;
      }
      if (!removed) return indexed;
      indexed = await lookupPremortemLaneIndex({ stateDirectory, ...expected });
    }
    if (indexed.blocked || indexed.status === "degraded") return indexed;
    const scanned = await inspectStates();
    if (indexed.status === "finalized") {
      if (scanned.errors.length || scanned.truncations.length) {
        return { status: "mismatch", blocked: true,
          reason: "A finalized premortem scope cannot verify that no stale lane was published." };
      }
      const exact = scanned.states.filter((state) => state.binding.goalId === expected.goalId
        && state.binding.goalStepId === expected.goalStepId
        && state.binding.queueId === expected.queueId
        && state.binding.gatewayAttempt === expected.gatewayAttempt);
      const indexedLanes = new Set(indexed.pointers.map((pointer) => pointer.laneDigest));
      const unexpected = indexed.finalization?.status === "read-only"
        ? exact : exact.filter((state) => !indexedLanes.has(state.laneDigest));
      if (unexpected.length) {
        return { status: "mismatch", blocked: true,
          reason: "A finalized premortem scope has a stale unindexed lane." };
      }
    } else {
      if (scanned.errors.length || scanned.truncations.length) {
        return { status: "degraded", blocked: false,
          reason: "premortem orphan scan is uncertain" };
      }
      const exact = scanned.states.filter((state) => state.binding.goalId === expected.goalId
        && state.binding.goalStepId === expected.goalStepId
        && state.binding.queueId === expected.queueId
        && state.binding.gatewayAttempt === expected.gatewayAttempt);
      const indexedLanes = new Set(indexed.pointers.map((pointer) => pointer.laneDigest));
      const orphaned = exact.filter((state) => !indexedLanes.has(state.laneDigest));
      if (orphaned.length) {
        for (const state of orphaned) {
          await recoverPremortemLaneIndex({ stateDirectory, state, readState });
        }
        continue;
      }
      if (indexed.status === "unavailable") return indexed;
    }
    const states = [];
    let retry = false;
    for (const pointer of indexed.pointers) {
      const resolved = await resolvePointer({ stateDirectory, pointer, readState, expected });
      if (resolved.status === "retry") {
        retry = true;
        break;
      }
      if (resolved.status !== "resolved") return resolved;
      states.push(resolved.state);
    }
    if (!retry) return { ...indexed, states };
  }
  return { status: "degraded", blocked: false,
    reason: "premortem goal scope changed during bounded recovery" };
}
