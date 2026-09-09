import { createHash, randomBytes } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const issued = new WeakMap();

function exact(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !ID.test(value) || value.includes("*")) {
    throw new Error(`${field} must be one exact ID`);
  }
  return value;
}

// Without a host ID, only the parsed invocation object can verify its receipt.
export function preflightDeliveryId(input, { issue = false } = {}) {
  if (!input || typeof input !== "object") return null;
  const turn = exact(input.turn_id, "turnId");
  const event = exact(input.event_id ?? input.hook_event_id, "hookEventId");
  if (turn && event) return `host-turn:${createHash("sha256").update(`${turn}\0${event}`).digest("hex").slice(0, 32)}`;
  if (turn || event) return turn || event;
  let id = issued.get(input);
  if (!id && issue) {
    id = `hook-invocation:${randomBytes(16).toString("hex")}`;
    issued.set(input, id);
  }
  return id || null;
}
