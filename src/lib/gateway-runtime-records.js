import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function appendReceipt(runtime, kind, objectId, now, details = {}) {
  const material = { kind, objectId, at: now, details, authority: "execution-state-only" };
  const digest = sha256(JSON.stringify(material));
  const id = "gateway-receipt:" + digest.slice(0, 24);
  const previous = runtime.receipts.find((item) => item.id === id);
  if (previous) return previous;
  const receipt = { id, ...material, digest };
  runtime.receipts.push(receipt);
  return receipt;
}

export function preserve(runtime, kind, value, transition, now) {
  runtime.history.push({ kind, objectId: kind === "outbox" ? value.outboxId : value.queueId, transition, at: now,
    value: structuredClone(value), authority: "execution-state-only" });
}
