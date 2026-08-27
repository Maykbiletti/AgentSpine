import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../src/lib/audit.js";

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
