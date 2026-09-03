import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelEventSigningPayload, channelRuntimeContext, claimChannelEvent,
  completeChannelEvent, grantChannelBinding, ingestChannelEvent,
  loadChannelPolicy, loadChannelRuntime, revokeChannelBinding
} from "../src/lib/channel-runtime.js";
import { runAudit } from "../src/lib/audit.js";
import { runHook } from "../src/hook.js";
import { linkEntities, upsertEntity } from "../src/lib/graph.js";

const SECRET = "synthetic-channel-secret-that-is-at-least-32-bytes";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sign(event) {
  return `sha256=${createHmac("sha256", SECRET).update(channelEventSigningPayload(event)).digest("hex")}`;
}

function runCli(args) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-channel-runtime-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-channel-runtime-state-"));
  const previousState = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previousState === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previousState;
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
  });
  const sources = {
    "AGENTS.md": "# Synthetic rules\n\nDo not rewrite this file.\n",
    "SOUL.md": "# Synthetic voice\n\nWarm and direct.\n",
    "MEMORY.md": "# Synthetic memory\n\nNo channel authority.\n"
  };
  for (const [name, content] of Object.entries(sources)) await writeFile(join(root, name), content, "utf8");
  const before = Object.fromEntries(await Promise.all(Object.keys(sources).map(async (name) => [name, digest(await readFile(join(root, name)))])));
  await upsertEntity({ root, id: "agent:franz", kind: "agent", privacy: "shared" });
  await upsertEntity({ root, id: "agent:otto", kind: "agent", privacy: "shared" });
  await upsertEntity({ root, id: "project:synthetic", kind: "project", privacy: "shared" });
  await upsertEntity({ root, id: "group:synthetic", kind: "group", privacy: "shared" });
  await linkEntities({ root, from: "agent:franz", to: "group:synthetic", relation: "member-of", privacy: "group" });
  await grantChannelBinding({
    root,
    id: "channel-binding:franz",
    provider: "telegram",
    tenantId: "tenant:synthetic",
    accountId: "bot:franz",
    chatId: "-1001234567890",
    threadId: "42",
    senderIds: ["user:mayk"],
    agentId: "agent:franz",
    projectId: "project:synthetic",
    groupId: "group:synthetic",
    sessionKey: "agent:franz:telegram:group:-1001234567890:topic:42",
    secretEnv: "AGENTSPINE_TEST_TELEGRAM_SECRET", outboundSecretEnv: "AGENTSPINE_TEST_TELEGRAM_SECRET",
    capabilities: ["receive", "reply"],
    confirmation: "local-owner-confirmed",
    now: "2032-01-01T00:00:00.000Z"
  });
  return { root, before, env: { AGENTSPINE_TEST_TELEGRAM_SECRET: SECRET } };
}

function event(overrides = {}) {
  return {
    schema: "agentspine.channel-event/v1",
    eventId: "telegram:update:1001",
    provider: "telegram",
    tenantId: "tenant:synthetic",
    accountId: "bot:franz",
    chatId: "-1001234567890",
    threadId: "42",
    senderId: "user:mayk",
    replyTo: "telegram:message:900",
    observedAt: "2032-01-01T00:00:01.000Z",
    privacy: "group",
    text: "Bitte prüfe den synthetischen Auftrag.",
    ...overrides
  };
}

test("authenticated channel ingress binds one exact event to one agent lane without touching sources", async (t) => {
  const { root, before, env } = await fixture(t);
  const input = event();
  const first = await ingestChannelEvent({ root, event: input, signature: sign(input), env, now: "2032-01-01T00:00:02.000Z" });
  assert.equal(first.duplicate, false);
  assert.equal(first.event.agentId, "agent:franz");
  assert.equal(first.event.projectId, "project:synthetic");
  assert.equal(first.event.groupId, "group:synthetic");
  assert.equal(first.event.sessionKey, "agent:franz:telegram:group:-1001234567890:topic:42");
  assert.equal(first.event.status, "pending");
  assert.equal(first.event.authority, "execution-state-only");
  assert.equal(first.event.text, input.text);
  assert.equal("signature" in first.event, false);

  const repeated = await ingestChannelEvent({ root, event: input, signature: sign(input), env, now: "2032-01-01T00:00:03.000Z" });
  assert.equal(repeated.duplicate, true);
  assert.equal((await loadChannelRuntime(root)).runtime.events.length, 1);
  assert.equal((await loadChannelRuntime(root)).runtime.receipts.length, 1);
  for (const [name, expected] of Object.entries(before)) assert.equal(digest(await readFile(join(root, name))), expected);
});

test("route, sender, signature, schema, secret, and collision failures are fail-closed", async (t) => {
  const { root, env } = await fixture(t);
  const valid = event();
  await assert.rejects(ingestChannelEvent({ root, event: valid, signature: `sha256=${"0".repeat(64)}`, env }), /signature/i);
  await assert.rejects(ingestChannelEvent({ root, event: event({ chatId: "-100999" }), signature: sign(event({ chatId: "-100999" })), env }), /binding/i);
  await assert.rejects(ingestChannelEvent({ root, event: event({ senderId: "user:intruder" }), signature: sign(event({ senderId: "user:intruder" })), env }), /sender/i);
  await assert.rejects(ingestChannelEvent({ root, event: { ...valid, agentId: "agent:otto" }, signature: "sha256=invalid", env }), /unknown field/i);
  const secret = event({ eventId: "telegram:update:secret", text: "token=abcdefghijklmnopqrstuvwxyz1234567890" });
  await assert.rejects(ingestChannelEvent({ root, event: secret, signature: sign(secret), env }), /secret/i);

  await ingestChannelEvent({ root, event: valid, signature: sign(valid), env });
  const changed = event({ text: "A different payload under the same ID." });
  await assert.rejects(ingestChannelEvent({ root, event: changed, signature: sign(changed), env }), /collision/i);
  assert.equal((await loadChannelRuntime(root)).runtime.events.length, 1);
});

test("a native SessionStart injects one exact authenticated message without a model-side MCP call", async (t) => {
  const { root, env } = await fixture(t);
  const input = event();
  await ingestChannelEvent({ root, event: input, signature: sign(input), env, now: "2032-01-01T00:00:02.000Z" });
  const result = await runHook({
    hook_event_name: "SessionStart", host: "codex", cwd: root,
    entity_id: "agent:franz", project_id: "project:synthetic", group_id: "group:synthetic",
    session_id: "session:channel:one", timestamp: "2032-01-01T00:00:03.000Z",
    agent_spine_channel_event: { event_id: input.eventId, provider: "telegram" }
  });
  const context = JSON.parse(result.context);
  assert.equal(context.channelEvent.eventId, input.eventId);
  assert.equal(context.channelEvent.text, input.text);
  assert.equal(context.channelEvent.chatId, input.chatId);
  assert.equal(context.channelEvent.threadId, input.threadId);
  assert.equal(context.channelEvent.agentId, "agent:franz");
  assert.equal(context.channelEvent.authority, "explicit-local-channel-policy");
  assert.match(context.channelEvent.instruction, /exact authenticated channel event/);
  assert.equal((await loadChannelRuntime(root)).runtime.events[0].status, "leased");
});

test("a stock host SessionStart receives exact gateway scope through the worker environment bridge", async (t) => {
  const { root, env } = await fixture(t);
  const input = event({ eventId: "telegram:update:gateway-env" });
  await ingestChannelEvent({ root, event: input, signature: sign(input), env, now: "2032-01-01T00:00:02.000Z" });
  const keys = {
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
    AGENTSPINE_HOST: "codex",
    AGENTSPINE_ENTITY_ID: "agent:franz",
    AGENTSPINE_PROJECT_ID: "project:synthetic",
    AGENTSPINE_GROUP_ID: "group:synthetic",
    AGENTSPINE_CHANNEL_EVENT_ID: input.eventId,
    AGENTSPINE_CHANNEL_PROVIDER: "telegram"
  };
  const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, keys);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const result = await runHook({
    hook_event_name: "SessionStart", model: "gpt-5.6-codex", cwd: root,
    session_id: "session:gateway-env", timestamp: "2032-01-01T00:00:03.000Z"
  });
  const context = JSON.parse(result.context);
  assert.equal(context.channelEvent.eventId, input.eventId);
  assert.equal(context.channelEvent.agentId, "agent:franz");
  assert.equal(context.briefing.scope.groupId, "group:synthetic");
  assert.equal(context.briefing.host, "codex");
});

test("parallel workers lease once, exact scope is enforced, and an expired lease recovers", async (t) => {
  const { root, env } = await fixture(t);
  const input = event();
  await ingestChannelEvent({ root, event: input, signature: sign(input), env, now: "2032-01-01T00:00:02.000Z" });
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => claimChannelEvent({
    root,
    agentId: "agent:franz",
    projectId: "project:synthetic",
    groupId: "group:synthetic",
    provider: "telegram",
    workerId: `worker:${index}`,
    leaseSeconds: 15,
    now: "2032-01-01T00:00:03.000Z"
  })));
  assert.equal(claims.filter((claim) => claim.event).length, 1);
  const winner = claims.find((claim) => claim.event);
  assert.equal(winner.event.status, "leased");
  const isolated = await claimChannelEvent({
    root, agentId: "agent:otto", projectId: "project:synthetic", groupId: "group:synthetic",
    provider: "telegram", workerId: "worker:wrong", now: "2032-01-01T00:00:04.000Z"
  });
  assert.equal(isolated.event, null);

  const recovered = await claimChannelEvent({
    root, agentId: "agent:franz", projectId: "project:synthetic", groupId: "group:synthetic",
    provider: "telegram", workerId: "worker:recovered", leaseSeconds: 15,
    now: "2032-01-01T00:00:19.000Z"
  });
  assert.equal(recovered.event.eventId, input.eventId);
  assert.equal(recovered.event.lease.workerId, "worker:recovered");
  assert.equal(recovered.event.attempts, 2);
  const completed = await completeChannelEvent({
    root, eventId: input.eventId, workerId: "worker:recovered", status: "completed",
    now: "2032-01-01T00:00:20.000Z"
  });
  assert.equal(completed.event.status, "completed");
  assert.equal(completed.event.lease, null);
  assert.equal((await channelRuntimeContext({ root, agentId: "agent:franz", projectId: "project:synthetic" })).items.length, 0);
});

test("revocation immediately blocks new ingress and invalidates pending or leased work", async (t) => {
  const { root, env } = await fixture(t);
  const input = event();
  await ingestChannelEvent({ root, event: input, signature: sign(input), env });
  await revokeChannelBinding({
    root, id: "channel-binding:franz", reason: "Synthetic route retired.",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:10.000Z"
  });
  const context = await channelRuntimeContext({ root, agentId: "agent:franz", projectId: "project:synthetic", includeTerminal: true });
  assert.equal(context.items[0].status, "cancelled");
  const next = event({ eventId: "telegram:update:1002" });
  await assert.rejects(ingestChannelEvent({ root, event: next, signature: sign(next), env }), /binding/i);
  assert.equal((await loadChannelPolicy(root)).policy.bindings[0].status, "revoked");
});

test("the ten-gate audit detects forged channel authority while preserving every source byte", async (t) => {
  const { root, before } = await fixture(t);
  const healthy = await runAudit(root);
  assert.equal(healthy.ok, true);
  const loaded = await loadChannelPolicy(root);
  loaded.policy.bindings[0].authority = "relationship-memory";
  await writeFile(loaded.channelPolicyPath, `${JSON.stringify(loaded.policy)}\n`, "utf8");
  const failed = await runAudit(root);
  assert.equal(failed.ok, false);
  assert.equal(failed.gates.find((gate) => gate.name === "Authority boundary").ok, false);
  assert.equal(failed.gates.find((gate) => gate.name === "Byte preservation").ok, true);
  for (const [name, expected] of Object.entries(before)) assert.equal(digest(await readFile(join(root, name))), expected);
});

test("the audit rejects forged retained channel history, payloads, and receipts", async (t) => {
  const historyFixture = await fixture(t);
  const historyEvent = event();
  await ingestChannelEvent({ root: historyFixture.root, event: historyEvent, signature: sign(historyEvent), env: historyFixture.env });
  await claimChannelEvent({
    root: historyFixture.root, eventId: historyEvent.eventId, agentId: "agent:franz",
    projectId: "project:synthetic", groupId: "group:synthetic", provider: "telegram",
    workerId: "worker:history", now: "2032-01-01T00:00:03.000Z"
  });
  const loadedRuntime = await loadChannelRuntime(historyFixture.root);
  loadedRuntime.runtime.history[0].value.text = "Forged archived payload.";
  await writeFile(loadedRuntime.channelRuntimePath, `${JSON.stringify(loadedRuntime.runtime)}\n`, "utf8");
  assert.equal((await runAudit(historyFixture.root)).ok, false);

  const receiptFixture = await fixture(t);
  const receiptEvent = event();
  await ingestChannelEvent({ root: receiptFixture.root, event: receiptEvent, signature: sign(receiptEvent), env: receiptFixture.env });
  const loadedReceipt = await loadChannelRuntime(receiptFixture.root);
  loadedReceipt.runtime.receipts[0].digest = "0".repeat(64);
  await writeFile(loadedReceipt.channelRuntimePath, `${JSON.stringify(loadedReceipt.runtime)}\n`, "utf8");
  assert.equal((await runAudit(receiptFixture.root)).ok, false);

  const policyFixture = await fixture(t);
  await revokeChannelBinding({
    root: policyFixture.root, id: "channel-binding:franz", reason: "Synthetic retirement.",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:10.000Z"
  });
  const loadedPolicy = await loadChannelPolicy(policyFixture.root);
  loadedPolicy.policy.history[0].value.authority = "relationship-memory";
  await writeFile(loadedPolicy.channelPolicyPath, `${JSON.stringify(loadedPolicy.policy)}\n`, "utf8");
  assert.equal((await runAudit(policyFixture.root)).ok, false);
});

test("CLI exposes local channel policy and status but requires confirmation for revocation", async (t) => {
  const { root } = await fixture(t);
  assert.equal(runCli(["channel-policy", root, "--json"]).bindings[0].id, "channel-binding:franz");
  assert.equal(runCli(["channel-events", root, "--include-terminal", "--json"]).items.length, 0);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const denied = spawnSync(process.execPath, [
    cli, "channel-revoke", "channel-binding:franz", "--reason", "Synthetic retirement.",
    "--root", root, "--json"
  ], { encoding: "utf8", env: process.env });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /explicit local owner confirmation/);
  const revoked = runCli([
    "channel-revoke", "channel-binding:franz", "--reason", "Synthetic retirement.",
    "--confirm-local-channel", "--root", root, "--json"
  ]);
  assert.equal(revoked.binding.status, "revoked");
});
