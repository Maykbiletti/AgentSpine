import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalPath, stateRoot } from "./paths.js";
import { undeclaredCalls } from "./identifier-analysis.js";
import { resolveFinalAssistantMessage } from "./hook-final-message.js";
import { auditGuard } from "./hook-protection.js";

const STAND_SCHEMA = "blun.snapshot-stand/v1";
const ALLOWLIST_SCHEMA = "agentspine.identifier-allowlist/v1";
const HEX_RE = /^[a-f0-9]{64}$/i;
const MAX_STAND_BYTES = 64 * 1024;
const MAX_ASSIGNMENT_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 200 * 1024;
const DIRECT_WRITE = /(^|__)(write|edit)(_|$)/i;
const JAVASCRIPT_FILE = /\.(?:js|mjs|cjs)$/i;
const IDENTIFIER_STATE_SCHEMA = "agentspine.identifier-state/v1";

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

function toolDeliveryId(input) {
  const value = input.tool_use_id ?? input.toolUseId ?? input.event_id ?? input.hook_event_id;
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function identifierStatePath(root, path, kind, deliveryId = null) {
  const project = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
  const file = createHash("sha256").update(resolve(path)).digest("hex");
  const suffix = kind === "pending"
    ? `${file}.${createHash("sha256").update(deliveryId || "unbound").digest("hex")}.json`
    : `${file}.json`;
  return join(stateRoot(), "identifier-guard", project, kind, suffix);
}

async function writeIdentifierState(root, path, kind, deliveryId, state) {
  const target = identifierStatePath(root, path, kind, deliveryId);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function readIdentifierState(root, path, kind, deliveryId) {
  const target = identifierStatePath(root, path, kind, deliveryId);
  let content;
  try {
    content = await boundedText(target, MAX_STAND_BYTES);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (content === null) return null;
  try {
    const state = JSON.parse(content);
    if (!(state?.schema === IDENTIFIER_STATE_SCHEMA && state.path === resolve(path)
      && Array.isArray(state.names) && state.names.every((name) => /^[A-Za-z_$][\w$]*$/.test(name))
      && typeof state.existed === "boolean")) return null;
    return state;
  } catch {
    return null;
  }
}

function stateFor(path, existed, findings, source) {
  return {
    schema: IDENTIFIER_STATE_SCHEMA, path: resolve(path), existed,
    names: [...new Set(findings.map((item) => item.name))].sort(),
    sourceDigest: source === null ? null : createHash("sha256").update(source).digest("hex"),
    authority: "diagnostic-only"
  };
}

function originalSource(input, current) {
  const value = input.tool_input ?? input.tool_args;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["original_content", "previous_content", "before_content"]) {
    if (typeof value[key] === "string" && Buffer.byteLength(value[key]) <= MAX_SOURCE_BYTES) return value[key];
  }
  if (typeof value.old_string !== "string" || typeof value.new_string !== "string") return null;
  if (value.new_string.length === 0) return null;
  if (value.replace_all === true) return current.split(value.new_string).join(value.old_string);
  const index = current.indexOf(value.new_string);
  return index < 0 ? null : current.slice(0, index) + value.old_string + current.slice(index + value.new_string.length);
}

function parsesJavaScript(source) {
  return spawnSync(process.execPath, ["--check", "-"], {
    input: source, encoding: "utf8", timeout: 2000
  }).status === 0;
}

export async function captureJavaScriptBeforeWrite({ input, cwd, root }) {
  if ((input.hook_event_name || input.event_name) !== "PreToolUse" || !DIRECT_WRITE.test(input.tool_name || "")) {
    return { status: "not-applicable", blocked: false };
  }
  const path = writtenPath(input, cwd);
  const deliveryId = toolDeliveryId(input);
  if (!path || !JAVASCRIPT_FILE.test(path) || !deliveryId) return { status: "not-applicable", blocked: false, path };
  let source = null;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > MAX_SOURCE_BYTES) {
      return { status: metadata.isFile() ? "skipped-large" : "skipped-non-file", blocked: false, path };
    }
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let findings = [];
  if (source !== null) {
    if (!parsesJavaScript(source)) return { status: "parse-warning", blocked: false, path };
    findings = undeclaredCalls(source, { allowlist: await identifierAllowlist(root) });
  }
  await writeIdentifierState(root, path, "pending", deliveryId, stateFor(path, source !== null, findings, source));
  return { status: "captured", blocked: false, path, findings };
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
  const allowlist = await identifierAllowlist(root);
  try {
    findings = undeclaredCalls(source, { allowlist })
      .map((item) => ({ ...item, path }));
  } catch (error) {
    return { status: "parse-warning", blocked: false, path, findings: [], reason: error.message };
  }
  const deliveryId = toolDeliveryId(input);
  const previousSource = originalSource(input, source);
  let previous = null;
  if (previousSource !== null && parsesJavaScript(previousSource)) {
    previous = stateFor(path, true, undeclaredCalls(previousSource, { allowlist }), previousSource);
  } else if (deliveryId) {
    previous = await readIdentifierState(root, path, "pending", deliveryId);
  }
  previous ||= await readIdentifierState(root, path, "last", null);
  const previousNames = previous ? new Set(previous.names) : null;
  const newFindings = previousNames ? findings.filter((item) => !previousNames.has(item.name)) : [];
  const existingFindings = previousNames ? findings.filter((item) => previousNames.has(item.name)) : findings;
  await writeIdentifierState(root, path, "last", null, stateFor(path, true, findings, source));
  if (deliveryId) await rm(identifierStatePath(root, path, "pending", deliveryId), { force: true });
  const warning = existingFindings.map((item) => `${item.path}:${item.line}: ${item.name}`).join("\n");
  if (newFindings.length) {
    const added = newFindings.map((item) => `${item.path}:${item.line}: ${item.name}`).join("\n");
    return {
      status: "new-undeclared-identifiers", blocked: true, path, findings, newFindings, existingFindings,
      reason: `AgentSpine new undeclared calls:\n${added}${warning ? `\nPre-existing warnings:\n${warning}` : ""}`
    };
  }
  if (!findings.length) return { status: "clean", blocked: false, path, findings, newFindings, existingFindings };
  return {
    status: previousNames ? "pre-existing-undeclared-identifiers" : "unverified-undeclared-identifiers",
    blocked: false, path, findings, newFindings, existingFindings,
    reason: `AgentSpine pre-existing undeclared-call warning (non-blocking):\n${warning}`
  };
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
  const message = resolveFinalAssistantMessage(input);
  if (["conflict", "malformed"].includes(message.status)) {
    const result = { status: "degraded", blocked: false, mismatches: [], path: cwd,
      reason: `AgentSpine delivery ${message.reason}` };
    await auditGuard(input, "delivery-artifact-guard", result);
    return result;
  }
  const claims = claimedArtifacts(message.text);
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
