import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { channelEventSigningPayload, claimChannelEvent,
  ingestChannelEvent, loadChannelRuntime, revokeChannelBinding } from "../src/lib/channel-runtime.js";
import { claimGatewayWork, completeGatewayRun, loadGatewayRuntime, reconcileGateway } from "../src/lib/gateway-runtime.js";
import { groupResponseContract, reviewGroupResponse, settleSuppressedGroupEvents } from "../src/lib/gateway-group-response.js";
import { runWorkerTick } from "../src/worker.js";
import { fixture } from "./gateway-runtime-fixture.js";
import { markTestGatewayHostStarted } from "./gateway-claim-fixture.js";

const schema = "agentspine.group-response/v1";
const silence = { groupResponse: { schema, kind: "silence" } };
const now = "2032-01-01T00:00:05.000Z";
const secret = "synthetic-ingress-secret-with-32-bytes";

async function incoming(root, id, overrides = {}) {
  const event = { schema: "agentspine.channel-event/v1", eventId: `telegram:update:${id}`,
    provider: "telegram", tenantId: "tenant:alpha", accountId: "123456789", chatId: "-1001234567890",
    threadId: "42", senderId: "777", replyTo: String(id), observedAt: "2032-01-01T00:00:02.000Z",
    privacy: "group", text: "Synthetic group activity.", ...overrides };
  const signature = "sha256=" + createHmac("sha256", secret).update(channelEventSigningPayload(event)).digest("hex");
  return ingestChannelEvent({ root, event, signature, env: { AGENTSPINE_TEST_INGRESS: secret }, now });
}

async function claim(root) {
  await reconcileGateway({ root, now });
  const claimed = await claimGatewayWork({ root, workerId: "worker:group", now });
  await markTestGatewayHostStarted(root, claimed, now);
  return { root, queueId: claimed.item.queueId, workerId: claimed.item.lease.workerId,
    claimedAt: claimed.item.lease.claimedAt, attempt: claimed.item.attempts, now };
}

test("group silence completes without text, outbox, delivery claim or repeated host invocation", async (t) => {
  const { root, before } = await fixture(t);
  const source = await readFile(join(root, "AGENTS.md"));
  const started = performance.now(); let calls = 0; let sends = 0; let contextBytes = 0;
  const hostRunner = async (item) => {
    calls += 1;
    assert.equal(item.groupResponseContract.defaultKind, "silence");
    assert.equal(item.groupResponseContract.directAddressVerified, false);
    contextBytes = Buffer.byteLength(JSON.stringify(item.groupResponseContract));
    return silence;
  };
  const adapter = { send: async () => { sends += 1; return { ok: true, receipt: "synthetic" }; } };
  for (let id = 1; id <= 5; id += 1) {
    await incoming(root, id);
    const result = await runWorkerTick({ root, hostRunner, adapter, now });
    assert.equal(result.status, "silent");
    assert.equal(result.deliveryConfirmed, false);
    assert.equal(result.completionVerified, false);
  }
  for (let id = 0; id < 3; id += 1) {
    assert.equal((await runWorkerTick({ root, hostRunner, adapter, now })).processed, false);
  }
  const { runtime } = await loadGatewayRuntime(root);
  assert.equal(runtime.outbox.length, 0);
  assert.equal(runtime.queue.filter((item) => item.status === "completed").length, 5);
  assert.equal(runtime.receipts.filter((item) => item.kind === "group-response-suppressed").length, 5);
  const channel = (await loadChannelRuntime(root)).runtime;
  assert.equal(channel.events.filter((event) => event.status === "completed").length, 5);
  assert.equal(channel.receipts.some((receipt) => receipt.details.deliveryReceiptId), false);
  assert.equal(calls, 5); assert.equal(sends, 0);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), source);
  assert.equal(await readFile(join(root, "SOUL.md"), "utf8"), before);
  assert.ok(contextBytes <= 1024);
  assert.ok(performance.now() - started < 10000);
  t.diagnostic(JSON.stringify({ task: "five-empty-group-wakes", hostCalls: calls, sends,
    contextBytes, elapsedMs: performance.now() - started, tokens: null, realModelRuns: 0 }));
});

test("new ideas, errors and improvements send once; changed content and direct answers remain possible", async (t) => {
  const { root } = await fixture(t);
  let sends = 0; let id = 20;
  const adapter = { send: async () => ({ ok: true, receipt: `synthetic:${++sends}` }) };
  for (const kind of ["idea", "error", "improvement"]) {
    const result = { text: `Synthetic ${kind}: keep the source backup.`,
      groupResponse: { schema, kind, subjectId: `subject:${kind}` } };
    await incoming(root, id++);
    assert.equal((await runWorkerTick({ root, now, adapter, hostRunner: async () => result })).status, "delivered");
    await incoming(root, id++);
    const duplicate = await runWorkerTick({ root, now, adapter, hostRunner: async () => result });
    assert.equal(duplicate.status, "silent"); assert.equal(duplicate.communication.duplicate, true);
    await incoming(root, id++);
    const changed = { ...result, text: result.text + " The destination has changed." };
    assert.equal((await runWorkerTick({ root, now, adapter, hostRunner: async () => changed })).status, "delivered");
  }
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await incoming(root, id++, { text: "Bitte nenne den aktuellen Stand." });
    assert.equal((await runWorkerTick({ root, now, adapter, hostRunner: async () => ({
      text: "Noch kein neues Ergebnis; die Prüfung läuft.", groupResponse: { schema, kind: "answer" }
    }) })).status, "delivered");
  }
  assert.equal(sends, 8);
});

test("crash after durable suppression recovers a pending or already claimed channel event without rerun", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 50);
  const completion = await completeGatewayRun({ ...await claim(root), result: silence });
  assert.equal(completion.outbox, null);
  assert.equal((await loadChannelRuntime(root)).runtime.events[0].status, "pending");
  // Reconstruct the deterministic recovery worker and stop between its two writes.
  const { createHash } = await import("node:crypto");
  const workerId = "group-silence:" + createHash("sha256").update(completion.item.queueId).digest("hex").slice(0, 32);
  const event = (await loadChannelRuntime(root)).runtime.events[0];
  await claimChannelEvent({ root, agentId: event.agentId, projectId: event.projectId,
    groupId: event.groupId, provider: event.provider, eventId: event.eventId, workerId, now });
  const tick = await runWorkerTick({ root, now, hostRunner: async () => { throw new Error("must not rerun"); },
    adapter: { send: async () => { throw new Error("must not send"); } } });
  assert.equal(tick.processed, false);
  assert.equal((await loadChannelRuntime(root)).runtime.events[0].status, "completed");
  assert.equal((await settleSuppressedGroupEvents({ root, now })).settled, 0);
});

test("competing completions consume one exact lease and leave one durable suppression", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 60);
  const request = { ...await claim(root), result: silence };
  const results = await Promise.allSettled([completeGatewayRun(request), completeGatewayRun(request)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const recovered = await Promise.all([settleSuppressedGroupEvents({ root, now }), settleSuppressedGroupEvents({ root, now })]);
  assert.equal(recovered.reduce((sum, result) => sum + result.settled, 0), 1);
  assert.equal((await loadGatewayRuntime(root)).runtime.outbox.length, 0);
});

test("malformed, future, secret, false-silence and expired results cannot send or consume the lease", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 70);
  const request = await claim(root);
  const before = JSON.stringify((await loadGatewayRuntime(root)).runtime);
  for (const result of [
    { groupResponse: { schema: "agentspine.group-response/v999", kind: "silence" } },
    { groupResponse: { schema, kind: "silence", trusted: true } },
    { groupResponse: { schema, kind: "unknown" } },
    { ...silence, text: "Nothing to report." },
    { text: "token=abcdefghijklmnopqrstuvwxyz123456", groupResponse: { schema, kind: "answer" } },
    { text: "An idea", groupResponse: { schema, kind: "idea" } }
  ]) await assert.rejects(completeGatewayRun({ ...request, result }));
  await assert.rejects(completeGatewayRun({ ...request, workerId: "worker:foreign", result: silence }));
  await assert.rejects(completeGatewayRun({ ...request, now: "2032-01-01T01:00:00Z", result: silence }));
  assert.equal(JSON.stringify((await loadGatewayRuntime(root)).runtime), before);
  await completeGatewayRun({ ...request, result: silence });
});

test("revoked bindings still reject silence without a forged delivery acknowledgement", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 80);
  const request = await claim(root);
  await revokeChannelBinding({ root, id: "channel-binding:telegram", reason: "Synthetic revocation",
    confirmation: "local-owner-confirmed", now });
  await assert.rejects(completeGatewayRun({ ...request, result: silence }), /reply capability/);
  assert.equal((await loadGatewayRuntime(root)).runtime.outbox.length, 0);
});

test("fresh worker process recovers silence without provider invocation or adapter access", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 90);
  await completeGatewayRun({ ...await claim(root), result: silence });
  const moduleUrl = new URL("../src/worker.js", import.meta.url).href;
  const script = `import {runWorkerTick} from ${JSON.stringify(moduleUrl)};
    const result = await runWorkerTick({root:${JSON.stringify(root)},now:${JSON.stringify(now)},
      hostRunner:async()=>{throw Error("unexpected provider call")},
      adapter:{send:async()=>{throw Error("unexpected adapter call")}}});
    process.stdout.write(JSON.stringify(result));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script],
    { timeout: 5000, maxBuffer: 4096, env: process.env });
  assert.equal(JSON.parse(stdout).processed, false);
  assert.equal((await loadChannelRuntime(root)).runtime.events[0].status, "completed");
});

test("revocation after silent commit defers local acknowledgement without rerunning or stopping other work", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 95);
  await completeGatewayRun({ ...await claim(root), result: silence });
  await revokeChannelBinding({ root, id: "channel-binding:telegram", reason: "Synthetic revocation",
    confirmation: "local-owner-confirmed", now });
  const recovery = await settleSuppressedGroupEvents({ root, now });
  // Channel revocation may itself cancel the event. Neither case creates a send.
  assert.equal(recovery.settled, 0);
  assert.equal((await runWorkerTick({ root, now, hostRunner: async () => { throw Error("must not rerun"); },
    adapter: { send: async () => { throw Error("must not send"); } } })).processed, false);
});

test("prepared contribution reserves dedupe before send and survives restart without another outbox", async (t) => {
  const { root } = await fixture(t);
  const result = { text: "Preserve the synthetic backup.", groupResponse: { schema, kind: "improvement", subjectId: "subject:backup" } };
  await incoming(root, 96);
  const first = await completeGatewayRun({ ...await claim(root), result });
  assert.equal(first.outbox.status, "prepared");
  await incoming(root, 97);
  const second = await completeGatewayRun({ ...await claim(root), result });
  assert.equal(second.communication.duplicate, true);
  assert.equal(second.outbox, null);
  let sends = 0;
  const tick = await runWorkerTick({ root, now, hostRunner: async () => { throw Error("must not rerun"); },
    adapter: { send: async () => { sends += 1; return { ok: true, receipt: "synthetic:recovered" }; } } });
  assert.equal(tick.status, "delivered");
  assert.equal(sends, 1);
  assert.equal((await loadGatewayRuntime(root)).runtime.outbox.length, 1);
});

test("busy acknowledgement service remains deferred, never a successful delivery or a host retry", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 98);
  await completeGatewayRun({ ...await claim(root), result: silence });
  const { directory } = await loadChannelRuntime(root);
  const lock = join(directory, "channel-runtime.lock");
  await writeFile(lock, "synthetic busy channel", { flag: "wx" });
  try {
    assert.deepEqual(await settleSuppressedGroupEvents({ root, now }), { settled: 0, deferred: 1 });
    assert.equal((await loadGatewayRuntime(root)).runtime.outbox.length, 0);
  } finally { await unlink(lock); }
  assert.equal((await settleSuppressedGroupEvents({ root, now })).settled, 1);
});

test("mutated channel source cannot be acknowledged as silence", async (t) => {
  const { root } = await fixture(t);
  await incoming(root, 100);
  await completeGatewayRun({ ...await claim(root), result: silence });
  const loaded = await loadChannelRuntime(root);
  const original = await readFile(loaded.channelRuntimePath);
  const changed = JSON.parse(original);
  changed.events[0].text = "Modified synthetic message";
  await writeFile(loaded.channelRuntimePath, JSON.stringify(changed));
  await assert.rejects(settleSuppressedGroupEvents({ root, now }));
  assert.equal((await loadGatewayRuntime(root)).runtime.outbox.length, 0);
  assert.equal(JSON.parse(await readFile(loaded.channelRuntimePath)).events[0].text, changed.events[0].text);
});

test("private replies cannot opt into group silence; exact route changes do not share contribution dedupe", () => {
  const event = { eventId: "event:one", privacy: "group", provider: "telegram", tenantId: "tenant:alpha",
    accountId: "account:alpha", bindingId: "binding:alpha", agentId: "agent:alpha", projectId: "project:alpha",
    groupId: "group:alpha", chatId: "chat:alpha", threadId: "thread:alpha", sessionKey: "session:alpha" };
  const item = { queueId: "queue:alpha", agentId: event.agentId, projectId: event.projectId, groupId: event.groupId };
  const runtime = { receipts: [] };
  const result = { text: "A useful suggestion", groupResponse: { schema, kind: "idea", subjectId: "subject:backup" } };
  const review = (source, target = item) => reviewGroupResponse({ result, text: result.text, event: source, item: target, runtime, current: now });
  assert.equal(review(event).suppressed, false);
  assert.equal(review({ ...event, eventId: "event:two" }).duplicate, true);
  for (const key of ["tenantId", "accountId", "bindingId", "chatId", "threadId", "sessionKey"]) {
    assert.equal(review({ ...event, [key]: `${key}:other` }).duplicate, false);
  }
  for (const key of ["agentId", "projectId", "groupId"]) {
    assert.throws(() => review({ ...event, [key]: `${key}:other` }), /exact group/);
    assert.equal(review({ ...event, [key]: `${key}:other` }, { ...item, [key]: `${key}:other` }).duplicate, false);
  }
  assert.equal(groupResponseContract({ ...event, groupId: null }), null);
  assert.throws(() => reviewGroupResponse({ result: silence, text: null, event: { ...event, groupId: null },
    item, runtime, current: now }), /exact group/);
});
