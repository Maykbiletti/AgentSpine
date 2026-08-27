import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scanAndSave, verifyCatalog } from "../src/lib/catalog.js";
import { readDocument, resolveContext } from "../src/lib/context.js";
import { annotateDocument, linkDocuments } from "../src/lib/graph.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentspine-test-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  await mkdir(join(root, "memory", "user"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "# Rules\n\nLoad [memory](MEMORY.md).\n", "utf8");
  await writeFile(join(root, "AGENTS.md"), "# Agent rules\n\nKeep sources unchanged.\n", "utf8");
  await writeFile(join(root, "SOUL.md"), "# Soul\n\nCurious, direct, and kind.\n", "utf8");
  await writeFile(join(root, "MEMORY.md"), "# Index\n\n- [Preference](memory/user/preference.md)\n", "utf8");
  await writeFile(join(root, "memory", "user", "preference.md"), "# Preference\n\nPrefers concise updates.\n", "utf8");
  await writeFile(join(root, "notes.md"), "# Notes\n\nUnrelated.\n", "utf8");
  return { root, state };
}

async function snapshot(root) {
  const files = ["CLAUDE.md", "AGENTS.md", "SOUL.md", "MEMORY.md", "memory/user/preference.md", "notes.md"];
  return Object.fromEntries(await Promise.all(files.map(async (path) => {
    const value = await readFile(join(root, path));
    return [path, createHash("sha256").update(value).digest("hex")];
  })));
}

test("scan, resolution, graph learning, and verification preserve every source byte", async (t) => {
  const { root, state } = await fixture();
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  const before = await snapshot(root);

  const { catalog } = await scanAndSave(root);
  assert.equal(catalog.summary.total, 6);
  assert.equal(Array.isArray(catalog.conflicts), true);
  assert.equal(catalog.documents.find((doc) => doc.relativePath === "memory/user/preference.md").protected, true);
  assert.equal(catalog.documents.find((doc) => doc.relativePath === "notes.md").protected, false);

  const context = await resolveContext({ root, cwd: root, host: "claude" });
  assert.deepEqual(context.documents.map((doc) => doc.relativePath), [
    "CLAUDE.md", "SOUL.md", "MEMORY.md", "memory/user/preference.md"
  ]);

  await annotateDocument({ root, path: "notes.md", layer: "project-reference", reason: "Agent inspected its content", confidence: 0.8 });
  await linkDocuments({ root, from: "MEMORY.md", to: "notes.md", relation: "related", reason: "Index context", confidence: 0.7 });
  const learned = await resolveContext({ root, cwd: root, host: "claude" });
  assert.equal(learned.documents.some((doc) => doc.relativePath === "notes.md"), true);
  assert.equal(learned.graph.edges[0].authority, "context-only");

  await annotateDocument({ root, path: "notes.md", layer: "soul", reason: "Agent recognized an unconventional soul filename", confidence: 0.9 });
  const inferred = await resolveContext({ root, cwd: root, host: "codex" });
  assert.equal(inferred.documents.some((doc) => doc.relativePath === "notes.md"), true);

  const range = await readDocument({ root, path: "memory/user/preference.md", offset: 0, length: 12 });
  assert.equal(range.content, "# Preference");
  assert.equal(Buffer.from(range.contentBase64, "base64").toString("utf8"), "# Preference");
  assert.equal(range.eof, false);

  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(await verifyCatalog(root), {
    ok: true, reason: "compared", added: [], removed: [], changed: [],
    catalogPath: (await scanAndSave(root)).catalogPath
  });
});

test("catalog exposes broken links and native precedence without editing either file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-conflict-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-conflict-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await writeFile(join(root, "AGENTS.md"), "# Base\n\n[Missing](missing.md)\n", "utf8");
  await writeFile(join(root, "AGENTS.override.md"), "# Override\n", "utf8");
  const before = await Promise.all(["AGENTS.md", "AGENTS.override.md"].map((name) => readFile(join(root, name), "utf8")));
  const { catalog } = await scanAndSave(root);
  assert.equal(catalog.conflicts.some((item) => item.type === "broken-link"), true);
  assert.equal(catalog.conflicts.some((item) => item.type === "native-precedence"), true);
  const after = await Promise.all(["AGENTS.md", "AGENTS.override.md"].map((name) => readFile(join(root, name), "utf8")));
  assert.deepEqual(after, before);
});

test("verify reports changes and never restores them", async (t) => {
  const { root, state } = await fixture();
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await scanAndSave(root);
  await writeFile(join(root, "SOUL.md"), "# Soul\n\nChanged by the file owner.\n", "utf8");
  const result = await verifyCatalog(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ["SOUL.md"]);
  assert.match(await readFile(join(root, "SOUL.md"), "utf8"), /Changed by the file owner/);
});

test("agent annotations cannot promote arbitrary Markdown to host authority", async (t) => {
  const { root, state } = await fixture();
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await assert.rejects(
    annotateDocument({ root, path: "notes.md", layer: "constitution", reason: "Untrusted claim", confidence: 1 }),
    /unsupported context-only layer/
  );
});
