import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fixture, client, requirement, measureReads, processCall } from "./mcp-bounded-fixture.js";
import { resolveHostSourceCatalog } from "../src/lib/source-roots.js";
import { readDocument } from "../src/lib/context.js";
import { verifyDeliveryAgentUse } from "../src/lib/delivery-agent-usage.js";

test("permission uncertainty gives no receipt, then retry works without resetting state", async t => {
  const f = await fixture(t, { homeRoot: false });
  const blockedPath = join(f.root, "blocked");
  await fs.mkdir(blockedPath);
  const requirementId = await requirement(f.root, "codex");
  const call = client();
  const opendir = fs.opendir;
  fs.opendir = async (...args) => {
    if (String(args[0]) === blockedPath) {
      throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
    }
    return opendir(...args);
  };
  syncBuiltinESMExports();
  try {
    const rejected = await call("session_briefing", { root: f.root, host: "codex", requirementId });
    assert.equal(rejected.isError, true);
    assert.match(rejected.error, /incomplete/);
    assert.equal((await verifyDeliveryAgentUse({ root: f.root, requirementId })).status, "missing-briefing");
    const readable = await call("session_briefing", { root: f.root, host: "codex" });
    assert.equal(readable.isError, false);
  } finally {
    fs.opendir = opendir;
    syncBuiltinESMExports();
  }
  // A restarted protocol instance reuses the original requirement, not a reset.
  const recovered = await client()("session_briefing", { root: f.root, host: "codex", requirementId });
  assert.equal(recovered.isError, false, recovered.error);
  assert.ok(recovered.deliveryUseReceipt.digest);
  await f.preserve();
});

test("changed, deleted, replaced and foreign catalog sources never return bytes", async t => {
  const f = await fixture(t);
  const sources = await resolveHostSourceCatalog({ host: "codex", cwd: f.root });
  const options = { root: f.root, catalog: sources.catalog, path: "AGENTS.md" };
  const initial = await readDocument(options);
  assert.ok(initial.content.includes("Synthetic"));
  await fs.writeFile(join(f.root, "AGENTS.md"), "replacement bytes\n");
  await assert.rejects(readDocument(options), /changed/);
  await fs.unlink(join(f.root, "AGENTS.md"));
  await assert.rejects(readDocument(options));
  await assert.rejects(readDocument({ ...options, root: f.foreign }), /different project/);
  try {
    await fs.symlink(join(f.foreign, "PRIVATE.md"), join(f.root, "AGENTS.md"));
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(readDocument(options), /changed/);
});

test("source changes during handle read are rejected", async t => {
  const f = await fixture(t);
  const { catalog } = await resolveHostSourceCatalog({ host: "codex", cwd: f.root });
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === join(f.root, "AGENTS.md")) {
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          await fs.appendFile(join(f.root, "AGENTS.md"), "changed during read\n");
        }
        return result;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(readDocument({ root: f.root, catalog, path: "AGENTS.md" }), /changed/);
  } finally {
    fs.open = open;
    syncBuiltinESMExports();
  }
});

test("foreign scope and project claims fail before receipt creation", async t => {
  const f = await fixture(t);
  for (const [key, value] of [["host", "claude"], ["projectId", "project:foreign"],
    ["groupId", "group:foreign"], ["entityId", "agent:foreign"], ["currentTaskId", "task:foreign"]]) {
    const requirementId = await requirement(f.root, "codex", `session:foreign-${key}`);
    const measured = await measureReads(() => client()("session_briefing", {
      root: f.root, requirementId, [key]: value }));
    assert.equal(measured.result.isError, true);
    assert.match(measured.result.error, /does not match/);
    assert.equal(measured.accesses.some(item => ["opendir", "readdir"].includes(item.operation)), false);
    assert.equal((await verifyDeliveryAgentUse({ root: f.root, requirementId })).status, "missing-briefing");
  }
});

test("concurrent independent protocol instances retain separate receipts and current bytes", async t => {
  const f = await fixture(t);
  const ids = await Promise.all([requirement(f.root, "codex", "session:a"),
    requirement(f.root, "codex", "session:b")]);
  const results = await Promise.all(ids.map(requirementId => client()("session_briefing", {
    root: f.root, requirementId, host: "codex" })));
  assert.ok(results.every(result => !result.isError && result.deliveryUseReceipt.digest));
  assert.notEqual(results[0].deliveryUseReceipt.digest, results[1].deliveryUseReceipt.digest);
  const changed = await client()("read_document", { root: f.root, host: "codex", path: "AGENTS.md" });
  assert.equal(changed.isError, false);
  assert.equal(changed.content.includes("Synthetic"), true);
  const denied = await client()("read_document", { root: f.root, host: "codex", path: "unrelated/deep/PRIVATE.md" });
  assert.equal(denied.isError, true);
  await f.preserve();
});

test("killed MCP process resumes persisted preflight and reads fresh source evidence", async t => {
  const f = await fixture(t);
  const requirementId = await requirement(f.root, "codex");
  const briefing = await processCall(f.root, "session_briefing", { root: f.root,
    host: "codex", requirementId });
  assert.equal(briefing.isError, false, briefing.error);
  const args = { root: f.root, requirementId, targetPaths: ["target.js"],
    contractPaths: ["AGENTS.md"], recentErrorTerms: ["source", "timeout"] };
  const first = await processCall(f.root, "delivery_knowledge_query", args);
  assert.equal(first.isError, false, first.error);
  assert.equal((await verifyDeliveryAgentUse({ root: f.root, requirementId })).status, "verified");
  await f.preserve();
  await fs.writeFile(join(f.root, "AGENTS.md"), "# New synthetic source\nsource timeout after restart\n");
  const secondId = await requirement(f.root, "codex", "session:restart-new-delivery");
  assert.equal((await processCall(f.root, "session_briefing", {
    root: f.root, host: "codex", requirementId: secondId })).isError, false);
  const second = await processCall(f.root, "delivery_knowledge_query", { ...args, requirementId: secondId });
  assert.equal(second.isError, false, second.error);
  assert.notEqual(second.contracts[0].sha256, first.contracts[0].sha256);
});
