import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention } from "./filesystem-retry.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";

const KINDS = new Set(["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference", "behavior"]);
const EVIDENCE_TYPES = new Set(["user-statement", "document", "interaction", "test"]);
const PRIVACY = new Set(["private", "shared", "group"]);
const STATUSES = new Set(["candidate", "accepted", "rejected", "superseded", "rolled-back"]);
const AUTO_KINDS = new Set(["project-fact", "reference"]);
const OUTCOME_AUTO_KINDS = new Set(["behavior"]);
const CONTINUITY_AUTO_KINDS = new Set(["preference", "no-go", "correction", "project-fact", "reference"]);
const OUTCOME_PHASES = new Set(["before", "after"]);
const MEASUREMENT_KINDS = new Set(["objective", "user-feedback", "model-suggestion"]);
const METRIC_DIRECTIONS = new Set(["higher", "lower"]);
const SCOPE_FIELDS = ["personaId", "userId", "tenantId", "projectId", "groupId", "taskId"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const AUTHORITY_ASSERTION_RE = /\b(?:user|agent|person|they|he|she|i|ich|wir|nutzer|benutzer).{0,60}\b(?:may|can|is allowed|is authorized|has|have|darf|berechtigt|hat|haben).{0,50}\b(?:admin(?:istrator)?|permissions?|rights?|authorization|production access|deploy|billing|spending|policy exception|bypass|zugang|rechte|berechtigung|produktion|abrechnung|ausnahme|umgehen)\b/i;
const PROTECTED_LESSON_RE = /\b(?:security|safety|identity|authentication|authorization|permissions?|credentials?|secrets?|policy|production|deployment|payments?|billing|tool access|file access|network access|database access|sicherheit|identität|authentifizierung|berechtigungen?|zugang|richtlinie|produktion|zahlungen?)\b/i;

function defaults() {
  return {
    autoPromote: false,
    minConfidence: 0.85,
    minEvidence: 2,
    maxContextItems: 12,
    minOutcomeReceipts: 2,
    minImprovement: 0.05,
    regressionTolerance: 0,
    outcomeMaxAgeDays: 30,
    canaryReceipts: 2,
    canaryTtlDays: 14
  };
}

function emptyLearning(root) {
  return {
    schema: "agentspine.learning/v1",
    root,
    config: defaults(),
    candidates: [],
    outcomes: [],
    applications: [],
    deliveries: [],
    evaluations: [],
    history: []
  };
}

function normalizeState(value, root) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "agentspine.learning/v1" || value.root !== root
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)
    || !Array.isArray(value.candidates) || !value.candidates.every((item) => item && typeof item === "object" && Array.isArray(item.evidence))
    || (value.outcomes !== undefined && (!Array.isArray(value.outcomes) || !value.outcomes.every((item) => item && typeof item === "object")))
    || (value.applications !== undefined && (!Array.isArray(value.applications) || !value.applications.every((item) => item && typeof item === "object")))
    || (value.deliveries !== undefined && (!Array.isArray(value.deliveries) || !value.deliveries.every((item) => item && typeof item === "object")))
    || (value.evaluations !== undefined && (!Array.isArray(value.evaluations) || !value.evaluations.every((item) => item && typeof item === "object")))
    || !Array.isArray(value.history) || !value.history.every((item) => item && typeof item === "object")) {
    throw new Error("learning state structure is invalid; run the audit before learning");
  }
  const normalized = {
    ...value,
    config: { ...defaults(), ...value.config },
    candidates: value.candidates.map((candidate) => ({
      ...candidate,
      scope: normalizeStoredScope(candidate.scope, candidate.subjectId, candidate.groupId),
      requiresLocalReview: candidate.requiresLocalReview ?? PROTECTED_LESSON_RE.test(candidate.claim || "")
    })),
    outcomes: value.outcomes || [],
    applications: value.applications || [],
    deliveries: value.deliveries || [],
    evaluations: value.evaluations || []
  };
  if (normalized.outcomes.some((receipt) => !storedOutcomeStructure(receipt))) {
    throw new Error("learning outcome state is invalid; run the audit before learning");
  }
  if (normalized.applications.some((receipt) => !storedApplicationStructure(receipt))) {
    throw new Error("learning application state is invalid; run the audit before learning");
  }
  if (normalized.deliveries.some((receipt) => !storedDeliveryStructure(receipt))) {
    throw new Error("learning delivery state is invalid; run the audit before learning");
  }
  if (normalized.evaluations.some((contract) => !storedEvaluationStructure(contract))) {
    throw new Error("learning evaluation state is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => {
    const candidate = normalized.candidates.find((item) => item.id === receipt.learningId);
    return !candidate || !scopeContains(candidate.scope, receipt.scope);
  })) throw new Error("learning outcome scope is invalid; run the audit before learning");
  if (normalized.applications.some((receipt) => {
    const candidate = normalized.candidates.find((item) => item.id === receipt.learningId);
    return !candidate || !scopeContains(candidate.scope, receipt.scope);
  })) throw new Error("learning application scope is invalid; run the audit before learning");
  if (normalized.deliveries.some((receipt) => {
    const application = normalized.applications.find((item) => item.id === receipt.applicationId);
    return !application || application.learningId !== receipt.learningId
      || application.schema !== "agentspine.learning-application/v2"
      || application.sessionId !== receipt.sessionId || application.preflightReceiptId !== receipt.preflightReceiptId
      || !exactScope(application.scope, receipt.scope)
      || new Date(receipt.completedAt).getTime() < new Date(application.projectedAt).getTime()
      || new Date(receipt.completedAt).getTime() > new Date(application.deliveryExpiresAt).getTime();
  })) throw new Error("learning delivery binding is invalid; run the audit before learning");
  if (normalized.evaluations.some((contract) => {
    const candidate = normalized.candidates.find((item) => item.id === contract.learningId);
    return !candidate || !scopeContains(candidate.scope, contract.scope);
  })) throw new Error("learning evaluation scope is invalid; run the audit before learning");
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v2", "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(receipt.schema)
    && receipt.phase === "after" && !normalized.applications.some((application) => application.id === receipt.applicationId
      && application.learningId === receipt.learningId && exactScope(application.scope, receipt.scope)
      && new Date(receipt.measuredAt).getTime() >= new Date(application.projectedAt).getTime()
      && new Date(receipt.measuredAt).getTime() <= new Date(application.expiresAt).getTime()))) {
    throw new Error("learning outcome application binding is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(receipt.schema)
    && !normalized.evaluations.some((contract) => contract.id === receipt.evaluationId
      && contract.learningId === receipt.learningId && exactScope(contract.scope, receipt.scope)
      && contract.metric.name === receipt.metric.name && contract.metric.direction === receipt.metric.direction
      && contract.evaluatorIds.includes(receipt.measurement.evaluatorId)
      && new Date(receipt.measuredAt).getTime() >= new Date(contract.registeredAt).getTime()
      && new Date(receipt.measuredAt).getTime() <= new Date(contract.expiresAt).getTime()))) {
    throw new Error("learning outcome evaluation binding is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => receipt.schema === "agentspine.learning-outcome/v5"
    && !normalized.evaluations.some((contract) => contract.id === receipt.evaluationId
      && contract.schema === "agentspine.learning-evaluation/v2"
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases))) {
    throw new Error("learning outcome coverage binding is invalid; run the audit before learning");
  }
  if (normalized.outcomes.some((receipt) => ["agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(receipt.schema)
    && (receipt.phase === "after" ? !normalized.deliveries.some((delivery) => delivery.id === receipt.deliveryId
      && delivery.applicationId === receipt.applicationId && delivery.learningId === receipt.learningId
      && exactScope(delivery.scope, receipt.scope)
      && new Date(receipt.measuredAt).getTime() >= new Date(delivery.completedAt).getTime()) : receipt.deliveryId !== null))) {
    throw new Error("learning outcome delivery binding is invalid; run the audit before learning");
  }
  if (normalized.candidates.some((candidate) => candidate.status === "accepted"
    && candidate.promotion?.mode === "outcome-canary" && candidate.promotion.canary?.evaluationId
    && !normalized.evaluations.some((contract) => contract.id === candidate.promotion.canary.evaluationId
      && contract.learningId === candidate.id && contract.digest === candidate.promotion.canary.evaluationDigest
      && exactScope(contract.scope, candidate.promotion.canary.scope)))) {
    throw new Error("learning canary evaluation binding is invalid; run the audit before learning");
  }
  return normalized;
}

function validConfig(config) {
  return typeof config?.autoPromote === "boolean"
    && Number.isFinite(config.minConfidence) && config.minConfidence >= 0.5 && config.minConfidence <= 1
    && Number.isInteger(config.minEvidence) && config.minEvidence >= 1 && config.minEvidence <= 10
    && Number.isInteger(config.maxContextItems) && config.maxContextItems >= 1 && config.maxContextItems <= 50
    && Number.isInteger(config.minOutcomeReceipts) && config.minOutcomeReceipts >= 2 && config.minOutcomeReceipts <= 10
    && Number.isFinite(config.minImprovement) && config.minImprovement >= 0 && config.minImprovement <= 1
    && Number.isFinite(config.regressionTolerance) && config.regressionTolerance >= 0 && config.regressionTolerance <= 1
    && Number.isInteger(config.outcomeMaxAgeDays) && config.outcomeMaxAgeDays >= 1 && config.outcomeMaxAgeDays <= 365
    && Number.isInteger(config.canaryReceipts) && config.canaryReceipts >= 1 && config.canaryReceipts <= 10
    && Number.isInteger(config.canaryTtlDays) && config.canaryTtlDays >= 1 && config.canaryTtlDays <= 90;
}

function normalizeStoredScope(scope, subjectId = null, groupId = null) {
  const source = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
  const normalized = {};
  for (const field of SCOPE_FIELDS) normalized[field] = source[field] ?? null;
  if (normalized.groupId === null && groupId) normalized.groupId = groupId;
  return normalized;
}

function normalizeScope(scope, subjectId = null, groupId = null) {
  const normalized = normalizeStoredScope(scope, subjectId, groupId);
  for (const [field, value] of Object.entries(normalized)) {
    if (value !== null && !ID_RE.test(value)) throw new Error(`scope.${field} must be a stable, whitespace-free identifier`);
  }
  return normalized;
}

function scopeKey(scope) {
  return JSON.stringify(SCOPE_FIELDS.map((field) => scope?.[field] ?? null));
}

function scopeContains(candidateScope, runtimeScope) {
  return SCOPE_FIELDS.every((field) => candidateScope?.[field] === null || candidateScope?.[field] === runtimeScope?.[field]);
}

function exactScope(left, right) {
  return scopeKey(left) === scopeKey(right);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function storedOutcomeStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = outcomePayload(receipt);
  const legacy = receipt.schema === "agentspine.learning-outcome/v1";
  const bound = receipt.schema === "agentspine.learning-outcome/v2";
  const planned = receipt.schema === "agentspine.learning-outcome/v3";
  const delivered = receipt.schema === "agentspine.learning-outcome/v4";
  const covered = receipt.schema === "agentspine.learning-outcome/v5";
  return (legacy || bound || planned || delivered || covered) && ID_RE.test(receipt.id || "")
    && ID_RE.test(receipt.learningId || "") && OUTCOME_PHASES.has(receipt.phase)
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && typeof receipt.metric?.name === "string" && receipt.metric.name.length > 0
    && METRIC_DIRECTIONS.has(receipt.metric?.direction)
    && Number.isFinite(receipt.metric?.value) && receipt.metric.value >= 0 && receipt.metric.value <= 1
    && Number.isInteger(receipt.metric?.blockingDefects) && receipt.metric.blockingDefects >= 0
    && MEASUREMENT_KINDS.has(receipt.measurement?.kind) && ID_RE.test(receipt.measurement?.evaluatorId || "")
    && (receipt.measurement?.sourceDigest === null || DIGEST_RE.test(receipt.measurement?.sourceDigest || ""))
    && (legacy ? receipt.applicationId === undefined : (receipt.phase === "before"
      ? receipt.applicationId === null : ID_RE.test(receipt.applicationId || "")))
    && (!(planned || delivered || covered) || ID_RE.test(receipt.evaluationId || ""))
    && (!(delivered || covered) || (receipt.phase === "before" ? receipt.deliveryId === null : ID_RE.test(receipt.deliveryId || "")))
    && (!covered || (DIGEST_RE.test(receipt.coverage?.datasetDigest || "")
      && Number.isInteger(receipt.coverage?.caseCount) && receipt.coverage.caseCount >= 1
      && receipt.coverage.caseCount <= 1000000 && receipt.coverage?.authority === "context-only"))
    && receipt.authority === "context-only" && receipt.measurement?.authority === "context-only"
    && Number.isFinite(new Date(receipt.measuredAt).getTime()) && receipt.digest === digest(payload);
}

function evaluationPayload({ id, learningId, scope, metric, benchmark, evaluatorIds, thresholds,
  registeredAt, expiresAt, schema = "agentspine.learning-evaluation/v1" }) {
  return {
    schema, id, learningId, scope, metric, benchmark,
    evaluatorIds, thresholds, registeredAt, expiresAt, authority: "context-only"
  };
}

function storedEvaluationStructure(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return false;
  const payload = evaluationPayload(contract);
  return ["agentspine.learning-evaluation/v1", "agentspine.learning-evaluation/v2"].includes(contract.schema)
    && ID_RE.test(contract.id || "") && ID_RE.test(contract.learningId || "")
    && SCOPE_FIELDS.every((field) => contract.scope?.[field] === null || ID_RE.test(contract.scope?.[field] || ""))
    && typeof contract.metric?.name === "string" && contract.metric.name.length > 0
    && METRIC_DIRECTIONS.has(contract.metric?.direction)
    && [contract.benchmark?.taskDigest, contract.benchmark?.datasetDigest, contract.benchmark?.protocolDigest]
      .every((value) => DIGEST_RE.test(value || ""))
    && Number.isInteger(contract.benchmark?.minCases) && contract.benchmark.minCases >= 1
    && Array.isArray(contract.evaluatorIds) && contract.evaluatorIds.length >= 2
    && new Set(contract.evaluatorIds).size === contract.evaluatorIds.length
    && contract.evaluatorIds.every((id) => ID_RE.test(id || ""))
    && Number.isFinite(contract.thresholds?.minImprovement) && contract.thresholds.minImprovement >= 0
    && contract.thresholds.minImprovement <= 1
    && Number.isFinite(contract.thresholds?.regressionTolerance) && contract.thresholds.regressionTolerance >= 0
    && contract.thresholds.regressionTolerance <= 1
    && Number.isInteger(contract.thresholds?.beforeReceipts) && contract.thresholds.beforeReceipts >= 2
    && Number.isInteger(contract.thresholds?.afterReceipts) && contract.thresholds.afterReceipts >= 1
    && Number.isFinite(new Date(contract.registeredAt).getTime())
    && Number.isFinite(new Date(contract.expiresAt).getTime())
    && new Date(contract.expiresAt).getTime() > new Date(contract.registeredAt).getTime()
    && contract.authority === "context-only" && contract.digest === digest(payload);
}

function applicationPayload({ id, learningId, scope, preflightReceiptId, promptDigest,
  preflightBriefingDigest, sessionBriefingDigest, sessionId, projectedAt, deliveryExpiresAt, expiresAt,
  schema = "agentspine.learning-application/v1" }) {
  return {
    schema, id, learningId, scope,
    preflightReceiptId, promptDigest, preflightBriefingDigest, sessionBriefingDigest,
    ...(schema === "agentspine.learning-application/v2" ? { sessionId, deliveryExpiresAt } : {}),
    projectedAt, expiresAt, authority: "context-only"
  };
}

function storedApplicationStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = applicationPayload(receipt);
  const legacy = receipt.schema === "agentspine.learning-application/v1";
  const delivered = receipt.schema === "agentspine.learning-application/v2";
  return (legacy || delivered) && ID_RE.test(receipt.id || "")
    && ID_RE.test(receipt.learningId || "") && ID_RE.test(receipt.preflightReceiptId || "")
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && [receipt.promptDigest, receipt.preflightBriefingDigest, receipt.sessionBriefingDigest]
      .every((value) => /^[a-f0-9]{64}$/.test(value || ""))
    && Number.isFinite(new Date(receipt.projectedAt).getTime())
    && Number.isFinite(new Date(receipt.expiresAt).getTime())
    && new Date(receipt.expiresAt).getTime() >= new Date(receipt.projectedAt).getTime()
    && (!delivered || (ID_RE.test(receipt.sessionId || "")
      && Number.isFinite(new Date(receipt.deliveryExpiresAt).getTime())
      && new Date(receipt.deliveryExpiresAt).getTime() >= new Date(receipt.projectedAt).getTime()
      && new Date(receipt.deliveryExpiresAt).getTime() <= new Date(receipt.expiresAt).getTime()))
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
}

function deliveryPayload({ id, applicationId, learningId, scope, sessionId, preflightReceiptId,
  hookEvent, completedAt }) {
  return {
    schema: "agentspine.learning-delivery/v1", id, applicationId, learningId, scope,
    sessionId, preflightReceiptId, hookEvent, completedAt, authority: "context-only"
  };
}

function storedDeliveryStructure(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const payload = deliveryPayload(receipt);
  return receipt.schema === "agentspine.learning-delivery/v1" && ID_RE.test(receipt.id || "")
    && ID_RE.test(receipt.applicationId || "") && ID_RE.test(receipt.learningId || "")
    && ID_RE.test(receipt.sessionId || "") && ID_RE.test(receipt.preflightReceiptId || "")
    && SCOPE_FIELDS.every((field) => receipt.scope?.[field] === null || ID_RE.test(receipt.scope?.[field] || ""))
    && ["Stop", "SubagentStop"].includes(receipt.hookEvent)
    && Number.isFinite(new Date(receipt.completedAt).getTime())
    && receipt.authority === "context-only" && receipt.digest === digest(payload);
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

async function mutation(root, operation, providedCatalog = null) {
  const catalog = providedCatalog || await buildCatalog(root);
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
  privacy = "private", groupId = null, scope = null, evidence, supersedesId = null, now = new Date(),
  catalog: providedCatalog = null
}) {
  if (!ID_RE.test(id)) throw new Error("id must be a stable, whitespace-free identifier");
  if (!KINDS.has(kind)) throw new Error(`unsupported learning kind: ${kind}`);
  claim = safeText(claim, "claim", 1000);
  assertSafeClaim(claim);
  const normalizedScope = normalizeScope(scope, subjectId, groupId);
  if (normalizedScope.groupId !== (groupId ?? null)) throw new Error("scope.groupId must match the privacy groupId");
  const timestamp = date(now, "now");
  return mutation(root, async (state, catalog, learningPath) => {
    if (state.candidates.some((candidate) => candidate.id === id)) {
      throw new Error("learning candidate IDs are immutable; add evidence or propose a superseding candidate");
    }
    const { graph } = await loadGraph(catalog.root, catalog);
    validateScope(privacy, groupId, graph, subjectId);
    const duplicate = state.candidates.find((candidate) => candidate.kind === kind
      && candidate.claim === claim && exactScope(candidate.scope, normalizedScope)
      && candidate.privacy === privacy && candidate.status !== "rejected" && candidate.status !== "rolled-back");
    if (duplicate) return { candidate: duplicate, learningPath, unchanged: true };
    const normalizedEvidence = normalizeEvidence(evidence, catalog, timestamp);
    const superseded = supersedesId ? state.candidates.find((candidate) => candidate.id === supersedesId) : null;
    if (supersedesId && (!superseded || superseded.status !== "accepted")) {
      throw new Error(`supersedesId must reference an accepted learning: ${supersedesId}`);
    }
    if (superseded && (superseded.kind !== kind || superseded.subjectId !== subjectId || superseded.privacy !== privacy
      || superseded.groupId !== groupId || !exactScope(superseded.scope, normalizedScope))) {
      throw new Error("a superseding candidate must keep kind, subject, and privacy scope");
    }
    const conflictsWith = state.candidates.filter((candidate) => candidate.kind === kind
      && candidate.claim !== claim && exactScope(candidate.scope, normalizedScope)
      && ["candidate", "accepted"].includes(candidate.status) && candidate.id !== supersedesId)
      .map((candidate) => candidate.id).sort();
    if (conflictsWith.length) {
      state.candidates = state.candidates.map((candidate) => conflictsWith.includes(candidate.id)
        ? { ...candidate, conflictsWith: [...new Set([...(candidate.conflictsWith || []), id])].sort(), updatedAt: timestamp }
        : candidate);
    }
    const candidate = {
      id,
      kind,
      claim,
      subjectId,
      privacy,
      groupId,
      scope: normalizedScope,
      status: "candidate",
      evidence: [normalizedEvidence],
      confidence: normalizedEvidence.confidence,
      supersedesId,
      supersededIds: [],
      conflictsWith,
      requiresLocalReview: PROTECTED_LESSON_RE.test(claim),
      automatic: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      acceptedAt: null,
      authority: "context-only"
    };
    state.candidates.push(candidate);
    state.candidates.sort((a, b) => a.id.localeCompare(b.id));
    return { candidate, learningPath };
  }, providedCatalog);
}

export async function addLearningEvidence({
  root = process.cwd(), id, evidence, now = new Date(), catalog: providedCatalog = null
}) {
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
  }, providedCatalog);
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

export async function registerLearningEvaluation({
  root = process.cwd(), id = `evaluation:${randomUUID()}`, learningId, scope, metric, benchmark,
  evaluatorIds, expiresAt = null, confirmLocalEvaluation = false, now = new Date()
}) {
  if (!confirmLocalEvaluation) throw new Error("evaluation registration requires explicit local confirmation");
  if (!ID_RE.test(id || "") || !ID_RE.test(learningId || "")) {
    throw new Error("evaluation id and learningId must be stable identifiers");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (!candidate) throw new Error(`unknown learning candidate: ${learningId}`);
    if (candidate.kind !== "behavior" || candidate.status !== "candidate" || candidate.requiresLocalReview) {
      throw new Error("evaluation contracts are limited to unreviewed, low-risk behavior candidates");
    }
    const normalizedScope = normalizeScope(scope);
    if (!scopeContains(candidate.scope, normalizedScope)) throw new Error("evaluation scope does not match the learning candidate");
    const name = safeText(metric?.name, "evaluation.metric.name", 120);
    const direction = metric?.direction;
    if (!METRIC_DIRECTIONS.has(direction)) throw new Error("evaluation.metric.direction must be higher or lower");
    const digests = {
      taskDigest: benchmark?.taskDigest,
      datasetDigest: benchmark?.datasetDigest,
      protocolDigest: benchmark?.protocolDigest
    };
    if (Object.entries(digests).some(([, value]) => !DIGEST_RE.test(value || ""))) {
      throw new Error("evaluation benchmark digests must be SHA-256 values");
    }
    const normalizedEvaluators = [...new Set((evaluatorIds || []).map((value) => String(value)))].sort();
    const requiredEvaluators = Math.max(state.config.minOutcomeReceipts, state.config.canaryReceipts, 2);
    if (normalizedEvaluators.length < requiredEvaluators || normalizedEvaluators.some((value) => !ID_RE.test(value))) {
      throw new Error(`evaluation requires at least ${requiredEvaluators} distinct stable evaluator IDs`);
    }
    const expiry = date(expiresAt || new Date(new Date(timestamp).getTime()
      + state.config.outcomeMaxAgeDays * 86400000), "evaluation.expiresAt");
    if (new Date(expiry).getTime() <= new Date(timestamp).getTime()
      || new Date(expiry).getTime() > new Date(timestamp).getTime() + 365 * 86400000) {
      throw new Error("evaluation expiry must be in the future and no more than 365 days away");
    }
    const payload = evaluationPayload({
      schema: "agentspine.learning-evaluation/v2",
      id, learningId, scope: normalizedScope, metric: { name, direction },
      benchmark: { ...digests, minCases: integer(benchmark?.minCases, "evaluation.benchmark.minCases", 1, 1000000) },
      evaluatorIds: normalizedEvaluators,
      thresholds: {
        minImprovement: state.config.minImprovement,
        regressionTolerance: state.config.regressionTolerance,
        beforeReceipts: state.config.minOutcomeReceipts,
        afterReceipts: state.config.canaryReceipts
      },
      registeredAt: timestamp, expiresAt: expiry
    });
    const contract = { ...payload, digest: digest(payload) };
    const existing = state.evaluations.find((entry) => entry.id === id);
    if (existing) {
      if (existing.digest === contract.digest) return { contract: existing, learningPath, unchanged: true };
      throw new Error("evaluation contract IDs are immutable");
    }
    if (state.evaluations.some((entry) => entry.learningId === learningId
      && exactScope(entry.scope, normalizedScope) && new Date(entry.expiresAt).getTime() >= new Date(timestamp).getTime())) {
      throw new Error("an active evaluation contract already exists for this learning and exact scope");
    }
    state.evaluations.push(contract);
    state.evaluations.sort((a, b) => a.id.localeCompare(b.id));
    return { contract, learningPath, unchanged: false };
  });
}

function outcomePayload({ schema = "agentspine.learning-outcome/v1", id, learningId, phase, scope, metric, measurement,
  applicationId, deliveryId, evaluationId, coverage, measuredAt }) {
  return {
    schema,
    id,
    learningId,
    phase,
    scope,
    metric,
    measurement,
    ...(["agentspine.learning-outcome/v2", "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(schema) ? { applicationId } : {}),
    ...(["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(schema) ? { evaluationId } : {}),
    ...(["agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(schema) ? { deliveryId } : {}),
    ...(schema === "agentspine.learning-outcome/v5" ? { coverage } : {}),
    measuredAt,
    authority: "context-only"
  };
}

function normalizeOutcome(input, candidate, timestamp, application = null, delivery = null, evaluation = null) {
  const id = input.id || `outcome:${randomUUID()}`;
  if (!ID_RE.test(id)) throw new Error("outcome.id must be a stable, whitespace-free identifier");
  const phase = input.phase;
  if (!OUTCOME_PHASES.has(phase)) throw new Error("outcome.phase must be before or after");
  const scope = normalizeScope(input.scope);
  if (!scopeContains(candidate.scope, scope)) throw new Error("outcome scope does not match the learning candidate");
  if (!evaluation || evaluation.learningId !== candidate.id || !exactScope(evaluation.scope, scope)) {
    throw new Error("outcomes require a matching immutable evaluation contract");
  }
  const name = safeText(input.metric?.name, "outcome.metric.name", 120);
  const direction = input.metric?.direction;
  if (!METRIC_DIRECTIONS.has(direction)) throw new Error("outcome.metric.direction must be higher or lower");
  if (name !== evaluation.metric.name || direction !== evaluation.metric.direction) {
    throw new Error("outcome metric does not match the evaluation contract");
  }
  const metric = {
    name,
    direction,
    value: number(input.metric?.value, "outcome.metric.value", 0, 1),
    blockingDefects: integer(input.metric?.blockingDefects ?? 0, "outcome.metric.blockingDefects", 0, 1000)
  };
  const kind = input.measurement?.kind;
  if (!MEASUREMENT_KINDS.has(kind)) throw new Error("outcome.measurement.kind is unsupported");
  const evaluatorId = input.measurement?.evaluatorId;
  if (!ID_RE.test(evaluatorId || "")) throw new Error("outcome.measurement.evaluatorId is required");
  if (!evaluation.evaluatorIds.includes(evaluatorId)) throw new Error("outcome evaluator is not allowed by the evaluation contract");
  const sourceDigest = input.measurement?.sourceDigest ?? null;
  if (sourceDigest !== null && !/^[a-f0-9]{64}$/.test(sourceDigest)) {
    throw new Error("outcome.measurement.sourceDigest must be a SHA-256 digest");
  }
  const measurement = { kind, evaluatorId, sourceDigest, authority: "context-only" };
  const coverageRequired = evaluation.schema === "agentspine.learning-evaluation/v2";
  const coverage = coverageRequired ? {
    datasetDigest: input.coverage?.datasetDigest,
    caseCount: integer(input.coverage?.caseCount, "outcome.coverage.caseCount", 1, 1000000),
    authority: "context-only"
  } : null;
  if (coverageRequired && coverage.datasetDigest !== evaluation.benchmark.datasetDigest) {
    throw new Error("outcome coverage dataset does not match the evaluation contract");
  }
  if (coverageRequired && coverage.caseCount < evaluation.benchmark.minCases) {
    throw new Error(`outcome coverage requires at least ${evaluation.benchmark.minCases} cases`);
  }
  const measuredAt = date(input.measuredAt || timestamp, "outcome.measuredAt");
  if (new Date(measuredAt).getTime() < new Date(evaluation.registeredAt).getTime()
    || new Date(measuredAt).getTime() > new Date(evaluation.expiresAt).getTime()) {
    throw new Error("outcome is outside its evaluation contract window");
  }
  const applicationId = phase === "after" ? input.applicationId : null;
  const deliveryId = phase === "after" ? input.deliveryId : null;
  if (phase === "after") {
    if (!ID_RE.test(applicationId || "") || !application) throw new Error("after outcomes require a recorded learning application receipt");
    if (application.learningId !== candidate.id || !exactScope(application.scope, scope)) {
      throw new Error("learning application scope does not match the after outcome");
    }
    if (new Date(measuredAt).getTime() < new Date(application.projectedAt).getTime()
      || new Date(measuredAt).getTime() > new Date(application.expiresAt).getTime()) {
      throw new Error("after outcome is outside its learning application window");
    }
    if (!ID_RE.test(deliveryId || "") || !delivery || delivery.applicationId !== application.id
      || delivery.learningId !== candidate.id || !exactScope(delivery.scope, scope)) {
      throw new Error("after outcomes require the matching completed model-turn delivery receipt");
    }
    if (new Date(measuredAt).getTime() < new Date(delivery.completedAt).getTime()) {
      throw new Error("after outcome predates the completed model-turn delivery");
    }
  }
  const payload = outcomePayload({ schema: coverageRequired ? "agentspine.learning-outcome/v5" : "agentspine.learning-outcome/v4",
    id, learningId: candidate.id, phase, scope, metric, measurement, applicationId, deliveryId,
    evaluationId: evaluation.id, coverage, measuredAt });
  return { ...payload, digest: digest(payload) };
}

export async function recordLearningApplications({
  root = process.cwd(), items, scope, preflightReceipt, sessionBriefingDigest, projectedAt = new Date()
}) {
  if (!Array.isArray(items)) throw new Error("learning application items must be an array");
  if (!preflightReceipt || preflightReceipt.schema !== "agentspine.preflight/v2"
    || preflightReceipt.status !== "ready" || !ID_RE.test(preflightReceipt.id || "")
    || !/^[a-f0-9]{64}$/.test(preflightReceipt.promptDigest || "")
    || !/^[a-f0-9]{64}$/.test(preflightReceipt.briefingDigest || "")
    || !ID_RE.test(preflightReceipt.sessionId || "")
    || !/^[a-f0-9]{64}$/.test(sessionBriefingDigest || "")) {
    throw new Error("learning applications require one valid consumed preflight binding");
  }
  const runtimeScope = normalizeScope(scope);
  const timestamp = date(projectedAt, "projectedAt");
  const preflightCreated = new Date(preflightReceipt.createdAt).getTime();
  const preflightExpires = new Date(preflightReceipt.expiresAt).getTime();
  if (!Number.isFinite(preflightCreated) || !Number.isFinite(preflightExpires)
    || preflightCreated > new Date(timestamp).getTime() || preflightExpires < new Date(timestamp).getTime()) {
    throw new Error("learning application preflight binding is stale");
  }
  if (preflightReceipt.agentId !== runtimeScope.personaId || preflightReceipt.userId !== runtimeScope.userId
    || preflightReceipt.tenantId !== runtimeScope.tenantId || preflightReceipt.projectId !== runtimeScope.projectId
    || preflightReceipt.groupId !== runtimeScope.groupId || preflightReceipt.taskId !== runtimeScope.taskId) {
    throw new Error("learning application preflight scope does not match the projected turn");
  }
  return mutation(root, (state, _catalog, learningPath) => {
    const pending = state.applications.filter((application) => application.schema === "agentspine.learning-application/v2"
      && application.sessionId === preflightReceipt.sessionId
      && application.preflightReceiptId !== preflightReceipt.id
      && new Date(application.deliveryExpiresAt).getTime() >= new Date(timestamp).getTime()
      && !state.deliveries.some((delivery) => delivery.applicationId === application.id));
    if (pending.length) {
      throw new Error("this session already has an unconfirmed learning application; await Stop or its bounded expiry");
    }
    const receipts = [];
    for (const item of items.filter((entry) => entry?.outcomeStatus === "active")) {
      const candidate = state.candidates.find((entry) => entry.id === item.id);
      const canary = candidate?.promotion?.canary;
      if (!candidate || candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
        || canary?.status !== "active" || !exactScope(canary.scope, runtimeScope)) {
        throw new Error(`active learning application no longer matches its exact scope: ${item.id || "unknown"}`);
      }
      const expiresAt = canary.expiresAt;
      const deliveryExpiresAt = new Date(Math.min(new Date(expiresAt).getTime(),
        new Date(timestamp).getTime() + 5 * 60_000)).toISOString();
      const material = `${candidate.id}\0${preflightReceipt.id}\0${sessionBriefingDigest}`;
      const id = `application:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
      const payload = applicationPayload({ schema: "agentspine.learning-application/v2", id, learningId: candidate.id, scope: runtimeScope,
        preflightReceiptId: preflightReceipt.id, promptDigest: preflightReceipt.promptDigest,
        preflightBriefingDigest: preflightReceipt.briefingDigest, sessionBriefingDigest,
        sessionId: preflightReceipt.sessionId, projectedAt: timestamp, deliveryExpiresAt, expiresAt });
      const receipt = { ...payload, digest: digest(payload) };
      const existing = state.applications.find((entry) => entry.id === id);
      if (existing) {
        const sameBinding = existing.learningId === receipt.learningId && exactScope(existing.scope, receipt.scope)
          && existing.preflightReceiptId === receipt.preflightReceiptId && existing.promptDigest === receipt.promptDigest
          && existing.preflightBriefingDigest === receipt.preflightBriefingDigest
          && existing.sessionBriefingDigest === receipt.sessionBriefingDigest;
        if (!sameBinding) throw new Error("learning application receipt IDs are immutable");
        receipts.push(existing);
        continue;
      }
      if (state.applications.some((entry) => entry.learningId === candidate.id
        && entry.preflightReceiptId === preflightReceipt.id)) {
        throw new Error("one preflight turn cannot produce conflicting learning application receipts");
      }
      state.applications.push(receipt);
      receipts.push(receipt);
    }
    state.applications.sort((a, b) => a.id.localeCompare(b.id));
    return { schema: "agentspine.learning-application-batch/v2", receipts, learningPath,
      authority: "context-only" };
  });
}

export async function recordLearningDeliveries({
  root = process.cwd(), sessionId, scope, hookEvent, completedAt = new Date()
}) {
  if (!ID_RE.test(sessionId || "")) throw new Error("learning delivery sessionId is required");
  if (!["Stop", "SubagentStop"].includes(hookEvent)) throw new Error("learning delivery requires Stop or SubagentStop");
  const runtimeScope = normalizeScope(scope);
  const timestamp = date(completedAt, "completedAt");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidates = state.applications.filter((application) => application.schema === "agentspine.learning-application/v2"
      && application.sessionId === sessionId && exactScope(application.scope, runtimeScope));
    if (!candidates.length) return { schema: "agentspine.learning-delivery-batch/v1", status: "not-applicable",
      receipts: [], learningPath, authority: "context-only" };
    const latest = [...candidates].sort((a, b) => b.projectedAt.localeCompare(a.projectedAt))[0];
    const batch = candidates.filter((application) => application.preflightReceiptId === latest.preflightReceiptId);
    if (new Date(timestamp).getTime() > new Date(latest.deliveryExpiresAt).getTime()) {
      return { schema: "agentspine.learning-delivery-batch/v1", status: "stale", receipts: [], learningPath,
        authority: "context-only" };
    }
    const receipts = [];
    for (const application of batch) {
      const existingForApplication = state.deliveries.find((entry) => entry.applicationId === application.id);
      if (existingForApplication) {
        if (existingForApplication.sessionId !== sessionId || existingForApplication.hookEvent !== hookEvent
          || !exactScope(existingForApplication.scope, runtimeScope)) {
          throw new Error("one learning application cannot have conflicting delivery receipts");
        }
        receipts.push(existingForApplication);
        continue;
      }
      const id = `delivery:${createHash("sha256").update(`${application.id}\0${hookEvent}`).digest("hex").slice(0, 32)}`;
      const payload = deliveryPayload({ id, applicationId: application.id, learningId: application.learningId,
        scope: runtimeScope, sessionId, preflightReceiptId: application.preflightReceiptId, hookEvent,
        completedAt: timestamp });
      const receipt = { ...payload, digest: digest(payload) };
      if (state.deliveries.some((entry) => entry.id === id)) throw new Error("learning delivery receipt IDs are immutable");
      state.deliveries.push(receipt);
      receipts.push(receipt);
    }
    state.deliveries.sort((a, b) => a.id.localeCompare(b.id));
    return { schema: "agentspine.learning-delivery-batch/v1", status: receipts.length ? "completed" : "not-applicable",
      receipts, learningPath, authority: "context-only" };
  });
}

function outcomeFresh(receipt, config, now) {
  return new Date(receipt.measuredAt).getTime() >= new Date(now).getTime() - config.outcomeMaxAgeDays * 86400000;
}

function outcomeMatchesContract(receipt, contract) {
  if (contract.schema === "agentspine.learning-evaluation/v2") {
    return receipt.schema === "agentspine.learning-outcome/v5"
      && receipt.coverage?.datasetDigest === contract.benchmark.datasetDigest
      && receipt.coverage?.caseCount >= contract.benchmark.minCases;
  }
  return ["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4"].includes(receipt.schema);
}

function promotableReceipts(state, candidate, timestamp) {
  const contracts = state.evaluations.filter((contract) => contract.learningId === candidate.id
    && new Date(contract.expiresAt).getTime() >= new Date(timestamp).getTime());
  const groups = contracts.map((contract) => ({
    contract,
    receipts: state.outcomes.filter((item) => outcomeMatchesContract(item, contract)
      && item.learningId === candidate.id && item.evaluationId === contract.id && item.phase === "before"
      && exactScope(item.scope, contract.scope) && outcomeFresh(item, state.config, timestamp)
      && item.measurement.kind !== "model-suggestion")
  })).filter(({ contract, receipts }) => receipts.some((item) => item.measurement.kind === "objective")
    && new Set(receipts.map((item) => item.measurement.evaluatorId)).size >= contract.thresholds.beforeReceipts)
    .sort((a, b) => b.receipts.length - a.receipts.length || a.contract.id.localeCompare(b.contract.id));
  return groups[0] || null;
}

function improvement(direction, baseline, value) {
  return direction === "higher" ? value - baseline : baseline - value;
}

function rollbackCandidate(state, candidate, reason, timestamp, mode = "manual") {
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
    rollback: { reason, mode, rolledBackAt: timestamp, authority: "context-only" },
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? rolledBack : entry);
  return { candidate: rolledBack, restored };
}

function reconcileCanary(state, candidate, timestamp) {
  const canary = candidate.promotion?.canary;
  if (candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary" || canary?.status !== "active") {
    return { candidate, decision: "unchanged", restored: [] };
  }
  if (new Date(canary.expiresAt).getTime() < new Date(timestamp).getTime()) {
    const result = rollbackCandidate(state, candidate, "outcome canary expired before validation", timestamp, "automatic-stale");
    return { ...result, decision: "rolled-back" };
  }
  const evaluation = canary.evaluationId
    ? state.evaluations.find((contract) => contract.id === canary.evaluationId && contract.learningId === candidate.id)
    : null;
  if (canary.evaluationId && (!evaluation || evaluation.digest !== canary.evaluationDigest
    || new Date(evaluation.expiresAt).getTime() < new Date(timestamp).getTime())) {
    const result = rollbackCandidate(state, candidate, "outcome evaluation contract is missing, changed, or stale", timestamp, "automatic-stale");
    return { ...result, decision: "rolled-back" };
  }
  const planned = Boolean(evaluation);
  const receipts = state.outcomes.filter((item) => (planned
    ? outcomeMatchesContract(item, evaluation)
    : item.schema === "agentspine.learning-outcome/v2")
    && item.learningId === candidate.id && item.phase === "after"
    && (!planned || item.evaluationId === evaluation.id)
    && exactScope(item.scope, canary.scope) && item.metric.name === canary.metric.name
    && item.metric.direction === canary.metric.direction && outcomeFresh(item, state.config, timestamp)
    && state.applications.some((application) => application.id === item.applicationId
      && application.learningId === candidate.id && exactScope(application.scope, canary.scope)));
  if (receipts.some((item) => item.metric.blockingDefects > 0)) {
    const result = rollbackCandidate(state, candidate, "outcome canary recorded a blocking defect", timestamp, "automatic-regression");
    return { ...result, decision: "rolled-back" };
  }
  const eligible = receipts.filter((item) => item.measurement.kind !== "model-suggestion");
  const independentEvaluators = new Set(eligible.map((item) => item.measurement.evaluatorId)).size;
  const independentApplications = new Set(eligible.map((item) => item.applicationId)).size;
  const deltas = eligible.map((item) => improvement(canary.metric.direction, canary.baseline, item.metric.value));
  const thresholds = planned ? evaluation.thresholds : {
    regressionTolerance: state.config.regressionTolerance,
    afterReceipts: state.config.canaryReceipts,
    minImprovement: state.config.minImprovement
  };
  if (deltas.some((value) => value < -thresholds.regressionTolerance)) {
    const result = rollbackCandidate(state, candidate, "outcome canary regressed against its baseline", timestamp, "automatic-regression");
    return { ...result, decision: "rolled-back" };
  }
  if (independentEvaluators < thresholds.afterReceipts || independentApplications < thresholds.afterReceipts
    || !eligible.some((item) => item.measurement.kind === "objective")) {
    return { candidate, decision: "active", restored: [] };
  }
  const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  if (average < thresholds.minImprovement) {
    const result = rollbackCandidate(state, candidate, "outcome canary did not meet the minimum measured improvement", timestamp, "automatic-no-improvement");
    return { ...result, decision: "rolled-back" };
  }
  preserve(state, "learning-candidate", candidate, timestamp);
  const validated = {
    ...candidate,
    promotion: {
      ...candidate.promotion,
      canary: { ...canary, status: "validated", validatedAt: timestamp, afterReceipts: eligible.map((item) => item.id), improvement: average }
    },
    updatedAt: timestamp,
    authority: "context-only"
  };
  state.candidates = state.candidates.map((entry) => entry.id === candidate.id ? validated : entry);
  return { candidate: validated, decision: "validated", restored: [] };
}

export async function recordLearningOutcome({ root = process.cwd(), id, learningId, phase, scope, metric, measurement,
  applicationId = null, deliveryId = null, evaluationId, coverage = null, measuredAt, now = new Date() }) {
  if (!ID_RE.test(learningId || "")) throw new Error("learningId is required");
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === learningId);
    if (!candidate) throw new Error(`unknown learning candidate: ${learningId}`);
    if (!ID_RE.test(evaluationId || "")) throw new Error("evaluationId is required");
    const evaluation = state.evaluations.find((item) => item.id === evaluationId);
    const application = applicationId === null ? null : state.applications.find((item) => item.id === applicationId);
    const delivery = deliveryId === null ? null : state.deliveries.find((item) => item.id === deliveryId);
    const existing = id ? state.outcomes.find((item) => item.id === id) : null;
    if (existing) {
      const retry = normalizeOutcome({ id, phase, scope, metric, measurement, applicationId, deliveryId, evaluationId, coverage,
        measuredAt: measuredAt ?? existing.measuredAt }, candidate, timestamp, application, delivery, evaluation);
      if (existing.digest === retry.digest) {
        return { receipt: existing, candidate, decision: "unchanged", learningPath, unchanged: true };
      }
      throw new Error("outcome receipt IDs are immutable");
    }
    if (phase === "before" && candidate.status !== "candidate") throw new Error("before outcomes require an unreviewed candidate");
    if (phase === "after" && (candidate.status !== "accepted" || candidate.promotion?.mode !== "outcome-canary"
      || candidate.promotion?.canary?.status !== "active")) {
      throw new Error("after outcomes require an active outcome canary");
    }
    const receipt = normalizeOutcome({ id, phase, scope, metric, measurement, applicationId, deliveryId, evaluationId, coverage,
      measuredAt }, candidate, timestamp, application, delivery, evaluation);
    const duplicate = state.outcomes.find((item) => item.digest === receipt.digest);
    if (duplicate) return { receipt: duplicate, candidate, decision: "unchanged", learningPath, unchanged: true };
    state.outcomes.push(receipt);
    state.outcomes.sort((a, b) => a.id.localeCompare(b.id));
    const reconciled = phase === "after" ? reconcileCanary(state, candidate, timestamp) : { candidate, decision: "recorded", restored: [] };
    return { receipt, ...reconciled, learningPath, unchanged: false };
  });
}

export async function evaluateLearning({ root = process.cwd(), now = new Date() } = {}) {
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const accepted = [];
    const reconciled = [];
    for (const current of state.candidates.filter((entry) => entry.status === "accepted" && entry.promotion?.mode === "outcome-canary")) {
      const result = reconcileCanary(state, current, timestamp);
      if (result.decision !== "unchanged" && result.decision !== "active") reconciled.push({ id: current.id, decision: result.decision });
    }
    if (state.config.autoPromote) {
      for (const candidate of state.candidates.filter((entry) => entry.status === "candidate")) {
        if (candidate.confidence < state.config.minConfidence) continue;
        if (distinctEvidence(candidate) < state.config.minEvidence) continue;
        if (candidate.conflictsWith?.some((id) => state.candidates.some((entry) => entry.id === id && ["candidate", "accepted"].includes(entry.status)))) continue;
        if (OUTCOME_AUTO_KINDS.has(candidate.kind)) {
          if (SCOPE_FIELDS.every((field) => candidate.scope?.[field] === null)) continue;
          if (candidate.requiresLocalReview) continue;
          const planned = promotableReceipts(state, candidate, timestamp);
          if (!planned) continue;
          const { contract, receipts } = planned;
          const baseline = receipts.reduce((sum, item) => sum + item.metric.value, 0) / receipts.length;
          accepted.push(acceptCandidate(state, candidate, timestamp, true, {
            mode: "outcome-canary",
            minConfidence: state.config.minConfidence,
            minEvidence: state.config.minEvidence,
            evidenceCount: distinctEvidence(candidate),
            evaluatedAt: timestamp,
            canary: {
              status: "active",
              scope: receipts[0].scope,
              metric: { name: receipts[0].metric.name, direction: receipts[0].metric.direction },
              evaluationId: contract.id,
              evaluationDigest: contract.digest,
              coverage: contract.schema === "agentspine.learning-evaluation/v2" ? {
                datasetDigest: contract.benchmark.datasetDigest,
                minCases: contract.benchmark.minCases,
                authority: "context-only"
              } : null,
              baseline,
              beforeReceipts: receipts.map((item) => item.id),
              expiresAt: new Date(Math.min(new Date(contract.expiresAt).getTime(),
                new Date(timestamp).getTime() + state.config.canaryTtlDays * 86400000)).toISOString()
            },
            authority: "context-only"
          }));
          continue;
        }
        if (AUTO_KINDS.has(candidate.kind)) {
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
    }
    return { enabled: state.config.autoPromote, accepted, reconciled, learningPath, authority: "context-only" };
  });
}

export async function purgeStaleLearningApplications({ root = process.cwd(), confirmation, now = new Date() } = {}) {
  if (confirmation !== "local-user-purge-confirmed") {
    throw new Error("purging stale learning applications requires explicit local confirmation");
  }
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const ids = new Set(state.applications.filter((application) => application.schema === "agentspine.learning-application/v2"
      && new Date(application.deliveryExpiresAt).getTime() < new Date(timestamp).getTime()
      && !state.deliveries.some((delivery) => delivery.applicationId === application.id)).map((application) => application.id));
    state.applications = state.applications.filter((application) => !ids.has(application.id));
    return { schema: "agentspine.learning-delivery-purge/v1", purged: ids.size, applicationIds: [...ids].sort(),
      learningPath, authority: "context-only" };
  });
}

/**
 * Internal runtime promotion path for locally opted-in continuity signals.
 * This is intentionally not exposed over MCP. The caller must provide the
 * directness, confidence, repetition and local opt-in proof recorded by the
 * continuity state machine.
 */
export async function acceptContinuityLearning({
  root = process.cwd(), id, proof, now = new Date(), catalog: providedCatalog = null
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
  }, providedCatalog);
}

export async function rollbackLearning({ root = process.cwd(), id, reason, now = new Date() }) {
  if (!ID_RE.test(id || "")) throw new Error("id is required");
  const rollbackReason = safeText(reason, "reason", 500);
  const timestamp = date(now, "now");
  return mutation(root, (state, _catalog, learningPath) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    if (!candidate || candidate.status !== "accepted") throw new Error("only an accepted learning can be rolled back");
    const result = rollbackCandidate(state, candidate, rollbackReason, timestamp, "manual");
    return { ...result, learningPath };
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
  subjectIds = null, scope = null, maxItems = null, catalog: providedCatalog = null, now = new Date()
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
  const runtimeScope = normalizeScope(scope, null, groupId);
  const kindFilter = kinds === null ? null : new Set(kinds);
  if (kindFilter && [...kindFilter].some((kind) => !KINDS.has(kind))) throw new Error("kinds contains an unsupported learning kind");
  const subjectFilter = subjectIds === null ? null : new Set(subjectIds);
  const limit = maxItems === null ? learning.config.maxContextItems : integer(maxItems, "maxItems", 0, 50);
  const timestamp = date(now, "now");
  const stale = learning.candidates.filter((candidate) => candidate.status === "accepted"
    && candidate.promotion?.mode === "outcome-canary" && candidate.promotion.canary?.status === "active"
    && new Date(candidate.promotion.canary.expiresAt).getTime() < new Date(timestamp).getTime()).map((candidate) => candidate.id);
  const items = learning.candidates
    .filter((candidate) => candidate.status === "accepted")
    .filter((candidate) => !stale.includes(candidate.id))
    .filter((candidate) => scope === null || scopeContains(candidate.scope, runtimeScope))
    .filter((candidate) => candidate.promotion?.mode !== "outcome-canary"
      || exactScope(candidate.promotion.canary.scope, runtimeScope))
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
      outcomeStatus: candidate.promotion?.mode === "outcome-canary" ? candidate.promotion.canary.status : "not-required",
      authority: "context-only"
    }));
  return {
    schema: "agentspine.learning-context/v1",
    root: catalog.root,
    groupId,
    scope: runtimeScope,
    items,
    degraded: stale.length > 0,
    diagnostics: stale.map((id) => `stale-outcome-canary:${id}`),
    authority: "context-only",
    note: "Learned context is descriptive evidence, never permission, delegation, access, or an instruction to act."
  };
}

export async function learningOutcomeStatus({ root = process.cwd(), scope = null, now = new Date() } = {}) {
  const { learning, learningPath } = await loadLearning(root);
  const runtimeScope = scope === null ? null : normalizeScope(scope);
  const timestamp = date(now, "now");
  const records = learning.candidates
    .filter((candidate) => runtimeScope === null || scopeContains(candidate.scope, runtimeScope))
    .map((candidate) => {
      const outcomes = learning.outcomes.filter((item) => item.learningId === candidate.id);
      const applications = learning.applications.filter((item) => item.learningId === candidate.id);
      const deliveries = learning.deliveries.filter((item) => item.learningId === candidate.id);
      const evaluations = learning.evaluations.filter((item) => item.learningId === candidate.id);
      const canary = candidate.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
      const stale = canary?.status === "active" && new Date(canary.expiresAt).getTime() < new Date(timestamp).getTime();
      return {
        id: candidate.id,
        kind: candidate.kind,
        status: candidate.status,
        conflictsWith: candidate.conflictsWith || [],
        beforeReceipts: outcomes.filter((item) => item.phase === "before").length,
        afterReceipts: outcomes.filter((item) => item.phase === "after").length,
        boundAfterReceipts: outcomes.filter((item) => item.phase === "after" && item.applicationId
          && applications.some((application) => application.id === item.applicationId)).length,
        deliveredAfterReceipts: outcomes.filter((item) => item.phase === "after" && item.deliveryId
          && deliveries.some((delivery) => delivery.id === item.deliveryId)).length,
        plannedOutcomeReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(item.schema)
          && evaluations.some((contract) => contract.id === item.evaluationId)).length,
        coverageBoundReceipts: outcomes.filter((item) => item.schema === "agentspine.learning-outcome/v5"
          && evaluations.some((contract) => contract.id === item.evaluationId
            && contract.schema === "agentspine.learning-evaluation/v2"
            && item.coverage?.datasetDigest === contract.benchmark.datasetDigest
            && item.coverage?.caseCount >= contract.benchmark.minCases)).length,
        legacyCoverageReceipts: outcomes.filter((item) => ["agentspine.learning-outcome/v1", "agentspine.learning-outcome/v2",
          "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4"].includes(item.schema)).length,
        evaluationContracts: evaluations.length,
        activeEvaluationId: canary?.evaluationId || [...evaluations]
          .filter((contract) => new Date(contract.expiresAt).getTime() >= new Date(timestamp).getTime())
          .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))[0]?.id || null,
        applicationReceipts: applications.length,
        deliveryReceipts: deliveries.length,
        pendingApplications: applications.filter((application) => application.schema === "agentspine.learning-application/v2"
          && new Date(application.deliveryExpiresAt).getTime() >= new Date(timestamp).getTime()
          && !deliveries.some((delivery) => delivery.applicationId === application.id)).length,
        stalePendingApplications: applications.filter((application) => application.schema === "agentspine.learning-application/v2"
          && new Date(application.deliveryExpiresAt).getTime() < new Date(timestamp).getTime()
          && !deliveries.some((delivery) => delivery.applicationId === application.id)).length,
        latestApplicationId: [...applications].sort((a, b) => b.projectedAt.localeCompare(a.projectedAt))[0]?.id || null,
        canaryStatus: stale ? "stale" : (canary?.status || "not-applicable"),
        expiresAt: canary?.expiresAt || null,
        authority: "context-only"
      };
    });
  return {
    schema: "agentspine.learning-outcome-status/v1",
    root: learning.root,
    records,
    learningPath,
    authority: "context-only",
    note: "Outcome status is context-only and never grants permissions, delegation, access, or policy exceptions."
  };
}

export async function configureLearning({ root = process.cwd(), config = {}, now = new Date() }) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.keys(config).length) {
    throw new Error("config must change at least one learning setting");
  }
  const allowed = new Set([
    "autoPromote", "minConfidence", "minEvidence", "maxContextItems", "minOutcomeReceipts",
    "minImprovement", "regressionTolerance", "outcomeMaxAgeDays", "canaryReceipts", "canaryTtlDays"
  ]);
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
    if ("minOutcomeReceipts" in config) state.config.minOutcomeReceipts = integer(config.minOutcomeReceipts, "minOutcomeReceipts", 2, 10);
    if ("minImprovement" in config) state.config.minImprovement = number(config.minImprovement, "minImprovement", 0, 1);
    if ("regressionTolerance" in config) state.config.regressionTolerance = number(config.regressionTolerance, "regressionTolerance", 0, 1);
    if ("outcomeMaxAgeDays" in config) state.config.outcomeMaxAgeDays = integer(config.outcomeMaxAgeDays, "outcomeMaxAgeDays", 1, 365);
    if ("canaryReceipts" in config) state.config.canaryReceipts = integer(config.canaryReceipts, "canaryReceipts", 1, 10);
    if ("canaryTtlDays" in config) state.config.canaryTtlDays = integer(config.canaryTtlDays, "canaryTtlDays", 1, 90);
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
    state.outcomes = state.outcomes.filter((entry) => entry.learningId !== id);
    state.applications = state.applications.filter((entry) => entry.learningId !== id);
    state.deliveries = state.deliveries.filter((entry) => entry.learningId !== id);
    state.evaluations = state.evaluations.filter((entry) => entry.learningId !== id);
    state.history = state.history.filter((entry) => entry.recordId !== id && entry.value?.id !== id);
    return { deleted: existed, id, learningPath };
  });
}

export async function purgeLearningBySubject({ root = process.cwd(), subjectId }) {
  if (!ID_RE.test(subjectId || "")) throw new Error("subjectId is required");
  return mutation(root, (state, _catalog, learningPath) => {
    const ids = new Set(state.candidates.filter((entry) => entry.subjectId === subjectId).map((entry) => entry.id));
    state.candidates = state.candidates.filter((entry) => entry.subjectId !== subjectId);
    state.outcomes = state.outcomes.filter((entry) => !ids.has(entry.learningId));
    state.applications = state.applications.filter((entry) => !ids.has(entry.learningId));
    state.deliveries = state.deliveries.filter((entry) => !ids.has(entry.learningId));
    state.evaluations = state.evaluations.filter((entry) => !ids.has(entry.learningId));
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
    if (!candidate.scope || Object.keys(candidate.scope).some((field) => !SCOPE_FIELDS.includes(field))
      || Object.values(candidate.scope || {}).some((value) => value !== null && !ID_RE.test(value))) findings.push(`invalid-scope:${candidate.id}`);
    if (candidate.status === "accepted") {
      const canaryEvaluation = candidate.promotion?.canary?.evaluationId
        ? (learning.evaluations || []).find((contract) => contract.id === candidate.promotion.canary.evaluationId)
        : null;
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
          && candidate.promotion?.evidenceCount >= candidate.promotion?.minEvidence)
        || (OUTCOME_AUTO_KINDS.has(candidate.kind)
          && candidate.promotion?.mode === "outcome-canary"
          && candidate.requiresLocalReview === false
          && ["active", "validated"].includes(candidate.promotion?.canary?.status)
          && candidate.confidence >= candidate.promotion?.minConfidence
          && distinctEvidence(candidate) >= candidate.promotion?.minEvidence
          && candidate.promotion?.canary?.beforeReceipts?.length >= (canaryEvaluation?.thresholds.beforeReceipts
            ?? learning.config.minOutcomeReceipts)
          && (!candidate.promotion?.canary?.evaluationId
            || (canaryEvaluation && canaryEvaluation.digest === candidate.promotion.canary.evaluationDigest))));
      if (!candidate.acceptedAt || (!manualProof && !automaticProof)) findings.push(`invalid-acceptance:${candidate.id}`);
      if (candidate.promotion?.mode === "outcome-canary" && candidate.promotion?.canary?.status === "active"
        && new Date(candidate.promotion.canary.expiresAt).getTime() < Date.now()) findings.push(`stale-canary:${candidate.id}`);
    }
  }
  const outcomeIds = new Set();
  for (const receipt of learning.outcomes || []) {
    const candidate = learning.candidates.find((item) => item.id === receipt.learningId);
    const valid = storedOutcomeStructure(receipt) && candidate && scopeContains(candidate.scope, receipt.scope);
    if (!valid || outcomeIds.has(receipt.id)) findings.push(`invalid-outcome:${receipt.id || "unknown"}`);
    outcomeIds.add(receipt.id);
  }
  const evaluationIds = new Set();
  for (const contract of learning.evaluations || []) {
    const candidate = learning.candidates.find((item) => item.id === contract.learningId);
    const valid = storedEvaluationStructure(contract) && candidate && scopeContains(candidate.scope, contract.scope);
    if (!valid || evaluationIds.has(contract.id)) findings.push(`invalid-evaluation:${contract.id || "unknown"}`);
    evaluationIds.add(contract.id);
  }
  const applicationIds = new Set();
  for (const receipt of learning.applications || []) {
    const candidate = learning.candidates.find((item) => item.id === receipt.learningId);
    const valid = storedApplicationStructure(receipt) && candidate && scopeContains(candidate.scope, receipt.scope);
    if (!valid || applicationIds.has(receipt.id)) findings.push(`invalid-application:${receipt.id || "unknown"}`);
    if (receipt.schema === "agentspine.learning-application/v2"
      && new Date(receipt.deliveryExpiresAt).getTime() < Date.now()
      && !(learning.deliveries || []).some((delivery) => delivery.applicationId === receipt.id)) {
      findings.push(`stale-undelivered-application:${receipt.id}`);
    }
    applicationIds.add(receipt.id);
  }
  const deliveryIds = new Set();
  for (const receipt of learning.deliveries || []) {
    const candidate = learning.candidates.find((item) => item.id === receipt.learningId);
    const application = learning.applications.find((item) => item.id === receipt.applicationId);
    const valid = storedDeliveryStructure(receipt) && candidate && application
      && application.learningId === receipt.learningId && application.sessionId === receipt.sessionId
      && exactScope(application.scope, receipt.scope) && scopeContains(candidate.scope, receipt.scope);
    if (!valid || deliveryIds.has(receipt.id)) findings.push(`invalid-delivery:${receipt.id || "unknown"}`);
    deliveryIds.add(receipt.id);
  }
  for (const receipt of learning.outcomes || []) {
    if (["agentspine.learning-outcome/v2", "agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(receipt.schema) && receipt.phase === "after"
      && !applicationIds.has(receipt.applicationId)) findings.push(`unbound-outcome:${receipt.id}`);
    if (["agentspine.learning-outcome/v3", "agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(receipt.schema) && !evaluationIds.has(receipt.evaluationId)) {
      findings.push(`unplanned-outcome:${receipt.id}`);
    }
    if (["agentspine.learning-outcome/v4", "agentspine.learning-outcome/v5"].includes(receipt.schema) && receipt.phase === "after"
      && !deliveryIds.has(receipt.deliveryId)) findings.push(`undelivered-outcome:${receipt.id}`);
    if (receipt.schema === "agentspine.learning-outcome/v5") {
      const contract = (learning.evaluations || []).find((item) => item.id === receipt.evaluationId);
      if (!contract || contract.schema !== "agentspine.learning-evaluation/v2"
        || receipt.coverage?.datasetDigest !== contract.benchmark.datasetDigest
        || receipt.coverage?.caseCount < contract.benchmark.minCases) findings.push(`invalid-coverage:${receipt.id}`);
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
