import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import {
  readAuthenticatedTimelineState, sealSessionTimelineState, sessionTimelinePrivatePaths,
  verifySessionTimelineState
} from "./session-timeline-auth.js";

export async function privateEnrollmentPaths(root, { create = true } = {}) {
  const state = await sessionTimelinePrivatePaths(root, "enrollment", { create });
  const head = await sessionTimelinePrivatePaths(root, "enrollment-head", { create });
  return {
    ...state,
    headPath: head.path,
    assertStable: async () => { await state.assertStable(); await head.assertStable(); }
  };
}

function validHead(value, root, headSchema, headAuthority) {
  return value && value.schema === headSchema && value.rootDigest === root.digest
    && validGeneration(value.generation) && validSignature(value.signature)
    && validSignature(value.stateSignature)
    && (value.generation === 1 ? value.previousSignature === null : validSignature(value.previousSignature))
    && value.authority === headAuthority;
}

function validSignature(value) { return /^[a-f0-9]{64}$/.test(value || ""); }
function validGeneration(value) { return Number.isSafeInteger(value) && value > 0; }

async function readHead(path, root, assertStable, headSchema, headAuthority, maximumBytes) {
  const text = await readAuthenticatedTimelineState(path, maximumBytes, assertStable);
  const head = await verifySessionTimelineState(JSON.parse(text));
  if (!validHead(head, root, headSchema, headAuthority)) throw new Error("private timeline enrollment head is invalid");
  return head;
}

export async function readPrivateEnrollmentState({
  path, headPath, root, assertStable, assertOwned = null, empty, validate, headSchema, headAuthority, maximumBytes
}) {
  let text;
  try {
    text = await readAuthenticatedTimelineState(path, maximumBytes, assertStable);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { await readHead(headPath, root, assertStable, headSchema, headAuthority, maximumBytes); }
    catch (headError) {
      if (headError.code === "ENOENT") return empty(root.value);
      throw headError;
    }
    throw new Error("private timeline enrollment state is missing");
  }
  const state = await verifySessionTimelineState(validate(JSON.parse(text), root.value));
  const head = await readHead(headPath, root, assertStable, headSchema, headAuthority, maximumBytes);
  if (matchesHead(state, head)) return state;
  if (typeof assertOwned !== "function" || !recoverableForwardCommit(state, head)) {
    throw new Error("private timeline enrollment state replay was rejected");
  }
  // A state replacement can survive a crash before its paired head replacement.
  // Repair is allowed only while holding the owned lock and only for the exact
  // authenticated one-generation successor of the retained head.  Re-read both
  // records after writing so a path swap cannot produce usable content.
  const freshState = await readAuthenticatedTimelineState(path, maximumBytes, assertStable);
  const checkedState = await verifySessionTimelineState(validate(JSON.parse(freshState), root.value));
  const checkedHead = await readHead(headPath, root, assertStable, headSchema, headAuthority, maximumBytes);
  if (!sameState(state, checkedState) || !recoverableForwardCommit(checkedState, checkedHead)) {
    throw new Error("private timeline enrollment state replay was rejected");
  }
  await savePrivateEnrollmentHead({ state: checkedState, path: headPath, root, assertOwned, assertStable,
    headSchema, headAuthority, maximumBytes });
  const finalStateText = await readAuthenticatedTimelineState(path, maximumBytes, assertStable);
  const finalState = await verifySessionTimelineState(validate(JSON.parse(finalStateText), root.value));
  const finalHead = await readHead(headPath, root, assertStable, headSchema, headAuthority, maximumBytes);
  if (!matchesHead(finalState, finalHead)) throw new Error("private timeline enrollment state replay was rejected");
  return finalState;
}

function matchesHead(state, head) {
  return state.generation === head.generation && state.signature === head.stateSignature
    && state.previousSignature === head.previousSignature;
}

function sameState(left, right) {
  return left.generation === right.generation && left.previousSignature === right.previousSignature
    && left.signature === right.signature;
}

function recoverableForwardCommit(state, head) {
  return state.generation === head.generation + 1 && state.previousSignature === head.stateSignature;
}

async function saveSigned(value, path, maximumBytes, label, assertOwned, assertStable) {
  const assertWritable = async () => { await assertStable(); await assertOwned(); };
  await assertWritable();
  await sealSessionTimelineState(value);
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error(`${label} exceeds its byte budget`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertWritable });
    await assertWritable();
  } catch (error) {
    await unlink(temporary).catch((cleanup) => { if (cleanup.code !== "ENOENT") error.cleanupError = cleanup; });
    throw error;
  }
}

export async function savePrivateEnrollmentState({
  state, path, headPath, root, assertOwned, assertStable, headSchema, headAuthority, maximumBytes
}) {
  if (!Number.isSafeInteger(state.generation) || state.generation < 0 || state.generation >= Number.MAX_SAFE_INTEGER
    || (state.generation > 0 && !validSignature(state.signature))) {
    throw new Error("private timeline enrollment generation is invalid");
  }
  state.previousSignature = state.generation === 0 ? null : state.signature;
  state.generation += 1;
  delete state.signature;
  await saveSigned(state, path, maximumBytes, "private timeline enrollment state", assertOwned, assertStable);
  await savePrivateEnrollmentHead({ state, path: headPath, root, assertOwned, assertStable,
    headSchema, headAuthority, maximumBytes });
}

export async function savePrivateEnrollmentHead({
  state, path, root, assertOwned, assertStable, headSchema, headAuthority, maximumBytes
}) {
  const head = {
    schema: headSchema, rootDigest: root.digest, generation: state.generation,
    stateSignature: state.signature, previousSignature: state.previousSignature,
    authority: headAuthority
  };
  await saveSigned(head, path, maximumBytes, "private timeline enrollment head", assertOwned, assertStable);
}
