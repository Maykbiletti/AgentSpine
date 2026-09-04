import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { canonicalPath, isInside } from "./paths.js";

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function readCatalogDocument({ root, catalog, path, offset = 0, length = 65536 }) {
  if (catalog.root !== await canonicalPath(root)) throw new Error("catalog belongs to a different project root");
  const absolute = resolve(catalog.root, path);
  const document = catalog.documents.find(item => item.relativePath === path
    || (isInside(catalog.root, absolute) && item.path === absolute));
  if (!document) throw new Error("path is not an indexed Markdown document in the bounded host sources");
  const before = await lstat(document.path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== document.bytes
    || before.size > 4 * 1024 * 1024 || await realpath(document.path) !== document.path) {
    throw new Error("indexed contract source changed before reading");
  }
  const handle = await open(document.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let buffer;
  try {
    if (!sameFile(before, await handle.stat())) throw new Error("indexed contract source was replaced");
    // A concurrent append must not turn this bounded read into an unbounded one.
    buffer = Buffer.alloc(before.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    buffer = buffer.subarray(0, bytesRead);
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(document.path))
      || await realpath(document.path) !== document.path
      || createHash("sha256").update(buffer).digest("hex") !== document.sha256) {
      throw new Error("indexed contract source changed during reading");
    }
  } finally {
    await handle.close();
  }
  const start = Math.min(buffer.length, Math.max(0, Number(offset) || 0));
  const end = Math.min(buffer.length, start + Math.max(0, Number(length) || 0));
  return { path: isInside(catalog.root, document.path)
    ? relative(catalog.root, document.path).replaceAll("\\", "/") : document.relativePath,
    sha256: document.sha256, offset: start, bytes: end - start, totalBytes: buffer.length,
    eof: end >= buffer.length, encoding: "utf8", content: buffer.subarray(start, end).toString("utf8"),
    contentBase64: buffer.subarray(start, end).toString("base64") };
}
