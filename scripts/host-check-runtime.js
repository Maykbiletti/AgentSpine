import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { installedHostEnvironment } from "./host-environment.js";

export function assertHostContract(condition, message) {
  if (!condition) throw new Error(message);
}

export async function readHostJson(root, path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function expand(value, variable, root) {
  assertHostContract(typeof value === "string" && value.length > 0,
    "host command values must be non-empty strings");
  return value.split(`\${${variable}}`).join(root);
}

export async function validateEntrypoint(root, value) {
  const target = resolve(value);
  const within = relative(root, target);
  assertHostContract(within && !within.startsWith("..") && !isAbsolute(within),
    "MCP entrypoint must remain inside the plugin");
  assertHostContract((await stat(target)).isFile(), "MCP entrypoint must be a regular file");
}

export async function initializeServer({ label, root, variable, server, version }) {
  assertHostContract(server && typeof server === "object" && !Array.isArray(server),
    `${label} MCP registration is missing`);
  assertHostContract(server.command === "node",
    `${label} MCP registration must use the Node.js runtime`);
  assertHostContract(Array.isArray(server.args) && server.args.length === 1,
    `${label} MCP registration must name exactly one entrypoint`);
  const args = server.args.map((value) => {
    const expanded = expand(value, variable, root);
    return isAbsolute(expanded) ? expanded : resolve(root, expanded);
  });
  assertHostContract(!args.some((value) => value.includes("${")),
    `${label} MCP registration contains an unresolved variable`);
  await validateEntrypoint(root, args[0]);

  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: installedHostEnvironment(label, root),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const settle = () => error ? reject(error) : resolveResult(value);
      if (child.exitCode !== null || child.signalCode !== null) return settle();
      child.once("close", settle);
      child.kill();
    };
    const timer = setTimeout(() => {
      finish(new Error(`${label} MCP initialize timed out${stderr ? `: ${stderr.trim()}` : ""}`));
    }, 3000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(stdout.slice(0, newline));
        assertHostContract(message.id === 1,
          `${label} MCP initialize returned the wrong request id`);
        assertHostContract(message.result?.serverInfo?.name === "agent-spine",
          `${label} MCP initialize returned the wrong server identity`);
        assertHostContract(message.result?.serverInfo?.version === version,
          `${label} MCP initialize returned a stale server version`);
        finish(null, { label, server: message.result.serverInfo.name,
          entrypoint: relative(root, args[0]) });
      } catch (error) {
        finish(error);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (!settled) finish(new Error(`${label} MCP server exited with ${code}`
        + `${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" }
    })}\n`);
  });
}
