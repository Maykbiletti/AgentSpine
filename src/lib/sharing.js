import { createHash, randomUUID } from "node:crypto";
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { loadGraph } from "./graph.js";
import { learningFindings, loadLearning } from "./learning.js";
import { isInside, projectStateDir } from "./paths.js";
import {
  assertTrustedIdentity, loadTrust, signEnvelope, trustFindings, verifyEnvelope
} from "./authentication.js";

const KINDS = new Set(["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference"]);
const PRIVACY = new Set(["shared", "group"]);
const STATUSES = new Set(["pending", "accepted", "rejected", "superseded", "rolled-back"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_ADAPTER_EVENTS = 2000;
const MAX_ADAPTER_BYTES = 20 * 1024 * 1024;
const CONFIRMATION = "local-share-confirmed";
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const AUTHORITY_RE = /\b(?:user|agent|person|they|he|she|i|ich|wir|nutzer|benutzer).{0,60}\b(?:may|can|is allowed|is authorized|has|have|darf|berechtigt|hat|haben).{0,50}\b(?:admin(?:istrator)?|permissions?|rights?|authorization|production access|deploy|billing|spending|policy exception|bypass|zugang|rechte|berechtigung|produktion|abrechnung|ausnahme|umgehen)\b/i;

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

function withoutDigest(value) {
  const { digest: _digest, ...rest } = value;
  return rest;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeText(value, field, maximum) {
  if (!value || typeof value !== "string") throw new Error(`${field} is required`);
  const result = value.trim().slice(0, maximum);
  if (!result) throw new Error(`${field} is required`);
  if (SECRET_RE.test(result)) throw new Error(`${field} appears to contain a secret and cannot enter shared memory`);
  return result;
}

function safeClaim(value) {
  const result = safeText(value, "claim", 1000);
  if (AUTHORITY_RE.test(result)) throw new Error("authority and access claims cannot enter shared memory");
  return result;
}

function date(value, field = "date") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function validDateValue(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(new Date(value).getTime());
}

function integer(value, field, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  return result;
}

function emptySharing(root) {
  return {
    schema: "agentspine.sharing/v1",
    root,
    instanceId: `instance:${randomUUID()}`,
    config: { maxContextItems: 12 },
    records: [],
    history: []
  };
}

function normalizeSharing(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "agentspine.sharing/v1" || value.root !== root
    || !ID_RE.test(value.instanceId || "") || !value.config || typeof value.config !== "object"
    || !Array.isArray(value.records) || !value.records.every((item) => item && typeof item === "object")
    || !Array.isArray(value.history) || !value.history.every((item) => item && typeof item === "object")) {
    throw new Error("sharing state structure is invalid; run the audit before using shared memory");
  }
  return value;
}

function validConfig(config) {
  return Number.isInteger(config?.maxContextItems) && config.maxContextItems >= 1 && config.maxContextItems <= 50;
}

async function readJson(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("sharing state exceeds the 5 MiB read limit");
    return normalizeSharing(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptySharing(root);
  }
}

async function writeJson(path, state) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("sharing state exceeds 5 MiB; reject or delete old imports first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    });
    throw error;
  }
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
  throw new Error("sharing state is busy; retry shortly");
}

async function withLock(path, read, task, save = true) {
  const { handle, lockPath } = await acquireLock(path);
  try {
    const value = await read();
    const result = await task(value);
    if (save) await writeJson(path, value);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function sharingPaths(root, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return { catalog, sharingPath: join(directory, "sharing.json") };
}

export async function loadSharing(root = process.cwd(), providedCatalog = null) {
  const paths = await sharingPaths(root, providedCatalog);
  return { sharing: await readJson(paths.sharingPath, paths.catalog.root), ...paths };
}

export async function inspectSharing(root = process.cwd(), providedCatalog = null) {
  const paths = await sharingPaths(root, providedCatalog);
  try {
    return { sharing: await readJson(paths.sharingPath, paths.catalog.root), error: null, ...paths };
  } catch (error) {
    return { sharing: emptySharing(paths.catalog.root), error: error.message, ...paths };
  }
}

function preserve(state, value, now) {
  state.history.push({
    kind: "shared-record",
    recordId: value.event.id,
    supersededAt: now,
    privacy: value.event.privacy,
    value: { ...value, authority: "context-only" },
    authority: "context-only"
  });
}

async function mutation(root, operation) {
  const paths = await sharingPaths(root);
  const { graph } = await loadGraph(paths.catalog.root, paths.catalog);
  return withLock(
    paths.sharingPath,
    () => readJson(paths.sharingPath, paths.catalog.root),
    async (state) => {
      if (!validConfig(state.config)) throw new Error("sharing configuration is invalid; run the audit before using shared memory");
      const findings = sharingFindings(state, graph);
      if (findings.length) throw new Error(`sharing state failed closed: ${findings.join(", ")}`);
      const result = await operation(state, paths.catalog, paths.sharingPath, graph);
      const resultFindings = sharingFindings(state, graph);
      if (resultFindings.length) throw new Error(`sharing mutation failed closed: ${resultFindings.join(", ")}`);
      return result;
    }
  );
}

function requireConfirmation(confirmation) {
  if (confirmation !== CONFIRMATION) throw new Error("shared adapter writes require explicit local owner confirmation");
}

function manifestBody({ adapterId, scopeId, createdAt }) {
  return {
    schema: "agentspine.directory-adapter/v1",
    adapter: "directory",
    adapterId,
    scopeId,
    createdAt,
    authority: "context-only"
  };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || !exactKeys(manifest, ["schema", "adapter", "adapterId", "scopeId", "createdAt", "authority", "digest"])
    || manifest.schema !== "agentspine.directory-adapter/v1" || manifest.adapter !== "directory"
    || !ID_RE.test(manifest.adapterId || "") || !ID_RE.test(manifest.scopeId || "")
    || manifest.authority !== "context-only" || !validDateValue(manifest.createdAt)
    || !DIGEST_RE.test(manifest.digest || "") || digest(withoutDigest(manifest)) !== manifest.digest) {
    throw new Error("directory adapter manifest is invalid or has failed its integrity check");
  }
  return manifest;
}

function validateAuthentication(authentication) {
  return authentication === null || authentication === undefined || (
    exactKeys(authentication, ["mode", "signerId", "keyId", "signedAt", "verifiedAt", "signature", "authority"])
    && authentication.mode === "signed" && ID_RE.test(authentication.signerId || "")
    && ID_RE.test(authentication.keyId || "") && validDateValue(authentication.signedAt)
    && validDateValue(authentication.verifiedAt) && typeof authentication.signature === "string"
    && authentication.signature.length >= 80 && authentication.signature.length <= 96
    && authentication.authority === "context-only"
  );
}

async function assertRegularFile(path, field) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${field} must be a regular file, not a symlink`);
  return metadata;
}

async function adapterLocation(root, directory, create = false) {
  if (!directory || typeof directory !== "string") throw new Error("adapter directory is required");
  const target = resolve(directory);
  if (isInside(root, target)) throw new Error("shared adapter directory must remain outside the scanned project");
  if (create) {
    let ancestor = target;
    const missing = [];
    while (true) {
      try {
        ancestor = await realpath(ancestor);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.push(basename(ancestor));
        ancestor = parent;
      }
    }
    const prospective = resolve(ancestor, ...missing.reverse());
    if (isInside(root, prospective)) throw new Error("shared adapter directory must remain outside the scanned project");
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
  const canonicalDirectory = await realpath(target);
  if (isInside(root, canonicalDirectory)) throw new Error("shared adapter directory must remain outside the scanned project");
  return canonicalDirectory;
}

async function openAdapter(root, directory) {
  const adapterDirectory = await adapterLocation(root, directory, false);
  const manifestPath = join(adapterDirectory, ".agentspine-exchange.json");
  const metadata = await assertRegularFile(manifestPath, "adapter manifest");
  if (metadata.size > MAX_EVENT_BYTES) throw new Error("adapter manifest exceeds 64 KiB");
  const manifestDocument = JSON.parse(await readFile(manifestPath, "utf8"));
  let manifest;
  let authentication = null;
  let publicIdentity = null;
  if (manifestDocument?.schema === "agentspine.signed-envelope/v1") {
    const verified = verifyEnvelope(manifestDocument, "manifest");
    manifest = validateManifest(verified.payload);
    authentication = verified.authentication;
    publicIdentity = verified.publicIdentity;
  } else {
    manifest = validateManifest(manifestDocument);
  }
  const eventsDirectory = join(adapterDirectory, "events");
  const eventsMetadata = await lstat(eventsDirectory);
  if (!eventsMetadata.isDirectory() || eventsMetadata.isSymbolicLink()) throw new Error("adapter events path must be a real directory");
  return {
    adapterDirectory, manifestPath, manifest, manifestDocument,
    eventsDirectory, authentication, publicIdentity
  };
}

export async function initDirectoryAdapter({
  root = process.cwd(), directory, scopeId, adapterId = `adapter:${randomUUID()}`,
  signerId = null, confirmation, now = new Date()
}) {
  requireConfirmation(confirmation);
  if (!ID_RE.test(scopeId || "")) throw new Error("scopeId must be a stable, whitespace-free identifier");
  if (!ID_RE.test(adapterId || "")) throw new Error("adapterId must be a stable, whitespace-free identifier");
  const catalog = await buildCatalog(root);
  const adapterDirectory = await adapterLocation(catalog.root, directory, true);
  const manifestPath = join(adapterDirectory, ".agentspine-exchange.json");
  const eventsDirectory = join(adapterDirectory, "events");
  await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });
  const lockTarget = join(adapterDirectory, ".agentspine-adapter");
  return withLock(lockTarget, async () => ({}), async () => {
    try {
      await assertRegularFile(manifestPath, "adapter manifest");
      const existingDocument = JSON.parse(await readFile(manifestPath, "utf8"));
      const verified = existingDocument?.schema === "agentspine.signed-envelope/v1"
        ? verifyEnvelope(existingDocument, "manifest") : null;
      const existing = validateManifest(verified ? verified.payload : existingDocument);
      if (existing.scopeId !== scopeId) throw new Error(`adapter already belongs to scope ${existing.scopeId}`);
      if (signerId && verified?.publicIdentity.signerId !== signerId) throw new Error("adapter is signed by a different identity");
      return {
        created: false, manifest: existing, signed: Boolean(verified),
        signer: verified?.publicIdentity || null, adapterDirectory, manifestPath
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const body = manifestBody({ adapterId, scopeId, createdAt: date(now, "now") });
    const manifest = { ...body, digest: digest(body) };
    const document = signerId
      ? await signEnvelope({ root: catalog.root, signerId, kind: "manifest", payload: manifest, now })
      : manifest;
    const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, manifestPath);
    return {
      created: true, manifest, signed: Boolean(signerId),
      signer: document.signer || null, adapterDirectory, manifestPath
    };
  }, false);
}

function eventBody({
  id, scopeId, originInstanceId, candidate, supersedesEventId, publishedAt
}) {
  const proof = candidate.review || candidate.promotion;
  return {
    schema: "agentspine.shared-event/v1",
    id,
    scopeId,
    originInstanceId,
    kind: candidate.kind,
    claim: candidate.claim,
    subjectId: candidate.subjectId,
    privacy: candidate.privacy,
    groupId: candidate.groupId,
    confidence: candidate.confidence,
    source: {
      type: "accepted-learning",
      learningId: candidate.id,
      acceptedAt: candidate.acceptedAt,
      automatic: candidate.automatic,
      evidenceCount: candidate.evidence.length,
      reviewDigest: digest(proof || {})
    },
    supersedesEventId,
    publishedAt,
    authority: "context-only"
  };
}

export function validateSharedEvent(event, expectedScopeId = null) {
  if (!event || typeof event !== "object" || Array.isArray(event)
    || !exactKeys(event, [
      "schema", "id", "scopeId", "originInstanceId", "kind", "claim", "subjectId", "privacy",
      "groupId", "confidence", "source", "supersedesEventId", "publishedAt", "authority", "digest"
    ])
    || !exactKeys(event.source, ["type", "learningId", "acceptedAt", "automatic", "evidenceCount", "reviewDigest"])
    || event.schema !== "agentspine.shared-event/v1" || !ID_RE.test(event.id || "")
    || !ID_RE.test(event.scopeId || "") || !ID_RE.test(event.originInstanceId || "")
    || (expectedScopeId !== null && event.scopeId !== expectedScopeId)
    || !KINDS.has(event.kind) || !PRIVACY.has(event.privacy)
    || typeof event.claim !== "string" || !event.claim.trim() || event.claim.length > 1000
    || (event.subjectId !== null && !ID_RE.test(event.subjectId || ""))
    || (event.privacy === "group" && !ID_RE.test(event.groupId || ""))
    || (event.privacy !== "group" && event.groupId !== null)
    || !Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1
    || event.source?.type !== "accepted-learning" || !ID_RE.test(event.source?.learningId || "")
    || !validDateValue(event.source?.acceptedAt)
    || typeof event.source?.automatic !== "boolean" || !Number.isInteger(event.source?.evidenceCount) || event.source.evidenceCount < 1
    || !DIGEST_RE.test(event.source?.reviewDigest || "")
    || (event.supersedesEventId !== null && !ID_RE.test(event.supersedesEventId || ""))
    || !validDateValue(event.publishedAt) || event.authority !== "context-only"
    || !DIGEST_RE.test(event.digest || "") || digest(withoutDigest(event)) !== event.digest) {
    throw new Error(`shared event is invalid or has failed its integrity check: ${event?.id || "unknown"}`);
  }
  if (SECRET_RE.test(event.claim) || AUTHORITY_RE.test(event.claim)) throw new Error(`shared event contains unsafe context: ${event.id}`);
  return event;
}

function eventFilename(id) {
  return `${createHash("sha256").update(id).digest("hex")}.json`;
}

async function readEventFile(path, scopeId) {
  const metadata = await assertRegularFile(path, "shared event");
  if (metadata.size > MAX_EVENT_BYTES) throw new Error("shared event exceeds 64 KiB");
  const document = JSON.parse(await readFile(path, "utf8"));
  if (document?.schema === "agentspine.signed-envelope/v1") {
    const verified = verifyEnvelope(document, "event");
    return {
      event: validateSharedEvent(verified.payload, scopeId),
      authentication: verified.authentication,
      publicIdentity: verified.publicIdentity,
      document
    };
  }
  return { event: validateSharedEvent(document, scopeId), authentication: null, publicIdentity: null, document };
}

export async function publishLearning({
  root = process.cwd(), directory, learningId, eventId = `shared:${randomUUID()}`,
  supersedesEventId = null, signerId = null, confirmation, now = new Date()
}) {
  requireConfirmation(confirmation);
  if (!ID_RE.test(learningId || "")) throw new Error("learningId is required");
  if (!ID_RE.test(eventId || "")) throw new Error("eventId must be a stable, whitespace-free identifier");
  if (supersedesEventId !== null && !ID_RE.test(supersedesEventId || "")) throw new Error("supersedesEventId is invalid");
  const catalog = await buildCatalog(root);
  const adapter = await openAdapter(catalog.root, directory);
  if (adapter.authentication && !signerId) throw new Error("signed adapters require an explicit local signer");
  if (!adapter.authentication && signerId) throw new Error("an unsigned adapter cannot accept signed events");
  const { learning } = await loadLearning(catalog.root, catalog);
  const { graph } = await loadGraph(catalog.root, catalog);
  const learningIssues = learningFindings(learning, graph);
  if (learningIssues.length) throw new Error(`learning state failed closed: ${learningIssues.join(", ")}`);
  const candidate = learning.candidates.find((item) => item.id === learningId);
  if (!candidate || candidate.status !== "accepted") throw new Error("only accepted learning can be published");
  if (!PRIVACY.has(candidate.privacy)) throw new Error("private learning can never be published to a shared adapter");
  safeClaim(candidate.claim);
  let instanceId;
  await mutation(catalog.root, (state) => { instanceId = state.instanceId; return { instanceId }; });
  const body = eventBody({
    id: eventId, scopeId: adapter.manifest.scopeId, originInstanceId: instanceId,
    candidate, supersedesEventId, publishedAt: date(now, "now")
  });
  const event = { ...body, digest: digest(body) };
  validateSharedEvent(event, adapter.manifest.scopeId);
  if (supersedesEventId !== null) {
    const previousPath = join(adapter.eventsDirectory, eventFilename(supersedesEventId));
    const previous = (await readEventFile(previousPath, adapter.manifest.scopeId)).event;
    if (previous.kind !== event.kind || previous.subjectId !== event.subjectId
      || previous.privacy !== event.privacy || previous.groupId !== event.groupId) {
      throw new Error("a superseding shared event must keep kind, subject, and privacy scope");
    }
  }
  const target = join(adapter.eventsDirectory, eventFilename(event.id));
  const lockTarget = join(adapter.adapterDirectory, ".agentspine-adapter");
  const document = signerId
    ? await signEnvelope({ root: catalog.root, signerId, kind: "event", payload: event, now })
    : event;
  return withLock(lockTarget, async () => ({}), async () => {
    try {
      const existing = await readEventFile(target, adapter.manifest.scopeId);
      if (existing.event.digest !== event.digest) throw new Error(`shared event ID collision: ${event.id}`);
      return {
        created: false, event: existing.event, authentication: existing.authentication,
        eventPath: target, manifest: adapter.manifest
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return {
      created: true, event,
      authentication: document.schema === "agentspine.signed-envelope/v1"
        ? verifyEnvelope(document, "event").authentication : null,
      eventPath: target, manifest: adapter.manifest
    };
  }, false);
}

async function readAdapterEvents(adapter) {
  const entries = await readdir(adapter.eventsDirectory, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.name.endsWith(".json"));
  if (candidates.length > MAX_ADAPTER_EVENTS) throw new Error(`adapter exceeds ${MAX_ADAPTER_EVENTS} events`);
  if (candidates.some((entry) => !entry.isFile() || entry.isSymbolicLink())) throw new Error("adapter contains a non-regular shared event");
  const events = [];
  let totalBytes = 0;
  for (const entry of candidates.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(adapter.eventsDirectory, entry.name);
    const metadata = await lstat(path);
    totalBytes += metadata.size;
    if (totalBytes > MAX_ADAPTER_BYTES) throw new Error("adapter event payload exceeds the 20 MiB pull limit");
    const item = await readEventFile(path, adapter.manifest.scopeId);
    if (entry.name !== eventFilename(item.event.id)) throw new Error(`shared event filename does not match its ID: ${item.event.id}`);
    events.push(item);
  }
  const byId = new Map();
  for (const item of events) {
    const previous = byId.get(item.event.id);
    if (previous && previous.event.digest !== item.event.digest) throw new Error(`shared event ID collision: ${item.event.id}`);
    byId.set(item.event.id, item);
  }
  return [...byId.values()].sort((a, b) => a.event.publishedAt.localeCompare(b.event.publishedAt) || a.event.id.localeCompare(b.event.id));
}

export async function readDirectoryExchange({
  root = process.cwd(), directory, requireAuthenticated = true
}) {
  const catalog = await buildCatalog(root);
  const adapter = await openAdapter(catalog.root, directory);
  if (requireAuthenticated && !adapter.authentication) {
    throw new Error("HTTPS snapshots require an authenticated directory adapter");
  }
  const events = await readAdapterEvents(adapter);
  if (adapter.authentication && events.some((item) => !item.authentication)) {
    throw new Error("signed adapters cannot contain unsigned events");
  }
  if (!adapter.authentication && events.some((item) => item.authentication)) {
    throw new Error("unsigned adapters cannot mix signed events");
  }
  return {
    root: catalog.root,
    scopeId: adapter.manifest.scopeId,
    adapterId: adapter.manifest.adapterId,
    authenticated: Boolean(adapter.authentication),
    manifest: structuredClone(adapter.manifestDocument),
    events: events.map((item) => structuredClone(item.document))
  };
}

export async function pullShared({ root = process.cwd(), directory, requireAuthenticated = false, now = new Date() }) {
  const catalog = await buildCatalog(root);
  const adapter = await openAdapter(catalog.root, directory);
  if (requireAuthenticated && !adapter.authentication) throw new Error("adapter is not authenticated");
  const { trust } = await loadTrust(catalog.root, catalog);
  if (adapter.authentication) assertTrustedIdentity(adapter.publicIdentity, trust);
  const events = await readAdapterEvents(adapter);
  if (adapter.authentication && events.some((item) => !item.authentication)) {
    throw new Error("signed adapters cannot contain unsigned events");
  }
  if (!adapter.authentication && events.some((item) => item.authentication)) {
    throw new Error("unsigned adapters cannot mix signed events");
  }
  for (const item of events) if (item.authentication) assertTrustedIdentity(item.publicIdentity, trust);
  const receivedAt = date(now, "now");
  return mutation(catalog.root, (state, _catalog, sharingPath) => {
    const known = new Map([
      ...state.records.map((record) => [record.event.id, record.event.digest]),
      ...state.history.map((entry) => [entry.value?.event?.id, entry.value?.event?.digest]).filter(([id]) => id)
    ]);
    const imported = [];
    const skipped = [];
    for (const item of events) {
      const event = item.event;
      const knownDigest = known.get(event.id);
      if (knownDigest && knownDigest !== event.digest) throw new Error(`shared event ID collision in local state: ${event.id}`);
      if (knownDigest || event.originInstanceId === state.instanceId) {
        skipped.push(event.id);
        continue;
      }
      state.records.push({
        event,
        authentication: item.authentication ? { ...item.authentication, verifiedAt: receivedAt } : null,
        adapterId: adapter.manifest.adapterId,
        receivedAt,
        status: "pending",
        review: null,
        acceptedAt: null,
        supersededIds: [],
        authority: "context-only"
      });
      known.set(event.id, event.digest);
      imported.push(event.id);
    }
    state.records.sort((a, b) => a.event.id.localeCompare(b.event.id));
    return {
      imported, skipped, scopeId: adapter.manifest.scopeId, adapterId: adapter.manifest.adapterId,
      authenticated: Boolean(adapter.authentication),
      manifestSigner: adapter.authentication ? {
        signerId: adapter.authentication.signerId, keyId: adapter.authentication.keyId,
        authority: "context-only"
      } : null,
      eventSigners: [...new Map(events.filter((item) => item.authentication).map((item) => [
        item.authentication.keyId,
        { signerId: item.authentication.signerId, keyId: item.authentication.keyId, authority: "context-only" }
      ])).values()],
      sharingPath
    };
  });
}

export async function reviewShared({
  root = process.cwd(), id, decision, reason, confirmedByUser = false, now = new Date()
}) {
  if (!ID_RE.test(id || "")) throw new Error("shared event id is required");
  if (!new Set(["accept", "reject"]).has(decision)) throw new Error("decision must be accept or reject");
  const reviewReason = safeText(reason, "reason", 500);
  const reviewedAt = date(now, "now");
  const acceptedTrust = decision === "accept" ? (await loadTrust(root)).trust : null;
  return mutation(root, (state, _catalog, sharingPath, graph) => {
    const record = state.records.find((item) => item.event.id === id);
    if (!record) throw new Error(`unknown shared event: ${id}`);
    if (record.status !== "pending") throw new Error("only a pending shared event can be reviewed");
    preserve(state, record, reviewedAt);
    if (decision === "reject") {
      const rejected = {
        ...record,
        status: "rejected",
        review: { decision, reason: reviewReason, confirmedByUser: false, reviewedAt, authority: "context-only" },
        authority: "context-only"
      };
      state.records = state.records.map((item) => item.event.id === id ? rejected : item);
      return { record: rejected, sharingPath };
    }
    if (!confirmedByUser) throw new Error("acceptance requires explicit local user confirmation");
    if (record.authentication) {
      const proofFindings = sharingAuthenticationFindings({ records: [record], history: [] }, acceptedTrust);
      if (proofFindings.length) throw new Error(`signed shared context failed verification: ${proofFindings.join(", ")}`);
      const trusted = acceptedTrust.records.find((item) => item.keyId === record.authentication.keyId);
      if (!trusted || trusted.status !== "trusted" || trusted.signerId !== record.authentication.signerId) {
        throw new Error("signed shared context must still have a trusted signer at local review time");
      }
    }
    validateLocalScope(record.event, graph);
    const newer = state.records.find((item) => item.status === "accepted" && item.event.supersedesEventId === id);
    if (newer) throw new Error(`shared event is already superseded by accepted event: ${newer.event.id}`);
    const prior = record.event.supersedesEventId
      ? state.records.find((item) => item.event.id === record.event.supersedesEventId)
      : null;
    if (record.event.supersedesEventId && prior?.status !== "accepted") {
      throw new Error("a shared predecessor must be locally accepted before its replacement");
    }
    if (prior && (prior.event.kind !== record.event.kind || prior.event.subjectId !== record.event.subjectId
      || prior.event.privacy !== record.event.privacy || prior.event.groupId !== record.event.groupId)) {
      throw new Error("a shared replacement must keep kind, subject, and privacy scope");
    }
    if (prior) {
      preserve(state, prior, reviewedAt);
      state.records = state.records.map((item) => item.event.id === prior.event.id
        ? { ...item, status: "superseded", authority: "context-only" }
        : item);
    }
    const accepted = {
      ...record,
      status: "accepted",
      review: { decision, reason: reviewReason, confirmedByUser: true, reviewedAt, authority: "context-only" },
      acceptedAt: reviewedAt,
      supersededIds: prior ? [prior.event.id] : [],
      authority: "context-only"
    };
    state.records = state.records.map((item) => item.event.id === id ? accepted : item);
    return { record: accepted, sharingPath };
  });
}

export async function rollbackShared({ root = process.cwd(), id, reason, now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("shared event id is required");
  const rollbackReason = safeText(reason, "reason", 500);
  const rolledBackAt = date(now, "now");
  return mutation(root, (state, _catalog, sharingPath) => {
    const record = state.records.find((item) => item.event.id === id);
    if (!record || record.status !== "accepted") throw new Error("only accepted shared context can be rolled back");
    preserve(state, record, rolledBackAt);
    const restored = [];
    for (const previousId of record.supersededIds || []) {
      const previous = state.records.find((item) => item.event.id === previousId && item.status === "superseded");
      if (!previous) continue;
      preserve(state, previous, rolledBackAt);
      state.records = state.records.map((item) => item.event.id === previousId
        ? { ...item, status: "accepted", authority: "context-only" }
        : item);
      restored.push(previousId);
    }
    const rolledBack = {
      ...record,
      status: "rolled-back",
      rollback: { reason: rollbackReason, rolledBackAt, authority: "context-only" },
      authority: "context-only"
    };
    state.records = state.records.map((item) => item.event.id === id ? rolledBack : item);
    return { record: rolledBack, restored, sharingPath };
  });
}

function groupAudience(graph, groupId, includePrivate) {
  const ids = new Set();
  if (!groupId) return ids;
  ids.add(groupId);
  for (const edge of graph.entityEdges) {
    if (edge.relation !== "member-of" || (!includePrivate && edge.privacy === "private")) continue;
    if (edge.to === groupId) ids.add(edge.from);
    if (edge.from === groupId) ids.add(edge.to);
  }
  return ids;
}

function visible(record, entities, audience, includePrivate, groupId) {
  const event = record.event;
  if (event.privacy === "group" && (!groupId || event.groupId !== groupId)) return false;
  const subject = event.subjectId ? entities.get(event.subjectId) : null;
  if (subject?.privacy === "private" && !includePrivate) return false;
  if (subject?.privacy === "group" && !audience.has(subject.id)) return false;
  if (event.privacy === "group" && event.subjectId && !audience.has(event.subjectId)) return false;
  return true;
}

export async function sharedContext({
  root = process.cwd(), scopeId = null, groupId = null, includePrivate = false,
  kinds = null, subjectIds = null, maxItems = null, catalog: providedCatalog = null
} = {}) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { sharing } = await loadSharing(catalog.root, catalog);
  const { graph } = await loadGraph(catalog.root, catalog);
  const { trust } = await loadTrust(catalog.root, catalog);
  const findings = sharingFindings(sharing, graph);
  if (findings.length) throw new Error(`sharing state failed closed: ${findings.join(", ")}`);
  const authenticationFindings = sharingAuthenticationFindings(sharing, trust);
  if (authenticationFindings.length) throw new Error(`shared authentication failed closed: ${authenticationFindings.join(", ")}`);
  if (scopeId !== null && !ID_RE.test(scopeId || "")) throw new Error("scopeId is invalid");
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  if (groupId !== null) {
    const group = entities.get(groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
  }
  const kindFilter = kinds === null ? null : new Set(kinds);
  if (kindFilter && [...kindFilter].some((kind) => !KINDS.has(kind))) throw new Error("kinds contains an unsupported shared-memory kind");
  const subjectFilter = subjectIds === null ? null : new Set(subjectIds);
  const audience = groupAudience(graph, groupId, includePrivate);
  const limit = maxItems === null ? sharing.config.maxContextItems : integer(maxItems, "maxItems", 0, 50);
  const items = sharing.records
    .filter((record) => record.status === "accepted")
    .filter((record) => !scopeId || record.event.scopeId === scopeId)
    .filter((record) => !kindFilter || kindFilter.has(record.event.kind))
    .filter((record) => !subjectFilter || subjectFilter.has(record.event.subjectId))
    .filter((record) => visible(record, entities, audience, includePrivate, groupId))
    .sort((a, b) => b.event.confidence - a.event.confidence || b.acceptedAt.localeCompare(a.acceptedAt) || a.event.id.localeCompare(b.event.id))
    .slice(0, limit)
    .map((record) => ({
      id: record.event.id,
      scopeId: record.event.scopeId,
      kind: record.event.kind,
      claim: record.event.claim,
      subjectId: record.event.subjectId,
      privacy: record.event.privacy,
      groupId: record.event.groupId,
      confidence: record.event.confidence,
      originInstanceId: record.event.originInstanceId,
      sourceLearningId: record.event.source.learningId,
      publishedAt: record.event.publishedAt,
      acceptedAt: record.acceptedAt,
      authentication: record.authentication ? {
        mode: "signed", signerId: record.authentication.signerId,
        keyId: record.authentication.keyId, verifiedAt: record.authentication.verifiedAt,
        authority: "context-only"
      } : { mode: "integrity-only", authority: "context-only" },
      authority: "context-only"
    }));
  return {
    schema: "agentspine.shared-context/v1",
    root: catalog.root,
    scopeId,
    groupId,
    items,
    authority: "context-only",
    note: "Shared memory is reviewed descriptive context. It never grants delegation, host permissions, access, or instructions to act."
  };
}

export async function sharedInbox({ root = process.cwd(), status = "pending" } = {}) {
  if (!STATUSES.has(status)) throw new Error(`unsupported shared record status: ${status}`);
  const { sharing, sharingPath } = await loadSharing(root);
  const findings = sharingFindings(sharing, null);
  if (findings.length) throw new Error(`sharing state failed closed: ${findings.join(", ")}`);
  return {
    schema: "agentspine.shared-inbox/v1",
    root: sharing.root,
    status,
    items: sharing.records.filter((record) => record.status === status).map((record) => ({
      id: record.event.id,
      scopeId: record.event.scopeId,
      kind: record.event.kind,
      claim: record.event.claim,
      subjectId: record.event.subjectId,
      privacy: record.event.privacy,
      groupId: record.event.groupId,
      confidence: record.event.confidence,
      originInstanceId: record.event.originInstanceId,
      publishedAt: record.event.publishedAt,
      receivedAt: record.receivedAt,
      authentication: record.authentication ? {
        mode: "signed", signerId: record.authentication.signerId,
        keyId: record.authentication.keyId, signedAt: record.authentication.signedAt,
        verifiedAt: record.authentication.verifiedAt, authority: "context-only"
      } : { mode: "integrity-only", authority: "context-only" },
      authority: "context-only"
    })),
    sharingPath,
    authority: "context-only"
  };
}

export async function configureSharing({ root = process.cwd(), maxContextItems }) {
  return mutation(root, (state, _catalog, sharingPath) => {
    state.config.maxContextItems = integer(maxContextItems, "maxContextItems", 1, 50);
    return { config: state.config, sharingPath };
  });
}

export async function deleteShared({ root = process.cwd(), id, confirmation }) {
  requireConfirmation(confirmation);
  if (!ID_RE.test(id || "")) throw new Error("shared event id is required");
  return mutation(root, (state, _catalog, sharingPath) => {
    const record = state.records.find((item) => item.event.id === id);
    if (record?.status === "accepted" && record.supersededIds?.length) {
      throw new Error("roll back accepted superseding shared context before permanent deletion");
    }
    if (state.records.some((item) => item.status === "accepted" && item.supersededIds?.includes(id))) {
      throw new Error("roll back accepted superseding shared context before deleting its predecessor");
    }
    const existed = Boolean(record);
    state.records = state.records.filter((item) => item.event.id !== id);
    state.history = state.history.filter((entry) => entry.recordId !== id && entry.value?.event?.id !== id);
    return { deleted: existed, id, sharingPath };
  });
}

export function sharingFindings(sharing, graph = null) {
  const findings = [];
  if (!exactKeys(sharing, ["schema", "root", "instanceId", "config", "records", "history"])
    || !exactKeys(sharing.config, ["maxContextItems"])
    || sharing.schema !== "agentspine.sharing/v1" || !ID_RE.test(sharing.instanceId || "") || !validConfig(sharing.config)) findings.push("invalid-sharing-state");
  if (new Set(sharing.records.map((record) => record.event?.id)).size !== sharing.records.length) findings.push("duplicate-shared-event");
  const records = [
    ...sharing.records.map((record) => ({ record, current: true })),
    ...sharing.history.map((entry) => entry.value).filter(Boolean).map((record) => ({ record, current: false }))
  ];
  for (const { record, current } of records) {
    try { validateSharedEvent(record.event); } catch { findings.push(`invalid-shared-event:${record.event?.id || "unknown"}`); }
    const allowedRecordKeys = new Set(["event", "authentication", "adapterId", "receivedAt", "status", "review", "acceptedAt", "supersededIds", "rollback", "authority"]);
    if (Object.keys(record).some((key) => !allowedRecordKeys.has(key))
      || !STATUSES.has(record.status) || record.authority !== "context-only" || !ID_RE.test(record.adapterId || "")
      || !validDateValue(record.receivedAt) || !Array.isArray(record.supersededIds)
      || record.supersededIds.some((id) => !ID_RE.test(id || ""))) findings.push(`invalid-shared-record:${record.event?.id || "unknown"}`);
    if (!validateAuthentication(record.authentication)) findings.push(`invalid-shared-authentication:${record.event?.id || "unknown"}`);
    const nested = [record.review, record.rollback].filter(Boolean);
    if (nested.some((item) => item.authority !== "context-only")) findings.push(`shared-authority:${record.event?.id || "unknown"}`);
    if (nested.some((item) => SECRET_RE.test(item.reason || ""))) findings.push(`unsafe-shared-review:${record.event?.id || "unknown"}`);
    const validReview = record.review === null || (
      exactKeys(record.review, ["decision", "reason", "confirmedByUser", "reviewedAt", "authority"])
      && new Set(["accept", "reject"]).has(record.review.decision)
      && typeof record.review.reason === "string" && record.review.reason.length > 0
      && typeof record.review.confirmedByUser === "boolean"
      && validDateValue(record.review.reviewedAt)
      && record.review.authority === "context-only"
    );
    const validRollback = record.rollback === undefined || (
      exactKeys(record.rollback, ["reason", "rolledBackAt", "authority"])
      && typeof record.rollback.reason === "string" && record.rollback.reason.length > 0
      && validDateValue(record.rollback.rolledBackAt)
      && record.rollback.authority === "context-only"
    );
    if (!validReview || !validRollback) findings.push(`invalid-shared-review:${record.event?.id || "unknown"}`);
    if (record.status === "pending" && (record.review !== null || record.acceptedAt !== null || record.supersededIds.length)) findings.push(`invalid-shared-pending:${record.event?.id || "unknown"}`);
    if (record.status === "rejected" && (record.review?.decision !== "reject" || record.review?.confirmedByUser !== false || record.acceptedAt !== null)) findings.push(`invalid-shared-rejection:${record.event?.id || "unknown"}`);
    if (record.status === "accepted" && (record.review?.decision !== "accept" || record.review?.confirmedByUser !== true || !record.acceptedAt)) {
      findings.push(`invalid-shared-acceptance:${record.event?.id || "unknown"}`);
    }
    if (["accepted", "superseded", "rolled-back"].includes(record.status) && !validDateValue(record.acceptedAt)) findings.push(`invalid-shared-accepted-date:${record.event?.id || "unknown"}`);
    if (record.status === "rolled-back" && !record.rollback) findings.push(`invalid-shared-rollback:${record.event?.id || "unknown"}`);
    if (graph && current && record.status === "accepted") {
      const event = record.event || {};
      const subject = event.subjectId ? graph.entities.find((entity) => entity.id === event.subjectId) : null;
      if (event.subjectId && !subject) findings.push(`unknown-shared-subject:${event.id || "unknown"}`);
      if (event.privacy === "group") {
        const group = graph.entities.find((entity) => entity.id === event.groupId && entity.kind === "group");
        const member = !event.subjectId || graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
          (edge.from === event.subjectId && edge.to === event.groupId) || (edge.to === event.subjectId && edge.from === event.groupId)
        ));
        if (!group || !member) findings.push(`invalid-shared-group:${event.id || "unknown"}`);
      }
    }
  }
  const accepted = new Set(sharing.records.filter((record) => record.status === "accepted").map((record) => record.event.id));
  for (const record of sharing.records.filter((item) => item.status === "accepted" && item.event.supersedesEventId)) {
    if (accepted.has(record.event.supersedesEventId)) findings.push(`active-shared-supersession:${record.event.id}`);
  }
  for (const record of sharing.records) {
    if (record.status === "accepted") {
      const expected = record.event.supersedesEventId === null ? [] : [record.event.supersedesEventId];
      if (record.supersededIds.length !== expected.length
        || record.supersededIds.some((id, index) => id !== expected[index])) {
        findings.push(`invalid-shared-supersession:${record.event.id}`);
      }
    }
    if (record.status === "superseded" && !sharing.records.some(
      (item) => item.status === "accepted" && item.supersededIds.includes(record.event.id)
    )) findings.push(`orphaned-shared-supersession:${record.event.id}`);
  }
  if (sharing.history.some((entry) => !exactKeys(entry, ["kind", "recordId", "supersededAt", "privacy", "value", "authority"])
    || entry.kind !== "shared-record" || entry.recordId !== entry.value?.event?.id
    || entry.privacy !== entry.value?.event?.privacy || !validDateValue(entry.supersededAt)
    || entry.authority !== "context-only" || entry.value?.authority !== "context-only")) findings.push("invalid-sharing-history");
  return [...new Set(findings)];
}

export function sharingAuthenticationFindings(sharing, trust) {
  const findings = [];
  const trustIssues = trustFindings(trust);
  if (trustIssues.length) return trustIssues;
  const records = [
    ...sharing.records.map((record) => ({ record, current: true })),
    ...sharing.history.map((entry) => entry.value).filter(Boolean).map((record) => ({ record, current: false }))
  ];
  for (const { record, current } of records.filter((item) => item.record.authentication)) {
    const trusted = trust.records.find((item) => item.keyId === record.authentication.keyId);
    if (!trusted || trusted.signerId !== record.authentication.signerId) {
      findings.push(`missing-shared-signing-key:${record.event.id}`);
      continue;
    }
    try {
      verifyEnvelope({
        schema: "agentspine.signed-envelope/v1",
        kind: "event",
        signer: trusted.publicIdentity,
        payload: record.event,
        signedAt: record.authentication.signedAt,
        authority: "context-only",
        signature: record.authentication.signature
      }, "event");
    } catch {
      findings.push(`invalid-stored-shared-signature:${record.event.id}`);
    }
    if (current && record.status === "accepted" && trusted.status !== "trusted") {
      findings.push(`untrusted-accepted-shared-event:${record.event.id}`);
    }
  }
  return [...new Set(findings)];
}

function validateLocalScope(event, graph) {
  if (event.subjectId && !graph.entities.some((entity) => entity.id === event.subjectId)) {
    throw new Error(`unknown shared subject entity: ${event.subjectId}`);
  }
  if (event.privacy !== "group") return;
  const group = graph.entities.find((entity) => entity.id === event.groupId && entity.kind === "group");
  if (!group) throw new Error(`unknown shared group entity: ${event.groupId}`);
  const member = !event.subjectId || graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
    (edge.from === event.subjectId && edge.to === event.groupId) || (edge.to === event.subjectId && edge.from === event.groupId)
  ));
  if (!member) throw new Error(`shared subject is not a visible member of group: ${event.groupId}`);
}
