import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claimGatewayWork, loadGatewayRuntime, markGatewayHostStarted
} from "../src/lib/gateway-runtime.js";
import { runWorkerTick } from "../src/worker.js";
import { assignPremortemPlan, premortemGoalFixture } from "./goal-premortem-fixture.js";

const workerUrl = new URL("../src/worker.js", import.meta.url).href;

function crashAfterHostEffect(root, effectPath) {
  const script = `
    import { appendFile } from "node:fs/promises";
    import { runWorkerTick } from ${JSON.stringify(workerUrl)};
    const [root, effectPath] = process.argv.slice(1);
    await runWorkerTick({ root, workerId: "worker:crash-after-effect",
      now: "2032-02-01T00:00:02.000Z", adapter: { send: async () => ({ ok: true }) },
      hostRunner: async () => {
        await appendFile(effectPath, "effect\\n");
        process.exit(86);
      } });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ["--input-type=module", "--eval", script, root, effectPath],
      { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

test("host-started transition requires one exact active lease", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:exact-host-start");
  const claim = await claimGatewayWork({ root, workerId: "worker:exact-host-start",
    now: "2032-02-01T00:00:02.000Z" });
  await assert.rejects(markGatewayHostStarted({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, now: "2032-02-01T00:00:02.050Z" }), /claimedAt and attempt/i);
  await assert.rejects(markGatewayHostStarted({ root, queueId: claim.item.queueId,
    workerId: "worker:foreign", claimedAt: claim.item.lease.claimedAt,
    attempt: claim.item.attempts, now: "2032-02-01T00:00:02.100Z" }), /exact active queue lease/i);
  await assert.rejects(markGatewayHostStarted({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, claimedAt: "2032-02-01T00:00:01.000Z",
    attempt: claim.item.attempts, now: "2032-02-01T00:00:02.100Z" }), /exact active queue lease/i);
  assert.equal((await loadGatewayRuntime(root)).runtime.queue[0].lease.hostStartedAt, undefined);

  const started = await markGatewayHostStarted({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt,
    attempt: claim.item.attempts, now: "2032-02-01T00:00:02.200Z" });
  assert.equal(started.item.lease.hostStartedAt, "2032-02-01T00:00:02.200Z");
  await assert.rejects(markGatewayHostStarted({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt,
    attempt: claim.item.attempts, now: "2032-02-01T00:00:02.300Z" }), /already started/i);
});

test("restart blocks an exact host-started lease instead of repeating its effect", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:crash-after-host-effect");
  const effectPath = join(root, "synthetic-effects.log");
  await writeFile(effectPath, "");

  const crashed = await crashAfterHostEffect(root, effectPath);
  assert.equal(crashed.code, 86, crashed.stderr);
  const interrupted = await loadGatewayRuntime(root);
  assert.equal(interrupted.runtime.queue[0].status, "leased");
  assert.equal(interrupted.runtime.queue[0].lease.hostStartedAt, "2032-02-01T00:00:02.000Z");

  const restarted = await runWorkerTick({ root, workerId: "worker:restart-after-effect",
    now: "2032-02-01T00:02:03.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async () => { throw new Error("ambiguous host effect must not run twice"); } });
  assert.equal(restarted.processed, false);
  assert.equal(await readFile(effectPath, "utf8"), "effect\n");

  const recovered = await loadGatewayRuntime(root);
  assert.equal(recovered.runtime.queue[0].status, "blocked");
  assert.equal(recovered.runtime.queue[0].lease, null);
  assert.equal(recovered.policy.goals[0].status, "blocked");
  assert.equal(recovered.policy.goals[0].plan.steps[0].status, "blocked");
  assert.equal(recovered.runtime.receipts.filter((item) => item.kind === "host-started").length, 1);
  assert.equal(recovered.runtime.receipts.filter((item) => item.kind === "host-outcome-ambiguous").length, 1);
  assert.equal((await claimGatewayWork({ root, workerId: "worker:no-second-claim",
    now: "2032-02-01T00:02:04.000Z" })).item, null);
});

test("a caught host error after invocation blocks instead of replaying", async (t) => {
  const { root, agentId } = await premortemGoalFixture(t);
  await assignPremortemPlan(root, agentId, "goal:caught-host-error");
  let effects = 0;
  const first = await runWorkerTick({ root, workerId: "worker:caught-host-error",
    now: "2032-02-01T00:00:02.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async () => { effects += 1; throw new Error("synthetic failure after effect"); } });
  assert.equal(first.status, "blocked");
  const second = await runWorkerTick({ root, workerId: "worker:must-not-replay",
    now: "2032-02-01T00:02:03.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async () => { effects += 1; return { completed: true }; } });
  assert.equal(second.processed, false);
  assert.equal(effects, 1);
  const loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue[0].status, "blocked");
  assert.equal(loaded.policy.goals[0].status, "blocked");
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "host-outcome-ambiguous").length, 1);
});
