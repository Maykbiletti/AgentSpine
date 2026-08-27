import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog } from "../src/lib/catalog.js";
import { resolveContext } from "../src/lib/context.js";

test("large Markdown trees stay deterministic and inside the context budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentspine-scale-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-scale-state-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => { await rm(root, { recursive: true }); await rm(state, { recursive: true }); });
  await mkdir(join(root, "memory", "facts"), { recursive: true });
  const count = 256;
  await Promise.all(Array.from({ length: count }, (_, index) => {
    const name = `fact-${String(index).padStart(3, "0")}.md`;
    return writeFile(join(root, "memory", "facts", name), `# Fact ${index}\n\nSynthetic value ${index}.\n`, "utf8");
  }));
  await writeFile(join(root, "MEMORY.md"), "# Memory\n\n[fact](memory/facts/fact-255.md)\n", "utf8");
  const before = await readFile(join(root, "MEMORY.md"));
  const catalog = await buildCatalog(root);
  assert.equal(catalog.summary.total, count + 1);
  const secondCatalog = await buildCatalog(root);
  assert.deepEqual(catalog.documents.map((document) => document.relativePath), secondCatalog.documents.map((document) => document.relativePath));
  const context = await resolveContext({ root, host: "generic", maxBytes: 1024, catalog });
  const loaded = context.documents.filter((document) => document.loaded).reduce((sum, document) => sum + document.bytes, 0);
  assert.ok(loaded <= 1024);
  assert.deepEqual(await readFile(join(root, "MEMORY.md")), before);
});
