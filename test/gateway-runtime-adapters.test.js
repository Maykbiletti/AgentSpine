import test from "node:test";
import assert from "node:assert/strict";
import { loadChannelRuntime } from "../src/lib/channel-runtime.js";
import { createTelegramAdapter } from "../src/lib/telegram-adapter.js";
import { fixture } from "./gateway-runtime-fixture.js";

test("Telegram adapter validates the exact binding and emits a bounded Bot API request", async (t) => {
  const { root } = await fixture(t);
  let request;
  const adapter = createTelegramAdapter({
    root,
    env: { AGENTSPINE_TEST_TELEGRAM: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 903 } }) };
    }
  });
  const outcome = await adapter.send({
    provider: "telegram", bindingId: "channel-binding:telegram", tenantId: "tenant:alpha",
    accountId: "123456789", chatId: "-1001234567890", threadId: "42", replyTo: "900",
    text: "Synthetische Antwort."
  });
  assert.deepEqual(outcome, { ok: true, receipt: "telegram-message:903" });
  assert.match(request.url, /^https:\/\/api\.telegram\.org\/bot123456789:/);
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: -1001234567890, text: "Synthetische Antwort.", message_thread_id: 42,
    reply_parameters: { message_id: 900 }
  });
  assert.equal(request.options.redirect, "error");
});

test("Telegram polling authenticates and ingests a bound update without a chat prompt", async (t) => {
  const { root } = await fixture(t);
  const adapter = createTelegramAdapter({
    root,
    env: {
      AGENTSPINE_TEST_TELEGRAM: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234",
      AGENTSPINE_TEST_INGRESS: "synthetic-ingress-secret-with-32-bytes"
    },
    fetchImpl: async (url, options) => {
      assert.match(url, /\/getUpdates$/);
      assert.deepEqual(JSON.parse(options.body).allowed_updates, ["message"]);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: [{
          update_id: 1002,
          message: {
            message_id: 904, date: 1956528002, message_thread_id: 42,
            chat: { id: -1001234567890 }, from: { id: 777 },
            text: "Automatisch eingegangene Nachricht."
          }
        }] })
      };
    }
  });
  assert.deepEqual(await adapter.poll(), { accounts: 1, ingested: 1, ignored: 0, rejected: 0 });
  const { runtime } = await loadChannelRuntime(root);
  assert.equal(runtime.events[0].eventId, "telegram:update:1002");
  assert.equal(runtime.events[0].status, "pending");
  assert.equal(runtime.events[0].replyTo, "904");
});

