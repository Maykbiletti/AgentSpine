import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";

const KINDS = new Set(["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference"]);
const EVIDENCE_TYPES = new Set(["user-statement", "document", "interaction", "test"]);
const PRIVACY = new Set(["private", "shared", "group"]);
const STATUSES = new Set(["candidate", "accepted", "rejected", "superseded", "rolled-back"]);
const AUTO_KINDS = new Set(["project-fact", "reference"]);
const CONTINUITY_AUTO_KINDS = new Set(["preference", "no-go", "correction", "project-fact", "reference"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const AUTHORITY_ASSERTION_RE = /\b(?:user|agent|person|they|he|she|i|ich|wir|nutzer|benutzer).{0,60}\b(?:may|can|is allowed|is authorized|has|have|darf|berechtigt|hat|haben).{0,50}\b(?:admin(?:istrator)?|permissions?|rights?|authorization|production access|deploy|billing|spending|policy exception|bypass|zugang|rechte|berechtigung|produktion|abrechnung|ausnahme|umgehen)\b/i;

function defaults() {
  return { autoPromote: false, minConfidence: 0.85, minEvidence: 2, maxContextItems: 12 };
}

function emptyLearning(root) {
  return {
    schema: "agentspine.learning/v1",
    root,
    config: defaults(),
    candidates: [],
    history: []
  };
}

function normalizeState(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "agentspine.learning/v1" || value.root !== root
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)
    || !Array.isArray(value.candidates) || !value.candidates.every((item) => item && typeof item === "object" && Array.isArray(item.evidence))
    || !Array.isArray(value.history) || !value.history.every((item) => item && typeof item === "object")) {
    throw new Error("learning state structure is invalid; run the audit before learning");
  }
  return value;
}

function validConfig(config) {
  return typeof config?.autoPromote === "boolean"
    && Number.isFinite(config.minConfidence) && config.minConfidence >= 0.5 && config.minConfidence <= 1
    && Number.isInteger(config.minEvidence) && config.minEvidence >= 1 && config.minEvidence <= 10
    && Number.isInteger(config.maxContextItems) && config.maxContextItems >= 1 && config.maxContextItems <= 50;
}

function date(value, field = "date") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function number(value, field, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function integer(value, field, minimum, maximum) {
  const parsed = number(value, field, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function relativePath(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a project-relative path`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} must be a project-relative path`);
  }
  return normalized;
}

function safeText(value, field, maximum) {
  if (!value || typeof value !== "string") throw new Error(`${field} is required`);
  const text = value.trim().slice(0, maximum);
  if (SECRET_RE.test(text)) throw new Error(`${field} appears to contain a secret and cannot enter learning state`);
  return text;
}

function assertSafeClaim(claim) {
  if (AUTHORITY_ASSERTION_RE.test(claim)) {
    throw new Error("authority and access claims cannot become learned context");
  }
}

function isGroupMember(graph, groupId, entityId) {
  if (!entityId || entityId === groupId) return true;
  return graph.entityEdges.some((edge) => edge.relation === "member-of" && edge.privacy !== "private" && (
    (edge.from === entityId && edge.to === groupId) || (edge.to === entityId && edge.from === groupId)
  ));
}

function validateScope(privacy, groupId, graph, subjectId) {
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

async function readState(path, root) {
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

async function saveState(state, path) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("learning state exceeds 5 MiB; reject or delete old candidates first");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
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

async function withLock(path, root, task) {
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("learning state is busy; retry shortly");
  try {
    const state = await readState(path, root);
    if (!validConfig(state.config)) throw new Error("learning configuration is invalid; run the audit before learning");
    const result = await task(state);
    await saveState(state, path);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function mutation(root, operation) {
  const catalog = await buildCatalog(root);
  const { learningPath } = await loadLearning(catalog.root, catalog);
  return withLock(learningPath, catalog.root, async (state) => operation(state, catalog, learningPath));
}

function preserve(state, kind, value, now) {
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

function normalizeEvidence(input, catalog, now) {
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

function evidenceConfidence(evidence) {
  if (!evidence.length) return 0;
  return evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length;
}

export async function proposeLearning({
  root = process.cwd(), id = `learning:${randomUUID()}`, kind, claim, subjectId = null,
  privacy = "private", groupId = null, evidence, supersedesId = null, now = new Date()
}) {
  if (!ID_RE.test(id)) throw new Error("id must be a stable, whitespace-free identifier");
  if (!KINDS.has(kind)) throw new Error(`unsupported learning kind: ${kind}`);
  claim = safeText(claim, "claim", 1000);
  assertSafeClaim(claim);
  const timestamp = date(now, "now");
  return mutation(root, async (state, catalog, learningPath) => {
    if (state.candidates.some((candidate) => candidate.id === id)) {
      throw new Error("learning candidate IDs are immutable; add evidence or propose a superseding candidate");
    }
    const { graph } = await loadGraph(catalog.root, catalog);
    validateScope(privacy, groupId, graph, subjectId);
    const normalizedEvidence = normalizeEvidence(evidence, catalog, timestamp);
    const superseded = supersedesId ? state.candidates.find((candidate) => candidate.id === supersedesId) : null;
    if (supersedesId && (!superseded || superseded.status !== "accepted")) {
      throw new Error(`supersedesId must reference an accepted learning: ${supersedesId}`);
    }
    if (superseded && (superseded.kind !== kind || superseded.subjectId !== subjectId || superseded.privacy !== privacy || superseded.groupId !== groupId)) {
      throw new Error("a superseding candidate must keep kind, subject, and privacy scope");
    }
    const candidate = {
      id,
      kind,
      claim,
      subjectId,
      privacy,
      groupId,
      status: "candidate",
      evidence: [normalizedEvidence],
      confidence: normalizedEvidence.confidence,
      supersedesId,
      supersededIds: [],
      automatic: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      acceptedAt: null,
      authority: "context-only"
    };
    state.candidates.push(candidate);
    state.candidates.sort((a, b) => a.id.localeCompare(b.id));
    return { candidate, learningPath };
  });
}

export async function addLearningEvidence({ root = process.cwd(), id, evidence, now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, catalog, learningPath) => {
    const previous = state.candidates.find((candidate) => candidate.id === id);
    if (!previous) throw new Error(`unknown learning candidate: ${id}`);
    if (previous.status !== "candidate") throw new Error("evidence can only be added to an unreviewed candidate");
    const item = normalizeEvidence(evidence, catalog, timestamp);
    if (previous.evidence.some((entry) => entry.id === item.id)) throw new Error(`duplicate evidence id: ${item.id}`);
    preserve(state, "learning-candidate", previous, timestamp);
    const candidate = {
      ...previous,
      evidence: [...previous.evidence, item],
      confidence: evidenceConfidence([...previous.evidence, item]),
      updatedAt: timestamp,
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === id ? candidate : entry);
    return { candidate, learningPath };
  });
}

function acceptCandidate(state, candidate, timestamp, automatic, promotion = null) {
  preserve(state, "learning-candidate", candidate, timestamp);
  const superseded = candidate.supersedesId
    ? state.candidates.find((entry) => entry.id === candidate.supersedesId && entry.status === "accepted")
    : null;
  if (candidate.supersedesId && !superseded) throw new Error("the learning being superseded is no longer active");
  if (superseded) {
    preserve(state, "learning-candidate", superseded, timestamp);
    state.candidates = state.candidates.map((entry) => entry.id === superseded.id
      ? { ...entry, status: "superseded", updatedAt: timestamp, authority: "context-only" }
      : entry);
  }
  const accepted = {
    ...candidate,
    status: "accepted",
    supersededIds: superseded ? [superseded.id] : [],
    automatic,
    promotion,
    acceptedAt: timestamp,
    updatedAt: timestamp,
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? accepted : entry);
  return accepted;
}

export async function reviewLearning({
  root = process.cwd(), id, decision, reason, confirmedByUser = false, now = new Date()
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  if (!new Set(["accept", "reject"]).has(decision)) throw new Error("decision must be accept or reject");
  const reviewReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`unknown learning candidate: ${id}`);
    if (candidate.status !== "candidate") throw new Error("only an unreviewed candidate can be reviewed");
    if (decision === "accept") {
      if (!confirmedByUser) throw new Error("acceptance requires explicit user confirmation");
      const accepted = acceptCandidate(state, candidate, timestamp, false, null);
      accepted.review = { decision, reason: reviewReason, confirmedByUser: true, reviewedAt: timestamp, authority: "context-only" };
      return { candidate: accepted, learningPath };
    }
    preserve(state, "learning-candidate", candidate, timestamp);
    const rejected = {
      ...candidate,
      status: "rejected",
      updatedAt: timestamp,
      review: { decision, reason: reviewReason, confirmedByUser: false, reviewedAt: timestamp, authority: "context-only" },
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === id ? rejected : entry);
    return { candidate: rejected, learningPath };
  });
}

function distinctEvidence(candidate) {
  return new Set(candidate.evidence.map((item) => item.sourceSha256 || item.sourceDocument || item.id)).size;
}

export async function evaluateLearning({ root = process.cwd(), now = new Date() } = {}) {
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const accepted = [];
    if (state.config.autoPromote) {
      for (const candidate of state.candidates.filter((entry) => entry.status === "candidate")) {
        if (!AUTO_KINDS.has(candidate.kind)) continue;
        if (candidate.confidence < state.config.minConfidence) continue;
        if (distinctEvidence(candidate) < state.config.minEvidence) continue;
        accepted.push(acceptCandidate(state, candidate, timestamp, true, {
          mode: "automatic-low-risk",
          minConfidence: state.config.minConfidence,
          minEvidence: state.config.minEvidence,
          evidenceCount: distinctEvidence(candidate),
          evaluatedAt: timestamp,
          authority: "context-only"
        }));
      }
    }
    return { enabled: state.config.autoPromote, accepted, learningPath, authority: "context-only" };
  });
}

/**
 * Internal runtime promotion path for locally opted-in continuity signals.
 * This is intentionally not exposed over MCP. The caller must provide the
 * directness, confidence, repetition and local opt-in proof recorded by the
 * continuity state machine.
 */
export async function acceptContinuityLearning({
  root = process.cwd(), id, proof, now = new Date()
}) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  if (!proof || proof.mode !== "automatic-continuity-low-risk" || proof.localOptIn !== true) {
    throw new Error("continuity promotion requires a recorded local opt-in proof");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`unknown learning candidate: ${id}`);
    if (candidate.status === "accepted") return { candidate, learningPath, unchanged: true };
    if (candidate.status !== "candidate") throw new Error("only an active candidate can be promoted");
    if (!CONTINUITY_AUTO_KINDS.has(candidate.kind)) throw new Error("learning kind is not eligible for continuity promotion");
    const minConfidence = number(proof.minConfidence, "proof.minConfidence", 0.9, 1);
    const minEvidence = integer(proof.minEvidence, "proof.minEvidence", 1, 10);
    const minDirectness = number(proof.minDirectness, "proof.minDirectness", 0.9, 1);
    const directness = number(proof.directness, "proof.directness", 0, 1);
    const evidenceCount = distinctEvidence(candidate);
    if (candidate.confidence < minConfidence || directness < minDirectness || evidenceCount < minEvidence) {
      throw new Error("continuity candidate does not meet the recorded promotion thresholds");
    }
    const accepted = acceptCandidate(state, candidate, timestamp, true, {
      mode: "automatic-continuity-low-risk",
      localOptIn: true,
      minConfidence,
      minEvidence,
      minDirectness,
      directness,
      evidenceCount,
      evaluatedAt: timestamp,
      authority: "context-only"
    });
    return { candidate: accepted, learningPath, unchanged: false };
  });
}

export async function rollbackLearning({ root = process.cwd(), id, reason, now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  const rollbackReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate || candidate.status !== "accepted") throw new Error("only an accepted learning can be rolled back");
    preserve(state, "learning-candidate", candidate, timestamp);
    const restored = [];
    for (const previousId of candidate.supersededIds || []) {
      const previous = state.candidates.find((entry) => entry.id === previousId);
      if (previous?.status === "superseded") {
        preserve(state, "learning-candidate", previous, timestamp);
        state.candidates = state.candidates.map((entry) => entry.id === previousId
          ? { ...entry, status: "accepted", updatedAt: timestamp, authority: "context-only" }
          : entry);
        restored.push(previousId);
      }
    }
    const rolledBack = {
      ...candidate,
      status: "rolled-back",
      updatedAt: timestamp,
      rollback: { reason: rollbackReason, rolledBackAt: timestamp, authority: "context-only" },
      authority: "context-only"
    };
    state.candidates = state.candidates.map((entry) => entry.id === id ? rolledBack : entry);
    return { candidate: rolledBack, restored, learningPath };
  });
}

function groupEntities(graph, groupId, includePrivate) {
  const result = new Set();
  if (!groupId) return result;
  result.add(groupId);
  for (const edge of graph.entityEdges) {
    if (edge.relation !== "member-of" || (!includePrivate && edge.privacy === "private")) continue;
    if (edge.to === groupId) result.add(edge.from);
    if (edge.from === groupId) result.add(edge.to);
  }
  return result;
}

function visible(candidate, entities, audience, includePrivate, groupId) {
  if (candidate.privacy === "private" && !includePrivate) return false;
  if (candidate.privacy === "group" && (!groupId || candidate.groupId !== groupId)) return false;
  if (candidate.privacy === "group" && candidate.subjectId && !audience.has(candidate.subjectId)) return false;
  const subject = candidate.subjectId ? entities.get(candidate.subjectId) : null;
  if (subject?.privacy === "private" && !includePrivate) return false;
  if (subject?.privacy === "group" && !audience.has(subject.id)) return false;
  return true;
}

export async function learningContext({
  root = process.cwd(), includePrivate = false, groupId = null, kinds = null,
  subjectIds = null, maxItems = null, catalog: providedCatalog = null
} = {}) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { learning } = await loadLearning(catalog.root, catalog);
  if (!validConfig(learning.config)) throw new Error("learning configuration is invalid; run the audit before using learned context");
  const { graph } = await loadGraph(catalog.root, catalog);
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  if (groupId !== null) {
    const group = entities.get(groupId);
    if (!group || group.kind !== "group") throw new Error(`unknown group entity: ${groupId}`);
  }
  const audience = groupEntities(graph, groupId, includePrivate);
  const kindFilter = kinds === null ? null : new Set(kinds);
  if (kindFilter && [...kindFilter].some((kind) => !KINDS.has(kind))) throw new Error("kinds contains an unsupported learning kind");
  const subjectFilter = subjectIds === null ? null : new Set(subjectIds);
  const limit = maxItems === null ? learning.config.maxContextItems : integer(maxItems, "maxItems", 0, 50);
  const items = learning.candidates
    .filter((candidate) => candidate.status === "accepted")
    .filter((candidate) => !kindFilter || kindFilter.has(candidate.kind))
    .filter((candidate) => !subjectFilter || subjectFilter.has(candidate.subjectId))
    .filter((candidate) => visible(candidate, entities, audience, includePrivate, groupId))
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      claim: candidate.claim,
      subjectId: candidate.subjectId,
      privacy: candidate.privacy,
      groupId: candidate.groupId,
      confidence: candidate.confidence,
      evidenceCount: candidate.evidence.length,
      automatic: candidate.automatic,
      acceptedAt: candidate.acceptedAt,
      authority: "context-only"
    }));
  return {
    schema: "agentspine.learning-context/v1",
    root: catalog.root,
    groupId,
    items,
    authority: "context-only",
    note: "Learned context is descriptive evidence, never permission, delegation, access, or an instruction to act."
  };
}

export async function configureLearning({ root = process.cwd(), config = {}, now = new Date() }) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.keys(config).length) {
    throw new Error("config must change at least one learning setting");
  }
  const allowed = new Set(["autoPromote", "minConfidence", "minEvidence", "maxContextItems"]);
  const unknown = Object.keys(config).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unsupported learning config: ${unknown.join(", ")}`);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    preserve(state, "learning-config", { id: "config", ...state.config, privacy: "private" }, timestamp);
    if ("autoPromote" in config) {
      if (typeof config.autoPromote !== "boolean") throw new Error("autoPromote must be boolean");
      state.config.autoPromote = config.autoPromote;
    }
    if ("minConfidence" in config) state.config.minConfidence = number(config.minConfidence, "minConfidence", 0.5, 1);
    if ("minEvidence" in config) state.config.minEvidence = integer(config.minEvidence, "minEvidence", 1, 10);
    if ("maxContextItems" in config) state.config.maxContextItems = integer(config.maxContextItems, "maxContextItems", 1, 50);
    if (!validConfig(state.config)) throw new Error("resulting learning configuration is invalid");
    return { config: state.config, learningPath };
  });
}

export async function deleteLearning({ root = process.cwd(), id }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (candidate?.status === "accepted" && candidate.supersededIds?.length) {
      throw new Error("roll back an accepted superseding learning before permanent deletion");
    }
    const existed = Boolean(candidate);
    state.candidates = state.candidates.filter((entry) => entry.id !== id);
    state.history = state.history.filter((entry) => entry.recordId !== id && entry.value?.id !== id);
    return { deleted: existed, id, learningPath };
  });
}

export async function purgeLearningBySubject({ root = process.cwd(), subjectId }) {
  if (!ID_RE.test(subjectId || "")) throw new Error("subjectId is required");
  return mutation(root, (state, _catalog, learningPath) => {
    const ids = new Set(state.candidates.filter((entry) => entry.subjectId === subjectId).map((entry) => entry.id));
    state.candidates = state.candidates.filter((entry) => entry.subjectId !== subjectId);
    state.history = state.history.filter((entry) => entry.subjectId !== subjectId && !ids.has(entry.recordId) && !ids.has(entry.value?.id));
    return { deleted: ids.size, subjectId, learningPath };
  });
}

export function learningFindings(learning, graph) {
  const findings = [];
  if (!validConfig(learning.config)) findings.push("invalid-config");
  const groups = new Set(graph.entities.filter((entity) => entity.kind === "group").map((entity) => entity.id));
  for (const candidate of learning.candidates) {
    if (!KINDS.has(candidate.kind) || !STATUSES.has(candidate.status) || !PRIVACY.has(candidate.privacy)) findings.push(`invalid-candidate:${candidate.id}`);
    const nested = [...(candidate.evidence || []), candidate.review, candidate.rollback, candidate.promotion].filter(Boolean);
    if (candidate.authority !== "context-only" || nested.some((item) => item.authority !== "context-only")) findings.push(`authority:${candidate.id}`);
    if (SECRET_RE.test(candidate.claim || "") || AUTHORITY_ASSERTION_RE.test(candidate.claim || "")) findings.push(`unsafe-claim:${candidate.id}`);
    if (candidate.evidence?.some((item) => SECRET_RE.test(item.summary || ""))) findings.push(`unsafe-evidence:${candidate.id}`);
    const evidenceValid = candidate.evidence.length > 0 && candidate.evidence.every((item) => (
      ID_RE.test(item.id || "") && EVIDENCE_TYPES.has(item.type)
      && typeof item.summary === "string" && item.summary.length > 0
      && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
      && Number.isFinite(new Date(item.observedAt).getTime())
      && (item.type !== "document" || (item.sourceDocument && /^[a-f0-9]{64}$/.test(item.sourceSha256 || "")))
    ));
    if (!evidenceValid || !Number.isFinite(candidate.confidence)
      || Math.abs(candidate.confidence - evidenceConfidence(candidate.evidence)) > 1e-12) {
      findings.push(`invalid-evidence:${candidate.id}`);
    }
    if (candidate.privacy === "group" && (!groups.has(candidate.groupId) || !isGroupMember(graph, candidate.groupId, candidate.subjectId))) findings.push(`invalid-group:${candidate.id}`);
    if (candidate.status === "accepted") {
      const manualProof = candidate.automatic === false
        && candidate.review?.decision === "accept" && candidate.review?.confirmedByUser === true;
      const automaticProof = candidate.automatic === true
        && ((AUTO_KINDS.has(candidate.kind)
          && candidate.promotion?.mode === "automatic-low-risk"
          && candidate.confidence >= candidate.promotion?.minConfidence
          && distinctEvidence(candidate) >= candidate.promotion?.minEvidence
          && candidate.promotion?.evidenceCount >= candidate.promotion?.minEvidence)
        || (CONTINUITY_AUTO_KINDS.has(candidate.kind)
          && candidate.promotion?.mode === "automatic-continuity-low-risk"
          && candidate.promotion?.localOptIn === true
          && candidate.confidence >= candidate.promotion?.minConfidence
          && candidate.promotion?.directness >= candidate.promotion?.minDirectness
          && distinctEvidence(candidate) >= candidate.promotion?.minEvidence
          && candidate.promotion?.evidenceCount >= candidate.promotion?.minEvidence));
      if (!candidate.acceptedAt || (!manualProof && !automaticProof)) findings.push(`invalid-acceptance:${candidate.id}`);
    }
  }
  for (const entry of learning.history) {
    const value = entry.value || {};
    const nested = [...(value.evidence || []), value.review, value.rollback, value.promotion].filter(Boolean);
    if (entry.authority !== "context-only" || value.authority !== "context-only" || nested.some((item) => item.authority !== "context-only")) {
      findings.push(`history-authority:${entry.recordId || "unknown"}`);
    }
    if (SECRET_RE.test(value.claim || "") || AUTHORITY_ASSERTION_RE.test(value.claim || "")
      || value.evidence?.some((item) => SECRET_RE.test(item.summary || ""))) {
      findings.push(`unsafe-history:${entry.recordId || "unknown"}`);
    }
  }
  return findings;
}
