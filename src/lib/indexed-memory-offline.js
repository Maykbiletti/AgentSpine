import { opendir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseMemoryIndex, safeIndexedSnapshot } from "./indexed-memory.js";

const MAX_ENTRIES = 100000;

export async function scanIndexedMemoryOrphans(root) {
  const canonicalRoot = await realpath(root);
  const index = await safeIndexedSnapshot(canonicalRoot, "MEMORY.md");
  if (index.rejected) throw new Error(`offline memory scan cannot read MEMORY.md: ${index.rejected}`);
  const indexed = new Set(parseMemoryIndex(index.buffer.toString("utf8"), index.path, canonicalRoot)
    .map((entry) => entry.relativePath));
  let markdownFiles = 0;
  let orphaned = 0;
  let rejectedSymlinks = 0;
  let visited = 0;
  async function walk(directory) {
    const entries = [];
    for await (const entry of await opendir(directory)) {
      visited += 1;
      if (visited > MAX_ENTRIES) throw new Error(`offline memory scan exceeds ${MAX_ENTRIES} entries`);
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { rejectedSymlinks += 1; continue; }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name !== "MEMORY.md") {
        markdownFiles += 1;
        if (!indexed.has(relative(canonicalRoot, path).replaceAll("\\", "/"))) orphaned += 1;
      }
    }
  }
  await walk(canonicalRoot);
  return {
    mode: "explicit-offline-doctor-scan", indexed: indexed.size, markdownFiles, orphaned,
    rejectedSymlinks, visitedEntries: visited, contentsExposed: false, authority: "diagnostic-only"
  };
}
