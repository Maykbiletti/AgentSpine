import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "../src/mcp.js";
import { preparePremortemRequirement } from "../src/lib/delivery-premortem.js";

export async function fixture(t, { homeRoot = true } = {}) {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentspine-mcp-bounded-"));
  const home = join(workspace, "home");
  const root = homeRoot ? home : join(home, "project");
  const foreign = join(home, "unrelated", "deep");
  const state = join(workspace, "state");
  const codex = join(home, ".codex");
  const claude = join(home, ".claude");
  for (const path of [root, foreign, state, codex, claude]) {
    await fs.mkdir(path, { recursive: true });
  }
  if (!homeRoot) await fs.mkdir(join(root, ".git"));
  const originals = new Map();
  for (const name of ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "SOUL.md"]) {
    const content = Buffer.from(`# Synthetic ${name}\r\n\r\nKeep source bytes after a timeout.\r\n`);
    originals.set(join(root, name), content);
    await fs.writeFile(join(root, name), content);
  }
  await fs.writeFile(join(root, "target.js"), "export const synthetic = true;\n");
  await fs.writeFile(join(foreign, "PRIVATE.md"), "SYNTHETIC_FOREIGN_SENTINEL\n");
  const values = { HOME: home, USERPROFILE: home, CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude, AGENTSPINE_STATE_DIR: state,
    AGENTSPINE_ROOT: undefined, BLUN_HOME: undefined };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return { root: await fs.realpath(root), home: await fs.realpath(home), foreign,
    async preserve() {
      for (const [path, bytes] of originals) assert.deepEqual(await fs.readFile(path), bytes);
    } };
}

export function client() {
  const input = new PassThrough();
  const output = new PassThrough();
  let id = 0;
  let buffer = "";
  const pending = new Map();
  output.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output);
  return async (name, args) => {
    const requestId = ++id;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("bounded MCP timeout")), 5000);
      pending.set(requestId, result => {
        clearTimeout(timeout);
        resolve({ ...JSON.parse(result.content[0].text), isError: result.isError });
      });
    });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call",
      params: { name, arguments: args } }) + "\n");
    return promise;
  };
}

export async function requirement(root, host, sessionId = `session:${host}`) {
  const result = await preparePremortemRequirement({ root,
    binding: { host, sessionId, projectId: "project:synthetic" } });
  assert.equal(result.blocked, false);
  return result.requirementId;
}

export async function measureReads(action) {
  const accesses = [];
  const originals = new Map();
  for (const name of ["readdir", "opendir", "readFile"]) {
    originals.set(name, fs[name]);
    fs[name] = async (...args) => {
      accesses.push({ operation: name, path: String(args[0]) });
      return originals.get(name)(...args);
    };
  }
  syncBuiltinESMExports();
  try {
    const started = performance.now();
    return { result: await action(), accesses, elapsed: performance.now() - started };
  } finally {
    for (const [name, fn] of originals) fs[name] = fn;
    syncBuiltinESMExports();
  }
}

export async function processCall(root, name, args) {
  const entry = fileURLToPath(new URL("../src/mcp.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: root, env: process.env,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "";
    let result;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("MCP child timeout");
      child.kill();
    }, 5000);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))).result;
        result = { ...JSON.parse(response.content[0].text), isError: response.isError };
      } catch (error) {
        failure = error;
      }
      // Stop the actual server after the response; no graceful state rewrite.
      child.kill();
    });
    child.once("close", () => {
      clearTimeout(timer);
      if (failure || !result) reject(failure || new Error("MCP child exited without result"));
      else resolve(result);
    });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args } }) + "\n");
  });
}
