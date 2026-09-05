import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalPath } from "./paths.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import {
  privateEnrollmentPaths, readPrivateEnrollmentState, savePrivateEnrollmentState
} from "./session-timeline-enrollment-storage.js";
import {
  normalizePrivateTimelineSource, PRIVATE_TIMELINE_PREFIX_BYTES, privateTimelinePrefixDigest
} from "./session-timeline-enrollment-source.js";
import {
  hostReceiptId, hostReceiptResult, hostReceiptUnavailable, makeHostTranscriptReceipt, MAX_PENDING_RECEIPTS,
  PRIVATE_TIMELINE_HOST_RECEIPT_ORIGIN, PRIVATE_TIMELINE_HOST_RECEIPT_SCHEMA, purgeExpiredHostReceipts,
  sameHostReceiptSource, sameIssuedHostTranscriptEvent, validHostTranscriptReceipt
} from "./session-timeline-host-receipt.js";
import {
  completeTimelineBinding, hasTimelineGroupScope, sameTimelineBinding, sessionTimelineBinding,
  safeTimelineId, TIMELINE_ID_RE, validTimelineBinding
} from "./session-timeline-contract.js";
import { sameTimelineTransportDigest, timelineTransportDigest, validTimelineTransportDigest } from "./session-timeline-transport.js";
import {
  sameSessionTimelineSourceLocation, sourcePath, validSessionTimelineSourceMetadata
} from "./session-timeline-source.js";
import { validVerifiedTimelineHostOrigin } from "./session-timeline-host-origin.js";

export const PRIVATE_TIMELINE_ENROLLMENT_SCHEMA = "agentspine.session-timeline-private-enrollment/v1";
export { PRIVATE_TIMELINE_HOST_RECEIPT_ORIGIN, PRIVATE_TIMELINE_HOST_RECEIPT_SCHEMA } from "./session-timeline-host-receipt.js";
export const LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION = "local-owner-confirmed";
export const LOCAL_TIMELINE_ENROLLMENT_RECOVERY_CONFIRMATION = "local-owner-confirmed-timeline-enrollment-recovery";
export const DEFAULT_TIMELINE_ENROLLMENT_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_TIMELINE_ENROLLMENT_TTL_MS = 12 * 60 * 60 * 1000;

const AUTHORITY = "context-only";
const TIMELINE_VISIBILITY = "private-verified";
const HEAD_SCHEMA = "agentspine.session-timeline-private-enrollment-head/v1";
const HEAD_AUTHORITY = "state-integrity-only";
const MAX_STATE_BYTES = 256 * 1024;
const MAX_ENROLLMENTS = 16;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function validSignature(value) { return /^[a-f0-9]{64}$/.test(value || ""); }
function validGeneration(value) { return Number.isSafeInteger(value) && value > 0; }
function validDate(value) { return Number.isFinite(new Date(value).getTime()); }
function date(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function runtimeDate(clock) {
  try { return date(typeof clock === "function" ? clock() : new Date()); }
  catch { return null; }
}

function enrollmentTtl(value) {
  return Number.isInteger(value) && value >= 60 * 1000 && value <= MAX_TIMELINE_ENROLLMENT_TTL_MS ? value : null;
}

function unavailable(reason) {
  return {
    schema: PRIVATE_TIMELINE_ENROLLMENT_SCHEMA, status: "unavailable", reason,
    binding: null, source: null, sourceDigest: null, expiresAt: null,
    enrollmentDigest: null, timelineVisibility: null, authority: AUTHORITY
  };
}

function empty(root) {
  return {
    schema: PRIVATE_TIMELINE_ENROLLMENT_SCHEMA, rootDigest: digest(root),
    enrollments: [], pendingReceipts: [], generation: 0, previousSignature: null, authority: AUTHORITY
  };
}

function sourceMetadata(source) {
  return {
    path: source?.path, profileRoot: source?.profileRoot, projectsRoot: source?.projectsRoot,
    pathDigest: source?.pathDigest, identity: source?.identity,
    size: source?.size, mtimeNs: source?.mtimeNs, ctimeNs: source?.ctimeNs
  };
}

function validSource(source) {
  return validSessionTimelineSourceMetadata(sourceMetadata(source))
    && Number.isSafeInteger(source.prefixBytes) && source.prefixBytes >= 0 && source.prefixBytes <= PRIVATE_TIMELINE_PREFIX_BYTES
    && /^[a-f0-9]{64}$/.test(source.prefixDigest || "")
    && source.commitment === null;
}

function sourceDigest(source) {
  return digest(`${source.pathDigest}\0${source.identity}\0${source.profileRoot}\0${source.projectsRoot}\0${source.size}\0${source.mtimeNs}\0${source.ctimeNs}\0${source.prefixDigest}\0lazy-snapshot/v1`);
}

function sameSource(left, right) { return sameSessionTimelineSourceLocation(sourceMetadata(left), sourceMetadata(right)); }

function sameSourceSnapshot(left, right) {
  const first = sourceMetadata(left);
  const second = sourceMetadata(right);
  return validSessionTimelineSourceMetadata(first) && validSessionTimelineSourceMetadata(second)
    && ["path", "profileRoot", "projectsRoot", "pathDigest", "identity", "size", "mtimeNs", "ctimeNs"]
      .every((key) => first[key] === second[key]);
}

function enrollmentId(root, binding, source) {
  return `timeline-enrollment:${digest(canonical({ rootDigest: digest(root), binding, sourceDigest: sourceDigest(source) })).slice(0, 32)}`;
}

function enrollmentDigest(root, binding, source, expiresAt, transportDigest) {
  return digest(canonical({ rootDigest: digest(root), binding, sourceDigest: sourceDigest(source), expiresAt,
    transportDigest, confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, timelineVisibility: TIMELINE_VISIBILITY }));
}

function validEnrollment(value, root) {
  return value && TIMELINE_ID_RE.test(value.id || "") && validTimelineBinding(value.binding)
    && completeTimelineBinding(value.binding) && value.binding.groupId === null && validSource(value.source)
    && validDate(value.confirmedAt) && validDate(value.expiresAt) && value.timelineVisibility === TIMELINE_VISIBILITY
    && value.confirmation === LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION && value.authority === AUTHORITY
    && validTimelineTransportDigest(value.transportDigest)
    && value.id === enrollmentId(root, value.binding, value.source)
    && value.enrollmentDigest === enrollmentDigest(root, value.binding, value.source, value.expiresAt, value.transportDigest)
    && value.append === undefined;
}

function unambiguousEnrollments(enrollments) {
  const keys = new Set();
  for (const record of enrollments) {
    const key = [record.binding.host, record.binding.sessionId, sourceDigest(record.source)].join("\0");
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function validate(state, root) {
  const receipts = state?.pendingReceipts === undefined ? [] : state.pendingReceipts;
  if (!state || state.schema !== PRIVATE_TIMELINE_ENROLLMENT_SCHEMA || state.rootDigest !== digest(root)
    || state.authority !== AUTHORITY || !Array.isArray(state.enrollments)
    || !validGeneration(state.generation) || !validSignature(state.signature)
    || (state.generation === 1 ? state.previousSignature !== null : !validSignature(state.previousSignature))
    || state.enrollments.length > MAX_ENROLLMENTS || !state.enrollments.every((item) => validEnrollment(item, root))
    || !unambiguousEnrollments(state.enrollments) || !Array.isArray(receipts) || receipts.length > MAX_PENDING_RECEIPTS
    || !receipts.every((item) => validHostTranscriptReceipt(item, root))
    || new Set(receipts.map((item) => item.id)).size !== receipts.length) {
    throw new Error("private timeline enrollment state is invalid");
  }
  return state;
}

function stateRoot(root) { return { value: root, digest: digest(root) }; }

async function enrollmentPaths(root, options = {}) {
  return privateEnrollmentPaths(root, options);
}

async function readState(path, headPath, root, assertStable, assertOwned = null) {
  const state = await readPrivateEnrollmentState({
    path, headPath, root: stateRoot(root), assertStable, assertOwned, empty, validate,
    headSchema: HEAD_SCHEMA, headAuthority: HEAD_AUTHORITY, maximumBytes: MAX_STATE_BYTES
  });
  if (!Array.isArray(state.pendingReceipts)) state.pendingReceipts = [];
  return state;
}

async function saveState(state, path, headPath, root, assertOwned, assertStable) {
  await savePrivateEnrollmentState({
    state, path, headPath, root: stateRoot(root), assertOwned, assertStable,
    headSchema: HEAD_SCHEMA, headAuthority: HEAD_AUTHORITY, maximumBytes: MAX_STATE_BYTES
  });
}

// The normal path remains read-only.  If a crash left one verified state
// generation ahead of its signed head, retry under the existing owned lock so
// storage can perform its exact one-step repair; every other failure remains
// unavailable and yields no enrollment or source data.
async function loadStateWithRecovery(rootPath, { create = false } = {}) {
  const names = await enrollmentPaths(rootPath, { create });
  try {
    return { names, state: await readState(names.path, names.headPath, rootPath, names.assertStable) };
  } catch {
    const state = await withOwnedFileLock(names.lock, async ({ assertOwned }) => readState(
      names.path, names.headPath, rootPath, names.assertStable, assertOwned
    ), { assertPath: names.assertStable });
    return { names, state };
  }
}

function validHostReceiptInput({ host, sessionId, scope }) {
  const binding = sessionTimelineBinding({ host, sessionId, scope });
  if (host !== "claude") return { reason: "unknown-timeline-host" };
  if (scope?.groupId !== null || hasTimelineGroupScope(scope)) return { reason: "group-suppressed" };
  if (!completeTimelineBinding(binding) || binding.groupId !== null) return { reason: "missing-or-unknown-session-scope" };
  return { binding };
}

function validResolverInput({ host, sessionId }) {
  if (host !== "claude") return null;
  return safeTimelineId(sessionId);
}

async function canonicalRoot(root) {
  if (typeof root !== "string" || !root) return null;
  try { return await canonicalPath(root); }
  catch { return null; }
}

// This is called only by the Claude UserPromptSubmit lifecycle adapter.  It
// records a signed, short-lived observation; the opaque token itself is never
// returned through hook context or a briefing.
export async function issueHostTranscriptReceipt({
  root, host, sessionId, scope, transcriptPath, hostHome, event, eventId = null,
  hostOrigin = null, clock = null, environment = process.env
}) {
  const current = runtimeDate(clock);
  if (!current) return hostReceiptUnavailable("invalid-host-receipt-time");
  if (event !== "UserPromptSubmit") return hostReceiptUnavailable("host-receipt-event-not-supported");
  const rootPath = await canonicalRoot(root);
  if (!rootPath) return hostReceiptUnavailable("unknown-project-root");
  const input = validHostReceiptInput({ host, sessionId, scope });
  if (!input.binding) return hostReceiptUnavailable(input.reason);
  const hookInput = { transcript_path: transcriptPath, event_id: eventId };
  if (!validVerifiedTimelineHostOrigin({ origin: hostOrigin, root: rootPath, input: hookInput,
    binding: input.binding, hostHome, event })) return hostReceiptUnavailable("host-lifecycle-receipt-required");
  const transportDigest = timelineTransportDigest({ root: rootPath, binding: input.binding, environment });
  if (!transportDigest) return hostReceiptUnavailable("local-transport-capability-required");
  const source = await sourcePath(transcriptPath, hostHome);
  if (source.status !== "registered") return hostReceiptUnavailable(source.reason || "transcript-unavailable");
  // This bounded 4 KiB digest is an immutable source binding, not transcript
  // capture: receipt issuance never retains or injects the source text.
  const snapshot = await normalizePrivateTimelineSource(source);
  if (!snapshot) return hostReceiptUnavailable("transcript-snapshot-unavailable");
  try {
    const names = await enrollmentPaths(rootPath);
    return await withOwnedFileLock(names.lock, async ({ assertOwned }) => {
      const state = await readState(names.path, names.headPath, rootPath, names.assertStable, assertOwned);
      const changed = purgeExpiredHostReceipts(state, current);
      const receipt = makeHostTranscriptReceipt({ root: rootPath, binding: input.binding, source: snapshot,
        transportDigest, current, eventId });
      const existing = state.pendingReceipts.find((item) => sameIssuedHostTranscriptEvent(item, receipt));
      if (existing) {
        if (changed) await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
        return hostReceiptResult(existing);
      }
      if (state.pendingReceipts.length >= MAX_PENDING_RECEIPTS) {
        if (changed) await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
        return hostReceiptUnavailable("host-receipt-capacity-exhausted");
      }
      state.pendingReceipts.unshift(receipt);
      await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
      return hostReceiptResult(receipt);
    }, { assertPath: names.assertStable });
  } catch {
    return hostReceiptUnavailable("host-receipt-state-unavailable");
  }
}

// The local owner can retrieve only the opaque current-session token.  The
// protected transport capability proves the caller's host session; no source
// path, scope, or transcript content is returned to a generic CLI process.
export async function currentHostTranscriptReceipt({ root, clock = null, environment = process.env }) {
  const current = runtimeDate(clock);
  if (!current) return hostReceiptUnavailable("invalid-host-receipt-time");
  const rootPath = await canonicalRoot(root);
  if (!rootPath) return hostReceiptUnavailable("unknown-project-root");
  try {
    const { state } = await loadStateWithRecovery(rootPath);
    const matches = state.pendingReceipts.filter((item) => {
      if (new Date(item.expiresAt).getTime() <= current.getTime()) return false;
      const transportDigest = timelineTransportDigest({ root: rootPath, binding: item.binding, environment });
      return transportDigest && sameTimelineTransportDigest(item.transportDigest, transportDigest);
    });
    return matches.length === 1 ? hostReceiptResult(matches[0])
      : hostReceiptUnavailable(matches.length ? "host-receipt-ambiguous" : "host-receipt-unavailable");
  } catch {
    return hostReceiptUnavailable("host-receipt-state-unavailable");
  }
}

// Internal state-only lookup for bootstrap and lifecycle hints. It reads the
// signed enrollment record but deliberately never opens, stats, or hashes the
// transcript; callers still need the normal resolver before any evidence read.
export async function loadPrivateSessionTimelineEnrollment({
  root, host = null, sessionId = null, scope = null, enrollmentDigest: wantedDigest = null,
  expectedTransportDigest = null, clock = null
}) {
  const current = runtimeDate(clock);
  if (!current) return inspectUnavailable("invalid-enrollment-time");
  const rootPath = await canonicalRoot(root);
  if (!rootPath || (wantedDigest !== null && !/^[a-f0-9]{64}$/.test(wantedDigest))) {
    return inspectUnavailable("private-enrollment-unavailable");
  }
  const requested = scope === null ? null : validHostReceiptInput({ host, sessionId, scope });
  if ((scope !== null || host !== null || sessionId !== null) && !requested?.binding) {
    return inspectUnavailable("private-enrollment-unavailable");
  }
  try {
    const { state } = await loadStateWithRecovery(rootPath);
    const matches = state.enrollments.filter((record) => (!requested || sameTimelineBinding(record.binding, requested.binding))
      && (wantedDigest === null || record.enrollmentDigest === wantedDigest));
    if (matches.length !== 1 || new Date(matches[0].expiresAt).getTime() <= current.getTime()) {
      return inspectUnavailable("private-enrollment-unavailable");
    }
    const [record] = matches;
    if (expectedTransportDigest !== null && (!validTimelineTransportDigest(expectedTransportDigest)
      || !sameTimelineTransportDigest(record.transportDigest, expectedTransportDigest))) {
      return inspectUnavailable("private-enrollment-transport-mismatch");
    }
    return { status: "loaded", rootPath, record, now: current };
  } catch {
    return inspectUnavailable("private-enrollment-state-unavailable");
  }
}

function activeResult(record, activeSource) {
  return {
    schema: PRIVATE_TIMELINE_ENROLLMENT_SCHEMA, status: "enrolled", id: record.id,
    binding: { ...record.binding }, source: {
      path: activeSource.path, profileRoot: activeSource.profileRoot, projectsRoot: activeSource.projectsRoot,
      pathDigest: activeSource.pathDigest, identity: activeSource.identity, size: activeSource.size,
      mtimeNs: activeSource.mtimeNs, ctimeNs: activeSource.ctimeNs,
      commitmentDigest: null, committedBytes: 0
    }, sourceDigest: sourceDigest(record.source), enrollmentDigest: record.enrollmentDigest,
    expiresAt: record.expiresAt, timelineVisibility: record.timelineVisibility, authority: AUTHORITY
  };
}

function inspectUnavailable(reason) { return { status: "unavailable", reason }; }

export async function inspectPrivateSessionTimelineEnrollment({
  root, host, sessionId, transcriptPath, hostHome, clock = null, expectedTransportDigest = null
}) {
  const current = runtimeDate(clock);
  if (!current) return inspectUnavailable("invalid-enrollment-time");
  const rootPath = await canonicalRoot(root);
  if (!rootPath) return inspectUnavailable("unknown-project-root");
  const activeSessionId = validResolverInput({ host, sessionId });
  if (!activeSessionId) return inspectUnavailable("unknown-timeline-host-or-session");
  try {
    const { state } = await loadStateWithRecovery(rootPath);
    const candidates = state.enrollments.filter((item) => item.binding.host === host && item.binding.sessionId === activeSessionId);
    const requestedPath = typeof transcriptPath === "string" && transcriptPath
      ? transcriptPath : candidates.length === 1 ? candidates[0].source.path : null;
    // Post-compaction input may omit a host profile root. In that case, the
    // sealed root from the one matching enrollment is the only allowed
    // fallback; an environment or arbitrary caller path is never consulted.
    const trustedHome = hostHome === null || hostHome === undefined
      ? candidates.length === 1 ? candidates[0].source.profileRoot : null
      : isAbsolute(hostHome) ? hostHome : null;
    if (!requestedPath || !trustedHome) return inspectUnavailable("private-enrollment-unavailable");
    const active = await sourcePath(requestedPath, trustedHome);
    if (active.status !== "registered") return inspectUnavailable(active.reason || "transcript-unavailable");
    const matches = candidates.filter((item) => sameSource(item.source, active));
    if (matches.length !== 1) return inspectUnavailable("private-enrollment-unavailable");
    const [record] = matches;
    if (new Date(record.expiresAt).getTime() <= current.getTime()) return inspectUnavailable("private-enrollment-expired");
    if (expectedTransportDigest !== null && (!validTimelineTransportDigest(expectedTransportDigest)
      || !sameTimelineTransportDigest(record.transportDigest, expectedTransportDigest))) {
      return inspectUnavailable("private-enrollment-transport-mismatch");
    }
    return { status: "loaded", rootPath, record, active, now: current };
  } catch {
    return inspectUnavailable("private-enrollment-state-unavailable");
  }
}

export async function mutatePrivateSessionTimelineEnrollment({ root, task }) {
  const rootPath = await canonicalRoot(root);
  if (!rootPath || typeof task !== "function") return null;
  try {
    const names = await enrollmentPaths(rootPath);
    return await withOwnedFileLock(names.lock, async ({ assertOwned }) => {
      const state = await readState(names.path, names.headPath, rootPath, names.assertStable, assertOwned);
      let committed = false;
      const commit = async () => {
        if (committed) return;
        await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
        committed = true;
      };
      return task({ rootPath, state, commit });
    }, { assertPath: names.assertStable });
  } catch {
    return null;
  }
}

// A first state write interrupted before any signed head exists is not
// distinguishable from a deleted head.  It is never auto-accepted: a local
// owner may explicitly discard all enrollment state, then obtain a fresh host
// receipt.  This function exposes no historic binding, path, or transcript.
export async function resetPrivateSessionTimelineEnrollment({ root, confirmation }) {
  if (confirmation !== LOCAL_TIMELINE_ENROLLMENT_RECOVERY_CONFIRMATION) return false;
  const rootPath = await canonicalRoot(root);
  if (!rootPath) return false;
  try {
    const names = await enrollmentPaths(rootPath);
    return await withOwnedFileLock(names.lock, async ({ assertOwned }) => {
      try {
        await readState(names.path, names.headPath, rootPath, names.assertStable, assertOwned);
        return false;
      } catch {
        const state = empty(rootPath);
        await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
        return true;
      }
    }, { assertPath: names.assertStable });
  } catch {
    return false;
  }
}

export async function enrollPrivateSessionTimeline(options = {}) {
  const { root, hostReceipt, confirmation, ttlMs = DEFAULT_TIMELINE_ENROLLMENT_TTL_MS,
    clock = null, environment = process.env } = options || {};
  if (!options || typeof options !== "object" || Array.isArray(options)
    || ["host", "sessionId", "scope", "transcriptPath", "hostHome"].some((key) => options[key] !== undefined)) {
    return unavailable("host-transcript-receipt-required");
  }
  if (confirmation !== LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION) return unavailable("local-owner-confirmation-required");
  if (!hostReceiptId(hostReceipt)) return unavailable("host-transcript-receipt-required");
  const current = runtimeDate(clock);
  if (!current) return unavailable("invalid-enrollment-time");
  const ttl = enrollmentTtl(ttlMs);
  if (!ttl) return unavailable("invalid-enrollment-expiry");
  const rootPath = await canonicalRoot(root);
  if (!rootPath) return unavailable("unknown-project-root");
  try {
    const names = await enrollmentPaths(rootPath);
    let result = unavailable("host-transcript-receipt-unavailable");
    await withOwnedFileLock(names.lock, async ({ assertOwned }) => {
      const state = await readState(names.path, names.headPath, rootPath, names.assertStable, assertOwned);
      const pruned = purgeExpiredHostReceipts(state, current);
      const receiptIndex = state.pendingReceipts.findIndex((item) => item.id === hostReceipt);
      const receipt = receiptIndex < 0 ? null : state.pendingReceipts[receiptIndex];
      if (!receipt) {
        if (pruned) await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
        return;
      }
      const transportDigest = timelineTransportDigest({ root: rootPath, binding: receipt.binding, environment });
      if (!transportDigest || !sameTimelineTransportDigest(receipt.transportDigest, transportDigest)) {
        result = unavailable("local-transport-capability-required"); return;
      }
      const source = await sourcePath(receipt.source.path, receipt.source.profileRoot);
      const normalized = source.status === "registered" ? await normalizePrivateTimelineSource(source) : null;
      state.pendingReceipts.splice(receiptIndex, 1);
      if (!normalized || !sameHostReceiptSource(receipt, normalized)) {
        await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
        result = unavailable("transcript-snapshot-changed"); return;
      }
      const record = { binding: receipt.binding, source: normalized, confirmedAt: current.toISOString(),
        expiresAt: new Date(current.getTime() + ttl).toISOString(), timelineVisibility: TIMELINE_VISIBILITY,
        confirmation: LOCAL_TIMELINE_ENROLLMENT_CONFIRMATION, transportDigest: receipt.transportDigest, authority: AUTHORITY };
      record.id = enrollmentId(rootPath, record.binding, record.source);
      record.enrollmentDigest = enrollmentDigest(rootPath, record.binding, record.source, record.expiresAt, record.transportDigest);
      state.enrollments = state.enrollments.filter((item) => new Date(item.expiresAt).getTime() > current.getTime()
        && !(sameTimelineBinding(item.binding, record.binding)
          || (item.binding.host === record.binding.host && item.binding.sessionId === record.binding.sessionId
            && sameSource(item.source, record.source))));
      state.enrollments.unshift(record);
      state.enrollments = state.enrollments.slice(0, MAX_ENROLLMENTS);
      await saveState(state, names.path, names.headPath, rootPath, assertOwned, names.assertStable);
      result = activeResult(record, source);
    }, { assertPath: names.assertStable });
    return result;
  } catch {
    return unavailable("private-enrollment-state-unavailable");
  }
}

export async function resolvePrivateSessionTimelineEnrollment({
  root, host, sessionId, transcriptPath, hostHome, clock = null, expectedTransportDigest = null
}) {
  const inspected = await inspectPrivateSessionTimelineEnrollment({
    root, host, sessionId, transcriptPath, hostHome, clock, expectedTransportDigest
  });
  if (inspected.status !== "loaded") return unavailable(inspected.reason);
  const { record, active } = inspected;
  if (!sameSourceSnapshot(record.source, active)) {
    return unavailable("transcript-snapshot-renewal-required");
  }
  if (await privateTimelinePrefixDigest(active, record.source.prefixBytes) !== record.source.prefixDigest) {
    return unavailable("transcript-replaced");
  }
  return activeResult(record, active);
}
