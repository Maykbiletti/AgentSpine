import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { loadGraph } from "./graph.js";
import {
  acceptContinuityLearning, addLearningEvidence, loadLearning,
  proposeLearning, purgeLearningBySubject
} from "./learning.js";
import { projectStateDir } from "./paths.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";

const SCHEMA = "agentspine.continuity/v1";
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const SAFE_KINDS = new Set(["preference", "no-go", "correction", "project-fact", "reference"]);
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret|passwort|geheimnis)\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const BLOCKED_RE = /\b(?:birthday|birthdate|geburtstag|relationship|beziehung|spouse|partner|children?|kinder?|pets?|haustiere?|address|adresse|phone|telefon|e-?mail|health|gesundheit|medical|medizin|diagnosis|diagnose|religion|politic|politik|sexual|finances?|finanzen|salary|gehalt|same person|same identity|alias of|merge identit|identit(?:y|ät)|permission|permissions|rights?|roles?|delegat|authorized|authorisation|authorization|berechtigt|rechte|rolle|freigabe|approval|approve|admin|deploy|production|produktion|billing|payment|zahlung|spending|network|netzwerk|database|datenbank|tool access|dateizugriff|file access|private group|private gruppe|private chat|privater chat|permisos?|derechos?|autorizad[oa]|roles?|delegación|aprobación|producción|pagos?|red|base de datos|rättigheter|behörighet|roller?|delegering|godkännande|produktion|betalning|nätverk|databas|privat grupp|privat chatt)\b/i;

function defaults() {
  return {
    enabled: false,
    minConfidence: 0.95,
    minDirectness: 0.95,
    minEvidence: 2,
    maxPromptBytes: 16384,
    maxBriefingBytes: 16384,
    defaultEntityId: null,
    defaultProjectId: null
  };
}

function emptyState(root) {
  return { schema: SCHEMA, root, config: defaults(), signals: [], history: [] };
}

function validConfig(config) {
  return config && typeof config.enabled === "boolean"
    && Number.isFinite(config.minConfidence) && config.minConfidence >= 0.9 && config.minConfidence <= 1
    && Number.isFinite(config.minDirectness) && config.minDirectness >= 0.9 && config.minDirectness <= 1
    && Number.isInteger(config.minEvidence) && config.minEvidence >= 1 && config.minEvidence <= 10
    && Number.isInteger(config.maxPromptBytes) && config.maxPromptBytes >= 1024 && config.maxPromptBytes <= 65536
    && Number.isInteger(config.maxBriefingBytes) && config.maxBriefingBytes >= 4096 && config.maxBriefingBytes <= 262144
    && (config.defaultEntityId === null || ID_RE.test(config.defaultEntityId))
    && (config.defaultProjectId === null || ID_RE.test(config.defaultProjectId));
}

function normalizeState(value, root) {
  if (!value || value.schema !== SCHEMA || value.root !== root || !validConfig(value.config)
    || !Array.isArray(value.signals) || !Array.isArray(value.history)) {
    throw new Error("continuity state structure is invalid; automatic recall is disabled until repaired");
  }
  return value;
}

function timestamp(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("now must be a valid date");
  return parsed.toISOString();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readState(path, root) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("continuity state exceeds its 2 MiB read limit");
    return normalizeState(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyState(root);
  }
}

async function saveState(state, path) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("continuity state exceeds 2 MiB");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path);
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
      if (!isFileLockContention(error)) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 15000) await unlink(lockPath);
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("continuity state is busy; retry shortly");
  try {
    const state = await readState(path, root);
    const result = await task(state);
    await saveState(state, path);
    return result;
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function loadContinuity(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const continuityPath = join(directory, "continuity.json");
  return { continuity: await readState(continuityPath, catalog.root), continuityPath, catalog };
}

export async function inspectContinuity(root = process.cwd(), providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  const continuityPath = join(directory, "continuity.json");
  try {
    return { continuity: await readState(continuityPath, catalog.root), continuityPath, error: null, catalog };
  } catch (error) {
    return { continuity: emptyState(catalog.root), continuityPath, error: error.message, catalog };
  }
}

async function mutate(root, task, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
  const { continuityPath } = await loadContinuity(catalog.root, catalog);
  return withLock(continuityPath, catalog.root, (state) => task(state, catalog, continuityPath));
}

function validateConfiguredEntity(graph, id, kind = null) {
  if (id === null) return;
  const entity = graph.entities.find((item) => item.id === id);
  if (!entity || (kind && entity.kind !== kind)) throw new Error(`unknown ${kind || ""} entity: ${id}`.replace("  ", " "));
}

export async function configureContinuity({ root = process.cwd(), config = {}, confirmation = null, now = new Date() }) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.keys(config).length) {
    throw new Error("config must change at least one continuity setting");
  }
  const allowed = new Set(Object.keys(defaults()));
  const unknown = Object.keys(config).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unsupported continuity config: ${unknown.join(", ")}`);
  if (config.enabled === true && confirmation !== "local-user-opt-in") {
    throw new Error("enabling automatic continuity requires one explicit local user opt-in");
  }
  const at = timestamp(now);
  return mutate(root, async (state, catalog, continuityPath) => {
    const scopeChanges = "defaultEntityId" in config || "defaultProjectId" in config;
    if (state.config.enabled && scopeChanges && confirmation !== "local-user-opt-in") {
      throw new Error("changing an enabled automatic-continuity scope requires explicit local user confirmation");
    }
    const next = { ...state.config, ...config };
    if (!validConfig(next)) throw new Error("resulting continuity configuration is invalid");
    const { graph } = await loadGraph(catalog.root, catalog);
    validateConfiguredEntity(graph, next.defaultEntityId);
    validateConfiguredEntity(graph, next.defaultProjectId);
    state.history.push({ kind: "config", at, previous: state.config, authority: "context-only" });
    state.config = next;
    return { config: next, continuityPath, authority: "context-only" };
  });
}

function fragment(value) {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").slice(0, 280);
}

function detectSignal(prompt) {
  const rules = [
    { kind: "no-go", re: /^(?:please\s+)?(?:never|do not|don't|bitte\s+nie|niemals|por favor\s+nunca|nunca|vänligen\s+aldrig|aldrig)\s+(.+)$/i, prefix: "Avoid: ", explicit: true },
    { kind: "correction", re: /^(?:correction|korrektur|nein|corrección|korrigering)[,:]\s*(.+)$/i, prefix: "Correction: ", explicit: true },
    { kind: "preference", re: /^(?:please|bitte|por favor|vänligen)\s+(?:always\s+|immer\s+|siempre\s+|alltid\s+)?(?:answer|respond|write|antworte|schreibe|responde|escribe|svara|skriv)\s+(?:always\s+|immer\s+|siempre\s+|alltid\s+)?(.+)$/i, prefix: "Response preference: ", explicit: true },
    { kind: "preference", re: /^(?:svara|skriv|responde|escribe)\s+(?:alltid|siempre)\s+(.+)$/i, prefix: "Response preference: ", explicit: true },
    { kind: "preference", re: /^(?:i prefer|ich bevorzuge|ich möchte|prefiero|quiero|jag föredrar|jag vill)\s+(.+)$/i, prefix: "Preference: ", explicit: true },
    { kind: "project-fact", re: /^(?:the project|das projekt|el proyecto|projektet)\s+(?:uses|verwendet|ist|usa|utiliza|es|använder|är)\s+(.+)$/i, prefix: "Project fact: ", explicit: false },
    { kind: "reference", re: /^(?:reference|referenz|referencia|referens)\s*:\s*(.+)$/i, prefix: "Reference: ", explicit: false }
  ];
  for (const rule of rules) {
    const match = prompt.trim().match(rule.re);
    if (!match) continue;
    const value = fragment(match[1]);
    if (!value) return null;
    return { kind: rule.kind, claim: `${rule.prefix}${value}`, confidence: 0.98, directness: 1, explicit: rule.explicit };
  }
  return null;
}

function assertSafeSignal(signal, prompt, scope) {
  if (!SAFE_KINDS.has(signal.kind)) throw new Error("signal kind cannot be learned automatically");
  if (scope.groupId !== null) throw new Error("group conversation content cannot be learned automatically");
  if (SECRET_RE.test(prompt) || SECRET_RE.test(signal.claim)) throw new Error("secret-shaped conversation content was rejected");
  if (BLOCKED_RE.test(prompt) || BLOCKED_RE.test(signal.claim)) throw new Error("sensitive, identity, authority, or operational content was rejected");
}

export async function captureContinuityPrompt({
  root = process.cwd(), prompt, entityId = null, groupId = null, projectId = null,
  eventId = null, now = new Date(), userStateRoot = null, catalog: providedCatalog = null,
  userCatalog: providedUserCatalog = null
}) {
  const storageCatalog = userStateRoot && userStateRoot !== root
    ? providedUserCatalog : providedCatalog;
  const { continuity, catalog } = await loadContinuity(userStateRoot || root, storageCatalog);
  if (!continuity.config.enabled) return { enabled: false, captured: false, reason: "opt-in-disabled", authority: "context-only" };
  if (typeof prompt !== "string" || Buffer.byteLength(prompt) > continuity.config.maxPromptBytes) {
    throw new Error("prompt payload is missing or exceeds the configured byte limit");
  }
  const detected = detectSignal(prompt);
  if (!detected) return { enabled: true, captured: false, reason: "no-minimal-safe-signal", authority: "context-only" };
  const storageRoot = detected.kind === "project-fact" ? root : userStateRoot || root;
  const subjectId = detected.kind === "project-fact" ? projectId : entityId || projectId;
  if (!subjectId || !ID_RE.test(subjectId)) throw new Error("automatic learning requires an exact known person or project identity");
  if (groupId !== null && !ID_RE.test(groupId)) throw new Error("groupId is invalid");
  const targetCatalog = storageRoot === catalog.root ? catalog
    : providedCatalog || await buildCatalog(storageRoot);
  const { graph } = await loadGraph(targetCatalog.root, targetCatalog);
  const subject = graph.entities.find((item) => item.id === subjectId);
  if (!subject) throw new Error(`automatic learning requires a known canonical identity: ${subjectId}`);
  if (subjectId === projectId && subject.kind !== "project") throw new Error("projectId must identify a project");
  if (subjectId === entityId && !["person", "agent"].includes(subject.kind)) throw new Error("entityId must identify a person or agent");
  const scope = { entityId, groupId, projectId };
  assertSafeSignal(detected, prompt, scope);
  const at = timestamp(now);
  const signalKey = `${subjectId}\0${groupId || ""}\0${detected.kind}\0${detected.claim.toLocaleLowerCase("en")}`;
  const learningId = `learning:auto:${digest(signalKey).slice(0, 32)}`;
  const promptDigest = digest(prompt);
  const receiptId = eventId && ID_RE.test(eventId) ? eventId : `signal:${promptDigest.slice(0, 32)}`;
  const eventKey = digest(`${receiptId}\0${signalKey}\0${promptDigest}`);

  const recorded = await mutate(storageRoot, (state, catalog, continuityPath) => {
    if (!state.config.enabled) return { duplicate: false, disabled: true, config: state.config, continuityPath, catalog };
    const duplicate = state.signals.some((item) => item.eventKey === eventKey);
    if (duplicate) return { duplicate: true, disabled: false, config: state.config, continuityPath, catalog };
    state.signals.push({
      eventKey, receiptId, promptDigest, learningId, kind: detected.kind, subjectId,
      groupId, projectId, confidence: detected.confidence, directness: detected.directness, explicit: detected.explicit,
      observedAt: at, authority: "context-only"
    });
    state.history.push({ kind: "signal-observed", eventKey, learningId, subjectId, observedAt: at, authority: "context-only" });
    return { duplicate: false, disabled: false, config: state.config, continuityPath, catalog };
  }, targetCatalog);
  if (recorded.disabled) return { enabled: false, captured: false, reason: "opt-in-disabled", authority: "context-only" };

  const evidence = {
    id: `evidence:${eventKey.slice(0, 32)}`,
    type: "user-statement",
    summary: `Direct ${detected.kind} signal captured by the opted-in lifecycle adapter; prompt digest ${promptDigest.slice(0, 16)}.`,
    confidence: detected.confidence,
    observedAt: at
  };
  let existing = (await loadLearning(storageRoot, targetCatalog)).learning.candidates.find((item) => item.id === learningId);
  if (!existing) {
    try {
      await proposeLearning({
        root: storageRoot, id: learningId, kind: detected.kind, claim: detected.claim, subjectId,
        privacy: subjectId === projectId ? "shared" : "private", groupId: null, evidence, now: at,
        catalog: targetCatalog
      });
    } catch (error) {
      if (!/candidate IDs are immutable/.test(error.message)) throw error;
    }
    existing = (await loadLearning(storageRoot, targetCatalog)).learning.candidates.find((item) => item.id === learningId);
  }
  if (existing?.status === "candidate" && !existing.evidence.some((item) => item.id === evidence.id)) {
    try {
      await addLearningEvidence({ root: storageRoot, id: learningId, evidence, now: at, catalog: targetCatalog });
    } catch (error) {
      if (!/duplicate evidence id|unreviewed candidate/.test(error.message)) throw error;
    }
  }
  const refreshed = (await loadLearning(storageRoot, targetCatalog)).learning.candidates.find((item) => item.id === learningId);
  let accepted = refreshed?.status === "accepted";
  if (!accepted && refreshed?.status === "candidate") {
    const distinct = new Set(refreshed.evidence.map((item) => item.id)).size;
    const requiredEvidence = detected.explicit ? 1 : recorded.config.minEvidence;
    if (refreshed.confidence >= recorded.config.minConfidence
      && detected.directness >= recorded.config.minDirectness
      && distinct >= requiredEvidence) {
      await acceptContinuityLearning({
        root: storageRoot, id: learningId, now: at, catalog: targetCatalog,
        proof: {
          mode: "automatic-continuity-low-risk", localOptIn: true,
          minConfidence: recorded.config.minConfidence,
          minDirectness: recorded.config.minDirectness,
          minEvidence: requiredEvidence,
          directness: detected.directness
        }
      });
      accepted = true;
    }
  }
  return {
    enabled: true, captured: !recorded.duplicate, duplicate: recorded.duplicate,
    learningId, accepted, kind: detected.kind, authority: "context-only"
  };
}

export async function purgeContinuity({ root = process.cwd(), subjectId, confirmation = null, now = new Date() }) {
  if (!ID_RE.test(subjectId || "")) throw new Error("subjectId is required");
  if (confirmation !== "local-user-confirmed") throw new Error("continuity purge requires explicit local user confirmation");
  const at = timestamp(now);
  const result = await mutate(root, (state, _catalog, continuityPath) => {
    const signalCount = state.signals.filter((item) => item.subjectId === subjectId).length;
    state.signals = state.signals.filter((item) => item.subjectId !== subjectId);
    state.history = state.history.filter((item) => item.subjectId !== subjectId);
    state.history.push({ kind: "subject-purged", subjectId: digest(subjectId), at, authority: "context-only" });
    return { signalCount, continuityPath };
  });
  const learning = await purgeLearningBySubject({ root, subjectId });
  return { subjectId, deletedSignals: result.signalCount, deletedLearning: learning.deleted, authority: "context-only" };
}

export function continuityFindings(continuity) {
  const findings = [];
  if (!validConfig(continuity.config)) findings.push("invalid-config");
  const eventKeys = new Set();
  for (const item of continuity.signals) {
    if (!/^[a-f0-9]{64}$/.test(item.eventKey || "") || eventKeys.has(item.eventKey)) findings.push(`invalid-or-duplicate-signal:${item.eventKey || "unknown"}`);
    eventKeys.add(item.eventKey);
    if (!SAFE_KINDS.has(item.kind) || item.groupId !== null || typeof item.explicit !== "boolean" || item.authority !== "context-only") findings.push(`unsafe-signal:${item.eventKey || "unknown"}`);
  }
  if (continuity.history.some((item) => item.authority !== "context-only")) findings.push("history-authority");
  return findings;
}
