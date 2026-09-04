import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isInside } from "./paths.js";

const MAX_TARGET_BYTES = 2 * 1024 * 1024;
const AUTHORITY = "context-only";

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyParents(parents, root) {
  for (const [path, before] of parents) {
    const after = await lstat(path);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFile(before, after)
      || !isInside(root, await realpath(path))) {
      throw new Error("delivery target parent changed during the knowledge query");
    }
  }
}

// Inspect only the target's components, never enumerate its parent or any tree.
// ENOENT is a baseline, not permission to create; other errors still abort the query.
export async function targetSnapshot(root, relativePath) {
  if (isAbsolute(relativePath)) throw new Error("delivery target path must be relative");
  const absolute = resolve(root, relativePath);
  if (!isInside(root, absolute) || absolute === root) throw new Error("delivery target escapes the project root");
  const parts = relative(root, absolute).split(sep);
  const parents = [[root, await lstat(root)]];
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]);
    const before = await optionalStat(cursor);
    if (!before) {
      await verifyParents(parents, root);
      if (await optionalStat(cursor)) throw new Error("delivery target appeared during the knowledge query");
      return { path: relativePath, state: "absent", bytes: 0, sha256: null,
        existingParent: relative(root, parents.at(-1)[0]) || ".", authority: AUTHORITY };
    }
    if (before.isSymbolicLink()) throw new Error("delivery target and parents must be non-symbolic paths");
    const canonical = await realpath(cursor);
    if (!isInside(root, canonical)) throw new Error("delivery target resolves outside the project root");
    if (index < parts.length - 1) {
      if (!before.isDirectory()) throw new Error("delivery target parent must be a directory");
      parents.push([cursor, before]);
      continue;
    }
    if (!before.isFile()) throw new Error("delivery target must be a regular non-symbolic file");
    if (before.size > MAX_TARGET_BYTES) {
      await verifyParents(parents, root);
      return { path: relativePath, bytes: before.size,
        omitted: "target-exceeds-2-mib", authority: AUTHORITY };
    }
    const bytes = await readFile(canonical);
    const after = await lstat(absolute);
    if (!sameFile(before, after) || after.isSymbolicLink()) {
      throw new Error("delivery target changed during the knowledge query");
    }
    await verifyParents(parents, root);
    return { path: relativePath, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), authority: AUTHORITY };
  }
}
