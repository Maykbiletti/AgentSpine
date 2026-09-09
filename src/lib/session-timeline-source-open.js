import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { matchesSourceMetadata, pathMatchesSource } from "./session-timeline-source.js";

export async function unchangedHandle(handle, source, hostHome = null) {
  try {
    const metadata = await handle.stat({ bigint: true });
    return matchesSourceMetadata(metadata, source) && await pathMatchesSource(source, hostHome);
  } catch { return false; }
}

export async function validatedHandle(source, hostHome = null) {
  if (!await pathMatchesSource(source, hostHome)) {
    return { status: "unavailable", reason: "transcript-changed" };
  }
  let handle;
  try { handle = await open(source.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); }
  catch { return { status: "unavailable", reason: "transcript-changed" }; }
  if (!await unchangedHandle(handle, source, hostHome)) {
    await handle.close();
    return { status: "unavailable", reason: "transcript-changed" };
  }
  return { status: "open", handle, size: source.size };
}

export async function readRange(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}
