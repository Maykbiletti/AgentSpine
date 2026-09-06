import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { projectStateDir } from "./paths.js";
import { MAX_STATE_BYTES, emptyAttention, normalizeAttention } from "./attention-schema.js";

export async function readAttentionFile(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("attention state exceeds the 5 MiB read limit");
    return normalizeAttention(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyAttention(root);
  }
}

export async function loadAttention(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const attentionPath = join(directory, "attention.json");
  return { attention: await readAttentionFile(attentionPath, catalog.root), attentionPath, catalog };
}

export async function inspectAttention(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const attentionPath = join(directory, "attention.json");
  try {
    return { attention: await readAttentionFile(attentionPath, catalog.root), attentionPath, catalog, error: null };
  } catch (error) {
    return { attention: emptyAttention(catalog.root), attentionPath, catalog, error: error.message };
  }
}

export async function saveAttention(state, path) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("attention state exceeds 5 MiB; resolve or delete old cues first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await replaceFileWithRetry(temporary, path);
}

export async function withAttentionLock(path, task) {
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("attention state is busy; retry shortly");
  try {
    const state = await readAttentionFile(path, task.root);
    const result = await task.run(state);
    await saveAttention(state, path);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export function preservePrevious(state, kind, value, now) {
  if (!value) return;
  state.history.push({
    kind,
    recordId: value.id,
    entityId: value.entityId || null,
    supersededAt: now,
    value: { ...value, authority: "context-only" },
    privacy: value.privacy || "private",
    authority: "context-only"
  });
}

export async function attentionMutation(root, operation, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { attentionPath } = await loadAttention(catalog.root, catalog);
  return withAttentionLock(attentionPath, { root: catalog.root, run: (state) => operation(state, catalog, attentionPath) });
}
