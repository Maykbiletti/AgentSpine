import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyEnvelope } from "./authentication.js";
import { buildCatalog } from "./catalog.js";
import { isInside } from "./paths.js";
import { pullShared, readDirectoryExchange, validateSharedEvent } from "./sharing.js";

const SCHEMA = "agentspine.https-snapshot/v1";
const CONFIRMATION = "local-share-confirmed";
const MAX_EVENTS = 2000;
const MAX_SNAPSHOT_BYTES = 21 * 1024 * 1024;
const MAX_TOKEN_BYTES = 8192;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TOKEN_ENV_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

const blockedAddresses = new BlockList();
const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96],
  ["100::", 64], ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28],
  ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
]) blockedAddresses.addSubnet(network, prefix, "ipv6");

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
  return typeof value === "string" && value.length > 0 && Number.isFinite(new Date(value).getTime());
}

function withoutDigest(value) {
  const { digest: _digest, ...body } = value;
  return body;
}

function eventId(document) {
  const payload = document?.schema === "agentspine.signed-envelope/v1" ? document.payload : null;
  return payload?.id;
}

function eventFilename(id) {
  return `${createHash("sha256").update(id).digest("hex")}.json`;
}

export function validateHttpsEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("HTTPS snapshot URL is invalid");
  }
  if (endpoint.protocol !== "https:") throw new Error("HTTPS snapshots require an https:// URL");
  if (endpoint.username || endpoint.password) throw new Error("credentials must not be embedded in an HTTPS snapshot URL");
  if (endpoint.search || endpoint.hash) throw new Error("HTTPS snapshot URLs cannot contain a query or fragment");
  if (!endpoint.hostname || endpoint.pathname.endsWith("/")) {
    throw new Error("HTTPS snapshot URL must identify one explicit JSON resource");
  }
  return endpoint;
}

function addressBlocked(address) {
  const family = isIP(address);
  if (!family) throw new Error(`DNS returned an invalid address: ${address}`);
  if (family === 6 && !publicIpv6.check(address, "ipv6")) return true;
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
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

export async function resolveHttpsEndpoint(endpoint, {
  allowPrivateNetwork = false, lookup = dnsLookup
} = {}) {
  const parsed = endpoint instanceof URL ? endpoint : validateHttpsEndpoint(endpoint);
  const lookupHostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const literalFamily = isIP(lookupHostname);
  const answers = literalFamily
    ? [{ address: lookupHostname, family: literalFamily }]
    : await lookup(lookupHostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw new Error("HTTPS snapshot host did not resolve");
  for (const answer of answers) {
    if (!answer || isIP(answer.address) !== Number(answer.family)) throw new Error("HTTPS snapshot DNS result is invalid");
    if (!allowPrivateNetwork && addressBlocked(answer.address)) {
      throw new Error("HTTPS snapshot host resolves to a private, local, reserved, or documentation address");
    }
  }
  return {
    endpoint: parsed, lookupHostname,
    addresses: answers.map((answer) => ({ address: answer.address, family: Number(answer.family) }))
  };
}

function bearerToken(tokenEnv, environment) {
  if (tokenEnv === null || tokenEnv === undefined) return null;
  if (!TOKEN_ENV_RE.test(tokenEnv)) throw new Error("tokenEnv must be an uppercase environment variable name");
  const value = environment[tokenEnv];
  if (typeof value !== "string" || !value) throw new Error(`HTTPS snapshot token environment variable is missing: ${tokenEnv}`);
  if (Buffer.byteLength(value) > MAX_TOKEN_BYTES || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error("HTTPS snapshot bearer token is invalid");
  }
  return value;
}

export async function fetchHttpsSnapshot({
  url, tokenEnv = null, timeoutMs = 10000, allowPrivateNetwork = false,
  confirmation = null, environment = process.env, lookup = dnsLookup, request = httpsRequest
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error("HTTPS snapshot timeout must be between 1000 and 30000 milliseconds");
  }
  if (allowPrivateNetwork && confirmation !== CONFIRMATION) {
    throw new Error("private-network HTTPS access requires explicit local owner confirmation");
  }
  const resolved = await within(
    resolveHttpsEndpoint(validateHttpsEndpoint(url), { allowPrivateNetwork, lookup }),
    timeoutMs,
    "HTTPS snapshot DNS resolution timed out"
  );
  const token = bearerToken(tokenEnv, environment);
  const selected = resolved.addresses[0];
  const headers = {
    accept: "application/json",
    "accept-encoding": "identity",
    "user-agent": "AgentSpine/0.1 HTTPS snapshot transport"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = await new Promise((resolvePromise, rejectPromise) => {
    let deadline;
    const reject = (error) => {
      clearTimeout(deadline);
      rejectPromise(error);
    };
    const resolve = (value) => {
      clearTimeout(deadline);
      resolvePromise(value);
    };
    const requestOptions = {
      protocol: "https:", hostname: resolved.lookupHostname,
      port: resolved.endpoint.port || 443,
      path: resolved.endpoint.pathname, method: "GET", headers,
      agent: false, autoSelectFamily: false,
      servername: isIP(resolved.lookupHostname) ? undefined : resolved.lookupHostname,
      lookup: (_hostname, options, callback) => {
        const family = typeof options === "object" && options.family ? Number(options.family) : 0;
        const usable = family ? resolved.addresses.find((item) => item.family === family) : selected;
        if (!usable) return callback(new Error("no vetted DNS address matches the requested family"));
        return callback(null, usable.address, usable.family);
      }
    };
    const active = request(requestOptions, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error("HTTPS snapshot redirects are not followed"));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTPS snapshot request failed with status ${status}`));
        return;
      }
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/.test(contentType)) {
        response.resume();
        reject(new Error("HTTPS snapshot response must use an application/json content type"));
        return;
      }
      const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
      if (encoding !== "identity") {
        response.resume();
        reject(new Error("compressed HTTPS snapshots are rejected to keep byte limits exact"));
        return;
      }
      const declared = Number(response.headers["content-length"] || 0);
      if (declared && (!Number.isSafeInteger(declared) || declared > MAX_SNAPSHOT_BYTES)) {
        response.resume();
        reject(new Error("HTTPS snapshot exceeds the 21 MiB response limit"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_SNAPSHOT_BYTES) {
          active.destroy(new Error("HTTPS snapshot exceeds the 21 MiB response limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    active.setTimeout(timeoutMs, () => active.destroy(new Error("HTTPS snapshot request timed out")));
    deadline = setTimeout(() => active.destroy(new Error("HTTPS snapshot request timed out")), timeoutMs);
    active.on("error", reject);
    active.end();
  });
  let snapshot;
  try {
    snapshot = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("HTTPS snapshot response is not valid JSON");
  }
  return {
    snapshot: validateHttpsSnapshot(snapshot),
    endpoint: `${resolved.endpoint.origin}${resolved.endpoint.pathname}`,
    authenticatedRequest: Boolean(token)
  };
}

export function validateHttpsSnapshot(snapshot) {
  if (!exactKeys(snapshot, [
    "schema", "snapshotId", "scopeId", "adapterId", "generatedAt",
    "manifest", "events", "authority", "digest"
  ]) || snapshot.schema !== SCHEMA || !ID_RE.test(snapshot.snapshotId || "")
    || !ID_RE.test(snapshot.scopeId || "") || !ID_RE.test(snapshot.adapterId || "")
    || !validDate(snapshot.generatedAt) || snapshot.authority !== "context-only"
    || !DIGEST_RE.test(snapshot.digest || "") || digest(withoutDigest(snapshot)) !== snapshot.digest
    || !Array.isArray(snapshot.events) || snapshot.events.length > MAX_EVENTS) {
    throw new Error("HTTPS snapshot is invalid or has failed its integrity check");
  }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) {
    throw new Error("HTTPS snapshot exceeds the 21 MiB validation limit");
  }
  const verifiedManifest = verifyEnvelope(snapshot.manifest, "manifest");
  if (verifiedManifest.payload?.scopeId !== snapshot.scopeId
    || verifiedManifest.payload?.adapterId !== snapshot.adapterId
    || verifiedManifest.payload?.adapter !== "directory") {
    throw new Error("HTTPS snapshot metadata does not match its signed manifest");
  }
  const seen = new Map();
  for (const document of snapshot.events) {
    const verified = verifyEnvelope(document, "event");
    const event = validateSharedEvent(verified.payload, snapshot.scopeId);
    const previous = seen.get(event.id);
    if (previous && previous !== event.digest) throw new Error(`HTTPS snapshot event ID collision: ${event.id}`);
    if (previous) throw new Error(`HTTPS snapshot contains duplicate event: ${event.id}`);
    seen.set(event.id, event.digest);
  }
  return snapshot;
}

export async function exportHttpsSnapshot({
  root = process.cwd(), directory, output, snapshotId = `snapshot:${randomUUID()}`,
  confirmation, now = new Date()
}) {
  if (confirmation !== CONFIRMATION) throw new Error("HTTPS snapshot export requires explicit local owner confirmation");
  if (!ID_RE.test(snapshotId || "")) throw new Error("snapshotId must be a stable, whitespace-free identifier");
  if (!output || typeof output !== "string") throw new Error("HTTPS snapshot output path is required");
  const exchange = await readDirectoryExchange({ root, directory, requireAuthenticated: true });
  const generatedAt = new Date(now).toISOString();
  if (!validDate(generatedAt)) throw new Error("now must be a valid date");
  const body = {
    schema: SCHEMA, snapshotId, scopeId: exchange.scopeId, adapterId: exchange.adapterId,
    generatedAt, manifest: exchange.manifest, events: exchange.events,
    authority: "context-only"
  };
  const snapshot = validateHttpsSnapshot({ ...body, digest: digest(body) });
  const catalog = await buildCatalog(root);
  const target = resolve(output);
  if (isInside(catalog.root, target)) {
    throw new Error("HTTPS snapshot output must remain outside the scanned project");
  }
  let parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  parent = await realpath(parent);
  if (isInside(catalog.root, parent)) {
    throw new Error("HTTPS snapshot output must remain outside the scanned project");
  }
  try {
    await lstat(target);
    throw new Error("HTTPS snapshot output already exists; choose a new path");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new Error("HTTPS snapshot exceeds the 21 MiB export limit");
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    created: true, output: target, snapshotId: snapshot.snapshotId,
    scopeId: snapshot.scopeId, adapterId: snapshot.adapterId,
    events: snapshot.events.length, digest: snapshot.digest,
    authority: "context-only"
  };
}

export async function importHttpsSnapshot({ root = process.cwd(), snapshot, now = new Date() }) {
  const validated = validateHttpsSnapshot(structuredClone(snapshot));
  const directory = await mkdtemp(join(tmpdir(), "agentspine-https-snapshot-"));
  try {
    const eventsDirectory = join(directory, "events");
    await mkdir(eventsDirectory, { mode: 0o700 });
    await writeFile(
      join(directory, ".agentspine-exchange.json"),
      `${JSON.stringify(validated.manifest, null, 2)}\n`, { mode: 0o600 }
    );
    for (const document of validated.events) {
      const id = eventId(document);
      await writeFile(join(eventsDirectory, eventFilename(id)), `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600, flag: "wx"
      });
    }
    const result = await pullShared({ root, directory, requireAuthenticated: true, now });
    return {
      ...result, transport: "https-snapshot", snapshotId: validated.snapshotId,
      snapshotDigest: validated.digest, authority: "context-only"
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function pullHttpsSnapshot(options) {
  const fetched = await fetchHttpsSnapshot(options);
  const imported = await importHttpsSnapshot({ root: options.root, snapshot: fetched.snapshot, now: options.now });
  return {
    ...imported, endpoint: fetched.endpoint,
    authenticatedRequest: fetched.authenticatedRequest
  };
}
