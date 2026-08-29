#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const base = await mkdtemp(join(tmpdir(), "agentspine-hermetic-tests-"));
const testFiles = (await readdir(join(root, "test"))).filter((name) => name.endsWith(".test.js")).sort();
const concurrency = Math.max(1, Math.min(4, cpus().length));

async function profileEnvironment(mode, index) {
  const profile = join(base, mode, String(index));
  const home = join(profile, "home"); const claude = join(profile, "claude"); const codex = join(profile, "codex");
  const state = join(profile, "state"); const xdgState = join(profile, "xdg-state"); const temporary = join(profile, "tmp");
  for (const directory of [home, claude, codex, state, xdgState, temporary]) await mkdir(directory, { recursive: true });
  if (mode === "populated") {
    await writeFile(join(claude, "CLAUDE.md"), "# Hermetic populated Claude profile\n\nSynthetic global source.\n");
    await writeFile(join(codex, "AGENTS.md"), "# Hermetic populated Codex profile\n\nSynthetic global source.\n");
  }
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:AGENTSPINE_|CLAUDE_|CODEX_|HOME$|USERPROFILE$|XDG_STATE_HOME$|TMPDIR$|TMP$|TEMP$|NODE_OPTIONS$|NODE_PATH$)/.test(key)));
  return { ...inherited, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex,
    AGENTSPINE_STATE_DIR: state, XDG_STATE_HOME: xdgState, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    AGENTSPINE_HERMETIC_ROOT: profile, AGENTSPINE_TEST_PROFILE: mode };
}

async function runOne(file, mode, index) {
  const env = await profileEnvironment(mode, index);
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--test", join(root, "test", file)], { cwd: root, env, shell: false,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ file, mode, code, stdout, stderr }));
    child.on("error", (error) => resolvePromise({ file, mode, code: 1, stdout, stderr: error.message }));
  });
}

async function runMode(mode) {
  const queue = testFiles.map((file, index) => ({ file, index })); const results = [];
  async function worker() { while (queue.length) { const item = queue.shift(); results.push(await runOne(item.file, mode, item.index)); } }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  for (const result of results.sort((a, b) => a.file.localeCompare(b.file))) {
    if (result.code !== 0) {
      process.stderr.write("\n[" + mode + "] " + result.file + " failed\n" + result.stdout + result.stderr);
    }
  }
  return results;
}

let failed = false;
try {
  for (const mode of ["empty", "populated"]) {
    const results = await runMode(mode); const failures = results.filter((item) => item.code !== 0);
    process.stdout.write("Hermetic " + mode + " profile: " + (results.length - failures.length) + "/" + results.length + " test files passed\n");
    if (failures.length) failed = true;
  }
} finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
if (failed) process.exitCode = 1;
