import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOwnedFileLock } from "../src/lib/owned-file-lock.js";

const helperUrl = new URL("../src/lib/owned-file-lock.js", import.meta.url).href;
const testLease = { staleAfterMs: 1000, heartbeatIntervalMs: 100, retryDelayMs: 10, maxAttempts: 2000 };

function worker(lockPath, counterPath, holdMs = 20) {
  const script = `
    import { readFile, writeFile } from "node:fs/promises";
    import { withOwnedFileLock } from ${JSON.stringify(helperUrl)};
    const [lockPath, counterPath, holdMs] = process.argv.slice(1);
    await withOwnedFileLock(lockPath, async () => {
      const value = Number(await readFile(counterPath, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
      await writeFile(counterPath, String(value + 1), "utf8");
    }, ${JSON.stringify(testLease)});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, lockPath, counterPath, String(holdMs)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
  });
}

async function waitForLock(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await readFile(path, "utf8")).includes("agentspine.owned-file-lock/v1")) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("leader did not acquire the synthetic learning lock");
}

test("owned learning locks survive long mutations, recover crashes, and preserve foreign ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-owned-lock-"));
  const lockPath = join(root, "learning.json.lock");
  const counterPath = join(root, "counter.txt");
  const sourcePath = join(root, "AGENTS.md");
  const source = Buffer.from("# Synthetic instructions\n\nRemain byte exact.\n", "utf8");
  await Promise.all([writeFile(counterPath, "0", "utf8"), writeFile(sourcePath, source)]);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const leader = worker(lockPath, counterPath, 1200);
  await waitForLock(lockPath);
  await Promise.all([leader, ...Array.from({ length: 5 }, () => worker(lockPath, counterPath))]);
  assert.equal(await readFile(counterPath, "utf8"), "6",
    "a mutation longer than the stale threshold must retain exclusive ownership across processes");
  await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/, "the owner releases its completed lease");

  await writeFile(lockPath, "{\"crashed\":true}\n", "utf8");
  const old = new Date(Date.now() - 5000);
  await utimes(lockPath, old, old);
  let recovered = false;
  await withOwnedFileLock(lockPath, async () => { recovered = true; }, testLease);
  assert.equal(recovered, true, "an actually stale crash remnant is recoverable");

  const foreign = JSON.stringify({ schema: "agentspine.owned-file-lock/v1", token: "foreign-owner",
    acquiredAt: new Date().toISOString(), leaseMs: 1000, authority: "state-coordination-only" });
  await assert.rejects(withOwnedFileLock(lockPath, async () => {
    await unlink(lockPath);
    await writeFile(lockPath, `${foreign}\n`, "utf8");
  }, testLease),
  /ownership was lost/, "a replaced lease aborts before state commit");
  assert.equal((await readFile(lockPath, "utf8")).trim(), foreign,
    "the former owner must not delete a replacement lease during cleanup");
  assert.deepEqual(await readFile(sourcePath), source, "lock recovery never changes user sources");
});

test("same-process contenders queue before spending the external lock budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-local-lock-"));
  const lockPath = join(root, "state.json.lock");
  const sourcePath = join(root, "source.txt");
  const source = Buffer.from("synthetic source remains byte exact\n", "utf8");
  const strictLease = { staleAfterMs: 1000, heartbeatIntervalMs: 100, retryDelayMs: 1, maxAttempts: 1 };
  await writeFile(sourcePath, source);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const order = [];
  const result = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    withOwnedFileLock(lockPath, async () => {
      order.push(`start-${index}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push(`end-${index}`);
      return index;
    }, strictLease)));

  assert.deepEqual(result, [0, 1, 2, 3]);
  assert.deepEqual(order, ["start-0", "end-0", "start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  assert.deepEqual(await readFile(sourcePath), source, "local queuing never changes user sources");
  await assert.rejects(readFile(lockPath), /ENOENT/);
});

test("a failed local owner releases its same-path successor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-local-lock-failure-"));
  const lockPath = join(root, "state.json.lock");
  const strictLease = { staleAfterMs: 1000, heartbeatIntervalMs: 100, retryDelayMs: 1, maxAttempts: 1 };
  t.after(async () => rm(root, { recursive: true, force: true }));

  const settled = await Promise.allSettled([
    withOwnedFileLock(lockPath, async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("synthetic owner failure");
    }, strictLease),
    withOwnedFileLock(lockPath, async () => "successor-acquired", strictLease)
  ]);

  assert.equal(settled[0].status, "rejected");
  assert.match(settled[0].reason.message, /synthetic owner failure/);
  assert.deepEqual(settled[1], { status: "fulfilled", value: "successor-acquired" });
  await assert.rejects(readFile(lockPath), /ENOENT/);
});

test("local serialization remains independent for different lock paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-local-lock-paths-"));
  const strictLease = { staleAfterMs: 1000, heartbeatIntervalMs: 100, retryDelayMs: 1, maxAttempts: 1 };
  t.after(async () => rm(root, { recursive: true, force: true }));
  let entered = 0;
  let release;
  const bothEntered = new Promise((resolve) => { release = resolve; });
  const enter = async () => {
    entered += 1;
    if (entered === 2) release();
    await Promise.race([
      bothEntered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("unrelated lock paths were serialized")), 500))
    ]);
  };

  await Promise.all([
    withOwnedFileLock(join(root, "left.lock"), enter, strictLease),
    withOwnedFileLock(join(root, "right.lock"), enter, strictLease)
  ]);
  assert.equal(entered, 2);
});
