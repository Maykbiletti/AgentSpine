import { createHash } from "node:crypto";
import { opendir, readFile, stat } from "node:fs/promises";
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

function hostsFor(name) {
  if (name === "AGENTS.md" || name === "AGENTS.override.md") return ["codex"];
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md") return ["claude"];
  if (name === "GEMINI.md") return ["gemini"];
  return ["generic"];
}

function extractMarkdownLinks(text, filePath, root) {
  const links = new Set();
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
  const documents = [];
  for (const path of files) {
    const [buffer, metadata] = await Promise.all([readFile(path), stat(path)]);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    const classification = classify(relativePath);
    documents.push({
      path,
      relativePath,
      name: basename(path),
      ...classification,
      hosts: hostsFor(basename(path)),
      bytes: buffer.byteLength,
      modifiedAt: metadata.mtime.toISOString(),
      sha256: sha256(buffer),
      links: extractMarkdownLinks(buffer.toString("utf8"), path, root)
    });
  }

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
