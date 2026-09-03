import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { deliveryToolActions } from "../src/lib/delivery-command-actions.js";

function actions(tool_name, command) {
  return deliveryToolActions({ tool_name, tool_input: { command } });
}

test("quoted mutation words and inline-program literals are not writes", () => {
  for (const [tool, command] of [
    ["Bash", `echo "please rm foo"`],
    ["Bash", `printf '%s\\n' "use touch file"`],
    ["Bash", `echo "npm install foo"`],
    ["PowerShell", `Write-Output 'please Set-Content file'`],
    ["PowerShell", `Write-Output 'use Remove-Item carefully'`],
    ["Bash", `powershell -Command "Write-Output 'please Remove-Item file'"`],
    ["Bash", `node -e "console.log('writeFileSync( is documentation')"`],
    ["Bash", `python -c 'print("open(\\\"x\\\", \\\"w\\\")")'`],
    ["Bash", `printf '%s' '$(rm artifact.txt)'`],
    ["Bash", "printf '%s' '`touch artifact.txt`'"],
    ["Bash", `printf '%s' 'case "$value" in y) rm artifact.txt;; esac'`],
    ["Bash", `case "$value" in y) printf '%s' 'rm artifact.txt';; esac`],
    ["Bash", `eval "printf '%s' 'rm artifact.txt'"`],
    ["Bash", `"if" rm artifact.txt`],
    ["Bash", `"(" rm artifact.txt`]
  ]) assert.deepEqual(actions(tool, command), [], command);
});

test("real shell and inline-program mutations remain recognized", () => {
  for (const [tool, command] of [
    ["Bash", "rm artifact.txt"],
    ["Bash", "printf synthetic > artifact.txt"],
    ["Bash", "bash -c 'touch artifact.txt'"],
    ["PowerShell", "Set-Content -Path artifact.txt -Value synthetic"],
    ["Bash", `powershell -Command "Set-Content -Path artifact.txt -Value synthetic"`],
    ["Bash", `node -e "require('fs').writeFileSync('artifact.js', 'x')"`],
    ["Bash", `node -e "require('fs').promises.writeFile('artifact.js', 'x')"`],
    ["Bash", `python -c "open('artifact.js', 'w').write('x')"`],
    ["Bash", `python -c "from pathlib import Path; Path('artifact').write_text('x')"`]
  ]) assert.equal(actions(tool, command).some((item) => item.kind === "write"), true, command);
});

test("shell wrappers cannot hide mutations and preserve read-only commands", () => {
  for (const command of [
    "sudo -u root rm AGENTS.md", "sudo --user=root rm AGENTS.md", "command -- rm AGENTS.md",
    "env FOO=synthetic rm AGENTS.md", "env -u FOO rm AGENTS.md", "builtin -- rm AGENTS.md",
    "timeout 1 rm AGENTS.md", "timeout --signal TERM 1 rm AGENTS.md", "nice -n 1 rm AGENTS.md",
    "nice --adjustment=1 rm AGENTS.md", "/usr/bin/env FOO=synthetic rm AGENTS.md",
    "env -S 'rm AGENTS.md'", "exec -a benign rm AGENTS.md", "/bin/bash -c 'rm AGENTS.md'",
    "/usr/bin/env bash -c 'rm AGENTS.md'", "env --split-string='rm AGENTS.md'",
    "\"env\" \"FOO=synthetic\" rm AGENTS.md"
  ]) assert.equal(actions("Bash", command).some((item) => item.kind === "write"), true, command);
  for (const command of [
    "sudo -u root cat AGENTS.md", "command -- git diff", "env FOO=synthetic cat AGENTS.md",
    "timeout 1 cat AGENTS.md", "nice -n 1 git diff", "/usr/bin/env FOO=synthetic cat AGENTS.md",
    "env -S 'cat AGENTS.md'", "exec -a benign cat AGENTS.md", "/bin/bash -c 'cat AGENTS.md'",
    "/usr/bin/env bash -c 'cat AGENTS.md'", "env --split-string='cat AGENTS.md'",
    "\"env\" \"FOO=synthetic\" cat AGENTS.md"
  ]) assert.deepEqual(actions("Bash", command), [], command);
});

test("shell comparisons and explicit inspection modes remain read-only", () => {
  for (const command of [
    "[[ $left > $right ]]",
    "(( left > right ))",
    "test $left \\> $right",
    "[ $left '>' $right ]",
    "rm --help",
    "cp --version",
    "mkdir --help",
    "touch --help",
    "git apply --check patch.diff",
    "git checkout --help",
    "npm install --dry-run"
  ]) assert.deepEqual(actions("Bash", command), [], command);
  assert.deepEqual(actions("Bash", "(rm --help)"), []);
});

test("inspection exclusions do not hide actual redirects or mutations", () => {
  for (const command of [
    "printf synthetic > artifact.txt",
    "printf synthetic 2>errors.txt",
    "printf synthetic >> artifact.txt",
    "test $left > comparison.txt",
    "[ $left > comparison.txt ]",
    "rm --help > help.txt",
    "rm -- --help",
    "git apply patch.diff",
    "git apply --check=false patch.diff",
    "npm install synthetic-package",
    "npm install --dry-run=false",
    "[[ $(printf synthetic > artifact.txt) ]]",
    "[[ $left > $right ]] > artifact.txt",
    "[[left > artifact.txt",
    "cat <<'EOF' > artifact.txt\nsynthetic\nEOF"
  ]) assert.equal(actions("Bash", command).some((item) => item.kind === "write"), true, command);
});

test("control structures and executable substitutions preserve nested writes", () => {
  for (const command of [
    "if rm artifact.txt; then printf ok; fi",
    "{ rm artifact.txt; }",
    "for item in a; do rm artifact.txt; done",
    "while test -f artifact.txt; do touch marker.txt; done",
    `case "$value" in y) rm artifact.txt;; esac`,
    `case "$value" in "y)") touch artifact.txt;; esac`,
    "case x in a) printf no;; b) rm artifact.txt;; esac",
    "(rm artifact.txt)",
    "(git apply)",
    "(pnpm update)",
    `eval "rm artifact.txt"`,
    "eval rm artifact.txt",
    "echo $(rm artifact.txt)",
    "result=$(touch artifact.txt)",
    "echo `rm artifact.txt`",
    "echo \"$(rm artifact.txt)\""
  ]) assert.equal(actions("Bash", command).some((item) => item.kind === "write"), true, command);
  assert.deepEqual(actions("Bash",
    "case x in a) printf no;; b) printf '%s' 'rm artifact.txt';; esac"), []);
});

test("heredoc bodies are data while opener-side writes remain writes", () => {
  for (const command of [
    "cat <<'EOF'\nrm artifact.txt\ntouch marker.txt\nprintf x > output.txt\nEOF",
    "cat <<EOF\nrm artifact.txt\nEOF",
    "cat <<-EOF\n\trm artifact.txt\n\tEOF",
    "cat <<FIRST <<SECOND\nrm artifact.txt\nFIRST\ntouch artifact.txt\nSECOND"
  ]) assert.deepEqual(actions("Bash", command), [], command);
  for (const command of [
    "cat <<EOF > artifact.txt\nrm decoy.txt\nEOF",
    "cat <<-EOF >> artifact.txt\n\ttouch decoy.txt\n\tEOF",
    "bash <<'SH'\nrm artifact.txt\nSH",
    "sh <<SH\ntouch artifact.txt\nSH",
    "zsh <<'SH'\nprintf x > artifact.txt\nSH"
  ]) assert.equal(actions("Bash", command).some((item) => item.kind === "write"), true, command);
  assert.deepEqual(actions("Bash", "bash <<'SH'\nprintf '%s' 'rm artifact.txt'\nSH"), []);
});

test("PreToolUse allows comparisons but requires a premortem for real redirection", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-command-actions-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic rules\n", "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  const common = {
    cwd: root, host: "codex", session_id: "session:command-actions",
    agent_spine_scope: { project_id: "project:command-actions" },
    hook_event_name: "PreToolUse", tool_name: "Bash"
  };
  const comparison = await runHook({
    ...common, tool_use_id: "tool:comparison",
    tool_input: { command: "[[ $left > $right ]]" }
  });
  assert.equal(comparison.blocked, false);
  const redirection = await runHook({
    ...common, tool_use_id: "tool:redirection",
    tool_input: { command: "printf synthetic > artifact.txt" }
  });
  assert.equal(redirection.blocked, true);
  assert.match(redirection.reason, /missing premortem/);
});

test("wrapped protected-source writes are blocked while wrapper reads remain allowed", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-wrapper-protection-"));
  const root = join(workspace, "project");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic protected rules\n", "utf8");
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(workspace, { recursive: true, force: true });
  });
  const common = {
    cwd: root, host: "codex", session_id: "session:wrapper-protection",
    agent_spine_scope: { project_id: "project:wrapper-protection" },
    hook_event_name: "PreToolUse", tool_name: "Bash"
  };
  for (const [index, command] of [
    "timeout 1 rm AGENTS.md", "nice -n 1 rm AGENTS.md", "/usr/bin/env FOO=synthetic rm AGENTS.md",
    "env -S 'rm AGENTS.md'", "exec -a benign rm AGENTS.md", "/bin/bash -c 'rm AGENTS.md'",
    "/usr/bin/env bash -c 'rm AGENTS.md'"
  ].entries()) {
    const result = await runHook({ ...common, tool_use_id: `tool:wrapped-write:${index}`, tool_input: { command } });
    assert.equal(result.blocked, true, command);
    assert.match(result.reason, /protected source: .*AGENTS\.md/);
  }
  for (const [index, command] of [
    "timeout 1 cat AGENTS.md", "nice -n 1 git diff", "/usr/bin/env FOO=synthetic cat AGENTS.md",
    "env -S 'cat AGENTS.md'", "exec -a benign cat AGENTS.md", "/bin/bash -c 'cat AGENTS.md'",
    "/usr/bin/env bash -c 'cat AGENTS.md'"
  ].entries()) {
    const result = await runHook({ ...common, tool_use_id: `tool:wrapped-read:${index}`, tool_input: { command } });
    assert.equal(result.blocked, false, command);
  }
});

test("oversized uncertain shell input fails open without a write classification", () => {
  const oversized = `printf synthetic > ${"a".repeat((64 * 1024) + 1)}`;
  assert.deepEqual(actions("Bash", oversized), []);
});
