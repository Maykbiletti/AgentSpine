#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  claimGatewayWork, completeGatewayRun, deliverPrepared, executionAttemptForStep,
  failGatewayRun, loadGatewayRuntime, reconcileGateway, updateGatewayHealth
} from "./lib/gateway-runtime.js";
import { createTelegramAdapter } from "./lib/telegram-adapter.js";
import { acknowledgeChannelDelivery, loadChannelRuntime } from "./lib/channel-runtime.js";
import { loadPersonaRuntime, syncPersonaRosterFromEnvironment } from "./lib/persona-runtime.js";
import { selfHelpPolicyForWorkItem } from "./lib/knowledge-evidence.js";
import { isMainModule } from "./lib/runtime.js";

const MAX_FRAME = 64 * 1024;
const WAKE_FILES = new Set(["attention.json", "channel-runtime.json", "gateway-policy.json", "persona-policy.json", "persona-runtime.json"]);

async function wakeSnapshot(directory) {
  return Promise.all([...WAKE_FILES].sort().map(async (name) => {
    try {
      const metadata = await lstat(join(directory, name), { bigint: true });
      return `${name}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`;
    } catch (error) {
      if (error.code === "ENOENT") return `${name}:missing`;
      throw error;
    }
  })).then((entries) => entries.join("\n"));
}

export async function waitForGatewayWake(root, delayMs, { watchFactory = watch, realpathFactory = realpath, onReady = null } = {}) {
  const delay = Math.max(250, Math.min(60000, Number(delayMs) || 60000));
  const { directory } = await loadGatewayRuntime(root);
  let watchPath;
  try { watchPath = await realpathFactory(directory); } catch { return "watch-unavailable"; }
  let before;
  try { before = await wakeSnapshot(watchPath); } catch { return "watch-unavailable"; }
  return new Promise((resolvePromise) => {
    let settled = false; let watcher;
    const finish = (reason) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      watcher?.close();
      resolvePromise(reason);
    };
    const timer = setTimeout(() => finish("timer"), delay);
    try {
      watcher = watchFactory(watchPath, { persistent: true }, (_eventType, filename) => {
        const name = filename === null ? null : String(filename);
        if (name === null || WAKE_FILES.has(name)) finish("event");
      });
      watcher.on?.("error", () => finish("watch-error"));
      Promise.resolve().then(() => onReady?.(watchPath)).then(() => wakeSnapshot(watchPath)).then((after) => {
        if (after !== before) finish("event");
      }).catch(() => finish("watch-error"));
    } catch { finish("watch-unavailable"); }
  });
}

function exactRunner(env) {
  const runner = env.AGENTSPINE_HOST_RUNNER;
  if (!runner || !isAbsolute(runner)) throw new Error("AGENTSPINE_HOST_RUNNER must be an absolute locally approved executable path");
  return resolve(runner);
}

async function invokeHostRunner(item, { env = process.env, timeoutMs = 300000, spawnProcess = spawn } = {}) {
  const executable = exactRunner(env);
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(executable, [], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR",
        "AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]))
    });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(value); };
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > MAX_FRAME) child.kill(); });
    child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]).subarray(0, 2048); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (stdout.length > MAX_FRAME) return finish(new Error("host runner response exceeds 64 KiB"));
      if (code !== 0) return finish(new Error("host runner failed: " + stderr.toString("utf8").slice(0, 2048)));
      try { finish(null, JSON.parse(stdout.toString("utf8"))); } catch { finish(new Error("host runner returned invalid JSON")); }
    });
    const timer = setTimeout(() => { child.kill(); finish(new Error("host runner exceeded its bounded timeout")); }, timeoutMs);
    child.stdin.end(JSON.stringify({ schema: "agentspine.run-request/v1", item, authority: "execution-state-only" }) + "\n");
  });
}

async function hostWorkItem(root, item) {
  const [{ policy }, personas, channel] = await Promise.all([
    loadGatewayRuntime(root), loadPersonaRuntime(root), loadChannelRuntime(root)
  ]);
  const persona = personas.runtime.personas.find((entry) => entry.personaId === item.agentId && entry.status === "active");
  const identity = personas.policy.bindings.find((entry) => entry.id === persona?.bindingId && entry.active);
  if (!persona || !identity) throw new Error("claimed work lost its authenticated agent identity");
  const goal = item.goalId === null ? null : policy.goals.find((entry) => entry.goalId === item.goalId) || null;
  const goalStep = item.goalStepId === null || item.goalStepId === undefined ? null
    : goal?.plan?.steps.find((entry) => entry.stepId === item.goalStepId) || null;
  if (item.goalStepId && !goalStep) throw new Error("claimed work lost its exact goal-plan step");
  const executionAttempt = executionAttemptForStep(goalStep);
  const event = item.channelEventId === null ? null
    : channel.runtime.events.find((entry) => entry.eventId === item.channelEventId) || null;
  if (item.channelEventId && !event) throw new Error("claimed channel work lost its exact event");
  return {
    ...structuredClone(item), host: identity.host, profileId: identity.profileId, projectRoot: root,
    goal: goal ? structuredClone(goal) : null,
    goalStep: goalStep ? { ...structuredClone(goalStep),
      ...(executionAttempt === null ? {} : { executionAttempt }) } : null,
    selfHelpPolicy: goalStep ? selfHelpPolicyForWorkItem() : null,
    hostEnvironment: {
      AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1",
      AGENTSPINE_ENTITY_ID: item.agentId,
      AGENTSPINE_PROJECT_ID: item.projectId,
      ...(item.groupId === null ? {} : { AGENTSPINE_GROUP_ID: item.groupId }),
      ...(event ? {
        AGENTSPINE_CHANNEL_EVENT_ID: event.eventId,
        AGENTSPINE_CHANNEL_PROVIDER: event.provider
      } : {})
    },
    channelStart: event ? {
      agent_spine_scope: { entity_id: event.agentId, project_id: event.projectId, group_id: event.groupId },
      agent_spine_channel_event: { event_id: event.eventId, provider: event.provider },
      session_key: event.sessionKey,
      authority: "explicit-local-channel-policy"
    } : null
  };
}

export async function runWorkerTick({ root = process.cwd(), workerId = "gateway-worker:local", now = new Date(),
  hostRunner = invokeHostRunner, adapter = null, env = process.env } = {}) {
  const deliveryAdapter = adapter || createTelegramAdapter({ root, env });
  await syncPersonaRosterFromEnvironment({ root, env, now });
  const initial = await loadGatewayRuntime(root);
  if (!initial.policy.enabled || initial.policy.killSwitch) return { status: "stopped", processed: false };
  if (typeof deliveryAdapter.poll === "function") {
    try { await deliveryAdapter.poll(); }
    catch (error) {
      await updateGatewayHealth({ root, worker: "degraded", adapter: "failed", now });
      throw error;
    }
  }
  await reconcileGateway({ root, now });
  await updateGatewayHealth({ root, worker: "healthy", adapter: "healthy", now });
  const afterReconcile = await loadGatewayRuntime(root);
  const dueOutbox = afterReconcile.runtime.outbox.filter((item) => ["prepared", "failed"].includes(item.status)
    && new Date(item.nextAttemptAt) <= new Date(now)).sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt)
      || a.createdAt.localeCompare(b.createdAt) || a.outboxId.localeCompare(b.outboxId))[0] || null;
  if (dueOutbox) {
    const delivery = await deliverPrepared({ root, outboxId: dueOutbox.outboxId, adapter: deliveryAdapter, now });
    if (delivery.outbox.status === "delivered") await acknowledgeChannelDelivery({ root,
      eventId: delivery.outbox.eventId, bindingId: delivery.outbox.bindingId,
      deliveryReceiptId: delivery.receipt.id, now });
    return { status: delivery.outbox.status, processed: true, outboxId: delivery.outbox.outboxId,
      recoveredDelivery: true };
  }
  const claim = await claimGatewayWork({ root, workerId, now });
  if (!claim.item) return { status: claim.reason, processed: false };
  let result;
  try { result = await hostRunner(await hostWorkItem(root, claim.item), { env }); }
  catch (error) {
    const failed = await failGatewayRun({ root, queueId: claim.item.queueId, workerId,
      error: "Host runtime unavailable: " + String(error.message).slice(0, 400), now });
    return { status: failed.item.status, processed: true, queueId: failed.item.queueId, retryAt: failed.item.availableAt };
  }
  const completed = await completeGatewayRun({ root, queueId: claim.item.queueId, workerId, result, now });
  if (!completed.outbox) return {
    status: completed.clarification ? "needs-clarification"
      : completed.exploration ? "exploring" : completed.selfHelp ? "self-help-resolved" : completed.item.status,
    processed: true, queueId: completed.item.queueId,
    ...(completed.clarification ? { clarification: completed.clarification } : {}),
    ...(completed.exploration ? { exploration: completed.exploration } : {}),
    ...(completed.selfHelp ? { selfHelp: completed.selfHelp } : {})
  };
  const delivery = await deliverPrepared({ root, outboxId: completed.outbox.outboxId,
    adapter: deliveryAdapter, now });
  if (delivery.outbox.status === "delivered") await acknowledgeChannelDelivery({ root,
    eventId: delivery.outbox.eventId, bindingId: delivery.outbox.bindingId,
    deliveryReceiptId: delivery.receipt.id, now });
  return { status: delivery.outbox.status, processed: true, queueId: completed.item.queueId, outboxId: delivery.outbox.outboxId };
}

export async function runWorker({ root = process.cwd(), once = false, env = process.env,
  waitForWake = waitForGatewayWake } = {}) {
  const workerId = "gateway-worker:" + process.pid;
  do {
    const result = await runWorkerTick({ root, workerId, env });
    if (once) return result;
    const { policy, runtime } = await loadGatewayRuntime(root);
    if (!policy.enabled || policy.killSwitch) return { status: "stopped", processed: false };
    const pending = [
      ...runtime.queue.filter((item) => item.status === "pending").map((item) => new Date(item.availableAt).getTime()),
      ...runtime.outbox.filter((item) => ["prepared", "failed"].includes(item.status))
        .map((item) => new Date(item.nextAttemptAt).getTime())
    ];
    const delay = pending.length ? Math.max(250, Math.min(60000, Math.min(...pending) - Date.now())) : 60000;
    await waitForWake(root, delay);
  } while (true);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2); const once = args.includes("--once");
  const rootIndex = args.indexOf("--root");
  if (rootIndex >= 0 && (!args[rootIndex + 1] || args[rootIndex + 1].startsWith("--"))) throw new Error("--root requires a path");
  const root = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
  const rosterIndex = args.indexOf("--persona-roster");
  if (rosterIndex >= 0 && (!args[rosterIndex + 1] || args[rosterIndex + 1].startsWith("--"))) {
    throw new Error("--persona-roster requires a path");
  }
  const env = { ...process.env };
  if (rosterIndex >= 0) env.AGENTSPINE_PERSONA_ROSTER_FILE = args[rosterIndex + 1];
  runWorker({ root, once, env }).then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error) => { process.stderr.write("AgentSpine worker: " + String(error.message).slice(0, 2048) + "\n"); process.exitCode = 1; });
}
