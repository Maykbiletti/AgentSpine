import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPath, projectStateDir } from "./paths.js";
import { discoverDocuments } from "./documents.js";

export const CATALOG_SCHEMA = "agentspine.catalog/v1";

export async function buildCatalog(inputRoot = process.cwd()) {
  const root = await canonicalPath(inputRoot);
  const documents = await discoverDocuments(root);
  const byLayer = Object.fromEntries(
    [...new Set(documents.map((document) => document.layer))]
      .sort()
      .map((layer) => [layer, documents.filter((document) => document.layer === layer).length])
  );
  return {
    schema: CATALOG_SCHEMA,
    generatedAt: new Date().toISOString(),
    root,
    preservation: "source-files-are-read-only",
    documents,
    summary: {
      total: documents.length,
      protected: documents.filter((document) => document.protected).length,
      byLayer
    }
  };
}

export async function saveCatalog(catalog) {
  const directory = await projectStateDir(catalog.root);
  const target = join(directory, "catalog.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return target;
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
