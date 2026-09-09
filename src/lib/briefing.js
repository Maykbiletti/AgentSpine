import { buildCatalog, catalogForStateRoot } from "./catalog.js";
import { resolveContext } from "./context.js";
import { relationshipContext } from "./graph.js";
import { learningContext } from "./learning.js";
import { attentionContext } from "./attention.js";
import { taskContext } from "./coordination.js";
import { sharedContext } from "./sharing.js";
import { loadPersonaRuntime, personaRuntimeFindings } from "./persona-runtime.js";
import { gatewayRuntimeFindings, loadGatewayRuntime } from "./gateway-runtime.js";
import { voiceCue } from "./voice-runtime.js";
import { worldContext } from "./world-model.js";
import { projectPortfolioContext } from "./project-portfolio.js";

const MIN_BYTES = 4096;
const MAX_BYTES = 262144;

function integer(value, field, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function compactBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function normalizeKey(item) {
  return `${item.kind}\0${item.subjectId || ""}\0${item.claim.trim().toLowerCase()}`;
}

function sourceDescriptor(document, content = null) {
  return {
    path: document.relativePath,
    layer: document.effectiveLayer,
    sha256: document.sha256,
    bytes: document.bytes,
    loaded: content !== null,
    content,
    authority: document.authority
  };
}

function recalculateBudget(result) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const usedBytes = compactBytes(result);
    const remainingBytes = Math.max(0, result.budget.maxBytes - usedBytes);
    if (result.budget.usedBytes === usedBytes && result.budget.remainingBytes === remainingBytes) break;
    result.budget.usedBytes = usedBytes;
    result.budget.remainingBytes = remainingBytes;
  }
}

function tryAdd(result, collection, item) {
  collection.push(item);
  recalculateBudget(result);
  if (result.budget.usedBytes <= result.budget.maxBytes - 128) return true;
  collection.pop();
  recalculateBudget(result);
  return false;
}

function trySet(result, object, key, item) {
  const previous = object[key];
  object[key] = item;
  recalculateBudget(result);
  if (result.budget.usedBytes <= result.budget.maxBytes - 128) return true;
  object[key] = previous;
  recalculateBudget(result);
  return false;
}

function countOmitted(result, section, count = 1) {
  result.budget.omitted[section] += count;
  recalculateBudget(result);
}

function matchesScope(item, entityId, projectId) {
  if (!entityId && !projectId) return item.subjectId === null;
  return item.subjectId === null || item.subjectId === entityId || item.subjectId === projectId;
}

function taskMatchesScope(task, entityId) {
  return !entityId || task.createdBy === entityId || task.assigneeId === entityId;
}

function voiceProfile(entity) {
  const value = entity?.attributes?.voice;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set(["warmth", "directness", "humor", "length", "rhythm", "formality"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => allowed.has(key) && ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 120) : item]));
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function feedbackCandidates(values) {
  if (values.length < 3) return values.map((item) =>
    pick(item, ["id", "text", "provider", "digest", "session", "message", "at"]));
  const shared = ["provider", "digest", "session"].filter((key) =>
    values.every((item) => item[key] === values[0][key]));
  const fields = ["id", "text", "message", "at",
    ...["provider", "digest", "session"].filter((key) => !shared.includes(key))];
  const expected = { id: "assertion:user-feedback-", message: "timeline-event:" };
  const prefixes = fields.map((key) => expected[key] || (key === "at"
    && values.every((item) => /^\d{4}-\d{2}-\d{2}T\d{2}:/.test(item[key]))
    ? values[0][key].slice(0, 14) : ""));
  return { fields, common: Object.fromEntries(shared.map((key) => [key, values[0][key]])), prefixes,
    rows: values.map((item) => fields.map((key, index) => item[key].slice(prefixes[index].length))) };
}

function preAnswerRecall(world, currentTaskId) {
  if (!currentTaskId) return null;
  const task = [...(world.knowledge?.continuation?.tasks || []),
    ...(world.knowledge?.continuation?.terminal || [])]
    .find((item) => item.taskId === currentTaskId);
  if (!task) return null;
  const feedback = (world.knowledge?.taskContext?.items || []).filter((item) =>
    item?.source?.kind === "uninterpreted-user-message"
      && item.value?.targetAssertionId === task.assertionId)
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const interpretations = (world.knowledge?.taskContext?.items || []).filter((item) =>
    item?.source?.kind === "model-suggestion"
      && ["agentspine.timeline-user-feedback-interpretation/v1",
        "agentspine.timeline-user-feedback-clarification/v1"].includes(item.value?.schema)
      && item.value?.targetAssertionId === task.assertionId);
  const taskValue = pick(task, ["taskId", "status", "objective"]);
  taskValue.lastVerifiedStep = task.lastVerifiedStep
    ? pick(task.lastVerifiedStep, ["summary", "result"]) : null;
  taskValue.nextStep = task.nextStep ? pick(task.nextStep, ["summary"]) : null;
  const values = feedback.slice(0, 3).map(({ id, value, source, observedAt }) => ({
    id,
    text: value.sourceText,
    status: value.interpretationStatus, completionVerified: value.completionVerified,
    provider: value.sourceProvider, digest: value.sourceDigest,
    session: source.sessionRef, message: source.messageRef, at: observedAt
  }));
  if (!values.length) {
    Object.assign(taskValue, pick(task, ["assertionId", "observedAt"]));
    taskValue.source = pick(task.source, ["kind", "id", "digest", "sessionRef", "messageRef"]);
    taskValue.scope = pick(task.scope, ["projectId", "groupId", "privacy", "portalRef", "threadRef"]);
    taskValue.correctionStatus = task.source.kind === "explicit-user-feedback"
      ? "applied-source-verified" : "none-current";
  }
  if (values.length === 1) {
    const proposal = interpretations.find((item) =>
      item.value.sourceFeedbackAssertionId === feedback[0].id);
    if (proposal) {
      const value = proposal.value;
      const model = {
        status: value.interpretationStatus, kind: value.interpretationKind,
        nextStep: value.proposedNextStepSummary, question: value.clarificationQuestion,
        provider: value.modelProvider, replaces: value.replacedNextStepId,
        digest: proposal.source.digest, completionVerified: false
      };
      for (const key of ["nextStep", "question"]) {
        if (model[key] === null) delete model[key];
      }
      values[0].modelInterpretation = model;
    }
  }
  return {
    schema: "agentspine.pre-answer-recall/v1",
    order: "review-before-claims-and-actions",
    task: taskValue,
    ...(values.length === 1 ? { feedback: values[0], interpretationInput: {
      feedbackAssertionId: feedback[0].id, targetAssertionId: feedback[0].value.targetAssertionId } } : {}),
    ...(values.length > 1 ? { feedbackCandidates: feedbackCandidates(values),
      feedbackReview: { status: "multiple-unresolved", completionVerified: false,
        targetAssertionId: feedback[0].value.targetAssertionId,
        ...(() => {
          const ids = feedback.slice(0, 3).map((item) => item.id).sort();
          const proposal = interpretations.find((item) => item.value?.schema
            === "agentspine.timeline-user-feedback-clarification/v1"
            && JSON.stringify(item.value.sourceFeedbackAssertionIds) === JSON.stringify(ids));
          return proposal ? { modelClarification: { status: proposal.value.interpretationStatus,
            question: proposal.value.clarificationQuestion, provider: proposal.value.modelProvider,
            replaces: proposal.value.replacedNextStepId, digest: proposal.source.digest,
            completionVerified: false } } : {};
        })(),
        ...(feedback.length > 3 ? { omitted: feedback.length - 3 } : {}) } } : {}),
    authority: "context-only"
  };
}

async function settleReads(promises) {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find((item) => item.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((item) => item.value);
}

export async function sessionBriefing({
  root = process.cwd(), cwd = root, host = "generic", entityId = null,
  userId = null, tenantId = null, groupId = null, projectId = null, currentTaskId = null,
  portalRef = null, threadRef = null,
  includePrivate = false, focusActive = true, includeSourceContent = true,
  maxBytes = 16384, now = new Date(), catalog: providedCatalog = null, userStateRoot = null,
  sourceDiagnostics = null, prompt = null, preAnswer = false
} = {}) {
  const limit = integer(maxBytes, "maxBytes", MIN_BYTES, MAX_BYTES);
  if (!new Set(["codex", "claude", "generic"]).has(host)) throw new Error(`unsupported host: ${host}`);
  if (groupId !== null && includePrivate) throw new Error("private context cannot be assembled for a group audience");

  const catalog = providedCatalog || await buildCatalog(root);
  const sources = await resolveContext({
    root: catalog.root, cwd, host, maxBytes: limit,
    includeContent: includeSourceContent && groupId === null,
    catalog
  });
  const portableRelationship = Boolean(entityId && userStateRoot && userStateRoot !== catalog.root);
  const userCatalog = userStateRoot && userStateRoot !== catalog.root
    ? catalogForStateRoot(catalog, userStateRoot) : catalog;
  const learningScope = {
    personaId: entityId, userId, tenantId, projectId, groupId, taskId: currentTaskId
  };
  const relationship = entityId
    ? await relationshipContext(userStateRoot && userStateRoot !== catalog.root
      ? { root: userStateRoot, entityId, includePrivate, groupId, catalog: userCatalog }
      : { root: catalog.root, entityId, includePrivate, groupId, catalog })
    : null;
  const [learned, attention, tasks, shared, userLearned, personas, gateway, world, portfolio] = await settleReads([
    learningContext({ root: catalog.root, includePrivate, groupId, scope: learningScope, maxItems: 50,
      catalog, now, taskFocus: currentTaskId }),
    attentionContext({
      root: catalog.root, includePrivate, entityId, groupId, projectId, currentTaskId,
      focusActive, markPresented: false, maxItems: 20, now, catalog
    }),
    taskContext({ root: catalog.root, includePrivate, groupId, projectId, includeClosed: false, maxItems: 100, catalog }),
    sharedContext({ root: catalog.root, includePrivate, groupId, maxItems: 50, catalog }),
    userStateRoot && userStateRoot !== catalog.root
      ? learningContext({ root: userStateRoot, includePrivate, groupId, scope: learningScope, maxItems: 50, now,
        catalog: userCatalog, taskFocus: currentTaskId })
      : Promise.resolve({ items: [] }),
    loadPersonaRuntime(catalog.root, catalog),
    loadGatewayRuntime(catalog.root, catalog),
    worldContext({ root: catalog.root, projectId, groupId, includePrivate, portalRef, threadRef,
      continuationTaskId: currentTaskId, maxItems: 50, now }),
    tenantId ? projectPortfolioContext({ root: catalog.root, tenantId, groupId, markPresented: false, now })
      : Promise.resolve({ projects: [], observations: [], notice: null, rateLimited: false })
  ]);
  const personaFindings = personaRuntimeFindings(personas.policy, personas.runtime);
  if (personaFindings.length) throw new Error(`persona runtime failed closed: ${personaFindings.join(", ")}`);
  const registeredPersona = entityId ? personas.runtime.personas.find((item) => item.personaId === entityId) : null;
  if (registeredPersona && registeredPersona.status !== "active") throw new Error(`persona is not active in the authenticated roster: ${entityId}`);
  if (registeredPersona && groupId !== null && registeredPersona.groupId !== groupId) {
    throw new Error(`persona is not visible in the exact group scope: ${entityId}`);
  }
  const gatewayFindings = gatewayRuntimeFindings(gateway.policy, gateway.runtime);
  if (gatewayFindings.length) throw new Error(`gateway runtime failed closed: ${gatewayFindings.join(", ")}`);
  const compactFeedbackRecall = !preAnswer && currentTaskId
    && world.knowledge.taskContext.items.filter((item) => item.predicate === "task.user-feedback").length >= 3;

  const result = {
    schema: "agentspine.session-briefing/v1",
    root: catalog.root,
    cwd: sources.cwd,
    host,
    scope: { entityId, userId, tenantId, groupId, projectId, includePrivate,
      ...(portalRef && threadRef ? { portalRef, threadRef } : {}) },
    focus: { active: Boolean(focusActive), currentTaskId },
    sources: { documents: [], diagnostics: sourceDiagnostics },
    tasks: [],
    relationship: relationship ? {
      status: relationship.status || "loaded",
      reason: relationship.reason || null,
      entity: null,
      relatedEntities: [],
      edges: []
    } : null,
    voiceBrief: {
      schema: "agentspine.voice-brief/v1",
      personaId: entityId,
      displayName: null,
      language: null,
      profile: {},
      personaSources: [],
      preferences: [],
      corrections: [],
      noGos: [],
      currentTask: null,
      currentGoal: null,
      activeSignals: [],
      cue: voiceCue(prompt),
      guidance: [
        "Use scoped facts first; be honest; never claim consciousness; heed corrections; own errors."
      ],
      authority: "context-only"
    },
    learning: [],
    shared: [],
    ...(preAnswer || compactFeedbackRecall
      ? { preAnswerRecall: preAnswerRecall(world, currentTaskId) } : {}),
    world: {
      schema: world.schema,
      facts: [], conflicts: [], proposals: [], stale: [],
      ...(world.knowledge.current.length ? { knowledge: {
        schema: world.knowledge.schema, current: [], counts: world.knowledge.counts,
        continuation: { ...world.knowledge.continuation, tasks: [], terminal: [] },
        taskContext: { ...world.knowledge.taskContext, items: [] },
        omitted: { ...world.knowledge.omitted }, authority: "context-only"
      } } : {}),
      uncertainty: world.uncertainty,
      authority: "context-only"
    },
    attention: { suppressed: attention.suppressed, items: [] },
    portfolio: { projects: [], observations: [], notice: portfolio.notice, rateLimited: portfolio.rateLimited, authority: "context-only" },
    budget: {
      maxBytes: limit,
      usedBytes: 0,
      remainingBytes: 0,
      measurement: "compact-json-utf8",
      omitted: { sources: 0, tasks: 0, relationships: 0, voice: 0, learning: 0, shared: 0, world: 0, attention: 0, portfolio: 0 }
    },
    authority: "context-only"
  };
  recalculateBudget(result);
  if (result.budget.usedBytes > limit) throw new Error(`maxBytes is too small for the briefing envelope; use at least ${MIN_BYTES}`);

  const portableKinds = new Set(["preference", "no-go", "correction", "reference"]);
  const portableItems = userLearned.items.filter((item) => portableKinds.has(item.kind) && matchesScope(item, entityId, null));
  const localItems = [...portableItems, ...learned.items.filter((item) => matchesScope(item, entityId, projectId))];
  const attemptedLearning = new Set();

  const continuationIds = new Set([
    ...world.knowledge.continuation.tasks.map((item) => item.assertionId),
    ...world.knowledge.continuation.terminal.map((item) => item.assertionId)
  ]);
  for (const [items, key] of [[world.knowledge.continuation.tasks, "tasks"],
    [world.knowledge.continuation.terminal, "terminal"]]) {
    for (const item of items) {
      if (preAnswer || !tryAdd(result, result.world.knowledge.continuation[key], item)) countOmitted(result, "world");
    }
  }
  const contextualIds = new Set([...continuationIds, ...world.knowledge.current
    .filter((item) => ["task.user-feedback", "task.user-feedback-interpretation"]
      .includes(item.predicate)).map((item) => item.id)]);
  for (const item of world.knowledge.taskContext.items) {
    contextualIds.add(item.id);
    if (preAnswer || (compactFeedbackRecall
      && ["task.user-feedback", "task.user-feedback-interpretation"].includes(item.predicate))) {
      result.world.knowledge.taskContext.omitted += 1;
      countOmitted(result, "world");
    } else if (!tryAdd(result, result.world.knowledge.taskContext.items, item)) {
      result.world.knowledge.taskContext.omitted += 1;
      countOmitted(result, "world");
    }
  }
  for (const item of localItems.filter((entry) => entry.relevance)) {
    attemptedLearning.add(item);
    if (!tryAdd(result, result.learning, item)) countOmitted(result, "learning");
  }
  for (const section of ["facts", "conflicts", "proposals", "stale"]) {
    const items = section === "facts"
      ? world[section].filter((item) => !item.assertionIds?.some((id) => contextualIds.has(id)))
      : world[section].filter((item) => !contextualIds.has(item.id));
    for (const item of items) {
      if (!tryAdd(result, result.world[section], item)) countOmitted(result, "world");
    }
  }
  for (const item of world.knowledge.current.filter((entry) => !contextualIds.has(entry.id))) {
    if (!tryAdd(result, result.world.knowledge.current, item)) {
      result.world.knowledge.omitted.current += 1;
      countOmitted(result, "world");
    }
  }

  const scopedTasks = tasks.items.filter((task) => taskMatchesScope(task, entityId));
  const continuedTask = [...world.knowledge.continuation.tasks, ...world.knowledge.continuation.terminal]
    .find((task) => task.taskId === currentTaskId) || null;
  if (currentTaskId && !scopedTasks.some((task) => task.id === currentTaskId) && !continuedTask) {
    throw new Error(`current task is not visible in this briefing scope: ${currentTaskId}`);
  }
  const orderedTasks = [...scopedTasks].sort((left, right) => {
    if (left.id === currentTaskId) return -1;
    if (right.id === currentTaskId) return 1;
    return right.priority - left.priority || left.id.localeCompare(right.id);
  });
  for (const task of orderedTasks) {
    if (!tryAdd(result, result.tasks, task)) countOmitted(result, "tasks");
  }
  const focusedTask = orderedTasks.find((task) => task.id === currentTaskId) || orderedTasks[0] || null;
  if (focusedTask && !trySet(result, result.voiceBrief, "currentTask", {
    id: focusedTask.id, title: focusedTask.title, status: focusedTask.status
  })) countOmitted(result, "voice");
  if (!focusedTask && continuedTask && !trySet(result, result.voiceBrief, "currentTask", {
    id: continuedTask.taskId, title: continuedTask.objective, status: continuedTask.status,
    nextStep: continuedTask.nextStep
  })) countOmitted(result, "voice");
  const focusedGoal = entityId ? gateway.policy.goals.find((goal) => goal.agentId === entityId && goal.status === "active"
    && (projectId === null || goal.projectId === projectId) && goal.groupId === groupId) : null;
  if (focusedGoal && !trySet(result, result.voiceBrief, "currentGoal", {
    goalId: focusedGoal.goalId, successCriterion: focusedGoal.successCriterion,
    nextSafeStep: focusedGoal.nextSafeStep, deadline: focusedGoal.deadline,
    heartbeatAt: focusedGoal.heartbeatAt, blocker: focusedGoal.blocker
  })) countOmitted(result, "voice");

  if (registeredPersona) {
    if (!trySet(result, result.voiceBrief, "displayName", registeredPersona.displayName)) countOmitted(result, "voice");
    const binding = personas.policy.bindings.find((item) => item.id === registeredPersona.bindingId && item.active);
    if (binding?.sourceBinding && !tryAdd(result, result.voiceBrief.personaSources, binding.sourceBinding)) countOmitted(result, "voice");
  }

  if (relationship && relationship.status !== "degraded") {
    if (!trySet(result, result.relationship, "entity", relationship.entity)) countOmitted(result, "relationships");
    if (!registeredPersona && !trySet(result, result.voiceBrief, "displayName", relationship.entity.displayName || null)) countOmitted(result, "voice");
    const language = typeof relationship.entity.attributes?.language === "string"
      ? relationship.entity.attributes.language.slice(0, 40) : null;
    if (!trySet(result, result.voiceBrief, "language", language)) countOmitted(result, "voice");
    if (!trySet(result, result.voiceBrief, "profile", voiceProfile(relationship.entity))) countOmitted(result, "voice");
    if (!portableRelationship) {
      for (const entity of relationship.relatedEntities.filter((item) => item.id !== entityId)) {
        if (!tryAdd(result, result.relationship.relatedEntities, entity)) countOmitted(result, "relationships");
      }
      for (const edge of relationship.edges) {
        if (!tryAdd(result, result.relationship.edges, edge)) countOmitted(result, "relationships");
      }
    }
  }

  const voiceCollections = {
    preference: result.voiceBrief.preferences,
    correction: result.voiceBrief.corrections,
    "no-go": result.voiceBrief.noGos
  };
  for (const item of localItems.filter((entry) => voiceCollections[entry.kind]).slice(0, 12)) {
    if (!tryAdd(result, voiceCollections[item.kind], item.claim)) countOmitted(result, "voice");
  }
  const localKeys = new Set(localItems.map(normalizeKey));
  for (const item of localItems.filter((entry) => !attemptedLearning.has(entry))) {
    if (!tryAdd(result, result.learning, item)) countOmitted(result, "learning");
  }
  for (const item of shared.items.filter((entry) => matchesScope(entry, entityId, projectId))) {
    if (localKeys.has(normalizeKey(item))) {
      countOmitted(result, "shared");
      continue;
    }
    if (!tryAdd(result, result.shared, item)) countOmitted(result, "shared");
  }

  const sourceByteCap = Math.min(8192, Math.floor(limit / 2));
  let sourceBytes = 0;
  const personaLayers = new Set(["soul", "identity", "voice", "conduct"]);
  for (const document of sources.documents.filter((item) => personaLayers.has(item.effectiveLayer))) {
    if (!tryAdd(result, result.voiceBrief.personaSources, document.relativePath)) countOmitted(result, "voice");
  }
  for (const document of sources.documents) {
    const mayLoad = document.loaded && document.content !== null && sourceBytes + document.bytes <= sourceByteCap;
    const loaded = mayLoad ? sourceDescriptor(document, document.content) : null;
    if (loaded && tryAdd(result, result.sources.documents, loaded)) {
      sourceBytes += document.bytes;
      continue;
    }
    if (tryAdd(result, result.sources.documents, sourceDescriptor(document))) {
      if (includeSourceContent) countOmitted(result, "sources");
    } else countOmitted(result, "sources");
  }

  const attentionItems = attention.items.filter((item) => !entityId || item.entityId === null || item.entityId === entityId);
  for (const item of attentionItems.filter((entry) => ["promise", "blocker"].includes(entry.kind)).slice(0, 6)) {
    if (!tryAdd(result, result.voiceBrief.activeSignals, {
      kind: item.kind, summary: item.summary, taskId: item.taskId || null, dueAt: item.dueAt || null
    })) countOmitted(result, "voice");
  }
  for (const item of attentionItems) {
    if (!tryAdd(result, result.attention.items, item)) countOmitted(result, "attention");
  }
  for (const item of portfolio.projects) {
    if (!tryAdd(result, result.portfolio.projects, item)) countOmitted(result, "portfolio");
  }
  for (const item of portfolio.observations) {
    if (!tryAdd(result, result.portfolio.observations, item)) countOmitted(result, "portfolio");
  }

  recalculateBudget(result);
  if (result.budget.usedBytes > limit) throw new Error("briefing budget invariant failed");
  return result;
}
