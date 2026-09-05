import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { stateRoot } from "./paths.js";
import { sessionTimelineRootDigest } from "./session-timeline-root.js";
import { verifyWindowsTimelineDirectoryAcl, verifyWindowsTimelineFileAcl } from "./session-timeline-windows-acl.js";

const KEY_BYTES = 32;
const SIGNATURE_RE = /^[a-f0-9]{64}$/;
const HEAD_SCHEMA = "agentspine.session-timeline-head/v1";
const HEAD_MAX_BYTES = 64 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payload(state) {
  const { signature: _signature, ...unsigned } = state;
  return canonical(unsigned);
}

function privateMode(metadata) {
  return process.platform !== "win32" && (metadata.mode & 0o077n) !== 0n;
}

function unsafeDirectory(metadata) {
  return !metadata.isDirectory() || metadata.isSymbolicLink()
    || (process.platform !== "win32" && (metadata.mode & 0o022n) !== 0n);
}

function ownerMatches(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

async function stateDirectory(create) {
  const path = stateRoot();
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path, { bigint: true });
  if (unsafeDirectory(metadata)) throw new Error("session timeline state root is invalid");
  await verifyWindowsTimelineDirectoryAcl(path, { metadata, role: "parent" });
  return { path, metadata };
}

async function integrityDirectory(create) {
  const root = await stateDirectory(create);
  const path = join(root.path, "integrity");
  let created = false;
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  let metadata = await lstat(path, { bigint: true });
  await verifyWindowsTimelineDirectoryAcl(path, { created, metadata, role: "integrity" });
  metadata = await lstat(path, { bigint: true });
  if (unsafeDirectory(metadata) || privateMode(metadata) || !ownerMatches(metadata)) {
    throw new Error("session timeline integrity directory is invalid");
  }
  return { path, metadata, parent: root };
}

function sameDirectory(left, right) {
  return left.isDirectory() && right.isDirectory() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino;
}

async function assertStateDirectory(anchor) {
  const metadata = await lstat(anchor.path, { bigint: true });
  if (unsafeDirectory(metadata) || !sameDirectory(anchor.metadata, metadata)) {
    throw new Error("session timeline state root changed during operation");
  }
  await verifyWindowsTimelineDirectoryAcl(anchor.path, { metadata, role: "parent" });
  return metadata;
}

async function assertIntegrityDirectory(anchor) {
  await assertStateDirectory(anchor.parent);
  const metadata = await lstat(anchor.path, { bigint: true });
  if (unsafeDirectory(metadata) || privateMode(metadata) || !ownerMatches(metadata) || !sameDirectory(anchor.metadata, metadata)) {
    throw new Error("session timeline integrity directory changed during operation");
  }
  await verifyWindowsTimelineDirectoryAcl(anchor.path, { metadata, role: "integrity" });
  return metadata;
}

function keyPath(integrity) {
  return join(integrity.path, "session-timeline-signing.key");
}

function safePrivateFile(metadata, maximumBytes = null) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n
    && (maximumBytes === null || metadata.size <= BigInt(maximumBytes))
    && !privateMode(metadata) && ownerMatches(metadata);
}

async function verifyPrivateTimelineFile(path, metadata, role = "private", { created = false } = {}) {
  if (!safePrivateFile(metadata)) throw new Error("session timeline private file is invalid");
  await verifyWindowsTimelineFileAcl(path, { created, role });
}

async function verifyExistingPrivateTimelineFile(path, role = "private", maximumBytes = null) {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!safePrivateFile(metadata, maximumBytes)) throw new Error("session timeline private file is invalid");
    await verifyWindowsTimelineFileAcl(path, { role });
    return metadata;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function existingKey(path, integrity) {
  await assertIntegrityDirectory(integrity);
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || metadata.size !== BigInt(KEY_BYTES)
    || privateMode(metadata) || !ownerMatches(metadata)) {
    throw new Error("session timeline signing key is invalid");
  }
  await verifyWindowsTimelineFileAcl(path, { role: "key" });
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFile(metadata, before)) throw new Error("session timeline signing key is invalid");
    await verifyWindowsTimelineFileAcl(path, { role: "key" });
    const value = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || after.nlink !== 1n || value.byteLength !== KEY_BYTES) {
      throw new Error("session timeline signing key is invalid");
    }
    await verifyWindowsTimelineFileAcl(path, { role: "key" });
    await assertIntegrityDirectory(integrity);
    return value;
  } finally { await handle.close(); }
}

async function signingKey({ create }) {
  const integrity = await integrityDirectory(create);
  const path = keyPath(integrity);
  try { return await existingKey(path, integrity); }
  catch (error) {
    if (!create || error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(KEY_BYTES);
  try {
    await assertIntegrityDirectory(integrity);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(value);
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || metadata.size !== BigInt(KEY_BYTES)
        || privateMode(metadata) || !ownerMatches(metadata)) throw new Error("session timeline signing key is invalid");
    } finally { await handle.close(); }
    const metadata = await lstat(path, { bigint: true });
    await verifyPrivateTimelineFile(path, metadata, "key", { created: true });
    await assertIntegrityDirectory(integrity);
    return existingKey(path, integrity);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return existingKey(path, integrity);
  }
}

export async function ensureSessionTimelineTrust({ create = false } = {}) {
  const integrity = await integrityDirectory(create);
  try { await existingKey(keyPath(integrity), integrity); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (create) await signingKey({ create: true });
  }
}

function timelineFileRole(namespace) {
  if (namespace === "state") return "state";
  return namespace.endsWith("head") ? "head" : "private";
}

export async function sessionTimelinePrivatePaths(root, namespace, { create = true } = {}) {
  if (!/^[a-z-]{1,32}$/.test(namespace || "")) throw new Error("session timeline private namespace is invalid");
  const integrity = await integrityDirectory(create);
  const identifier = sessionTimelineRootDigest(root);
  const assertStable = () => assertIntegrityDirectory(integrity);
  const path = join(integrity.path, `session-timeline-${namespace}-${identifier}.json`);
  await assertStable();
  await verifyExistingPrivateTimelineFile(path, timelineFileRole(namespace));
  return {
    path,
    lock: join(integrity.path, `session-timeline-${namespace}-${identifier}.lock`),
    assertStable
  };
}

export function sessionTimelineStatePaths(root, options = {}) {
  return sessionTimelinePrivatePaths(root, "state", options);
}

function signature(value, key) {
  return createHmac("sha256", key).update(payload(value)).digest("hex");
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function sameFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function readAuthenticatedTimelineState(path, maximumBytes, assertStable = null) {
  await assertStable?.();
  const pathname = await lstat(path, { bigint: true });
  if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.nlink !== 1n || pathname.size > BigInt(maximumBytes)) {
    throw new Error("session timeline state is invalid");
  }
  await verifyWindowsTimelineFileAcl(path, { role: "private" });
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFile(pathname, before) || before.nlink !== 1n) throw new Error("session timeline state is invalid");
    await verifyWindowsTimelineFileAcl(path, { role: "private" });
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || after.nlink !== 1n || content.byteLength !== Number(after.size)) {
      throw new Error("session timeline state changed during read");
    }
    await verifyWindowsTimelineFileAcl(path, { role: "private" });
    await assertStable?.();
    return content.toString("utf8");
  } finally { await handle.close(); }
}

function headPath(integrity, root) {
  return join(integrity.path, `session-timeline-head-${sessionTimelineRootDigest(root)}.json`);
}

async function saveHead(integrity, root, stateSignature, assertOwned = null) {
  const path = headPath(integrity, root);
  await verifyExistingPrivateTimelineFile(path, "head", HEAD_MAX_BYTES);
  const head = { schema: HEAD_SCHEMA, rootDigest: sessionTimelineRootDigest(root), stateSignature, authority: "state-integrity-only" };
  head.signature = signature(head, await signingKey({ create: true }));
  const content = `${JSON.stringify(head)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await assertIntegrityDirectory(integrity);
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await verifyPrivateTimelineFile(temporary, await lstat(temporary, { bigint: true }), "head", { created: true });
    await replaceFileWithRetry(temporary, path, { beforeAttempt: async () => {
      await assertIntegrityDirectory(integrity); await assertOwned?.();
    } });
    await verifyPrivateTimelineFile(path, await lstat(path, { bigint: true }), "head");
    await assertIntegrityDirectory(integrity);
  }
  catch (error) {
    await unlink(temporary).catch((cleanup) => { if (cleanup.code !== "ENOENT") error.cleanupError = cleanup; });
    throw error;
  }
}

export async function recordSessionTimelineHead({ root, stateSignature, assertOwned = null }) {
  if (!SIGNATURE_RE.test(stateSignature || "")) throw new Error("session timeline state signature is invalid");
  const integrity = await integrityDirectory(true);
  await saveHead(integrity, root, stateSignature, assertOwned);
}

export async function sessionTimelineHeadExists({ root }) {
  let integrity;
  try { integrity = await integrityDirectory(false); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const path = headPath(integrity, root);
    await verifyExistingPrivateTimelineFile(path, "head", HEAD_MAX_BYTES);
    await lstat(path, { bigint: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function verifySessionTimelineHead({ root, stateSignature }) {
  let integrity;
  let head;
  try {
    integrity = await integrityDirectory(false);
    head = JSON.parse(await readAuthenticatedTimelineState(headPath(integrity, root), HEAD_MAX_BYTES,
      () => assertIntegrityDirectory(integrity)));
  }
  catch { throw new Error("session timeline state head is unavailable"); }
  if (head?.schema !== HEAD_SCHEMA || head.rootDigest !== sessionTimelineRootDigest(root) || !SIGNATURE_RE.test(head.stateSignature || "")
    || head.authority !== "state-integrity-only") throw new Error("session timeline state head is invalid");
  await verifySessionTimelineState(head);
  await assertIntegrityDirectory(integrity);
  if (head.stateSignature !== stateSignature) throw new Error("session timeline state replay was rejected");
}

export async function sealSessionTimelineState(state) {
  state.signature = signature(state, await signingKey({ create: true }));
  return state;
}

export async function verifySessionTimelineState(state) {
  if (!SIGNATURE_RE.test(state?.signature || "")) throw new Error("session timeline state authentication failed");
  const expected = Buffer.from(signature(state, await signingKey({ create: false })), "hex");
  const actual = Buffer.from(state.signature, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new Error("session timeline state authentication failed");
  }
  return state;
}
