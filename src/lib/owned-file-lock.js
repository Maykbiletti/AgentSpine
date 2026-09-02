import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { isFileLockContention, isTransientLockMetadataError } from "./filesystem-retry.js";

const LOCK_SCHEMA = "agentspine.owned-file-lock/v1";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lockPayload(token, acquiredAt, leaseMs) {
  return {
    schema: LOCK_SCHEMA,
    token,
    acquiredAt,
    leaseMs,
    authority: "state-coordination-only"
  };
}

async function readOwner(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schema !== LOCK_SCHEMA || typeof value.token !== "string") return null;
    return value;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function removeStaleLock(path, staleAfterMs) {
  let before;
  try {
    before = await stat(path);
  } catch (error) {
    if (isTransientLockMetadataError(error)) return false;
    throw error;
  }
  if (Date.now() - before.mtimeMs <= staleAfterMs) return false;
  await readOwner(path);
  let after;
  try {
    after = await stat(path);
  } catch (error) {
    if (isTransientLockMetadataError(error)) return false;
    throw error;
  }
  if (!sameFile(before, after) || Date.now() - after.mtimeMs <= staleAfterMs) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isFileLockContention(error) || isTransientLockMetadataError(error)) return false;
    throw error;
  }
}

export async function withOwnedFileLock(path, task, {
  staleAfterMs = 15000,
  heartbeatIntervalMs = 1000,
  retryDelayMs = 25,
  maxAttempts = 80
} = {}) {
  if (typeof task !== "function") throw new Error("owned file lock requires a task");
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 50
    || !Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 10
    || heartbeatIntervalMs * 3 >= staleAfterMs
    || !Number.isInteger(retryDelayMs) || retryDelayMs < 1
    || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("owned file lock timing is invalid");
  }
  const token = randomUUID();
  const acquiredAt = new Date().toISOString();
  let acquired = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      const payload = `${JSON.stringify(lockPayload(token, acquiredAt, staleAfterMs))}\n`;
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      acquired = true;
      break;
    } catch (error) {
      if (!isFileLockContention(error)) {
        if (handle) {
          await handle.close();
          handle = null;
          await unlink(path).catch((cleanupError) => {
            if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
          });
        }
        throw error;
      }
      await removeStaleLock(path, staleAfterMs);
      if (attempt + 1 < maxAttempts) await delay(retryDelayMs);
    } finally {
      await handle?.close();
    }
  }
  if (!acquired) throw new Error("state is busy; retry shortly");

  let ownershipError = null;
  let heartbeat = Promise.resolve();
  const assertOwned = async () => {
    if (ownershipError) throw ownershipError;
    const owner = await readOwner(path);
    if (!owner || owner.token !== token) {
      ownershipError = new Error("state lock ownership was lost; mutation aborted");
      throw ownershipError;
    }
  };
  const renew = async () => {
    await assertOwned();
    const now = new Date();
    await utimes(path, now, now);
  };
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(renew).catch((error) => { ownershipError ||= error; });
  }, heartbeatIntervalMs);
  timer.unref?.();

  try {
    const result = await task({ token, acquiredAt, assertOwned });
    await assertOwned();
    return result;
  } finally {
    clearInterval(timer);
    await heartbeat;
    const owner = await readOwner(path).catch(() => null);
    if (owner?.token === token) {
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
