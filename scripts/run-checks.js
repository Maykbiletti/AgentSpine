#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubErrorCommand } from "./github-actions.js";

const CHECKS = [
  { title: "Syntax check", script: "lint" },
  { title: "Hermetic test suite", script: "test" },
  { title: "Host manifest check", script: "host:check" },
  { title: "Installed bundle check", script: "host:install-check" },
  { title: "Runtime smoke test", script: "smoke" },
  { title: "Self audit", script: "audit:self" }
];

function runNpmScript(script) {
  const npmExecPath = process.env.npm_execpath;
  const executable = npmExecPath ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = npmExecPath ? [npmExecPath, "run", script] : ["run", script];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", shell: false, windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function runChecks({
  checks = CHECKS, runCommand = runNpmScript, githubActions = process.env.GITHUB_ACTIONS === "true", output = process.stderr
} = {}) {
  for (const check of checks) {
    let code;
    try { code = await runCommand(check.script); }
    catch (error) {
      if (githubActions) output.write(githubErrorCommand(check.title, error.message) + "\n");
      else output.write(`${check.title} failed: ${error.message}\n`);
      return 1;
    }
    if (code !== 0) {
      if (githubActions) output.write(githubErrorCommand(check.title, `npm run ${check.script} exited with code ${code}`) + "\n");
      return code;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runChecks();
