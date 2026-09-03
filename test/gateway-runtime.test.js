import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPersonaRoster, loadPersonaRuntime } from "../src/lib/persona-runtime.js";
import { recordAttentionEvent } from "../src/lib/attention.js";
import { createTask } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import {
  channelEventSigningPayload, grantChannelBinding, ingestChannelEvent, loadChannelRuntime, revokeChannelBinding
} from "../src/lib/channel-runtime.js";
import {
  assignGoal, claimGatewayWork, completeGatewayRun, deliverPrepared,
  gatewayContext, gatewayHealthFindings, gatewayRuntimeFindings, loadGatewayRuntime, reconcileGateway,
  resolveGoalKnowledgeGap, setGatewayControl
} from "../src/lib/gateway-runtime.js";
import { createTelegramAdapter } from "../src/lib/telegram-adapter.js";
import { runWorkerTick, waitForGatewayWake } from "../src/worker.js";
import { runAudit } from "../src/lib/audit.js";

async function fixture(t) {
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

async function addSyntheticPersona(root, {
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

async function ingest(root, agentId) {
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

async function prepareDelivery(root, agentId, workerId = "worker:delivery") {
  await ingest(root, agentId);
  await reconcileGateway({ root, now: "2032-01-01T00:00:04.000Z" });
  const claim = await claimGatewayWork({ root, workerId, now: "2032-01-01T00:00:05.000Z" });
  return completeGatewayRun({ root, queueId: claim.item.queueId, workerId,
    result: { text: "Die Antwort bleibt exakt gebunden." }, now: "2032-01-01T00:00:06.000Z" });
}

async function leavePersona(root, now) {
  const { policy } = await loadPersonaRuntime(root);
  const binding = policy.bindings[0];
  await applyPersonaRoster({ root, bindings: [{
    id: binding.id, authenticator: binding.authenticator, issuer: binding.issuer,
    tenantId: binding.tenantId, host: binding.host, profileId: binding.profileId,
    subjectId: binding.subjectId, kind: binding.kind, displayName: binding.displayName,
    sourceBinding: binding.sourceBinding, groupId: binding.groupId, active: false
  }], confirmation: "local-owner-confirmed", now });
}

test("authenticated Telegram event wakes one agent lane and returns exactly one origin-bound reply", async (t) => {
  const { root, agentId, before } = await fixture(t);
  await ingest(root, agentId);
  await reconcileGateway({ root, now: "2032-01-01T00:00:04.000Z" });
  const claimed = await claimGatewayWork({ root, workerId: "worker:one", now: "2032-01-01T00:00:05.000Z" });
  assert.equal(claimed.item.kind, "direct-message");
  assert.equal(claimed.item.agentId, agentId);
  await assert.rejects(completeGatewayRun({
    root, queueId: claimed.item.queueId, workerId: "worker:one",
    result: { text: "Ich liebe dich und ich habe Gefühle." }, now: "2032-01-01T00:00:05.500Z"
  }), /prohibited attachment or consciousness/i);
  const completed = await completeGatewayRun({
    root, queueId: claimed.item.queueId, workerId: "worker:one",
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

test("host failure persists a bounded retry instead of losing an unanswered message", async (t) => {
  const { root, agentId } = await fixture(t);
  await ingest(root, agentId);
  const result = await runWorkerTick({ root, workerId: "worker:offline", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async () => { throw new Error("synthetic host unavailable"); },
    adapter: { send: async () => { throw new Error("must not send"); } } });
  assert.equal(result.status, "pending");
  const { runtime } = await loadGatewayRuntime(root);
  assert.equal(runtime.queue[0].status, "pending");
  assert.match(runtime.queue[0].lastError, /Host runtime unavailable/);
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
  const claim = await claimGatewayWork({ root, workerId: "worker:revoked", now: "2032-01-01T00:00:05.000Z" });
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

test("authenticated goal assignment remains idle-safe without a goal and checkpointed with one", async (t) => {
  const { root, agentId } = await fixture(t);
  assert.equal((await claimGatewayWork({ root, workerId: "worker:idle" })).reason, "idle/needs-goal");
  await assignGoal({
    root, goalId: "goal:alpha", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Synthetic acceptance is green.", nextSafeStep: "Run the synthetic check.",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });
  const claim = await claimGatewayWork({ root, workerId: "worker:goal", now: "2032-01-01T00:00:02.000Z" });
  await completeGatewayRun({
    root, queueId: claim.item.queueId, workerId: "worker:goal",
    result: { checkpoint: { gate: 1 }, completed: false }, now: "2032-01-01T00:00:03.000Z"
  });
  const { policy, runtime } = await loadGatewayRuntime(root);
  assert.deepEqual(policy.goals[0].checkpoint, { gate: 1 });
  assert.equal(runtime.queue.some((item) => item.kind === "follow-up" && item.status === "pending"), true);
});

test("dependency-bound goal plans resume after a torn write and complete three objective steps in order", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const planSteps = [
    { stepId: "step:observe", title: "Observe the synthetic state.",
      successCriterion: "The observed digest is recorded.", dependsOn: [] },
    { stepId: "step:act", title: "Apply the bounded synthetic action.",
      successCriterion: "The bounded action reports success.", dependsOn: ["step:observe"] },
    { stepId: "step:verify", title: "Verify the synthetic outcome.",
      successCriterion: "The independent outcome check is green.", dependsOn: ["step:act"] }
  ];
  await assignGoal({
    root, goalId: "goal:vertical", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Three synthetic acceptance gates pass in dependency order.",
    steps: planSteps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });

  // Simulate the policy write surviving while the matching runtime write is lost.
  let loaded = await loadGatewayRuntime(root);
  loaded.runtime.queue = [];
  loaded.runtime.receipts = [];
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.000Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.500Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.goalStepId === "step:observe" && item.status === "pending").length, 1);

  const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:plan:${index}`, now: "2032-01-01T00:00:03.000Z"
  })));
  assert.equal(claims.filter((claim) => claim.item).length, 1);
  const observe = claims.find((claim) => claim.item);
  assert.equal(observe.item.goalStepId, "step:observe");
  await completeGatewayRun({ root, queueId: observe.item.queueId, workerId: observe.item.lease.workerId,
    result: { checkpoint: { observed: true }, completed: true }, now: "2032-01-01T00:00:04.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "active", "pending"]);
  assert.equal(loaded.policy.goals[0].status, "active");

  const act = await claimGatewayWork({ root, workerId: "worker:plan:act", now: "2032-01-01T00:00:05.000Z" });
  assert.equal(act.item.goalStepId, "step:act");
  await completeGatewayRun({ root, queueId: act.item.queueId, workerId: "worker:plan:act",
    result: { checkpoint: { dependency: "offline" }, blocked: true, blocker: "Synthetic dependency is unavailable." },
    now: "2032-01-01T00:00:05.500Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "blocked");
  const resumed = await assignGoal({
    root, goalId: "goal:vertical", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Three synthetic acceptance gates pass in dependency order.",
    steps: planSteps, confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:05.750Z"
  });
  assert.equal(resumed.resumed, true);
  const resumedAct = await claimGatewayWork({ root, workerId: "worker:plan:act-resumed", now: "2032-01-01T00:00:05.900Z" });
  assert.equal(resumedAct.item.goalStepId, "step:act");
  await completeGatewayRun({ root, queueId: resumedAct.item.queueId, workerId: "worker:plan:act-resumed",
    result: { checkpoint: { acted: true }, completed: true }, now: "2032-01-01T00:00:06.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "completed", "active"]);

  const verify = await claimGatewayWork({ root, workerId: "worker:plan:verify", now: "2032-01-01T00:00:07.000Z" });
  assert.equal(verify.item.goalStepId, "step:verify");
  await completeGatewayRun({ root, queueId: verify.item.queueId, workerId: "worker:plan:verify",
    result: { checkpoint: { verified: true }, completed: true }, now: "2032-01-01T00:00:08.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "completed", "completed"]);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);
});

test("provider-neutral goal plans hand dependent steps to exact authenticated teammates", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const teammateId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:linnea", subjectId: "subject:linnea", host: "claude",
    profileId: "profile:linnea", displayName: "Linnea", now: "2032-01-01T00:00:00.750Z"
  });
  const steps = [
    { stepId: "step:observe", agentId, title: "Observe the synthetic input.",
      successCriterion: "The input digest is recorded.", dependsOn: [] },
    { stepId: "step:analyze", agentId: teammateId, title: "Analyze the bounded synthetic input.",
      successCriterion: "The analysis fixture reports green.", dependsOn: ["step:observe"] },
    { stepId: "step:verify", agentId, title: "Verify the independent synthetic result.",
      successCriterion: "The independent verification reports green.", dependsOn: ["step:analyze"] }
  ];
  await assignGoal({
    root, goalId: "goal:team-handoff", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Two providers complete three dependent synthetic gates.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });

  // Simulate a torn policy/runtime write before the first team step is claimed.
  let loaded = await loadGatewayRuntime(root);
  loaded.runtime.queue = []; loaded.runtime.receipts = [];
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:01.500Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:01.750Z" });

  const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:team:${index}`, now: "2032-01-01T00:00:02.000Z"
  })));
  assert.equal(claims.filter((claim) => claim.item).length, 1);
  const first = claims.find((claim) => claim.item);
  assert.equal(first.item.agentId, agentId);
  await completeGatewayRun({ root, queueId: first.item.queueId, workerId: first.item.lease.workerId,
    result: { checkpoint: { observed: true }, completed: true }, now: "2032-01-01T00:00:03.000Z" });

  const routes = [];
  const second = await runWorkerTick({ root, workerId: "worker:team:claude", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async (item) => {
      routes.push([item.goalStep.stepId, item.agentId, item.host, item.profileId]);
      return { checkpoint: { analyzed: true }, completed: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(second.status, "completed");
  const third = await runWorkerTick({ root, workerId: "worker:team:codex", now: "2032-01-01T00:00:05.000Z",
    hostRunner: async (item) => {
      routes.push([item.goalStep.stepId, item.agentId, item.host, item.profileId]);
      return { checkpoint: { verified: true }, completed: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(third.status, "completed");
  assert.deepEqual(routes, [
    ["step:analyze", teammateId, "claude", "profile:linnea"],
    ["step:verify", agentId, "codex", "profile:alpha"]
  ]);

  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps.map((step) => step.status), ["completed", "completed", "completed"]);
  assert.equal((await gatewayContext({ root, agentId: teammateId })).goals[0].goalId, "goal:team-handoff");
  const foreignContext = await gatewayContext({ root, agentId: "agent:foreign" });
  assert.deepEqual(foreignContext.goals, []);
  assert.deepEqual(foreignContext.executionAttempts, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  loaded.policy.goals[0].plan.steps[1].agentId = agentId;
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy is invalid/i);
});

test("team plans reject foreign groups and pause safely when an assignee leaves", async (t) => {
  const { root, agentId } = await fixture(t);
  const teammateId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:solveig", subjectId: "subject:solveig", host: "claude",
    profileId: "profile:solveig", displayName: "Solveig", now: "2032-01-01T00:00:00.700Z"
  });
  const outsiderId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:outsider", subjectId: "subject:outsider", host: "codex",
    profileId: "profile:outsider", displayName: "Outsider", groupId: "group:beta",
    now: "2032-01-01T00:00:00.800Z"
  });
  const base = {
    root, agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The exact synthetic team completes its assigned gate.", confirmation: "local-owner-confirmed"
  };
  await assert.rejects(assignGoal({ ...base, goalId: "goal:foreign-team", steps: [{
    stepId: "step:foreign", agentId: outsiderId, title: "Run foreign step.", successCriterion: "Foreign step passes.", dependsOn: []
  }] }), /group does not match/i);

  const teamSteps = [{ stepId: "step:teammate", agentId: teammateId, title: "Run teammate step.",
    successCriterion: "Teammate step passes.", dependsOn: [] }];
  await assignGoal({ ...base, goalId: "goal:member-leaves", steps: teamSteps, now: "2032-01-01T00:00:01.000Z" });
  const personas = await loadPersonaRuntime(root);
  const binding = personas.policy.bindings.find((item) => item.id === "persona-binding:solveig");
  await applyPersonaRoster({ root, bindings: [{ ...binding, active: false }],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:02.000Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:03.000Z" });
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "blocked");
  assert.equal(loaded.policy.goals[0].plan.steps[0].status, "blocked");
  assert.equal(loaded.runtime.queue.filter((item) => ["pending", "leased"].includes(item.status)).length, 0);
  assert.equal((await claimGatewayWork({ root, workerId: "worker:departed", now: "2032-01-01T00:00:04.000Z" })).item, null);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
});

test("shared plan resources serialize conflicting agents by immutable goal priority", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const highAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:high", subjectId: "subject:high", host: "claude",
    profileId: "profile:high", displayName: "High Agent", now: "2032-01-01T00:00:00.600Z"
  });
  const independentAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:independent", subjectId: "subject:independent", host: "codex",
    profileId: "profile:independent", displayName: "Independent Agent", now: "2032-01-01T00:00:00.700Z"
  });
  const foreignAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:foreign-resource", subjectId: "subject:foreign-resource", host: "claude",
    profileId: "profile:foreign-resource", displayName: "Foreign Agent", groupId: "group:beta",
    tenantId: "tenant:beta", now: "2032-01-01T00:00:00.800Z"
  });
  const assignResourceGoal = ({ goalId, lead, groupId = "group:alpha", priority, resource, now }) => assignGoal({
    root, goalId, agentId: lead, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId, priority,
    successCriterion: `Synthetic resource goal ${goalId} passes.`,
    steps: [{ stepId: `step:${goalId.split(":").at(-1)}`, agentId: lead, resources: [resource],
      title: `Run ${goalId}.`, successCriterion: `The ${resource} fixture reports success.`, dependsOn: [] }],
    confirmation: "local-owner-confirmed", now
  });

  await assignResourceGoal({ goalId: "goal:resource-low", lead: agentId, priority: 20,
    resource: "resource:synthetic-ledger", now: "2032-01-01T00:00:01.000Z" });
  await assignResourceGoal({ goalId: "goal:resource-high", lead: highAgentId, priority: 90,
    resource: "resource:synthetic-ledger", now: "2032-01-01T00:00:01.100Z" });

  // Runtime priority is not trusted: invert it and prove policy priority still wins.
  let loaded = await loadGatewayRuntime(root);
  loaded.runtime.queue.find((item) => item.goalId === "goal:resource-low").priority = 100;
  loaded.runtime.queue.find((item) => item.goalId === "goal:resource-high").priority = 0;
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  const raced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:resource:${index}`, leaseSeconds: 15, now: "2032-01-01T00:00:02.000Z"
  })));
  assert.equal(raced.filter((claim) => claim.item).length, 1);
  const firstHigh = raced.find((claim) => claim.item);
  assert.equal(firstHigh.item.goalId, "goal:resource-high");
  const waiting = await gatewayContext({ root, agentId });
  assert.deepEqual(waiting.resourceWaits.map((item) => item.resources), [["resource:synthetic-ledger"]]);
  assert.deepEqual(waiting.resourceWaits[0].blockedByQueueIds, [firstHigh.item.queueId]);

  // Simulate a worker crash. Expiry releases the resource without duplicating either wake.
  await reconcileGateway({ root, now: "2032-01-01T00:00:17.000Z" });
  const reraced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:resource:retry:${index}`, leaseSeconds: 15, now: "2032-01-01T00:00:18.000Z"
  })));
  assert.equal(reraced.filter((claim) => claim.item).length, 1);
  const high = reraced.find((claim) => claim.item);
  assert.equal(high.item.goalId, "goal:resource-high");

  await assignResourceGoal({ goalId: "goal:resource-independent", lead: independentAgentId, priority: 50,
    resource: "resource:synthetic-cache", now: "2032-01-01T00:00:19.000Z" });
  await assignResourceGoal({ goalId: "goal:resource-foreign", lead: foreignAgentId, groupId: "group:beta", priority: 80,
    resource: "resource:synthetic-ledger", now: "2032-01-01T00:00:20.000Z" });
  assert.deepEqual((await gatewayContext({ root, agentId: foreignAgentId })).resourceWaits, []);

  const foreign = await claimGatewayWork({ root, workerId: "worker:resource:foreign", now: "2032-01-01T00:00:21.000Z" });
  assert.equal(foreign.item.goalId, "goal:resource-foreign");
  const independent = await claimGatewayWork({ root, workerId: "worker:resource:independent", now: "2032-01-01T00:00:22.000Z" });
  assert.equal(independent.item.goalId, "goal:resource-independent");
  await completeGatewayRun({ root, queueId: high.item.queueId, workerId: high.item.lease.workerId,
    result: { checkpoint: { high: true }, completed: true }, now: "2032-01-01T00:00:23.000Z" });
  const low = await claimGatewayWork({ root, workerId: "worker:resource:low", now: "2032-01-01T00:00:24.000Z" });
  assert.equal(low.item.goalId, "goal:resource-low");

  for (const claim of [foreign, independent, low]) {
    await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
      result: { checkpoint: { completed: claim.item.goalId }, completed: true }, now: "2032-01-01T00:00:25.000Z" });
  }
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals.filter((goal) => goal.status === "completed").length, 4);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  loaded.policy.goals.find((goal) => goal.goalId === "goal:resource-low").plan.steps[0].resources = ["resource:tampered"];
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy is invalid/i);
});

test("plan steps choose the safest sufficient strategy and require an objective post-action gate", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const steps = [{
    stepId: "step:bounded-inspection", title: "Inspect the bounded synthetic fixture.",
    successCriterion: "The objective fixture score reaches the precommitted threshold.", dependsOn: [],
    execution: {
      requiredCapabilities: ["capability:inspect"],
      strategies: [
        { strategyId: "strategy:write-and-inspect", capabilities: ["capability:inspect", "capability:write"], risk: 40, cost: 10 },
        { strategyId: "strategy:read-only", capabilities: ["capability:inspect"], risk: 5, cost: 20 }
      ],
      verification: { evaluatorId: "evaluator:synthetic-fixture", metric: "metric:quality", operator: "gte",
        threshold: 0.9, minCases: 12 }
    }
  }];
  await assignGoal({
    root, goalId: "goal:execution-reflection", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The safest sufficient strategy passes objective verification.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });

  let seenDecision;
  const unsupportedSelfReport = await runWorkerTick({ root, workerId: "worker:reflection:missing",
    now: "2032-01-01T00:00:02.000Z", hostRunner: async (item) => {
      seenDecision = item.goalStep.execution;
      return { checkpoint: { inspected: true }, completed: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(seenDecision.selectedStrategyId, "strategy:read-only");
  assert.equal(unsupportedSelfReport.status, "blocked");
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].plan.steps[0].executionOutcomes.length, 0);
  assert.equal(loaded.runtime.receipts.some((receipt) => receipt.kind === "execution-proof-invalid"), true);

  await assignGoal({ root, goalId: "goal:execution-reflection", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The safest sufficient strategy passes objective verification.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:03.000Z" });
  const failedGate = await runWorkerTick({ root, workerId: "worker:reflection:defect",
    now: "2032-01-01T00:00:04.000Z", hostRunner: async () => ({ checkpoint: { inspected: true }, completed: true,
      execution: { strategyId: "strategy:read-only", capabilitiesUsed: ["capability:inspect"], outcome: {
        evaluatorId: "evaluator:synthetic-fixture", metric: "metric:quality", value: 0.98, cases: 12,
        blockingDefect: true, sourceDigest: "a".repeat(64), observedAt: "2032-01-01T00:00:03.900Z"
      } }
    }), adapter: { send: async () => ({ ok: true }) } });
  assert.equal(failedGate.status, "blocked");
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].plan.steps[0].executionOutcomes[0].passed, false);

  await assignGoal({ root, goalId: "goal:execution-reflection", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The safest sufficient strategy passes objective verification.", steps,
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:05.000Z" });
  // Lose the resumed wake and prove restart reconciliation recreates exactly one.
  loaded = await loadGatewayRuntime(root);
  const lostQueueIds = new Set(loaded.runtime.queue.filter((item) => item.status === "pending").map((item) => item.queueId));
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => !lostQueueIds.has(item.queueId));
  loaded.runtime.receipts = loaded.runtime.receipts.filter((receipt) => !lostQueueIds.has(receipt.objectId));
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:05.500Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:05.750Z" });
  const raced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:reflection:pass:${index}`, now: "2032-01-01T00:00:06.000Z"
  })));
  assert.equal(raced.filter((claim) => claim.item).length, 1);
  const claim = raced.find((entry) => entry.item);
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, now: "2032-01-01T00:00:07.000Z",
    result: { checkpoint: { verified: true }, completed: true,
      execution: { strategyId: "strategy:read-only", capabilitiesUsed: ["capability:inspect"], outcome: {
        evaluatorId: "evaluator:synthetic-fixture", metric: "metric:quality", value: 0.93, cases: 12,
        blockingDefect: false, sourceDigest: "b".repeat(64), observedAt: "2032-01-01T00:00:06.900Z"
      } }
    }
  });
  assert.equal(completed.executionReview.passed, true);
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps[0].executionOutcomes.map((outcome) => outcome.passed), [false, true]);
  const foreignExplorationContext = await gatewayContext({ root, agentId: "agent:foreign" });
  assert.deepEqual(foreignExplorationContext.goals, []);
  assert.deepEqual(foreignExplorationContext.executionAttempts, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  loaded.policy.goals[0].plan.steps[0].execution.strategies[1].risk = 99;
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy is invalid/i);
});

test("a bounded reflection explores one equally safe alternative and stops on defects or budget exhaustion", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const verification = { evaluatorId: "evaluator:synthetic-exploration", metric: "metric:quality",
    operator: "gte", threshold: 0.9, minCases: 10 };
  const execution = {
    requiredCapabilities: ["capability:inspect"],
    strategies: [
      { strategyId: "strategy:cheap-first", capabilities: ["capability:inspect"], risk: 5, cost: 10 },
      { strategyId: "strategy:safe-alternative", capabilities: ["capability:inspect"], risk: 5, cost: 20 },
      { strategyId: "strategy:third-safe", capabilities: ["capability:inspect"], risk: 5, cost: 30 },
      { strategyId: "strategy:risky-shortcut", capabilities: ["capability:inspect"], risk: 40, cost: 1 }
    ],
    verification,
    exploration: { maxAttempts: 2 }
  };
  const assign = (goalId, now) => assignGoal({
    root, goalId, agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: `Bounded exploration for ${goalId} passes.`, confirmation: "local-owner-confirmed", now,
    steps: [{ stepId: `step:${goalId.split(":").at(-1)}`, title: `Explore ${goalId}.`,
      successCriterion: "The objective exploration evaluator passes.", dependsOn: [], execution }]
  });

  const assignments = await Promise.all(Array.from({ length: 6 }, () =>
    assign("goal:bounded-exploration", "2032-01-01T00:00:01.000Z")));
  assert.equal(assignments.filter((item) => item.duplicate !== true).length, 1);
  const attempts = [];
  const first = await runWorkerTick({
    root, workerId: "worker:exploration:first", now: "2032-01-01T00:00:02.000Z",
    hostRunner: async (item) => {
      attempts.push(item.goalStep.executionAttempt);
      return { completed: true, execution: {
        strategyId: item.goalStep.executionAttempt.strategyId,
        capabilitiesUsed: ["capability:inspect"], outcome: {
          ...verification, value: 0.4, cases: 10, blockingDefect: false,
          sourceDigest: "a".repeat(64), observedAt: "2032-01-01T00:00:01.900Z"
        }
      } };
    },
    adapter: { send: async () => ({ ok: true }) }
  });
  assert.equal(first.status, "exploring");
  assert.deepEqual(attempts[0], {
    schema: "agentspine.execution-attempt/v1",
    attempt: 1, maxAttempts: 2, strategyId: "strategy:cheap-first",
    previousOutcomeDigest: null, decisionDigest: attempts[0].decisionDigest,
    authority: "context-only-attempt"
  });
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "active");
  assert.equal(loaded.policy.goals[0].plan.steps[0].executionOutcomes.length, 1);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 1);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "execution-exploration-continued").length, 1);
  assert.equal((await gatewayContext({ root, agentId })).executionAttempts[0].strategyId,
    "strategy:safe-alternative");

  // Lose the automatically scheduled alternative and prove restart reconciliation restores it once.
  const lost = loaded.runtime.queue.find((item) => item.status === "pending");
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => item.queueId !== lost.queueId);
  loaded.runtime.receipts = loaded.runtime.receipts.filter((item) => item.objectId !== lost.queueId);
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.250Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.500Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 1);

  const second = await runWorkerTick({
    root, workerId: "worker:exploration:second", now: "2032-01-01T00:00:03.000Z",
    hostRunner: async (item) => {
      attempts.push(item.goalStep.executionAttempt);
      return { completed: true, execution: {
        strategyId: item.goalStep.executionAttempt.strategyId,
        capabilitiesUsed: ["capability:inspect"], outcome: {
          ...verification, value: 0.94, cases: 10, blockingDefect: false,
          sourceDigest: "b".repeat(64), observedAt: "2032-01-01T00:00:02.900Z"
        }
      } };
    },
    adapter: { send: async () => ({ ok: true }) }
  });
  assert.equal(second.status, "completed");
  assert.equal(attempts[1].attempt, 2);
  assert.equal(attempts[1].strategyId, "strategy:safe-alternative");
  assert.equal(attempts[1].previousOutcomeDigest,
    (await loadGatewayRuntime(root)).policy.goals[0].plan.steps[0].executionOutcomes[0].digest);
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(loaded.policy.goals[0].plan.steps[0].executionOutcomes.map((item) => item.passed), [false, true]);

  // A blocking defect cannot be averaged away and never opens the alternative attempt.
  await assign("goal:blocking-exploration", "2032-01-01T00:00:04.000Z");
  const defect = await runWorkerTick({
    root, workerId: "worker:exploration:defect", now: "2032-01-01T00:00:05.000Z",
    hostRunner: async (item) => ({ completed: true, execution: {
      strategyId: item.goalStep.executionAttempt.strategyId,
      capabilitiesUsed: ["capability:inspect"], outcome: {
        ...verification, value: 0.99, cases: 10, blockingDefect: true,
        sourceDigest: "c".repeat(64), observedAt: "2032-01-01T00:00:04.900Z"
      }
    } }), adapter: { send: async () => ({ ok: true }) }
  });
  assert.equal(defect.status, "blocked");
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals.find((goal) => goal.goalId === "goal:blocking-exploration").status, "blocked");
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 0);
  await assert.rejects(assign("goal:blocking-exploration", "2032-01-01T00:00:06.000Z"),
    /exploration.*exhausted|blocking defect/i);

  // Two ordinary failures consume the frozen budget; a third safe or riskier option is never attempted.
  await assign("goal:budget-exploration", "2032-01-01T00:00:07.000Z");
  const budgetAttempts = [];
  for (const [index, sourceDigest] of ["d".repeat(64), "e".repeat(64)].entries()) {
    const result = await runWorkerTick({
      root, workerId: `worker:exploration:budget:${index}`,
      now: `2032-01-01T00:00:0${8 + index}.000Z`,
      hostRunner: async (item) => {
        budgetAttempts.push(item.goalStep.executionAttempt.strategyId);
        return { completed: true, execution: {
          strategyId: item.goalStep.executionAttempt.strategyId,
          capabilitiesUsed: ["capability:inspect"], outcome: {
            ...verification, value: 0.5 + index / 10, cases: 10, blockingDefect: false,
            sourceDigest, observedAt: `2032-01-01T00:00:0${7 + index}.900Z`
          }
        } };
      }, adapter: { send: async () => ({ ok: true }) }
    });
    assert.equal(result.status, index === 0 ? "exploring" : "blocked");
  }
  loaded = await loadGatewayRuntime(root);
  const exhausted = loaded.policy.goals.find((goal) => goal.goalId === "goal:budget-exploration");
  assert.equal(exhausted.status, "blocked");
  assert.deepEqual(budgetAttempts, ["strategy:cheap-first", "strategy:safe-alternative"]);
  assert.equal(exhausted.plan.steps[0].executionOutcomes.length, 2);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 0);
  await assert.rejects(assign("goal:budget-exploration", "2032-01-01T00:00:10.000Z"),
    /exploration.*exhausted/i);

  const foreignBoundedContext = await gatewayContext({ root, agentId: "agent:foreign" });
  assert.deepEqual(foreignBoundedContext.goals, []);
  assert.deepEqual(foreignBoundedContext.executionAttempts, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  // Recomputing local digests cannot expand the immutable exploration order into a riskier strategy.
  const completedGoal = loaded.policy.goals.find((goal) => goal.goalId === "goal:bounded-exploration");
  const decision = completedGoal.plan.steps[0].execution;
  decision.explorationOrder[1] = "strategy:risky-shortcut";
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  decision.decisionDigest = digest({ requiredCapabilities: decision.requiredCapabilities,
    strategies: decision.strategies, verification: decision.verification,
    selectedStrategyId: decision.selectedStrategyId,
    explorationMaxAttempts: decision.explorationMaxAttempts, explorationOrder: decision.explorationOrder,
    authority: "context-only-decision" });
  completedGoal.plan.definitionsDigest = digest(completedGoal.plan.steps.map(({ stepId, agentId: assignedAgent,
    resources, execution: exactExecution, title, successCriterion, dependsOn }) => ({
    stepId, agentId: assignedAgent, resources, execution: exactExecution, title, successCriterion, dependsOn
  })));
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy is invalid/i);
});

test("objective strategy evidence transfers to a matching task and rolls back after one regression", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const targetAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-target", subjectId: "subject:transfer-target", host: "claude",
    profileId: "profile:transfer-target", displayName: "Transfer Target", now: "2032-01-01T00:00:00.600Z"
  });
  const fallbackAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-fallback", subjectId: "subject:transfer-fallback", host: "codex",
    profileId: "profile:transfer-fallback", displayName: "Transfer Fallback", now: "2032-01-01T00:00:00.700Z"
  });
  const staleAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-stale", subjectId: "subject:transfer-stale", host: "claude",
    profileId: "profile:transfer-stale", displayName: "Transfer Stale", now: "2032-01-01T00:00:00.800Z"
  });
  const foreignAgentId = await addSyntheticPersona(root, {
    bindingId: "persona-binding:transfer-foreign", subjectId: "subject:transfer-foreign", host: "codex",
    profileId: "profile:transfer-foreign", displayName: "Transfer Foreign", groupId: "group:beta",
    tenantId: "tenant:beta", now: "2032-01-01T00:00:00.900Z"
  });
  const verification = { evaluatorId: "evaluator:synthetic-transfer", metric: "metric:quality",
    operator: "gte", threshold: 0.9, minCases: 10 };
  const transferred = { strategyId: "strategy:proven-inspection", capabilities: ["capability:inspect"], risk: 5, cost: 20 };
  const sourceExecution = {
    requiredCapabilities: ["capability:inspect"],
    strategies: [transferred, { strategyId: "strategy:broad-write", capabilities: ["capability:inspect", "capability:write"], risk: 40, cost: 5 }],
    verification, transfer: { transferKey: "transfer:synthetic-inspection", maxAgeDays: 30 }
  };
  const targetExecution = {
    requiredCapabilities: ["capability:inspect"],
    strategies: [{ strategyId: "strategy:cheap-unproven", capabilities: ["capability:inspect"], risk: 5, cost: 10 }, transferred],
    verification, transfer: { transferKey: "transfer:synthetic-inspection", maxAgeDays: 30 }
  };
  const assign = ({ goalId, lead, execution, groupId = "group:alpha", now }) => assignGoal({
    root, goalId, agentId: lead, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId,
    successCriterion: `Objective transfer fixture ${goalId} passes.`, confirmation: "local-owner-confirmed", now,
    steps: [{ stepId: `step:${goalId.split(":").at(-1)}`, title: `Run ${goalId}.`,
      successCriterion: "The independent transfer evaluator passes.", dependsOn: [], execution }]
  });
  const finishSource = async (goalId, now, digest) => {
    await assign({ goalId, lead: agentId, execution: sourceExecution, now });
    const claim = await claimGatewayWork({ root, workerId: `worker:${goalId}`, now: new Date(new Date(now).getTime() + 1000) });
    assert.equal(claim.item.goalId, goalId);
    const completedAt = new Date(new Date(now).getTime() + 2000).toISOString();
    await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId, now: completedAt,
      result: { checkpoint: { verified: goalId }, completed: true, execution: {
        strategyId: transferred.strategyId, capabilitiesUsed: ["capability:inspect"], outcome: {
          ...verification, value: 0.94, cases: 10, blockingDefect: false,
          sourceDigest: digest, observedAt: new Date(new Date(now).getTime() + 1500).toISOString()
        }
      } }
    });
  };

  await finishSource("goal:transfer-source-one", "2032-01-01T00:00:01.000Z", "a".repeat(64));
  await assign({ goalId: "goal:transfer-before-evidence", lead: agentId, execution: targetExecution,
    now: "2032-01-01T00:00:03.250Z" });
  let control = await loadGatewayRuntime(root);
  const beforeEvidence = control.policy.goals.find((goal) => goal.goalId === "goal:transfer-before-evidence");
  assert.equal(beforeEvidence.plan.steps[0].execution.selectedStrategyId, "strategy:cheap-unproven");
  assert.equal(beforeEvidence.plan.steps[0].execution.transferProof, null);
  const controlClaim = await claimGatewayWork({ root, workerId: "worker:transfer:before",
    now: "2032-01-01T00:00:03.500Z" });
  await completeGatewayRun({ root, queueId: controlClaim.item.queueId, workerId: controlClaim.item.lease.workerId,
    now: "2032-01-01T00:00:03.750Z", result: { completed: true, execution: {
      strategyId: "strategy:cheap-unproven", capabilitiesUsed: ["capability:inspect"], outcome: {
        ...verification, value: 0.92, cases: 10, blockingDefect: false,
        sourceDigest: "d".repeat(64), observedAt: "2032-01-01T00:00:03.700Z"
      }
    } }
  });
  await finishSource("goal:transfer-source-two", "2032-01-01T00:00:04.000Z", "b".repeat(64));

  const assignments = await Promise.all(Array.from({ length: 6 }, () => assign({
    goalId: "goal:transfer-target", lead: targetAgentId, execution: targetExecution,
    now: "2032-01-02T00:00:00.000Z"
  })));
  assert.equal(assignments.filter((item) => item.duplicate !== true).length, 1);
  let loaded = await loadGatewayRuntime(root);
  const target = loaded.policy.goals.find((goal) => goal.goalId === "goal:transfer-target");
  assert.equal(target.plan.steps[0].execution.selectedStrategyId, transferred.strategyId);
  assert.equal(target.plan.steps[0].execution.transferProof.evidence.length, 2);
  assert.equal(loaded.runtime.queue.filter((item) => item.goalId === target.goalId && item.status === "pending").length, 1);

  // Lose the transfer wake, recover once, then prove six workers still obtain one exact lease.
  const lost = loaded.runtime.queue.find((item) => item.goalId === target.goalId && item.status === "pending");
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => item.queueId !== lost.queueId);
  loaded.runtime.receipts = loaded.runtime.receipts.filter((item) => item.objectId !== lost.queueId);
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-01-02T00:00:00.250Z" });
  await reconcileGateway({ root, now: "2032-01-02T00:00:00.500Z" });
  const raced = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:transfer:${index}`, now: "2032-01-02T00:00:01.000Z"
  })));
  assert.equal(raced.filter((entry) => entry.item).length, 1);
  const claim = raced.find((entry) => entry.item);
  assert.equal(claim.item.goalId, target.goalId);

  // The same evidence is too old after its frozen 30-day window and never crosses a group boundary.
  await assign({ goalId: "goal:transfer-stale", lead: staleAgentId, execution: targetExecution,
    now: "2032-02-05T00:00:00.000Z" });
  await assign({ goalId: "goal:transfer-foreign", lead: foreignAgentId, execution: targetExecution,
    groupId: "group:beta", now: "2032-01-02T00:00:01.250Z" });
  loaded = await loadGatewayRuntime(root);
  for (const goalId of ["goal:transfer-stale", "goal:transfer-foreign"]) {
    const execution = loaded.policy.goals.find((goal) => goal.goalId === goalId).plan.steps[0].execution;
    assert.equal(execution.selectedStrategyId, "strategy:cheap-unproven");
    assert.equal(execution.transferProof, null);
  }

  // One blocking defect overrides both earlier successes and removes transfer from every future matching task.
  await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: claim.item.lease.workerId,
    now: "2032-01-02T00:00:02.000Z", result: { checkpoint: { inspected: true }, completed: true, execution: {
      strategyId: transferred.strategyId, capabilitiesUsed: ["capability:inspect"], outcome: {
        ...verification, value: 0.99, cases: 10, blockingDefect: true,
        sourceDigest: "c".repeat(64), observedAt: "2032-01-02T00:00:01.900Z"
      }
    } }
  });
  await assign({ goalId: "goal:transfer-after-regression", lead: fallbackAgentId, execution: targetExecution,
    now: "2032-01-03T00:00:00.000Z" });
  loaded = await loadGatewayRuntime(root);
  const afterRegression = loaded.policy.goals.find((goal) => goal.goalId === "goal:transfer-after-regression");
  assert.equal(afterRegression.plan.steps[0].execution.selectedStrategyId, "strategy:cheap-unproven");
  assert.equal(afterRegression.plan.steps[0].execution.transferProof, null);
  assert.deepEqual((await gatewayContext({ root, agentId: "agent:foreign" })).goals, []);
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);

  // Recomputing every local digest cannot turn a fabricated source into valid transfer evidence.
  const targetForTamper = loaded.policy.goals.find((goal) => goal.goalId === "goal:transfer-target");
  const proof = targetForTamper.plan.steps[0].execution.transferProof;
  proof.evidence[0].sourceDigest = "f".repeat(64);
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  proof.proofDigest = digest({ transferKey: proof.transferKey, strategyId: proof.strategyId,
    maxAgeDays: proof.maxAgeDays, evidence: proof.evidence, authority: "context-only-transfer" });
  proof.proofId = "strategy-transfer:" + proof.proofDigest.slice(0, 32);
  const execution = targetForTamper.plan.steps[0].execution;
  execution.decisionDigest = digest({ requiredCapabilities: execution.requiredCapabilities,
    strategies: execution.strategies, verification: execution.verification,
    selectedStrategyId: execution.selectedStrategyId, transferKey: execution.transferKey,
    transferMaxAgeDays: execution.transferMaxAgeDays, transferProof: execution.transferProof,
    authority: "context-only-decision" });
  targetForTamper.plan.definitionsDigest = digest(targetForTamper.plan.steps.map(({ stepId, agentId, resources, execution: decision,
    title, successCriterion, dependsOn }) => ({ stepId, agentId, resources, execution: decision,
    title, successCriterion, dependsOn })));
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy is invalid/i);
});

test("pre-team goal plans retain their lead-agent routing after upgrade", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:legacy-plan", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "The legacy synthetic gate passes.",
    steps: [{ stepId: "step:legacy", title: "Run legacy step.", successCriterion: "Legacy step passes.", dependsOn: [] }],
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z"
  });
  const loaded = await loadGatewayRuntime(root);
  for (const step of loaded.policy.goals[0].plan.steps) {
    delete step.resources; delete step.execution; delete step.executionOutcomes;
  }
  let definitions = loaded.policy.goals[0].plan.steps.map(({ stepId, agentId, title, successCriterion, dependsOn }) => ({
    stepId, agentId, title, successCriterion, dependsOn
  }));
  loaded.policy.goals[0].plan.definitionsDigest = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  assert.deepEqual(gatewayRuntimeFindings((await loadGatewayRuntime(root)).policy, loaded.runtime), []);

  for (const step of loaded.policy.goals[0].plan.steps) delete step.agentId;
  definitions = loaded.policy.goals[0].plan.steps.map(({ stepId, title, successCriterion, dependsOn }) => ({
    stepId, title, successCriterion, dependsOn
  }));
  loaded.policy.goals[0].plan.definitionsDigest = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  const upgraded = await loadGatewayRuntime(root);
  assert.deepEqual(gatewayRuntimeFindings(upgraded.policy, upgraded.runtime), []);
  const claim = await claimGatewayWork({ root, workerId: "worker:legacy", now: "2032-01-01T00:00:02.000Z" });
  assert.equal(claim.item.agentId, agentId);
  assert.equal(claim.item.goalStepId, "step:legacy");
});

test("goal plans reject dependency cycles, definition drift, and stale-step completion", async (t) => {
  const { root, agentId } = await fixture(t);
  const base = {
    root, agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "Synthetic plan remains bound.", confirmation: "local-owner-confirmed"
  };
  await assert.rejects(assignGoal({ ...base, goalId: "goal:cycle", steps: [
    { stepId: "step:a", title: "Step A.", successCriterion: "A passes.", dependsOn: ["step:b"] },
    { stepId: "step:b", title: "Step B.", successCriterion: "B passes.", dependsOn: ["step:a"] }
  ] }), /acyclic dependency graph/i);

  await assignGoal({ ...base, goalId: "goal:bound", steps: [
    { stepId: "step:first", title: "First bounded step.", successCriterion: "First passes.", dependsOn: [] },
    { stepId: "step:second", title: "Second bounded step.", successCriterion: "Second passes.", dependsOn: ["step:first"] }
  ], now: "2032-01-01T00:00:01.000Z" });
  const claim = await claimGatewayWork({ root, workerId: "worker:stale", now: "2032-01-01T00:00:02.000Z" });
  const loaded = await loadGatewayRuntime(root);
  const originalPolicy = structuredClone(loaded.policy);
  const goal = loaded.policy.goals[0];
  goal.plan.steps[0].status = "completed"; goal.plan.steps[0].completedAt = "2032-01-01T00:00:02.500Z";
  goal.plan.steps[0].completedByQueueId = claim.item.queueId;
  goal.plan.steps[1].status = "active"; goal.plan.steps[1].updatedAt = "2032-01-01T00:00:02.500Z";
  goal.plan.currentStepId = "step:second"; goal.nextSafeStep = goal.plan.steps[1].title; goal.updatedAt = "2032-01-01T00:00:02.500Z";
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(completeGatewayRun({ root, queueId: claim.item.queueId, workerId: "worker:stale",
    result: { completed: true }, now: "2032-01-01T00:00:03.000Z" }), /not bound to the current active goal step/i);

  originalPolicy.goals[0].plan.steps[0].title = "Drifted definition.";
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(originalPolicy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy is invalid/i);
});

test("an objective knowledge gap pauses one plan step, asks once, and resumes with bound owner context", async (t) => {
  const { root, agentId, before } = await fixture(t);
  const steps = [{
    stepId: "step:regional-check", title: "Run the bounded regional check.",
    successCriterion: "The selected synthetic region passes the independent check.", dependsOn: []
  }];
  const assignment = {
    root, goalId: "goal:knowledge-gap", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "The regional check uses explicitly resolved context.", steps,
    confirmation: "local-owner-confirmed"
  };
  await assignGoal({ ...assignment, now: "2032-01-01T00:00:01.000Z" });
  const paused = await runWorkerTick({ root, workerId: "worker:gap", now: "2032-01-01T00:00:02.000Z",
    hostRunner: async () => ({
      checkpoint: { inspected: true },
      knowledgeGap: {
        question: "Which synthetic region should the bounded check use?",
        reason: "The success criterion requires a region, but the plan and checkpoint contain none.",
        requiredEvidence: "owner-input"
      }
    }), adapter: { send: async () => ({ ok: true }) } });
  assert.equal(paused.status, "needs-clarification");
  assert.equal(paused.clarification.status, "open");
  assert.equal(paused.clarification.answer, null);

  await reconcileGateway({ root, now: "2032-01-01T00:00:02.250Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:02.500Z" });
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "blocked");
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 0);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "knowledge-gap-opened").length, 1);
  await assert.rejects(assignGoal({ ...assignment, now: "2032-01-01T00:00:02.750Z" }), /open knowledge gap/i);

  const resolutions = await Promise.all(Array.from({ length: 6 }, () => resolveGoalKnowledgeGap({
    root, goalId: "goal:knowledge-gap", gapId: paused.clarification.gapId,
    answer: "Use synthetic-region-west.", answerSource: "owner-input",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:03.000Z"
  })));
  assert.equal(resolutions.filter((item) => item.duplicate === false).length, 1);
  assert.equal(resolutions.filter((item) => item.duplicate === true).length, 5);
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending" && item.goalStepId === "step:regional-check").length, 1);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "knowledge-gap-resolved").length, 1);

  let observedGap = null;
  const resumed = await runWorkerTick({ root, workerId: "worker:gap-resumed", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async (item) => {
      observedGap = item.goalStep.knowledgeGaps[0];
      return { checkpoint: { regionChecked: true }, completed: true };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(resumed.status, "completed");
  assert.equal(observedGap.answer, "Use synthetic-region-west.");
  assert.equal(observedGap.authority, "context-only");
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.deepEqual((await gatewayContext({ root, agentId: "agent:foreign" })).goals, []);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);
});

test("objective questions require repository-first self-help and reject state tampering or repetition", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:observed-gap", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha",
    successCriterion: "A synthetic observation selects the bounded input.",
    steps: [{ stepId: "step:observe-input", title: "Select the observed input.",
      successCriterion: "The input is bound to an objective observation.", dependsOn: [] }],
    confirmation: "local-owner-confirmed"
  });
  const claim = await claimGatewayWork({ root, workerId: "worker:observed-gap" });
  const deferred = await completeGatewayRun({ root, queueId: claim.item.queueId, workerId: "worker:observed-gap",
    result: { knowledgeGap: {
      question: "Which synthetic fixture produced the green observation?",
      reason: "The fixture identity is absent from the current objective result.",
      requiredEvidence: "objective-observation"
    } } });
  assert.equal(deferred.clarification, null);
  assert.equal(deferred.selfHelpRequired.requirement.authority, "context-only-research");

  const loaded = await loadGatewayRuntime(root);
  const original = structuredClone(loaded.policy);
  loaded.policy.goals[0].plan.steps[0].selfHelpRequirements[0].question = "Tampered question.";
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy is invalid/i);
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(original, null, 2)}\n`);

  const repeatedClaim = await claimGatewayWork({ root, workerId: "worker:repeated-gap" });
  const repeated = await completeGatewayRun({ root, queueId: repeatedClaim.item.queueId,
    workerId: "worker:repeated-gap", result: { knowledgeGap: {
      question: "Which synthetic fixture produced the green observation?",
      reason: "The fixture identity is absent from the current objective result.",
      requiredEvidence: "owner-input"
    } } });
  assert.equal(repeated.item.status, "blocked");
  const final = await loadGatewayRuntime(root);
  assert.equal(final.policy.goals[0].status, "blocked");
  assert.equal(final.policy.goals[0].plan.steps[0].knowledgeGaps.length, 0);
  assert.equal(final.runtime.receipts.filter((item) => item.kind === "self-help-requirement-regression").length, 1);
});

test("goal-assign CLI reads a bounded plan without changing its source bytes", async (t) => {
  const { root, agentId } = await fixture(t);
  const planPath = join(root, "synthetic-goal-plan.json");
  const planBytes = `${JSON.stringify({ steps: [
    { stepId: "step:cli-one", title: "Run the first CLI step.", successCriterion: "First CLI gate passes.", dependsOn: [] },
    { stepId: "step:cli-two", title: "Run the second CLI step.", successCriterion: "Second CLI gate passes.", dependsOn: ["step:cli-one"] }
  ] }, null, 2)}\n`;
  await writeFile(planPath, planBytes);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "goal-assign", "goal:cli-plan", "--root", root,
    "--agent", agentId, "--owner", "subject:owner", "--project", "project:alpha", "--group", "group:alpha",
    "--success", "Both CLI gates pass.", "--plan", planPath, "--confirm-local-goal", "--json"], {
    encoding: "utf8", env: process.env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).goal.plan.currentStepId, "step:cli-one");
  let observedStep = null;
  await runWorkerTick({ root, workerId: "worker:cli-plan", now: "2032-01-01T00:00:03.000Z",
    hostRunner: async (item) => {
      observedStep = item.goalStep;
      return { checkpoint: { cli: true }, completed: false };
    }, adapter: { send: async () => ({ ok: true }) } });
  assert.equal(observedStep.stepId, "step:cli-one");
  assert.equal(observedStep.successCriterion, "First CLI gate passes.");
  assert.equal(await readFile(planPath, "utf8"), planBytes);
});

test("startup reconciliation creates one deadline wake and health detects a silent scheduler", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({ root, goalId: "goal:deadline", agentId, ownerSubjectId: "subject:owner",
    projectId: "project:alpha", groupId: "group:alpha", successCriterion: "Deadline is handled once.",
    nextSafeStep: "Handle the bounded deadline step.", deadline: "2032-01-01T00:00:02.000Z",
    confirmation: "local-owner-confirmed", now: "2032-01-01T00:00:01.000Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:03.000Z" });
  await reconcileGateway({ root, now: "2032-01-01T00:00:03.500Z" });
  let loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.kind === "deadline").length, 1);
  assert.match(gatewayHealthFindings(loaded.policy, loaded.runtime, { now: "2032-01-01T00:00:03.500Z" }).join(","), /worker-not-healthy/);
  await runWorkerTick({ root, workerId: "worker:health", now: "2032-01-01T00:00:04.000Z",
    hostRunner: async () => ({ checkpoint: { deadline: true }, completed: true }), adapter: { send: async () => ({ ok: true }) } });
  loaded = await loadGatewayRuntime(root);
  assert.deepEqual(gatewayHealthFindings(loaded.policy, loaded.runtime, { now: "2032-01-01T00:00:04.000Z" }), []);
  assert.match(gatewayHealthFindings(loaded.policy, loaded.runtime, { now: "2032-01-01T00:04:00.001Z" }).join(","), /heartbeat-stale/);
});

test("worker wait wakes on relevant desired-state changes and ignores its own runtime file", async (t) => {
  const { root } = await fixture(t);
  const { directory } = await loadGatewayRuntime(root);
  const eventWake = waitForGatewayWake(root, 1000, {
    onReady: () => writeFile(join(directory, "attention.json"), "{}\n")
  });
  assert.equal(await eventWake, "event");
  const timerWake = waitForGatewayWake(root, 25, { watchFactory: (_path, _options, listener) => {
    setTimeout(() => listener("change", "gateway-runtime.json"), 10);
    return { close() {}, on() {} };
  } });
  assert.equal(await timerWake, "timer");
});

test("worker passes a canonical Windows directory to the native file watcher", { skip: process.platform !== "win32" }, async (t) => {
  const { root } = await fixture(t);
  process.env.AGENTSPINE_STATE_DIR = process.env.AGENTSPINE_STATE_DIR.toUpperCase();
  const { directory } = await loadGatewayRuntime(root);
  let watchedPath = null;
  const wake = waitForGatewayWake(root, 250, { watchFactory: (path) => {
    watchedPath = path;
    return { close() {}, on() {} };
  } });
  assert.equal(await wake, "timer");
  assert.notEqual(directory, await realpath(directory));
  assert.equal(watchedPath, await realpath(directory));
});

test("worker wait degrades safely when the state directory cannot be canonicalized", async (t) => {
  const { root } = await fixture(t);
  assert.equal(await waitForGatewayWake(root, 250, {
    realpathFactory: async () => { throw new Error("synthetic path failure"); }
  }), "watch-unavailable");
});

test("resolved blockers and open promises enter the bounded attention wake queue", async (t) => {
  const { root, agentId } = await fixture(t);
  await createTask({
    root, id: "task:attention", actorId: agentId, assigneeId: agentId,
    projectId: "project:alpha", title: "Synthetic attention task", privacy: "private"
  });
  await recordAttentionEvent({
    root, id: "event:blocker:alpha", kind: "blocker", summary: "Synthetic dependency.", status: "open",
    entityId: agentId, projectId: "project:alpha", taskId: "task:attention", privacy: "private",
    receiptId: "receipt:blocker:open", host: "codex", hookEvent: "PostToolUse",
    observedAt: "2032-01-01T00:00:01.000Z"
  });
  await recordAttentionEvent({
    root, id: "event:blocker:alpha", kind: "blocker", summary: "Synthetic dependency.", status: "resolved",
    entityId: agentId, projectId: "project:alpha", taskId: "task:attention", privacy: "private",
    receiptId: "receipt:blocker:resolved", host: "codex", hookEvent: "PostToolUse",
    observedAt: "2032-01-01T00:00:02.000Z"
  });
  await reconcileGateway({ root, now: "2032-01-01T00:00:03.000Z" });
  const { runtime } = await loadGatewayRuntime(root);
  const wake = runtime.queue.find((item) => item.kind === "resolved-blocker");
  assert.equal(wake.agentId, agentId);
  assert.equal(wake.projectId, "project:alpha");
});

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

test("gateway receipts and checkpoints reject tampering, secrets, and authority claims", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:secure", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Synthetic security gate passes.",
    nextSafeStep: "Run one bounded step.", confirmation: "local-owner-confirmed"
  });
  const claim = await claimGatewayWork({ root, workerId: "worker:secure" });
  await assert.rejects(completeGatewayRun({
    root, queueId: claim.item.queueId, workerId: "worker:secure",
    result: { checkpoint: { token: "abcdefghijklmnopqrstuvwxyz1234567890" } }
  }), /secret- or authority-shaped/i);
  const { policy, runtime } = await loadGatewayRuntime(root);
  const forged = structuredClone(runtime);
  forged.receipts[0].digest = "0".repeat(64);
  assert.match(gatewayRuntimeFindings(policy, forged).join(","), /invalid-gateway-receipt/);
});

test("the ten-gate audit fails closed on forged gateway state", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignGoal({
    root, goalId: "goal:audit", agentId, ownerSubjectId: "subject:owner", projectId: "project:alpha",
    groupId: "group:alpha", successCriterion: "Audit remains green.", nextSafeStep: "Inspect the receipt.",
    confirmation: "local-owner-confirmed"
  });
  await runWorkerTick({ root, workerId: "worker:audit",
    hostRunner: async () => ({ checkpoint: { audit: true }, completed: false }),
    adapter: { send: async () => ({ ok: true }) } });
  assert.equal((await runAudit(root)).ok, true);
  const loaded = await loadGatewayRuntime(root);
  loaded.runtime.receipts[0].authority = "explicit-local-execution-policy";
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  const forged = await runAudit(root);
  assert.equal(forged.ok, false);
  assert.equal(forged.gates.find((gate) => gate.id === 8).ok, false);
});
