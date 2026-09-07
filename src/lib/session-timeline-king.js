import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { matchesSourceMetadata } from "./session-timeline-source.js";

export const KING_HISTORY_ADAPTER = "king-agent-wire-jsonl/v1";
export const KING_HISTORY_CONTRACT_COMMIT = "fbb97459a3fa2157f8bfea3d24931be63288ab11";
export const KING_HISTORY_RUNTIME_VERSION = "0.12.1";
const HEADER_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const RECORDS = new Set([
  "metadata", "forked", "turn.prompt", "turn.steer", "turn.cancel", "config.update",
  "permission.set_mode", "permission.record_approval_result", "full_compaction.begin",
  "plan_mode.enter", "plan_mode.cancel", "plan_mode.exit", "swarm_mode.enter", "swarm_mode.exit",
  "tools.register_user_tool", "tools.unregister_user_tool", "tools.set_active_tools", "usage.record",
  "full_compaction.cancel", "full_compaction.complete", "micro_compaction.apply",
  "context.append_message", "context.append_loop_event", "context.clear", "context.apply_compaction",
  "context.undo", "tools.update_store", "goal.create", "goal.update", "goal.clear"
]);

function sessionDirectory(path) {
  return basename(dirname(dirname(dirname(path))));
}

function exactWirePath(path, sessionId) {
  const agent = dirname(path);
  const agents = dirname(agent);
  const session = dirname(agents);
  return basename(path) === "wire.jsonl" && basename(agent) === "main" && basename(agents) === "agents"
    && [sessionId, sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`].includes(basename(session))
    && sessionDirectory(path) === basename(session);
}

export async function validateKingTimelineHeader({ source, sessionId, protocolVersion }) {
  if (!ID.test(sessionId || "") || !VERSION.test(protocolVersion || "")
    || !exactWirePath(source.path, sessionId)) return false;
  let handle;
  try {
    handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!matchesSourceMetadata(await handle.stat({ bigint: true }), source)) return false;
    const bytes = Buffer.alloc(Math.min(source.size, HEADER_BYTES));
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const end = bytes.indexOf(0x0a);
    if (read.bytesRead !== bytes.length || end < 0) return false;
    const line = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    const keys = Object.keys(line).sort();
    const allowed = line.time === undefined ? ["created_at", "protocol_version", "type"]
      : ["created_at", "protocol_version", "time", "type"];
    if (keys.join("\0") !== allowed.sort().join("\0") || line.type !== "metadata"
      || line.protocol_version !== protocolVersion || !Number.isSafeInteger(line.created_at)
      || line.created_at <= 0 || (line.time !== undefined && (!Number.isSafeInteger(line.time) || line.time <= 0))) return false;
    return matchesSourceMetadata(await handle.stat({ bigint: true }), source);
  } catch { return false; }
  finally { await handle?.close(); }
}

function textOutput(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length > 12) return null;
  if (value.some((part) => !part || !["text", "input_text", "output_text"].includes(part.type)
    || typeof part.text !== "string")) return null;
  return value.map((part) => part.text).join("\n");
}

export function kingTimelineToolResult(line) {
  if (!RECORDS.has(line?.type) || line.schema_version !== undefined) {
    throw new Error("king-history-format-mismatch");
  }
  if (line.type !== "context.append_loop_event") return null;
  const event = line.event;
  if (!event || event.type !== "tool.result" || !ID.test(event.toolCallId || "")
    || !event.result || typeof event.result !== "object") return null;
  const output = textOutput(event.result.output);
  if (output === null) return null;
  const at = Number.isSafeInteger(line.time) && line.time > 0 ? new Date(line.time) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  return { role: "tool", content: output, nativeMessageId: event.toolCallId, at: at.toISOString() };
}

export function kingTimelineUserMessage(line) {
  if (!RECORDS.has(line?.type) || line.schema_version !== undefined) {
    throw new Error("king-history-format-mismatch");
  }
  if (line.type !== "context.append_message" || line.message?.role !== "user") return null;
  const content = textOutput(line.message.content);
  const nativeMessageId = line.message.id === undefined ? undefined
    : ID.test(line.message.id) ? line.message.id : null;
  const at = Number.isSafeInteger(line.time) && line.time > 0 ? new Date(line.time) : null;
  if (content === null || nativeMessageId === null || !at || !Number.isFinite(at.getTime())) return null;
  return { role: "user", content, at: at.toISOString(),
    ...(nativeMessageId ? { nativeMessageId } : {}) };
}
