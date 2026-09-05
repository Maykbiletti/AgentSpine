import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { matchesSourceMetadata } from "./session-timeline-source.js";

export const PRIVATE_TIMELINE_PREFIX_BYTES = 4096;

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

// A receipt and enrollment never read a complete host transcript.  A small
// stable prefix makes later replacement detectable while append verification
// establishes the bounded full commitment separately.
export async function privateTimelinePrefixDigest(source, bytes = Math.min(source?.size, PRIVATE_TIMELINE_PREFIX_BYTES)) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PRIVATE_TIMELINE_PREFIX_BYTES) return null;
  let handle;
  try {
    handle = await open(source.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    if (!matchesSourceMetadata(before, source) || before.size < BigInt(bytes)) return null;
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = bytes ? await handle.read(buffer, 0, bytes, 0) : { bytesRead: 0 };
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== bytes || !matchesSourceMetadata(after, source) || after.size < BigInt(bytes)) return null;
    return digest(buffer);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export async function normalizePrivateTimelineSource(source) {
  const prefixBytes = Math.min(source.size, PRIVATE_TIMELINE_PREFIX_BYTES);
  const prefixDigest = await privateTimelinePrefixDigest(source, prefixBytes);
  if (!prefixDigest) return null;
  return {
    path: source.path, profileRoot: source.profileRoot, projectsRoot: source.projectsRoot,
    pathDigest: source.pathDigest, identity: source.identity, size: source.size,
    mtimeNs: source.mtimeNs, ctimeNs: source.ctimeNs, prefixBytes, prefixDigest, commitment: null
  };
}
