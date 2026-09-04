import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { canonicalPath, projectStateDir } from "./paths.js";
import { finalizePremortemScope,
  registerPremortemLaneIndex, removePremortemLaneIndex } from "./delivery-premortem-index.js";
import { writePremortemFile } from "./delivery-premortem-file.js";
import { appendPremortemWrite, appendPremortemWriteIndex, findPremortemWrite, readPremortemWriteIndex,
  validPremortemWriteLedger, verifyPremortemWriteIndex } from "./delivery-premortem-write-ledger.js";
import { closedPremortemResult as closedResult, degradedPremortem as degraded,
  premortemBlock as block, premortemBoundary as boundary } from "./delivery-premortem-results.js";
import { normalizePremortemBinding as normalizeBinding, premortemGoalBindingSummary as goalBindingSummary,
  formatPremortemRequirementId as requirementId, parsePremortemRequirementId,
  premortemLaneDigest as laneDigest,
  premortemWriteIdentity, validPremortemStateBinding as validStateBinding } from "./delivery-premortem-binding.js";
import { createPremortemArtifact, createPremortemAttachment, createPremortemClosure,
  reviewPremortemClosure, validPremortemArtifact, validPremortemClosure } from "./delivery-premortem-closure.js";
import { inspectActiveDeliveryPremortems,
  verifyEmptyPremortemGoalScope } from "./delivery-premortem-inspection.js";
import { premortemGoalWriterScopeCheck } from "./delivery-premortem-session-guard.js";
import { recordPremortemRegistrationRejection } from "./delivery-premortem-rejection.js";
import { removePremortemStateFile,
  resolvePremortemGoalScope } from "./delivery-premortem-recovery.js";
import { canonicalPremortem as canonical, premortemSha256 as sha256, premortemTime as at,
  premortemMismatchError as mismatchError, sealPremortem as sealed, validPremortemSeal as validSeal,
  validPremortemTime as validTime } from "./delivery-premortem-codec.js";
export const DELIVERY_PREMORTEM_SCHEMA = "agentspine.delivery-premortem/v1";
const REQUIREMENT_SCHEMA = "agentspine.delivery-premortem-requirement/v1";
const EVENT_SCHEMA = "agentspine.delivery-premortem-event/v1";
const AUTHORITY = "context-only";
const MAX_BYTES = 64 * 1024;
const MAX_EVENTS = 48;
const MAX_FILES = 256;
const DIGEST_RE = /^[a-f0-9]{64}$/;
export const PREMORTEM_REQUIREMENT_TEXT = [
  "Before the first Write/Edit/apply_patch or recognized common shell-mediated mutation, register exactly three premortem items.",
  "Use categories baseline-environment, contract-tests, and delivery-path exactly once.",
  "Each failure must start `this delivery fails because ` and include one concrete check.",
  "Registration returns the immutable checkId used for closure.",
  "Premortem content is context only and grants no permissions or tool access.",
  "Close a written delivery with `Premortem closure sha256 <64hex>` and one line per category:",
  "Bind it with `Premortem latest write sha256 <64hex>` from the latest write receipt.",
  "- <category> <checkId>: PASS — <nonempty result>"
].join("\n");
function requirementFor(binding, digest, now) {
  const generationDigest = sha256({ laneDigest: digest, nonce: randomUUID() });
  return sealed({ schema: REQUIREMENT_SCHEMA,
    requirementId: requirementId(digest, generationDigest), laneDigest: digest,
    generationDigest, binding, createdAt: at(now), authority: AUTHORITY });
}
function stateMaterial(state) {
  const material = { ...state };
  delete material.integrityDigest;
  return material;
}
function sealState(state) {
  state.integrityDigest = sha256(stateMaterial(state));
  return state;
}
function emptyState(binding, digest) {
  return sealState({ schema: DELIVERY_PREMORTEM_SCHEMA, laneDigest: digest, binding, revision: 0,
    requirement: null, artifact: null, firstWrite: null, lastWrite: null, late: false, conflict: null,
    closure: null, writeIndexRoot: null, writeLedger: [], events: [], authority: AUTHORITY,
    integrityDigest: null });
}
function validRequirement(value, state) {
  let parsed = null;
  try { parsed = parsePremortemRequirementId(value?.requirementId); } catch {}
  return value && value.schema === REQUIREMENT_SCHEMA && value.authority === AUTHORITY
    && value.laneDigest === state.laneDigest && parsed?.laneDigest === state.laneDigest
    && parsed?.generationDigest === value.generationDigest
    && DIGEST_RE.test(value.generationDigest || "")
    && canonical(value.binding) === canonical(state.binding)
    && validTime(value.createdAt) && validSeal(value);
}
function validWrite(value, state) {
  return value && value.schema === "agentspine.delivery-premortem-write/v1" && value.authority === AUTHORITY
    && value.laneDigest === state.laneDigest && value.requirementId === state.requirement?.requirementId
    && new Set(["intent", "post"]).has(value.phase)
    && DIGEST_RE.test(value.idDigest || "") && DIGEST_RE.test(value.inputDigest || "")
    && (value.inputKnown === undefined || typeof value.inputKnown === "boolean")
    && validTime(value.recordedAt) && validSeal(value);
}
function validEvents(events, revision) {
  const types = new Set(["requirement-prepared", "artifact-recorded", "artifact-recorded-late",
    "artifact-conflict", "write-recorded", "write-conflict", "closure-invalidated",
    "premortem-closed", "premortem-consumed"]);
  return events.every((event, index) => event.schema === EVENT_SCHEMA && event.authority === AUTHORITY
    && types.has(event.type) && validTime(event.at) && Number.isInteger(event.sequence)
    && event.sequence > 0 && event.sequence <= revision && (!index || event.sequence > events[index - 1].sequence)
    && DIGEST_RE.test(event.payloadDigest || "")
    && (event.type !== "write-recorded" || event.writeIdDigest === undefined
      || (DIGEST_RE.test(event.writeIdDigest) && DIGEST_RE.test(event.inputDigest)
        && typeof event.inputKnown === "boolean" && DIGEST_RE.test(event.writeDigest)))
    && validSeal(event));
}
function validateState(state, expectedDigest) {
  if (!state || state.schema !== DELIVERY_PREMORTEM_SCHEMA || state.laneDigest !== expectedDigest
    || !validStateBinding(state, expectedDigest) || state.authority !== AUTHORITY
    || !Number.isInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.events) || state.events.length > MAX_EVENTS
    || !validEvents(state.events, state.revision)
    || (state.requirement !== null && !validRequirement(state.requirement, state))
    || (state.artifact !== null && !validPremortemArtifact(state.artifact, state))
    || Boolean(state.artifact) > Boolean(state.requirement) || typeof state.late !== "boolean"
    || (state.firstWrite !== null && !validWrite(state.firstWrite, state))
    || (state.lastWrite !== null && !validWrite(state.lastWrite, state))
    || Boolean(state.firstWrite) !== Boolean(state.lastWrite)
    || (state.firstWrite ? !DIGEST_RE.test(state.writeIndexRoot || "") : state.writeIndexRoot !== null)
    || !validPremortemWriteLedger(state.writeLedger, state.firstWrite, state.lastWrite)
    || (state.closure !== null && !validPremortemClosure(state.closure, state))
    || (state.conflict !== null && !DIGEST_RE.test(state.conflict || ""))
    || !DIGEST_RE.test(state.integrityDigest || "")
    || state.integrityDigest !== sha256(stateMaterial(state))) {
    throw mismatchError("delivery premortem state failed integrity validation");
  }
  return state;
}
async function directoryFor(root) {
  const directory = join(await projectStateDir(await canonicalPath(root)), "delivery-premortem");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
async function pathsFor(root, digest) {
  const directory = await directoryFor(root);
  const path = join(directory, `${digest}.json`);
  return { directory, path, lockPath: `${path}.lock` };
}
async function readState(path, digest) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw mismatchError("delivery premortem state exceeds 64 KiB");
    return validateState(JSON.parse(text), digest);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("delivery premortem state is not valid JSON");
    throw error;
  }
}
async function saveState(path, state, assertOwned, scopeCheck = null) {
  sealState(state);
  await registerPremortemLaneIndex({ statePath: path, state, scopeCheck,
    commit: ({ assertOwned: assertScopeOwned } = {}) =>
      writePremortemFile(path, state, async () => {
        await assertOwned();
        await assertScopeOwned?.();
      }, MAX_BYTES) });
}
function appendEvent(state, type, payload, now, details = {}) {
  const event = sealed({ ...details, schema: EVENT_SCHEMA, type, at: at(now), sequence: state.revision + 1,
    payloadDigest: sha256(payload), authority: AUTHORITY });
  state.events.push(event);
  state.events = state.events.slice(-MAX_EVENTS);
  state.revision += 1;
  return event;
}
const parseRequirement = (id) => parsePremortemRequirementId(id).laneDigest;
export async function inspectPremortemState({ root, binding: rawBinding = null,
  requirementId: id = null }) {
  try {
    if (Boolean(rawBinding) === Boolean(id)) throw new Error("inspect premortem requires one exact selector");
    const binding = rawBinding ? normalizeBinding(rawBinding) : null;
    const digest = binding ? laneDigest(binding) : parseRequirement(id);
    const state = await readState((await pathsFor(root, digest)).path, digest);
    if (!state) return { status: "absent", blocked: false, laneDigest: digest,
      requirementId: id };
    if (id && state.requirement?.requirementId !== id) {
      return block("stale", `AgentSpine cannot find current premortem requirement ${id}.`,
        { requirementId: id });
    }
    return { status: state.firstWrite ? "written" : "read-only", blocked: false,
      laneDigest: digest, requirementId: state.requirement?.requirementId || null,
      requirement: structuredClone(state.requirement),
      binding: structuredClone(state.binding), hasWrite: Boolean(state.firstWrite),
      closed: Boolean(state.closure),
      consumed: state.events.some((event) => event.type === "premortem-consumed"),
      conflicted: Boolean(state.conflict), artifactDigest: state.artifact?.digest || null };
  } catch (error) {
    return boundary(error);
  }
}
export function premortemRequirementText(requirement) {
  const id = typeof requirement === "string" ? requirement : requirement?.requirementId;
  return `${PREMORTEM_REQUIREMENT_TEXT}\nRequirement: ${id || "<unavailable; retry registration>"}`;
}
export async function preparePremortemRequirement({ root, binding: rawBinding, now = new Date() }) {
  try {
    const binding = normalizeBinding(rawBinding);
    const digest = laneDigest(binding);
    const paths = await pathsFor(root, digest);
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, digest) || emptyState(binding, digest);
      if (!state.requirement) {
        state.requirement = requirementFor(binding, digest, now);
        appendEvent(state, "requirement-prepared", { requirementId: state.requirement.requirementId }, now);
        await saveState(paths.path, state, assertOwned);
      }
      return { status: "required", blocked: false, requirementId: state.requirement.requirementId,
        requirement: structuredClone(state.requirement), laneDigest: digest, path: paths.path };
    });
  } catch (error) {
    return boundary(error);
  }
}
export async function recordDeliveryPremortem({ root, requirementId: id, items, now = new Date() }) {
  try {
    const digest = parseRequirement(id);
    const paths = await pathsFor(root, digest);
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, digest);
      if (!state?.requirement || state.requirement.requirementId !== id) {
        return block("stale", `AgentSpine cannot find current premortem requirement ${id}.`, { requirementId: id });
      }
      const proposed = createPremortemArtifact({ requirement: state.requirement,
        items, recordedAt: at(now) });
      if (state.conflict) return block("conflict", `AgentSpine premortem ${id} has conflicting registrations.`,
        { requirementId: id, digest: state.artifact?.digest || null });
      if (state.artifact) {
        if (canonical(state.artifact.items) !== canonical(proposed.items)) {
          const rejection = await recordPremortemRegistrationRejection({ root, state, proposed, now });
          return block("conflict", `AgentSpine premortem ${id} conflicts with its first registration.`,
            { requirementId: id, digest: state.artifact.digest, rejection });
        }
        return { status: state.late ? "late" : "duplicate", blocked: state.late,
          reason: state.late ? `AgentSpine premortem ${id} was recorded after the first write.` : undefined,
          requirementId: id, artifact: structuredClone(state.artifact), digest: state.artifact.digest };
      }
      state.artifact = proposed;
      state.late = Boolean(state.firstWrite);
      appendEvent(state, state.late ? "artifact-recorded-late" : "artifact-recorded",
        { artifactDigest: proposed.digest }, now);
      await saveState(paths.path, state, assertOwned);
      if (state.late) return block("late", `AgentSpine premortem ${id} was recorded after the first write.`,
        { requirementId: id, artifact: structuredClone(proposed), digest: proposed.digest });
      return { status: "recorded", blocked: false, requirementId: id,
        artifact: structuredClone(proposed), digest: proposed.digest };
    });
  } catch (error) {
    if (error.code === "AGENTSPINE_PREMORTEM_SECRET") {
      return block("unsafe", error.message, { requirementId: id });
    }
    return boundary(error);
  }
}
function premortemProblem(state, id) {
  if (!state?.requirement || !state.artifact) {
    return block("missing", `AgentSpine is missing premortem ${id} before the first write.`, { requirementId: id });
  }
  if (state.conflict) return block("conflict", `AgentSpine premortem ${id} has conflicting registrations.`, { requirementId: id });
  if (state.late) return block("late", `AgentSpine premortem ${id} was recorded after the first write.`, { requirementId: id });
  if (state.events.some((event) => event.type === "premortem-consumed")) {
    return block("finalized", `AgentSpine premortem ${id} was already consumed.`, { requirementId: id });
  }
  return null;
}
export async function verifyPremortemBeforeWrite({ root, binding: rawBinding }) {
  try {
    const binding = normalizeBinding(rawBinding);
    const digest = laneDigest(binding);
    const state = await readState((await pathsFor(root, digest)).path, digest);
    const problem = premortemProblem(state, state?.requirement?.requirementId || requirementId(digest));
    return problem || { status: "verified", blocked: false, requirementId: state.requirement.requirementId,
      artifact: structuredClone(state.artifact), digest: state.artifact.digest };
  } catch (error) {
    return boundary(error);
  }
}
export async function recordPremortemWrite({ root, binding: rawBinding, input, phase = "post", now = new Date() }) {
  try {
    if (!new Set(["intent", "post"]).has(phase)) throw new Error("premortem write phase is invalid");
    const binding = normalizeBinding(rawBinding);
    const digest = laneDigest(binding);
    const paths = await pathsFor(root, digest);
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, digest) || emptyState(binding, digest);
      if (state.events.some((event) => event.type === "premortem-consumed")) {
        return block("finalized", "The goal-step premortem was already consumed; later writes are blocked.");
      }
      const write = premortemWriteIdentity(input, phase);
      if (phase === "intent") {
        const problem = premortemProblem(state,
          state.requirement?.requirementId || requirementId(digest));
        if (problem) return problem;
      }
      if (!state.requirement) {
        state.requirement = requirementFor(binding, digest, now);
        appendEvent(state, "requirement-prepared", { requirementId: state.requirement.requirementId }, now);
      }
      const recentWrite = findPremortemWrite(state.writeLedger, write.idDigest);
      const storedWrite = await readPremortemWriteIndex({ statePath: paths.path,
        laneDigest: digest, rootDigest: state.writeIndexRoot, idDigest: write.idDigest });
      if (storedWrite && recentWrite && ["inputDigest", "inputKnown", "writeDigest"]
        .some((key) => storedWrite[key] !== recentWrite[key])) {
        throw mismatchError("premortem write receipt conflicts with recent state");
      }
      if (recentWrite && !storedWrite) throw mismatchError("premortem write index lost a recent write");
      const priorWrite = storedWrite || recentWrite;
      if (priorWrite && write.inputKnown && (priorWrite.inputKnown === false
        || priorWrite.inputDigest !== write.inputDigest)) {
        state.conflict = sha256({ writeIdDigest: write.idDigest,
          priorInputDigest: priorWrite.inputDigest, inputDigest: write.inputDigest });
        appendEvent(state, "write-conflict", { conflict: state.conflict }, now);
        await saveState(paths.path, state, assertOwned);
        return block("conflict", "A repeated write receipt has different tool input.");
      }
      if (priorWrite) {
        return { status: "duplicate", blocked: false, writeDigest: priorWrite.writeDigest };
      }
      const boundWrite = sealed({ ...write, laneDigest: digest,
        requirementId: state.requirement.requirementId, recordedAt: at(now) });
      state.writeIndexRoot = (await appendPremortemWriteIndex({ statePath: paths.path,
        laneDigest: digest, rootDigest: state.writeIndexRoot, write: boundWrite, assertOwned })).rootDigest;
      appendPremortemWrite(state.writeLedger, boundWrite);
      if (!state.firstWrite) state.firstWrite = boundWrite;
      state.lastWrite = boundWrite;
      appendEvent(state, "write-recorded", { writeIdDigest: write.idDigest,
        inputDigest: write.inputDigest }, now, { writeIdDigest: write.idDigest,
        inputDigest: write.inputDigest, inputKnown: write.inputKnown, writeDigest: boundWrite.digest });
      if (state.closure) {
        appendEvent(state, "closure-invalidated", { closureDigest: state.closure.digest,
          lastWriteDigest: boundWrite.digest }, now);
        state.closure = null;
      }
      await saveState(paths.path, state, assertOwned, premortemGoalWriterScopeCheck({
        stateDirectory: paths.directory, binding, laneDigest: digest, readState }));
      return { status: "write-recorded", blocked: false, writeDigest: boundWrite.digest,
        premortemDigest: state.artifact?.digest || null };
    });
  } catch (error) {
    return boundary(error);
  }
}
export async function recordPremortemWriteIntent(input) {
  const result = await recordPremortemWrite({ ...input, phase: "intent" });
  return result.status === "write-recorded" ? { ...result, status: "write-intent-recorded" } : result;
}
export async function verifyPremortemStop({ root, binding: rawBinding, message, now = new Date() }) {
  try {
    const binding = normalizeBinding(rawBinding);
    const digest = laneDigest(binding);
    const paths = await pathsFor(root, digest);
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, digest);
      if (!state) return { status: "no-write", blocked: false };
      if (!state.firstWrite) {
        const status = state.binding.goalId ? "read-only" : "no-write";
        const removed = await removePremortemLaneIndex({ statePath: paths.path, state,
          commit: ({ assertOwned: assertIndexOwned }) =>
            removePremortemStateFile(paths.path, assertOwned, assertIndexOwned) });
        if (removed.status === "degraded") return { ...removed, blocked: false };
        if (removed.blocked) return removed;
        return { status, blocked: false };
      }
      const id = state.requirement?.requirementId || requirementId(digest);
      const problem = premortemProblem(state, id);
      if (problem) return problem;
      await verifyPremortemWriteIndex({ statePath: paths.path, state });
      const reviewed = reviewPremortemClosure(message, state.artifact, state.lastWrite.digest);
      if (reviewed.missing.length) return block("unchecked",
        `AgentSpine premortem closure is incomplete: ${reviewed.missing.join(", ")}.`,
        { requirementId: id, unchecked: reviewed.missing });
      const proposed = createPremortemClosure({ requirementId: id,
        artifactDigest: state.artifact.digest, lastWriteDigest: state.lastWrite.digest,
        checks: reviewed.checks, closedAt: at(now) });
      if (state.closure && canonical(state.closure.checks) !== canonical(proposed.checks)) {
        return block("conflict", `AgentSpine premortem ${id} has conflicting closure results.`, { requirementId: id });
      }
      if (!state.closure) {
        state.closure = proposed;
        appendEvent(state, "premortem-closed", { closureDigest: proposed.digest }, now);
        await saveState(paths.path, state, assertOwned);
      }
      return closedResult(state, id);
    });
  } catch (error) {
    return boundary(error);
  }
}
export async function inspectDeliveryPremortems(root) {
  try {
    return inspectActiveDeliveryPremortems({ stateDirectory: await directoryFor(root),
      readState, maxFiles: MAX_FILES });
  } catch (error) {
    return { states: [], paths: [], errors: [{ path: String(root),
      reason: String(error.message).slice(0, 400) }], truncations: [], directory: null };
  }
}
async function removeReadOnlyGoalLane(root, state) {
  const paths = await pathsFor(root, state.laneDigest);
  return withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
    const current = await readState(paths.path, state.laneDigest);
    if (!current || current.firstWrite) return { removed: !current, state: current };
    const removed = await removePremortemLaneIndex({ statePath: paths.path, state: current,
      commit: ({ assertOwned: assertIndexOwned }) =>
        removePremortemStateFile(paths.path, assertOwned, assertIndexOwned) });
    if (removed.status === "degraded") throw new Error(removed.reason);
    if (removed.blocked) throw mismatchError(removed.reason);
    return { removed: true, state: null };
  });
}
export async function closedPremortemForGoal({ root, goalId, goalStepId, queueId = null,
  gatewayAttempt = null }) {
  try {
    if (gatewayAttempt !== null && (!Number.isInteger(gatewayAttempt) || gatewayAttempt < 1)) {
      throw new Error("premortem gatewayAttempt must be a positive integer");
    }
    const stateDirectory = await directoryFor(root);
    const indexed = await resolvePremortemGoalScope({ stateDirectory,
      expected: { goalId, goalStepId, queueId, gatewayAttempt }, readState,
      inspectStates: () => inspectDeliveryPremortems(root, { includeHistory: false }),
      removeReadOnlyState: (state) => removeReadOnlyGoalLane(root, state) });
    if (indexed.blocked) return { ...indexed, attachment: null };
    if (indexed.status === "degraded") return { ...indexed, blocked: false, attachment: null };
    if (indexed.status === "finalized" && indexed.finalization?.status === "read-only") return {
      status: "read-only-finalized", blocked: false, attachment: null,
      finalization: structuredClone(indexed.finalization) };
    if (indexed.status === "unavailable") return { ...indexed, blocked: false, attachment: null };
    const states = indexed.states;
    const invalid = states.find((state) => state.conflict || state.late);
    if (invalid) return block(invalid.conflict ? "conflict" : "late",
      "The exact goal-step premortem is conflicted or late.", { attachment: null });
    const written = states.filter((state) => state.firstWrite);
    for (const state of states.filter((entry) => !entry.firstWrite)) {
      const cleaned = await removeReadOnlyGoalLane(root, state);
      if (cleaned.state?.firstWrite) written.push(cleaned.state);
    }
    if (!written.length) return { status: "read-only", blocked: false, attachment: null,
      bindings: states.map((state) => goalBindingSummary(state)) };
    if (written.length > 1) return block("conflict", "Multiple premortems use the same goal-step attempt.", { attachment: null });
    const open = written.filter((state) => !state.closure);
    if (open.length) return block("missing", "A written goal-step premortem has no valid closure.", { attachment: null });
    const target = written[0];
    const paths = await pathsFor(root, target.laneDigest);
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const current = await readState(paths.path, target.laneDigest);
      const problem = premortemProblem(current,
        current?.requirement?.requirementId || requirementId(target.laneDigest));
      if ((problem && problem.status !== "finalized") || !current.firstWrite || !current.closure) return problem
        || block("mismatch", "The goal-step premortem changed before consumption.", { attachment: null });
      await verifyPremortemWriteIndex({ statePath: paths.path, state: current });
      const attachment = createPremortemAttachment(current);
      const summary = goalBindingSummary(current);
      const payload = { attachmentDigest: attachment.attachmentDigest };
      const consumed = current.events.find((event) => event.type === "premortem-consumed");
      if (consumed && consumed.payloadDigest !== sha256(payload)) {
        return block("conflict", "The goal-step premortem has conflicting consumption.", { attachment: null });
      }
      if (!consumed) {
        appendEvent(current, "premortem-consumed", payload, new Date());
        sealState(current);
      }
      const finalized = await finalizePremortemScope({ stateDirectory, goalId,
        goalStepId, queueId, gatewayAttempt, status: "closed",
        laneDigest: target.laneDigest, attachmentDigest: attachment.attachmentDigest,
        context: current.binding, bindingSummaryDigests: [summary.digest],
        commit: consumed ? null : ({ assertOwned: assertScopeOwned }) =>
          writePremortemFile(paths.path, current, async () => {
            await assertOwned();
            await assertScopeOwned();
          }, MAX_BYTES) });
      if (finalized.blocked || finalized.status === "degraded") {
        return { ...finalized, attachment: null };
      }
      return { status: "closed", blocked: false, attachment,
        finalization: finalized.finalization };
    });
  } catch (error) {
    return { ...boundary(error), attachment: null };
  }
}
export async function finalizeReadOnlyPremortemForGoal({ root, goalId, goalStepId,
  queueId = null, gatewayAttempt = null, dispositionDigest, context,
  bindingSummaryDigests = [] }) {
  try {
    if (!DIGEST_RE.test(dispositionDigest || "")) throw new Error("premortem disposition digest is invalid");
    const stateDirectory = await directoryFor(root);
    return await finalizePremortemScope({ stateDirectory, goalId, goalStepId,
      queueId, gatewayAttempt, status: "read-only", attachmentDigest: dispositionDigest,
      context, bindingSummaryDigests,
      verifyEmpty: () => verifyEmptyPremortemGoalScope({ stateDirectory, readState,
        maxFiles: MAX_FILES, expected: { goalId, goalStepId, queueId, gatewayAttempt } }) });
  } catch (error) {
    return boundary(error);
  }
}
export async function deliveryPremortemPath({ root, binding: rawBinding }) {
  try {
    const binding = normalizeBinding(rawBinding);
    return (await pathsFor(root, laneDigest(binding))).path;
  } catch {
    return null;
  }
}
