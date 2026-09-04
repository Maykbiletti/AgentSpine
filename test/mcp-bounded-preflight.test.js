import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, client, requirement, measureReads } from "./mcp-bounded-fixture.js";
import { verifyDeliveryAgentUse } from "../src/lib/delivery-agent-usage.js";

for (const host of ["codex", "claude", "generic"]) {
  test(`real ${host} MCP preflight never enumerates unrelated home trees`, async t => {
    const f = await fixture(t);
    const requirementId = await requirement(f.root, host);
    const call = client();
    const measured = await measureReads(async () => {
      const briefing = await call("session_briefing", { root: f.root, host,
        requirementId, projectId: "project:synthetic", includeSourceContent: false });
      assert.equal(briefing.isError, false, briefing.error);
      const contractPaths = host === "claude" ? ["CLAUDE.md", "CLAUDE.local.md"] : ["AGENTS.md"];
      const knowledge = await call("delivery_knowledge_query", { root: f.root, requirementId,
        targetPaths: ["target.js"], contractPaths, recentErrorTerms: ["timeout", "source"] });
      assert.equal(knowledge.isError, false, knowledge.error);
      assert.equal(knowledge.contracts.length, contractPaths.length);
      assert.ok(knowledge.contracts.every(item => item.matchedRecentErrorTerms.includes("timeout")));
      assert.ok(knowledge.deliveryUseReceipt.digest);
      return { briefing, knowledge };
    });
    assert.deepEqual(measured.accesses.filter(item => item.path.includes("unrelated")), []);
    assert.equal(measured.accesses.some(item => item.operation !== "readFile" && item.path === f.home), false);
    assert.equal(JSON.stringify(measured.result).includes("SYNTHETIC_FOREIGN_SENTINEL"), false);
    assert.ok(measured.elapsed < 4000);
    await f.preserve();
    t.diagnostic(`${host} preflight ${Math.round(measured.elapsed)} ms; no home enumeration`);
  });
}

test("one scoped catalog serves all contract readers and the nested briefing", async t => {
  const f = await fixture(t, { homeRoot: false });
  await mkdir(join(f.root, "contracts"));
  const contractPaths = ["AGENTS.md"];
  for (let i = 0; i < 5; i++) {
    const path = `contracts/contract-${i}.md`;
    await writeFile(join(f.root, path), "# Synthetic contract\nsource timeout\n");
    contractPaths.push(path);
  }
  const requirementId = await requirement(f.root, "codex");
  const call = client();
  assert.equal((await call("session_briefing", { root: f.root, host: "codex", requirementId })).isError, false);
  const measured = await measureReads(() => call("delivery_knowledge_query", {
    root: f.root, requirementId, targetPaths: ["target.js"], contractPaths,
    recentErrorTerms: ["source", "timeout"] }));
  assert.equal(measured.result.isError, false, measured.result.error);
  assert.equal(measured.result.contracts.length, 6);
  assert.equal(measured.accesses.filter(item => item.path === join(f.root, "contracts")
    && ["readdir", "opendir"].includes(item.operation)).length, 1);
  await f.preserve();
});

test("MCP callers cannot supply an internal catalog or alternate state root", async t => {
  const f = await fixture(t);
  for (const key of ["catalog", "userStateRoot", "sourceDiagnostics", "sourceRegistry", "env"]) {
    const requirementId = await requirement(f.root, "codex", `session:injected-${key}`);
    const result = await client()("session_briefing", { root: f.root, host: "codex",
      requirementId, [key]: {} });
    assert.equal(result.isError, true);
    assert.match(result.error, /internal|unsupported/i);
    assert.equal((await verifyDeliveryAgentUse({ root: f.root, requirementId })).status, "missing-briefing");
  }
});

test("resolve_context uses the process-selected host consistently without a home scan", async t => {
  const f = await fixture(t);
  const previous = process.env.AGENTSPINE_HOST;
  process.env.AGENTSPINE_HOST = "codex";
  try {
    const measured = await measureReads(() => client()("resolve_context", { root: f.root }));
    assert.equal(measured.result.isError, false, measured.result.error);
    assert.equal(measured.result.host, "codex");
    assert.equal(measured.result.documents.length, 1);
    assert.equal(measured.result.documents[0].name, "AGENTS.md");
    assert.equal(measured.accesses.some(item => item.path.includes("unrelated")), false);
    await f.preserve();
  } finally {
    if (previous === undefined) delete process.env.AGENTSPINE_HOST;
    else process.env.AGENTSPINE_HOST = previous;
  }
});
