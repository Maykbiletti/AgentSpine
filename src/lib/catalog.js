import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPath, comparablePath, isInside, projectStateDir, stateRoot } from "./paths.js";
import { discoverDocuments } from "./documents.js";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { withOwnedFileLock } from "./owned-file-lock.js";

export const CATALOG_SCHEMA = "agentspine.catalog/v1";

export function catalogScanPolicy(root, env = process.env) {
  return {
    stateRoot: isInside(comparablePath(root), comparablePath(stateRoot(env))) ? "excluded" : "outside",
    authority: "scanner-boundary-only"
  };
}

export function catalogForStateRoot(catalog, root) {
  if (!catalog || catalog.schema !== CATALOG_SCHEMA || typeof root !== "string" || !root) {
    throw new Error("a resolved catalog and state root are required");
  }
  if (catalog.root === root) return catalog;
  return {
    schema: CATALOG_SCHEMA,
    generatedAt: catalog.generatedAt,
    root,
    scanPolicy: catalogScanPolicy(root),
    preservation: "source-files-are-read-only",
    documents: [],
    conflicts: [],
    summary: { total: 0, protected: 0, conflicts: 0, byLayer: {} }
  };
}

function catalogConflicts(documents) {
  const byPath = new Map(documents.map((document) => [document.relativePath, document]));
  const conflicts = [];
  for (const document of documents) {
    for (const target of document.links) {
      if (!byPath.has(target)) {
        conflicts.push({ type: "broken-link", source: document.relativePath, target });
      }
    }
  }
  const byDirectory = new Map();
  for (const document of documents) {
    const directory = document.relativePath.includes("/")
      ? document.relativePath.slice(0, document.relativePath.lastIndexOf("/"))
      : ".";
    const key = `${directory}\0${document.layer}\0${document.hosts.join(",")}`;
    if (!byDirectory.has(key)) byDirectory.set(key, []);
    byDirectory.get(key).push(document);
  }
  for (const entries of byDirectory.values()) {
    if (entries.length < 2 || !["constitution", "soul", "memory-index"].includes(entries[0].layer)) continue;
    const names = entries.map((entry) => entry.relativePath).sort();
    const knownOverride = names.some((name) => /(?:AGENTS\.override|CLAUDE\.local)\.md$/.test(name));
    conflicts.push({
      type: knownOverride ? "native-precedence" : "multiple-candidates",
      layer: entries[0].layer,
      documents: names,
      resolution: knownOverride ? "host-native-order" : "agent-review-required"
    });
  }
  return conflicts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export async function buildCatalog(inputRoot = process.cwd(), { env = process.env } = {}) {
  const root = await canonicalPath(inputRoot);
  const documents = await discoverDocuments(root, { excludeRoots: [stateRoot(env)], env });
  const conflicts = catalogConflicts(documents);
  const byLayer = Object.fromEntries(
    [...new Set(documents.map((document) => document.layer))]
      .sort()
      .map((layer) => [layer, documents.filter((document) => document.layer === layer).length])
  );
  return {
    schema: CATALOG_SCHEMA,
    generatedAt: new Date().toISOString(),
    root,
    scanPolicy: catalogScanPolicy(root, env),
    preservation: "source-files-are-read-only",
    documents,
    conflicts,
    summary: {
      total: documents.length,
      protected: documents.filter((document) => document.protected).length,
      conflicts: conflicts.length,
      byLayer
    }
  };
}

export async function saveCatalog(catalog) {
  const directory = await projectStateDir(catalog.root);
  const target = join(directory, "catalog.json");
  const lockPath = `${target}.lock`;
  return withOwnedFileLock(lockPath, async ({ assertOwned }) => {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
      await assertOwned();
      await replaceFileWithRetry(temporary, target);
      return target;
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  });
}

export async function scanAndSave(root) {
  const catalog = await buildCatalog(root);
  const catalogPath = await saveCatalog(catalog);
  return { catalog, catalogPath };
}

export async function loadCatalog(inputRoot = process.cwd()) {
  const root = await canonicalPath(inputRoot);
  const directory = await projectStateDir(root);
  const path = join(directory, "catalog.json");
  const content = await readFile(path, "utf8");
  return { catalog: JSON.parse(content), catalogPath: path };
}

export async function verifyCatalog(inputRoot = process.cwd()) {
  let previous;
  try {
    previous = await loadCatalog(inputRoot);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ok: false, reason: "no-catalog", added: [], removed: [], changed: [] };
    }
    throw error;
  }
  const current = await buildCatalog(previous.catalog.root);
  const before = new Map(previous.catalog.documents.map((doc) => [doc.relativePath, doc]));
  const after = new Map(current.documents.map((doc) => [doc.relativePath, doc]));
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const changed = [...after.keys()]
    .filter((path) => before.has(path) && before.get(path).sha256 !== after.get(path).sha256)
    .sort();
  return {
    ok: removed.length === 0 && added.length === 0 && changed.length === 0,
    reason: "compared",
    added,
    removed,
    changed,
    catalogPath: previous.catalogPath
  };
}
