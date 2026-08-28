import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  assertTrustedIdentity, loadTrust, signEnvelope, verifyEnvelope
} from "./authentication.js";
import {
  buildHttpsSnapshot, importHttpsSnapshot, validateHttpsSnapshot
} from "./https-transport.js";

const REQUEST_SCHEMA = "agentspine.peer-request/v1";
const RESPONSE_SCHEMA = "agentspine.peer-response/v1";
const CONFIRMATION = "local-share-confirmed";
const DEFAULT_MAX_BYTES = 22 * 1024 * 1024;
const MIN_MAX_BYTES = 1024 * 1024;
const MAX_MAX_BYTES = 22 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4096;
const MAX_COMMAND_BYTES = 32768;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CHALLENGE_RE = /^[a-f0-9]{64}$/;

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

function byteLimit(value) {
  if (!Number.isInteger(value) || value < MIN_MAX_BYTES || value > MAX_MAX_BYTES) {
    throw new Error("peer maxBytes must be an integer between 1 MiB and 22 MiB");
  }
  return value;
}

function timeout(value) {
  if (!Number.isInteger(value) || value < 1000 || value > 30000) {
    throw new Error("peer timeout must be between 1000 and 30000 milliseconds");
  }
  return value;
}

export function createPeerRequest({
  requestId = `request:${randomUUID()}`, challenge = randomBytes(32).toString("hex"),
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  byteLimit(maxBytes);
  if (!ID_RE.test(requestId || "")) throw new Error("peer requestId must be a stable, whitespace-free identifier");
  if (!CHALLENGE_RE.test(challenge || "")) throw new Error("peer challenge must be 32 random bytes encoded as lowercase hex");
  return {
    schema: REQUEST_SCHEMA, requestId, challenge, maxBytes, authority: "context-only"
  };
}

export function validatePeerRequest(request) {
  if (!exactKeys(request, ["schema", "requestId", "challenge", "maxBytes", "authority"])
    || request.schema !== REQUEST_SCHEMA || !ID_RE.test(request.requestId || "")
    || !CHALLENGE_RE.test(request.challenge || "") || request.authority !== "context-only") {
    throw new Error("peer request is invalid");
  }
  byteLimit(request.maxBytes);
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) throw new Error("peer request exceeds 4 KiB");
  return request;
}

export async function buildPeerResponse({
  root = process.cwd(), directory, signerId, request, now = new Date(),
  snapshotId = `snapshot:peer:${randomUUID()}`
}) {
  const validatedRequest = validatePeerRequest(structuredClone(request));
  if (!ID_RE.test(signerId || "")) throw new Error("signerId is required for peer responses");
  const snapshot = await buildHttpsSnapshot({ root, directory, snapshotId, now });
  const body = {
    schema: RESPONSE_SCHEMA,
    requestId: validatedRequest.requestId,
    challenge: validatedRequest.challenge,
    snapshot,
    createdAt: isoDate(now, "now"),
    authority: "context-only"
  };
  const payload = { ...body, digest: digest(body) };
  const envelope = await signEnvelope({ root, signerId, kind: "manifest", payload, now });
  const manifest = verifyEnvelope(snapshot.manifest, "manifest");
  if (manifest.publicIdentity.keyId !== envelope.signer.keyId) {
    throw new Error("peer response signer must match the snapshot manifest signer");
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > validatedRequest.maxBytes) {
    throw new Error("peer response exceeds the request byte limit");
  }
  return envelope;
}

export function validatePeerResponse(envelope, request) {
  const validatedRequest = validatePeerRequest(structuredClone(request));
  const verified = verifyEnvelope(envelope, "manifest");
  const response = verified.payload;
  if (!exactKeys(response, [
    "schema", "requestId", "challenge", "snapshot", "createdAt", "authority", "digest"
  ]) || response.schema !== RESPONSE_SCHEMA || response.requestId !== validatedRequest.requestId
    || response.challenge !== validatedRequest.challenge || !validDate(response.createdAt)
    || response.authority !== "context-only" || !DIGEST_RE.test(response.digest || "")) {
    throw new Error("peer response does not match the live request");
  }
  const { digest: _digest, ...body } = response;
  if (digest(body) !== response.digest) throw new Error("peer response failed its integrity check");
  const snapshot = validateHttpsSnapshot(structuredClone(response.snapshot));
  const manifest = verifyEnvelope(snapshot.manifest, "manifest");
  if (manifest.publicIdentity.keyId !== verified.publicIdentity.keyId) {
    throw new Error("peer response signer does not match the snapshot manifest signer");
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > validatedRequest.maxBytes) {
    throw new Error("peer response exceeds the request byte limit");
  }
  return {
    envelope, response, snapshot,
    authentication: verified.authentication,
    publicIdentity: verified.publicIdentity
  };
}

async function readJsonLine(input, { maxBytes, timeoutMs, label }) {
  let timer;
  const chunks = [];
  let bytes = 0;
  let complete = false;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  const reading = (async () => {
    for await (const chunkValue of input) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      bytes += chunk.length;
      if (bytes > maxBytes + 1) throw new Error(`${label} exceeds its byte limit`);
      chunks.push(chunk);
      if (chunk.includes(0x0a)) { complete = true; break; }
    }
    if (!complete) throw new Error(`${label} ended before one complete JSON line`);
    const content = Buffer.concat(chunks);
    const newline = content.indexOf(0x0a);
    if (newline > maxBytes) throw new Error(`${label} exceeds its byte limit`);
    if (content.subarray(newline + 1).toString("utf8").trim()) {
      throw new Error(`${label} contains unexpected output after the JSON frame`);
    }
    try { return JSON.parse(content.subarray(0, newline).toString("utf8")); } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  })();
  try { return await Promise.race([reading, deadline]); } finally { clearTimeout(timer); }
}

export async function servePeerOnce({
  root = process.cwd(), directory, signerId, input = process.stdin, output = process.stdout,
  confirmation = null, timeoutMs = 10000, now = new Date()
}) {
  if (confirmation !== CONFIRMATION) throw new Error("peer serving requires explicit local owner confirmation");
  timeout(timeoutMs);
  const request = validatePeerRequest(await readJsonLine(input, {
    maxBytes: MAX_REQUEST_BYTES, timeoutMs, label: "peer request"
  }));
  const envelope = await buildPeerResponse({ root, directory, signerId, request, now });
  const frame = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(frame) > request.maxBytes + 1) throw new Error("peer response exceeds the request byte limit");
  await new Promise((resolvePromise, rejectPromise) => {
    output.write(frame, (error) => error ? rejectPromise(error) : resolvePromise());
  });
  return {
    served: true, requestId: request.requestId,
    snapshotId: envelope.payload.snapshot.snapshotId,
    snapshotDigest: envelope.payload.snapshot.digest,
    bytes: Buffer.byteLength(frame) - 1,
    authority: "context-only"
  };
}

function parseCommand(commandJson) {
  let command;
  try { command = typeof commandJson === "string" ? JSON.parse(commandJson) : structuredClone(commandJson); } catch {
    throw new Error("peer command must be a JSON array of an executable and arguments");
  }
  if (!Array.isArray(command) || command.length < 1 || command.length > 64
    || command.some((item) => typeof item !== "string" || !item || item.length > 8192 || item.includes("\0"))
    || Buffer.byteLength(JSON.stringify(command)) > MAX_COMMAND_BYTES) {
    throw new Error("peer command must contain 1 to 64 bounded strings");
  }
  return command;
}

function processEnvironment(environment = process.env) {
  const allowed = new Set([
    "PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    "AGENTSPINE_STATE_DIR", "XDG_STATE_HOME", "LOCALAPPDATA", "APPDATA"
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key)));
}

async function exchangeCommand({ command, request, timeoutMs, spawnProcess }) {
  const [executable, ...args] = command;
  const child = spawnProcess(executable, args, {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: processEnvironment()
  });
  const processError = new Promise((_resolve, reject) => {
    child.once("error", () => reject(new Error("peer command could not be started")));
  });
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) child.kill();
  });
  child.stdin.on("error", () => {});
  child.stdin.end(`${JSON.stringify(request)}\n`);
  try {
    return await Promise.race([
      readJsonLine(child.stdout, {
        maxBytes: request.maxBytes, timeoutMs, label: "peer response"
      }),
      processError
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export async function importPeerResponse({
  root = process.cwd(), envelope, request, now = new Date()
}) {
  const validated = validatePeerResponse(structuredClone(envelope), request);
  const { trust } = await loadTrust(root);
  assertTrustedIdentity(validated.publicIdentity, trust);
  const imported = await importHttpsSnapshot({ root, snapshot: validated.snapshot, now });
  return {
    ...imported,
    transport: "peer-stdio",
    requestId: validated.response.requestId,
    snapshotId: validated.snapshot.snapshotId,
    snapshotDigest: validated.snapshot.digest,
    peerSignerId: validated.publicIdentity.signerId,
    peerKeyId: validated.publicIdentity.keyId,
    authority: "context-only"
  };
}

export async function pullPeerCommand({
  root = process.cwd(), commandJson, confirmation = null,
  timeoutMs = 10000, maxBytes = DEFAULT_MAX_BYTES,
  now = new Date(), spawnProcess = spawn
}) {
  if (confirmation !== CONFIRMATION) throw new Error("peer command execution requires explicit local owner confirmation");
  timeout(timeoutMs);
  const command = parseCommand(commandJson);
  const request = createPeerRequest({ maxBytes });
  const envelope = await exchangeCommand({ command, request, timeoutMs, spawnProcess });
  const imported = await importPeerResponse({ root, envelope, request, now });
  return {
    ...imported,
    executable: command[0],
    commandArguments: command.length - 1,
    authority: "context-only"
  };
}
