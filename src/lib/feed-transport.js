import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  assertTrustedIdentity, loadTrust, signEnvelope, verifyEnvelope
} from "./authentication.js";
import { buildCatalog } from "./catalog.js";
import {
  buildHttpsSnapshot, fetchHttpsSnapshot, importHttpsSnapshot, resolveHttpsEndpoint
} from "./https-transport.js";
import {
  httpsObjectUrl, putHttpsSnapshot, validateHttpsObjectBase
} from "./object-transport.js";
import { isInside, projectStateDir } from "./paths.js";

const SCHEMA = "agentspine.feed/v1";
const STATE_SCHEMA = "agentspine.feed-state/v1";
const CONFIRMATION = "local-share-confirmed";
const MAX_ENTRIES = 256;
const MAX_FEED_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN_BYTES = 8192;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ETAG_RE = /^"[^"\r\n]{1,128}"$/;
const TOKEN_ENV_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function isoDate(value, field = "date") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function bearerToken(tokenEnv, environment) {
  if (tokenEnv === null || tokenEnv === undefined) return null;
  if (!TOKEN_ENV_RE.test(tokenEnv)) throw new Error("tokenEnv must be an uppercase environment variable name");
  const value = environment[tokenEnv];
  if (typeof value !== "string" || !value) throw new Error(`HTTPS feed token environment variable is missing: ${tokenEnv}`);
  if (Buffer.byteLength(value) > MAX_TOKEN_BYTES || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error("HTTPS feed bearer token is invalid");
  }
  return value;
}

function timeout(value) {
  if (!Number.isInteger(value) || value < 1000 || value > 30000) {
    throw new Error("HTTPS feed timeout must be between 1000 and 30000 milliseconds");
  }
  return value;
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function httpsFeedUrl(baseUrl, feedId) {
  if (!ID_RE.test(feedId || "")) throw new Error("feedId must be a stable, whitespace-free identifier");
  const endpoint = validateHttpsObjectBase(baseUrl);
  const name = createHash("sha256").update(feedId).digest("hex");
  endpoint.pathname = `${endpoint.pathname}/feeds/${name}.json`;
  return endpoint.toString();
}

function validateEntry(entry) {
  if (!exactKeys(entry, [
    "sequence", "snapshotId", "snapshotDigest", "previousDigest", "publishedAt", "authority", "digest"
  ]) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1
    || !ID_RE.test(entry.snapshotId || "") || !DIGEST_RE.test(entry.snapshotDigest || "")
    || !(entry.previousDigest === null || DIGEST_RE.test(entry.previousDigest))
    || !validDate(entry.publishedAt) || entry.authority !== "context-only"
    || !DIGEST_RE.test(entry.digest || "")) {
    throw new Error("HTTPS feed entry is invalid");
  }
  const { digest: _digest, ...body } = entry;
  if (digest(body) !== entry.digest) throw new Error("HTTPS feed entry failed its integrity check");
  return entry;
}

export function validateHttpsFeed(envelope) {
  const verified = verifyEnvelope(envelope, "manifest");
  const feed = verified.payload;
  if (!exactKeys(feed, [
    "schema", "feedId", "scopeId", "adapterId", "sequence", "entries", "authority", "digest"
  ]) || feed.schema !== SCHEMA || !ID_RE.test(feed.feedId || "")
    || !ID_RE.test(feed.scopeId || "") || !ID_RE.test(feed.adapterId || "")
    || !Number.isSafeInteger(feed.sequence) || feed.sequence < 1
    || !Array.isArray(feed.entries) || feed.entries.length < 1 || feed.entries.length > MAX_ENTRIES
    || feed.authority !== "context-only" || !DIGEST_RE.test(feed.digest || "")) {
    throw new Error("HTTPS feed is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_FEED_BYTES) throw new Error("HTTPS feed exceeds 256 KiB");
  const { digest: _digest, ...body } = feed;
  if (digest(body) !== feed.digest) throw new Error("HTTPS feed failed its integrity check");
  let previous = null;
  for (const entry of feed.entries) {
    validateEntry(entry);
    if (previous) {
      if (entry.sequence !== previous.sequence + 1 || entry.previousDigest !== previous.digest) {
        throw new Error("HTTPS feed hash chain is broken");
      }
    } else if (entry.sequence === 1 && entry.previousDigest !== null) {
      throw new Error("HTTPS feed genesis entry cannot have a predecessor");
    } else if (entry.sequence > 1 && entry.previousDigest === null) {
      throw new Error("truncated HTTPS feed window must retain its predecessor digest");
    }
    previous = entry;
  }
  if (previous.sequence !== feed.sequence) throw new Error("HTTPS feed sequence does not match its latest entry");
  return { envelope, feed, authentication: verified.authentication, publicIdentity: verified.publicIdentity };
}

function nextFeedBody({ current, feedId, snapshot, publishedAt }) {
  if (current && (current.feedId !== feedId || current.scopeId !== snapshot.scopeId
    || current.adapterId !== snapshot.adapterId)) {
    throw new Error("HTTPS feed identity does not match the snapshot");
  }
  const latest = current?.entries.at(-1) || null;
  const entryBody = {
    sequence: (latest?.sequence || 0) + 1,
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.digest,
    previousDigest: latest?.digest || null,
    publishedAt,
    authority: "context-only"
  };
  const entry = { ...entryBody, digest: digest(entryBody) };
  const entries = [...(current?.entries || []), entry].slice(-MAX_ENTRIES);
  const body = {
    schema: SCHEMA, feedId, scopeId: snapshot.scopeId, adapterId: snapshot.adapterId,
    sequence: entry.sequence, entries, authority: "context-only"
  };
  return { ...body, digest: digest(body) };
}

async function resolvedRequest({
  url, method, headers, body = null, timeoutMs, allowPrivateNetwork, lookup, request, accepted
}) {
  const resolved = await within(
    resolveHttpsEndpoint(url, { allowPrivateNetwork, lookup }), timeoutMs,
    "HTTPS feed DNS resolution timed out"
  );
  const selected = resolved.addresses[0];
  return new Promise((resolvePromise, rejectPromise) => {
    let deadline;
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      operation(value);
    };
    const options = {
      protocol: "https:", hostname: resolved.lookupHostname,
      port: resolved.endpoint.port || 443, path: resolved.endpoint.pathname,
      method, headers, agent: false, autoSelectFamily: false,
      servername: isIP(resolved.lookupHostname) ? undefined : resolved.lookupHostname,
      lookup: (_hostname, lookupOptions, callback) => {
        const family = typeof lookupOptions === "object" && lookupOptions.family
          ? Number(lookupOptions.family) : 0;
        const usable = family ? resolved.addresses.find((item) => item.family === family) : selected;
        if (!usable) return callback(new Error("no vetted DNS address matches the requested family"));
        return callback(null, usable.address, usable.family);
      }
    };
    const active = request(options, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && status !== 304) {
        response.resume();
        finish(rejectPromise, new Error("HTTPS feed redirects are not followed"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_FEED_BYTES) active.destroy(new Error("HTTPS feed exceeds 256 KiB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (!accepted.includes(status)) {
          finish(rejectPromise, new Error(`HTTPS feed request failed with status ${status}`));
          return;
        }
        finish(resolvePromise, { status, headers: response.headers, body: Buffer.concat(chunks) });
      });
      response.on("error", (error) => finish(rejectPromise, error));
    });
    active.setTimeout(timeoutMs, () => active.destroy(new Error("HTTPS feed request timed out")));
    deadline = setTimeout(() => active.destroy(new Error("HTTPS feed request timed out")), timeoutMs);
    active.on("error", (error) => finish(rejectPromise, error));
    active.end(body);
  });
}

export async function fetchHttpsFeed({
  baseUrl, feedId, tokenEnv = null, timeoutMs = 10000, allowPrivateNetwork = false,
  confirmation = null, environment = process.env, lookup = dnsLookup, request = httpsRequest,
  allowMissing = false
}) {
  timeout(timeoutMs);
  if (allowPrivateNetwork && confirmation !== CONFIRMATION) {
    throw new Error("private-network HTTPS feed access requires explicit local owner confirmation");
  }
  const token = bearerToken(tokenEnv, environment);
  const url = httpsFeedUrl(baseUrl, feedId);
  const headers = {
    accept: "application/vnd.agentspine.feed+json", "accept-encoding": "identity",
    "user-agent": "AgentSpine/0.1 HTTPS feed transport"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await resolvedRequest({
    url, method: "GET", headers, timeoutMs, allowPrivateNetwork, lookup, request,
    accepted: allowMissing ? [200, 404] : [200]
  });
  if (response.status === 404) return { missing: true, url, authenticatedRequest: Boolean(token) };
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/.test(contentType)) {
    throw new Error("HTTPS feed response must use an application/json content type");
  }
  if (String(response.headers["content-encoding"] || "identity").toLowerCase() !== "identity") {
    throw new Error("compressed HTTPS feeds are rejected");
  }
  const etag = String(response.headers.etag || "");
  if (!ETAG_RE.test(etag)) throw new Error("HTTPS feed response requires one strong ETag");
  let envelope;
  try { envelope = JSON.parse(response.body.toString("utf8")); } catch { throw new Error("HTTPS feed response is not valid JSON"); }
  const validated = validateHttpsFeed(envelope);
  if (validated.feed.feedId !== feedId) throw new Error("HTTPS feed resource has the wrong feedId");
  return { ...validated, missing: false, etag, url, authenticatedRequest: Boolean(token) };
}

async function putFeed({ baseUrl, feedId, envelope, etag, options }) {
  const token = bearerToken(options.tokenEnv, options.environment);
  const body = Buffer.from(JSON.stringify(envelope));
  if (body.length > MAX_FEED_BYTES) throw new Error("HTTPS feed exceeds 256 KiB");
  const headers = {
    accept: "application/json", "accept-encoding": "identity",
    "content-length": String(body.length), "content-type": "application/vnd.agentspine.feed+json",
    "user-agent": "AgentSpine/0.1 HTTPS feed transport"
  };
  if (etag) headers["if-match"] = etag;
  else headers["if-none-match"] = "*";
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    return await resolvedRequest({
      url: httpsFeedUrl(baseUrl, feedId), method: "PUT", headers, body,
      timeoutMs: options.timeoutMs, allowPrivateNetwork: options.allowPrivateNetwork,
      lookup: options.lookup, request: options.request, accepted: etag ? [200, 204] : [201, 204]
    });
  } catch (error) {
    if (/status 412/.test(error.message)) throw new Error("HTTPS feed changed concurrently; fetch and retry");
    throw error;
  }
}

export async function publishHttpsFeed({
  root = process.cwd(), directory, baseUrl, feedId, signerId,
  snapshotId = `snapshot:${randomUUID()}`, now = new Date(), tokenEnv = null,
  timeoutMs = 10000, allowPrivateNetwork = false, confirmation = null,
  environment = process.env, lookup = dnsLookup, request = httpsRequest
}) {
  if (confirmation !== CONFIRMATION) throw new Error("HTTPS feed publishing requires explicit local owner confirmation");
  if (!ID_RE.test(signerId || "")) throw new Error("signerId is required for HTTPS feed publishing");
  timeout(timeoutMs);
  const publishedAt = isoDate(now, "now");
  const snapshot = await buildHttpsSnapshot({ root, directory, snapshotId, now });
  const transportOptions = {
    tokenEnv, timeoutMs, allowPrivateNetwork, confirmation, environment, lookup, request
  };
  const object = await putHttpsSnapshot({ baseUrl, snapshot, ...transportOptions });
  const current = await fetchHttpsFeed({ baseUrl, feedId, allowMissing: true, ...transportOptions });
  if (!current.missing && current.authentication.signerId !== signerId) {
    throw new Error("HTTPS feed signer cannot change during publication");
  }
  const feed = nextFeedBody({ current: current.feed, feedId, snapshot, publishedAt });
  const envelope = await signEnvelope({ root, signerId, kind: "manifest", payload: feed, now });
  if (!current.missing && current.publicIdentity.keyId !== envelope.signer.keyId) {
    throw new Error("HTTPS feed signing key cannot change; use a new feedId after key rotation");
  }
  await putFeed({ baseUrl, feedId, envelope, etag: current.etag || null, options: transportOptions });
  const verified = await fetchHttpsFeed({ baseUrl, feedId, ...transportOptions });
  if (verified.feed.digest !== feed.digest || verified.authentication.signerId !== signerId) {
    throw new Error("HTTPS feed read-back does not match the published chain tip");
  }
  return {
    createdFeed: current.missing, sequence: feed.sequence, feedId, feedDigest: feed.digest,
    entryDigest: feed.entries.at(-1).digest, snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.digest, objectUrl: object.objectUrl, feedUrl: verified.url,
    objectCreated: object.created, verified: true, authenticatedWrite: Boolean(bearerToken(tokenEnv, environment)),
    authority: "context-only"
  };
}

function emptyState(root) {
  return { schema: STATE_SCHEMA, root, feeds: [], history: [] };
}

function validateReceipt(record) {
  return exactKeys(record, [
    "feedId", "scopeId", "adapterId", "sequence", "entryDigest", "snapshotDigest",
    "signerId", "keyId", "observedAt", "authority"
  ]) && ID_RE.test(record.feedId || "") && ID_RE.test(record.scopeId || "")
    && ID_RE.test(record.adapterId || "") && Number.isSafeInteger(record.sequence) && record.sequence >= 1
    && DIGEST_RE.test(record.entryDigest || "") && DIGEST_RE.test(record.snapshotDigest || "")
    && ID_RE.test(record.signerId || "") && ID_RE.test(record.keyId || "")
    && validDate(record.observedAt) && record.authority === "context-only";
}

function validateState(state, root) {
  if (!exactKeys(state, ["schema", "root", "feeds", "history"]) || state.schema !== STATE_SCHEMA
    || state.root !== root || !Array.isArray(state.feeds) || !Array.isArray(state.history)
    || state.feeds.some((item) => !validateReceipt(item)) || state.history.some((item) => !validateReceipt(item))) {
    throw new Error("HTTPS feed state is invalid");
  }
  if (new Set(state.feeds.map((item) => item.feedId)).size !== state.feeds.length) {
    throw new Error("HTTPS feed state contains duplicate feeds");
  }
  return state;
}

async function feedStatePaths(root) {
  const catalog = await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  if (isInside(catalog.root, directory)) throw new Error("HTTPS feed state must remain outside the scanned project");
  return { root: catalog.root, path: join(directory, "feed-state.json") };
}

async function readState(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("HTTPS feed state exceeds 4 MiB");
    return validateState(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyState(root);
  }
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { return { handle: await open(lockPath, "wx", 0o600), lockPath }; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 90000) await unlink(lockPath);
      } catch (lockError) { if (lockError.code !== "ENOENT") throw lockError; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error("HTTPS feed state is busy; retry shortly");
}

async function saveState(path, state) {
  validateState(state, state.root);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("HTTPS feed state exceeds 4 MiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function assessFeed(feed, receipt) {
  const latest = feed.entries.at(-1);
  if (!receipt) return { latest, unchanged: false };
  if (receipt.scopeId !== feed.scopeId || receipt.adapterId !== feed.adapterId) {
    throw new Error("HTTPS feed scope or adapter changed");
  }
  if (latest.sequence < receipt.sequence) throw new Error("HTTPS feed rollback detected");
  if (latest.sequence === receipt.sequence) {
    if (latest.digest !== receipt.entryDigest || latest.snapshotDigest !== receipt.snapshotDigest) {
      throw new Error("HTTPS feed equivocation detected at an observed sequence");
    }
    return { latest, unchanged: true };
  }
  const anchor = feed.entries.findIndex((entry) => (
    entry.sequence === receipt.sequence && entry.digest === receipt.entryDigest
  ));
  if (anchor < 0) throw new Error("HTTPS feed continuity window no longer contains the last observed entry");
  return { latest, unchanged: false };
}

export async function loadHttpsFeedState(root = process.cwd()) {
  const paths = await feedStatePaths(root);
  return { state: await readState(paths.path, paths.root), statePath: paths.path };
}

export async function inspectHttpsFeedState(root = process.cwd()) {
  const paths = await feedStatePaths(root);
  try {
    return { state: await readState(paths.path, paths.root), statePath: paths.path, error: null };
  } catch (error) {
    return { state: emptyState(paths.root), statePath: paths.path, error: error.message };
  }
}

export async function pullHttpsFeed({
  root = process.cwd(), baseUrl, feedId, now = new Date(), tokenEnv = null,
  timeoutMs = 10000, allowPrivateNetwork = false, confirmation = null,
  environment = process.env, lookup = dnsLookup, request = httpsRequest
}) {
  const observedAt = isoDate(now, "now");
  const options = {
    baseUrl, feedId, tokenEnv, timeoutMs, allowPrivateNetwork,
    confirmation, environment, lookup, request
  };
  const remote = await fetchHttpsFeed(options);
  const { trust } = await loadTrust(root);
  assertTrustedIdentity(remote.publicIdentity, trust);
  const paths = await feedStatePaths(root);
  const { handle, lockPath } = await acquireLock(paths.path);
  try {
    const state = await readState(paths.path, paths.root);
    const existing = state.feeds.find((item) => item.feedId === feedId) || null;
    if (existing && (existing.signerId !== remote.publicIdentity.signerId
      || existing.keyId !== remote.publicIdentity.keyId)) {
      throw new Error("HTTPS feed signing identity changed; use a new feedId after key rotation");
    }
    const assessment = assessFeed(remote.feed, existing);
    if (assessment.unchanged) {
      return {
        changed: false, feedId, sequence: existing.sequence,
        snapshotDigest: existing.snapshotDigest, statePath: paths.path,
        authenticatedRequest: remote.authenticatedRequest, authority: "context-only"
      };
    }
    const objectUrl = httpsObjectUrl(baseUrl, assessment.latest.snapshotDigest);
    const fetched = await fetchHttpsSnapshot({
      url: objectUrl, tokenEnv, timeoutMs, allowPrivateNetwork,
      confirmation, environment, lookup, request
    });
    if (fetched.snapshot.digest !== assessment.latest.snapshotDigest
      || fetched.snapshot.snapshotId !== assessment.latest.snapshotId
      || fetched.snapshot.scopeId !== remote.feed.scopeId
      || fetched.snapshot.adapterId !== remote.feed.adapterId) {
      throw new Error("HTTPS feed snapshot does not match its signed entry");
    }
    const imported = await importHttpsSnapshot({ root: paths.root, snapshot: fetched.snapshot, now });
    const receipt = {
      feedId, scopeId: remote.feed.scopeId, adapterId: remote.feed.adapterId,
      sequence: assessment.latest.sequence, entryDigest: assessment.latest.digest,
      snapshotDigest: assessment.latest.snapshotDigest,
      signerId: remote.publicIdentity.signerId, keyId: remote.publicIdentity.keyId,
      observedAt, authority: "context-only"
    };
    if (existing) state.history.push(existing);
    state.feeds = [...state.feeds.filter((item) => item.feedId !== feedId), receipt]
      .sort((a, b) => a.feedId.localeCompare(b.feedId));
    await saveState(paths.path, state);
    return {
      ...imported, changed: true, feedId, sequence: receipt.sequence,
      entryDigest: receipt.entryDigest, snapshotDigest: receipt.snapshotDigest,
      feedUrl: remote.url, objectUrl, statePath: paths.path,
      authenticatedRequest: remote.authenticatedRequest, authority: "context-only"
    };
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
