import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { projectStateDir } from "./paths.js";
import {
  EVIDENCE_TYPES, PRIVACY, ID_RE, MAX_STATE_BYTES, SECRET_RE, AUTHORITY_ASSERTION_RE,
  emptyLearning
} from "./learning-schema.js";
import {
  normalizeState
} from "./learning-state-upgrade.js";
import {
  validConfig
} from "./learning-scope-targets.js";
import {
  visible
} from "./learning-context.js";

export function date(value, field = "date") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

export function number(value, field, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function integer(value, field, minimum, maximum) {
  const parsed = number(value, field, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

export function relativePath(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a project-relative path`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must be a project-relative path`);
  }
  return normalized;
}

export function safeText(value, field, maximum) {
  if (!value || typeof value !== "string") throw new Error(`${field} is required`);
  const text = value.trim().slice(0, maximum);
  if (SECRET_RE.test(text)) throw new Error(`${field} appears to contain a secret and cannot enter learning state`);
  return text;
}

export function assertSafeClaim(claim) {
  if (AUTHORITY_ASSERTION_RE.test(claim)) {
    throw new Error("authority and access claims cannot become learned context");
  }
}

export function isGroupMember(graph, groupId, entityId) {
  if (!entityId || entityId === groupId) return true;
  return graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
    (edge.from === entityId && edge.to === groupId) || (edge.to === entityId && edge.from === groupId)
  ));
}

export function validateScope(privacy, groupId, graph, subjectId) {
  if (!PRIVACY.has(privacy)) throw new Error(`unsupported privacy scope: ${privacy}`);
  if (subjectId !== null && !graph.entities.some((entity) => entity.id === subjectId)) throw new Error(`unknown subject entity: ${subjectId}`);
  if (privacy === "group") {
    if (!groupId) throw new Error("group privacy requires groupId");
    const group = graph.entities.find((entity) => entity.id === groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
    if (!isGroupMember(graph, groupId, subjectId)) throw new Error(`subject is not a visible member of group: ${groupId}`);
  } else if (groupId !== null && groupId !== undefined) {
    throw new Error("groupId is only valid with group privacy");
  }
}

export async function readState(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("learning state exceeds the 5 MiB read limit");
    return normalizeState(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyLearning(root);
  }
}

export async function loadLearning(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const learningPath = join(directory, "learning.json");
  return { learning: await readState(learningPath, catalog.root), learningPath, catalog };
}

export async function inspectLearning(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const learningPath = join(directory, "learning.json");
  try {
    return { learning: await readState(learningPath, catalog.root), learningPath, catalog, error: null };
  } catch (error) {
    return { learning: emptyLearning(catalog.root), learningPath, catalog, error: error.message };
  }
}

export async function saveState(state, path, beforeReplace = null) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("learning state exceeds 5 MiB; reject or delete old candidates first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await beforeReplace?.();
        await rename(temporary, path);
        break;
      } catch (error) {
        const transientWindowsReplace = process.platform === "win32"
          && ["EACCES", "EBUSY", "EPERM"].includes(error.code);
        if (!transientWindowsReplace || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    });
    throw error;
  }
}

export async function withLock(path, root, task) {
  const lockPath = `${path}.lock`;
  return withOwnedFileLock(lockPath, async ({ assertOwned }) => {
    const state = await readState(path, root);
    if (!validConfig(state.config)) throw new Error("learning configuration is invalid; run the audit before learning");
    const result = await task(state);
    await saveState(state, path, assertOwned);
    return result;
  }).catch((error) => {
    if (error.message === "state is busy; retry shortly") {
      throw new Error("learning state is busy; retry shortly");
    }
    throw error;
  });
}

export async function mutation(root, operation, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { learningPath } = await loadLearning(catalog.root, catalog);
  return withLock(learningPath, catalog.root, async (state) => operation(state, catalog, learningPath));
}

export function preserve(state, kind, value, now) {
  if (!value) return;
  state.history.push({
    kind,
    recordId: value.id || "config",
    subjectId: value.subjectId || null,
    supersededAt: now,
    privacy: value.privacy || "private",
    value: { ...value, authority: "context-only" },
    authority: "context-only"
  });
}

export function normalizeEvidence(input, catalog, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("evidence is required");
  const id = input.id || `evidence:${randomUUID()}`;
  if (!ID_RE.test(id)) throw new Error("evidence.id must be a stable, whitespace-free identifier");
  const type = input.type || "interaction";
  if (!EVIDENCE_TYPES.has(type)) throw new Error(`unsupported evidence type: ${type}`);
  const sourceDocument = relativePath(input.sourceDocument, "evidence.sourceDocument");
  let sourceSha256 = null;
  if (sourceDocument !== null) {
    const source = catalog.documents.find((document) => document.relativePath === sourceDocument);
    if (!source) throw new Error(`unknown evidence source document: ${sourceDocument}`);
    sourceSha256 = source.sha256;
  }
  if (type === "document" && !sourceDocument) throw new Error("document evidence requires sourceDocument");
  return {
    id,
    type,
    summary: safeText(input.summary, "evidence.summary", 500),
    sourceDocument,
    sourceSha256,
    confidence: number(input.confidence ?? 0.5, "evidence.confidence", 0, 1),
    observedAt: date(input.observedAt || now, "evidence.observedAt"),
    authority: "context-only"
  };
}

export function evidenceConfidence(evidence) {
  if (!evidence.length) return 0;
  return evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length;
}
