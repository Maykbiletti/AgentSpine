import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { premortemMismatchError as mismatchError } from "./delivery-premortem-codec.js";

const SCHEMA = "agentspine.delivery-premortem-index/v1";
const SCOPE_SCHEMA = "agentspine.delivery-premortem-index-scope/v1";
const FINALIZATION_SCHEMA = "agentspine.delivery-premortem-index-finalization/v1";
const AUTHORITY = "context-only";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_POINTER_BYTES = 8 * 1024;
const MAX_LANES_PER_QUEUE = 64;
const MAX_AUDIT_SCOPES = 256;
const MAX_AUDIT_POINTERS = 256;
const KEYS = ["authority", "digest", "gatewayAttempt", "goalId", "goalStepId", "laneDigest",
  "planDefinitionsDigest", "queueId", "schema", "scopeDigest", "sessionDigest"];
const FINALIZATION_KEYS = ["attachmentDigest", "authority", "bindingSummaryDigest", "digest",
  "entityId", "gatewayAttempt", "goalId", "goalStepId", "groupId", "host", "laneDigest",
  "planDefinitionsDigest", "pointerDigest", "projectId", "queueId", "schema", "scopeDigest", "status", "taskId"];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function scopeMaterial(goalId, goalStepId, queueId, gatewayAttempt) {
  return { schema: SCOPE_SCHEMA, goalId, goalStepId, queueId, gatewayAttempt };
}

function scopeDigest(goalId, goalStepId, queueId, gatewayAttempt) {
  return sha256(scopeMaterial(goalId, goalStepId, queueId, gatewayAttempt));
}

export function premortemScopeDigest(goalId, goalStepId, queueId, gatewayAttempt) {
  return scopeDigest(goalId, goalStepId, queueId, gatewayAttempt);
}

function indexRootForState(statePath) {
  return join(dirname(dirname(statePath)), "delivery-premortem-index");
}

function finalizedError(message) {
  const error = new Error(message);
  error.code = "AGENTSPINE_PREMORTEM_FINALIZED";
  return error;
}

function pointerFor(state) {
  const { binding } = state;
  const pointer = {
    schema: SCHEMA,
    scopeDigest: scopeDigest(binding.goalId, binding.goalStepId, binding.queueId,
      binding.gatewayAttempt),
    laneDigest: state.laneDigest,
    sessionDigest: sha256(binding.sessionId),
    goalId: binding.goalId,
    goalStepId: binding.goalStepId,
    queueId: binding.queueId,
    gatewayAttempt: binding.gatewayAttempt,
    planDefinitionsDigest: binding.planDefinitionsDigest,
    authority: AUTHORITY
  };
  return { ...pointer, digest: sha256(pointer) };
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
}

function validPointer(value, expectedScope = null, expectedLane = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical(KEYS)
    || value.schema !== SCHEMA || value.authority !== AUTHORITY
    || !DIGEST_RE.test(value.digest || "") || !DIGEST_RE.test(value.scopeDigest || "")
    || !DIGEST_RE.test(value.laneDigest || "") || !DIGEST_RE.test(value.sessionDigest || "")
    || !validId(value.goalId) || !validId(value.goalStepId)
    || (value.queueId !== null && !validId(value.queueId))
    || (value.gatewayAttempt !== null
      && (!Number.isInteger(value.gatewayAttempt) || value.gatewayAttempt < 1 || value.queueId === null))
    || (value.planDefinitionsDigest !== null && !DIGEST_RE.test(value.planDefinitionsDigest || ""))) return false;
  const material = { ...value };
  delete material.digest;
  return value.digest === sha256(material)
    && value.scopeDigest === scopeDigest(value.goalId, value.goalStepId, value.queueId,
      value.gatewayAttempt)
    && (expectedScope === null || value.scopeDigest === expectedScope)
    && (expectedLane === null || value.laneDigest === expectedLane);
}

async function readPointer(path, expectedScope, expectedLane) {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > MAX_POINTER_BYTES) throw mismatchError("premortem index pointer exceeds 8 KiB");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("premortem index pointer is not valid JSON");
  }
  if (!validPointer(value, expectedScope, expectedLane)) {
    throw mismatchError("premortem index pointer failed integrity validation");
  }
  return value;
}

async function savePointer(path, pointer, assertOwned) {
  const text = `${JSON.stringify(pointer, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertOwned });
    await assertOwned();
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function finalizationFor(pointer, attachmentDigest, status, context, summaryDigests) {
  const value = { schema: FINALIZATION_SCHEMA, scopeDigest: pointer.scopeDigest,
    status, goalId: context.goalId, goalStepId: context.goalStepId, queueId: context.queueId,
    gatewayAttempt: context.gatewayAttempt, planDefinitionsDigest: context.planDefinitionsDigest,
    host: context.host, projectId: context.projectId, entityId: context.entityId ?? null,
    groupId: context.groupId ?? null, taskId: context.taskId ?? null,
    bindingSummaryDigest: sha256([...summaryDigests].sort()),
    laneDigest: pointer.laneDigest, pointerDigest: pointer.digest, attachmentDigest,
    authority: AUTHORITY };
  return { ...value, digest: sha256(value) };
}

function readOnlyFinalizationFor(expectedScope, attachmentDigest, context, summaryDigests) {
  return emptyScopeFinalizationFor(expectedScope, attachmentDigest, "read-only", context, summaryDigests);
}

function fencedFinalizationFor(expectedScope, context, summaryDigests) {
  const attachmentDigest = sha256({ schema: FINALIZATION_SCHEMA, scopeDigest: expectedScope,
    status: "fenced" });
  return emptyScopeFinalizationFor(expectedScope, attachmentDigest, "fenced", context, summaryDigests);
}

function emptyScopeFinalizationFor(expectedScope, attachmentDigest, status, context, summaryDigests) {
  const value = { schema: FINALIZATION_SCHEMA, scopeDigest: expectedScope,
    status, goalId: context.goalId, goalStepId: context.goalStepId,
    queueId: context.queueId, gatewayAttempt: context.gatewayAttempt,
    planDefinitionsDigest: context.planDefinitionsDigest, host: context.host,
    projectId: context.projectId, entityId: context.entityId ?? null, groupId: context.groupId ?? null,
    taskId: null,
    bindingSummaryDigest: sha256([...summaryDigests].sort()),
    laneDigest: null, pointerDigest: null, attachmentDigest,
    authority: AUTHORITY };
  return { ...value, digest: sha256(value) };
}

function validFinalization(value, expectedScope = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical(FINALIZATION_KEYS)
    || value.schema !== FINALIZATION_SCHEMA || value.authority !== AUTHORITY
    || !new Set(["closed", "read-only", "fenced"]).has(value.status)
    || ![value.scopeDigest, value.planDefinitionsDigest, value.bindingSummaryDigest,
      value.attachmentDigest, value.digest]
      .every((digest) => DIGEST_RE.test(digest || ""))
    || !validId(value.goalId) || !validId(value.goalStepId) || !validId(value.queueId)
    || !Number.isInteger(value.gatewayAttempt) || value.gatewayAttempt < 1
    || !validId(value.host) || !validId(value.projectId)
    || (value.entityId !== null && !validId(value.entityId))
    || (value.groupId !== null && !validId(value.groupId))
    || (value.taskId !== null && !validId(value.taskId))
    || value.scopeDigest !== scopeDigest(value.goalId, value.goalStepId,
      value.queueId, value.gatewayAttempt)
    || (value.status === "closed"
      ? ![value.laneDigest, value.pointerDigest].every((digest) => DIGEST_RE.test(digest || ""))
      : value.laneDigest !== null || value.pointerDigest !== null)
    || (expectedScope !== null && value.scopeDigest !== expectedScope)) return false;
  const material = { ...value };
  delete material.digest;
  return value.digest === sha256(material);
}

export function validPremortemScopeFinalizationContext(value, context) {
  if (!context) return false;
  const fields = ["goalId", "goalStepId", "queueId", "gatewayAttempt",
    "planDefinitionsDigest", "host", "projectId"];
  return validFinalization(value, scopeDigest(context.goalId, context.goalStepId,
    context.queueId, context.gatewayAttempt))
    && fields.every((field) => canonical(value[field]) === canonical(context[field]))
    && value.entityId === (context.entityId ?? null) && value.groupId === (context.groupId ?? null)
    && value.taskId === (context.taskId ?? null);
}

export function validPremortemScopeFinalization(value, context, bindingSummaryDigests = []) {
  return validPremortemScopeFinalizationContext(value, context)
    && Array.isArray(bindingSummaryDigests)
    && bindingSummaryDigests.every((digest) => DIGEST_RE.test(digest || ""))
    && value.bindingSummaryDigest === sha256([...bindingSummaryDigests].sort());
}

async function readFinalization(path, expectedScope) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_POINTER_BYTES) {
      throw mismatchError("premortem scope finalization exceeds 8 KiB");
    }
    const value = JSON.parse(text);
    if (!validFinalization(value, expectedScope)) {
      throw mismatchError("premortem scope finalization failed integrity validation");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function registerPremortemLaneIndex({ statePath, state, commit = null, scopeCheck = null }) {
  if (!state?.binding?.goalId || !state.binding.goalStepId) {
    await commit?.();
    return { status: "not-applicable" };
  }
  const pointer = pointerFor(state);
  if (!validPointer(pointer, pointer.scopeDigest, pointer.laneDigest)) {
    throw mismatchError("premortem index pointer failed integrity validation");
  }
  const indexRoot = indexRootForState(statePath);
  const directory = join(indexRoot, pointer.scopeDigest);
  await mkdir(indexRoot, { recursive: true, mode: 0o700 });
  const path = join(directory, `${pointer.laneDigest}.json`);
  const scopeLock = join(indexRoot, `${pointer.scopeDigest}.lock`);
  await withOwnedFileLock(scopeLock, async ({ assertOwned: assertScopeOwned }) => {
    await assertScopeOwned();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const finalizationPath = join(directory, "finalized.json");
    if (await readFinalization(finalizationPath, pointer.scopeDigest)) {
      throw finalizedError("premortem goal-step attempt was already finalized");
    }
    await scopeCheck?.();
    await withOwnedFileLock(`${path}.lock`, async ({ assertOwned: assertPointerOwned }) => {
      await assertScopeOwned();
      await assertPointerOwned();
      if (await readFinalization(finalizationPath, pointer.scopeDigest)) {
        throw finalizedError("premortem goal-step attempt was already finalized");
      }
      let previous = null;
      try {
        previous = await readPointer(path, pointer.scopeDigest, pointer.laneDigest);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (previous && previous.digest !== pointer.digest) {
        throw mismatchError("premortem index pointer conflicts with its lane");
      }
      const assertBothOwned = async () => {
        await assertScopeOwned();
        await assertPointerOwned();
      };
      if (!previous) await savePointer(path, pointer, assertBothOwned);
      await commit?.({ assertOwned: assertBothOwned });
    });
  });
  return { status: "indexed", pointer, path };
}

export async function finalizePremortemLaneIndex({ stateDirectory, goalId, goalStepId,
  queueId = null, gatewayAttempt = null, laneDigest, attachmentDigest, context,
  bindingSummaryDigests = [], commit = null }) {
  return finalizePremortemScope({ stateDirectory, goalId, goalStepId, queueId,
    gatewayAttempt, laneDigest, attachmentDigest, status: "closed", context,
    bindingSummaryDigests, commit });
}

export async function finalizePremortemScope({ stateDirectory, goalId, goalStepId,
  queueId = null, gatewayAttempt = null, laneDigest = null, attachmentDigest,
  status, context, bindingSummaryDigests = [], commit = null, verifyEmpty = null }) {
  const expected = scopeDigest(goalId, goalStepId, queueId, gatewayAttempt);
  const indexRoot = join(dirname(stateDirectory), "delivery-premortem-index");
  const directory = join(indexRoot, expected);
  if (!context || canonical({ goalId, goalStepId, queueId, gatewayAttempt })
    !== canonical({ goalId: context.goalId, goalStepId: context.goalStepId,
      queueId: context.queueId, gatewayAttempt: context.gatewayAttempt })
    || !Array.isArray(bindingSummaryDigests) || bindingSummaryDigests.length > MAX_LANES_PER_QUEUE
    || bindingSummaryDigests.some((digest) => !DIGEST_RE.test(digest || ""))) {
    throw mismatchError("premortem finalization context is invalid");
  }
  await mkdir(indexRoot, { recursive: true, mode: 0o700 });
  return withOwnedFileLock(join(indexRoot, `${expected}.lock`), async ({ assertOwned, recovered }) => {
    await assertOwned();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "finalized.json");
    const previous = await readFinalization(path, expected);
    if (previous?.status === "fenced") return { status: "mismatch", blocked: true,
      reason: "Premortem scope was fenced after stale lock recovery.", finalization: previous };
    if (!previous && recovered) {
      const fenced = fencedFinalizationFor(expected, context, bindingSummaryDigests);
      if (!validPremortemScopeFinalization(fenced, context, bindingSummaryDigests)) {
        throw mismatchError("premortem scope fence evidence is invalid");
      }
      await assertOwned();
      await savePointer(path, fenced, assertOwned);
      return { status: "mismatch", blocked: true,
        reason: "Premortem scope was fenced after stale lock recovery.", finalization: fenced };
    }
    const indexed = await lookupPremortemLaneIndex({ stateDirectory, goalId, goalStepId,
      queueId, gatewayAttempt });
    if (indexed.blocked || indexed.status === "degraded") return indexed;
    const closed = status === "closed";
    if (!new Set(["closed", "read-only"]).has(status)
      || (closed && (indexed.pointers.length !== 1 || indexed.pointers[0].laneDigest !== laneDigest))
      || (!closed && indexed.pointers.length !== 0)) {
      return { status: "conflict", blocked: true,
        reason: "Premortem goal-step attempt changed during finalization." };
    }
    if (!closed && verifyEmpty) {
      const verified = await verifyEmpty();
      if (!verified || verified.status !== "empty") return verified || { status: "degraded", blocked: false,
        reason: "Premortem read-only orphan scan was inconclusive." };
    }
    const value = closed
      ? finalizationFor(indexed.pointers[0], attachmentDigest, status, context, bindingSummaryDigests)
      : readOnlyFinalizationFor(expected, attachmentDigest, context, bindingSummaryDigests);
    if (!validPremortemScopeFinalization(value, context, bindingSummaryDigests)) {
      throw mismatchError("premortem finalization evidence is invalid");
    }
    if (previous) {
      if (previous.digest !== value.digest) {
        throw mismatchError("premortem scope has conflicting finalization evidence");
      }
      return { status: "finalized", blocked: false, finalization: previous };
    }
    await assertOwned();
    await commit?.({ assertOwned });
    await savePointer(path, value, assertOwned);
    return { status: "finalized", blocked: false, finalization: value };
  });
}

export async function removePremortemLaneIndex({ statePath, state, commit = null }) {
  if (!state?.binding?.goalId || !state.binding.goalStepId) {
    await commit?.({ assertOwned: async () => {} });
    return { status: "not-applicable" };
  }
  const pointer = pointerFor(state);
  const indexRoot = indexRootForState(statePath);
  const directory = join(indexRoot, pointer.scopeDigest);
  const path = join(directory, `${pointer.laneDigest}.json`);
  try {
    await mkdir(indexRoot, { recursive: true, mode: 0o700 });
    await withOwnedFileLock(join(indexRoot, `${pointer.scopeDigest}.lock`), async ({ assertOwned: assertScopeOwned }) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const finalizationPath = join(directory, "finalized.json");
      await assertScopeOwned();
      if (await readFinalization(finalizationPath, pointer.scopeDigest)) {
        throw finalizedError("premortem goal-step attempt was already finalized");
      }
      await withOwnedFileLock(`${path}.lock`, async ({ assertOwned: assertPointerOwned }) => {
        await assertScopeOwned();
        await assertPointerOwned();
        if (await readFinalization(finalizationPath, pointer.scopeDigest)) {
          throw finalizedError("premortem goal-step attempt was already finalized");
        }
        try {
          const previous = await readPointer(path, pointer.scopeDigest, pointer.laneDigest);
          if (previous.digest !== pointer.digest) {
            throw mismatchError("premortem index pointer conflicts with its lane");
          }
          await assertScopeOwned();
          await assertPointerOwned();
          await unlink(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await commit?.({ assertOwned: async () => {
          await assertScopeOwned();
          await assertPointerOwned();
        } });
      });
      await assertScopeOwned();
      await rmdir(directory).catch((error) => {
        if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(error.code)) throw error;
      });
    });
    return { status: "removed", path };
  } catch (error) {
    const verified = error.code === "AGENTSPINE_PREMORTEM_MISMATCH"
      || error.code === "AGENTSPINE_PREMORTEM_FINALIZED";
    return { status: verified ? (error.code === "AGENTSPINE_PREMORTEM_FINALIZED" ? "finalized" : "mismatch") : "degraded",
      blocked: verified,
      reason: String(error.message).slice(0, 400), path };
  }
}

export async function lookupPremortemLaneIndex({ stateDirectory, goalId, goalStepId,
  queueId = null, gatewayAttempt = null }) {
  const expected = scopeDigest(goalId, goalStepId, queueId, gatewayAttempt);
  const directory = join(dirname(stateDirectory), "delivery-premortem-index", expected);
  let names, finalization;
  try {
    names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    finalization = await readFinalization(join(directory, "finalized.json"), expected);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "unavailable", pointers: [], directory };
    if (error.code === "AGENTSPINE_PREMORTEM_MISMATCH") return { status: "mismatch", blocked: true,
      reason: String(error.message).slice(0, 400), pointers: [], directory };
    return { status: "degraded", blocked: false,
      reason: String(error.message).slice(0, 400), pointers: [], directory };
  }
  if (names.length > MAX_LANES_PER_QUEUE) return { status: "capacity", blocked: true,
    reason: `premortem queue index exceeds ${MAX_LANES_PER_QUEUE} lanes`, pointers: [], directory };
  try {
    const pointers = [];
    for (const name of names) pointers.push(await readPointer(join(directory, name), expected, name.slice(0, 64)));
    if (finalization) {
      if (finalization.status === "fenced") return { status: "mismatch", blocked: true,
        reason: "premortem scope was fenced after stale lock recovery", pointers: [], directory };
      const validClosed = finalization.status === "closed" && pointers.length === 1
        && finalization.laneDigest === pointers[0].laneDigest
        && finalization.pointerDigest === pointers[0].digest
        && finalization.planDefinitionsDigest === pointers[0].planDefinitionsDigest;
      const validReadOnly = finalization.status === "read-only" && pointers.length === 0;
      if (!(validClosed || validReadOnly)) return { status: "mismatch", blocked: true,
        reason: "premortem scope finalization conflicts with its index", pointers: [], directory };
      return { status: "finalized", blocked: false, pointers, finalization, directory };
    }
    return { status: pointers.length ? "available" : "unavailable", pointers, finalization: null, directory };
  } catch (error) {
    if (error.code === "AGENTSPINE_PREMORTEM_MISMATCH") {
      return { status: "mismatch", blocked: true,
        reason: String(error.message).slice(0, 400), pointers: [], directory };
    }
    return { status: "degraded", blocked: false,
      reason: String(error.message).slice(0, 400), pointers: [], directory };
  }
}

export async function inspectPremortemLaneIndexes(stateDirectory) {
  const directory = join(dirname(stateDirectory), "delivery-premortem-index");
  const result = { directory, directories: [], paths: [], pointers: [], errors: [],
    finalizations: [], tamperedPointers: [], tamperedFinalizations: [], truncations: [] };
  let scopes;
  try {
    scopes = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && DIGEST_RE.test(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code !== "ENOENT") result.errors.push({ path: directory, reason: String(error.message).slice(0, 400) });
    return result;
  }
  if (scopes.length > MAX_AUDIT_SCOPES) result.truncations.push({ path: directory,
    reason: `premortem index exceeds ${MAX_AUDIT_SCOPES} audit scopes` });
  let remaining = MAX_AUDIT_POINTERS;
  for (const scope of scopes.slice(0, MAX_AUDIT_SCOPES)) {
    const scopePath = join(directory, scope);
    result.directories.push(scopePath);
    const finalizationPath = join(scopePath, "finalized.json");
    try {
      const finalization = await readFinalization(finalizationPath, scope);
      if (finalization) {
        result.paths.push(finalizationPath);
        result.finalizations.push(finalization);
      }
    } catch (error) {
      result.paths.push(finalizationPath);
      result.errors.push({ path: finalizationPath, reason: String(error.message).slice(0, 400) });
      if (error.code === "AGENTSPINE_PREMORTEM_MISMATCH") {
        result.tamperedFinalizations.push(finalizationPath);
      }
    }
    let names;
    try {
      names = (await readdir(scopePath)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    } catch (error) {
      result.errors.push({ path: scopePath, reason: String(error.message).slice(0, 400) });
      continue;
    }
    if (names.length > remaining) {
      result.truncations.push({ path: scopePath, reason: `premortem index exceeds ${MAX_AUDIT_POINTERS} audit pointers` });
    }
    for (const name of names.slice(0, remaining)) {
      const path = join(scopePath, name);
      result.paths.push(path);
      try {
        result.pointers.push(await readPointer(path, scope, name.slice(0, 64)));
      } catch (error) {
        result.errors.push({ path, reason: String(error.message).slice(0, 400) });
        if (error.code === "AGENTSPINE_PREMORTEM_MISMATCH") result.tamperedPointers.push(path);
      }
    }
    remaining = Math.max(0, remaining - names.length);
  }
  return result;
}
