import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { projectStateDir } from "./paths.js";

const SCHEMA = "agentspine.lesson-recall-sessions/v1";
const AUTHORITY = "context-only";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const MAX_BYTES = 1024 * 1024;
const MAX_SESSIONS = 128;
const MAX_PATHS = 8;
const TTL_MS = 24 * 60 * 60 * 1000;

function boundedId(value) {
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}

function time(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("lesson recall timestamp is invalid");
  return date;
}

function suppliedScope(input) {
  const value = input.agent_spine_scope && typeof input.agent_spine_scope === "object"
    ? input.agent_spine_scope : input;
  return {
    entityId: boundedId(value.entity_id ?? value.entityId),
    projectId: boundedId(value.project_id ?? value.projectId),
    groupId: boundedId(value.group_id ?? value.groupId),
    taskId: boundedId(value.task_id ?? value.taskId ?? value.currentTaskId)
  };
}

function sessionId(input) {
  return boundedId(input.session_id ?? input.sessionId);
}

function emptyState(root) {
  return { schema: SCHEMA, root, sessions: [], authority: AUTHORITY };
}

function validPath(item) {
  return item && typeof item.path === "string" && item.path.length > 0 && item.path.length <= 512
    && !item.path.startsWith("/") && !item.path.startsWith("../") && !item.path.includes("/../")
    && /^[a-f0-9]{64}$/.test(item.sha256 || "");
}

function validSession(item) {
  return item && boundedId(item.sessionId) && item.host === "claude"
    && [item.entityId, item.projectId, item.groupId, item.taskId].every((value) => value === null || boundedId(value))
    && Array.isArray(item.paths) && item.paths.length <= MAX_PATHS && item.paths.every(validPath)
    && Number.isFinite(new Date(item.updatedAt).getTime())
    && Number.isFinite(new Date(item.expiresAt).getTime())
    && item.authority === AUTHORITY;
}

function normalizeState(value, root) {
  if (!value || value.schema !== SCHEMA || value.root !== root || value.authority !== AUTHORITY
    || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS
    || value.sessions.some((item) => !validSession(item))) {
    throw new Error("lesson recall session state is invalid");
  }
  return value;
}

async function pathsFor(root) {
  const directory = await projectStateDir(root);
  return { path: join(directory, "lesson-recall-sessions.json"),
    lockPath: join(directory, "lesson-recall-sessions.lock") };
}

async function readState(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_BYTES) throw new Error("lesson recall session state exceeds 1 MiB");
    return normalizeState(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyState(root);
  }
}

async function saveState(state, path, assertOwned) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("lesson recall session state exceeds 1 MiB");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path, { beforeAttempt: assertOwned });
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    });
    throw error;
  }
}

function sameScope(record, input) {
  const scope = suppliedScope(input);
  return record.sessionId === sessionId(input) && record.host === "claude"
    && record.entityId === scope.entityId && record.projectId === scope.projectId
    && record.groupId === scope.groupId && record.taskId === scope.taskId;
}

export function hookMemoryQuery(input) {
  for (const key of ["prompt", "user_prompt", "message", "input"]) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key].slice(0, 16384);
  }
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const values = [];
  const visit = (value, key = "", depth = 0) => {
    if (depth > 4 || values.length >= 32) return;
    if (typeof value === "string" && /(?:path|file|target|cmd|command|pattern|query)/i.test(key)) {
      values.push(value.slice(0, 2048));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 16)) visit(item, key, depth + 1);
      return;
    }
    for (const [name, item] of Object.entries(value).slice(0, 32)) visit(item, name, depth + 1);
  };
  visit(input.tool_input ?? input.tool_args ?? {});
  return [tool, ...values].filter(Boolean).join(" ");
}

export async function loadLessonRecallSelection({ root, input, now = new Date() }) {
  const session = sessionId(input);
  const scope = suppliedScope(input);
  if (!session) return { status: "no-session", paths: [], authority: AUTHORITY };
  if (scope.groupId) return { status: "group-suppressed", paths: [], authority: AUTHORITY };
  const { path } = await pathsFor(root);
  const state = await readState(path, root);
  const timestamp = time(now);
  const record = state.sessions.find((item) => sameScope(item, input)
    && new Date(item.expiresAt).getTime() >= timestamp.getTime());
  return record
    ? { status: "restored", paths: record.paths.map((item) => item.path), updatedAt: record.updatedAt,
      expiresAt: record.expiresAt, authority: AUTHORITY }
    : { status: "empty", paths: [], authority: AUTHORITY };
}

export async function rememberLessonRecallSelection({ root, input, sources, now = new Date() }) {
  const session = sessionId(input);
  const scope = suppliedScope(input);
  if (!session) return { status: "no-session", paths: [], authority: AUTHORITY };
  if (scope.groupId) return { status: "group-suppressed", paths: [], authority: AUTHORITY };
  const selected = sources.filter((item) => item.relativePath !== "MEMORY.md").slice(0, MAX_PATHS)
    .map((item) => ({ path: item.relativePath, sha256: item.snapshot.metadata.sha256 }));
  if (!selected.length) return { status: "empty", paths: [], authority: AUTHORITY };
  const timestamp = time(now);
  const updatedAt = timestamp.toISOString();
  const expiresAt = new Date(timestamp.getTime() + TTL_MS).toISOString();
  const names = await pathsFor(root);
  return withOwnedFileLock(names.lockPath, async ({ assertOwned }) => {
    const state = await readState(names.path, root);
    state.sessions = state.sessions.filter((item) => new Date(item.expiresAt).getTime() >= timestamp.getTime()
      && !sameScope(item, input));
    state.sessions.push({ sessionId: session, host: "claude", ...scope, paths: selected,
      updatedAt, expiresAt, authority: AUTHORITY });
    state.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);
    await saveState(state, names.path, assertOwned);
    return { status: "recorded", paths: selected.map((item) => item.path), updatedAt, expiresAt,
      authority: AUTHORITY };
  });
}
