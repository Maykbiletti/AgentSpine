import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blunRuntimeMessage, runHook } from "../src/hook.js";
import { hookScanAuditPath } from "../src/lib/hook-audit.js";
import { auditSkippedScans, hookScanFailureFailsOpen } from "../src/lib/hook-protection.js";
import { resolveHostSourceCatalog } from "../src/lib/source-roots.js";
import { registeredWriteContext } from "./premortem-write-fixture.js";

const PROJECT_FILE_LIMIT = 240;
const PROJECT_ENTRY_LIMIT = 8192;
const HOOK_PATH = fileURLToPath(new URL("../src/hook.js", import.meta.url));
const ENV_KEYS = [
  "AGENTSPINE_ROOT", "AGENTSPINE_STATE_DIR", "BLUN_HOME", "BLUN_PLUGIN_ROOT",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "PLUGIN_ROOT", "USERPROFILE"
];

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function installEnvironment(t, values) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function writeFiles(paths, contentFor, batchSize = 256) {
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    await Promise.all(paths.slice(offset, offset + batchSize)
      .map((path, index) => writeFile(path, contentFor(offset + index), "utf8")));
  }
}

async function sourceHashes(paths) {
  return new Map(await Promise.all(paths.map(async (path) => [path, hash(await readFile(path))])));
}

async function fixture(t, name) {
  const workspace = await mkdtemp(join(tmpdir(), `agentspine-${name}-`));
  const project = join(workspace, "project");
  const profile = join(workspace, "profile");
  const state = join(workspace, "state");
  await Promise.all([
    mkdir(join(project, ".git"), { recursive: true }),
    mkdir(profile, { recursive: true }),
    mkdir(state, { recursive: true })
  ]);
  installEnvironment(t, {
    AGENTSPINE_STATE_DIR: state, CODEX_HOME: profile, HOME: workspace, USERPROFILE: workspace
  });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, project, profile, state };
}

test("project Markdown cap has deterministic before/after truncation without disabling hooks", async (t) => {
  const { project, state } = await fixture(t, "project-file-cap");
  const retained = [join(project, "000-SOUL.md"), ...Array.from({ length: PROJECT_FILE_LIMIT - 1 },
    (_, index) => join(project, `source-${String(index).padStart(3, "0")}.md`))];
  await writeFiles(retained, (index) => `# Retained ${index}\n\nUser-owned bytes.\n`);

  const before = await resolveHostSourceCatalog({ host: "codex", cwd: project, env: process.env });
  assert.equal(before.catalog.documents.length, PROJECT_FILE_LIMIT);
  assert.equal(before.diagnostics.projectTreeScan, "bounded");
  assert.equal(before.diagnostics.incomplete, false);
  assert.deepEqual(before.diagnostics.warnings, []);

  const overflowPath = join(project, "zzzz-overflow.md");
  await writeFile(overflowPath, "# Overflow\n\nMust remain untouched.\n", "utf8");
  const allSources = [...retained, overflowPath];
  const bytesBeforeHooks = await sourceHashes(allSources);
  const after = await resolveHostSourceCatalog({ host: "codex", cwd: project, env: process.env });
  const repeated = await resolveHostSourceCatalog({ host: "codex", cwd: project, env: process.env });
  const paths = after.catalog.documents.map((item) => item.relativePath);
  assert.equal(after.diagnostics.status, "loaded");
  assert.equal(after.diagnostics.projectTreeScan, "bounded-truncated");
  assert.equal(after.diagnostics.incomplete, true);
  assert.match(after.diagnostics.warning, /context is incomplete.*remaining files were skipped/i);
  assert.deepEqual(after.catalog.documents.map((item) => item.relativePath),
    repeated.catalog.documents.map((item) => item.relativePath));
  assert.equal(paths.length, PROJECT_FILE_LIMIT);
  assert.ok(paths.includes("agentspine:project/000-SOUL.md"));
  assert.ok(paths.includes("agentspine:project/source-238.md"));
  assert.ok(!paths.includes("agentspine:project/zzzz-overflow.md"));
  const warning = after.diagnostics.warnings.find((item) => item.operation === "file-limit");
  assert.deepEqual({ code: warning?.code, limit: warning?.limit, retained: warning?.retained }, {
    code: "AGENTSPINE_SCAN_INCOMPLETE", limit: PROJECT_FILE_LIMIT, retained: PROJECT_FILE_LIMIT
  });
  assert.equal(hookScanFailureFailsOpen({ code: warning.code }), true);

  const session = await runHook({ hook_event_name: "SessionStart", host: "codex", cwd: project });
  assert.equal(session.blocked, false);
  const context = JSON.parse(session.context);
  assert.equal(context.sourceResolution.projectTreeScan, "bounded-truncated");
  assert.match(context.sourceResolution.warning, /remaining files were skipped/i);
  assert.match(blunRuntimeMessage(session.context), /Warning: .*context is incomplete.*remaining files were skipped/i);

  const toolCases = [
    ["Write", { file_path: "allowed-output.txt", content: "allowed\n" }],
    ["Edit", { file_path: "allowed-output.txt", old_string: "old", new_string: "new" }],
    ["Bash", { command: "pwd" }]
  ];
  for (const [toolName, toolInput] of toolCases) {
    const scope = await registeredWriteContext({
      root: project, sessionId: `session:project-cap:${toolName}`, projectId: "project:source-cap"
    });
    const result = await runHook({
      ...scope, hook_event_name: "PreToolUse", tool_use_id: `tool:project-cap:${toolName}`,
      tool_name: toolName, tool_input: toolInput
    });
    assert.equal(result.blocked, false, `${toolName}: ${result.reason || result.error || "blocked"}`);
    assert.notEqual(result.failedClosed, true, toolName);
    assert.match(result.sourceWarning, /context is incomplete.*remaining files were skipped/i, toolName);
  }

  const installed = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: project, env: process.env, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", host: "codex", cwd: project,
      tool_name: "Bash", tool_input: { command: "pwd" } })
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(JSON.parse(installed.stdout).hookSpecificOutput.additionalContext,
    /AgentSpine source warning: .*context is incomplete.*remaining files were skipped/i);

  const protectedWrite = await runHook({
    hook_event_name: "PreToolUse", host: "codex", cwd: project, tool_name: "Write",
    tool_input: { file_path: join(project, "000-SOUL.md"), content: "replacement" }
  });
  assert.equal(protectedWrite.blocked, true);
  assert.match(protectedWrite.reason, /protected source/i);

  await auditSkippedScans({ tool_name: "PriorityProbe", cwd: project }, "source-resolution", [
    { path: "/000-prior-skip", code: "EACCES", operation: "opendir" }, warning
  ]);

  const audit = (await readFile(hookScanAuditPath({ ...process.env, AGENTSPINE_STATE_DIR: state }), "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  const auditedTools = new Set(audit.filter((item) => item.code === "AGENTSPINE_SCAN_INCOMPLETE"
    && item.phase === "source-resolution" && item.decision === "allow").map((item) => item.toolName));
  for (const toolName of ["Write", "Edit", "Bash"]) assert.ok(auditedTools.has(toolName), toolName);
  assert.ok(audit.some((item) => item.toolName === "PriorityProbe" && item.code === "AGENTSPINE_SCAN_INCOMPLETE"));
  for (const [path, expected] of bytesBeforeHooks) assert.equal(hash(await readFile(path)), expected, path);
});

test("flat project trees stop at the directory-entry bound and keep partial context", async (t) => {
  const { project } = await fixture(t, "project-entry-cap");
  const paths = Array.from({ length: PROJECT_ENTRY_LIMIT + 1 }, (_, index) =>
    join(project, `flat-${String(index).padStart(5, "0")}.md`));
  await writeFiles(paths, (index) => `# Flat ${index}\n`);
  const firstBefore = await readFile(paths[0]);
  const lastBefore = await readFile(paths.at(-1));

  const result = await resolveHostSourceCatalog({ host: "codex", cwd: project, env: process.env });
  assert.equal(result.catalog.documents.length, PROJECT_FILE_LIMIT);
  assert.equal(result.diagnostics.projectTreeScan, "bounded-truncated");
  assert.ok(result.diagnostics.warnings.some((item) =>
    item.operation === "directory-entry-limit" && item.limit === PROJECT_ENTRY_LIMIT));
  assert.ok(result.diagnostics.warnings.some((item) =>
    item.operation === "file-limit" && item.retained === PROJECT_FILE_LIMIT));
  assert.deepEqual(await readFile(paths[0]), firstBefore);
  assert.deepEqual(await readFile(paths.at(-1)), lastBefore);
});

test("optional project deadline returns bounded partial diagnostics instead of re-throwing", async (t) => {
  const { project } = await fixture(t, "project-deadline");
  const source = join(project, "source.md");
  await writeFile(source, "# Deadline source\n", "utf8");
  const before = await readFile(source);
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => calls++ < 2 ? 1_000 : 3_001;
  let result;
  try {
    result = await resolveHostSourceCatalog({ host: "codex", cwd: project, env: process.env });
  } finally {
    Date.now = realNow;
  }
  assert.equal(result.diagnostics.projectTreeScan, "bounded-truncated");
  assert.equal(result.diagnostics.incomplete, true);
  assert.ok(result.diagnostics.warnings.some((item) =>
    item.operation === "deadline" && item.code === "AGENTSPINE_SCAN_INCOMPLETE"));
  assert.deepEqual(await readFile(source), before);
});

test("mandatory native sources keep priority over optional project Markdown", async (t) => {
  const { project, profile } = await fixture(t, "native-source-priority");
  await writeFile(join(profile, "AGENTS.md"), "# Required user source\n", "utf8");
  let cwd = project;
  for (let index = 0; index < 16; index += 1) {
    await writeFile(join(cwd, "AGENTS.md"), `# Required project source ${index}\n`, "utf8");
    cwd = join(cwd, `level-${String(index).padStart(2, "0")}`);
    await mkdir(cwd);
  }
  await writeFile(join(cwd, "AGENTS.md"), "# Required deepest source\n", "utf8");
  const optional = Array.from({ length: PROJECT_FILE_LIMIT }, (_, index) =>
    join(project, `optional-${String(index).padStart(3, "0")}.md`));
  await writeFiles(optional, (index) => `# Optional ${index}\n`);

  const result = await resolveHostSourceCatalog({ host: "codex", cwd, env: process.env });
  const required = result.catalog.documents.filter((item) => item.sourceBinding !== "host-native-rule-tree");
  const projectExtras = result.catalog.documents.filter((item) => item.sourceBinding === "host-native-rule-tree");
  assert.equal(required.length, 18);
  assert.equal(result.catalog.documents.length, 256);
  assert.equal(projectExtras.length, 256 - required.length);
  assert.ok(required.every((item) => item.name === "AGENTS.md"));
  assert.deepEqual({ limit: result.diagnostics.warnings[0]?.limit, retained: result.diagnostics.warnings[0]?.retained },
    { limit: 256 - required.length, retained: 256 - required.length });
  assert.equal(result.diagnostics.projectTreeScan, "bounded-truncated");
});
