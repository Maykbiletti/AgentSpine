import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const WINDOWS_TRANSIENT_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export function isFileLockContention(error, platform = process.platform) {
  return error?.code === "EEXIST"
    || (platform === "win32" && ["EACCES", "EPERM"].includes(error?.code));
}

export function isTransientLockMetadataError(error, platform = process.platform) {
  return error?.code === "ENOENT"
    || (platform === "win32" && WINDOWS_TRANSIENT_CODES.has(error?.code));
}

export async function replaceFileWithRetry(temporary, target, options = {}) {
  const renameFile = options.renameFile || rename;
  const wait = options.wait || delay;
  const beforeAttempt = options.beforeAttempt || null;
  const platform = options.platform || process.platform;
  const maxRetries = options.maxRetries ?? 7;
  for (let attempt = 0; ; attempt += 1) {
    await beforeAttempt?.(attempt);
    try {
      await renameFile(temporary, target);
      return;
    } catch (error) {
      const transientWindowsReplace = platform === "win32"
        && WINDOWS_TRANSIENT_CODES.has(error?.code);
      if (!transientWindowsReplace || attempt >= maxRetries) throw error;
      await wait(10 * (attempt + 1));
    }
  }
}
