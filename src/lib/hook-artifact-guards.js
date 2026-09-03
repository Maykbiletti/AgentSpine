import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalPath } from "./paths.js";
import { undeclaredCalls } from "./identifier-analysis.js";

const STAND_SCHEMA = "blun.snapshot-stand/v1";
const ALLOWLIST_SCHEMA = "agentspine.identifier-allowlist/v1";
const HEX_RE = /^[a-f0-9]{64}$/i;
const MAX_STAND_BYTES = 64 * 1024;
const MAX_ASSIGNMENT_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 200 * 1024;
const DIRECT_WRITE = /(^|__)(write|edit)(_|$)/i;
const JAVASCRIPT_FILE = /\.(?:js|mjs|cjs)$/i;

function configuredExchange(input, cwd) {
  const value = input.agent_spine_exchange_directory ?? input.exchange_directory
    ?? process.env.AGENTSPINE_EXCHANGE_DIR;
  return typeof value === "string" && value.trim() ? resolve(cwd, value.trim()) : null;
}

function assignmentText(input) {
  const values = [];
  const collect = (value) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  for (const key of ["agent_spine_assignment", "current_assignment", "assignment"]) collect(input[key]);
  return values.join("\n");
}

function baselineDigests(content) {
  const values = [];
  for (const match of content.matchAll(/\bBasis\s*:[^\r\n]*?\bsha256\s*[:=]?\s*([a-f0-9]{64}|[a-f0-9]{16})\b/gi)) {
    values.push(match[1].toLowerCase());
  }
  return values;
}

async function boundedText(path, maxBytes) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maxBytes) return null;
  return readFile(path, "utf8");
}

async function assignmentBaselines(input, cwd) {
  const direct = baselineDigests(assignmentText(input));
  if (direct.length) return direct;
  const exchange = configuredExchange(input, cwd);
  if (!exchange) return [];
  let entries;
  try {
    entries = await readdir(exchange, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const digests = [];
  for (const entry of entries.filter((item) => item.isFile() && /^AUFTRAG-.*\.md$/i.test(item.name))
    .sort((left, right) => left.name.localeCompare(right.name)).slice(0, 32)) {
    const content = await boundedText(join(exchange, entry.name), MAX_ASSIGNMENT_BYTES);
    if (content !== null) digests.push(...baselineDigests(content));
  }
  return digests;
}

export async function verifyBaselineBeforeWrite({ input, cwd }) {
  if ((input.hook_event_name || input.event_name) !== "PreToolUse" || !DIRECT_WRITE.test(input.tool_name || "")) {
    return { status: "not-applicable", blocked: false };
  }
  const standPath = join(cwd, ".blun-snapshot-stand.json");
  let content;
  try {
    content = await boundedText(standPath, MAX_STAND_BYTES);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "no-stand", blocked: false, path: standPath };
    throw error;
  }
  if (content === null) return { status: "invalid-stand", blocked: false, path: standPath };
  let stand;
  try {
    stand = JSON.parse(content);
  } catch {
    return { status: "invalid-stand", blocked: false, path: standPath };
  }
  if (!(stand && stand.schema === STAND_SCHEMA && typeof stand.projectId === "string"
    && stand.projectId && HEX_RE.test(stand.snapshotSha256 || ""))) {
    return { status: "invalid-stand", blocked: false, path: standPath };
  }
  const baselines = [...new Set(await assignmentBaselines(input, cwd))];
  if (!baselines.length) return { status: "no-baseline", blocked: false, path: standPath };
  if (baselines.length !== 1) return { status: "ambiguous-baseline", blocked: false, path: standPath };
  const required = baselines[0];
  const actual = stand.snapshotSha256.toLowerCase();
  if (!actual.startsWith(required)) {
    return {
      status: "mismatch", blocked: true, path: standPath, requiredDigest: required, snapshotDigest: actual,
      reason: `AgentSpine baseline mismatch: required sha256 ${required}; snapshot stand sha256 ${actual}.`
    };
  }
  return { status: "verified", blocked: false, path: standPath, requiredDigest: required, snapshotDigest: actual };
}

function writtenPath(input, cwd) {
  const value = input.tool_input ?? input.tool_args;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = value.file_path ?? value.path ?? value.target_file ?? value.filename;
  return typeof path === "string" && path ? resolve(cwd, path) : null;
}

async function identifierAllowlist(root) {
  const path = join(root, ".agentspine-identifier-allowlist.json");
  let content;
  try {
    content = await boundedText(path, MAX_STAND_BYTES);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (content === null) return [];
  try {
    const value = JSON.parse(content);
    if (!(value && value.schema === ALLOWLIST_SCHEMA && Array.isArray(value.identifiers)
      && value.identifiers.every((item) => typeof item === "string" && /^[A-Za-z_$][\w$]*$/.test(item)))) return [];
    return [...new Set(value.identifiers)];
  } catch {
    return [];
  }
}

export async function inspectWrittenJavaScript({ input, cwd, root }) {
  if ((input.hook_event_name || input.event_name) !== "PostToolUse" || !DIRECT_WRITE.test(input.tool_name || "")) {
    return { status: "not-applicable", blocked: false, findings: [] };
  }
  const path = writtenPath(input, cwd);
  if (!path || !JAVASCRIPT_FILE.test(path)) return { status: "not-applicable", blocked: false, findings: [] };
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_SOURCE_BYTES) {
    return { status: metadata.isFile() ? "skipped-large" : "skipped-non-file", blocked: false, path, findings: [] };
  }
  const syntax = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 2000 });
  if (syntax.status !== 0) {
    return { status: "parse-warning", blocked: false, path, findings: [],
      reason: String(syntax.stderr || syntax.error?.message || "JavaScript parse failed").slice(0, 2048) };
  }
  const source = await readFile(path, "utf8");
  let findings;
  try {
    findings = undeclaredCalls(source, { allowlist: await identifierAllowlist(root) })
      .map((item) => ({ ...item, path }));
  } catch (error) {
    return { status: "parse-warning", blocked: false, path, findings: [], reason: error.message };
  }
  if (!findings.length) return { status: "clean", blocked: false, path, findings };
  const warning = findings.map((item) => `${item.path}:${item.line}: ${item.name}`).join("\n");
  return {
    status: "undeclared-identifiers", blocked: true, path, findings,
    reason: `AgentSpine undeclared-identifier warning:\n${warning}`
  };
}

function assistantMessage(input) {
  for (const key of ["last_assistant_message", "assistant_message", "final_assistant_message", "final_message", "response"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}

function claimedArtifacts(message) {
  const claims = [];
  for (const line of message.split(/\r?\n/)) {
    const digestMatch = line.match(/\b(?:sha256\s*[:=]?\s*)?([a-f0-9]{64}|[a-f0-9]{16})\b/i);
    if (!digestMatch) continue;
    const before = line.slice(0, digestMatch.index);
    const quoted = [...before.matchAll(/[`'"]([^`'"]+)[`'"]/g)].at(-1)?.[1];
    const plain = [...before.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_. -]+)*\.[A-Za-z0-9_.-]+)/g)].at(-1)?.[1];
    const path = (quoted || plain || "").trim();
    if (path) claims.push({ path, digest: digestMatch[1].toLowerCase() });
  }
  return claims;
}

function under(directory, path) {
  const child = relative(directory, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyDeliveredArtifacts({ input, cwd }) {
  if (!["Stop", "SubagentStop"].includes(input.hook_event_name || input.event_name)) {
    return { status: "not-applicable", blocked: false, mismatches: [] };
  }
  const claims = claimedArtifacts(assistantMessage(input));
  if (!claims.length) return { status: "no-claims", blocked: false, mismatches: [] };
  const configured = configuredExchange(input, cwd);
  if (!configured) return { status: "unconfigured", blocked: false, mismatches: [] };
  const exchange = await canonicalPath(configured);
  const mismatches = [];
  for (const claim of claims) {
    const fromCwd = resolve(cwd, claim.path);
    const target = under(exchange, fromCwd) ? fromCwd : resolve(exchange, claim.path);
    if (!under(exchange, target)) {
      mismatches.push({ path: claim.path, expected: claim.digest, actual: "outside-exchange" });
      continue;
    }
    try {
      const canonical = await canonicalPath(target);
      if (!under(exchange, canonical) || !(await lstat(canonical)).isFile()) {
        mismatches.push({ path: claim.path, expected: claim.digest, actual: "missing" });
        continue;
      }
      const actual = await fileDigest(canonical);
      if (!actual.startsWith(claim.digest)) mismatches.push({ path: claim.path, expected: claim.digest, actual });
    } catch (error) {
      if (error.code === "ENOENT") mismatches.push({ path: claim.path, expected: claim.digest, actual: "missing" });
      else throw error;
    }
  }
  if (!mismatches.length) return { status: "verified", blocked: false, mismatches: [] };
  return {
    status: "mismatch", blocked: true, mismatches,
    reason: `AgentSpine delivery artifact verification failed:\n${mismatches
      .map((item) => `${item.path}: expected ${item.expected}; actual ${item.actual}`).join("\n")}`
  };
}
