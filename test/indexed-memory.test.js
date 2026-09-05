import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { scanIndexedMemoryOrphans } from "../src/lib/indexed-memory-offline.js";
import {
  bindSourceRoot, purgeSourceBinding, resolveHostSourceCatalog, rollbackSourceBinding
} from "../src/lib/source-roots.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

async function fixture(t, name = "agentspine-indexed-memory-hardening-") {
  const workspace = await mkdtemp(join(tmpdir(), name));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const sessionDir = join(profile, "projects", "project-a");
  const session = join(sessionDir, "session.jsonl");
  const memory = join(sessionDir, "memory");
  await Promise.all([mkdir(state), mkdir(project), mkdir(memory, { recursive: true })]);
  await mkdir(join(project, ".git"));
  await writeFile(session, "{}\n", "utf8");
  const previous = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(async () => {
    if (previous.state === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = previous.state;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  });
  return { workspace, state, profile, project, session, memory };
}

async function createMany(directory, count) {
  await mkdir(directory, { recursive: true });
  const batch = 250;
  for (let offset = 0; offset < count; offset += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, count - offset) }, (_, index) =>
      writeFile(join(directory, `unused-${String(offset + index).padStart(5, "0")}.md`), "", "utf8")));
  }
}

test("50,000 unindexed files never enter the live hook path and cache work scales with relevant links", async (t) => {
  const { project, session, memory } = await fixture(t);
  const facts = join(memory, "facts");
  await mkdir(facts);
  const content = new Map([
    ["always.md", "# Always\n\nHuman, calm answers.\n"],
    ["project.md", "# Project\n\nProject Alpha only.\n"],
    ["group.md", "# Group\n\nGroup Alpha only.\n"],
    ["person.md", "# Person\n\nPerson Owner only.\n"],
    ["prompt.md", "# Prompt\n\nCarbonara preference.\n"],
    ["hidden.md", "# Hidden\n\nMust remain lazy.\n"],
    ["nested.md", "# Nested\n\nMust never load transitively.\n"]
  ]);
  for (const [name, value] of content) await writeFile(join(facts, name), value, "utf8");
  await writeFile(join(facts, "always.md"), `${content.get("always.md")}\n[Nested](nested.md)\n`, "utf8");
  const index = join(memory, "MEMORY.md");
  await writeFile(index, [
    "# Indexed memory", "",
    "- [Communication](facts/always.md) <!-- agentspine:always -->",
    "- [Alpha project](facts/project.md) <!-- agentspine:project=project:alpha -->",
    "- [Alpha group](facts/group.md) <!-- agentspine:group=group:alpha -->",
    "- [Owner](facts/person.md) <!-- agentspine:entity=person:owner -->",
    "- [Pasta](facts/prompt.md) <!-- agentspine:keywords=carbonara -->",
    "- [Hidden](facts/hidden.md)", "", "```markdown",
    "[Example only](facts/nested.md) <!-- agentspine:always -->", "```", ""
  ].join("\n"), "utf8");
  await createMany(join(memory, "orphans"), 50000);
  const liveImplementation = await readFile(new URL("../src/lib/indexed-memory.js", import.meta.url), "utf8");
  assert.doesNotMatch(liveImplementation, /\b(?:opendir|readdir|walk)\b/, "live indexed memory must have no directory enumeration primitive");

  const before = new Map(await Promise.all([index, ...[...content.keys()].map((name) => join(facts, name))]
    .map(async (path) => [path, hash(await readFile(path))])));
  const opened = [];
  const input = {
    transcript_path: session, prompt: "Bitte ein Carbonara-Rezept.",
    agent_spine_scope: { entity_id: "person:owner", project_id: "project:alpha", group_id: "group:alpha" }
  };
  const first = await resolveHostSourceCatalog({
    host: "claude", cwd: project, input, memoryHooks: { onOpen: ({ relativePath }) => opened.push(relativePath) }
  });
  const memoryIds = first.catalog.documents.filter((item) => item.sourceScope === "project-memory").map((item) => item.relativePath);
  assert.deepEqual(memoryIds, [
    "claude:memory/MEMORY.md", "claude:memory/facts/always.md", "claude:memory/facts/project.md",
    "claude:memory/facts/group.md", "claude:memory/facts/person.md", "claude:memory/facts/prompt.md"
  ]);
  assert.ok(!memoryIds.some((id) => id.includes("hidden") || id.includes("nested") || id.includes("unused")));
  assert.equal(first.diagnostics.memory.directoryEnumeration, 0);
  assert.equal(first.diagnostics.memory.indexed, 6);
  assert.equal(first.diagnostics.memory.relevant, 5);
  assert.equal(first.diagnostics.memory.loaded, 5);
  assert.equal(opened.length, 7, "only MEMORY.md twice and five relevant direct links may be opened");

  const secondOpened = [];
  const second = await resolveHostSourceCatalog({
    host: "claude", cwd: project, input,
    memoryHooks: { onOpen: ({ relativePath }) => secondOpened.push(relativePath) }
  });
  assert.equal(second.diagnostics.memory.cacheHits, 6);
  assert.equal(second.diagnostics.memory.cacheMisses, 0);
  assert.equal(secondOpened.length, 7);

  const isolated = await resolveHostSourceCatalog({
    host: "claude", cwd: project,
    input: { transcript_path: session, agent_spine_scope: { entity_id: "person:other", project_id: "project:other", group_id: "group:beta" } }
  });
  assert.deepEqual(isolated.catalog.documents.filter((item) => item.sourceScope === "project-memory").map((item) => item.relativePath),
    ["claude:memory/MEMORY.md", "claude:memory/facts/always.md"]);

  const restarted = JSON.parse((await runHook({ hook_event_name: "SessionStart", host: "claude", cwd: project,
    transcript_path: session, prompt: input.prompt })).context);
  const compacted = JSON.parse((await runHook({ hook_event_name: "PostCompact", host: "claude", cwd: project,
    prompt: input.prompt })).context);
  assert.deepEqual(restarted.briefing.sources.documents.map((item) => item.path), compacted.briefing.sources.documents.map((item) => item.path));
  assert.equal(restarted.sourceResolution.memory.directoryEnumeration, 0);
  const offline = await scanIndexedMemoryOrphans(memory);
  assert.equal(offline.mode, "explicit-offline-doctor-scan");
  assert.equal(offline.orphaned, 50001, "nested and 50,000 unindexed files are visible only offline");
  assert.equal(offline.contentsExposed, false);
  for (const [path, expected] of before) assert.equal(hash(await readFile(path)), expected);
});

test("cache invalidates on correction, deletion, link removal, restart, and compaction", async (t) => {
  const { project, session, memory } = await fixture(t);
  const fact = join(memory, "fact.md");
  const index = join(memory, "MEMORY.md");
  const indexed = "# Memory\n\n[Fact](fact.md) <!-- agentspine:always -->\n";
  await writeFile(index, indexed, "utf8");
  await writeFile(fact, "# Fact\n\nVersion one.\n", "utf8");
  const input = { transcript_path: session };
  const first = await resolveHostSourceCatalog({ host: "claude", cwd: project, input });
  assert.equal(first.diagnostics.memory.cacheMisses, 2);
  const hit = await resolveHostSourceCatalog({ host: "claude", cwd: project, input });
  assert.equal(hit.diagnostics.memory.cacheHits, 2);

  await writeFile(fact, "# Fact\n\nVersion two.\n", "utf8");
  const corrected = await resolveHostSourceCatalog({ host: "claude", cwd: project, input });
  assert.equal(corrected.diagnostics.memory.cacheMisses, 1);
  assert.equal(corrected.catalog.documents.find((item) => item.relativePath.endsWith("fact.md")).sha256,
    hash(await readFile(fact)));

  await writeFile(index, "# Memory\n", "utf8");
  const removed = await resolveHostSourceCatalog({ host: "claude", cwd: project, input });
  assert.deepEqual(removed.catalog.documents.filter((item) => item.sourceScope === "project-memory").map((item) => item.relativePath),
    ["claude:memory/MEMORY.md"]);
  await writeFile(index, indexed, "utf8");
  const readded = await resolveHostSourceCatalog({ host: "claude", cwd: project, input });
  assert.equal(readded.diagnostics.memory.cacheMisses, 2, "removed links must also be purged from cache");

  await unlink(fact);
  const deleted = await resolveHostSourceCatalog({ host: "claude", cwd: project, input });
  assert.equal(deleted.diagnostics.memory.missing, 1);
  assert.deepEqual(deleted.catalog.documents.filter((item) => item.sourceScope === "project-memory").map((item) => item.relativePath),
    ["claude:memory/MEMORY.md"]);
  const compacted = JSON.parse((await runHook({ hook_event_name: "PostCompact", host: "claude", cwd: project })).context);
  assert.equal(compacted.briefing.sources.documents.some((item) => item.path.endsWith("fact.md")), false);
});

test("missing, escaping, symlinked, and racing targets are rejected with private diagnostics", async (t) => {
  const { workspace, project, session, memory } = await fixture(t);
  const directory = join(memory, "facts");
  await mkdir(directory);
  const stable = join(directory, "stable.md");
  const racing = join(directory, "racing.md");
  const outside = join(workspace, "outside.md");
  await writeFile(stable, "# Stable\n", "utf8");
  await writeFile(racing, "# Racing\n", "utf8");
  await writeFile(outside, "# Outside\n", "utf8");
  const lines = [
    "# Memory", "", "[Stable](facts/stable.md) <!-- agentspine:always -->",
    "[Missing](facts/missing.md) <!-- agentspine:always -->",
    "[Escape](../../../outside.md) <!-- agentspine:always -->",
    "[Race](facts/racing.md) <!-- agentspine:always -->"
  ];
  let symlinkCount = 0;
  try {
    await symlink(outside, join(memory, "file-link.md"));
    await symlink(directory, join(memory, "dir-link"), process.platform === "win32" ? "junction" : "dir");
    lines.push("[File link](file-link.md) <!-- agentspine:always -->", "[Parent link](dir-link/stable.md) <!-- agentspine:always -->");
    symlinkCount = 2;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  await writeFile(join(memory, "MEMORY.md"), `${lines.join("\n")}\n`, "utf8");
  const result = await resolveHostSourceCatalog({
    host: "claude", cwd: project, input: { transcript_path: session },
    memoryHooks: { afterRead: async ({ relativePath }) => {
      if (relativePath === "facts/racing.md") await appendFile(racing, "changed\n", "utf8");
    } }
  });
  assert.equal(result.diagnostics.memory.missing, 1);
  assert.equal(result.diagnostics.memory.rejected.path, 1);
  assert.equal(result.diagnostics.memory.rejected.symlink, symlinkCount);
  assert.equal(result.diagnostics.memory.rejected.race, 1);
  assert.equal(result.catalog.documents.some((item) => item.relativePath.includes("racing")), false);
  assert.equal(JSON.stringify(result.diagnostics.memory).includes(workspace), false, "memory diagnostics must not expose private absolute paths");
});

test("parallel live resolutions serialize cache updates without mixed snapshots", async (t) => {
  const { project, session, memory } = await fixture(t);
  await writeFile(join(memory, "MEMORY.md"), "# Memory\n\n[Fact](fact.md) <!-- agentspine:always -->\n", "utf8");
  await writeFile(join(memory, "fact.md"), "# Fact\n\nParallel-safe.\n", "utf8");
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    resolveHostSourceCatalog({ host: "claude", cwd: project, input: { transcript_path: session } })));
  const signatures = new Set(results.map((result) => JSON.stringify(result.catalog.documents
    .filter((item) => item.sourceScope === "project-memory").map((item) => [item.relativePath, item.sha256]))));
  assert.equal(signatures.size, 1);
  assert.ok(results.every((result) => result.diagnostics.memory.loaded === 1));
});

test("project-memory binding rollback and purge remove cached snapshots immediately", async (t) => {
  const { state, profile, project, memory } = await fixture(t);
  await writeFile(join(memory, "MEMORY.md"), "# Memory\n\n[Fact](fact.md) <!-- agentspine:always -->\n", "utf8");
  await writeFile(join(memory, "fact.md"), "# Fact\n\nRemove this cached snapshot.\n", "utf8");
  const bind = () => bindSourceRoot({
    host: "claude", hostHome: profile, projectRoot: project, sourceRoot: memory,
    scope: "project-memory", confirmation: "local-user-confirmed"
  });
  const first = await bind();
  await resolveHostSourceCatalog({ host: "claude", cwd: project });
  let cache = JSON.parse(await readFile(join(state, "indexed-memory-cache.json"), "utf8"));
  assert.equal(Object.keys(cache.roots).length, 1);
  await rollbackSourceBinding({ id: first.binding.id, confirmation: "local-user-confirmed" });
  cache = JSON.parse(await readFile(join(state, "indexed-memory-cache.json"), "utf8"));
  assert.equal(Object.keys(cache.roots).length, 0);

  const second = await bind();
  await resolveHostSourceCatalog({ host: "claude", cwd: project });
  await purgeSourceBinding({ id: second.binding.id, confirmation: "local-user-confirmed" });
  cache = JSON.parse(await readFile(join(state, "indexed-memory-cache.json"), "utf8"));
  assert.equal(Object.keys(cache.roots).length, 0);
});

test("an index beyond 4,096 direct links fails closed before any fact target is opened", async (t) => {
  const { project, session, memory } = await fixture(t);
  const links = Array.from({ length: 4097 }, (_, index) =>
    `[Fact ${index}](fact-${index}.md) <!-- agentspine:always -->`);
  await writeFile(join(memory, "MEMORY.md"), `# Memory\n\n${links.join("\n")}\n`, "utf8");
  const opened = [];
  await assert.rejects(resolveHostSourceCatalog({
    host: "claude", cwd: project, input: { transcript_path: session },
    memoryHooks: { onOpen: ({ relativePath }) => opened.push(relativePath) }
  }), /indexes more than 4096 direct files/);
  assert.deepEqual(opened, ["MEMORY.md"]);
});
