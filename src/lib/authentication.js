import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID,
  sign as cryptoSign, verify as cryptoVerify
} from "node:crypto";
import {
  chmod, lstat, mkdir, open, readFile, stat, unlink, writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { isInside, projectId, projectStateDir, stateRoot } from "./paths.js";

const AUTH_CONFIRMATION = "local-share-confirmed";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{80,96}={0,2}$/;
const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_IDENTITY_BYTES = 16 * 1024;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;

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

function isoDate(value, field = "date") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function requireConfirmation(confirmation) {
  if (confirmation !== AUTH_CONFIRMATION) throw new Error("signer and trust changes require explicit local owner confirmation");
}

function emptyRegistry() {
  return { schema: "agentspine.signers/v1", signers: [], history: [] };
}

function emptyTrust(root) {
  return { schema: "agentspine.sharing-trust/v1", root, records: [], history: [] };
}

function publicIdentityBody({ signerId, publicKey, createdAt }) {
  const keyBytes = Buffer.from(publicKey, "base64");
  return {
    schema: "agentspine.signer/v1",
    signerId,
    keyId: `ed25519:${createHash("sha256").update(keyBytes).digest("hex")}`,
    algorithm: "Ed25519",
    publicKey,
    createdAt,
    authority: "context-only"
  };
}

export function validatePublicIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || !exactKeys(identity, ["schema", "signerId", "keyId", "algorithm", "publicKey", "createdAt", "authority", "digest"])
    || identity.schema !== "agentspine.signer/v1" || !ID_RE.test(identity.signerId || "")
    || !ID_RE.test(identity.keyId || "") || identity.algorithm !== "Ed25519"
    || typeof identity.publicKey !== "string" || identity.publicKey.length > 1024
    || !validDate(identity.createdAt) || identity.authority !== "context-only"
    || !DIGEST_RE.test(identity.digest || "")) {
    throw new Error("public signing identity is invalid");
  }
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(identity.publicKey, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error("public signing identity contains an invalid Ed25519 key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("public signing identity must use Ed25519");
  const body = { ...identity };
  delete body.digest;
  const expected = publicIdentityBody({ signerId: identity.signerId, publicKey: identity.publicKey, createdAt: identity.createdAt });
  if (identity.keyId !== expected.keyId || identity.digest !== digest(body)) {
    throw new Error("public signing identity failed its fingerprint or integrity check");
  }
  return identity;
}

function registryFindings(registry) {
  const findings = [];
  if (!exactKeys(registry, ["schema", "signers", "history"])
    || registry.schema !== "agentspine.signers/v1" || !Array.isArray(registry.signers)
    || !Array.isArray(registry.history)) return ["invalid-signer-registry"];
  const ids = new Set();
  const keys = new Set();
  for (const record of registry.signers) {
    try { validatePublicIdentity(record.publicIdentity); } catch { findings.push(`invalid-signer:${record?.signerId || "unknown"}`); }
    if (!exactKeys(record, ["signerId", "keyId", "publicIdentity", "createdAt", "authority"])
      || record.signerId !== record.publicIdentity?.signerId || record.keyId !== record.publicIdentity?.keyId
      || record.createdAt !== record.publicIdentity?.createdAt || record.authority !== "context-only") {
      findings.push(`invalid-signer-record:${record?.signerId || "unknown"}`);
    }
    if (ids.has(record.signerId)) findings.push(`duplicate-signer:${record.signerId}`);
    if (keys.has(record.keyId)) findings.push(`duplicate-signer-key:${record.keyId}`);
    ids.add(record.signerId); keys.add(record.keyId);
  }
  for (const entry of registry.history) {
    if (!exactKeys(entry, ["kind", "signerId", "keyId", "replacedAt", "value", "authority"])
      || entry.kind !== "signer-rotation" || entry.signerId !== entry.value?.signerId
      || entry.keyId !== entry.value?.keyId || !validDate(entry.replacedAt)
      || entry.authority !== "context-only") findings.push(`invalid-signer-history:${entry?.signerId || "unknown"}`);
    try { validatePublicIdentity(entry.value); } catch { findings.push(`invalid-retired-signer:${entry?.signerId || "unknown"}`); }
  }
  return [...new Set(findings)];
}

export function trustFindings(trust) {
  const findings = [];
  if (!exactKeys(trust, ["schema", "root", "records", "history"])
    || trust.schema !== "agentspine.sharing-trust/v1" || typeof trust.root !== "string"
    || !Array.isArray(trust.records) || !Array.isArray(trust.history)) return ["invalid-sharing-trust"];
  const keys = new Set();
  for (const record of trust.records) {
    try { validatePublicIdentity(record.publicIdentity); } catch { findings.push(`invalid-trusted-signer:${record?.keyId || "unknown"}`); }
    if (!validTrustRecord(record)) findings.push(`invalid-trust-record:${record?.keyId || "unknown"}`);
    if (keys.has(record.keyId)) findings.push(`duplicate-trusted-key:${record.keyId}`);
    keys.add(record.keyId);
  }
  for (const entry of trust.history) {
    if (!exactKeys(entry, ["kind", "keyId", "changedAt", "value", "authority"])
      || entry.kind !== "trust-record" || entry.keyId !== entry.value?.keyId
      || !validDate(entry.changedAt) || entry.authority !== "context-only") {
      findings.push(`invalid-trust-history:${entry?.keyId || "unknown"}`);
    }
    if (!validTrustRecord(entry.value)) findings.push(`invalid-historical-trust:${entry?.keyId || "unknown"}`);
    try { validatePublicIdentity(entry.value?.publicIdentity); } catch { findings.push(`invalid-historical-trusted-signer:${entry?.keyId || "unknown"}`); }
  }
  return [...new Set(findings)];
}

function validTrustRecord(record) {
  if (!exactKeys(record, ["signerId", "keyId", "publicIdentity", "status", "addedAt", "revokedAt", "reason", "confirmation", "authority"])
    || record.signerId !== record.publicIdentity?.signerId || record.keyId !== record.publicIdentity?.keyId
    || !new Set(["trusted", "revoked"]).has(record.status) || !validDate(record.addedAt)
    || record.confirmation !== "local-owner" || record.authority !== "context-only") return false;
  if (record.status === "trusted") return record.revokedAt === null && record.reason === null;
  return validDate(record.revokedAt) && typeof record.reason === "string" && Boolean(record.reason.trim());
}

async function authPaths(root, providedCatalog = null, { allowInside = false, create = true } = {}) {
  const catalog = providedCatalog || await buildCatalog(root);
  const globalRoot = resolve(stateRoot());
  const signerDirectory = join(globalRoot, "signers");
  if (!allowInside && isInside(catalog.root, signerDirectory)) throw new Error("signing identity state must remain outside the scanned project");
  if (create) await mkdir(join(signerDirectory, "private"), { recursive: true, mode: 0o700 });
  const projectDirectory = create
    ? await projectStateDir(catalog.root)
    : join(globalRoot, "projects", projectId(catalog.root));
  return {
    catalog,
    signerDirectory,
    registryPath: join(signerDirectory, "registry.json"),
    trustPath: join(projectDirectory, "sharing-trust.json")
  };
}

async function readBoundedJson(path, fallback, normalize) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_AUTH_BYTES) throw new Error("authentication state exceeds the 2 MiB read limit");
    const value = JSON.parse(await readFile(path, "utf8"));
    return normalize(value);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return fallback();
  }
}

async function atomicWrite(path, value, mode = 0o600) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_AUTH_BYTES) throw new Error("authentication state exceeds 2 MiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  await replaceFileWithRetry(temporary, path);
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return { handle: await open(lockPath, "wx", 0o600), lockPath };
    } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error("authentication state is busy; retry shortly");
}

async function mutate(path, read, findings, operation) {
  const { handle, lockPath } = await acquireLock(path);
  try {
    const state = await read();
    const before = findings(state);
    if (before.length) throw new Error(`authentication state failed closed: ${before.join(", ")}`);
    const result = await operation(state);
    const after = findings(state);
    if (after.length) throw new Error(`authentication mutation failed closed: ${after.join(", ")}`);
    await atomicWrite(path, state);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function normalizeRegistry(value) {
  const findings = registryFindings(value);
  if (findings.length) throw new Error(`signer registry is invalid: ${findings.join(", ")}`);
  return value;
}

function normalizeTrust(value, root) {
  if (value?.root !== root) throw new Error("sharing trust state belongs to another project");
  const findings = trustFindings(value);
  if (findings.length) throw new Error(`sharing trust state is invalid: ${findings.join(", ")}`);
  return value;
}

function privatePath(directory, keyId) {
  return join(directory, "private", `${createHash("sha256").update(keyId).digest("hex")}.pem`);
}

export async function generateSigningIdentity({
  root = process.cwd(), signerId, rotate = false, publicOut = null,
  confirmation, now = new Date()
}) {
  requireConfirmation(confirmation);
  if (!ID_RE.test(signerId || "")) throw new Error("signerId must be a stable, whitespace-free identifier");
  const publicTarget = publicOut ? resolve(publicOut) : null;
  if (publicTarget) {
    try {
      await lstat(publicTarget);
      throw new Error(`public identity output already exists: ${publicTarget}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const paths = await authPaths(root);
  const createdAt = isoDate(now, "now");
  const result = await mutate(
    paths.registryPath,
    () => readBoundedJson(paths.registryPath, emptyRegistry, normalizeRegistry),
    registryFindings,
    async (registry) => {
      const existing = registry.signers.find((record) => record.signerId === signerId);
      if (existing && !rotate) throw new Error(`signer already exists: ${signerId}; use explicit rotation`);
      const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { format: "der", type: "spki" },
        privateKeyEncoding: { format: "pem", type: "pkcs8" }
      });
      const body = publicIdentityBody({ signerId, publicKey: publicKey.toString("base64"), createdAt });
      const publicIdentity = { ...body, digest: digest(body) };
      validatePublicIdentity(publicIdentity);
      const path = privatePath(paths.signerDirectory, publicIdentity.keyId);
      await writeFile(path, privateKey, { flag: "wx", mode: 0o600 });
      await chmod(path, 0o600);
      if (existing) {
        registry.history.push({
          kind: "signer-rotation", signerId, keyId: existing.keyId, replacedAt: createdAt,
          value: existing.publicIdentity, authority: "context-only"
        });
      }
      const record = { signerId, keyId: publicIdentity.keyId, publicIdentity, createdAt, authority: "context-only" };
      registry.signers = [...registry.signers.filter((item) => item.signerId !== signerId), record]
        .sort((a, b) => a.signerId.localeCompare(b.signerId));
      return { signerId, keyId: record.keyId, publicIdentity, retiredKeyId: existing?.keyId || null };
    }
  );
  if (result.retiredKeyId) await unlink(privatePath(paths.signerDirectory, result.retiredKeyId)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (publicOut) {
    await mkdir(dirname(publicTarget), { recursive: true, mode: 0o700 });
    await writeFile(publicTarget, `${JSON.stringify(result.publicIdentity, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  }
  return { ...result, publicOut: publicTarget, authority: "context-only" };
}

export async function listSigningIdentities({ root = process.cwd() } = {}) {
  const paths = await authPaths(root);
  const registry = await readBoundedJson(paths.registryPath, emptyRegistry, normalizeRegistry);
  return {
    schema: registry.schema,
    signers: registry.signers.map((record) => record.publicIdentity),
    retired: registry.history.map((entry) => entry.value),
    authority: "context-only"
  };
}

export async function inspectSignerRegistry(root = process.cwd(), providedCatalog = null) {
  const paths = await authPaths(root, providedCatalog, { allowInside: true, create: false });
  try {
    const registry = await readBoundedJson(paths.registryPath, emptyRegistry, normalizeRegistry);
    const errors = [];
    for (const record of registry.signers) {
      const path = privatePath(paths.signerDirectory, record.keyId);
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PUBLIC_IDENTITY_BYTES) {
          errors.push(`invalid-private-key-file:${record.signerId}`);
          continue;
        }
        if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) errors.push(`unsafe-private-key-mode:${record.signerId}`);
        const privateKey = createPrivateKey(await readFile(path, "utf8"));
        const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
        if (privateKey.asymmetricKeyType !== "ed25519" || publicKey !== record.publicIdentity.publicKey) {
          errors.push(`private-public-key-mismatch:${record.signerId}`);
        }
      } catch (error) {
        errors.push(`unreadable-private-key:${record.signerId}:${error.code || "invalid"}`);
      }
    }
    return { registry, registryPath: paths.registryPath, signerDirectory: paths.signerDirectory, errors, catalog: paths.catalog };
  } catch (error) {
    return {
      registry: emptyRegistry(), registryPath: paths.registryPath, signerDirectory: paths.signerDirectory,
      errors: [`unreadable-registry:${error.message}`], catalog: paths.catalog
    };
  }
}

async function activeIdentity(root, signerId) {
  const paths = await authPaths(root);
  const registry = await readBoundedJson(paths.registryPath, emptyRegistry, normalizeRegistry);
  const record = registry.signers.find((item) => item.signerId === signerId);
  if (!record) throw new Error(`unknown local signer: ${signerId}`);
  const path = privatePath(paths.signerDirectory, record.keyId);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("signing private key must be a regular file");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("signing private key permissions are too broad");
  const privateKey = createPrivateKey(await readFile(path, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing private key is not Ed25519");
  return { publicIdentity: record.publicIdentity, privateKey };
}

export async function signEnvelope({ root = process.cwd(), signerId, kind, payload, now = new Date() }) {
  if (!new Set(["manifest", "event"]).has(kind)) throw new Error("signed envelope kind must be manifest or event");
  const identity = await activeIdentity(root, signerId);
  const body = {
    schema: "agentspine.signed-envelope/v1",
    kind,
    signer: identity.publicIdentity,
    payload,
    signedAt: isoDate(now, "now"),
    authority: "context-only"
  };
  const signature = cryptoSign(null, Buffer.from(canonical(body)), identity.privateKey).toString("base64");
  return { ...body, signature };
}

export function verifyEnvelope(envelope, expectedKind = null) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || !exactKeys(envelope, ["schema", "kind", "signer", "payload", "signedAt", "authority", "signature"])
    || envelope.schema !== "agentspine.signed-envelope/v1"
    || !new Set(["manifest", "event"]).has(envelope.kind)
    || (expectedKind !== null && envelope.kind !== expectedKind)
    || !validDate(envelope.signedAt) || envelope.authority !== "context-only"
    || !SIGNATURE_RE.test(envelope.signature || "")) {
    throw new Error("signed envelope structure is invalid");
  }
  validatePublicIdentity(envelope.signer);
  const body = { ...envelope };
  delete body.signature;
  const key = createPublicKey({ key: Buffer.from(envelope.signer.publicKey, "base64"), format: "der", type: "spki" });
  if (!cryptoVerify(null, Buffer.from(canonical(body)), key, Buffer.from(envelope.signature, "base64"))) {
    throw new Error("signed envelope signature is invalid");
  }
  return {
    payload: envelope.payload,
    authentication: {
      mode: "signed",
      signerId: envelope.signer.signerId,
      keyId: envelope.signer.keyId,
      signedAt: envelope.signedAt,
      verifiedAt: null,
      signature: envelope.signature,
      authority: "context-only"
    },
    publicIdentity: envelope.signer
  };
}

export async function loadTrust(root = process.cwd(), providedCatalog = null) {
  const paths = await authPaths(root, providedCatalog);
  const trust = await readBoundedJson(
    paths.trustPath,
    () => emptyTrust(paths.catalog.root),
    (value) => normalizeTrust(value, paths.catalog.root)
  );
  return { trust, trustPath: paths.trustPath, catalog: paths.catalog };
}

export async function inspectTrust(root = process.cwd(), providedCatalog = null) {
  const paths = await authPaths(root, providedCatalog, { allowInside: true, create: false });
  try {
    const trust = await readBoundedJson(
      paths.trustPath, () => emptyTrust(paths.catalog.root),
      (value) => normalizeTrust(value, paths.catalog.root)
    );
    return { trust, trustPath: paths.trustPath, catalog: paths.catalog, error: null };
  } catch (error) {
    return { trust: emptyTrust(paths.catalog.root), trustPath: paths.trustPath, catalog: paths.catalog, error: error.message };
  }
}

async function trustMutation(root, operation) {
  const paths = await authPaths(root);
  return mutate(
    paths.trustPath,
    () => readBoundedJson(paths.trustPath, () => emptyTrust(paths.catalog.root), (value) => normalizeTrust(value, paths.catalog.root)),
    trustFindings,
    (trust) => operation(trust, paths)
  );
}

export async function trustSigner({ root = process.cwd(), publicIdentityPath, confirmation, now = new Date() }) {
  requireConfirmation(confirmation);
  if (!publicIdentityPath || typeof publicIdentityPath !== "string") throw new Error("public identity path is required");
  const target = resolve(publicIdentityPath);
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PUBLIC_IDENTITY_BYTES) {
    throw new Error("public identity must be a regular JSON file smaller than 16 KiB");
  }
  const publicIdentity = validatePublicIdentity(JSON.parse(await readFile(target, "utf8")));
  const addedAt = isoDate(now, "now");
  return trustMutation(root, (trust, paths) => {
    const existing = trust.records.find((record) => record.keyId === publicIdentity.keyId);
    if (existing?.status === "trusted") return { created: false, record: existing, trustPath: paths.trustPath };
    if (existing?.status === "revoked") throw new Error("a revoked key cannot be silently trusted again; import a rotated key");
    const record = {
      signerId: publicIdentity.signerId, keyId: publicIdentity.keyId, publicIdentity,
      status: "trusted", addedAt, revokedAt: null, reason: null,
      confirmation: "local-owner", authority: "context-only"
    };
    trust.records.push(record);
    trust.records.sort((a, b) => a.signerId.localeCompare(b.signerId) || a.keyId.localeCompare(b.keyId));
    return { created: true, record, trustPath: paths.trustPath };
  });
}

export async function revokeTrustedSigner({ root = process.cwd(), keyId, reason, confirmation, now = new Date() }) {
  requireConfirmation(confirmation);
  if (!ID_RE.test(keyId || "")) throw new Error("keyId is required");
  if (!reason || typeof reason !== "string" || !reason.trim()) throw new Error("revocation reason is required");
  if (SECRET_RE.test(reason)) throw new Error("revocation reason appears to contain a secret");
  const revokedAt = isoDate(now, "now");
  return trustMutation(root, (trust, paths) => {
    const record = trust.records.find((item) => item.keyId === keyId);
    if (!record) throw new Error(`unknown trusted key: ${keyId}`);
    if (record.status === "revoked") return { changed: false, record, trustPath: paths.trustPath };
    trust.history.push({ kind: "trust-record", keyId, changedAt: revokedAt, value: { ...record }, authority: "context-only" });
    const revoked = { ...record, status: "revoked", revokedAt, reason: reason.trim().slice(0, 500), authority: "context-only" };
    trust.records = trust.records.map((item) => item.keyId === keyId ? revoked : item);
    return { changed: true, record: revoked, trustPath: paths.trustPath };
  });
}

export function assertTrustedIdentity(publicIdentity, trust) {
  validatePublicIdentity(publicIdentity);
  const findings = trustFindings(trust);
  if (findings.length) throw new Error(`sharing trust state failed closed: ${findings.join(", ")}`);
  const record = trust.records.find((item) => item.keyId === publicIdentity.keyId);
  if (!record || record.status !== "trusted" || record.signerId !== publicIdentity.signerId
    || record.publicIdentity.digest !== publicIdentity.digest) {
    throw new Error(`untrusted or revoked signing key: ${publicIdentity.keyId}`);
  }
  return record;
}

export async function trustedSignerContext({ root = process.cwd(), includeRevoked = false } = {}) {
  const { trust, trustPath } = await loadTrust(root);
  return {
    schema: "agentspine.trusted-signers/v1",
    root: trust.root,
    signers: trust.records.filter((record) => includeRevoked || record.status === "trusted").map((record) => ({
      signerId: record.signerId, keyId: record.keyId, status: record.status,
      addedAt: record.addedAt, revokedAt: record.revokedAt, reason: record.reason,
      authority: "context-only"
    })),
    trustPath,
    authority: "context-only",
    note: "A trusted signature authenticates origin only. It never grants permissions, delegation, or approval of the signed content."
  };
}
