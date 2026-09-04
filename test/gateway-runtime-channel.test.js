import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadChannelRuntime, revokeChannelBinding } from "../src/lib/channel-runtime.js";
import {
  claimGatewayWork, completeGatewayRun, deliverPrepared, loadGatewayRuntime,
  reconcileGateway, setGatewayControl
} from "../src/lib/gateway-runtime.js";
import { claimReadOnlyGatewayWork, markTestGatewayHostStarted } from "./gateway-claim-fixture.js";
import { runWorkerTick } from "../src/worker.js";
import { fixture, ingest, prepareDelivery, leavePersona } from "./gateway-runtime-fixture.js";

test("authenticated Telegram event wakes one agent lane and returns exactly one origin-bound reply", async (t) => {
  const { root, agentId, before } = await fixture(t);
  await ingest(root, agentId);
  await reconcileGateway({ root, now: "2032-01-01T00:00:04.000Z" });
  const claimed = await claimGatewayWork({ root, workerId: "worker:one", now: "2032-01-01T00:00:05.000Z" });
  assert.equal(claimed.item.kind, "direct-message");
  assert.equal(claimed.item.agentId, agentId);
  await markTestGatewayHostStarted(root, claimed, "2032-01-01T00:00:05.250Z");
  await assert.rejects(completeGatewayRun({
    root, queueId: claimed.item.queueId, workerId: "worker:one", claimedAt: claimed.item.lease.claimedAt, attempt: claimed.item.attempts,
    result: { text: "Ich liebe dich und ich habe Gefühle." }, now: "2032-01-01T00:00:05.500Z"
  }), /prohibited attachment or consciousness/i);
  const completed = await completeGatewayRun({
    root, queueId: claimed.item.queueId, workerId: "worker:one", claimedAt: claimed.item.lease.claimedAt, attempt: claimed.item.attempts,
    result: { text: "Ja, ich kümmere mich darum." }, now: "2032-01-01T00:00:06.000Z"
  });
  let sends = 0;
  const delivered = await deliverPrepared({
    root, outboxId: completed.outbox.outboxId,
    adapter: { send: async (outbox) => {
      sends += 1;
      assert.deepEqual([outbox.chatId, outbox.threadId, outbox.replyTo], ["-1001234567890", "42", "900"]);
      return { ok: true, receipt: "telegram-message:901" };
    } },
    now: "2032-01-01T00:00:07.000Z"
  });
  assert.equal(delivered.outbox.status, "delivered");
  assert.equal(sends, 1);
  const duplicate = await deliverPrepared({
    root, outboxId: completed.outbox.outboxId,
    adapter: { send: async () => { sends += 1; return { ok: true, receipt: "unexpected" }; } },
    now: "2032-01-01T00:00:08.000Z"
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(sends, 1);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);
});
test("worker tick reconciles, runs, delivers, and acknowledges one pending channel event", async (t) => {
  const { root, agentId } = await fixture(t);
  await ingest(root, agentId);
  const result = await runWorkerTick({
    root, workerId: "gateway-worker:test", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async (item) => {
      assert.equal(item.host, "codex");
      assert.deepEqual(item.channelStart.agent_spine_channel_event, {
        event_id: "telegram:update:1001", provider: "telegram"
      });
      assert.deepEqual(item.hostEnvironment, {
        AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
        AGENTSPINE_ENTITY_ID: agentId,
        AGENTSPINE_PROJECT_ID: "project:alpha",
        AGENTSPINE_HOST: "codex",
        AGENTSPINE_GATEWAY_QUEUE_ID: item.queueId,
        AGENTSPINE_GATEWAY_ATTEMPT: "1",
        AGENTSPINE_GROUP_ID: "group:alpha",
        AGENTSPINE_CHANNEL_EVENT_ID: "telegram:update:1001",
        AGENTSPINE_CHANNEL_PROVIDER: "telegram"
      });
      assert.equal(item.channelStart.agent_spine_scope.entity_id, agentId);
      return { text: `Antwort für ${item.channelEventId}` };
    },
    adapter: { send: async () => ({ ok: true, receipt: "telegram-message:902" }) }
  });
  assert.equal(result.status, "delivered");
  const channel = await loadChannelRuntime(root);
  assert.equal(channel.runtime.events[0].status, "completed");
  const gateway = await loadGatewayRuntime(root);
  assert.equal(gateway.runtime.queue[0].status, "completed");
});
test("disabled and killed gateways never poll, run, or send", async (t) => {
  const { root } = await fixture(t);
  let effects = 0;
  await setGatewayControl({ root, enabled: false, confirmation: "local-owner-confirmed" });
  assert.deepEqual(await runWorkerTick({ root, adapter: {
    poll: async () => { effects += 1; }, send: async () => { effects += 1; }
  }, hostRunner: async () => { effects += 1; } }), { status: "stopped", processed: false });
  await setGatewayControl({ root, enabled: true, killSwitch: true, confirmation: "local-owner-confirmed" });
  assert.deepEqual(await runWorkerTick({ root, adapter: {
    poll: async () => { effects += 1; }, send: async () => { effects += 1; }
  }, hostRunner: async () => { effects += 1; } }), { status: "stopped", processed: false });
  assert.equal(effects, 0);
});
test("host failure after invocation blocks an ambiguous unanswered message", async (t) => {
  const { root, agentId } = await fixture(t);
  await ingest(root, agentId);
  const result = await runWorkerTick({ root, workerId: "worker:offline", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async () => { throw new Error("synthetic host unavailable"); },
    adapter: { send: async () => { throw new Error("must not send"); } } });
  assert.equal(result.status, "blocked");
  const { runtime } = await loadGatewayRuntime(root);
  assert.equal(runtime.queue[0].status, "blocked");
  assert.match(runtime.queue[0].lastError, /manual owner review/);
  assert.equal(runtime.queue[0].lease, null);
  assert.equal(runtime.outbox.length, 0);
});
test("prepared delivery survives restart and effect-none failures retry with backoff", async (t) => {
  const { root, agentId } = await fixture(t);
  const completed = await prepareDelivery(root, agentId);
  assert.equal((await loadGatewayRuntime(root)).runtime.outbox[0].status, "prepared");
  let sends = 0;
  const failed = await runWorkerTick({ root, workerId: "worker:restart-one", now: "2032-01-01T00:00:07.000Z",
    hostRunner: async () => { throw new Error("prepared delivery must run before host work"); },
    adapter: { send: async () => { sends += 1; return { ok: false, effect: "none", error: "rate limited", retryAfterMs: 5000 }; } } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.recoveredDelivery, true);
  await assert.rejects(deliverPrepared({ root, outboxId: completed.outbox.outboxId,
    now: "2032-01-01T00:00:10.000Z", adapter: { send: async () => ({ ok: true }) } }), /retry is not due/);
  const delivered = await runWorkerTick({ root, workerId: "worker:restart-two", now: "2032-01-01T00:00:12.000Z",
    hostRunner: async () => { throw new Error("retry delivery must run before host work"); },
    adapter: { send: async () => { sends += 1; return { ok: true, receipt: "telegram-message:retry" }; } } });
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.recoveredDelivery, true);
  assert.equal(sends, 2);
});
test("ambiguous send remains delivery-unknown without a duplicate effect", async (t) => {
  const { root, agentId } = await fixture(t);
  const completed = await prepareDelivery(root, agentId);
  let observedSending = false;
  const ambiguous = await deliverPrepared({ root, outboxId: completed.outbox.outboxId,
    now: "2032-01-01T00:00:07.000Z", adapter: { send: async () => {
      observedSending = (await loadGatewayRuntime(root)).runtime.outbox[0].status === "sending";
      throw new Error("connection lost after write");
    } } });
  assert.equal(observedSending, true);
  assert.equal(ambiguous.outbox.status, "delivery-unknown");
  await assert.rejects(deliverPrepared({ root, outboxId: completed.outbox.outboxId,
    adapter: { send: async () => ({ ok: true }) } }), /not safely retryable/);
});

test("exhausted demonstrably effect-free sends terminate in dead-letter", async (t) => {
  const { root, agentId } = await fixture(t);
  const completed = await prepareDelivery(root, agentId);
  let sends = 0;
  for (const now of ["2032-01-01T00:00:07.000Z", "2032-01-01T00:00:09.000Z", "2032-01-01T00:00:13.000Z"]) {
    await deliverPrepared({ root, outboxId: completed.outbox.outboxId, now,
      adapter: { send: async () => { sends += 1; return { ok: false, effect: "none", error: "synthetic rejection" }; } } });
  }
  const outbox = (await loadGatewayRuntime(root)).runtime.outbox[0];
  assert.equal(outbox.status, "dead-letter");
  assert.equal(sends, 3);
  await assert.rejects(deliverPrepared({ root, outboxId: outbox.outboxId,
    adapter: { send: async () => { sends += 1; return { ok: true }; } } }), /not safely retryable/);
  assert.equal(sends, 3);
});

test("revoked exact reply capability prevents delivery after answer preparation", async (t) => {
  const { root, agentId } = await fixture(t);
  const completed = await prepareDelivery(root, agentId);
  await revokeChannelBinding({ root, id: "channel-binding:telegram", reason: "Synthetic revocation.",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:06.500Z" });
  let sends = 0;
  const rejected = await deliverPrepared({ root, outboxId: completed.outbox.outboxId,
    adapter: { send: async () => { sends += 1; return { ok: true }; } }, now: "2032-01-01T00:00:07.000Z" });
  assert.equal(rejected.outbox.status, "dead-letter");
  assert.match(rejected.outbox.lastError, /reply capability is unavailable/);
  assert.equal(sends, 0);
});

test("persona leave cancels queued work before host execution", async (t) => {
  const { root, agentId } = await fixture(t);
  await ingest(root, agentId);
  await reconcileGateway({ root, now: "2032-01-01T00:00:04.000Z" });
  await leavePersona(root, "2032-01-01T00:00:04.500Z");
  const claim = await claimReadOnlyGatewayWork({ root, workerId: "worker:revoked", now: "2032-01-01T00:00:05.000Z" });
  assert.equal(claim.item, null);
  assert.equal((await loadGatewayRuntime(root)).runtime.queue[0].status, "cancelled");
});

test("persona leave blocks an already prepared channel effect", async (t) => {
  const { root, agentId } = await fixture(t);
  const completed = await prepareDelivery(root, agentId);
  await leavePersona(root, "2032-01-01T00:00:06.500Z");
  let sends = 0;
  const outcome = await deliverPrepared({ root, outboxId: completed.outbox.outboxId,
    adapter: { send: async () => { sends += 1; return { ok: true }; } }, now: "2032-01-01T00:00:07.000Z" });
  assert.equal(outcome.outbox.status, "dead-letter");
  assert.match(outcome.outbox.lastError, /active authenticated agent or bot/);
  assert.equal(sends, 0);
});

