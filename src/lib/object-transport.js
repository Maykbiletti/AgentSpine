import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  buildHttpsSnapshot, fetchHttpsSnapshot, resolveHttpsEndpoint, validateHttpsSnapshot
} from "./https-transport.js";

const CONFIRMATION = "local-share-confirmed";
const MAX_TOKEN_BYTES = 8192;
const MAX_RESPONSE_BYTES = 16 * 1024;
const TOKEN_ENV_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function bearerToken(tokenEnv, environment) {
  if (tokenEnv === null || tokenEnv === undefined) return null;
  if (!TOKEN_ENV_RE.test(tokenEnv)) throw new Error("tokenEnv must be an uppercase environment variable name");
  const value = environment[tokenEnv];
  if (typeof value !== "string" || !value) {
    throw new Error(`HTTPS object token environment variable is missing: ${tokenEnv}`);
  }
  if (Buffer.byteLength(value) > MAX_TOKEN_BYTES || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error("HTTPS object bearer token is invalid");
  }
  return value;
}

function timeout(value) {
  if (!Number.isInteger(value) || value < 1000 || value > 30000) {
    throw new Error("HTTPS object timeout must be between 1000 and 30000 milliseconds");
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

export function validateHttpsObjectBase(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("HTTPS object base URL is invalid");
  }
  if (endpoint.protocol !== "https:") throw new Error("HTTPS object publishing requires an https:// URL");
  if (endpoint.username || endpoint.password) {
    throw new Error("credentials must not be embedded in an HTTPS object base URL");
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error("HTTPS object base URLs cannot contain a query or fragment");
  }
  if (!endpoint.hostname || /%(?:2f|5c)/i.test(endpoint.pathname)) {
    throw new Error("HTTPS object base URL contains an ambiguous path");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return endpoint;
}

export function httpsObjectUrl(baseUrl, snapshotDigest) {
  if (!DIGEST_RE.test(snapshotDigest || "")) throw new Error("snapshot digest is invalid");
  const endpoint = validateHttpsObjectBase(baseUrl);
  endpoint.pathname = `${endpoint.pathname}/objects/${snapshotDigest}.json`;
  return endpoint.toString();
}

async function upload({
  url, body, digest, token, timeoutMs, allowPrivateNetwork, lookup, request
}) {
  const resolved = await within(
    resolveHttpsEndpoint(url, { allowPrivateNetwork, lookup }),
    timeoutMs,
    "HTTPS object DNS resolution timed out"
  );
  const selected = resolved.addresses[0];
  const headers = {
    accept: "application/json",
    "accept-encoding": "identity",
    "content-length": String(body.length),
    "content-type": "application/vnd.agentspine.snapshot+json",
    "if-none-match": "*",
    "user-agent": "AgentSpine/0.1 HTTPS object transport",
    "x-agentspine-digest": `sha256:${digest}`
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolvePromise, rejectPromise) => {
    let deadline;
    let settled = false;
    const reject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      rejectPromise(error);
    };
    const resolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolvePromise(value);
    };
    const options = {
      protocol: "https:", hostname: resolved.lookupHostname,
      port: resolved.endpoint.port || 443,
      path: resolved.endpoint.pathname, method: "PUT", headers,
      agent: false, autoSelectFamily: false,
      servername: isIP(resolved.lookupHostname) ? undefined : resolved.lookupHostname,
      lookup: (_hostname, lookupOptions, callback) => {
        const family = typeof lookupOptions === "object" && lookupOptions.family
          ? Number(lookupOptions.family) : 0;
        const usable = family
          ? resolved.addresses.find((item) => item.family === family)
          : selected;
        if (!usable) return callback(new Error("no vetted DNS address matches the requested family"));
        return callback(null, usable.address, usable.family);
      }
    };
    const active = request(options, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && status !== 412) {
        response.resume();
        reject(new Error("HTTPS object redirects are not followed"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          active.destroy(new Error("HTTPS object response exceeds the 16 KiB limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (![201, 204, 412].includes(status)) {
          reject(new Error(`HTTPS object publish failed with status ${status}`));
          return;
        }
        resolve({ status, responseBytes: bytes });
      });
      response.on("error", reject);
    });
    active.setTimeout(timeoutMs, () => active.destroy(new Error("HTTPS object publish timed out")));
    deadline = setTimeout(() => active.destroy(new Error("HTTPS object publish timed out")), timeoutMs);
    active.on("error", reject);
    active.end(body);
  });
}

export async function putHttpsSnapshot({
  baseUrl, snapshot, tokenEnv = null, timeoutMs = 10000,
  allowPrivateNetwork = false, confirmation = null,
  environment = process.env, lookup = dnsLookup, request = httpsRequest
}) {
  if (confirmation !== CONFIRMATION) {
    throw new Error("HTTPS object publishing requires explicit local owner confirmation");
  }
  timeout(timeoutMs);
  const validated = validateHttpsSnapshot(structuredClone(snapshot));
  const objectUrl = httpsObjectUrl(baseUrl, validated.digest);
  const token = bearerToken(tokenEnv, environment);
  const body = Buffer.from(JSON.stringify(validated));
  const result = await upload({
    url: objectUrl, body, digest: validated.digest, token, timeoutMs,
    allowPrivateNetwork, lookup, request
  });
  const fetched = await fetchHttpsSnapshot({
    url: objectUrl, tokenEnv, timeoutMs, allowPrivateNetwork,
    confirmation, environment, lookup, request
  });
  if (fetched.snapshot.digest !== validated.digest) {
    throw new Error("HTTPS object read-back does not match the published snapshot");
  }
  return {
    created: result.status !== 412,
    alreadyExisted: result.status === 412,
    verified: true,
    objectUrl,
    snapshotId: validated.snapshotId,
    snapshotDigest: validated.digest,
    scopeId: validated.scopeId,
    adapterId: validated.adapterId,
    events: validated.events.length,
    authenticatedWrite: Boolean(token),
    authority: "context-only"
  };
}

export async function publishHttpsSnapshot({
  root = process.cwd(), directory, baseUrl, snapshotId, now = new Date(), ...options
}) {
  if (options.confirmation !== CONFIRMATION) {
    throw new Error("HTTPS object publishing requires explicit local owner confirmation");
  }
  const snapshot = await buildHttpsSnapshot({ root, directory, snapshotId, now });
  return putHttpsSnapshot({ baseUrl, snapshot, ...options });
}
