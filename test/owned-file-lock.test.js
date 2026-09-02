import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOwnedFileLock } from "../src/lib/owned-file-lock.js";

const helperUrl = new URL("../src/lib/owned-file-lock.js", import.meta.url).href;

function worker(lockPath, counterPath) {
  const script = `
    import { readFile, writeFile } from "node:fs/promises";
    import { withOwnedFileLock } from ${JSON.stringify(helperUrl)};
    const [lockPath, counterPath] = process.argv.slice(1);
    await withOwnedFileLock(lockPath, async () => {
      const value = Number(await readFile(counterPath, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 90));
      await writeFile(counterPath, String(value + 1), "utf8");
    }, { staleAfterMs: 80, heartbeatIntervalMs: 20, retryDelayMs: 5, maxAttempts: 500 });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, lockPath, counterPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
  });
}

test("owned learning locks survive long mutations, recover crashes, and preserve foreign ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-owned-lock-"));
  const lockPath = join(root, "learning.json.lock");
  const counterPath = join(root, "counter.txt");
  const sourcePath = join(root, "AGENTS.md");
  const source = Buffer.from("# Synthetic instructions\n\nRemain byte exact.\n", "utf8");
  await Promise.all([writeFile(counterPath, "0", "utf8"), writeFile(sourcePath, source)]);
  t.after(async () => rm(root, { recursive: true, force: true }));

  await Promise.all(Array.from({ length: 6 }, () => worker(lockPath, counterPath)));
  assert.equal(await readFile(counterPath, "utf8"), "6",
    "a mutation longer than the stale threshold must retain exclusive ownership across processes");
  await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/, "the owner releases its completed lease");

  await writeFile(lockPath, "{\"crashed\":true}\n", "utf8");
  const old = new Date(Date.now() - 5000);
  await utimes(lockPath, old, old);
  let recovered = false;
  await withOwnedFileLock(lockPath, async () => { recovered = true; }, {
    staleAfterMs: 80, heartbeatIntervalMs: 20, retryDelayMs: 5, maxAttempts: 20
  });
  assert.equal(recovered, true, "an actually stale crash remnant is recoverable");

  const foreign = JSON.stringify({ schema: "agentspine.owned-file-lock/v1", token: "foreign-owner",
    acquiredAt: new Date().toISOString(), leaseMs: 1000, authority: "state-coordination-only" });
  await assert.rejects(withOwnedFileLock(lockPath, async () => {
    await unlink(lockPath);
    await writeFile(lockPath, `${foreign}\n`, "utf8");
  }, { staleAfterMs: 1000, heartbeatIntervalMs: 100, retryDelayMs: 5, maxAttempts: 20 }),
  /ownership was lost/, "a replaced lease aborts before state commit");
  assert.equal((await readFile(lockPath, "utf8")).trim(), foreign,
    "the former owner must not delete a replacement lease during cleanup");
  assert.deepEqual(await readFile(sourcePath), source, "lock recovery never changes user sources");
});
