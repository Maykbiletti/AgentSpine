import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { targetSnapshot } from "../src/lib/delivery-target.js";
import { fixture, client } from "./mcp-bounded-fixture.js";
import { prompt } from "./assignment-continuation-fixture.js";

async function query(root, requirementId, targetPaths) {
  return client()("delivery_knowledge_query", { root, requirementId, targetPaths,
    contractPaths: ["AGENTS.md"], recentErrorTerms: ["new", "file"], maxBytes: 4096 });
}

test("MCP snapshots absent new files without creating them and hashes existing targets", async t => {
  const f = await fixture(t, { homeRoot: false });
  const p = await prompt(f.root, "prompt:new-file");
  const call = client();
  const b = await call("session_briefing", { root: f.root, host: "codex",
    requirementId: p.requirementId, includeSourceContent: false, maxBytes: 4096 });
  assert.equal(b.isError, false);
  const result = await query(f.root, p.requirementId, ["new-test.js", "new/nested/test.js", "target.js"]);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.deliveryUseReceipt.blocked, false);
  assert.equal(result.targets[0].state, "absent");
  assert.equal(result.targets[0].sha256, null);
  assert.equal(result.targets[1].state, "absent");
  assert.equal(result.targets[2].sha256,
    createHash("sha256").update(await fs.readFile(`${f.root}/target.js`)).digest("hex"));
  await assert.rejects(fs.lstat(`${f.root}/new`), { code: "ENOENT" });
  await assert.rejects(fs.lstat(`${f.root}/new-test.js`), { code: "ENOENT" });
  await f.preserve();
});

test("only ENOENT is an absent baseline; permission and parent races yield no snapshot", async t => {
  const f = await fixture(t, { homeRoot: false });
  const lstat = fs.lstat;
  let deniedCalls = 0;
  fs.lstat = async (path, ...args) => {
    if (String(path) === join(f.root, "denied.js")) {
      deniedCalls++;
      throw Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
    }
    return lstat(path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(targetSnapshot(f.root, "denied.js"), { code: "EACCES" }); }
  finally {
    fs.lstat = lstat;
    syncBuiltinESMExports();
  }
  assert.equal(deniedCalls, 1, "the permission failure must actually be injected");
  await fs.mkdir(`${f.root}/parent`);
  await fs.mkdir(`${f.root}/elsewhere`);
  let changed = false;
  fs.lstat = async (path, ...args) => {
    if (String(path) === join(f.root, "parent", "new.js") && !changed) {
      changed = true;
      await fs.rename(`${f.root}/parent`, `${f.root}/original-parent`);
      await fs.symlink(`${f.root}/elsewhere`, `${f.root}/parent`, process.platform === "win32" ? "junction" : "dir");
    }
    return lstat(path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(targetSnapshot(f.root, "parent/new.js"), /parent changed/); }
  finally {
    fs.lstat = lstat;
    syncBuiltinESMExports();
  }
  assert.equal(changed, true, "the parent replacement must actually be injected");
  await f.preserve();
});

test("MCP rejects escapes, non-directory parents and symlinked parents even for absent targets", async t => {
  const f = await fixture(t, { homeRoot: false });
  const p = await prompt(f.root, "prompt:unsafe-target");
  for (const target of ["../escape.js", "target.js/child.js"]) {
    const result = await query(f.root, p.requirementId, [target]);
    assert.equal(result.isError, true, target);
    assert.equal(result.deliveryUseReceipt, undefined);
  }
  await fs.mkdir(`${f.root}/inside`);
  await fs.symlink(`${f.root}/inside`, `${f.root}/linked`, process.platform === "win32" ? "junction" : "dir");
  const result = await query(f.root, p.requirementId, ["linked/new.js"]);
  assert.equal(result.isError, true);
  assert.match(result.error, /symbolic|symlink/i);
  assert.equal(result.deliveryUseReceipt, undefined);
  await f.preserve();
});

test("MCP error waits for an already started target read before completing", async t => {
  const f = await fixture(t, { homeRoot: false });
  const p = await prompt(f.root, "prompt:drain-failed-query");
  const lstat = fs.lstat;
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let active = 0;
  fs.lstat = async (path, ...args) => {
    if (String(path) === join(f.root, "slow.js")) {
      active++;
      started();
      await gate;
      try { return await lstat(path, ...args); }
      finally { active--; }
    }
    return lstat(path, ...args);
  };
  syncBuiltinESMExports();
  let completed = false;
  const pending = query(f.root, p.requirementId, ["../escape.js", "slow.js"])
    .then(result => { completed = true; return result; });
  try {
    await entered;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 1, "a real target read is suspended");
    assert.equal(completed, false, "MCP must not respond while owned reads remain active");
  } finally {
    release();
    await pending;
    fs.lstat = lstat;
    syncBuiltinESMExports();
  }
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.deliveryUseReceipt, undefined);
  assert.equal(active, 0);
  await f.preserve();
});
