import { createHash, randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import {
  readAuthenticatedTimelineState, sealSessionTimelineState, sessionTimelinePrivatePaths,
  verifySessionTimelineState
} from "./session-timeline-auth.js";
import { sameTimelineTransportDigest, validTimelineTransportDigest } from "./session-timeline-transport.js";
import { sessionTimelineRootDigest } from "./session-timeline-root.js";

const SCHEMA = "agentspine.session-timeline-invocations/v1";
const HEAD_SCHEMA = "agentspine.session-timeline-invocation-head/v1";
const AUTHORITY = "context-only";
const MAX_BYTES = 256 * 1024;
const HEAD_MAX_BYTES = 64 * 1024;
const MAX_PERMITS = 64;
const PERMIT_TTL_MS = 60_000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function validDate(value) { return Number.isFinite(new Date(value).getTime()); }
function validSignature(value) { return /^[a-f0-9]{64}$/.test(value || ""); }
function validGeneration(value) { return Number.isSafeInteger(value) && value > 0; }
function empty(root) {
  return { schema: SCHEMA, rootDigest: sessionTimelineRootDigest(root), permits: [], generation: 0,
    previousSignature: null, authority: AUTHORITY };
}

function validPermit(item) {
  return item && validSignature(item.requestDigest) && validTimelineTransportDigest(item.transportDigest)
    && validSignature(item.toolUseDigest) && validDate(item.expiresAt) && item.authority === AUTHORITY;
}

function validate(state, root) {
  if (!state || state.schema !== SCHEMA || state.rootDigest !== sessionTimelineRootDigest(root) || state.authority !== AUTHORITY
    || !validGeneration(state.generation) || !validSignature(state.signature)
    || (state.generation === 1 ? state.previousSignature !== null : !validSignature(state.previousSignature))
    || !Array.isArray(state.permits) || state.permits.length > MAX_PERMITS || !state.permits.every(validPermit)) {
    throw new Error("session timeline invocation state is invalid");
  }
  return state;
}

function validateHead(head, root) {
  if (!head || head.schema !== HEAD_SCHEMA || head.rootDigest !== sessionTimelineRootDigest(root) || head.authority !== AUTHORITY
    || !validGeneration(head.generation) || !validSignature(head.signature) || !validSignature(head.stateSignature)
    || (head.generation === 1 ? head.previousSignature !== null : !validSignature(head.previousSignature))) {
    throw new Error("session timeline invocation head is invalid");
  }
  return head;
}

async function readHead(path, root, assertStable) {
  const text = await readAuthenticatedTimelineState(path, HEAD_MAX_BYTES, assertStable);
  return verifySessionTimelineState(validateHead(JSON.parse(text), root));
}

function matchesHead(state, head) {
  return state.generation === head.generation && state.signature === head.stateSignature
    && state.previousSignature === head.previousSignature;
}

function recoverableForwardCommit(state, head) {
  return state.generation === head.generation + 1 && state.previousSignature === head.stateSignature;
}

async function readState(path, headPath, root, assertStable, assertOwned) {
  let text;
  try {
    text = await readAuthenticatedTimelineState(path, MAX_BYTES, assertStable);
  } catch (error) {
    if (error.code === "ENOENT") {
      try { await readHead(headPath, root, assertStable); }
      catch (headError) {
        if (headError.code === "ENOENT") return empty(root);
        throw headError;
      }
      throw new Error("session timeline invocation state is unavailable");
    }
    throw error;
  }
  const state = await verifySessionTimelineState(validate(JSON.parse(text), root));
  const head = await readHead(headPath, root, assertStable);
  if (matchesHead(state, head)) return state;
  if (!recoverableForwardCommit(state, head)) throw new Error("session timeline invocation replay was rejected");
  await saveHead(state, headPath, root, assertOwned, assertStable);
  return state;
}

async function writeSigned(value, path, maximumBytes, assertOwned, assertStable) {
  const assertWritable = async () => { await assertStable(); await assertOwned(); };
  await assertWritable();
  await sealSessionTimelineState(value);
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("session timeline invocation integrity record exceeds its byte budget");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await assertWritable();
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertWritable });
    await assertWritable();
  } catch (error) {
    await unlink(temporary).catch((cleanup) => { if (cleanup.code !== "ENOENT") error.cleanupError = cleanup; });
    throw error;
  }
}

async function saveHead(state, path, root, assertOwned, assertStable) {
  const head = { schema: HEAD_SCHEMA, rootDigest: sessionTimelineRootDigest(root), generation: state.generation,
    stateSignature: state.signature, previousSignature: state.previousSignature, authority: AUTHORITY };
  await writeSigned(head, path, HEAD_MAX_BYTES, assertOwned, assertStable);
}

async function saveState(state, path, headPath, root, assertOwned, assertStable) {
  if (!Number.isSafeInteger(state.generation) || state.generation < 0 || state.generation >= Number.MAX_SAFE_INTEGER) {
    throw new Error("session timeline invocation generation is invalid");
  }
  state.previousSignature = state.generation === 0 ? null : state.signature;
  state.generation += 1;
  delete state.signature;
  await writeSigned(state, path, MAX_BYTES, assertOwned, assertStable);
  validate(state, root);
  await saveHead(state, headPath, root, assertOwned, assertStable);
}

function requestDigest({ root, tool, binding, sourceDigest, request }) {
  if (!/^(index|search)$/.test(tool || "") || !/^[a-f0-9]{64}$/.test(sourceDigest || "")
    || !binding || !request) {
    throw new Error("session timeline invocation binding is invalid");
  }
  return digest(canonical({ rootDigest: sessionTimelineRootDigest(root), tool, binding, sourceDigest, request }));
}

function purgeExpired(state, now) {
  const timestamp = now.getTime();
  state.permits = state.permits.filter((item) => new Date(item.expiresAt).getTime() > timestamp);
}

export async function issueSessionTimelineInvocation({
  root, tool, binding, sourceDigest, request, toolUseId, transportDigest, now = new Date()
}) {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime()) || typeof toolUseId !== "string" || toolUseId.length < 1 || toolUseId.length > 256) {
    throw new Error("session timeline invocation time or tool use is invalid");
  }
  if (!validTimelineTransportDigest(transportDigest)) throw new Error("session timeline transport is unavailable");
  const requested = requestDigest({ root, tool, binding, sourceDigest, request });
  const toolUseDigest = digest(toolUseId);
  const [names, heads] = await Promise.all([
    sessionTimelinePrivatePaths(root, "invocations"), sessionTimelinePrivatePaths(root, "invocation-head")
  ]);
  await withOwnedFileLock(names.lock, async ({ assertOwned }) => {
    const state = await readState(names.path, heads.path, root, names.assertStable, assertOwned);
    purgeExpired(state, current);
    if (state.permits.some((item) => item.toolUseDigest === toolUseDigest)) {
      throw new Error("session timeline invocation was already issued for this tool use");
    }
    state.permits.push({ requestDigest: requested, transportDigest, toolUseDigest,
      expiresAt: new Date(current.getTime() + PERMIT_TTL_MS).toISOString(), authority: AUTHORITY });
    state.permits = state.permits.slice(-MAX_PERMITS);
    await saveState(state, names.path, heads.path, root, assertOwned, names.assertStable);
  }, { assertPath: names.assertStable });
  return true;
}

export async function consumeSessionTimelineInvocation({
  root, tool, binding, sourceDigest, request, transportDigest, now = new Date()
}) {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime()) || !validTimelineTransportDigest(transportDigest)) {
    return false;
  }
  let requested;
  try { requested = requestDigest({ root, tool, binding, sourceDigest, request }); }
  catch { return false; }
  const [names, heads] = await Promise.all([
    sessionTimelinePrivatePaths(root, "invocations").catch(() => null),
    sessionTimelinePrivatePaths(root, "invocation-head").catch(() => null)
  ]);
  if (!names || !heads) return false;
  try {
    return await withOwnedFileLock(names.lock, async ({ assertOwned }) => {
      const state = await readState(names.path, heads.path, root, names.assertStable, assertOwned);
      purgeExpired(state, current);
      const index = state.permits.findIndex((item) => item.requestDigest === requested
        && sameTimelineTransportDigest(item.transportDigest, transportDigest));
      if (index < 0) return false;
      state.permits.splice(index, 1);
      await saveState(state, names.path, heads.path, root, assertOwned, names.assertStable);
      return true;
    }, { assertPath: names.assertStable });
  } catch { return false; }
}
