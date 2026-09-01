import assert from "node:assert/strict";
import test from "node:test";
import {
  isFileLockContention, isTransientLockMetadataError, replaceFileWithRetry
} from "../src/lib/filesystem-retry.js";

test("Windows lock contention recognizes access errors without weakening other platforms", () => {
  assert.equal(isFileLockContention({ code: "EEXIST" }, "linux"), true);
  assert.equal(isFileLockContention({ code: "EACCES" }, "win32"), true);
  assert.equal(isFileLockContention({ code: "EPERM" }, "win32"), true);
  assert.equal(isFileLockContention({ code: "EBUSY" }, "win32"), false);
  assert.equal(isFileLockContention({ code: "EPERM" }, "linux"), false);
  assert.equal(isFileLockContention({ code: "ENOENT" }, "win32"), false);
});

test("Windows lock metadata races retry transient stat failures", () => {
  assert.equal(isTransientLockMetadataError({ code: "ENOENT" }, "linux"), true);
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    assert.equal(isTransientLockMetadataError({ code }, "win32"), true);
    assert.equal(isTransientLockMetadataError({ code }, "linux"), false);
  }
  assert.equal(isTransientLockMetadataError({ code: "EINVAL" }, "win32"), false);
});

test("Windows atomic replacement retries transient access errors with bounded backoff", async () => {
  const codes = ["EPERM", "EACCES", "EBUSY"];
  const waits = [];
  const calls = [];
  await replaceFileWithRetry("state.tmp", "state.json", {
    platform: "win32",
    renameFile: async (...paths) => {
      calls.push(paths);
      const code = codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
    },
    wait: async (milliseconds) => { waits.push(milliseconds); }
  });
  assert.deepEqual(waits, [10, 20, 30]);
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ["state.tmp", "state.json"]));
});

test("atomic replacement does not retry non-Windows or non-transient failures", async () => {
  for (const [platform, code] of [["linux", "EPERM"], ["win32", "ENOENT"]]) {
    let calls = 0;
    await assert.rejects(replaceFileWithRetry("state.tmp", "state.json", {
      platform,
      renameFile: async () => {
        calls += 1;
        throw Object.assign(new Error(code), { code });
      },
      wait: async () => assert.fail("unexpected retry")
    }), { code });
    assert.equal(calls, 1);
  }
});

test("Windows atomic replacement stops at the configured retry limit", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(replaceFileWithRetry("state.tmp", "state.json", {
    platform: "win32",
    maxRetries: 2,
    renameFile: async () => {
      calls += 1;
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    wait: async (milliseconds) => { waits.push(milliseconds); }
  }), { code: "EPERM" });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});
