import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { premortemMismatchError as mismatchError } from "./delivery-premortem-codec.js";

export async function writePremortemFile(path, value, assertOwned, maxBytes = Infinity) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw mismatchError("delivery premortem state exceeds 64 KiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertOwned });
    // A stale lock holder can lose ownership in the narrow interval around rename.
    // Do not report this replacement as a committed state transition in that case.
    await assertOwned();
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
