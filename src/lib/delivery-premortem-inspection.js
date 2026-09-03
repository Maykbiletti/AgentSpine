import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function inspectActiveDeliveryPremortems({ stateDirectory, readState, maxFiles }) {
  const result = { states: [], paths: [], errors: [], truncations: [], directory: stateDirectory };
  try {
    const names = (await readdir(stateDirectory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    if (names.length > maxFiles) result.truncations.push({ path: stateDirectory,
      reason: `limited to ${maxFiles} state files` });
    for (const name of names.slice(0, maxFiles)) {
      const path = join(stateDirectory, name);
      try {
        const state = await readState(path, name.slice(0, 64));
        if (!state) throw new Error("delivery premortem state disappeared during inspection");
        result.states.push(structuredClone(state));
        result.paths.push(path);
      } catch (error) {
        result.errors.push({ path, reason: String(error.message).slice(0, 400) });
      }
    }
  } catch (error) {
    result.errors.push({ path: stateDirectory, reason: String(error.message).slice(0, 400) });
  }
  return result;
}

export async function verifyEmptyPremortemGoalScope({ stateDirectory, readState, maxFiles, expected }) {
  const inspected = await inspectActiveDeliveryPremortems({ stateDirectory, readState, maxFiles });
  if (inspected.errors.length || inspected.truncations.length) return { status: "degraded", blocked: false,
    reason: "premortem read-only orphan scan is uncertain" };
  const found = inspected.states.some((state) => state.binding.goalId === expected.goalId
    && state.binding.goalStepId === expected.goalStepId && state.binding.queueId === expected.queueId
    && state.binding.gatewayAttempt === expected.gatewayAttempt);
  return found ? { status: "mismatch", blocked: true,
    reason: "A read-only premortem scope still has active state." }
    : { status: "empty", blocked: false };
}
