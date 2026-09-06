import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { matchesSourceMetadata } from "./session-timeline-source.js";

export const CODEX_HISTORY_ADAPTER = "codex-rollout-jsonl/v1";
export const CODEX_HISTORY_CONTRACT_COMMIT = "6af345407d9c2a568da9d01b6c4b81a9e61495c0";
const HEADER_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const RECORDS = new Set(["session_meta", "response_item", "event_msg", "compacted", "turn_context",
  "token_usage_record", "world_state", "retained_context", "security_risk_score", "realtime_item",
  "inter_agent_communication", "inter_agent_communication_metadata"]);

// Read only the explicitly supplied native source. No directory discovery,
// decompression, inherited-history traversal or source rewriting is allowed.
export async function validateCodexTimelineHeader({ source, root, sessionId }) {
  let handle;
  try {
    handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!matchesSourceMetadata(await handle.stat({ bigint: true }), source)) return false;
    const bytes = Buffer.alloc(Math.min(source.size, HEADER_BYTES));
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const end = bytes.indexOf(0x0a);
    if (read.bytesRead !== bytes.length || end < 0) return false;
    const line = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    const meta = line?.payload;
    if (line.type !== "session_meta" || !meta || meta.id !== sessionId
      || (meta.session_id !== undefined && meta.session_id !== sessionId)
      || !ID.test(meta.id) || !isAbsolute(meta.cwd || "")
      || typeof meta.cli_version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(meta.cli_version)
      || (meta.history_mode !== undefined && meta.history_mode !== "legacy")
      || meta.history_base || meta.parent_thread_id || meta.forked_from_id
      || meta.schema_version !== undefined || line.schema_version !== undefined) return false;
    if (await realpath(meta.cwd) !== root) return false;
    return matchesSourceMetadata(await handle.stat({ bigint: true }), source);
  } catch { return false; }
  finally { await handle?.close(); }
}

// Whitelist actual Responses output records, never assistant/user assertions.
// The caller applies the common secret/injection filter to the original line.
export function codexTimelineToolResult(line) {
  if (!RECORDS.has(line?.type) || line.schema_version !== undefined) {
    throw new Error("codex-history-format-mismatch");
  }
  if (line.type !== "response_item") return null;
  const item = line.payload;
  if (!item || !["function_call_output", "custom_tool_call_output", "mcp_tool_call_output"].includes(item.type)) return null;
  if (!ID.test(item.call_id || "")) return null;
  let output = item.output;
  if (item.type === "mcp_tool_call_output") output = output?.content;
  if (Array.isArray(output)) {
    if (output.length > 12 || output.some(part => !["text", "input_text"].includes(part?.type)
      || typeof part.text !== "string")) return null;
    output = output.map(part => part.text).join("\n");
  }
  return typeof output === "string" ? { role: "tool", content: output, nativeMessageId: item.call_id } : null;
}
