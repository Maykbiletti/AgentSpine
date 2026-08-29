import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { runAudit } from "../src/lib/audit.js";
import { configureContinuity } from "../src/lib/continuity.js";
import { upsertEntity } from "../src/lib/graph.js";
import { createTask } from "../src/lib/coordination.js";
import {
  bindSourceRoot, inspectSourceRegistry, purgeSourceBinding, resolveHostSourceCatalog,
  rollbackSourceBinding
} from "../src/lib/source-roots.js";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function packet(result) { return JSON.parse(result.context); }

test("installed lifecycle resolves host-native user, project, and memory roots without cwd coupling or broad home scans", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-live-roots-"));
  const state = join(workspace, "state");
  const home = join(workspace, "home");
  const claudeHome = join(home, ".claude-profile");
  const codexHome = join(home, ".codex-profile");
  const projectA = join(home, "AgentSpine");
  const projectB = join(home, "foreign-project");
  const nestedB = join(projectB, "services", "api");
  const loose = join(workspace, "unrelated-cwd");
  const portableState = join(workspace, "portable-user-state");
  for (const path of [state, claudeHome, codexHome, projectA, nestedB, loose, portableState,
    join(claudeHome, "projects", "project-a", "memory")]) await mkdir(path, { recursive: true });
  await mkdir(join(projectA, ".git"));
  await mkdir(join(projectB, ".git"));
  await mkdir(join(projectA, ".private-notes"));
  await mkdir(join(projectA, "vendor-repository", ".git"), { recursive: true });

  const files = new Map([
    [join(claudeHome, "CLAUDE.md"), "# User style\n\nUse calm, humane language.\n"],
    [join(projectA, "CLAUDE.md"), "# AgentSpine project\n\nProject A only.\n"],
    [join(projectB, "CLAUDE.md"), "# Foreign project\n\nProject B only.\n"],
    [join(claudeHome, "projects", "project-a", "memory", "MEMORY.md"), "# Memory\n\nProject A continuity only.\n"],
    [join(codexHome, "AGENTS.override.md"), "# Global Codex\n\nUse calm, humane language.\n"],
    [join(projectA, "AGENTS.md"), "# Codex A\n\nProject A only.\n"],
    [join(projectB, "TEAM_GUIDE.md"), "# Codex B\n\nProject B root.\n"],
    [join(nestedB, "AGENTS.override.md"), "# Codex B API\n\nNested API wins here.\n"],
    [join(home, "PRIVATE.md"), "# Must never be scanned\n"],
    [join(projectA, ".private-notes", "HIDDEN.md"), "# Hidden project material must never be scanned\n"],
    [join(projectA, "vendor-repository", "FOREIGN.md"), "# Embedded repository must never be scanned\n"],
    [join(loose, "CLAUDE.md"), "# Loose project only\n"]
  ]);
  for (const [path, content] of files) await writeFile(path, content, "utf8");
  await writeFile(join(claudeHome, "projects", "project-a", "session.jsonl"), "{}\n", "utf8");
  await writeFile(join(codexHome, "config.toml"), [
    'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]',
    'project_root_markers = [".git"]',
    "project_doc_max_bytes = 65536",
    ""
  ].join("\n"), "utf8");
  const link = join(projectA, "linked-secret.md");
  try {
    await symlink(join(home, "PRIVATE.md"), link);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
  }

  const previous = Object.fromEntries(["AGENTSPINE_STATE_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTSPINE_ROOT", "HOME"]
    .map((key) => [key, process.env[key]]));
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = home;
  delete process.env.AGENTSPINE_ROOT;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  await upsertEntity({ root: portableState, id: "person:owner", kind: "person", privacy: "private" });
  await upsertEntity({ root: portableState, id: "project:portable", kind: "project", privacy: "private" });
  await createTask({ root: portableState, id: "task:must-not-port", actorId: "person:owner",
    projectId: "project:portable", title: "Private task must remain in its original project", privacy: "private" });
  await configureContinuity({ root: portableState,
    config: { enabled: true, defaultEntityId: "person:owner" }, confirmation: "local-user-opt-in" });
  const binding = await bindSourceRoot({ host: "all", hostHome: portableState, projectRoot: projectA,
    sourceRoot: portableState, scope: "state-user", confirmation: "local-user-confirmed" });

  const before = Object.fromEntries(await Promise.all([...files.keys()].map(async (path) => [path, hash(await readFile(path))])));
  const learned = await runHook({ hook_event_name: "UserPromptSubmit", host: "claude", cwd: projectA,
    transcript_path: join(claudeHome, "projects", "project-a", "session.jsonl"), event_id: "live-root:style",
    prompt: "Bitte antworte immer menschlich und ruhig." });
  assert.ok(learned.signal, learned.error || learned.context);
  assert.equal(learned.signal.accepted, true);
  assert.equal(packet(learned).briefing.learning[0].claim, "Response preference: menschlich und ruhig");

  const claudeA = packet(await runHook({ hook_event_name: "SessionStart", host: "claude", cwd: projectA }));
  const claudeLoose = packet(await runHook({ hook_event_name: "PostCompact", host: "claude", cwd: loose }));
  const idsA = claudeA.briefing.sources.documents.map((item) => item.path);
  const idsLoose = claudeLoose.briefing.sources.documents.map((item) => item.path);
  assert.ok(idsA.includes("claude:user/CLAUDE.md"));
  assert.ok(idsA.includes("claude:project/CLAUDE.md"));
  assert.ok(idsA.includes("claude:memory/MEMORY.md"));
  assert.ok(!idsA.some((id) => id.includes("PRIVATE")));
  assert.ok(!idsA.some((id) => id.includes("HIDDEN") || id.includes("FOREIGN")));
  assert.ok(idsLoose.includes("claude:user/CLAUDE.md"));
  assert.ok(idsLoose.includes("claude:project/CLAUDE.md"));
  assert.ok(!idsLoose.some((id) => id.startsWith("claude:memory/")));
  assert.equal(claudeA.briefing.learning[0].claim, claudeLoose.briefing.learning[0].claim);
  assert.equal(claudeA.briefing.tasks.some((item) => item.id === "task:must-not-port"), false);
  assert.equal(claudeA.sourceResolution.broadHomeScan, false);
  assert.equal(claudeA.sourceResolution.memoryProvenance, "source-root-registry");

  const codexA = packet(await runHook({ hook_event_name: "SessionStart", host: "codex", cwd: projectA }));
  const codexB = packet(await runHook({ hook_event_name: "PostCompact", host: "codex", cwd: nestedB }));
  const codexAIds = codexA.briefing.sources.documents.map((item) => item.path);
  const codexBIds = codexB.briefing.sources.documents.map((item) => item.path);
  assert.deepEqual(codexAIds.filter((id) => id.startsWith("codex:")), ["codex:user/AGENTS.override.md", "codex:project/AGENTS.md"]);
  assert.deepEqual(codexBIds.filter((id) => id.startsWith("codex:")), [
    "codex:user/AGENTS.override.md", "codex:project/TEAM_GUIDE.md", "codex:project/services/api/AGENTS.override.md"
  ]);
  assert.equal(codexA.briefing.learning[0].claim, claudeA.briefing.learning[0].claim);
  assert.ok(!JSON.stringify(codexB).includes("Project A only"));

  const homeResolution = await resolveHostSourceCatalog({ host: "claude", cwd: home, input: {} });
  assert.equal(homeResolution.diagnostics.broadHomeScan, false);
  assert.ok(!homeResolution.catalog.documents.some((item) => item.path === join(home, "PRIVATE.md")));

  for (const [path, expected] of Object.entries(before)) assert.equal(hash(await readFile(path)), expected);
  const registry = await inspectSourceRegistry();
  assert.ok(registry.registry.bindings.some((item) => item.scope === "project-memory" && item.provenance === "host-hook-transcript"));
  assert.ok(registry.registry.bindings.some((item) => item.id === binding.binding.id && item.projectRoot === "*"));
  const conflictingState = join(workspace, "conflicting-user-state");
  await mkdir(conflictingState);
  await assert.rejects(bindSourceRoot({ host: "all", hostHome: conflictingState, projectRoot: projectB,
    sourceRoot: conflictingState, scope: "state-user", confirmation: "local-user-confirmed" }), /conflicting all state-user source binding/);
  await rollbackSourceBinding({ id: binding.binding.id, confirmation: "local-user-confirmed" });
  assert.equal((await inspectSourceRegistry()).registry.bindings.find((item) => item.id === binding.binding.id).active, false);
  await purgeSourceBinding({ id: binding.binding.id, confirmation: "local-user-confirmed" });
  assert.equal((await inspectSourceRegistry()).registry.bindings.some((item) => item.id === binding.binding.id), false);
});

test("empty host roots are visible and never reported as loaded continuity", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-empty-roots-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const cwd = join(workspace, "cwd");
  await Promise.all([mkdir(state), mkdir(profile), mkdir(cwd)]);
  const previous = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(async () => {
    if (previous.state === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = previous.state;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    await rm(workspace, { recursive: true, force: true });
  });
  const result = packet(await runHook({ hook_event_name: "SessionStart", host: "claude", cwd }));
  assert.equal(result.indexedSources, 0);
  assert.equal(result.sourceResolution.status, "empty");
  assert.match(result.sourceResolution.reason, /No regular/);
  assert.equal(result.sourceResolution.broadHomeScan, false);
  const audit = await runAudit(cwd, { host: "claude" });
  assert.equal(audit.ok, false);
  assert.equal(audit.sourceResolution.status, "empty");
  assert.match(audit.gates[1].detail, /0 user/);
  await writeFile(join(state, "source-roots.json"), `${JSON.stringify({
    schema: "agentspine.source-roots/v1", revision: 1,
    bindings: [{ id: "binding:forged", host: "claude", profileKey: "claude:forged", projectRoot: cwd,
      sourceRoot: cwd, scope: "state-user", provenance: "conversation", active: true, authority: "host-authority" }],
    history: []
  })}\n`, "utf8");
  const damaged = await runHook({ hook_event_name: "SessionStart", host: "claude", cwd });
  assert.equal(damaged.failedClosed, true);
  assert.match(damaged.error, /unsafe binding/);
  const denied = await runHook({ hook_event_name: "PreToolUse", host: "claude", cwd,
    tool_name: "Write", tool_input: { file_path: join(cwd, "output.txt") } });
  assert.equal(denied.blocked, true);
  assert.match(denied.reason, /source resolution failed closed/);
});

test("Claude project memory loads only files indexed by MEMORY.md", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-indexed-memory-"));
  const state = join(workspace, "state");
  const profile = join(workspace, "profile");
  const project = join(workspace, "project");
  const session = join(profile, "projects", "project", "session.jsonl");
  const memory = join(profile, "projects", "project", "memory");
  const facts = join(memory, "facts");
  await Promise.all([mkdir(state), mkdir(project), mkdir(facts, { recursive: true })]);
  await mkdir(join(project, ".git"));
  await writeFile(session, "{}\n", "utf8");
  const index = join(memory, "MEMORY.md");
  const linked = join(facts, "linked.md");
  const unindexed = join(facts, "unindexed.md");
  await writeFile(index, [
    "# Memory", "", "[Linked fact](facts/linked.md) <!-- agentspine:always -->", "[Missing fact](facts/missing.md) <!-- agentspine:always -->",
    "[Outside](../../../../outside.md) <!-- agentspine:always -->", ""
  ].join("\n"), "utf8");
  await writeFile(linked, "# Linked\n\nLoad this fact.\n", "utf8");
  await writeFile(unindexed, "# Unindexed\n\nNever load this fact.\n", "utf8");
  await Promise.all(Array.from({ length: 256 }, (_, number) => writeFile(
    join(facts, `irrelevant-${String(number).padStart(3, "0")}.md`), "", "utf8"
  )));
  const outside = join(workspace, "outside.md");
  await writeFile(outside, "# Outside\n", "utf8");
  const linkedSymlink = join(memory, "linked-symlink.md");
  try {
    await symlink(outside, linkedSymlink);
    await writeFile(index, `${await readFile(index, "utf8")}[Symlink](linked-symlink.md) <!-- agentspine:always -->\n`, "utf8");
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  const before = new Map(await Promise.all([index, linked, unindexed, outside].map(async (path) => [path, hash(await readFile(path))])));
  const previous = { state: process.env.AGENTSPINE_STATE_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.AGENTSPINE_STATE_DIR = state;
  process.env.CLAUDE_CONFIG_DIR = profile;
  t.after(async () => {
    if (previous.state === undefined) delete process.env.AGENTSPINE_STATE_DIR; else process.env.AGENTSPINE_STATE_DIR = previous.state;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    await rm(workspace, { recursive: true, force: true });
  });

  const result = await resolveHostSourceCatalog({ host: "claude", cwd: project, input: { transcript_path: session } });
  assert.deepEqual(result.catalog.documents.filter((item) => item.sourceScope === "project-memory")
    .map((item) => item.relativePath), ["claude:memory/MEMORY.md", "claude:memory/facts/linked.md"]);
  assert.equal(result.catalog.documents.some((item) => item.path === unindexed), false);
  assert.equal(result.catalog.documents.some((item) => item.path === outside), false);
  assert.equal(result.diagnostics.scopes["project-memory"], 2);
  assert.deepEqual(result.diagnostics.memory, {
    indexed: process.platform === "win32" ? 3 : 4,
    relevant: process.platform === "win32" ? 3 : 4,
    loaded: 1,
    cacheHits: 0,
    cacheMisses: 2,
    missing: 1,
    rejected: { scope: 0, path: 1, symlink: process.platform === "win32" ? 0 : 1, race: 0, size: 0 },
    directoryEnumeration: 0
  });
  for (const [path, expected] of before) assert.equal(hash(await readFile(path)), expected);
});
