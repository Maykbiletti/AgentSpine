import { createHash } from "node:crypto";

function digest(parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

// Produce opaque continuity references from an already authenticated channel
// event. Raw account, chat and thread identifiers never enter timeline state.
export function channelTimelineContinuity(event) {
  if (!event) return null;
  const portalRef = `portal-ref:${digest([
    "agentspine.portal-ref/v1", event.provider, event.tenantId, event.accountId, event.bindingId
  ])}`;
  const threadRef = `thread-ref:${digest([
    "agentspine.thread-ref/v1", portalRef, event.chatId, event.threadId || "",
    event.sessionKey, event.agentId, event.projectId, event.groupId || ""
  ])}`;
  return { portalRef, threadRef };
}
