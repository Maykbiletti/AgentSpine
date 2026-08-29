import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".next", ".nuxt", ".turbo", ".venv",
  "build", "coverage", "dist", "node_modules", "target", "vendor"
]);

const RULE_NAMES = new Set([
  "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md",
  "GEMINI.md", "CONSTITUTION.md", "RULES.md"
]);

const MEMORY_NAMES = new Set(["MEMORY.md"]);
const SOUL_RE = /(^|[_-])(soul|persona|voice)([_-]|\.)/i;
const MEMORY_PATH_RE = /(^|\/)(memory|memories)(\/|$)/i;
const DOCUMENT_CONTENT = new WeakMap();

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function classify(relativePath) {
  const name = basename(relativePath);
  if (RULE_NAMES.has(name)) return { layer: "constitution", protected: true };
  if (MEMORY_NAMES.has(name)) return { layer: "memory-index", protected: true };
  if (SOUL_RE.test(name) || name === "SOUL.md") return { layer: "soul", protected: true };
  if (MEMORY_PATH_RE.test(relativePath)) return { layer: "memory-fact", protected: true };
  return { layer: "reference", protected: false };
}

function authorityFor(layer) {
  if (layer === "constitution") return "host-instruction-candidate";
  return "context-only";
}

function hostsFor(name) {
  if (name === "AGENTS.md" || name === "AGENTS.override.md") return ["codex"];
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md") return ["claude"];
  if (name === "GEMINI.md") return ["gemini"];
  return ["generic"];
}

export function documentSnapshotContent(document) {
  const value = DOCUMENT_CONTENT.get(document);
  return value ? Buffer.from(value) : null;
}

export function attachDocumentSnapshot(document, buffer) {
  if (buffer) DOCUMENT_CONTENT.set(document, Buffer.from(buffer));
  return document;
}

export function markdownOutsideCode(text) {
  let fence = null;
  return String(text).split(/\r?\n/).map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1] || null;
    if (!fence && marker) { fence = marker[0]; return ""; }
    if (fence && marker?.[0] === fence) { fence = null; return ""; }
    if (fence) return "";
    return line.replace(/`+[^`\n]*`+/g, "");
  }).join("\n");
}

export async function indexExplicitDocuments(entries) {
  const documents = [];
  for (const entry of entries) {
    let path;
    let metadata;
    let buffer;
    if (entry.snapshot) {
      path = entry.snapshot.path;
      metadata = entry.snapshot.metadata;
      buffer = Buffer.from(entry.snapshot.buffer);
      if (buffer.byteLength !== metadata.bytes || sha256(buffer) !== metadata.sha256) {
        throw new Error(`source snapshot integrity failed: ${entry.id}`);
      }
    } else {
      const supplied = await lstat(entry.path);
      if (supplied.isSymbolicLink() || !supplied.isFile()) throw new Error(`source is not a regular non-symlink file: ${entry.id}`);
      path = await realpath(entry.path);
      metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`source is not a regular non-symlink file: ${entry.id}`);
      buffer = await readFile(path);
    }
    if (buffer.byteLength > (entry.maxBytes || 4 * 1024 * 1024)) throw new Error(`source exceeds its byte limit: ${entry.id}`);
    const classification = classify(entry.id);
    const document = {
      path,
      relativePath: entry.id,
      name: basename(path),
      ...classification,
      layer: entry.layer || classification.layer,
      protected: entry.protected ?? classification.protected,
      authority: authorityFor(entry.layer || classification.layer),
      classificationSource: "host-native-source-binding",
      hosts: [entry.host],
      bytes: buffer.byteLength,
      modifiedAt: entry.snapshot ? metadata.modifiedAt : metadata.mtime.toISOString(),
      sha256: entry.snapshot ? metadata.sha256 : sha256(buffer),
      links: [],
      sourceScope: entry.scope,
      sourceBinding: entry.binding,
      precedence: entry.precedence,
      relevance: entry.relevance || null
    };
    attachDocumentSnapshot(document, entry.snapshot ? buffer : null);
    documents.push(document);
  }
  return documents;
}

export function extractMarkdownLinks(text, filePath, root) {
  const links = new Set();
  text = markdownOutsideCode(text);
  const patterns = [
    /\[[^\]]*\]\(([^)]+\.md)(?:#[^)]+)?\)/gi,
    /(?:^|\s)@([^\s`'\"]+\.md)(?:\s|$)/gim
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1].trim().replace(/^<|>$/g, "");
      if (/^[a-z]+:/i.test(raw)) continue;
      let decoded = raw;
      try { decoded = decodeURIComponent(raw); } catch { /* Keep malformed URLs visible instead of failing the scan. */ }
      const target = resolve(dirname(filePath), decoded);
      const rel = relative(root, target).replaceAll("\\", "/");
      if (!rel.startsWith("../") && rel !== "..") links.add(rel);
    }
  }
  return [...links].sort();
}

async function walk(directory, found) {
  const entries = [];
  for await (const entry of await opendir(directory)) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(fullPath, found);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      found.push(fullPath);
    }
  }
}

export async function discoverDocuments(root) {
  const files = [];
  await walk(root, files);
  const documents = new Array(files.length);
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const index = cursor++;
      const path = files[index];
      const [buffer, metadata] = await Promise.all([readFile(path), stat(path)]);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const classification = classify(relativePath);
      documents[index] = {
        path,
        relativePath,
        name: basename(path),
        ...classification,
        authority: authorityFor(classification.layer),
        classificationSource: "filename-and-path-hint",
        hosts: hostsFor(basename(path)),
        bytes: buffer.byteLength,
        modifiedAt: metadata.mtime.toISOString(),
        sha256: sha256(buffer),
        links: extractMarkdownLinks(buffer.toString("utf8"), path, root)
      };
    }
  }
  const concurrency = Math.max(1, Math.min(16, files.length));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const byPath = new Map(documents.map((document) => [document.relativePath, document]));
  const queue = documents.filter((document) => document.protected);
  const visited = new Set(queue.map((document) => document.relativePath));
  while (queue.length) {
    const current = queue.shift();
    for (const linkedPath of current.links) {
      const linked = byPath.get(linkedPath);
      if (linked && !visited.has(linkedPath)) {
        linked.protected = true;
        visited.add(linkedPath);
        queue.push(linked);
      }
    }
  }
  return documents;
}

export function isRuleDocument(name) {
  return RULE_NAMES.has(name);
}
