import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPersonaRoster, loadPersonaRuntime } from "../src/lib/persona-runtime.js";
import { upsertEntity } from "../src/lib/graph.js";
import {
  channelEventSigningPayload, grantChannelBinding, ingestChannelEvent
} from "../src/lib/channel-runtime.js";
import {
  claimGatewayWork, completeGatewayRun, reconcileGateway, setGatewayControl
} from "../src/lib/gateway-runtime.js";
import { markTestGatewayHostStarted } from "./gateway-claim-fixture.js";

import { runAudit } from "../src/lib/audit.js";
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-gateway-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-gateway-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
  });
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n\nNever rewrite.\n");
  await writeFile(join(root, "SOUL.md"), "# Synthetic voice\n\nWarm and direct.\n");
  await upsertEntity({ root, id: "project:alpha", kind: "project", privacy: "shared" });
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  const roster = await applyPersonaRoster({
    root,
    bindings: [{
      id: "persona-binding:franz", authenticator: "host-manifest", issuer: "host:local",
      tenantId: "tenant:alpha", host: "codex", profileId: "profile:alpha",
      subjectId: "subject:franz", kind: "agent", displayName: "Franz",
      sourceBinding: ".codex/agents/franz.md", groupId: "group:alpha"
    }],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:00.000Z"
  });
  const agentId = roster.runtime.personas[0].personaId;
  await setGatewayControl({ root, enabled: true, killSwitch: false,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:00.500Z" });
  await grantChannelBinding({
    root, id: "channel-binding:telegram", provider: "telegram", tenantId: "tenant:alpha",
    accountId: "123456789", chatId: "-1001234567890", threadId: "42",
    senderIds: ["777"], agentId, projectId: "project:alpha", groupId: "group:alpha",
    sessionKey: "session:franz:telegram", secretEnv: "AGENTSPINE_TEST_INGRESS",
    outboundSecretEnv: "AGENTSPINE_TEST_TELEGRAM", capabilities: ["receive", "reply"],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });
  return { root, agentId, before: await readFile(join(root, "SOUL.md"), "utf8") };
}
export async function addSyntheticPersona(root, {
  bindingId, subjectId, host, profileId, displayName, groupId = "group:alpha", tenantId = "tenant:alpha", now
}) {
  if (groupId !== "group:alpha") await upsertEntity({ root, id: groupId, kind: "group", privacy: "shared" });
  const roster = await applyPersonaRoster({
    root,
    bindings: [{
      id: bindingId, authenticator: "host-manifest", issuer: "host:local", tenantId, host, profileId,
      subjectId, kind: "agent", displayName, sourceBinding: `.${host}/agents/${subjectId.split(":").at(-1)}.md`, groupId
    }],
    confirmation: "local-owner-confirmed", now
  });
  return roster.policy.bindings.find((item) => item.id === bindingId).personaId;
}
export async function ingest(root, agentId) {
  const event = {
    schema: "agentspine.channel-event/v1", eventId: "telegram:update:1001", provider: "telegram",
    tenantId: "tenant:alpha", accountId: "123456789", chatId: "-1001234567890", threadId: "42",
    senderId: "777", replyTo: "900", observedAt: "2032-01-01T00:00:02.000Z",
    privacy: "group", text: "Bitte antworte im gebundenen Thema."
  };
  const secret = "synthetic-ingress-secret-with-32-bytes";
  const signature = `sha256=${createHmac("sha256", secret).update(channelEventSigningPayload(event)).digest("hex")}`;
  await ingestChannelEvent({ root, event, signature, env: { AGENTSPINE_TEST_INGRESS: secret }, now: "2032-01-01T00:00:03.000Z" });
  return { event, agentId };
}
export async function prepareDelivery(root, agentId, workerId = "worker:delivery") {
  await ingest(root, agentId);
  await reconcileGateway({ root, now: "2032-01-01T00:00:04.000Z" });
  const claim = await claimGatewayWork({ root, workerId, now: "2032-01-01T00:00:05.000Z" });
  await markTestGatewayHostStarted(root, claim, "2032-01-01T00:00:05.500Z");
  return completeGatewayRun({ root, queueId: claim.item.queueId, workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { text: "Die Antwort bleibt exakt gebunden." }, now: "2032-01-01T00:00:06.000Z" });
}
export async function leavePersona(root, now) {
  const { policy } = await loadPersonaRuntime(root);
  const binding = policy.bindings[0];
  await applyPersonaRoster({ root, bindings: [{
    id: binding.id, authenticator: binding.authenticator, issuer: binding.issuer,
    tenantId: binding.tenantId, host: binding.host, profileId: binding.profileId,
    subjectId: binding.subjectId, kind: binding.kind, displayName: binding.displayName,
    sourceBinding: binding.sourceBinding, groupId: binding.groupId, active: false
  }], confirmation: "local-owner-confirmed", now });
}

