import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ancestorsBetween, canonicalPath, isInside } from "./paths.js";
import { buildCatalog } from "./catalog.js";
import { attachDocumentSnapshot, documentSnapshotContent } from "./documents.js";
import { loadGraph } from "./graph.js";

function depth(root, path) {
  const value = relative(root, dirname(path));
  return value ? value.split(/[\\/]/).length : 0;
}

function nativeDocuments(catalog, cwd, host, graph) {
  if (catalog.sourceRegistry) {
    return [...catalog.documents]
      .filter((document) => document.hosts.includes(host))
      .sort((left, right) => left.precedence - right.precedence || left.relativePath.localeCompare(right.relativePath));
  }
  const ancestors = new Set(ancestorsBetween(catalog.root, cwd));
  const inScope = catalog.documents.filter((document) => ancestors.has(dirname(document.path)));
  const selected = [];

  if (host === "codex") {
    for (const directory of ancestorsBetween(catalog.root, cwd)) {
      const local = inScope.filter((document) => dirname(document.path) === directory);
      const override = local.find((document) => document.name === "AGENTS.override.md");
      const regular = local.find((document) => document.name === "AGENTS.md");
      if (override || regular) selected.push(override || regular);
    }
  } else if (host === "claude") {
    selected.push(...inScope.filter((document) =>
      document.name === "CLAUDE.md" || document.name === "CLAUDE.local.md"
    ));
  } else {
    selected.push(...inScope.filter((document) => document.layer === "constitution"));
  }

  selected.push(...inScope.filter((document) => document.layer === "soul"));
  selected.push(...inScope.filter((document) => document.layer === "memory-index"));
  const inferredLayers = new Set(["constitution", "soul", "memory-index"]);
  const inferredPaths = new Set(graph.annotations
    .filter((annotation) => inferredLayers.has(annotation.layer))
    .map((annotation) => annotation.path));
  selected.push(...inScope.filter((document) => inferredPaths.has(document.relativePath)));
  return [...new Map(selected.map((document) => [document.relativePath, document])).values()];
}

function addLinkedDocuments(catalog, seed, graph) {
  const byPath = new Map(catalog.documents.map((document) => [document.relativePath, document]));
  const selected = new Map(seed.map((document) => [document.relativePath, document]));
  const queue = [...seed];
  while (queue.length) {
    const current = queue.shift();
    const learnedLinks = graph.edges
      .filter((edge) => edge.from === current.relativePath && edge.confidence >= 0.6)
      .map((edge) => edge.to);
    for (const linkedPath of [...current.links, ...learnedLinks]) {
      const linked = byPath.get(linkedPath);
      if (linked && !selected.has(linked.relativePath)) {
        selected.set(linked.relativePath, linked);
        queue.push(linked);
      }
    }
  }
  return [...selected.values()];
}

function precedence(layer) {
  if (layer === "constitution") return 0;
  if (layer === "soul") return 1;
  if (layer === "memory-index") return 2;
  if (layer === "memory-fact") return 3;
  return 4;
}

export async function resolveContext({ root = process.cwd(), cwd = root, host = "generic", maxBytes = 65536, includeContent = true, catalog: providedCatalog = null } = {}) {
  const canonicalRoot = await canonicalPath(root);
  const canonicalCwd = await canonicalPath(cwd);
  if (!isInside(canonicalRoot, canonicalCwd) && !providedCatalog?.sourceRegistry) {
    throw new Error(`cwd must be inside root: ${canonicalCwd}`);
  }
  const catalog = providedCatalog || await buildCatalog(canonicalRoot);
  if (catalog.root !== canonicalRoot) throw new Error("provided catalog belongs to a different project root");
  const { graph } = await loadGraph(canonicalRoot, catalog);
  const annotations = new Map(graph.annotations.map((annotation) => [annotation.path, annotation]));
  const seed = nativeDocuments(catalog, canonicalCwd, host, graph);
  const documents = addLinkedDocuments(catalog, seed, graph)
    .map((document) => {
      const annotation = annotations.get(document.relativePath);
      const resolved = {
        ...document,
        effectiveLayer: annotation?.layer || document.layer,
        authority: annotation ? "context-only" : document.authority,
        classificationSource: annotation ? "agent-overlay" : document.classificationSource
      };
      return attachDocumentSnapshot(resolved, documentSnapshotContent(document));
    })
    .sort((a, b) => catalog.sourceRegistry
      ? a.precedence - b.precedence || a.relativePath.localeCompare(b.relativePath)
      : precedence(a.effectiveLayer) - precedence(b.effectiveLayer) || depth(catalog.root, a.path) - depth(catalog.root, b.path) || a.relativePath.localeCompare(b.relativePath));

  let remaining = Math.max(0, Number(maxBytes) || 0);
  const resolved = [];
  for (const document of documents) {
    let content = null;
    let loaded = false;
    if (includeContent && document.bytes <= remaining) {
      const snapshot = documentSnapshotContent(document);
      content = snapshot ? snapshot.toString("utf8") : await readFile(document.path, "utf8");
      remaining -= Buffer.byteLength(content);
      loaded = true;
    }
    resolved.push({ ...document, content, loaded });
  }

  return {
    schema: "agentspine.context/v1",
    root: canonicalRoot,
    cwd: canonicalCwd,
    host,
    graph: {
      edges: graph.edges,
      annotations: graph.annotations,
      authority: "context-only"
    },
    conflicts: catalog.conflicts,
    budget: { maxBytes, remainingBytes: remaining },
    documents: resolved,
    omitted: resolved.filter((document) => !document.loaded).map((document) => document.relativePath),
    note: "Omitted content remains available byte-for-byte through agentspine read or the MCP read_document tool."
  };
}

export async function readDocument({ root = process.cwd(), path, offset = 0, length = 65536 }) {
  if (!path) throw new Error("path is required");
  const catalog = await buildCatalog(root);
  const absolute = resolve(catalog.root, path);
  const document = catalog.documents.find((item) => item.path === absolute);
  if (!document) throw new Error("path is not an indexed Markdown document");
  const buffer = await readFile(absolute);
  const start = Math.max(0, Number(offset) || 0);
  const end = Math.min(buffer.length, start + Math.max(0, Number(length) || 0));
  return {
    path: document.relativePath,
    sha256: document.sha256,
    offset: start,
    bytes: end - start,
    totalBytes: buffer.length,
    eof: end >= buffer.length,
    encoding: "utf8",
    content: buffer.subarray(start, end).toString("utf8"),
    contentBase64: buffer.subarray(start, end).toString("base64")
  };
}
