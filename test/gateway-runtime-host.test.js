import test from "node:test";
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordAttentionEvent } from "../src/lib/attention.js";
import { createTask } from "../src/lib/coordination.js";
import {
  assignGoal, gatewayHealthFindings, loadGatewayRuntime, reconcileGateway
} from "../src/lib/gateway-runtime.js";
import { runWorkerTick, waitForGatewayWake } from "../src/worker.js";
import { fixture } from "./gateway-runtime-fixture.js";

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
    hostRunner: async () => ({ checkpoint: { deadline: true }, completed: true, readOnly: true }), adapter: { send: async () => ({ ok: true }) } });
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

