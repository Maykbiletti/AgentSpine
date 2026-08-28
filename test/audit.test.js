import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../src/lib/audit.js";
import { loadAttention } from "../src/lib/attention.js";
import { loadLearning, proposeLearning } from "../src/lib/learning.js";

test("ten-point audit passes a healthy spine without source writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await mkdir(join(root, "memory"));
  await writeFile(join(root, "CLAUDE.md"), "# Rules\n\nSee [memory](MEMORY.md).\n", "utf8");
  await writeFile(join(root, "MEMORY.md"), "# Memory\n\nSee [fact](memory/fact.md).\n", "utf8");
  await writeFile(join(root, "memory", "fact.md"), "# Fact\n", "utf8");
  const result = await runAudit(root);
  assert.equal(result.total, 10);
  assert.equal(result.passed, 10);
  assert.equal(result.ok, true);
  assert.equal(result.gates[9].name, "Byte preservation");
});

test("ten-point audit fails visibly on a broken local Markdown link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-broken-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-broken-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n\n[Missing](not-here.md)\n", "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Link integrity").ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Byte preservation").ok, true);
});

test("ten-point audit rejects invalid external attention policy without touching sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-attention-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-attention-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "SOUL.md"), "# Soul\n", "utf8");
  const loaded = await loadAttention(root);
  loaded.attention.config.maxItems = 999;
  await writeFile(loaded.attentionPath, `${JSON.stringify(loaded.attention)}\n`, "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Byte preservation").ok, true);
});

test("ten-point audit rejects accepted learning without review proof while preserving sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-learning-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-learning-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "SOUL.md"), "# Soul\n", "utf8");
  await proposeLearning({
    root, id: "learning:corrupt", kind: "project-fact", claim: "The synthetic project is healthy.",
    evidence: { id: "evidence:corrupt", type: "test", summary: "Synthetic test.", confidence: 1 }
  });
  const loaded = await loadLearning(root);
  loaded.learning.candidates[0].status = "accepted";
  loaded.learning.candidates[0].acceptedAt = new Date().toISOString();
  await writeFile(loaded.learningPath, `${JSON.stringify(loaded.learning)}\n`, "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Byte preservation").ok, true);
});

test("ten-point audit reports malformed learning state instead of overwriting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-learning-corrupt-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-learning-corrupt-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  const loaded = await loadLearning(root);
  const corrupt = "{\"schema\":\"wrong\"}";
  await writeFile(loaded.learningPath, corrupt, "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(await readFile(loaded.learningPath, "utf8"), corrupt);
});
