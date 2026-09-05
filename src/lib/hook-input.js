const MAX_STDIN_BYTES = 64 * 1024;

export const SILENT_OVERSIZE_POST_TOOL_USE = Symbol("silent-oversize-post-tool-use");
export const SILENT_OVERSIZE_POST_TOOL_USE_ARG = "--silent-oversize-post-tool-use";

export async function readHookInput({ silentOversizePostToolUse = false } = {}) {
  const chunks = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, MAX_STDIN_BYTES - bytes);
    if (remaining) chunks.push(buffer.subarray(0, remaining));
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) oversized = true;
  }
  if (oversized) {
    if (silentOversizePostToolUse) return SILENT_OVERSIZE_POST_TOOL_USE;
    throw new Error("hook input exceeds the 64 KiB limit");
  }
  const value = Buffer.concat(chunks, bytes).toString("utf8");
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook input must be one JSON object");
  }
  return parsed;
}
