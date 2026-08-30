import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { linkEntities, loadGraph, unlinkEntities, upsertEntity } from "./graph.js";
import { isInside, projectStateDir } from "./paths.js";

export const PERSONA_POLICY_SCHEMA = "agentspine.persona-policy/v1";
export const PERSONA_RUNTIME_SCHEMA = "agentspine.persona-runtime/v1";
export const PERSONA_EVENT_SCHEMA = "agentspine.persona-event/v1";
export const PERSONA_ROSTER_SCHEMA = "agentspine.persona-roster/v1";

const CONFIRMATION = "local-owner-confirmed";
const MAX_BYTES = 5 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const KINDS = new Set(["person", "agent", "bot"]);
const EVENTS = new Set(["join", "rename", "group-change", "leave", "deactivate", "rejoin"]);
const ACTIVE = new Set(["active", "left", "deactivated"]);
const AUTHENTICATORS = new Set(["host-manifest", "oauth-subject", "local-roster", "signed-roster"]);
const NATIVE_HOSTS = new Set(["claude", "codex"]);
const NATIVE_SCOPES = new Set(["user", "project"]);
const FORBIDDEN = /\b(?:permission|rights?|roles?|owner|trusted|reports[- ]to|responsible[- ]for|delegat|token|secret|credential|api[-_ ]?key|network|production|payment|send capability|tool capability)\b/i;

function emptyPolicy(root) {
  return { schema: PERSONA_POLICY_SCHEMA, root, revision: 0, bindings: [], history: [] };
}

function emptyRuntime(root) {
  return { schema: PERSONA_RUNTIME_SCHEMA, root, revision: 0, personas: [], events: [], receipts: [] };
}

function exactId(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("*")) {
    throw new Error(field + " must be an exact stable ID without wildcards");
  }
  return value;
}

function exactText(value, field, maximum = 200) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " is required");
  const text = value.trim().replace(/\s+/g, " ").slice(0, maximum);
  if (FORBIDDEN.test(text)) throw new Error(field + " contains authority or secret-shaped content");
  return text;
}

function sourceText(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("sourceBinding is invalid");
  return value.trim().replaceAll("\\", "/").slice(0, 500);
}

function at(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("timestamp is invalid");
  return date.toISOString();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identityMaterial(binding) {
  return [binding.authenticator, binding.issuer, binding.tenantId, binding.host, binding.profileId,
    binding.subjectId, binding.kind].join("\0");
}

function stablePersonaId(binding) {
  return binding.kind + ":runtime:" + digest(identityMaterial(binding)).slice(0, 32);
}

function validBinding(binding) {
  return binding && ID_RE.test(binding.id || "") && KINDS.has(binding.kind)
    && AUTHENTICATORS.has(binding.authenticator) && ID_RE.test(binding.issuer || "")
    && ID_RE.test(binding.tenantId || "") && ID_RE.test(binding.host || "")
    && ID_RE.test(binding.profileId || "") && ID_RE.test(binding.subjectId || "")
    && ID_RE.test(binding.personaId || "") && binding.personaId === stablePersonaId(binding)
    && typeof binding.displayName === "string" && binding.displayName.length > 0 && !FORBIDDEN.test(binding.displayName)
    && (binding.sourceBinding === null || typeof binding.sourceBinding === "string")
    && (binding.groupId === null || ID_RE.test(binding.groupId || ""))
    && typeof binding.active === "boolean" && typeof binding.deactivated === "boolean"
    && !(binding.active && binding.deactivated) && binding.authority === "authenticated-identity-policy"
    && Number.isFinite(new Date(binding.createdAt).getTime())
    && Number.isFinite(new Date(binding.updatedAt).getTime());
}

function validPersona(persona) {
  return persona && ID_RE.test(persona.personaId || "") && ID_RE.test(persona.bindingId || "")
    && KINDS.has(persona.kind) && ACTIVE.has(persona.status)
    && typeof persona.displayName === "string" && persona.displayName.length > 0
    && (persona.groupId === null || ID_RE.test(persona.groupId || ""))
    && Number.isInteger(persona.sequence) && persona.sequence >= 1
    && persona.authority === "identity-state-only" && Number.isFinite(new Date(persona.updatedAt).getTime());
}

function validEvent(event) {
  if (!(event && event.schema === PERSONA_EVENT_SCHEMA && ID_RE.test(event.eventId || "")
    && ID_RE.test(event.personaId || "") && ID_RE.test(event.bindingId || "")
    && EVENTS.has(event.type) && Number.isInteger(event.sequence) && event.sequence >= 1
    && Number.isFinite(new Date(event.observedAt).getTime())
    && /^[a-f0-9]{64}$/.test(event.payloadDigest || "")
    && event.authority === "identity-state-only")) return false;
  const payload = { personaId: event.personaId, bindingId: event.bindingId, type: event.type, sequence: event.sequence,
    displayName: event.displayName, groupId: event.groupId, observedAt: event.observedAt };
  const payloadDigest = digest(JSON.stringify(payload));
  return event.payloadDigest === payloadDigest && event.eventId === "persona-event:" + payloadDigest.slice(0, 32);
}

function validReceipt(receipt) {
  if (!(receipt && ID_RE.test(receipt.id || "") && ID_RE.test(receipt.eventId || "")
    && /^[a-f0-9]{64}$/.test(receipt.payloadDigest || "") && /^[a-f0-9]{64}$/.test(receipt.digest || "")
    && Number.isFinite(new Date(receipt.at).getTime()) && receipt.authority === "identity-state-only")) return false;
  const material = { eventId: receipt.eventId, payloadDigest: receipt.payloadDigest, at: receipt.at,
    authority: "identity-state-only" };
  return receipt.digest === digest(JSON.stringify(material)) && receipt.id === "persona-receipt:" + receipt.digest.slice(0, 24);
}

function normalizePolicy(value, root) {
  if (!value || value.schema !== PERSONA_POLICY_SCHEMA || value.root !== root
    || !Number.isInteger(value.revision) || !Array.isArray(value.bindings) || !Array.isArray(value.history)
    || value.bindings.some((item) => !validBinding(item))
    || value.history.some((item) => !item || !validBinding(item.value) || item.authority !== "authenticated-identity-policy")) {
    throw new Error("persona policy is invalid; automatic persona synchronization is disabled");
  }
  return value;
}

function normalizeRuntime(value, root) {
  if (!value || value.schema !== PERSONA_RUNTIME_SCHEMA || value.root !== root
    || !Number.isInteger(value.revision) || !Array.isArray(value.personas)
    || !Array.isArray(value.events) || !Array.isArray(value.receipts)
    || value.personas.some((item) => !validPersona(item)) || value.events.some((item) => !validEvent(item))
    || value.receipts.some((item) => !validReceipt(item))) {
    throw new Error("persona runtime is invalid; persona context is disabled");
  }
  return value;
}

async function pathsFor(root, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return { catalog, directory, personaPolicyPath: join(directory, "persona-policy.json"), personaRuntimePath: join(directory, "persona-runtime.json") };
}

async function readJson(path, root, normalize, empty) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_BYTES) throw new Error("persona state exceeds 5 MiB");
    return normalize(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return empty(root);
  }
}

async function writeJson(path, value) {
  const content = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("persona state exceeds 5 MiB");
  const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function withLock(paths, task) {
  const lockPath = join(paths.directory, "persona-runtime.lock");
  let handle;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { handle = await open(lockPath, "wx", 0o600); break; } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 90000) await unlink(lockPath);
      } catch (lockError) { if (lockError.code !== "ENOENT") throw lockError; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("persona state is busy; retry later");
  try { return await task(); } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function normalizeBinding(input, timestamp) {
  const binding = {
    id: exactId(input.id || "persona-binding:" + randomUUID(), "bindingId"),
    authenticator: AUTHENTICATORS.has(input.authenticator) ? input.authenticator : null,
    issuer: exactId(input.issuer, "issuer"), tenantId: exactId(input.tenantId, "tenantId"),
    host: exactId(input.host, "host"), profileId: exactId(input.profileId, "profileId"),
    subjectId: exactId(input.subjectId, "subjectId"), kind: input.kind,
    displayName: exactText(input.displayName, "displayName"),
    sourceBinding: input.sourceBinding === null || input.sourceBinding === undefined ? null : sourceText(input.sourceBinding),
    groupId: exactId(input.groupId, "groupId", true), deactivated: input.deactivated === true,
    active: input.deactivated === true ? false : input.active !== false,
    createdAt: timestamp, updatedAt: timestamp, authority: "authenticated-identity-policy"
  };
  if (!binding.authenticator || !KINDS.has(binding.kind)) throw new Error("persona binding requires an approved authenticator and person, agent, or bot kind");
  binding.personaId = stablePersonaId(binding);
  return binding;
}

function eventPayload(binding, type, sequence, observedAt) {
  const payload = { personaId: binding.personaId, bindingId: binding.id, type, sequence, displayName: binding.displayName,
    groupId: binding.groupId, observedAt };
  return { schema: PERSONA_EVENT_SCHEMA, eventId: "persona-event:" + digest(JSON.stringify(payload)).slice(0, 32),
    ...payload, payloadDigest: digest(JSON.stringify(payload)), authority: "identity-state-only" };
}

function eventReceipt(event) {
  const material = { eventId: event.eventId, payloadDigest: event.payloadDigest, at: event.observedAt,
    authority: "identity-state-only" };
  const receiptDigest = digest(JSON.stringify(material));
  return { id: "persona-receipt:" + receiptDigest.slice(0, 24), ...material, digest: receiptDigest };
}

function nextEventTypes(previous, binding) {
  if (!previous) return ["join"];
  if (!binding.active && previous.status === "active") return [binding.deactivated ? "deactivate" : "leave"];
  if (!binding.active) return [];
  const types = previous.status !== "active" ? ["rejoin"] : [];
  if (previous.displayName !== binding.displayName) types.push("rename");
  if (previous.groupId !== binding.groupId) types.push("group-change");
  return types;
}

function runtimeEntityAttributes(persona, binding, existing) {
  return {
    ...(existing?.attributes || {}),
    runtimeKind: persona.kind,
    identityBindingId: persona.bindingId,
    identityStatus: persona.status,
    sourceBinding: binding?.sourceBinding || null
  };
}

function sameRuntimeEntity(entity, persona, binding) {
  if (!entity) return false;
  const expectedKind = persona.kind === "bot" ? "agent" : persona.kind;
  const expectedPrivacy = persona.groupId ? "group" : "shared";
  const attributes = runtimeEntityAttributes(persona, binding, entity);
  return entity.kind === expectedKind && entity.displayName === persona.displayName
    && entity.privacy === expectedPrivacy
    && JSON.stringify(entity.attributes) === JSON.stringify(attributes);
}

async function reconcilePersonaGraph(paths, policy, runtime) {
  let { graph } = await loadGraph(paths.catalog.root);
  const changes = { groupsCreated: 0, entitiesUpdated: 0, membershipsAdded: 0, membershipsRemoved: 0 };
  const activeGroupIds = [...new Set(runtime.personas
    .filter((item) => item.status === "active" && item.groupId !== null)
    .map((item) => item.groupId))].sort();

  for (const groupId of activeGroupIds) {
    const existing = graph.entities.find((item) => item.id === groupId);
    if (existing && existing.kind !== "group") {
      throw new Error(`authenticated persona group conflicts with a non-group entity: ${groupId}`);
    }
    if (existing?.privacy === "private") {
      throw new Error(`authenticated persona group cannot use private relationship visibility: ${groupId}`);
    }
    if (!existing) {
      await upsertEntity({ root: paths.catalog.root, id: groupId, kind: "group", privacy: "group",
        attributes: { identitySource: "authenticated-persona-roster" }, confidence: 1 });
      changes.groupsCreated += 1;
      graph = (await loadGraph(paths.catalog.root)).graph;
    }
  }

  for (const persona of runtime.personas) {
    const binding = policy.bindings.find((item) => item.id === persona.bindingId);
    let existing = graph.entities.find((item) => item.id === persona.personaId);
    if (existing && existing.kind !== (persona.kind === "bot" ? "agent" : persona.kind)) {
      throw new Error(`authenticated persona conflicts with an existing entity kind: ${persona.personaId}`);
    }
    if (!sameRuntimeEntity(existing, persona, binding)) {
      await upsertEntity({ root: paths.catalog.root, id: persona.personaId,
        kind: persona.kind === "bot" ? "agent" : persona.kind, displayName: persona.displayName,
        aliases: existing?.aliases || [], attributes: runtimeEntityAttributes(persona, binding, existing),
        sourceDocument: existing?.sourceDocument
          && paths.catalog.documents.some((item) => item.relativePath === existing.sourceDocument)
          ? existing.sourceDocument : null,
        privacy: persona.groupId ? "group" : "shared", confidence: 1 });
      changes.entitiesUpdated += 1;
      graph = (await loadGraph(paths.catalog.root)).graph;
      existing = graph.entities.find((item) => item.id === persona.personaId);
    }

    const memberships = graph.entityEdges.filter((edge) => edge.from === persona.personaId && edge.relation === "member-of");
    for (const edge of memberships.filter((item) => persona.status !== "active" || item.to !== persona.groupId)) {
      await unlinkEntities({ root: paths.catalog.root, from: edge.from, to: edge.to, relation: edge.relation });
      changes.membershipsRemoved += 1;
      graph = (await loadGraph(paths.catalog.root)).graph;
    }
    if (persona.status === "active" && persona.groupId !== null
      && !graph.entityEdges.some((edge) => edge.from === persona.personaId && edge.to === persona.groupId
        && edge.relation === "member-of" && edge.privacy === "group")) {
      await linkEntities({ root: paths.catalog.root, from: persona.personaId, to: persona.groupId,
        relation: "member-of", reason: "Authenticated roster membership; context only.", confidence: 1, privacy: "group" });
      changes.membershipsAdded += 1;
      graph = (await loadGraph(paths.catalog.root)).graph;
    }
  }
  return changes;
}

export async function applyPersonaRoster({ root = process.cwd(), bindings, rosterScopes = [], confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("persona roster changes require explicit local owner confirmation");
  if (!Array.isArray(bindings) || bindings.length > 256 || (!bindings.length && !rosterScopes.length)) {
    throw new Error("bindings must contain up to 256 persona bindings or one explicit roster scope");
  }
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime] = await Promise.all([
      readJson(paths.personaPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.personaRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
    ]);
    const observedAt = at(now);
    const normalized = bindings.map((item) => normalizeBinding(item, observedAt));
    let changed = false;
    const scopedRosterKeys = new Set([
      ...normalized.map((item) => [item.authenticator, item.issuer, item.tenantId, item.host, item.profileId].join("\0")),
      ...rosterScopes.map((item) => [item.authenticator, item.issuer, item.tenantId, item.host, item.profileId].join("\0"))
    ]);
    const suppliedIds = new Set(normalized.map((item) => item.id));
    for (const missing of policy.bindings.filter((item) => item.active && scopedRosterKeys.has([
      item.authenticator, item.issuer, item.tenantId, item.host, item.profileId
    ].join("\0")) && !suppliedIds.has(item.id))) {
      const retired = { ...missing, active: false, deactivated: false, updatedAt: observedAt };
      normalized.push(retired);
    }
    const identities = new Set();
    for (const binding of normalized) {
      const key = identityMaterial(binding);
      if (identities.has(key)) throw new Error("persona roster contains a duplicate authenticated identity");
      identities.add(key);
      const previousBinding = policy.bindings.find((item) => item.id === binding.id);
      if (previousBinding && previousBinding.personaId !== binding.personaId) throw new Error("a binding ID cannot be reassigned to another authenticated identity");
      const unchangedBinding = previousBinding && ["authenticator", "issuer", "tenantId", "host", "profileId", "subjectId", "kind",
        "displayName", "sourceBinding", "groupId", "active", "deactivated", "personaId"].every((key) => previousBinding[key] === binding[key]);
      if (unchangedBinding) continue;
      changed = true;
      if (previousBinding) {
        policy.history.push({ recordId: previousBinding.id, supersededAt: observedAt, value: structuredClone(previousBinding), authority: "authenticated-identity-policy" });
        binding.createdAt = previousBinding.createdAt;
      }
      policy.bindings = policy.bindings.filter((item) => item.id !== binding.id);
      policy.bindings.push(binding);
      const previous = runtime.personas.find((item) => item.personaId === binding.personaId);
      const types = nextEventTypes(previous, binding);
      let sequence = previous?.sequence || 0;
      for (const type of types) {
        sequence += 1;
        const event = eventPayload(binding, type, sequence, observedAt);
        if (!runtime.receipts.some((item) => item.eventId === event.eventId)) {
          runtime.events.push(event);
          runtime.receipts.push(eventReceipt(event));
        }
      }
      if (types.length) {
        runtime.personas = runtime.personas.filter((item) => item.personaId !== binding.personaId);
        runtime.personas.push({ personaId: binding.personaId, bindingId: binding.id, kind: binding.kind,
          displayName: binding.displayName, groupId: binding.groupId,
          status: binding.active ? "active" : binding.deactivated ? "deactivated" : "left",
          sequence, updatedAt: observedAt, authority: "identity-state-only" });
      }
    }
    if (changed) {
      policy.bindings.sort((a, b) => a.id.localeCompare(b.id));
      runtime.personas.sort((a, b) => a.personaId.localeCompare(b.personaId));
      runtime.events.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.eventId.localeCompare(b.eventId));
      policy.revision += 1;
      runtime.revision += 1;
      await Promise.all([writeJson(paths.personaPolicyPath, policy), writeJson(paths.personaRuntimePath, runtime)]);
    }
    const graphChanges = await reconcilePersonaGraph(paths, policy, runtime);
    const graphReconciled = Object.values(graphChanges).some((value) => value > 0);
    return { policy, runtime, personaPolicyPath: paths.personaPolicyPath,
      personaRuntimePath: paths.personaRuntimePath, duplicate: !changed, graphReconciled, graphChanges };
  });
}

function normalizeNativeDiscovery(value) {
  if (!value || typeof value !== "object" || !NATIVE_HOSTS.has(value.host) || !NATIVE_SCOPES.has(value.scope)) {
    throw new Error("native persona discovery requires a supported host and user or project scope");
  }
  return {
    id: exactId(value.id, "nativeDiscovery.id"), host: value.host, scope: value.scope,
    authenticator: "host-manifest", issuer: exactId(value.issuer, "nativeDiscovery.issuer"),
    tenantId: exactId(value.tenantId, "nativeDiscovery.tenantId"),
    profileId: exactId(value.profileId, "nativeDiscovery.profileId"),
    kind: value.kind === "bot" ? "bot" : "agent", groupId: exactId(value.groupId, "nativeDiscovery.groupId", true)
  };
}

function nativeAgentDirectory(scope, catalog, env) {
  if (scope.scope === "project") return join(catalog.root, scope.host === "claude" ? ".claude" : ".codex", "agents");
  const home = scope.host === "claude" ? env.CLAUDE_CONFIG_DIR
    : env.CODEX_HOME || env.BLUN_HOME;
  if (home) {
    if (!isAbsolute(home)) throw new Error(scope.host + " home override must be absolute");
    return join(home, "agents");
  }
  const userHome = env.HOME || env.USERPROFILE;
  if (!userHome || !isAbsolute(userHome)) throw new Error("native persona discovery requires an absolute host home");
  return join(userHome, scope.host === "claude" ? ".claude" : ".codex", "agents");
}

function manifestName(host, content) {
  if (host === "claude") {
    const frontmatter = content.startsWith("---") ? content.slice(3, content.indexOf("\n---", 3) + 1) : "";
    const match = frontmatter.match(/^\s*name\s*:\s*['\"]?([^'\"\r\n]+)['\"]?\s*$/mi);
    return match ? exactText(match[1], "manifest name") : null;
  }
  const match = content.match(/^\s*name\s*=\s*['\"]([^'\"\r\n]+)['\"]\s*$/mi);
  return match ? exactText(match[1], "manifest name") : null;
}

async function nativeManifestBindings(scope, catalog, env) {
  const directory = nativeAgentDirectory(scope, catalog, env);
  let metadata;
  try { metadata = await lstat(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("native persona directory must be a regular non-symlink directory");
  const canonicalDirectory = await realpath(directory);
  const stream = await opendir(canonicalDirectory); const entries = [];
  try { for await (const entry of stream) entries.push(entry); } finally { await stream.close().catch(() => {}); }
  const extension = scope.host === "claude" ? ".md" : ".toml";
  const candidates = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(extension))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (candidates.length > 128) throw new Error("native persona directory exceeds 128 direct manifests");
  const bindings = [];
  for (const entry of candidates) {
    const path = join(canonicalDirectory, entry.name);
    const pathBefore = await lstat(path);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error("native persona manifest must be a regular non-symlink file");
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 256 * 1024) throw new Error("native persona manifest exceeds 256 KiB");
      const content = await handle.readFile("utf8");
      const after = await handle.stat();
      const pathAfter = await lstat(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error("native persona manifest changed during read");
      }
      if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
        throw new Error("native persona manifest was exchanged during read");
      }
      const displayName = manifestName(scope.host, content);
      if (!displayName) continue;
      const sourceBinding = `${scope.host}:${scope.scope}-agents/${entry.name}`;
      const subjectId = "manifest:" + digest([scope.host, scope.profileId, sourceBinding].join("\0")).slice(0, 32);
      bindings.push({ id: "persona-binding:native:" + digest(scope.id + "\0" + sourceBinding).slice(0, 24),
        authenticator: "host-manifest", issuer: scope.issuer, tenantId: scope.tenantId, host: scope.host,
        profileId: scope.profileId, subjectId, kind: scope.kind, displayName, sourceBinding, groupId: scope.groupId });
    } finally { await handle.close(); }
  }
  return bindings;
}

export async function loadPersonaRuntime(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  const [policy, runtime] = await Promise.all([
    readJson(paths.personaPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
    readJson(paths.personaRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
  ]);
  return { policy, runtime, ...paths };
}

export async function syncPersonaRosterFromEnvironment({ root = process.cwd(), env = process.env, now = new Date() } = {}) {
  const configured = env.AGENTSPINE_PERSONA_ROSTER_FILE;
  if (!configured) return { configured: false, changed: false };
  if (!isAbsolute(configured)) throw new Error("AGENTSPINE_PERSONA_ROSTER_FILE must be an absolute path");
  const catalog = await buildCatalog(root);
  const supplied = await lstat(configured);
  if (supplied.isSymbolicLink() || !supplied.isFile()) throw new Error("persona roster must be a regular non-symlink file");
  const canonical = await realpath(configured);
  if (isInside(catalog.root, canonical)) throw new Error("persona roster must remain outside the agent project");
  const handle = await open(canonical, "r");
  let value;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("persona roster exceeds its 1 MiB limit");
    value = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!value || value.schema !== PERSONA_ROSTER_SCHEMA || !Number.isInteger(value.revision)
    || value.revision < 1 || !Array.isArray(value.bindings || []) || !Array.isArray(value.nativeDiscovery || [])) {
    throw new Error("persona roster envelope is invalid");
  }
  const nativeScopes = (value.nativeDiscovery || []).map(normalizeNativeDiscovery);
  const nativeBindings = (await Promise.all(nativeScopes.map((scope) => nativeManifestBindings(scope, catalog, env)))).flat();
  const bindings = [...(value.bindings || []), ...nativeBindings];
  const rosterScopes = nativeScopes.map((scope) => ({ authenticator: "host-manifest", issuer: scope.issuer,
    tenantId: scope.tenantId, host: scope.host, profileId: scope.profileId }));
  const result = await applyPersonaRoster({ root: catalog.root, bindings, rosterScopes,
    confirmation: CONFIRMATION, now: value.observedAt || now });
  return { configured: true, changed: !result.duplicate || result.graphReconciled,
    rosterChanged: !result.duplicate, graphReconciled: result.graphReconciled, graphChanges: result.graphChanges,
    revision: value.revision,
    personas: result.runtime.personas.length, nativeManifests: nativeBindings.length,
    rosterDigest: digest(JSON.stringify(value)) };
}

export async function inspectPersonaRuntime(root = process.cwd(), providedCatalog = null) {
  const paths = await pathsFor(root, providedCatalog);
  const errors = [];
  let policy = emptyPolicy(paths.catalog.root);
  let runtime = emptyRuntime(paths.catalog.root);
  try { policy = await readJson(paths.personaPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy); } catch (error) { errors.push("policy:" + error.message); }
  try { runtime = await readJson(paths.personaRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime); } catch (error) { errors.push("runtime:" + error.message); }
  return { policy, runtime, errors, ...paths };
}

export function personaRuntimeFindings(policy, runtime, graph = null) {
  const findings = [];
  const bindingIds = new Set();
  const personaIds = new Set();
  for (const binding of policy.bindings) {
    if (!validBinding(binding)) findings.push("invalid-persona-binding:" + (binding?.id || "unknown"));
    if (bindingIds.has(binding.id)) findings.push("duplicate-persona-binding:" + binding.id);
    bindingIds.add(binding.id);
  }
  for (const persona of runtime.personas) {
    if (!validPersona(persona)) findings.push("invalid-persona:" + (persona?.personaId || "unknown"));
    if (personaIds.has(persona.personaId)) findings.push("duplicate-persona:" + persona.personaId);
    if (!bindingIds.has(persona.bindingId)) findings.push("orphan-persona:" + persona.personaId);
    if (graph) {
      const entity = graph.entities.find((item) => item.id === persona.personaId);
      const expectedKind = persona.kind === "bot" ? "agent" : persona.kind;
      if (!entity || entity.kind !== expectedKind) findings.push("persona-graph-mismatch:" + persona.personaId);
      if (entity?.attributes?.identityStatus !== persona.status) findings.push("persona-graph-status-mismatch:" + persona.personaId);
      const memberships = graph.entityEdges.filter((edge) => edge.from === persona.personaId && edge.relation === "member-of");
      const group = persona.groupId === null ? null : graph.entities.find((item) => item.id === persona.groupId);
      if (persona.status === "active" && persona.groupId !== null
        && (!group || group.kind !== "group" || group.privacy === "private")) {
        findings.push("persona-group-entity-mismatch:" + persona.personaId);
      }
      if (persona.status === "active" && persona.groupId !== null
        && !memberships.some((edge) => edge.to === persona.groupId && edge.privacy === "group")) {
        findings.push("persona-group-membership-mismatch:" + persona.personaId);
      }
      if (memberships.some((edge) => edge.to !== persona.groupId || persona.status !== "active")) {
        findings.push("persona-stale-group-membership:" + persona.personaId);
      }
    }
    personaIds.add(persona.personaId);
  }
  const eventIds = new Set();
  for (const event of runtime.events) {
    if (!validEvent(event) || !personaIds.has(event.personaId)) findings.push("invalid-persona-event:" + (event?.eventId || "unknown"));
    if (eventIds.has(event.eventId)) findings.push("duplicate-persona-event:" + event.eventId);
    eventIds.add(event.eventId);
  }
  const receiptIds = new Set();
  for (const receipt of runtime.receipts) {
    if (!validReceipt(receipt) || !eventIds.has(receipt.eventId)) findings.push("invalid-persona-receipt:" + (receipt?.id || "unknown"));
    if (receiptIds.has(receipt.id)) findings.push("duplicate-persona-receipt:" + receipt.id);
    receiptIds.add(receipt.id);
  }
  return findings;
}

export async function personaContext({ root = process.cwd(), personaId = null, groupId = undefined, includeInactive = false } = {}) {
  const { policy, runtime } = await loadPersonaRuntime(root);
  const findings = personaRuntimeFindings(policy, runtime);
  if (findings.length) throw new Error("persona runtime failed closed: " + findings.join(", "));
  const items = runtime.personas.filter((item) => (includeInactive || item.status === "active")
    && (personaId === null || item.personaId === exactId(personaId, "personaId"))
    && (groupId === undefined || item.groupId === exactId(groupId, "groupId", true)));
  return { schema: "agentspine.persona-context/v1", items: structuredClone(items), authority: "identity-state-only" };
}
