import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { runBoundedProcess, selectTestShard } from "../scripts/hermetic-process.js";

function capture() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  let value = "";
  stream.on("data", (chunk) => { value += chunk; });
  return { stream, value: () => value };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("hermetic shards are deterministic, disjoint, and complete", () => {
  const files = Array.from({ length: 151 }, (_, index) => `test-${String(index).padStart(3, "0")}.js`);
  const left = selectTestShard(files, "1/2");
  const right = selectTestShard(files, "2/2");
  assert.equal(left.length, 76);
  assert.equal(right.length, 75);
  assert.deepEqual([...left, ...right].sort(), files);
  assert.equal(left.some((file) => right.includes(file)), false);
  assert.deepEqual(selectTestShard(files), files);
  for (const invalid of ["0/2", "3/2", "1/1", "one/two", "1/0"]) {
    assert.throws(() => selectTestShard(files, invalid), /SHARD/);
  }
});

test("bounded process runner preserves a successful child and reports progress", async () => {
  const progress = capture();
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["--input-type=module", "--eval", "process.stdout.write('synthetic success\\n')"],
    label: "synthetic-success",
    timeoutMs: 2_000,
    progress: progress.stream
  });

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "synthetic success\n");
  assert.match(progress.value(), /\[synthetic-success\] START/);
  assert.match(progress.value(), /\[synthetic-success\] PASS/);
});

test("bounded process runner terminates a hanging descendant tree", async () => {
  const progress = capture();
  const script = `
    import { spawn } from "node:child_process";
    const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore", windowsHide: true
    });
    process.stdout.write(String(descendant.pid) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["--input-type=module", "--eval", script],
    label: "synthetic-hang",
    timeoutMs: 1_000,
    terminationGraceMs: 500,
    progress: progress.stream
  });

  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 5_000, "the runner must not inherit the child hang");
  assert.match(progress.value(), /\[synthetic-hang\] START/);
  assert.match(progress.value(), /\[synthetic-hang\] TIMEOUT after 1000ms/);
  const descendantPid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  await delay(100);
  assert.equal(processExists(descendantPid), false, "the timeout must terminate descendants too");
});
