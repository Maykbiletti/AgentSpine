import { loadChannelPolicy, loadChannelRuntime } from "./channel-runtime.js";
import { loadPersonaRuntime } from "./persona-runtime.js";
import { assertActivePersona, exactReplyBinding } from "./gateway-runtime-identity.js";
import { appendReceipt, preserve } from "./gateway-runtime-records.js";
import { HEALTH_VALUES, emptyPolicy, emptyRuntime, exactId, safeText, timestamp } from "./gateway-common.js";
import { normalizePolicy, normalizeRuntime, pathsFor, readJson, withLock, writeJson } from "./gateway-state.js";

export async function deliverPrepared({ root = process.cwd(), outboxId, adapter, now = new Date() }) {
  if (!adapter || typeof adapter.send !== "function") throw new Error("delivery adapter is unavailable");
  const paths = await pathsFor(root);
  let prepared;
  await withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channelRuntime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway was disabled before delivery");
    const outbox = runtime.outbox.find((item) => item.outboxId === exactId(outboxId, "outboxId"));
    if (!outbox) throw new Error("unknown outbox item");
    if (["delivered", "acknowledged"].includes(outbox.status)) { prepared = { duplicate: true, outbox: structuredClone(outbox) }; return; }
    if (outbox.status !== "prepared" && outbox.status !== "failed") throw new Error("outbox item is not safely retryable");
    if (new Date(outbox.nextAttemptAt) > new Date(timestamp(now))) throw new Error("outbox retry is not due");
    const event = channelRuntime.runtime.events.find((item) => item.eventId === outbox.eventId);
    if (!event) throw new Error("outbox channel event is missing");
    try {
      assertActivePersona(personas.policy, personas.runtime, event.agentId, event.projectId, event.groupId);
      exactReplyBinding(channelPolicy.policy, event);
    }
    catch (error) {
      const current = timestamp(now);
      preserve(runtime, "outbox", outbox, "capability-revoked", current);
      outbox.status = "dead-letter"; outbox.lastError = safeText(error.message, "adapterError", 500);
      outbox.updatedAt = current;
      const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
      if (queue) { queue.status = "dead-letter"; queue.completedAt = current; queue.updatedAt = current; }
      runtime.health.adapter = "failed"; runtime.revision += 1;
      const receipt = appendReceipt(runtime, "dead-letter", outbox.outboxId, current, { reason: "identity-or-capability-revoked" });
      await writeJson(paths.gatewayRuntimePath, runtime);
      prepared = { duplicate: false, terminal: true, outbox: structuredClone(outbox), receipt };
      return;
    }
    preserve(runtime, "outbox", outbox, "sending", timestamp(now));
    outbox.status = "sending"; outbox.attempts += 1; outbox.updatedAt = timestamp(now); runtime.revision += 1;
    appendReceipt(runtime, "sending", outbox.outboxId, outbox.updatedAt, { attempt: outbox.attempts });
    await writeJson(paths.gatewayRuntimePath, runtime);
    prepared = { duplicate: false, outbox: structuredClone(outbox) };
  });
  if (prepared.duplicate || prepared.terminal) return prepared;
  let outcome;
  try { outcome = await adapter.send(structuredClone(prepared.outbox)); }
  catch (error) { outcome = { ok: false, effect: "unknown", error: error.message }; }
  return withLock(paths, async () => {
    const runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime);
    const outbox = runtime.outbox.find((item) => item.outboxId === prepared.outbox.outboxId);
    if (!outbox || outbox.status !== "sending") throw new Error("outbox sending state changed unexpectedly");
    const current = timestamp(now);
    preserve(runtime, "outbox", outbox, outcome?.ok ? "delivered" : "send-failed", current);
    if (outcome?.ok) {
      outbox.status = "delivered"; outbox.deliveredAt = current; outbox.adapterReceipt = safeText(String(outcome.receipt || "delivered"), "adapterReceipt", 500);
      runtime.health.adapter = "healthy";
      const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
      if (queue) { queue.status = "completed"; queue.completedAt = current; queue.updatedAt = current; }
    } else if (outcome?.effect === "none") {
      outbox.status = outbox.attempts < 3 ? "failed" : "dead-letter";
      outbox.lastError = safeText(String(outcome.error || "adapter failure"), "adapterError", 500);
      runtime.health.adapter = outbox.status === "failed" ? "degraded" : "failed";
      if (outbox.status === "failed") {
        const delay = Math.min(300000, Number(outcome.retryAfterMs) || 1000 * (2 ** outbox.attempts));
        outbox.nextAttemptAt = new Date(new Date(current).getTime() + delay).toISOString();
      } else {
        const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
        if (queue) { queue.status = "dead-letter"; queue.completedAt = current; queue.updatedAt = current; }
      }
    } else {
      outbox.status = "delivery-unknown"; outbox.lastError = safeText(String(outcome?.error || "delivery outcome is ambiguous"), "adapterError", 500);
      runtime.health.adapter = "failed";
    }
    outbox.updatedAt = current; runtime.revision += 1;
    const receipt = appendReceipt(runtime, outbox.status, outbox.outboxId, current, { adapterReceipt: outbox.adapterReceipt });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { outbox, receipt, duplicate: false };
  });
}

export async function updateGatewayHealth({ root = process.cwd(), worker = null, adapter = null, host = null,
  now = new Date() } = {}) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime);
    for (const [key, value] of Object.entries({ worker, adapter, host })) {
      if (value !== null) {
        if (!HEALTH_VALUES.has(value)) throw new Error("unsupported gateway health value");
        runtime.health[key] = value;
      }
    }
    runtime.health.lastTickAt = timestamp(now); runtime.revision += 1;
    await writeJson(paths.gatewayRuntimePath, runtime);
    return structuredClone(runtime.health);
  });
}

