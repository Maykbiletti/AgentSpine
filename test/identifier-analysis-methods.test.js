import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { undeclaredCalls } from "../src/lib/identifier-analysis.js";
import { registeredWriteContext } from "./premortem-write-fixture.js";

function names(source) {
  return undeclaredCalls(source).map((finding) => finding.name);
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-identifier-methods-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic project rules\n", "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  return root;
}

async function editLifecycle(root, before, after) {
  const path = join(root, "output.js");
  await writeFile(path, before, "utf8");
  const context = await registeredWriteContext({ root, sessionId: "session:identifier-methods",
    projectId: "project:identifier-methods" });
  const input = {
    ...context,
    host: "codex", cwd: root, tool_name: "Edit", tool_use_id: "tool:method-edit",
    tool_input: { file_path: path, old_string: before, new_string: after }
  };
  const pre = await runHook({ ...input, hook_event_name: "PreToolUse" });
  assert.equal(pre.blocked, false);
  await writeFile(path, after, "utf8");
  return runHook({ ...input, hook_event_name: "PostToolUse", success: true });
}

test("method names and parameters are declarations while default calls remain analyzed", () => {
  const source = [
    "const consume = () => {};",
    "class Runner {",
    "  run(callback) { callback(); }",
    "  async *stream({ consume = missingFactory() }) { consume(); }",
    "  get value() { return 1; }",
    "  set value(next) { consume(next); }",
    "  [methodKey](callback) { callback(); }",
    "  'quoted'(callback) { callback(); }",
    "  1(callback) { callback(); }",
    "  default(callback) { callback(); }",
    "  if(callback) { callback(); }",
    "  café(callback) { callback(); }",
    "}",
    "const worker = { get(callback) { callback(); }, async(done) { done(); },",
    "  execute(task) { task(); }, [methodKey](callback) { callback(); } };",
    "new Runner().run(() => worker.execute(() => {}));",
    ""
  ].join("\n");
  assert.deepEqual(names(source), ["missingFactory"]);
});

test("regular-expression contents are not identifier calls", () => {
  assert.deepEqual(names([
    "const escaped = /missing\\(/;",
    "const grouped = /alsoMissing()/gi;",
    "if (escaped) /controlMissing()/.test(grouped);",
    "const divided = known / missingCall();",
    ""
  ].join("\n"), { allowlist: ["known"] }), ["missingCall"]);
});

test("a call followed by a separate block remains a call", () => {
  assert.deepEqual(names("missingCall()\n{ const value = 1; }\n"), ["missingCall"]);
  assert.deepEqual(names("function run() {\n  nestedMissing()\n  { const value = 1; }\n}\n"),
    ["nestedMissing"]);
});

test("async arrows are syntax while a real async call remains analyzed", () => {
  assert.deepEqual(names([
    "const parenthesized = async (task) => task();",
    "const single = async task => task();",
    "async();",
    ""
  ].join("\n")), ["async"]);
});

test("function and destructuring defaults remain call sites", () => {
  assert.deepEqual(names([
    "function execute({ first, second }, value = `${parameterFactory()}`) { first(); second(); return value; }",
    "const { item = bindingFactory(), sibling } = source;",
    "const has = item in source, optional = optionalFactory?.();",
    "for (const selected = of, callback = () => {}; selected; ) callback();",
    "execute();",
    "item(); sibling();",
    ""
  ].join("\n")), ["parameterFactory", "bindingFactory", "optionalFactory"]);
});

test("import and require aliases declare only their local bindings", () => {
  assert.deepEqual(names([
    "import defaultLocal, { remote as local } from './module.js';",
    "const { requiredRemote: requiredLocal } = require('./common.cjs');",
    "defaultLocal(); local(); requiredLocal();",
    "remote(); requiredRemote();",
    ""
  ].join("\n")), ["remote", "requiredRemote"]);
  assert.deepEqual(names("import './polyfill.js'\nmissingAfterImport();\n"), ["missingAfterImport"]);
});

test("PostToolUse accepts declared method parameters and blocks a new default call", async (t) => {
  const root = await fixture(t);
  const before = "class Runner { run(callback) { callback(); } }\n";
  const after = "class Runner { run(callback = missingFactory()) { callback(); } }\n";
  const result = await editLifecycle(root, before, after);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.artifactGuard.newFindings.map((item) => item.name), ["missingFactory"]);
  assert.doesNotMatch(result.reason, /\b(?:run|callback)\b.*undeclared/);
});

test("PostToolUse does not treat object methods or their parameters as calls", async (t) => {
  const root = await fixture(t);
  const before = "const worker = {};\n";
  const after = [
    "const methodKey = 'run';",
    "const worker = { async *[methodKey]({ task }) { task(); },",
    "  get(callback) { callback(); }, 'quoted'(callback) { callback(); },",
    "  1(callback) { callback(); } };",
    "const pattern = /notACall()/;",
    "const execute = async (task) => task();",
    ""
  ].join("\n");
  const result = await editLifecycle(root, before, after);
  assert.equal(result.blocked, false);
  assert.equal(result.artifactGuard.status, "clean");
  assert.deepEqual(result.artifactGuard.findings, []);
});
