import { createHash } from "node:crypto";
import { closedPremortemForGoal } from "./delivery-premortem.js";
import { hasSecretShapedText } from "./delivery-premortem-closure.js";
import { dispositionAttachments, finalizedReadOnlyAttachments, finalizeReadOnlyReview,
  validClosedFinalization } from "./gateway-premortem-disposition.js";
import { GOAL_PREMORTEM_CONTRACT, validGatewayPolicyProvenance } from "./gateway-policy-provenance.js";
export { GOAL_PREMORTEM_CONTRACT, readGatewayJson, validGatewayPolicyProvenance,
  writeGatewayJson } from "./gateway-policy-provenance.js";

const ATTACHMENT_SCHEMA = "agentspine.goal-premortem-attachment/v1";
const CHECKPOINT_SCHEMA = "agentspine.goal-delivery-checkpoint/v1";
const OUTCOME_SCHEMA = "agentspine.goal-outcome-receipt/v1";
const REGISTRY_SCHEMA = "agentspine.goal-premortem-contract-registry/v1";
const AUTHORITY = "context-only";
const REGISTRY_AUTHORITY = "context-only-contract-provenance";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CATEGORIES = ["baseline-environment", "contract-tests", "delivery-path"];
const NON_CLOSED = new Set(["read-only", "degraded-fail-open"]);
const CORE_KEYS = ["schema", "goalId", "goalStepId", "queueId", "gatewayAttempt",
  "planDefinitionsDigest", "laneDigest", "sessionDigest", "host", "projectId", "entityId",
  "groupId", "taskId", "premortemText", "premortemDigest", "lastWriteDigest", "checkResults",
  "closureDigest", "authority", "attachmentDigest"];
const COMMON_KEYS = ["status", "queueId", "gatewayAttempt", "goalId", "goalStepId",
  "planDefinitionsDigest", "projectRootDigest", "checkpointDigest", "host", "projectId", "entityId",
  "groupId", "scopeFinalizationDigest", "authority"];
const CLOSED_KEYS = [...COMMON_KEYS, "taskId", "sessionDigest", "bindingDigest", "lastWriteDigest",
  "sourceAttachmentDigest", "premortemText", "premortemDigest", "checkResults", "closureDigest"];
const READ_ONLY_BINDING_KEYS = ["goalId", "goalStepId", "queueId", "gatewayAttempt",
  "planDefinitionsDigest", "host", "projectId", "entityId", "groupId", "taskId", "laneDigest",
  "sessionDigest", "authority", "digest"];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}
function exactKeys(value, keys) {
  return value && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}
function validCheckResults(results) {
  return Array.isArray(results) && results.length === CATEGORIES.length
    && new Set(results.map((item) => item?.category)).size === CATEGORIES.length
    && CATEGORIES.every((category) => results.some((item) => item?.category === category))
    && results.every((item) => exactKeys(item, ["category", "checkId", "status", "result"])
      && typeof item.checkId === "string" && item.checkId.length > 0
      && item.checkId.length <= 80 && item.status === "PASS"
      && typeof item.result === "string" && item.result.trim().length > 0 && item.result.length <= 1024
      && !/[\0\r\n]/.test(item.result) && !hasSecretShapedText(item.result));
}
function validPremortemText(text) {
  const lines = typeof text === "string" ? text.split("\n") : [];
  return lines.length === CATEGORIES.length && lines.every((line) =>
    /^this delivery fails because \S.* Check: \S/i.test(line) && line.length <= 1032
      && !hasSecretShapedText(line));
}
function validCoreAttachment(attachment, expected) {
  if (!(exactKeys(attachment, CORE_KEYS) && attachment.schema === ATTACHMENT_SCHEMA && attachment.authority === AUTHORITY
    && attachment.goalId === expected.goalId && attachment.goalStepId === expected.goalStepId
    && attachment.queueId === expected.queueId
    && attachment.gatewayAttempt === expected.gatewayAttempt
    && attachment.planDefinitionsDigest === expected.planDefinitionsDigest
    && attachment.host === expected.host && attachment.projectId === expected.projectId
    && attachment.entityId === expected.entityId && attachment.groupId === expected.groupId
    && attachment.taskId === null
    && DIGEST_RE.test(attachment.laneDigest || "") && DIGEST_RE.test(attachment.sessionDigest || "")
    && DIGEST_RE.test(attachment.lastWriteDigest || "")
    && DIGEST_RE.test(attachment.premortemDigest || "") && DIGEST_RE.test(attachment.closureDigest || "")
    && DIGEST_RE.test(attachment.attachmentDigest || "") && validPremortemText(attachment.premortemText)
    && validCheckResults(attachment.checkResults))) return false;
  const material = { ...attachment };
  delete material.attachmentDigest;
  return attachment.attachmentDigest === sha256(material);
}
function attachmentMaterial(attachment, checkpointDigest, root, finalization) {
  return {
    status: "closed",
    queueId: attachment.queueId, gatewayAttempt: attachment.gatewayAttempt,
    goalId: attachment.goalId, goalStepId: attachment.goalStepId,
    planDefinitionsDigest: attachment.planDefinitionsDigest, projectRootDigest: sha256(root), checkpointDigest,
    scopeFinalizationDigest: finalization.digest,
    host: attachment.host, projectId: attachment.projectId, entityId: attachment.entityId,
    groupId: attachment.groupId, taskId: attachment.taskId,
    sessionDigest: attachment.sessionDigest, bindingDigest: attachment.laneDigest,
    lastWriteDigest: attachment.lastWriteDigest, sourceAttachmentDigest: attachment.attachmentDigest,
    premortemText: attachment.premortemText, premortemDigest: attachment.premortemDigest,
    checkResults: structuredClone(attachment.checkResults), closureDigest: attachment.closureDigest,
    authority: AUTHORITY
  };
}
function seal(value) {
  return { ...value, digest: sha256(value) };
}
function createAttachments(attachment, checkpoint, completedAt, root, finalization) {
  const common = attachmentMaterial(attachment, sha256(checkpoint ?? null), root, finalization);
  const deliveryCheckpoint = seal({ schema: CHECKPOINT_SCHEMA, ...common });
  const outcomeReceipt = seal({ schema: OUTCOME_SCHEMA, ...common, completedAt,
    deliveryCheckpointDigest: deliveryCheckpoint.digest });
  return { deliveryCheckpoint, outcomeReceipt };
}

function mismatchReason(goalId, goalStepId, queueId) {
  return `Closed delivery premortem does not match ${goalId}/${goalStepId}/${queueId}.`;
}
function validReadOnlyBindings(bindings, expected) {
  return Array.isArray(bindings) && bindings.length > 0 && bindings.length <= 64
    && bindings.every((binding) => exactKeys(binding, READ_ONLY_BINDING_KEYS)
      && binding.goalId === expected.goalId && binding.goalStepId === expected.goalStepId
      && binding.queueId === expected.queueId && binding.gatewayAttempt === expected.gatewayAttempt
      && binding.planDefinitionsDigest === expected.planDefinitionsDigest && binding.host === expected.host
      && binding.projectId === expected.projectId && binding.entityId === expected.entityId
      && binding.groupId === expected.groupId && binding.taskId === null
      && DIGEST_RE.test(binding.laneDigest || "") && DIGEST_RE.test(binding.sessionDigest || "")
      && binding.authority === AUTHORITY && validSeal(binding));
}
export async function reviewGoalPremortem({ root, goal, step, item, checkpoint, completedAt, host, readOnly }) {
  const expected = { goalId: goal.goalId, goalStepId: step.stepId, queueId: item.queueId,
    gatewayAttempt: item.attempts, planDefinitionsDigest: goal.plan.definitionsDigest,
    root, host, projectId: goal.projectId,
    entityId: item.agentId, groupId: goal.groupId, taskId: null };
  let loaded;
  try {
    loaded = await closedPremortemForGoal({ root, goalId: goal.goalId,
      goalStepId: step.stepId, queueId: item.queueId, gatewayAttempt: item.attempts });
  } catch {
    return { status: "degraded", blocked: false,
      attachments: dispositionAttachments("degraded-fail-open", expected, checkpoint, completedAt) };
  }
  if (!loaded || loaded.status === "degraded") {
    return { status: "degraded", blocked: false,
      attachments: dispositionAttachments("degraded-fail-open", expected, checkpoint, completedAt, loaded?.reason) };
  }
  if (loaded.status === "read-only-finalized") {
    const attachments = readOnly === true
      ? finalizedReadOnlyAttachments(expected, checkpoint, completedAt, loaded.finalization) : null;
    if (!attachments) {
      return { status: "mismatch", blocked: true,
        reason: mismatchReason(goal.goalId, step.stepId, item.queueId), attachments: null };
    }
    return { status: "read-only", blocked: false, attachments };
  }
  if (loaded.status === "unavailable" || (loaded.status === "missing" && loaded.verifiedAbsent === true)) {
    if (readOnly !== true) return { status: "missing", blocked: true,
      reason: "Goal-step completion has no verified premortem lane.", attachments: null };
    return finalizeReadOnlyReview(expected, checkpoint, completedAt);
  }
  if (loaded.blocked || loaded.status === "mismatch") {
    return { status: loaded.status || "mismatch", blocked: true,
      reason: loaded.reason || mismatchReason(goal.goalId, step.stepId, item.queueId), attachments: null };
  }
  if (loaded.status === "read-only") {
    if (readOnly !== true) return { status: "missing", blocked: true,
      reason: "Goal-step read-only completion requires an explicit readOnly:true result.", attachments: null };
    if (!validReadOnlyBindings(loaded.bindings, expected)) return { status: "mismatch", blocked: true,
      reason: mismatchReason(goal.goalId, step.stepId, item.queueId), attachments: null };
    return finalizeReadOnlyReview(expected, checkpoint, completedAt, loaded.bindings);
  }
  if (readOnly === true) return { status: "mismatch", blocked: true,
    reason: "A written goal-step cannot claim readOnly:true.", attachments: null };
  const attachment = loaded.attachment || loaded;
  if (!validCoreAttachment(attachment, expected)
    || !validClosedFinalization(expected, attachment, loaded.finalization)) {
    return { status: "mismatch", blocked: true,
      reason: mismatchReason(goal.goalId, step.stepId, item.queueId), attachments: null };
  }
  return { status: "closed", blocked: false,
    attachments: createAttachments(attachment, checkpoint, completedAt, root, loaded.finalization) };
}

function validSeal(value) {
  if (!value || !DIGEST_RE.test(value.digest || "")) return false;
  const material = { ...value };
  delete material.digest;
  return value.digest === sha256(material);
}

function validSourceSeal(value) {
  const material = { schema: ATTACHMENT_SCHEMA, goalId: value.goalId, goalStepId: value.goalStepId,
    queueId: value.queueId, gatewayAttempt: value.gatewayAttempt,
    planDefinitionsDigest: value.planDefinitionsDigest,
    laneDigest: value.bindingDigest, sessionDigest: value.sessionDigest, host: value.host,
    projectId: value.projectId, entityId: value.entityId, groupId: value.groupId, taskId: value.taskId,
    lastWriteDigest: value.lastWriteDigest,
    premortemText: value.premortemText, premortemDigest: value.premortemDigest,
    checkResults: value.checkResults, closureDigest: value.closureDigest, authority: value.authority };
  return value.sourceAttachmentDigest === sha256(material);
}

function sameCommon(left, right) {
  const keys = ["status", "queueId", "gatewayAttempt", "goalId", "goalStepId", "planDefinitionsDigest", "checkpointDigest",
    "projectRootDigest", "host", "projectId", "entityId", "groupId", "taskId",
    "sessionDigest", "bindingDigest", "lastWriteDigest", "premortemText", "premortemDigest", "checkResults",
    "closureDigest", "sourceAttachmentDigest", "scopeFinalizationDigest", "diagnosticDigest", "authority"];
  return keys.every((key) => canonical(left[key]) === canonical(right[key]));
}

export function validGoalPremortemAttachments(step, goal, root, planDefinitionsDigest) {
  const checkpoint = step.deliveryCheckpoint;
  const outcome = step.outcomeReceipt;
  if (![undefined, 1].includes(step.premortemContractVersion)) return false;
  if (checkpoint === undefined && outcome === undefined) {
    return step.premortemContractVersion !== 1 || step.status !== "completed";
  }
  const keys = checkpoint?.status === "closed" ? CLOSED_KEYS : [...COMMON_KEYS, "diagnosticDigest"];
  if (!(exactKeys(checkpoint, ["schema", ...keys, "digest"])
    && exactKeys(outcome, ["schema", ...keys, "completedAt", "deliveryCheckpointDigest", "digest"])
    && goal && typeof root === "string" && checkpoint.schema === CHECKPOINT_SCHEMA && outcome.schema === OUTCOME_SCHEMA
    && checkpoint.authority === AUTHORITY && outcome.authority === AUTHORITY
    && validSeal(checkpoint) && validSeal(outcome) && sameCommon(checkpoint, outcome)
    && checkpoint.goalId === goal.goalId && checkpoint.goalStepId === step.stepId
    && checkpoint.planDefinitionsDigest === planDefinitionsDigest
    && checkpoint.projectRootDigest === sha256(root) && checkpoint.projectId === goal.projectId
    && checkpoint.groupId === goal.groupId && checkpoint.entityId === (step.agentId ?? goal.agentId)
    && checkpoint.checkpointDigest === sha256(step.checkpoint ?? null)
    && checkpoint.queueId === step.completedByQueueId
    && Number.isInteger(checkpoint.gatewayAttempt) && checkpoint.gatewayAttempt > 0
    && (checkpoint.status === "degraded-fail-open" ? checkpoint.scopeFinalizationDigest === null
      : DIGEST_RE.test(checkpoint.scopeFinalizationDigest || ""))
    && outcome.deliveryCheckpointDigest === checkpoint.digest
    && outcome.completedAt === step.completedAt)) return false;
  if (checkpoint.status !== "closed") {
    return NON_CLOSED.has(checkpoint.status) && DIGEST_RE.test(checkpoint.diagnosticDigest || "")
      && ["sessionDigest", "bindingDigest", "lastWriteDigest", "premortemText", "premortemDigest",
        "checkResults", "closureDigest", "sourceAttachmentDigest"].every((key) => checkpoint[key] === undefined);
  }
  if (!(DIGEST_RE.test(checkpoint.sessionDigest || "") && DIGEST_RE.test(checkpoint.bindingDigest || "")
    && DIGEST_RE.test(checkpoint.lastWriteDigest || "")
    && DIGEST_RE.test(checkpoint.sourceAttachmentDigest || "")
    && validSourceSeal(checkpoint) && validSourceSeal(outcome)
    && DIGEST_RE.test(checkpoint.premortemDigest || "") && DIGEST_RE.test(checkpoint.closureDigest || "")
    && validPremortemText(checkpoint.premortemText) && validCheckResults(checkpoint.checkResults))) return false;
  return true;
}

function planContractVersion(plan) {
  const current = plan?.premortemContractVersion === 1 && plan?.premortemContract === GOAL_PREMORTEM_CONTRACT
    && plan?.steps?.every((step) => step.premortemContractVersion === 1);
  const legacy = plan?.premortemContractVersion === undefined && plan?.premortemContract === undefined
    && plan?.steps?.every((step) => step.premortemContractVersion === undefined);
  return current ? 1 : legacy ? 0 : null;
}

export function validPlanPremortemContract(plan, expectedVersion = undefined) {
  const version = planContractVersion(plan);
  return version !== null && (expectedVersion === undefined || version === expectedVersion);
}

function registryEntry(goal, contractVersion, registeredAt, root) {
  const material = { goalId: goal.goalId, contractVersion,
    planDefinitionsDigest: goal.plan.definitionsDigest, projectRootDigest: sha256(root),
    projectId: goal.projectId, groupId: goal.groupId, entityId: goal.agentId,
    registeredAt, authority: REGISTRY_AUTHORITY };
  return seal(material);
}

function registry(entries, revision, root) {
  return seal({ schema: REGISTRY_SCHEMA, revision, projectRootDigest: sha256(root), entries,
    authority: REGISTRY_AUTHORITY });
}

export function emptyGoalPremortemRegistry(root) {
  return registry([], 0, root);
}

function validRegistryEntry(entry, goal, root) {
  return exactKeys(entry, ["goalId", "contractVersion", "planDefinitionsDigest", "projectRootDigest",
    "projectId", "groupId", "entityId", "registeredAt", "authority", "digest"])
    && [0, 1].includes(entry.contractVersion) && entry.goalId === goal.goalId
    && entry.planDefinitionsDigest === goal.plan.definitionsDigest
    && entry.projectRootDigest === sha256(root) && entry.projectId === goal.projectId
    && entry.groupId === goal.groupId && entry.entityId === goal.agentId
    && Number.isFinite(new Date(entry.registeredAt).getTime())
    && entry.authority === REGISTRY_AUTHORITY && validSeal(entry)
    && validPlanPremortemContract(goal.plan, entry.contractVersion);
}

export function validGoalPremortemRegistry(policy) {
  const value = policy?.premortemContractRegistry;
  const planGoals = policy?.goals?.filter((goal) => goal.plan) || [];
  return exactKeys(value, ["schema", "revision", "projectRootDigest", "entries", "authority", "digest"])
    && value.schema === REGISTRY_SCHEMA && Number.isInteger(value.revision) && value.revision >= 0
    && value.projectRootDigest === sha256(policy.root) && value.authority === REGISTRY_AUTHORITY
    && Array.isArray(value.entries) && value.entries.length === planGoals.length
    && new Set(value.entries.map((entry) => entry?.goalId)).size === value.entries.length
    && validSeal(value) && planGoals.every((goal) => {
      const entry = value.entries.find((candidate) => candidate.goalId === goal.goalId);
      const historical = historyContractVersion(policy, goal.goalId);
      return validRegistryEntry(entry, goal, policy.root)
        && (historical === undefined || historical === entry.contractVersion);
    });
}

function historyContractVersion(policy, goalId) {
  const versions = (policy.history || []).filter((item) => item?.kind === "goal"
    && item.value?.goalId === goalId && item.value.plan).map((item) => planContractVersion(item.value.plan));
  if (versions.includes(null) || new Set(versions).size > 1) return null;
  return versions[0];
}

export function ensureGoalPremortemRegistry(policy, allowLegacyMigration = false) {
  if (policy?.premortemContractRegistry !== undefined) return validGoalPremortemRegistry(policy);
  if (!allowLegacyMigration || !policy || !Array.isArray(policy.goals) || !Array.isArray(policy.history)
    || typeof policy.root !== "string") return false;
  const entries = [];
  for (const goal of policy.goals.filter((item) => item.plan)) {
    const version = planContractVersion(goal.plan);
    const historical = historyContractVersion(policy, goal.goalId);
    if (version === null || (historical !== undefined && historical !== version)) return false;
    entries.push(registryEntry(goal, version, goal.createdAt, policy.root));
  }
  policy.premortemContractRegistry = registry(entries, entries.length, policy.root);
  return true;
}

export function ensureGoalPremortemPolicy(policy, currentSchema, provenance = null) {
  const legacy = policy?.schema === "agentspine.gateway-policy/v1";
  if (!(legacy || policy?.schema === currentSchema)
    || !Array.isArray(policy.goals) || !Array.isArray(policy.history)) return false;
  const anchored = provenance?.record
    && validGatewayPolicyProvenance(provenance.record, policy.root, currentSchema);
  const currentAnchor = anchored && (provenance.record.state === "committed"
    ? provenance.match === "next" : new Set(["previous", "next"]).has(provenance.match));
  if (legacy ? provenance !== null && !(anchored && provenance.record.state === "prepared"
    && provenance.match === "previous") : !currentAnchor) return false;
  if (legacy) {
    const plans = [...(policy.goals || []).map((goal) => goal?.plan),
      ...(policy.history || []).map((item) => item?.kind === "goal" ? item.value?.plan : null)].filter(Boolean);
    if (plans.some((plan) => planContractVersion(plan) !== 0)) return false;
  }
  if (!ensureGoalPremortemRegistry(policy, legacy)) return false;
  if (legacy) policy.schema = currentSchema;
  return true;
}

export function goalPremortemContractVersion(policy, goalId) {
  return policy?.premortemContractRegistry?.entries?.find((entry) => entry.goalId === goalId)?.contractVersion;
}

export function registerGoalPremortemContract(policy, goal, contractVersion, registeredAt) {
  const value = policy.premortemContractRegistry;
  const existing = value.entries.find((entry) => entry.goalId === goal.goalId);
  if (existing) {
    if (!validRegistryEntry(existing, goal, policy.root) || existing.contractVersion !== contractVersion) {
      throw new Error("goal premortem contract provenance is immutable");
    }
    return existing;
  }
  value.entries.push(registryEntry(goal, contractVersion, registeredAt, policy.root));
  policy.premortemContractRegistry = registry(value.entries, value.revision + 1, policy.root);
  return policy.premortemContractRegistry.entries.at(-1);
}

export function planDefinitionMaterial(steps) {
  return steps.map(({ stepId, agentId, resources, execution, premortemContractVersion,
    title, successCriterion, dependsOn }) => ({
    stepId, ...(agentId === undefined ? {} : { agentId }),
    ...(resources === undefined ? {} : { resources }), ...(execution === undefined ? {} : { execution }),
    ...(premortemContractVersion === undefined ? {} : { premortemContractVersion }),
    title, successCriterion, dependsOn
  }));
}
