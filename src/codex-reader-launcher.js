#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "agentspine.codex-reader-registration/v1";
const REQUIRED_TOOLS = [
  "session_briefing", "delivery_knowledge_query",
  "record_delivery_premortem", "read_document"
];
const MAX_REGISTRATION_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inside(root, path) {
  const value = relative(root, path);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function regular(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular non-symlink file`);
}

async function loadRegistration() {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "registration.json");
  await regular(path, "reader registration");
  const bytes = await readFile(path);
  if (bytes.length > MAX_REGISTRATION_BYTES) throw new Error("reader registration exceeds 32 KiB");
  const value = JSON.parse(bytes.toString("utf8"));
  const material = { ...value };
  delete material.digest;
  if (!value || value.schema !== SCHEMA || value.authority !== "host-registration-only"
    || value.expectedName !== "agent-spine" || typeof value.expectedVersion !== "string"
    || JSON.stringify(value.expectedTools) !== JSON.stringify(REQUIRED_TOOLS)
    || !/^[a-f0-9]{64}$/.test(value.digest || "") || value.digest !== sha256(canonical(material))) {
    throw new Error("reader registration failed integrity validation");
  }
  if (![value.packageRoot, value.nodePath, value.entrypoint].every((item) => typeof item === "string" && isAbsolute(item))) {
    throw new Error("reader registration contains a non-absolute path");
  }
  const rootMetadata = await lstat(value.packageRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || await realpath(value.packageRoot) !== resolve(value.packageRoot)) {
    throw new Error("registered package root is not a canonical directory");
  }
  await Promise.all([
    regular(value.nodePath, "registered Node.js runtime"),
    regular(value.entrypoint, "registered MCP entrypoint"),
    regular(resolve(value.packageRoot, "package.json"), "registered package manifest"),
    regular(resolve(value.packageRoot, "src", "version.js"), "registered version source")
  ]);
  if (!inside(value.packageRoot, value.entrypoint) || await realpath(value.entrypoint) !== value.entrypoint) {
    throw new Error("registered MCP entrypoint escapes the package root");
  }
  const [entrypoint, packageText, source] = await Promise.all([
    readFile(value.entrypoint), readFile(resolve(value.packageRoot, "package.json"), "utf8"),
    readFile(resolve(value.packageRoot, "src", "version.js"), "utf8")
  ]);
  const pkg = JSON.parse(packageText);
  const sourceVersion = source.match(/^export const VERSION = "([^"]+)";\s*$/)?.[1];
  if (sha256(entrypoint) !== value.entrypointDigest || sha256(packageText) !== value.packageDigest
    || sha256(source) !== value.versionSourceDigest || pkg.version !== value.expectedVersion
    || sourceVersion !== value.expectedVersion) {
    throw new Error("registered reader files or version changed after installation");
  }
  return value;
}

function jsonError(id, message) {
  return { jsonrpc: "2.0", id: id ?? null,
    error: { code: -32091, message: "AgentSpine loaded-reader verification failed", data: { reason: message } } };
}

async function start() {
  let registration;
  try {
    registration = await loadRegistration();
  } catch (error) {
    process.stdout.write(`${JSON.stringify(jsonError(null, error.message))}\n`);
    return;
  }
  const child = spawn(registration.nodePath, [registration.entrypoint], {
    cwd: registration.packageRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"]
  });
  let hostBuffer = "";
  let childBuffer = "";
  let initial = null;
  let phase = "await-host-initialize";
  const queued = [];
  let stderr = "";
  let failed = false;

  const fail = (message, id = initial?.id) => {
    if (failed) return;
    failed = true;
    process.stdout.write(`${JSON.stringify(jsonError(id, message))}\n`);
    child.kill();
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const verifyInitialize = (message) => {
    if (message.error || message.result?.serverInfo?.name !== registration.expectedName
      || message.result?.serverInfo?.version !== registration.expectedVersion) {
      return fail("the launched MCP server identity or version does not match its registration");
    }
    phase = "verify-tools";
    send({ jsonrpc: "2.0", id: "agentspine:verify-tools", method: "tools/list", params: {} });
  };
  const verifyTools = (message) => {
    const names = new Set((message.result?.tools || []).map((tool) => tool?.name));
    if (message.error || REQUIRED_TOOLS.some((name) => !names.has(name))) {
      return fail("the launched MCP server is missing required delivery tools");
    }
    phase = "verified";
    process.stdout.write(`${JSON.stringify({ ...initial.response, id: initial.id })}\n`);
    for (const message of queued.splice(0)) send(message);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    childBuffer += chunk;
    if (Buffer.byteLength(childBuffer) > MAX_LINE_BYTES) return fail("reader response exceeds 1 MiB");
    let newline;
    while ((newline = childBuffer.indexOf("\n")) >= 0) {
      const line = childBuffer.slice(0, newline).trim();
      childBuffer = childBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return fail("reader returned invalid JSON"); }
      if (phase === "verify-initialize" && message.id === "agentspine:verify-initialize") {
        initial.response = message;
        verifyInitialize(message);
      } else if (phase === "verify-tools" && message.id === "agentspine:verify-tools") verifyTools(message);
      else if (phase === "verified") process.stdout.write(`${JSON.stringify(message)}\n`);
      else return fail("reader returned an unexpected response before verification");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk; });
  child.on("error", (error) => fail(error.message));
  child.on("close", (code, signal) => {
    if (!failed && phase !== "verified") fail(`reader exited before verification (${signal || code})${stderr ? ": " + stderr.trim() : ""}`);
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    hostBuffer += chunk;
    if (Buffer.byteLength(hostBuffer) > MAX_LINE_BYTES) return fail("host request exceeds 1 MiB");
    let newline;
    while ((newline = hostBuffer.indexOf("\n")) >= 0) {
      const line = hostBuffer.slice(0, newline).trim();
      hostBuffer = hostBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return fail("host sent invalid JSON", null); }
      if (phase === "await-host-initialize") {
        if (message.method !== "initialize") return fail("initialize must be the first host request", message.id);
        initial = { id: message.id, response: null };
        phase = "verify-initialize";
        send({ ...message, id: "agentspine:verify-initialize" });
      } else if (phase === "verified") send(message);
      else queued.push(message);
    }
  });
  process.stdin.on("end", () => child.stdin.end());
}

start().catch((error) => {
  process.stdout.write(`${JSON.stringify(jsonError(null, error.message))}\n`);
  process.exitCode = 1;
});
