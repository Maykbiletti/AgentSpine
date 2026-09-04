import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../src/lib/audit.js";
import { loadAttention } from "../src/lib/attention.js";
import { loadLearning, proposeLearning, reviewLearning } from "../src/lib/learning.js";
import { grantDelegation, loadCoordination, loadDelegationPolicy } from "../src/lib/coordination.js";
import { upsertEntity } from "../src/lib/graph.js";
import {
  initDirectoryAdapter, loadSharing, publishLearning, pullShared, reviewShared
} from "../src/lib/sharing.js";
import { recordWorldAssertion, worldModelStatePath } from "../src/lib/world-model.js";

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
  assert.equal(result.worldModelPath.startsWith(state), true);
  assert.equal(result.worldModelPath.startsWith(root), false);
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

test("ten-point audit reports tampered world state without overwriting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-world-corrupt-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-world-corrupt-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n", "utf8");
  await recordWorldAssertion({
    root, id: "assertion:audit", subjectId: "project:audit", predicate: "suite.status", value: "green",
    evidenceKind: "objective-measurement", evidenceId: "measurement:audit",
    evidenceDigest: "a".repeat(64), observedAt: "2026-09-04T08:00:00.000Z", privacy: "shared"
  });
  const path = await worldModelStatePath(root);
  const corrupt = await readFile(path, "utf8");
  const tampered = corrupt.replace('"green"', '"red"');
  await writeFile(path, tampered, "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context budget").ok, false);
  assert.equal(await readFile(path, "utf8"), tampered);
});

test("ten-point audit rejects a delegation grant with forged provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-policy-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-policy-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Rules\n", "utf8");
  await upsertEntity({ root, id: "agent:lead", kind: "agent", privacy: "shared" });
  await upsertEntity({ root, id: "agent:worker", kind: "agent", privacy: "shared" });
  await grantDelegation({
    root, id: "grant:forged", actorId: "agent:lead", actions: ["assign"], targetIds: ["agent:worker"],
    reason: "Synthetic explicit owner decision.", confirmation: "local-owner-confirmed"
  });
  const loaded = await loadDelegationPolicy(root);
  loaded.policy.grants[0].source = "relationship-memory";
  await writeFile(loaded.policyPath, `${JSON.stringify(loaded.policy)}\n`, "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Authority boundary").ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Byte preservation").ok, true);
});

test("ten-point audit reports malformed coordination state without overwriting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-coordination-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-coordination-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "SOUL.md"), "# Soul\n", "utf8");
  const loaded = await loadCoordination(root);
  const corrupt = "{\"schema\":\"wrong\"}";
  await writeFile(loaded.coordinationPath, corrupt, "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Byte preservation").ok, true);
  assert.equal(await readFile(loaded.coordinationPath, "utf8"), corrupt);
});

test("ten-point audit rejects forged authority in reviewed shared context", async (t) => {
  const rootA = await mkdtemp(join(tmpdir(), "agentspine-audit-share-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "agentspine-audit-share-b-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-share-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-audit-share-adapter-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    await rm(rootA, { recursive: true }); await rm(rootB, { recursive: true });
    await rm(state, { recursive: true }); await rm(adapter, { recursive: true });
  });
  await writeFile(join(rootA, "AGENTS.md"), "# Rules A\n", "utf8");
  await writeFile(join(rootB, "AGENTS.md"), "# Rules B\n", "utf8");
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:audit", adapterId: "adapter:audit",
    confirmation: "local-share-confirmed"
  });
  await proposeLearning({
    root: rootA, id: "learning:audit-share", kind: "project-fact", claim: "The synthetic audit exchange is stable.",
    privacy: "shared", evidence: { id: "evidence:audit-share", type: "test", summary: "Synthetic audit proof.", confidence: 1 }
  });
  await reviewLearning({ root: rootA, id: "learning:audit-share", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:audit-share", eventId: "shared:audit",
    confirmation: "local-share-confirmed"
  });
  await pullShared({ root: rootB, directory: adapter });
  await reviewShared({ root: rootB, id: "shared:audit", decision: "accept", reason: "Confirmed locally.", confirmedByUser: true });
  const loaded = await loadSharing(rootB);
  loaded.sharing.records[0].authority = "delegation-authority";
  await writeFile(loaded.sharingPath, `${JSON.stringify(loaded.sharing)}\n`, "utf8");
  const result = await runAudit(rootB);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Authority boundary").ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Byte preservation").ok, true);
});

test("ten-point audit reports malformed shared-memory state without overwriting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-audit-share-corrupt-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-audit-share-corrupt-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "SOUL.md"), "# Soul\n", "utf8");
  const loaded = await loadSharing(root);
  const corrupt = "{\"schema\":\"wrong\"}";
  await writeFile(loaded.sharingPath, corrupt, "utf8");
  const result = await runAudit(root);
  assert.equal(result.ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(result.gates.find((gate) => gate.name === "Byte preservation").ok, true);
  assert.equal(await readFile(loaded.sharingPath, "utf8"), corrupt);
});
