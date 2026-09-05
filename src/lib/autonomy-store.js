import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { projectStateDir } from "./paths.js";

export const AUTONOMY_SCHEMA = "agentspine.autonomy-portfolio/v1";
export const AUTONOMY_MODES = Object.freeze(["observe", "advise", "execute", "publish"]);
export const AUTONOMY_ACTIONS = Object.freeze(["observe", "advise", "execute", "publish"]);
export const EVIDENCE_CLASSES = Object.freeze(["objective", "user-feedback", "model-suggestion"]);
export const AUTONOMY_CONFIRMATION = "local-owner-confirmed";
export const PUBLISH_CONFIRMATION = "local-owner-publish-confirmed";
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
export const DIGEST_RE = /^[a-f0-9]{64}$/;
export const CAPABILITY_RE = /^tool:[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function stableId(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${field} must be a stable whitespace-free ID`);
  return value;
}

export function safeText(value, field, maximum, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  if (SECRET_RE.test(result)) throw new Error(`${field} appears to contain a secret`);
  return result;
}

export function timestamp(value, field = "date", nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

export function exactCapabilities(value = []) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !CAPABILITY_RE.test(item) || item.includes("*"))) {
    throw new Error("capabilities must be exact tool:<name> values without wildcards");
  }
  return [...new Set(value)].sort();
}

export function modeAllows(mode, action) {
  return AUTONOMY_MODES.indexOf(mode) >= AUTONOMY_ACTIONS.indexOf(action);
}

export function emptyAutonomy(root) {
  return { schema: AUTONOMY_SCHEMA, root, revision: 0, projects: [], snapshots: [], observations: [], notices: [], history: [] };
}

function validSource(source) {
  return source && ["local-root", "public-repository"].includes(source.kind)
    && typeof source.value === "string" && source.value.length > 0
    && (source.kind !== "local-root" || isAbsolute(source.value));
}

function validProject(item) {
  return item && ID_RE.test(item.id || "") && ID_RE.test(item.projectId || "")
    && ID_RE.test(item.tenantId || "") && (item.groupId === null || ID_RE.test(item.groupId || ""))
    && AUTONOMY_MODES.includes(item.mode) && validSource(item.source)
    && Array.isArray(item.capabilities) && JSON.stringify(item.capabilities) === JSON.stringify([...new Set(item.capabilities)].sort())
    && item.capabilities.every((value) => CAPABILITY_RE.test(value) && !value.includes("*"))
    && typeof item.active === "boolean" && Number.isInteger(item.revision) && item.revision > 0
    && item.authority === "explicit-local-autonomy-policy" && item.sourceAuthority === "explicit-local-owner-policy"
    && typeof item.goal === "string" && typeof item.updatedAt === "string"
    && (item.publishConfirmedAt === null || typeof item.publishConfirmedAt === "string");
}

function ownDigest(item) {
  const { recordDigest, ...body } = item;
  return recordDigest === digest(body);
}

export function autonomyFindings(state) {
  const findings = [];
  if (!state || state.schema !== AUTONOMY_SCHEMA || typeof state.root !== "string" || !Number.isInteger(state.revision)
    || state.revision < 0 || !["projects", "snapshots", "observations", "notices", "history"].every((key) => Array.isArray(state[key]))) {
    return ["invalid-autonomy-state"];
  }
  if (new Set(state.projects.map((item) => item.id)).size !== state.projects.length) findings.push("duplicate-project-registration");
  for (const item of state.projects) if (!validProject(item) || !ownDigest(item)) findings.push(`invalid-project:${item?.id || "unknown"}`);
  for (const [key, limit] of [["snapshots", 256], ["observations", 1024], ["notices", 512], ["history", 2048]]) {
    if (state[key].length > limit) findings.push(`${key}-limit-exceeded`);
    if (new Set(state[key].map((item) => item.id)).size !== state[key].length) findings.push(`duplicate-${key}-id`);
    for (const item of state[key]) if (!item || !ID_RE.test(item.id || "") || !ownDigest(item)) findings.push(`invalid-${key}:${item?.id || "unknown"}`);
  }
  return findings;
}

export function normalizeAutonomy(value, root) {
  if (value?.root !== root) throw new Error("autonomy state root mismatch");
  const findings = autonomyFindings(value);
  if (findings.length) throw new Error(`autonomy state failed closed: ${findings.join(", ")}`);
  return value;
}

export async function autonomyPaths(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return { catalog, autonomyPath: join(directory, "autonomy-portfolio.json") };
}

export async function loadAutonomy(root = process.cwd(), providedCatalog = null) {
  const paths = await autonomyPaths(root, providedCatalog);
  try {
    const metadata = await stat(paths.autonomyPath);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("autonomy state exceeds 5 MiB");
    return { state: normalizeAutonomy(JSON.parse(await readFile(paths.autonomyPath, "utf8")), paths.catalog.root), ...paths };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { state: emptyAutonomy(paths.catalog.root), ...paths };
  }
}

async function saveAutonomy(state, path) {
  const findings = autonomyFindings(state);
  if (findings.length) throw new Error(`autonomy state failed closed: ${findings.join(", ")}`);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("autonomy state exceeds 5 MiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const handle = await import("node:fs/promises").then(({ open }) => open(lockPath, "wx", 0o600));
      return { handle, lockPath };
    } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 90000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("autonomy state is busy; retry later");
}

export async function mutateAutonomy(root, operation) {
  const paths = await autonomyPaths(root);
  const { handle, lockPath } = await acquireLock(paths.autonomyPath);
  try {
    const { state } = await loadAutonomy(paths.catalog.root, paths.catalog);
    const result = await operation(state, paths);
    await saveAutonomy(state, paths.autonomyPath);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export function signedRecord(body) {
  return { ...body, recordDigest: digest(body) };
}

export function appendHistory(state, body) {
  const entry = signedRecord({ id: `history:${randomUUID()}`, ...body, authority: "context-only" });
  state.history.push(entry);
  if (state.history.length > 2048) state.history.splice(0, state.history.length - 2048);
  return entry;
}

export async function canonicalLocalRoot(value) {
  const input = resolve(safeText(value, "localRoot", 4096));
  const metadata = await lstat(input);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("local project root must be a regular directory, not a symlink");
  const canonical = await realpath(input);
  const same = process.platform === "win32"
    ? input.toLowerCase() === canonical.toLowerCase()
    : input === canonical;
  if (!same) throw new Error("local project root cannot traverse a symlink");
  return canonical;
}

export function publicRepository(value) {
  const url = new URL(safeText(value, "publicRepository", 2048));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("public repository must be a credential-free HTTPS URL without query or fragment");
  }
  return url.toString().replace(/\/$/, "");
}
