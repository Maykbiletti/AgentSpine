import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
  gatewayHealthFindings, gatewayRuntimeFindings, loadGatewayRuntime, reconcileGateway, setGatewayControl
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
