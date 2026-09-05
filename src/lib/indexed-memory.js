import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isFileLockContention } from "./filesystem-retry.js";
import { isInside, stateRoot } from "./paths.js";
import { markdownOutsideCode } from "./documents.js";

export const INDEXED_MEMORY_CACHE_SCHEMA = "agentspine.indexed-memory-cache/v1";
const CACHE_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_INDEXED_LINKS = 4096;
const MAX_LIVE_SELECTIONS = 8;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function cachePath(env) { return join(stateRoot(env), "indexed-memory-cache.json"); }
function emptyCache() { return { schema: INDEXED_MEMORY_CACHE_SCHEMA, revision: 0, roots: {} }; }
function rootKey(root) { return sha256(root).slice(0, 32); }

function validateCache(value) {
  if (!value || value.schema !== INDEXED_MEMORY_CACHE_SCHEMA || !Number.isInteger(value.revision)
    || !value.roots || typeof value.roots !== "object" || Array.isArray(value.roots)) {
    throw new Error("indexed memory cache is corrupt; memory recall is disabled until repaired");
  }
  for (const records of Object.values(value.roots)) {
    if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("indexed memory cache contains an invalid root");
    for (const [path, record] of Object.entries(records)) {
      if (!path || path.startsWith("../") || path === ".." || !record || typeof record !== "object"
        || typeof record.contentBase64 !== "string" || typeof record.sha256 !== "string"
        || typeof record.identity !== "string" || !Number.isInteger(record.bytes)) {
        throw new Error("indexed memory cache contains an invalid record");
      }
      const buffer = Buffer.from(record.contentBase64, "base64");
      if (buffer.byteLength !== record.bytes || sha256(buffer) !== record.sha256) {
        throw new Error("indexed memory cache integrity check failed");
      }
    }
  }
  return value;
}

async function readCache(env) {
  const path = cachePath(env);
  try {
    const metadata = await stat(path);
    if (metadata.size > CACHE_LIMIT) throw new Error("indexed memory cache exceeds 16 MiB");
    return { cache: validateCache(JSON.parse(await readFile(path, "utf8"))), path };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { cache: emptyCache(), path };
  }
}

async function mutateCache(env, task) {
  const target = cachePath(env);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { handle = await open(lock, "wx", 0o600); break; } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lock);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lock);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await delay(25);
    }
  }
  if (!handle) throw new Error("indexed memory cache is busy; retry shortly");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const { cache } = await readCache(env);
    const result = await task(cache);
    cache.revision += 1;
    const content = `${JSON.stringify(cache)}\n`;
    if (Buffer.byteLength(content) > CACHE_LIMIT) throw new Error("indexed memory cache exceeds 16 MiB");
    await writeFile(temporary, content, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, target); break; } catch (error) {
        const transientWindowsReplace = process.platform === "win32"
          && ["EACCES", "EBUSY", "EPERM"].includes(error.code);
        if (!transientWindowsReplace || attempt >= 7) throw error;
        await delay(10 * (attempt + 1));
      }
    }
    return { ...result, cachePath: target, cacheRevision: cache.revision };
  } finally {
    await handle.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(lock).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function identity(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":");
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink?.() && !right.isSymbolicLink?.()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function pathClassification(root, relativePath) {
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate) || candidate === root) return { rejected: "path", candidate: null };
  const parts = relative(root, candidate).split(sep);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    let metadata;
    try { metadata = await lstat(cursor, { bigint: true }); } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return { rejected: "missing", candidate };
      throw error;
    }
    if (metadata.isSymbolicLink()) return { rejected: "symlink", candidate };
    if (index < parts.length - 1 && !metadata.isDirectory()) return { rejected: "path", candidate };
    if (index === parts.length - 1 && !metadata.isFile()) return { rejected: "path", candidate };
  }
  return { rejected: null, candidate };
}

async function safeSnapshotOnce(root, relativePath, cached, hooks, attempt) {
  const classified = await pathClassification(root, relativePath);
  if (classified.rejected) return { rejected: classified.rejected };
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try { handle = await open(classified.candidate, flags); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return { rejected: "missing" };
    if (["ELOOP", "EMLINK"].includes(error.code)) return { rejected: "symlink" };
    throw error;
  }
  try {
    await hooks.onOpen?.({ relativePath, attempt });
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(FILE_LIMIT)) return { rejected: before.size > BigInt(FILE_LIMIT) ? "size" : "path" };
    const canonical = await realpath(classified.candidate);
    if (!isInside(root, canonical)) return { rejected: "scope" };
    const expectedIdentity = identity(before);
    let buffer;
    let cacheHit = false;
    if (cached?.identity === expectedIdentity) {
      buffer = Buffer.from(cached.contentBase64, "base64");
      if (buffer.byteLength !== cached.bytes || sha256(buffer) !== cached.sha256) throw new Error("indexed memory cache integrity check failed");
      cacheHit = true;
    } else {
      buffer = await handle.readFile();
    }
    await hooks.afterRead?.({ relativePath, attempt, path: classified.candidate });
    const after = await handle.stat({ bigint: true });
    let pathname;
    try { pathname = await lstat(classified.candidate, { bigint: true }); } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return { rejected: "race" };
      throw error;
    }
    if (!sameFile(before, after) || !sameFile(after, pathname)) return { rejected: "race" };
    if (buffer.byteLength !== Number(after.size)) return { rejected: "race" };
    const digest = cacheHit ? cached.sha256 : sha256(buffer);
    return {
      rejected: null, cacheHit, path: canonical, relativePath, buffer,
      record: { identity: expectedIdentity, bytes: buffer.byteLength, sha256: digest, contentBase64: buffer.toString("base64") },
      metadata: { bytes: buffer.byteLength, sha256: digest, modifiedAt: new Date(Number(after.mtimeNs / 1000000n)).toISOString() }
    };
  } finally {
    await handle.close();
  }
}

export async function safeIndexedSnapshot(root, relativePath, cached = null, hooks = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await safeSnapshotOnce(root, relativePath, cached, hooks, attempt);
    if (result.rejected !== "race") return result;
    await hooks.onRace?.({ relativePath, attempt });
  }
  return { rejected: "race" };
}

function tokens(value) {
  return new Set(String(value || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{3,}/gu) || []);
}

export function parseMemoryIndex(text, indexPath, root) {
  const entries = [];
  const seen = new Set();
  const pattern = /\[([^\]]+)\]\(([^)]+\.md)(?:#[^)]+)?\)([^\n]*)/gi;
  for (const match of markdownOutsideCode(text).matchAll(pattern)) {
    const label = match[1].trim();
    let raw = match[2].trim().replace(/^<|>$/g, "");
    if (/^[a-z]+:/i.test(raw)) continue;
    try { raw = decodeURIComponent(raw); } catch { /* Retain malformed local paths for safe rejection. */ }
    const target = resolve(dirname(indexPath), raw);
    const relativePath = relative(root, target).replaceAll("\\", "/");
    if (seen.has(relativePath) || relativePath === "MEMORY.md") continue;
    seen.add(relativePath);
    const suffix = match[3] || "";
    const marker = suffix.match(/<!--\s*agentspine:([^>]+)-->/i)?.[1] || "";
    const directives = Object.fromEntries([...marker.matchAll(/([a-z]+)\s*=\s*([^,;\s]+)/gi)].map((item) => [item[1].toLowerCase(), item[2]]));
    const always = /(?:^|[,;\s])always(?:$|[,;\s])/i.test(marker) || /(?:—|-)\s*always\s*$/i.test(suffix);
    entries.push({ relativePath, label, always, directives, promptTokens: [...tokens(`${label} ${basename(relativePath)} ${directives.keywords || ""}`)] });
  }
  return entries;
}

export function relevantMemoryEntry(entry, scope = {}) {
  const pinned = new Set(Array.isArray(scope.pinnedPaths) ? scope.pinnedPaths : []);
  if (pinned.has(entry.relativePath)) return { relevant: true, reason: "pinned", score: 1000 };
  const exact = [
    ["entity", scope.entityId], ["person", scope.entityId], ["project", scope.projectId],
    ["group", scope.groupId], ["task", scope.currentTaskId]
  ];
  for (const [key, value] of exact) {
    if (entry.directives[key] && value && entry.directives[key] === value) {
      return { relevant: true, reason: key, score: 500 };
    }
  }
  const prompt = tokens(scope.prompt);
  const matches = entry.promptTokens.filter((value) => prompt.has(value)).length;
  if (matches) return { relevant: true, reason: "prompt", score: 700 + Math.min(matches, 99) };
  if (entry.always) return { relevant: true, reason: "always", score: 100 };
  return { relevant: false, reason: "scope", score: 0 };
}

export async function resolveIndexedMemory({ root, scope = {}, env = process.env, hooks = {}, deadline = Infinity }) {
  function checkDeadline() {
    if (Date.now() > deadline) throw new Error("indexed memory resolution exceeded its time limit");
  }
  checkDeadline();
  const canonicalRoot = await realpath(root);
  const { cache } = await readCache(env);
  const key = rootKey(canonicalRoot);
  const cached = cache.roots[key] || {};
  const diagnostics = {
    indexed: 0, relevant: 0, selected: 0, omittedRelevant: 0, loaded: 0, cacheHits: 0, cacheMisses: 0, missing: 0,
    rejected: { scope: 0, path: 0, symlink: 0, race: 0, size: 0 }, directoryEnumeration: 0
  };
  const index = await safeIndexedSnapshot(canonicalRoot, "MEMORY.md", cached["MEMORY.md"], hooks);
  if (index.rejected) {
    if (index.rejected === "missing") diagnostics.missing += 1;
    else diagnostics.rejected[index.rejected] = (diagnostics.rejected[index.rejected] || 0) + 1;
    await mutateCache(env, (value) => { delete value.roots[key]; return {}; });
    return { sources: [], diagnostics };
  }
  diagnostics.cacheHits += Number(index.cacheHit);
  diagnostics.cacheMisses += Number(!index.cacheHit);
  const entries = parseMemoryIndex(index.buffer.toString("utf8"), index.path, canonicalRoot);
  if (entries.length > MAX_INDEXED_LINKS) throw new Error(`Claude MEMORY.md indexes more than ${MAX_INDEXED_LINKS} direct files`);
  diagnostics.indexed = entries.length;
  const sources = [{ path: index.path, relativePath: "MEMORY.md", snapshot: index, relevance: "index" }];
  const selected = [];
  for (const entry of entries) {
    checkDeadline();
    const relevance = relevantMemoryEntry(entry, scope);
    if (!relevance.relevant) { diagnostics.rejected.scope += 1; continue; }
    diagnostics.relevant += 1;
    selected.push({ entry, relevance });
  }
  const chosen = new Set([...selected].sort((left, right) => right.relevance.score - left.relevance.score
    || left.entry.relativePath.localeCompare(right.entry.relativePath)).slice(0, MAX_LIVE_SELECTIONS)
    .map(({ entry }) => entry.relativePath));
  diagnostics.selected = chosen.size;
  diagnostics.omittedRelevant = Math.max(0, selected.length - MAX_LIVE_SELECTIONS);
  for (const { entry, relevance } of selected) {
    if (!chosen.has(entry.relativePath)) continue;
    checkDeadline();
    const snapshot = await safeIndexedSnapshot(canonicalRoot, entry.relativePath, cached[entry.relativePath], hooks);
    if (snapshot.rejected) {
      if (snapshot.rejected === "missing") diagnostics.missing += 1;
      else diagnostics.rejected[snapshot.rejected] = (diagnostics.rejected[snapshot.rejected] || 0) + 1;
      continue;
    }
    diagnostics.loaded += 1;
    diagnostics.cacheHits += Number(snapshot.cacheHit);
    diagnostics.cacheMisses += Number(!snapshot.cacheHit);
    sources.push({ path: snapshot.path, relativePath: entry.relativePath, snapshot, relevance: relevance.reason });
  }
  checkDeadline();
  const finalIndex = await safeIndexedSnapshot(canonicalRoot, "MEMORY.md", index.record, hooks);
  if (finalIndex.rejected || finalIndex.metadata.sha256 !== index.metadata.sha256) throw new Error("Claude MEMORY.md changed during indexed resolution; retry the hook");
  await mutateCache(env, (value) => {
    const records = { "MEMORY.md": index.record };
    for (const source of sources.slice(1)) records[source.relativePath] = source.snapshot.record;
    value.roots[key] = records;
    return {};
  });
  return { sources, diagnostics };
}

export async function purgeIndexedMemoryCache(root, env = process.env) {
  let canonical;
  try { canonical = await realpath(root); } catch (error) {
    if (error.code === "ENOENT") canonical = resolve(root); else throw error;
  }
  return mutateCache(env, (cache) => { delete cache.roots[rootKey(canonical)]; return { purged: true }; });
}
