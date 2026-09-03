import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { projectStateDir } from "./paths.js";

export const DELIVERY_VERIFICATION_SCHEMA = "agentspine.delivery-verification/v1";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_RECENT_EVENTS = 32;
const WRITE_TOOLS = /(^|__)(apply_patch|edit|write|delete|move|rename)(_|$)/i;
const SHELL_TOOLS = /(^|__)(bash|exec_command|shell)(_|$)/i;
const SHELL_WRITE_PATTERNS = [
  /(?:^|[;&|]\s*|\s)(?:apply_patch|rm|mv|cp|install|mkdir|rmdir|touch|truncate|tee|patch)\b/gi,
  /(?:^|[;&|]\s*|\s)(?:sed|perl)\b[^\n;&|]*\s-i(?:\s|$)/gi,
  /(?:^|[;&|]\s*|\s)git\s+(?:apply|checkout|restore|reset|merge|rebase|cherry-pick)\b/gi,
  /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn)\s+(?:install|update|add|remove)\b/gi
];
const TEST_COMMANDS = [
  { family: "node-test", expression: /^node\s+--test(?:\s+[^;&|\n]+)?$/i },
  { family: "npm-test", expression: /^npm\s+(?:run\s+)?test(?:[\s:][^;&|\n]*)?$/i },
  { family: "npm-check", expression: /^npm\s+run\s+check(?:\s+[^;&|\n]+)?$/i },
  { family: "pytest", expression: /^(?:python(?:3)?\s+-m\s+)?pytest(?:\s+[^;&|\n]+)?$/i }
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stateMaterial(state) {
  return {
    schema: state.schema,
    laneDigest: state.laneDigest,
    revision: state.revision,
    lastWrite: state.lastWrite,
    lastTest: state.lastTest,
    verifiedWriteDigest: state.verifiedWriteDigest,
    pauseEventDigest: state.pauseEventDigest,
    conflict: state.conflict,
    recentEvents: state.recentEvents,
    authority: "verification-state-only"
  };
}

function seal(state) {
  state.integrityDigest = sha256(JSON.stringify(stateMaterial(state)));
  return state;
}

function emptyState(laneDigest) {
  return seal({
    schema: DELIVERY_VERIFICATION_SCHEMA,
    laneDigest,
    revision: 0,
    lastWrite: null,
    lastTest: null,
    verifiedWriteDigest: null,
    pauseEventDigest: null,
    conflict: null,
    recentEvents: [],
    integrityDigest: null,
    authority: "verification-state-only"
  });
}

function validReceipt(receipt) {
  return receipt === null || (receipt && typeof receipt === "object" && !Array.isArray(receipt)
    && DIGEST_RE.test(receipt.eventDigest || "") && typeof receipt.toolName === "string"
    && receipt.toolName.length <= 128 && typeof receipt.at === "string"
    && Number.isFinite(new Date(receipt.at).getTime())
    && (receipt.family === null || typeof receipt.family === "string"));
}

function normalizeState(value, laneDigest) {
  if (!(value && value.schema === DELIVERY_VERIFICATION_SCHEMA && value.laneDigest === laneDigest
    && Number.isInteger(value.revision) && value.revision >= 0
    && validReceipt(value.lastWrite) && validReceipt(value.lastTest)
    && (value.verifiedWriteDigest === null || DIGEST_RE.test(value.verifiedWriteDigest))
    && (value.pauseEventDigest === null || DIGEST_RE.test(value.pauseEventDigest))
    && (value.conflict === null || DIGEST_RE.test(value.conflict))
    && Array.isArray(value.recentEvents) && value.recentEvents.length <= MAX_RECENT_EVENTS
    && value.recentEvents.every((item) => DIGEST_RE.test(item?.idDigest || "")
      && DIGEST_RE.test(item?.eventDigest || ""))
    && value.authority === "verification-state-only"
    && DIGEST_RE.test(value.integrityDigest || "")
    && value.integrityDigest === sha256(JSON.stringify(stateMaterial(value))))) {
    throw new Error("delivery verification state failed integrity validation");
  }
  return value;
}

function timestamp(value) {
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function scopeValue(scope, name) {
  const value = scope?.[name];
  return typeof value === "string" && value ? value : "";
}

function laneMaterial({ host, sessionId, scope }) {
  const taskBound = scopeValue(scope, "entityId") && scopeValue(scope, "projectId")
    && scopeValue(scope, "currentTaskId");
  if (taskBound) {
    return ["task", host || "unknown", scopeValue(scope, "entityId"),
      scopeValue(scope, "projectId"), scopeValue(scope, "currentTaskId")].join("\0");
  }
  return typeof sessionId === "string" && sessionId ? ["session", host || "unknown", sessionId].join("\0") : null;
}

function stopIdentity(eventId, sessionId) {
  if (typeof eventId === "string" && eventId) return `event\0${eventId}`;
  if (typeof sessionId === "string" && sessionId) return `session\0${sessionId}`;
  return null;
}

function commandFromInput(input) {
  const toolInput = input?.tool_input ?? input?.tool_args;
  if (typeof toolInput === "string") return toolInput;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";
  for (const key of ["command", "cmd", "script"]) {
    if (typeof toolInput[key] === "string") return toolInput[key];
  }
  return "";
}

function patternActions(command, expression, action) {
  const actions = [];
  expression.lastIndex = 0;
  for (const match of command.matchAll(expression)) actions.push({ ...action, index: match.index });
  return actions;
}

function trailingTestAction(command) {
  if (typeof command !== "string" || /\|\||[;|\n]/.test(command)) return null;
  const parts = command.split(/\s*&&\s*/);
  const tail = parts.at(-1)?.trim() || "";
  const index = command.lastIndexOf(tail);
  const match = TEST_COMMANDS.find(({ expression }) => expression.test(tail));
  return match ? { kind: "test", family: match.family, index } : null;
}

export function deliveryToolActions(input) {
  const toolName = String(input?.tool_name || "").slice(0, 128);
  if (WRITE_TOOLS.test(toolName)) return [{ kind: "write", family: null, index: 0 }];
  if (!SHELL_TOOLS.test(toolName)) return [];
  const command = commandFromInput(input);
  const actions = [];
  for (const expression of SHELL_WRITE_PATTERNS) {
    actions.push(...patternActions(command, expression, { kind: "write", family: null }));
  }
  const test = trailingTestAction(command);
  if (test) actions.push(test);
  return actions.sort((left, right) => left.index - right.index || left.kind.localeCompare(right.kind));
}

function eventIdentity(input, actions, success) {
  const supplied = input.tool_use_id ?? input.event_id ?? input.hook_event_id;
  const idDigest = sha256(typeof supplied === "string" && supplied
    ? supplied : JSON.stringify([input.timestamp || null, input.tool_name || null, input.tool_input || input.tool_args || null]));
  return {
    idDigest,
    eventDigest: sha256(JSON.stringify([idDigest, input.tool_name || null, actions, Boolean(success)]))
  };
}

async function statePaths(root, laneDigest) {
  const directory = join(await projectStateDir(root), "delivery-verification");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${laneDigest}.json`);
  return { path, lockPath: `${path}.lock` };
}

async function readState(path, laneDigest) {
  try {
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("delivery verification state exceeds 64 KiB");
    return normalizeState(JSON.parse(content), laneDigest);
  } catch (error) {
    if (error.code === "ENOENT") return emptyState(laneDigest);
    if (error instanceof SyntaxError) throw new Error("delivery verification state is not valid JSON");
    throw error;
  }
}

async function saveState(path, state, assertOwned) {
  seal(state);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("delivery verification state exceeds 64 KiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await assertOwned();
    await replaceFileWithRetry(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function receipt(input, eventDigest, family = null) {
  return {
    eventDigest,
    toolName: String(input.tool_name || "unknown").slice(0, 128),
    family,
    at: timestamp(input.timestamp)
  };
}

export async function recordDeliveryToolUse({ root, host, sessionId, scope, input, success }) {
  const material = laneMaterial({ host, sessionId, scope });
  const actions = deliveryToolActions(input);
  if (!material || !actions.length) return { status: "not-applicable", blocked: false };
  const laneDigest = sha256(material);
  const paths = await statePaths(root, laneDigest);
  try {
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, laneDigest);
      const identity = eventIdentity(input, actions, success);
      const known = state.recentEvents.find((item) => item.idDigest === identity.idDigest);
      if (known) {
        if (known.eventDigest !== identity.eventDigest) {
          state.conflict = identity.idDigest;
          state.revision += 1;
          await saveState(paths.path, state, assertOwned);
          return { status: "conflict", blocked: false };
        }
        return { status: "duplicate", blocked: false };
      }
      for (const action of actions) {
        if (action.kind === "write") {
          state.lastWrite = receipt(input, identity.eventDigest);
          state.pauseEventDigest = null;
        } else if (success) {
          state.lastTest = receipt(input, identity.eventDigest, action.family);
          state.verifiedWriteDigest = state.lastWrite?.eventDigest || null;
        }
      }
      state.recentEvents.push(identity);
      state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
      state.revision += 1;
      await saveState(paths.path, state, assertOwned);
      return {
        status: actions.some((item) => item.kind === "write") ? "write-recorded" : success ? "test-recorded" : "test-failed",
        blocked: false,
        pending: Boolean(state.lastWrite && state.verifiedWriteDigest !== state.lastWrite.eventDigest)
      };
    });
  } catch (error) {
    return { status: "degraded", blocked: false, reason: error.message };
  }
}

export async function recordDeliveryPause({ root, host, sessionId, scope, eventId }) {
  const material = laneMaterial({ host, sessionId, scope });
  const identity = stopIdentity(eventId, sessionId);
  if (!material || !identity) {
    return { status: "paused-job", blocked: false };
  }
  const laneDigest = sha256(material);
  const paths = await statePaths(root, laneDigest);
  try {
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      const state = await readState(paths.path, laneDigest);
      state.pauseEventDigest = sha256(identity);
      state.revision += 1;
      await saveState(paths.path, state, assertOwned);
      return { status: "paused-job", blocked: false };
    });
  } catch (error) {
    return { status: "degraded-pause", blocked: false, reason: error.message };
  }
}

export async function verifyDeliveryStop({ root, host, sessionId, scope, eventId = null }) {
  const material = laneMaterial({ host, sessionId, scope });
  if (!material) return { status: "not-applicable", blocked: false };
  const laneDigest = sha256(material);
  const paths = await statePaths(root, laneDigest);
  try {
    return await withOwnedFileLock(paths.lockPath, async () => {
      const state = await readState(paths.path, laneDigest);
      const identity = stopIdentity(eventId, sessionId);
      if (identity && state.pauseEventDigest === sha256(identity)) {
        return { status: "paused-job", blocked: false };
      }
      if (state.conflict) {
        return { status: "blocked", blocked: true,
          reason: "AgentSpine cannot verify tool history because one tool delivery ID had conflicting results." };
      }
      if (state.lastWrite && state.verifiedWriteDigest !== state.lastWrite.eventDigest) {
        return { status: "blocked", blocked: true,
          reason: "AgentSpine cannot accept this delivery: run a successful test after the latest write (node --test, npm test, npm run check, or pytest)." };
      }
      return { status: state.lastWrite ? "verified" : "no-write", blocked: false,
        testFamily: state.lastTest?.family || null };
    });
  } catch (error) {
    return { status: "blocked", blocked: true,
      reason: `AgentSpine cannot verify post-write tests: ${String(error.message).slice(0, 400)}` };
  }
}

export async function deliveryVerificationPath({ root, host, sessionId, scope }) {
  const material = laneMaterial({ host, sessionId, scope });
  if (!material) return null;
  return (await statePaths(root, sha256(material))).path;
}
