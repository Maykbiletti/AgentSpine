import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { canonicalPath, projectStateDir } from "./paths.js";
import { commandFromInput, deliveryToolActions, isSuccessMarkerClause } from "./delivery-command-actions.js";
import { deliveryWriteIdDigest } from "./delivery-premortem-binding.js";

export { deliveryToolActions } from "./delivery-command-actions.js";

export const DELIVERY_VERIFICATION_SCHEMA = "agentspine.delivery-verification/v1";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_RECENT_EVENTS = 32;
const MAX_PENDING_WRITE_INTENTS = 32;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const TEST_PROOF_GUIDANCE = "AgentSpine saw a test command without verified success. Use structured exit_code 0, "
  + "or append && node -e \"console.log('AGENTSPINE_TEST_OK')\" and keep that marker as the final output line.";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stateMaterial(state) {
  return {
    schema: state.schema,
    laneDigest: state.laneDigest,
    revision: state.revision,
    lastWrite: state.lastWrite,
    lastTest: state.lastTest,
    verifiedWriteDigest: state.verifiedWriteDigest,
    pauseEventDigest: state.pauseEventDigest,
    conflict: state.conflict,
    pendingWriteIntents: state.pendingWriteIntents,
    recentEvents: state.recentEvents,
    authority: "verification-state-only"
  };
}

function legacyStateMaterial(state) {
  const material = stateMaterial(state);
  delete material.pendingWriteIntents;
  return material;
}

function seal(state) {
  state.integrityDigest = sha256(JSON.stringify(stateMaterial(state)));
  return state;
}

function emptyState(laneDigest) {
  return seal({
    schema: DELIVERY_VERIFICATION_SCHEMA,
    laneDigest,
    revision: 0,
    lastWrite: null,
    lastTest: null,
    verifiedWriteDigest: null,
    pauseEventDigest: null,
    conflict: null,
    pendingWriteIntents: [],
    recentEvents: [],
    integrityDigest: null,
    authority: "verification-state-only"
  });
}

function validReceipt(receipt) {
  return receipt === null || (receipt && typeof receipt === "object" && !Array.isArray(receipt)
    && DIGEST_RE.test(receipt.eventDigest || "") && typeof receipt.toolName === "string"
    && receipt.toolName.length <= 128 && typeof receipt.at === "string"
    && Number.isFinite(new Date(receipt.at).getTime())
    && (receipt.family === null || typeof receipt.family === "string"));
}

function normalizeState(value, laneDigest) {
  const pendingWriteIntents = value?.pendingWriteIntents ?? [];
  const legacyIntegrity = value?.pendingWriteIntents === undefined
    && value?.integrityDigest === sha256(JSON.stringify(legacyStateMaterial(value)));
  if (!(value && value.schema === DELIVERY_VERIFICATION_SCHEMA && value.laneDigest === laneDigest
    && Number.isInteger(value.revision) && value.revision >= 0
    && validReceipt(value.lastWrite) && validReceipt(value.lastTest)
    && (value.verifiedWriteDigest === null || DIGEST_RE.test(value.verifiedWriteDigest))
    && (value.pauseEventDigest === null || DIGEST_RE.test(value.pauseEventDigest))
    && (value.conflict === null || DIGEST_RE.test(value.conflict))
    && Array.isArray(pendingWriteIntents) && pendingWriteIntents.length <= MAX_PENDING_WRITE_INTENTS
    && pendingWriteIntents.every((item) => validReceipt(item) && DIGEST_RE.test(item.idDigest || "")
      && DIGEST_RE.test(item.intentDigest || ""))
    && Array.isArray(value.recentEvents) && value.recentEvents.length <= MAX_RECENT_EVENTS
    && value.recentEvents.every((item) => DIGEST_RE.test(item?.idDigest || "")
      && DIGEST_RE.test(item?.eventDigest || "")
      && (item.intentDigest === undefined || item.intentDigest === null || DIGEST_RE.test(item.intentDigest)))
    && value.authority === "verification-state-only"
    && DIGEST_RE.test(value.integrityDigest || "")
    && (value.integrityDigest === sha256(JSON.stringify(stateMaterial(value))) || legacyIntegrity))) {
    throw new Error("delivery verification state failed integrity validation");
  }
  return value.pendingWriteIntents === undefined ? seal({ ...value, pendingWriteIntents }) : value;
}

function timestamp(value) {
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function scopeValue(scope, name) {
  const value = scope?.[name];
  return typeof value === "string" && value ? value : "";
}

function exactGatewayAttempt(scope) {
  const value = scope?.gatewayAttempt;
  return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
}

function laneMaterial({ host, sessionId, scope }) {
  const taskBound = scopeValue(scope, "entityId") && scopeValue(scope, "projectId")
    && scopeValue(scope, "currentTaskId");
  if (taskBound) {
    const queueId = scopeValue(scope, "queueId");
    const gatewayAttempt = exactGatewayAttempt(scope);
    if (queueId && gatewayAttempt) {
      return ["delivery", host || "unknown", scopeValue(scope, "entityId"),
        scopeValue(scope, "tenantId"), scopeValue(scope, "groupId"), scopeValue(scope, "projectId"),
        scopeValue(scope, "currentTaskId"), queueId, gatewayAttempt, scopeValue(scope, "goalId"),
        scopeValue(scope, "goalStepId"), scopeValue(scope, "planDefinitionsDigest")].join("\0");
    }
    const values = ["task", host || "unknown", scopeValue(scope, "entityId"),
      scopeValue(scope, "projectId"), scopeValue(scope, "currentTaskId")];
    if (typeof sessionId === "string" && sessionId) values.push(sessionId);
    return values.join("\0");
  }
  return typeof sessionId === "string" && sessionId ? ["session", host || "unknown", sessionId].join("\0") : null;
}

export function deliveryActorSession(input) {
  const hostSession = input?.session_id ?? input?.sessionId;
  if (typeof hostSession !== "string" || !ID_RE.test(hostSession)) return null;
  const turn = input?.turn_id ?? input?.turnId;
  if (turn !== null && turn !== undefined && turn !== ""
    && (typeof turn !== "string" || !ID_RE.test(turn))) throw new Error("turnId is invalid");
  return hostSession;
}

function eventIdentity(input, actions, success) {
  const supplied = input.tool_use_id ?? input.event_id ?? input.hook_event_id;
  const idDigest = sha256(typeof supplied === "string" && supplied
    ? supplied : JSON.stringify([input.timestamp || null, input.tool_name || null, input.tool_input || input.tool_args || null]));
  return {
    idDigest,
    eventDigest: sha256(JSON.stringify([idDigest, input.tool_name || null, actions, Boolean(success)]))
  };
}

function stableToolIdentity(input, actions) {
  const idDigest = deliveryWriteIdDigest(input);
  return {
    idDigest,
    intentDigest: sha256(JSON.stringify([
      idDigest, input.tool_name || null, actions, input.tool_input ?? input.tool_args ?? null
    ]))
  };
}

function resultValues(input) {
  return [input?.tool_result, input?.tool_response, input?.result].filter((value) => value !== undefined);
}

function markerOutputTexts(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(markerOutputTexts);
  if (!value || typeof value !== "object") return [];
  return ["stdout", "output", "text", "content", "stderr"].flatMap((key) => markerOutputTexts(value[key]));
}

function hasBoundSuccessMarker(input) {
  const command = commandFromInput(input);
  const parts = command.split(/\s*&&\s*/);
  if (parts.length < 2 || !isSuccessMarkerClause(parts.at(-1))) return false;
  const output = resultValues(input).flatMap(markerOutputTexts).join("\n").trimEnd();
  return output.split(/\r?\n/).at(-1)?.trim() === "AGENTSPINE_TEST_OK";
}

export function deliverySuccessEvidence(input) {
  if (input?.success === false || input?.is_error === true || input?.tool_error) return false;
  if (resultValues(input).some((value) => value && typeof value === "object"
    && (value.isError === true || value.exit_code > 0 || value.exitCode > 0))) return false;
  if (input?.success === true || input?.is_error === false) return true;
  return resultValues(input).some((value) => value && typeof value === "object"
    && (value.isError === false || value.exit_code === 0 || value.exitCode === 0))
    || hasBoundSuccessMarker(input);
}

async function statePaths(root, laneDigest) {
  const directory = join(await projectStateDir(await canonicalPath(root)), "delivery-verification");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${laneDigest}.json`);
  return { path, lockPath: `${path}.lock` };
}

async function readState(path, laneDigest) {
  try {
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("delivery verification state exceeds 64 KiB");
    return normalizeState(JSON.parse(content), laneDigest);
  } catch (error) {
    if (error.code === "ENOENT") return emptyState(laneDigest);
    if (error instanceof SyntaxError) throw new Error("delivery verification state is not valid JSON");
    throw error;
  }
}

async function saveState(path, state, assertOwned) {
  seal(state);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("delivery verification state exceeds 64 KiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await assertOwned();
    await replaceFileWithRetry(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function receipt(input, eventDigest, family = null) {
  return {
    eventDigest,
    toolName: String(input.tool_name || "unknown").slice(0, 128),
    family,
    at: timestamp(input.timestamp)
  };
}

function pendingIntentReceipt(input, identity) {
  return {
    ...receipt(input, identity.intentDigest),
    idDigest: identity.idDigest,
    intentDigest: identity.intentDigest
  };
}

function unresolvedIntentReason(state) {
  const tools = [...new Set(state.pendingWriteIntents.map((item) => item.toolName))].sort();
  return `AgentSpine cannot accept this delivery: ${state.pendingWriteIntents.length} write intent(s) `
    + `(${tools.join(", ")}) have no auditable PostToolUse result. Run a successful test after the intended mutation. `
    + `If the hook supplies no success field, append && node -e \"console.log('AGENTSPINE_TEST_OK')\"; `
    + `the marker must be the final output line.`;
}

export async function recordDeliveryWriteIntent({ root, host, sessionId, scope, input }) {
  const material = laneMaterial({ host, sessionId, scope });
  const actions = deliveryToolActions(input);
  if (!material || !actions.some((item) => item.kind === "write")) {
    return { status: "not-applicable", blocked: false };
  }
  const identity = stableToolIdentity(input, actions);
  const laneDigest = sha256(material);
  const paths = await statePaths(root, laneDigest);
  try {
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, laneDigest);
      const resolved = state.recentEvents.find((item) => item.idDigest === identity.idDigest);
      if (resolved) {
        if (resolved.intentDigest && resolved.intentDigest !== identity.intentDigest) {
          state.conflict = identity.idDigest;
          state.revision += 1;
          await saveState(paths.path, state, assertOwned);
          return { status: "conflict", blocked: true,
            reason: "AgentSpine write tool_use_id was reused with a different mutation." };
        }
        return { status: "already-resolved", blocked: false };
      }
      const pending = state.pendingWriteIntents.find((item) => item.idDigest === identity.idDigest);
      if (pending) {
        if (pending.intentDigest !== identity.intentDigest) {
          state.conflict = identity.idDigest;
          state.revision += 1;
          await saveState(paths.path, state, assertOwned);
          return { status: "conflict", blocked: true,
            reason: "AgentSpine write tool_use_id was reused with a different mutation." };
        }
        return { status: "duplicate-intent", blocked: false };
      }
      if (state.pendingWriteIntents.length >= MAX_PENDING_WRITE_INTENTS) {
        state.conflict = sha256(`pending-write-intent-overflow\0${laneDigest}`);
        state.revision += 1;
        await saveState(paths.path, state, assertOwned);
        return { status: "conflict", blocked: true,
          reason: `AgentSpine cannot track more than ${MAX_PENDING_WRITE_INTENTS} concurrent write intents.` };
      }
      state.pendingWriteIntents.push(pendingIntentReceipt(input, identity));
      // A resumed mutation makes a prior paused Stop event stale. Keep the
      // invalidation in the same locked state transition as the intent so an
      // identical later completion event cannot bypass the pending-test gate.
      state.pauseEventDigest = null;
      state.revision += 1;
      await saveState(paths.path, state, assertOwned);
      return { status: "intent-recorded", blocked: false, pending: true };
    });
  } catch (error) {
    return { status: "degraded", blocked: false, reason: error.message };
  }
}

export async function recordDeliveryToolUse({ root, host, sessionId, scope, input, success }) {
  const material = laneMaterial({ host, sessionId, scope });
  const actions = deliveryToolActions(input);
  if (!material || !actions.length) return { status: "not-applicable", blocked: false };
  const laneDigest = sha256(material);
  const paths = await statePaths(root, laneDigest);
  try {
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, laneDigest);
      const identity = eventIdentity(input, actions, success);
      const stableIdentity = stableToolIdentity(input, actions);
      const known = state.recentEvents.find((item) => item.idDigest === identity.idDigest);
      if (known) {
        if (known.eventDigest !== identity.eventDigest) {
          state.conflict = identity.idDigest;
          state.revision += 1;
          await saveState(paths.path, state, assertOwned);
          return { status: "conflict", blocked: false };
        }
        return { status: "duplicate", blocked: false };
      }
      const writes = actions.some((item) => item.kind === "write");
      if (writes) {
        const pending = state.pendingWriteIntents.find((item) => item.idDigest === stableIdentity.idDigest);
        if (pending && pending.intentDigest !== stableIdentity.intentDigest) {
          state.conflict = stableIdentity.idDigest;
          state.revision += 1;
          await saveState(paths.path, state, assertOwned);
          return { status: "conflict", blocked: false };
        }
        state.pendingWriteIntents = state.pendingWriteIntents
          .filter((item) => item.idDigest !== stableIdentity.idDigest);
      }
      for (const action of actions) {
        if (action.kind === "write") {
          state.lastWrite = receipt(input, identity.eventDigest);
          state.pauseEventDigest = null;
        } else if (success) {
          if (state.pendingWriteIntents.length) {
            const intendedWrite = state.pendingWriteIntents.at(-1);
            state.lastWrite = {
              eventDigest: intendedWrite.intentDigest, toolName: intendedWrite.toolName,
              family: null, at: intendedWrite.at
            };
            state.pendingWriteIntents = [];
            state.pauseEventDigest = null;
          }
          state.lastTest = receipt(input, identity.eventDigest, action.family);
          state.verifiedWriteDigest = state.lastWrite?.eventDigest || null;
        }
      }
      state.recentEvents.push({ ...identity, intentDigest: stableIdentity.intentDigest });
      state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
      state.revision += 1;
      await saveState(paths.path, state, assertOwned);
      return {
        status: actions.some((item) => item.kind === "write") ? "write-recorded" : success ? "test-recorded" : "test-failed",
        blocked: false,
        ...(!writes && !success ? { reason: TEST_PROOF_GUIDANCE } : {}),
        pending: Boolean(state.lastWrite && state.verifiedWriteDigest !== state.lastWrite.eventDigest)
      };
    });
  } catch (error) {
    return { status: "degraded", blocked: false, reason: error.message };
  }
}

export async function recordDeliveryPause({ root, host, sessionId, scope, eventId }) {
  const material = laneMaterial({ host, sessionId, scope });
  if (!material) {
    return { status: "paused-job", blocked: false };
  }
  const laneDigest = sha256(material);
  const paths = await statePaths(root, laneDigest);
  try {
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, laneDigest);
      if (state.pendingWriteIntents.length) {
        return { status: "blocked", blocked: true, reason: unresolvedIntentReason(state) };
      }
      // A pause may deduplicate only this exact Stop event. A session identity is
      // deliberately insufficient because it could bypass a later completion.
      const pauseEventDigest = typeof eventId === "string" && eventId ? sha256(`event\0${eventId}`) : null;
      if (state.pauseEventDigest !== pauseEventDigest) {
        state.pauseEventDigest = pauseEventDigest;
        state.revision += 1;
        await saveState(paths.path, state, assertOwned);
      }
      return { status: "paused-job", blocked: false };
    });
  } catch (error) {
    return { status: "degraded-pause", blocked: false, reason: error.message };
  }
}

export async function verifyDeliveryStop({ root, host, sessionId, scope, eventId = null }) {
  const material = laneMaterial({ host, sessionId, scope });
  if (!material) return { status: "not-applicable", blocked: false };
  const laneDigest = sha256(material);
  const paths = await statePaths(root, laneDigest);
  try {
    return await withOwnedFileLock(paths.lockPath, async () => {
      const state = await readState(paths.path, laneDigest);
      const pauseEventDigest = typeof eventId === "string" && eventId ? sha256(`event\0${eventId}`) : null;
      if (state.conflict) {
        return { status: "blocked", blocked: true,
          reason: "AgentSpine cannot verify tool history because one tool delivery ID had conflicting results." };
      }
      if (state.pendingWriteIntents.length) {
        return { status: "blocked", blocked: true, reason: unresolvedIntentReason(state) };
      }
      if (pauseEventDigest && state.pauseEventDigest === pauseEventDigest) {
        return { status: "paused-job", blocked: false, stateDigest: state.integrityDigest };
      }
      if (state.lastWrite && state.verifiedWriteDigest !== state.lastWrite.eventDigest) {
        return { status: "blocked", blocked: true,
          reason: "AgentSpine cannot accept this delivery: run a successful test after the latest write "
            + `(node --test, npm test, npm run check, or pytest). ${TEST_PROOF_GUIDANCE}` };
      }
      return { status: state.lastWrite ? "verified" : "no-write", blocked: false,
        testFamily: state.lastTest?.family || null, stateDigest: state.integrityDigest };
    });
  } catch (error) {
    return { status: "blocked", blocked: true,
      reason: `AgentSpine cannot verify post-write tests: ${String(error.message).slice(0, 400)}` };
  }
}

export async function deliveryVerificationPath({ root, host, sessionId, scope }) {
  const material = laneMaterial({ host, sessionId, scope });
  if (!material) return null;
  return (await statePaths(root, sha256(material))).path;
}
