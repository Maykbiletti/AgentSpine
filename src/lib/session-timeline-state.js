import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import {
  readAuthenticatedTimelineState, readSessionTimelineHead, recordSessionTimelineHead, sealSessionTimelineState,
  sessionTimelineHeadExists, verifySessionTimelineHead, verifySessionTimelineState
} from "./session-timeline-auth.js";

function validSignature(value) { return /^[a-f0-9]{64}$/.test(value || ""); }

function validStateGeneration(state) {
  return state.generation === undefined && state.previousSignature === undefined
    || Number.isSafeInteger(state.generation) && state.generation > 0
    && (state.generation === 1 && state.previousSignature === null || validSignature(state.previousSignature));
}

function matchesHead(state, head) {
  return state.signature === head.stateSignature && state.generation === head.generation
    && state.previousSignature === head.previousSignature;
}

function sameState(left, right) {
  return left.signature === right.signature && left.generation === right.generation
    && left.previousSignature === right.previousSignature;
}

function sameHead(left, right) {
  return left.signature === right.signature && left.stateSignature === right.stateSignature
    && left.generation === right.generation && left.previousSignature === right.previousSignature;
}

function recoverableForwardCommit(state, head) {
  if (!Number.isSafeInteger(state.generation) || !validSignature(state.previousSignature)) return false;
  if (head.generation === undefined) return state.generation === 1 && state.previousSignature === head.stateSignature;
  return state.generation === head.generation + 1 && state.previousSignature === head.stateSignature;
}

async function authenticatedState({ path, root, maximumBytes, validate, assertStable }) {
  const content = await readAuthenticatedTimelineState(path, maximumBytes, assertStable);
  const state = await verifySessionTimelineState(validate(JSON.parse(content), root));
  if (!validStateGeneration(state)) throw new Error("session timeline state generation is invalid");
  return state;
}

export async function readTimelineState({
  path, root, maximumBytes, empty, validate, assertStable = null, assertOwned = null
}) {
  try {
    const state = await authenticatedState({ path, root, maximumBytes, validate, assertStable });
    const head = await readSessionTimelineHead({ root });
    if (matchesHead(state, head)) return state;
    if (typeof assertOwned !== "function" || !recoverableForwardCommit(state, head)) {
      throw new Error("session timeline state replay was rejected");
    }
    const checkedState = await authenticatedState({ path, root, maximumBytes, validate, assertStable });
    const checkedHead = await readSessionTimelineHead({ root });
    if (!sameState(state, checkedState) || !sameHead(head, checkedHead)
      || !recoverableForwardCommit(checkedState, checkedHead)) {
      throw new Error("session timeline state replay was rejected");
    }
    await recordSessionTimelineHead({ root, stateSignature: checkedState.signature,
      generation: checkedState.generation, previousSignature: checkedState.previousSignature, assertOwned });
    const finalState = await authenticatedState({ path, root, maximumBytes, validate, assertStable });
    await verifySessionTimelineHead({ root, stateSignature: finalState.signature,
      generation: finalState.generation, previousSignature: finalState.previousSignature });
    return finalState;
  } catch (error) {
    if (error.code === "ENOENT") {
      if (await sessionTimelineHeadExists({ root })) throw new Error("session timeline state is missing after a signed head");
      return empty(root);
    }
    throw error;
  }
}

export async function saveTimelineState({ state, path, root, maximumBytes, assertOwned, assertStable = null }) {
  const assertWritable = async () => {
    await assertStable?.();
    await assertOwned?.();
  };
  await assertWritable();
  if (state.generation === undefined && state.previousSignature === undefined) {
    state.generation = 1;
    state.previousSignature = validSignature(state.signature) ? state.signature : null;
  } else {
    if (!Number.isSafeInteger(state.generation) || state.generation < 0 || state.generation >= Number.MAX_SAFE_INTEGER
      || state.generation > 0 && !validSignature(state.signature)) {
      throw new Error("session timeline state generation is invalid");
    }
    state.previousSignature = state.generation === 0 ? null : state.signature;
    state.generation += 1;
  }
  delete state.signature;
  await sealSessionTimelineState(state);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("session timeline state exceeds 16 MiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertWritable });
    await assertWritable();
  }
  catch (error) {
    await unlink(temporary).catch((cleanup) => { if (cleanup.code !== "ENOENT") error.cleanupError = cleanup; });
    throw error;
  }
  await recordSessionTimelineHead({ root, stateSignature: state.signature, generation: state.generation,
    previousSignature: state.previousSignature, assertOwned: assertWritable });
  await assertStable?.();
}
