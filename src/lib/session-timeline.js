import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import {
  completeTimelineBinding, hasVerifiedTimelinePrivateScope, sameTimelineBinding, sessionTimelineBinding,
  TIMELINE_ID_RE, validTimelineBinding
} from "./session-timeline-contract.js";
import {
  ensureSessionTimelineTrust, sessionTimelineStatePaths
} from "./session-timeline-auth.js";
import { consumeSessionTimelineInvocation, issueSessionTimelineInvocation } from "./session-timeline-invocation.js";
import {
  loadPrivateSessionTimelineEnrollment, resolvePrivateSessionTimelineEnrollment
} from "./session-timeline-enrollment.js";
import { timelineTransportEnrollmentMatches } from "./session-timeline-enrollment-transport.js";
import { sameTimelineTransportDigest, timelineTransportDigest } from "./session-timeline-transport.js";
import {
  matchesTimelineEvent, rankTimelineEvents, timelineQuery
} from "./session-timeline-query.js";
import { timelineContinuationCapsule, timelineSearchResult } from "./session-timeline-results.js";
import { seekTimelineEvidence, verifyTimelineEvent } from "./session-timeline-search.js";
import { eventFromTimelineLine, extractTimelineTimestamp } from "./session-timeline-event-extract.js";
import { matchesSourceMetadata, pathMatchesSource } from "./session-timeline-source.js";
import { readTimelineState, saveTimelineState } from "./session-timeline-state.js";
import { sessionTimelineRootDigest } from "./session-timeline-root.js";

export const SESSION_TIMELINE_SCHEMA = "agentspine.session-timeline/v1";
const STATE_SCHEMA = "agentspine.session-timeline-state/v1";
const AUTHORITY = "context-only";
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCES = 64;
const MAX_EVENTS = 4096;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const ROOM_BYTES = 1024 * 1024;
const EVENT_OUTCOMES = new Set(["pass", "fail", "blocked", "timeout", "error", "skipped"]);
const EVENT_LABEL_RE = /^(?:suite-(?:0|[1-9]\d{0,3})|acceptance|audit|npm-check|ci|test)$/;
const EVENT_KEYS = new Set(["id", "at", "offset", "bytes", "sha256", "kind", "outcome", "count", "testLabel", "terms", "authority"]);
const MUTATION_TAILS = new Map();

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("session timeline timestamp is invalid");
  return date;
}
function date(value) { return Number.isFinite(new Date(value).getTime()); }

function empty(root) { return { schema: STATE_SCHEMA, rootDigest: sessionTimelineRootDigest(root), sources: [], authority: AUTHORITY }; }
function hasOnlyKeys(item, allowed) { return Object.keys(item).every((key) => allowed.has(key)); }
function validCount(item) {
  return item === null || Boolean(item && typeof item === "object" && Object.keys(item).length === 2
    && Number.isSafeInteger(item.value) && item.value >= 0 && Number.isSafeInteger(item.total)
    && item.total > 0 && item.value <= item.total);
}
function validEvent(item) {
  return item && typeof item === "object" && hasOnlyKeys(item, EVENT_KEYS)
    && typeof item.id === "string" && TIMELINE_ID_RE.test(item.id) && date(item.at)
    && Number.isSafeInteger(item.offset) && item.offset >= 0 && Number.isSafeInteger(item.bytes) && item.bytes > 0
    && /^[a-f0-9]{64}$/.test(item.sha256 || "") && item.kind === "objective-result"
    && EVENT_OUTCOMES.has(item.outcome) && validCount(item.count)
    && (item.testLabel === null || typeof item.testLabel === "string" && EVENT_LABEL_RE.test(item.testLabel))
    && Array.isArray(item.terms) && item.terms.length <= 24 && item.terms.every((term) => /^[\p{L}\p{N}]{3,}$/u.test(term))
    && item.authority === AUTHORITY;
}
function validSource(item) {
  return item && validTimelineBinding(item.binding) && typeof item.path === "string" && isAbsolute(item.path)
    && item.path.length > 0 && item.path.length <= 4096 && typeof item.profileRoot === "string" && isAbsolute(item.profileRoot)
    && item.profileRoot.length > 0 && item.profileRoot.length <= 4096 && typeof item.projectsRoot === "string" && isAbsolute(item.projectsRoot)
    && item.projectsRoot.length > 0 && item.projectsRoot.length <= 4096 && item.pathDigest === digest(item.path)
    && typeof item.identity === "string" && item.identity.length <= 256
    && /^[0-9]+$/.test(item.mtimeNs || "") && /^[0-9]+$/.test(item.ctimeNs || "")
    && Number.isInteger(item.indexedBytes) && item.indexedBytes >= 0 && Number.isInteger(item.size) && item.size >= 0
    && item.indexedBytes <= item.size && Array.isArray(item.events) && item.events.length <= MAX_EVENTS
    && item.events.every((event) => validEvent(event) && event.bytes <= MAX_LINE_BYTES && event.offset + event.bytes <= item.size)
    && (item.lessonDigest === null || /^[a-f0-9]{64}$/.test(item.lessonDigest || ""))
    && date(item.updatedAt) && item.authority === AUTHORITY;
}
function validate(value, root) {
  if (!value || value.schema !== STATE_SCHEMA || value.rootDigest !== sessionTimelineRootDigest(root) || value.authority !== AUTHORITY
    || !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES || value.sources.some((item) => !validSource(item))) {
    throw new Error("session timeline state is invalid");
  }
  return value;
}

function paths(root) { return sessionTimelineStatePaths(root); }
function readState(path, root, assertStable) {
  return readTimelineState({ path, root, maximumBytes: MAX_STATE_BYTES, empty, validate, assertStable });
}
function saveState(state, path, assertOwned, root, assertStable) {
  return saveTimelineState({ state, path, root, maximumBytes: MAX_STATE_BYTES, assertOwned, assertStable });
}

async function serializeLocalMutation(key, task) {
  const previous = MUTATION_TAILS.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => current);
  MUTATION_TAILS.set(key, tail);
  await previous.catch(() => {});
  try { return await task(); }
  finally {
    release();
    if (MUTATION_TAILS.get(key) === tail) MUTATION_TAILS.delete(key);
  }
}

function status(value, extra = {}) { return { schema: SESSION_TIMELINE_SCHEMA, ...value, ...extra, authority: AUTHORITY }; }
function hasExactPrivateTimelineScope(scope) { return scope?.groupId === null; }
function sourceFor(state, scope) { return state.sources.find((item) => sameTimelineBinding(item.binding, scope)) || null; }
function sourceMetadata(source) {
  const sourceDigest = digest(`${source.pathDigest}\0${source.identity}\0${source.size}\0${source.mtimeNs}\0${source.ctimeNs}`);
  return { sourceDigest, indexedBytes: source.indexedBytes, size: source.size, events: source.events.length,
    rooms: Math.ceil(source.size / ROOM_BYTES), continuation: timelineContinuationCapsule({ source, sourceDigest, roomBytes: ROOM_BYTES, authority: AUTHORITY }) };
}
function sameSourceSnapshot(left, right) {
  return Boolean(left && right) && ["path", "profileRoot", "projectsRoot", "pathDigest", "identity", "size", "mtimeNs", "ctimeNs"]
    .every((key) => left[key] === right[key]);
}
async function confirmedSourceEnrollment({ root, scoped, source, hostHome }) {
  const enrollment = await resolvePrivateSessionTimelineEnrollment({ root, host: scoped.host, sessionId: scoped.sessionId,
    transcriptPath: source.path, hostHome });
  if (enrollment.status !== "enrolled" || !sameTimelineBinding(enrollment.binding, scoped)
    || !sameSourceSnapshot(enrollment.source, source)) return false;
  return true;
}

async function bootstrapEnrollment(root, enrollmentDigest, environment) {
  const loaded = await loadPrivateSessionTimelineEnrollment({ root, enrollmentDigest });
  if (loaded.status !== "loaded") return null;
  const transportDigest = timelineTransportDigest({
    root: loaded.rootPath, binding: loaded.record.binding, environment
  });
  return transportDigest && sameTimelineTransportDigest(loaded.record.transportDigest, transportDigest) ? loaded : null;
}

function enrolledSource(record, previous, now) {
  const source = record.source;
  const unchanged = previous && sameSourceSnapshot(previous, source);
  return {
    binding: record.binding, path: source.path, profileRoot: source.profileRoot, projectsRoot: source.projectsRoot,
    pathDigest: source.pathDigest, identity: source.identity, size: source.size, mtimeNs: source.mtimeNs,
    ctimeNs: source.ctimeNs, lessonDigest: unchanged ? previous.lessonDigest : null,
    indexedBytes: unchanged ? previous.indexedBytes : 0, events: unchanged ? previous.events : [],
    updatedAt: asDate(now).toISOString(), authority: AUTHORITY
  };
}

// Bootstrap has no caller-provided source location. It copies only the source
// metadata sealed in the just-validated enrollment into the private sidecar;
// the MCP index remains the first and only path that opens transcript bytes.
export async function bootstrapSessionTimelineEnrollment({
  root, enrollmentDigest, environment = process.env, now = new Date()
}) {
  const loaded = await bootstrapEnrollment(root, enrollmentDigest, environment);
  if (!loaded) return status({ status: "unavailable", reason: "private-enrollment-unavailable" });
  const { rootPath, record } = loaded;
  try { await ensureSessionTimelineTrust({ create: true }); }
  catch { return status({ status: "unavailable", reason: "timeline-state-unavailable" }); }
  try {
    const names = await paths(rootPath);
    await withOwnedFileLock(names.lock, async ({ assertOwned }) => {
      const state = await readState(names.path, rootPath, names.assertStable);
      const previous = sourceFor(state, record.binding);
      if (previous && sameSourceSnapshot(previous, record.source)) return;
      state.sources = state.sources.filter((item) => !sameTimelineBinding(item.binding, record.binding));
      state.sources.unshift(enrolledSource(record, previous, now));
      state.sources = state.sources.slice(0, MAX_SOURCES);
      await saveState(state, names.path, assertOwned, rootPath, names.assertStable);
    }, { assertPath: names.assertStable });
  } catch { return status({ status: "unavailable", reason: "timeline-state-unavailable" }); }
  return status({ status: "registered", bootstrap: "signed-enrollment-metadata" });
}

// Hooks use this deliberately source-blind hint after compaction. It proves
// only that a matching signed enrollment and sidecar still exist; the next
// bound MCP index/search revalidates the immutable source before any read.
export async function sessionTimelineLifecycleHint({
  root, host, sessionId, scope, environment = process.env
}) {
  const scoped = sessionTimelineBinding({ host, sessionId, scope });
  if (!hasExactPrivateTimelineScope(scope)) return status({ status: "group-suppressed" });
  // Lifecycle input cannot assert private visibility. Its exact signed
  // enrollment below is the authority for this source-blind status hint.
  if (!completeTimelineBinding(scoped)) {
    return status({ status: "unavailable", reason: "timeline-scope-unverified" });
  }
  const loaded = await loadPrivateSessionTimelineEnrollment({ root, host, sessionId, scope });
  if (loaded.status !== "loaded") return status({ status: "unavailable", reason: "private-enrollment-unavailable" });
  const transportDigest = timelineTransportDigest({ root: loaded.rootPath, binding: loaded.record.binding, environment });
  if (!transportDigest || !sameTimelineTransportDigest(loaded.record.transportDigest, transportDigest)) {
    return status({ status: "unavailable", reason: "private-enrollment-unavailable" });
  }
  try {
    await ensureSessionTimelineTrust();
    const names = await paths(loaded.rootPath);
    const state = await readState(names.path, loaded.rootPath, names.assertStable);
    const source = sourceFor(state, scoped);
    if (!source) return status({ status: "unavailable", reason: "timeline-not-registered" });
    return status({ status: source.indexedBytes >= source.size ? "indexed" : "partial", ...sourceMetadata(source),
      freshness: "source-not-read", instruction: "Use session_timeline_index before search when this snapshot is partial." });
  } catch {
    return status({ status: "unavailable", reason: "timeline-state-unavailable" });
  }
}

// Source registration used to accept a raw caller path. That would turn a
// direct API call into a second transcript reader, so the only supported
// setup is now receipt-backed enrollment followed by signed metadata bootstrap.
// Keep this explicit no-data result for callers upgrading from the legacy API.
export async function registerSessionTimelineSource() {
  return status({ status: "unavailable", reason: "timeline-enrollment-bootstrap-required" });
}

function mergeEvents(existing, additions) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of additions) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.at.localeCompare(right.at) || left.offset - right.offset).slice(-MAX_EVENTS);
}
async function unchangedHandle(handle, source, hostHome = null) {
  try {
    const metadata = await handle.stat({ bigint: true });
    return matchesSourceMetadata(metadata, source) && await pathMatchesSource(source, hostHome);
  } catch { return false; }
}

async function validatedHandle(source, hostHome = null) {
  if (!await pathMatchesSource(source, hostHome)) return { status: "unavailable", reason: "transcript-changed" };
  let handle;
  try { handle = await open(source.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); }
  catch { return { status: "unavailable", reason: "transcript-changed" }; }
  if (!await unchangedHandle(handle, source, hostHome)) {
    await handle.close();
    return { status: "unavailable", reason: "transcript-changed" };
  }
  return { status: "open", handle, size: source.size };
}
async function readRange(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}
function parsedEvents(buffer, start, dropFirst = false) {
  const result = [];
  let index = 0;
  while (index < buffer.byteLength) {
    const newline = buffer.indexOf(0x0a, index);
    const end = newline < 0 ? buffer.byteLength : newline + 1;
    const line = buffer.subarray(index, end);
    if (!(dropFirst && index === 0) && line.byteLength) {
      const event = eventFromTimelineLine(line.toString("utf8"), start + index, AUTHORITY);
      if (event) result.push(event);
    }
    index = end;
  }
  return result;
}

async function indexRange(source, start, maximum, hostHome = null) {
  const opened = await validatedHandle(source, hostHome);
  if (opened.status !== "open") return opened;
  try {
    if (start >= opened.size) return { status: "indexed", next: opened.size, events: [], size: opened.size };
    const bytes = await readRange(opened.handle, start, Math.min(maximum, opened.size - start));
    const last = bytes.lastIndexOf(0x0a);
    const completeAtEnd = start + bytes.byteLength === opened.size;
    if (last < 0 && !completeAtEnd) return { status: "partial-line", events: [], size: opened.size };
    const selected = last < 0 || completeAtEnd ? bytes : bytes.subarray(0, last + 1);
    const before = start > 0 ? await readRange(opened.handle, start - 1, 1) : Buffer.alloc(0);
    if (!await unchangedHandle(opened.handle, source, hostHome)) return { status: "unavailable", reason: "transcript-changed" };
    return { status: "indexed", next: start + selected.byteLength,
      events: parsedEvents(selected, start, start > 0 && before[0] !== 0x0a), size: opened.size };
  } finally { await opened.handle.close(); }
}

async function mutateSource(root, scoped, task) {
  try { await ensureSessionTimelineTrust(); }
  catch { return status({ status: "unavailable", reason: "timeline-state-unavailable" }); }
  let names;
  try { names = await paths(root); }
  catch { return status({ status: "unavailable", reason: "timeline-state-unavailable" }); }
  return serializeLocalMutation(names.lock, () => withOwnedFileLock(names.lock, async ({ assertOwned }) => {
    let state;
    try { state = await readState(names.path, root, names.assertStable); }
    catch { return status({ status: "unavailable", reason: "timeline-state-unavailable" }); }
    const source = sourceFor(state, scoped);
    if (!source) return status({ status: "unavailable", reason: "timeline-not-registered" });
    const result = await task(source);
    if (result.status === "indexed") {
      source.size = result.size;
      if (!result.preserveCursor) source.indexedBytes = Math.max(source.indexedBytes, result.next);
      source.events = mergeEvents(source.events, result.events); source.updatedAt = new Date().toISOString();
      await saveState(state, names.path, assertOwned, root, names.assertStable);
    }
    return result.status === "indexed" ? status({ status: source.indexedBytes >= source.size ? "indexed"
      : result.preserveCursor ? "fresh-tail" : "partial", ...sourceMetadata(source), added: result.events.length })
      : status(result);
  }, { assertPath: names.assertStable })).catch(() =>
    status({ status: "unavailable", reason: "timeline-state-unavailable" }));
}

export async function indexSessionTimeline({
  root, host, sessionId, scope, maxBytes = 4 * 1024 * 1024,
  invocationRequest = null, transportDigest = null, enrollmentDigest = null, hostHome = null
}) {
  const scoped = sessionTimelineBinding({ host, sessionId, scope });
  if (!hasExactPrivateTimelineScope(scope)) return status({ status: "group-suppressed" });
  if (!hasVerifiedTimelinePrivateScope(scope)) return status({ status: "unavailable", reason: "timeline-scope-unverified" });
  if (!completeTimelineBinding(scoped)) return status({ status: "unavailable", reason: "missing-session-scope" });
  if (!Number.isInteger(maxBytes) || maxBytes < 64 * 1024 || maxBytes > MAX_INDEX_BYTES) throw new Error("timeline index byte budget is invalid");
  return mutateSource(root, scoped, async (source) => {
    if (!await confirmedSourceEnrollment({ root, scoped, source, hostHome })) {
      return { status: "unavailable", reason: "private-enrollment-unavailable" };
    }
    const sourceDigest = sourceMetadata(source).sourceDigest;
    if (!invocationRequest || !await timelineTransportEnrollmentMatches({ root, binding: scoped, enrollmentDigest, transportDigest, hostHome })
      || !await consumeSessionTimelineInvocation({ root, tool: "index", binding: scoped, sourceDigest,
        request: invocationRequest, transportDigest })) {
      return { status: "unavailable", reason: "timeline-invocation-unavailable" };
    }
    return indexRange(source, source.indexedBytes, maxBytes, hostHome);
  });
}

// Tail refresh is intentionally retired: only a bound MCP index invocation
// may open an enrolled transcript, and it must consume its one-use permit.
export async function refreshSessionTimelineTail() {
  return status({ status: "unavailable", reason: "timeline-mcp-index-required" });
}

export async function sessionTimelineStatus({ root, host, sessionId, scope, environment = process.env }) {
  if (!hasExactPrivateTimelineScope(scope)) return status({ status: "group-suppressed" });
  if (!hasVerifiedTimelinePrivateScope(scope)) return status({ status: "unavailable", reason: "timeline-scope-unverified" });
  // Status is intentionally a sidecar-only hint. Immutable source validation
  // is kept at receipt consumption and PreTool, while MCP index/search alone
  // perform bounded evidence reads.
  return sessionTimelineLifecycleHint({ root, host, sessionId, scope, environment });
}

export async function authorizeSessionTimelineInvocation({
  root, host, sessionId, scope, hostHome, tool, request, toolUseId, transportDigest, enrollmentDigest
}) {
  const scoped = sessionTimelineBinding({ host, sessionId, scope });
  if (!hasExactPrivateTimelineScope(scope) || !completeTimelineBinding(scoped) || !/^(index|search)$/.test(tool || "")) return null;
  if (!hasVerifiedTimelinePrivateScope(scope)) return null;
  try {
    await ensureSessionTimelineTrust();
    const names = await paths(root);
    const state = await readState(names.path, root, names.assertStable);
    const source = sourceFor(state, scoped);
    if (!source || !await pathMatchesSource(source, hostHome)
      || !await confirmedSourceEnrollment({ root, scoped, source, hostHome })) return null;
    const sourceDigest = sourceMetadata(source).sourceDigest;
    if (!await timelineTransportEnrollmentMatches({ root, binding: scoped, enrollmentDigest, transportDigest, hostHome })) return null;
    await issueSessionTimelineInvocation({
      root, tool, binding: scoped, sourceDigest, request, toolUseId, transportDigest
    });
    return { sourceDigest, authority: AUTHORITY };
  } catch { return null; }
}

function searchResult(source, target, wanted, mode, events, extra = {}) {
  const index = sourceMetadata(source);
  return timelineSearchResult({ sourceDigest: index.sourceDigest, target, wanted, mode, events, index,
    roomBytes: ROOM_BYTES, authority: AUTHORITY, extra });
}

export async function searchSessionTimeline({
  root, host, sessionId, scope, at, query, windowSeconds = undefined,
  invocationRequest = null, transportDigest = null, enrollmentDigest = null, hostHome = null
}) {
  const scoped = sessionTimelineBinding({ host, sessionId, scope });
  if (!hasExactPrivateTimelineScope(scope) || !hasVerifiedTimelinePrivateScope(scope) || !completeTimelineBinding(scoped)) {
    return { blocked: true, reason: "session timeline scope is unavailable", authority: AUTHORITY };
  }
  const { target, wanted } = timelineQuery({ at, query });
  const boundedWindowSeconds = windowSeconds === undefined ? 0 : windowSeconds;
  if (!Number.isInteger(boundedWindowSeconds) || boundedWindowSeconds < 0 || boundedWindowSeconds > 900) {
    throw new Error("timeline window is invalid");
  }
  try { await ensureSessionTimelineTrust(); }
  catch { return { blocked: true, reason: "session timeline is unavailable", authority: AUTHORITY }; }
  let names; let state;
  try {
    names = await paths(root);
    state = await readState(names.path, root, names.assertStable);
  }
  catch { return { blocked: true, reason: "session timeline is unavailable", authority: AUTHORITY }; }
  const source = sourceFor(state, scoped);
  if (!source) return { blocked: true, reason: "session timeline is unavailable", authority: AUTHORITY };
  if (!await confirmedSourceEnrollment({ root, scoped, source, hostHome })) {
    return { blocked: true, reason: "session timeline is unavailable", authority: AUTHORITY };
  }
  const sourceDigest = sourceMetadata(source).sourceDigest;
  if (!invocationRequest || !await timelineTransportEnrollmentMatches({ root, binding: scoped, enrollmentDigest, transportDigest, hostHome })
    || !await consumeSessionTimelineInvocation({ root, tool: "search", binding: scoped, sourceDigest,
      request: invocationRequest, transportDigest })) {
    return { blocked: true, reason: "session timeline invocation is unavailable", authority: AUTHORITY };
  }
  const opened = await validatedHandle(source, hostHome);
  if (opened.status !== "open") return { blocked: true, reason: opened.reason, authority: AUTHORITY };
  try {
    const indexed = rankTimelineEvents(source.events
      .filter((event) => matchesTimelineEvent(event, wanted, target, boundedWindowSeconds * 1000)), wanted, target).slice(0, 8);
    const verified = [];
    for (const event of indexed) {
      const current = await verifyTimelineEvent({ handle: opened.handle, event, readRange, digest,
        eventFromLine: (line, offset) => eventFromTimelineLine(line, offset, AUTHORITY) });
      if (!current || !matchesTimelineEvent(current, wanted, target, boundedWindowSeconds * 1000)) return { blocked: true, reason: "timeline evidence changed", authority: AUTHORITY };
      verified.push(current);
    }
    if (verified.length) {
      if (!await unchangedHandle(opened.handle, source, hostHome)) return { blocked: true, reason: "transcript-changed", authority: AUTHORITY };
      return searchResult(source, target, wanted, "verified-index", verified);
    }
    if (!target) return searchResult(source, target, wanted, "verified-index", []);
    const sought = await seekTimelineEvidence({ handle: opened.handle, size: opened.size, target, wanted,
      windowMs: boundedWindowSeconds * 1000, readRange, eventFromLine: (line, offset) => eventFromTimelineLine(line, offset, AUTHORITY),
      extractTimestamp: extractTimelineTimestamp,
      matches: matchesTimelineEvent, rank: rankTimelineEvents });
    if (sought.status === "searched") {
      if (!await unchangedHandle(opened.handle, source, hostHome)) return { blocked: true, reason: "transcript-changed", authority: AUTHORITY };
      return searchResult(source, target, wanted, "timestamp-seek", sought.events, { budgetExhausted: sought.budgetExhausted });
    }
    if (sought.status === "out-of-range") return searchResult(source, target, wanted, "timestamp-seek", []);
    return { blocked: true, reason: sought.reason, authority: AUTHORITY };
  } finally { await opened.handle.close(); }
}
