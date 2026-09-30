import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";

const KEY_BYTES = 32;
const DIRECTORY_ERROR = "preflight signing key directory is unsafe; turn blocked";
const KEY_ERROR = "preflight signing key is corrupt; turn blocked";

function foreignOwner(metadata) {
  return typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid());
}

function unsafeMode(metadata, mask) {
  return process.platform !== "win32" && (metadata.mode & mask) !== 0n;
}

function safeRoot(metadata) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && !foreignOwner(metadata)
    && !unsafeMode(metadata, 0o022n);
}

function safeDirectory(metadata) {
  return safeRoot(metadata);
}

function safeKey(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n
    && metadata.size === BigInt(KEY_BYTES) && !foreignOwner(metadata) && !unsafeMode(metadata, 0o077n);
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left, right) {
  return sameNode(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function createAnchor(path) {
  const directory = dirname(path);
  const root = dirname(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root, { bigint: true });
  if (!safeRoot(rootMetadata)) throw new Error(DIRECTORY_ERROR);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const directoryMetadata = await lstat(directory, { bigint: true });
  if (!safeDirectory(directoryMetadata)) throw new Error(DIRECTORY_ERROR);
  return { root: { path: root, metadata: rootMetadata }, directory: { path: directory, metadata: directoryMetadata } };
}

async function assertAnchor(anchor) {
  const root = await lstat(anchor.root.path, { bigint: true });
  if (!safeRoot(root) || !sameNode(root, anchor.root.metadata)) throw new Error(DIRECTORY_ERROR);
  const directory = await lstat(anchor.directory.path, { bigint: true });
  if (!safeDirectory(directory) || !sameNode(directory, anchor.directory.metadata)) throw new Error(DIRECTORY_ERROR);
}

async function readKey(path, anchor) {
  await assertAnchor(anchor);
  const metadata = await lstat(path, { bigint: true });
  if (!safeKey(metadata)) throw new Error(KEY_ERROR);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!safeKey(before) || !sameFile(metadata, before)) throw new Error(KEY_ERROR);
    const value = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!safeKey(after) || !sameFile(before, after) || value.byteLength !== KEY_BYTES) throw new Error(KEY_ERROR);
    await assertAnchor(anchor);
    const current = await lstat(path, { bigint: true });
    if (!safeKey(current) || !sameFile(after, current)) throw new Error(KEY_ERROR);
    return value;
  } finally { await handle.close(); }
}

async function removePending(path, anchor, assertOwned) {
  await assertOwned();
  await assertAnchor(anchor);
  await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await assertAnchor(anchor);
}

export async function privateSigningKey(path) {
  const anchor = await createAnchor(path);
  try { return await readKey(path, anchor); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return withOwnedFileLock(`${path}.lock`, async ({ assertOwned }) => {
    try { return await readKey(path, anchor); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const pending = `${path}.pending`;
    await removePending(pending, anchor, assertOwned);
    const value = randomBytes(KEY_BYTES);
    let handle;
    try {
      await assertOwned();
      await assertAnchor(anchor);
      handle = await open(pending, "wx", 0o600);
      await handle.writeFile(value);
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      if (!safeKey(metadata)) throw new Error(KEY_ERROR);
      await handle.close();
      handle = null;
      await assertOwned();
      await assertAnchor(anchor);
      await link(pending, path);
      await unlink(pending);
      await assertAnchor(anchor);
      return readKey(path, anchor);
    } finally {
      await handle?.close();
      await assertAnchor(anchor);
      await unlink(pending).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }, { assertPath: () => assertAnchor(anchor) });
}
