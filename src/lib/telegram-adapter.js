import { createHmac } from "node:crypto";
import {
  channelEventSigningPayload, ingestChannelEvent, loadChannelPolicy
} from "./channel-runtime.js";

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,80}$/;

function numeric(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const raw = String(value).split(":").at(-1);
  if (!/^-?\d{1,20}$/.test(raw)) throw new Error(field + " must resolve to an exact Telegram numeric ID");
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new Error(field + " exceeds the safe integer range");
  return number;
}

export function createTelegramAdapter({ root = process.cwd(), env = process.env, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error("Telegram timeout must be 1000-30000 ms");
  const offsets = new Map();
  return {
    async poll() {
      const { policy } = await loadChannelPolicy(root);
      const bindings = policy.bindings.filter((item) => item.status === "active" && item.provider === "telegram"
        && item.capabilities.includes("receive") && item.capabilities.includes("reply") && item.outboundSecretEnv);
      const accounts = [...new Map(bindings.map((item) => [
        [item.tenantId, item.accountId, item.outboundSecretEnv].join("\0"),
        { tenantId: item.tenantId, accountId: item.accountId, tokenEnv: item.outboundSecretEnv }
      ])).values()];
      let ingested = 0; let ignored = 0; let rejected = 0;
      for (const account of accounts) {
        const token = env[account.tokenEnv];
        if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("Telegram credential is unavailable or malformed");
        const accountKey = [account.tenantId, account.accountId, account.tokenEnv].join("\0");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
          response = await fetchImpl("https://api.telegram.org/bot" + token + "/getUpdates", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ offset: offsets.get(accountKey) || 0, timeout: 0, allowed_updates: ["message"] }),
            signal: controller.signal, redirect: "error"
          });
        } catch (error) {
          throw new Error(error.name === "AbortError" ? "Telegram poll timeout" : "Telegram poll transport failed");
        } finally { clearTimeout(timer); }
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        if (!response.ok || payload?.ok !== true || !Array.isArray(payload.result) || payload.result.length > 100) {
          throw new Error("Telegram poll response is invalid");
        }
        for (const update of payload.result) {
          if (!Number.isSafeInteger(update?.update_id)) { rejected += 1; continue; }
          offsets.set(accountKey, Math.max(offsets.get(accountKey) || 0, update.update_id + 1));
          const message = update.message;
          const chatId = message?.chat?.id === undefined ? null : String(message.chat.id);
          const threadId = message?.message_thread_id === undefined ? null : String(message.message_thread_id);
          const senderId = message?.from?.id === undefined ? null : String(message.from.id);
          const binding = bindings.find((item) => item.tenantId === account.tenantId && item.accountId === account.accountId
            && item.chatId === chatId && item.threadId === threadId && item.senderIds.includes(senderId));
          if (!binding || typeof message?.text !== "string" || !Number.isSafeInteger(message.message_id)) { ignored += 1; continue; }
          const observedAt = Number.isSafeInteger(message.date)
            ? new Date(message.date * 1000).toISOString() : new Date().toISOString();
          const event = {
            schema: "agentspine.channel-event/v1", eventId: "telegram:update:" + update.update_id,
            provider: "telegram", tenantId: binding.tenantId, accountId: binding.accountId,
            chatId: binding.chatId, threadId: binding.threadId, senderId,
            replyTo: String(message.message_id), observedAt,
            privacy: binding.groupId === null ? "private" : "group", text: message.text
          };
          const secret = env[binding.secretEnv];
          if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
            throw new Error("Telegram ingress signing secret is unavailable or too short");
          }
          const signature = "sha256=" + createHmac("sha256", secret).update(channelEventSigningPayload(event)).digest("hex");
          try {
            const result = await ingestChannelEvent({ root, event, signature, env, now: observedAt });
            if (!result.duplicate) ingested += 1;
          } catch { rejected += 1; }
        }
      }
      return { accounts: accounts.length, ingested, ignored, rejected };
    },
    async send(outbox) {
      if (outbox.provider !== "telegram") return { ok: false, effect: "none", error: "unsupported adapter provider" };
      const { policy } = await loadChannelPolicy(root);
      const binding = policy.bindings.find((item) => item.id === outbox.bindingId && item.status === "active"
        && item.provider === "telegram" && item.tenantId === outbox.tenantId && item.accountId === outbox.accountId
        && item.chatId === outbox.chatId && item.threadId === outbox.threadId && item.capabilities.includes("reply"));
      if (!binding) return { ok: false, effect: "none", error: "current Telegram reply binding is unavailable" };
      const token = env[binding.outboundSecretEnv];
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, effect: "none", error: "Telegram credential is unavailable or malformed" };
      const body = { chat_id: numeric(outbox.chatId, "chatId"), text: outbox.text };
      if (outbox.threadId !== null) body.message_thread_id = numeric(outbox.threadId, "threadId");
      if (outbox.replyTo !== null) body.reply_parameters = { message_id: numeric(outbox.replyTo, "replyTo") };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl("https://api.telegram.org/bot" + token + "/sendMessage", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          signal: controller.signal, redirect: "error"
        });
      } catch (error) {
        return { ok: false, effect: "unknown", error: error.name === "AbortError" ? "Telegram send timeout" : "Telegram transport failed" };
      } finally { clearTimeout(timer); }
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      if (response.ok && payload?.ok === true && Number.isSafeInteger(payload.result?.message_id)) {
        return { ok: true, receipt: "telegram-message:" + payload.result.message_id };
      }
      const retryAfter = Number(payload?.parameters?.retry_after);
      if (response.status === 429 && Number.isFinite(retryAfter)) {
        return { ok: false, effect: "none", error: "Telegram rate limited", retryAfterMs: Math.min(300000, retryAfter * 1000) };
      }
      if (response.status >= 500) return { ok: false, effect: "none", error: "Telegram server rejected the send" };
      return { ok: false, effect: "none", error: "Telegram send was rejected" };
    }
  };
}
