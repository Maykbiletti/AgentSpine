import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCatalog } from "./catalog.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { attentionFindings, loadAttention } from "./attention.js";
import {
  channelRuntimeFindings, loadChannelPolicy, loadChannelRuntime
} from "./channel-runtime.js";
import { loadGraph } from "./graph.js";
import { projectStateDir } from "./paths.js";
import { loadPersonaRuntime, personaRuntimeFindings } from "./persona-runtime.js";
import { evaluateVoiceOutput } from "./voice-runtime.js";

export const GATEWAY_POLICY_SCHEMA = "agentspine.gateway-policy/v1";
export const GATEWAY_RUNTIME_SCHEMA = "agentspine.gateway-runtime/v1";
export const GATEWAY_EVENT_SCHEMA = "agentspine.gateway-event/v1";
export const GOAL_PLAN_SCHEMA = "agentspine.goal-plan/v1";
export const KNOWLEDGE_GAP_SCHEMA = "agentspine.knowledge-gap/v1";
export const EXECUTION_OUTCOME_SCHEMA = "agentspine.execution-outcome/v1";
export const STRATEGY_TRANSFER_PROOF_SCHEMA = "agentspine.strategy-transfer-proof/v1";

const CONFIRMATION = "local-owner-confirmed";
const MAX_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const ROUTE_RE = /^-?[A-Za-z0-9][A-Za-z0-9:_.@/+~-]{0,255}$/;
const GOAL_STATUSES = new Set(["active", "blocked", "completed", "cancelled"]);
const PLAN_STEP_STATUSES = new Set(["pending", "active", "blocked", "completed", "cancelled"]);
const QUEUE_STATUSES = new Set(["pending", "leased", "awaiting-delivery", "completed", "blocked", "dead-letter", "cancelled"]);
const OUTBOX_STATUSES = new Set(["prepared", "sending", "delivered", "failed", "dead-letter", "delivery-unknown", "acknowledged"]);
const WAKE_KINDS = new Set(["direct-message", "deadline", "promise", "resolved-blocker", "assignment", "follow-up", "relationship"]);
const PRIORITY = { "direct-message": 100, deadline: 90, promise: 90, "resolved-blocker": 80, assignment: 70, "follow-up": 60, relationship: 50 };
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;
const SECRET_KEY_RE = /"(?:api[-_ ]?key|token|password|secret|credential)"\s*:/i;
const AUTHORITY_RE = /\b(?:permission|rights?|roles?|owner|trusted|delegat|authorized|approval|production|payment|spending|tool capability|send capability)\b/i;
const HEALTH_VALUES = new Set(["stopped", "running", "unknown", "healthy", "degraded", "failed"]);
const KNOWLEDGE_EVIDENCE = new Set(["owner-input", "objective-observation"]);
const METRIC_OPERATORS = new Set(["gte", "lte", "eq"]);

function emptyPolicy(root) {
  return { schema: GATEWAY_POLICY_SCHEMA, root, revision: 0, enabled: false, killSwitch: false, goals: [], history: [] };
}

function emptyRuntime(root) {
  return { schema: GATEWAY_RUNTIME_SCHEMA, root, revision: 0, queue: [], lanes: [], outbox: [], receipts: [], history: [],
    health: { gateway: "stopped", adapter: "unknown", scheduler: "unknown", queue: "healthy", worker: "unknown", host: "unknown", lastTickAt: null, lastReconciledAt: null } };
}

function exactId(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !ID_RE.test(value) || value.includes("*")) throw new Error(field + " must be an exact stable ID without wildcards");
  return value;
}

function safeText(value, field, maximum = 1000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " is required");
  const text = value.trim().replace(/\s+/g, " ").slice(0, maximum);
  if (SECRET_RE.test(text)) throw new Error(field + " appears to contain a secret");
  return text;
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("timestamp is invalid");
  return date.toISOString();
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function safeCheckpoint(value) {
  if (value === null || value === undefined) return null;
  let content;
  try { content = JSON.stringify(value); } catch { throw new Error("checkpoint must be JSON serializable"); }
  if (!content || Buffer.byteLength(content) > 16384) throw new Error("checkpoint exceeds 16 KiB");
  if (SECRET_RE.test(content) || SECRET_KEY_RE.test(content) || AUTHORITY_RE.test(content)) {
    throw new Error("checkpoint contains secret- or authority-shaped content");
  }
  return JSON.parse(content);
}

function safeKnowledgeText(value, field, maximum) {
  const text = safeText(value, field, maximum);
  if (AUTHORITY_RE.test(text)) throw new Error(field + " cannot grant or describe authority");
  return text;
}

function knowledgeGapSubjectMaterial(gap) {
  return {
    goalId: gap.goalId, goalStepId: gap.goalStepId, planDefinitionsDigest: gap.planDefinitionsDigest,
    question: gap.question, reason: gap.reason, requiredEvidence: gap.requiredEvidence,
    authority: "context-only"
  };
}

function knowledgeGapRequestMaterial(gap) {
  return {
    subjectDigest: gap.subjectDigest, requestedAt: gap.requestedAt,
    requestedByQueueId: gap.requestedByQueueId, authority: "context-only"
  };
}

function knowledgeGapResolutionMaterial(gap) {
  return {
    requestDigest: gap.requestDigest, answer: gap.answer, answerSource: gap.answerSource,
    sourceDigest: gap.sourceDigest, resolvedAt: gap.resolvedAt,
    resolvedBySubjectId: gap.resolvedBySubjectId, authority: "context-only"
  };
}

function validKnowledgeGap(gap) {
  if (!(gap && gap.schema === KNOWLEDGE_GAP_SCHEMA && ID_RE.test(gap.gapId || "")
    && ID_RE.test(gap.goalId || "") && ID_RE.test(gap.goalStepId || "")
    && /^[a-f0-9]{64}$/.test(gap.planDefinitionsDigest || "")
    && typeof gap.question === "string" && gap.question.length <= 500
    && typeof gap.reason === "string" && gap.reason.length <= 500
    && KNOWLEDGE_EVIDENCE.has(gap.requiredEvidence)
    && ID_RE.test(gap.requestedByQueueId || "")
    && Number.isFinite(new Date(gap.requestedAt).getTime())
    && /^[a-f0-9]{64}$/.test(gap.subjectDigest || "")
    && /^[a-f0-9]{64}$/.test(gap.requestDigest || "")
    && ["open", "resolved"].includes(gap.status) && gap.authority === "context-only")) return false;
  try {
    if (safeKnowledgeText(gap.question, "knowledgeGap.question", 500) !== gap.question
      || safeKnowledgeText(gap.reason, "knowledgeGap.reason", 500) !== gap.reason) return false;
  } catch { return false; }
  if (gap.subjectDigest !== sha256(JSON.stringify(knowledgeGapSubjectMaterial(gap)))
    || gap.gapId !== "knowledge-gap:" + gap.subjectDigest.slice(0, 32)
    || gap.requestDigest !== sha256(JSON.stringify(knowledgeGapRequestMaterial(gap)))) return false;
  if (gap.status === "open") return gap.answer === null && gap.answerSource === null && gap.sourceDigest === null
    && gap.resolvedAt === null && gap.resolvedBySubjectId === null && gap.resolutionDigest === null;
  if (!(typeof gap.answer === "string" && gap.answer.length <= 2000
    && gap.answerSource === gap.requiredEvidence
    && (gap.sourceDigest === null || /^[a-f0-9]{64}$/.test(gap.sourceDigest))
    && Number.isFinite(new Date(gap.resolvedAt).getTime()) && ID_RE.test(gap.resolvedBySubjectId || "")
    && /^[a-f0-9]{64}$/.test(gap.resolutionDigest || ""))) return false;
  if (new Date(gap.resolvedAt) < new Date(gap.requestedAt)) return false;
  if ((gap.answerSource === "objective-observation") !== (gap.sourceDigest !== null)) return false;
  try { if (safeKnowledgeText(gap.answer, "knowledgeGap.answer", 2000) !== gap.answer) return false; } catch { return false; }
  return gap.resolutionDigest === sha256(JSON.stringify(knowledgeGapResolutionMaterial(gap)));
}

function executionDecisionMaterial(execution) {
  return {
    requiredCapabilities: execution.requiredCapabilities, strategies: execution.strategies,
    verification: execution.verification, selectedStrategyId: execution.selectedStrategyId,
    ...(execution.transferKey === undefined ? {} : {
      transferKey: execution.transferKey, transferMaxAgeDays: execution.transferMaxAgeDays,
      transferProof: execution.transferProof
    }),
    authority: "context-only-decision"
  };
}

function selectedExecutionStrategy(execution) {
  const required = new Set(execution.requiredCapabilities);
  const sufficient = execution.strategies.filter((strategy) => strategy.capabilities.every((capability) => ID_RE.test(capability))
    && [...required].every((capability) => strategy.capabilities.includes(capability)))
    .sort((left, right) => left.risk - right.risk || left.cost - right.cost
      || left.strategyId.localeCompare(right.strategyId));
  const minimumRisk = sufficient[0]?.risk;
  const transferred = execution.transferProof && sufficient.find((strategy) =>
    strategy.strategyId === execution.transferProof.strategyId && strategy.risk === minimumRisk);
  return transferred || sufficient[0] || null;
}

function strategyTransferProofMaterial(proof) {
  return {
    transferKey: proof.transferKey, strategyId: proof.strategyId, maxAgeDays: proof.maxAgeDays,
    evidence: proof.evidence, authority: "context-only-transfer"
  };
}

function validStrategyTransferProof(proof) {
  if (!(proof && proof.schema === STRATEGY_TRANSFER_PROOF_SCHEMA
    && ID_RE.test(proof.proofId || "") && ID_RE.test(proof.transferKey || "")
    && ID_RE.test(proof.strategyId || "") && Number.isInteger(proof.maxAgeDays)
    && proof.maxAgeDays >= 1 && proof.maxAgeDays <= 90 && Array.isArray(proof.evidence)
    && proof.evidence.length >= 2 && proof.evidence.length <= 8
    && new Set(proof.evidence.map((item) => item.sourceGoalId)).size === proof.evidence.length
    && new Set(proof.evidence.map((item) => item.sourceDigest)).size === proof.evidence.length
    && proof.evidence.every((item) => item && ID_RE.test(item.sourceGoalId || "")
      && ID_RE.test(item.sourceStepId || "") && ID_RE.test(item.outcomeId || "")
      && /^[a-f0-9]{64}$/.test(item.outcomeDigest || "")
      && /^[a-f0-9]{64}$/.test(item.sourceDigest || "")
      && Number.isFinite(new Date(item.completedAt).getTime()))
    && /^[a-f0-9]{64}$/.test(proof.proofDigest || "")
    && proof.authority === "context-only-transfer")) return false;
  const digest = sha256(JSON.stringify(strategyTransferProofMaterial(proof)));
  return proof.proofDigest === digest && proof.proofId === "strategy-transfer:" + digest.slice(0, 32);
}

function sameStrategy(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameVerification(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectStrategyTransferEvidence(goals, execution, strategy, scope) {
  if (!execution.transferKey) return { evidence: [], regressed: false };
  const before = new Date(scope.before);
  const cutoff = new Date(before.getTime() - execution.transferMaxAgeDays * 86400000);
  const evidence = []; let regressed = false;
  for (const goal of goals) {
    if (goal.goalId === scope.goalId || goal.projectId !== scope.projectId || goal.groupId !== scope.groupId || !goal.plan) continue;
    for (const step of goal.plan.steps) {
      const prior = step.execution;
      const completedAt = step.completedAt && new Date(step.completedAt);
      const updatedAt = new Date(step.updatedAt);
      if (!prior || prior.transferKey !== execution.transferKey || prior.selectedStrategyId !== strategy.strategyId
        || !sameVerification(prior.verification, execution.verification)
        || !sameStrategy(prior.strategies.find((item) => item.strategyId === strategy.strategyId), strategy)
        || updatedAt > before) continue;
      for (const outcome of step.executionOutcomes || []) {
        if (outcome.strategyId !== strategy.strategyId) continue;
        const observedAt = new Date(outcome.observedAt);
        if (observedAt < cutoff || observedAt > before || observedAt < new Date(goal.createdAt)) continue;
        if (!outcome.passed || outcome.blockingDefect) { regressed = true; continue; }
        if (step.status !== "completed" || !completedAt || completedAt < cutoff || completedAt > before
          || observedAt > completedAt) continue;
        evidence.push({ sourceGoalId: goal.goalId, sourceStepId: step.stepId, outcomeId: outcome.outcomeId,
          outcomeDigest: outcome.digest, sourceDigest: outcome.sourceDigest, completedAt: step.completedAt });
      }
    }
  }
  const unique = [];
  for (const item of evidence.sort((left, right) => left.completedAt.localeCompare(right.completedAt)
    || left.outcomeId.localeCompare(right.outcomeId))) {
    if (!unique.some((entry) => entry.sourceGoalId === item.sourceGoalId || entry.sourceDigest === item.sourceDigest)) unique.push(item);
  }
  return { evidence: unique.slice(-8), regressed };
}

function createStrategyTransferProof(goals, execution, scope) {
  if (!execution.transferKey) return null;
  const required = new Set(execution.requiredCapabilities);
  const sufficient = execution.strategies.filter((strategy) =>
    [...required].every((capability) => strategy.capabilities.includes(capability)));
  const minimumRisk = Math.min(...sufficient.map((strategy) => strategy.risk));
  const proven = sufficient.filter((strategy) => strategy.risk === minimumRisk).map((strategy) => ({
    strategy, ...collectStrategyTransferEvidence(goals, execution, strategy, scope)
  })).filter((item) => !item.regressed && item.evidence.length >= 2)
    .sort((left, right) => right.evidence.length - left.evidence.length
      || left.strategy.cost - right.strategy.cost || left.strategy.strategyId.localeCompare(right.strategy.strategyId));
  if (!proven.length) return null;
  const proof = { schema: STRATEGY_TRANSFER_PROOF_SCHEMA, proofId: null,
    transferKey: execution.transferKey, strategyId: proven[0].strategy.strategyId,
    maxAgeDays: execution.transferMaxAgeDays, evidence: proven[0].evidence,
    proofDigest: null, authority: "context-only-transfer" };
  proof.proofDigest = sha256(JSON.stringify(strategyTransferProofMaterial(proof)));
  proof.proofId = "strategy-transfer:" + proof.proofDigest.slice(0, 32);
  return proof;
}

function validGoalTransferProofs(goal, goals) {
  if (!goal.plan) return true;
  return goal.plan.steps.every((step) => {
    if (!step.execution?.transferProof) return true;
    const expected = createStrategyTransferProof(goals, step.execution, {
      goalId: goal.goalId, projectId: goal.projectId, groupId: goal.groupId, before: goal.createdAt
    });
    return JSON.stringify(expected) === JSON.stringify(step.execution.transferProof);
  });
}

function validExecutionDecision(execution) {
  if (!(execution && execution.authority === "context-only-decision"
    && Array.isArray(execution.requiredCapabilities) && execution.requiredCapabilities.length > 0
    && execution.requiredCapabilities.length <= 16
    && new Set(execution.requiredCapabilities).size === execution.requiredCapabilities.length
    && execution.requiredCapabilities.every((capability) => ID_RE.test(capability || ""))
    && Array.isArray(execution.strategies) && execution.strategies.length >= 2 && execution.strategies.length <= 8
    && new Set(execution.strategies.map((strategy) => strategy?.strategyId)).size === execution.strategies.length
    && execution.strategies.every((strategy) => strategy && ID_RE.test(strategy.strategyId || "")
      && Array.isArray(strategy.capabilities) && strategy.capabilities.length > 0 && strategy.capabilities.length <= 16
      && new Set(strategy.capabilities).size === strategy.capabilities.length
      && strategy.capabilities.every((capability) => ID_RE.test(capability || ""))
      && Number.isInteger(strategy.risk) && strategy.risk >= 0 && strategy.risk <= 100
      && Number.isInteger(strategy.cost) && strategy.cost >= 0 && strategy.cost <= 100)
    && execution.verification && ID_RE.test(execution.verification.evaluatorId || "")
    && ID_RE.test(execution.verification.metric || "") && METRIC_OPERATORS.has(execution.verification.operator)
    && Number.isFinite(execution.verification.threshold)
    && Number.isInteger(execution.verification.minCases) && execution.verification.minCases >= 1
    && execution.verification.minCases <= 100000 && ID_RE.test(execution.selectedStrategyId || "")
    && (execution.transferKey === undefined || (ID_RE.test(execution.transferKey || "")
      && Number.isInteger(execution.transferMaxAgeDays) && execution.transferMaxAgeDays >= 1
      && execution.transferMaxAgeDays <= 90
      && (execution.transferProof === null || (validStrategyTransferProof(execution.transferProof)
        && execution.transferProof.transferKey === execution.transferKey
        && execution.transferProof.maxAgeDays === execution.transferMaxAgeDays))))
    && /^[a-f0-9]{64}$/.test(execution.decisionDigest || ""))) return false;
  const selected = selectedExecutionStrategy(execution);
  return selected?.strategyId === execution.selectedStrategyId
    && execution.decisionDigest === sha256(JSON.stringify(executionDecisionMaterial(execution)));
}

function createExecutionDecision(value, field, transferContext) {
  if (value === null || value === undefined) return null;
  const execution = {
    requiredCapabilities: Array.isArray(value.requiredCapabilities)
      ? value.requiredCapabilities.map((capability) => exactId(capability, `${field}.requiredCapabilities`)) : [],
    strategies: Array.isArray(value.strategies) ? value.strategies.map((strategy, index) => ({
      strategyId: exactId(strategy?.strategyId, `${field}.strategies[${index}].strategyId`),
      capabilities: Array.isArray(strategy?.capabilities)
        ? strategy.capabilities.map((capability) => exactId(capability, `${field}.strategies[${index}].capabilities`)) : [],
      risk: Number(strategy?.risk), cost: Number(strategy?.cost)
    })) : [],
    verification: {
      evaluatorId: exactId(value.verification?.evaluatorId, `${field}.verification.evaluatorId`),
      metric: exactId(value.verification?.metric, `${field}.verification.metric`),
      operator: value.verification?.operator,
      threshold: Number(value.verification?.threshold), minCases: Number(value.verification?.minCases)
    },
    selectedStrategyId: null, decisionDigest: null, authority: "context-only-decision"
  };
  if (value.transfer !== undefined && value.transfer !== null) {
    execution.transferKey = exactId(value.transfer?.transferKey, `${field}.transfer.transferKey`);
    execution.transferMaxAgeDays = Number(value.transfer?.maxAgeDays);
    execution.transferProof = null;
    execution.transferProof = createStrategyTransferProof(transferContext.goals, execution, transferContext.scope);
  }
  execution.selectedStrategyId = selectedExecutionStrategy(execution)?.strategyId || null;
  execution.decisionDigest = sha256(JSON.stringify(executionDecisionMaterial(execution)));
  if (!validExecutionDecision(execution)) {
    throw new Error(`${field} requires 2-8 bounded strategies and one objective verification gate`);
  }
  return execution;
}

function executionOutcomeMaterial(outcome) {
  return {
    queueId: outcome.queueId, decisionDigest: outcome.decisionDigest, strategyId: outcome.strategyId,
    capabilitiesUsed: outcome.capabilitiesUsed, evaluatorId: outcome.evaluatorId, metric: outcome.metric,
    value: outcome.value, cases: outcome.cases, blockingDefect: outcome.blockingDefect,
    sourceDigest: outcome.sourceDigest, observedAt: outcome.observedAt, passed: outcome.passed,
    authority: "objective-evidence-only"
  };
}

function metricPassed(operator, value, threshold) {
  if (operator === "gte") return value >= threshold;
  if (operator === "lte") return value <= threshold;
  return value === threshold;
}

function validExecutionOutcome(outcome, execution) {
  if (!(outcome && outcome.schema === EXECUTION_OUTCOME_SCHEMA && ID_RE.test(outcome.outcomeId || "")
    && ID_RE.test(outcome.queueId || "") && outcome.decisionDigest === execution.decisionDigest
    && outcome.strategyId === execution.selectedStrategyId && Array.isArray(outcome.capabilitiesUsed)
    && outcome.capabilitiesUsed.length <= 16 && new Set(outcome.capabilitiesUsed).size === outcome.capabilitiesUsed.length
    && outcome.capabilitiesUsed.every((capability) => ID_RE.test(capability || ""))
    && outcome.evaluatorId === execution.verification.evaluatorId && outcome.metric === execution.verification.metric
    && Number.isFinite(outcome.value) && Number.isInteger(outcome.cases) && outcome.cases >= 0
    && typeof outcome.blockingDefect === "boolean" && /^[a-f0-9]{64}$/.test(outcome.sourceDigest || "")
    && Number.isFinite(new Date(outcome.observedAt).getTime()) && typeof outcome.passed === "boolean"
    && /^[a-f0-9]{64}$/.test(outcome.digest || "") && outcome.authority === "objective-evidence-only")) return false;
  const strategy = execution.strategies.find((item) => item.strategyId === execution.selectedStrategyId);
  const used = new Set(outcome.capabilitiesUsed);
  const expectedPass = execution.requiredCapabilities.every((capability) => used.has(capability))
    && outcome.capabilitiesUsed.every((capability) => strategy.capabilities.includes(capability))
    && outcome.cases >= execution.verification.minCases && !outcome.blockingDefect
    && metricPassed(execution.verification.operator, outcome.value, execution.verification.threshold);
  const digest = sha256(JSON.stringify(executionOutcomeMaterial(outcome)));
  return outcome.passed === expectedPass && outcome.digest === digest
    && outcome.outcomeId === "execution-outcome:" + digest.slice(0, 32);
}

function reviewExecutionResult(execution, queueId, report, now) {
  if (!report || report.strategyId !== execution.selectedStrategyId || !Array.isArray(report.capabilitiesUsed)
    || !report.outcome || report.outcome.evaluatorId !== execution.verification.evaluatorId
    || report.outcome.metric !== execution.verification.metric) {
    return { passed: false, outcome: null, reason: "Objective execution evidence is missing or invalid." };
  }
  let outcome;
  try {
    outcome = {
      schema: EXECUTION_OUTCOME_SCHEMA, outcomeId: null, queueId,
      decisionDigest: execution.decisionDigest, strategyId: report.strategyId,
      capabilitiesUsed: report.capabilitiesUsed.map((capability) => exactId(capability, "execution.capabilitiesUsed")),
      evaluatorId: report.outcome.evaluatorId, metric: report.outcome.metric,
      value: Number(report.outcome.value), cases: Number(report.outcome.cases),
      blockingDefect: report.outcome.blockingDefect === true, sourceDigest: String(report.outcome.sourceDigest || ""),
      observedAt: timestamp(report.outcome.observedAt || now), passed: false, digest: null,
      authority: "objective-evidence-only"
    };
    const strategy = execution.strategies.find((item) => item.strategyId === execution.selectedStrategyId);
    const used = new Set(outcome.capabilitiesUsed);
    outcome.passed = execution.requiredCapabilities.every((capability) => used.has(capability))
      && outcome.capabilitiesUsed.every((capability) => strategy.capabilities.includes(capability))
      && outcome.cases >= execution.verification.minCases && !outcome.blockingDefect
      && metricPassed(execution.verification.operator, outcome.value, execution.verification.threshold);
    outcome.digest = sha256(JSON.stringify(executionOutcomeMaterial(outcome)));
    outcome.outcomeId = "execution-outcome:" + outcome.digest.slice(0, 32);
  } catch {
    return { passed: false, outcome: null, reason: "Objective execution evidence is missing or invalid." };
  }
  if (!validExecutionOutcome(outcome, execution)) {
    return { passed: false, outcome: null, reason: "Objective execution evidence is missing or invalid." };
  }
  return { passed: outcome.passed, outcome,
    reason: outcome.passed ? null : "The objective execution gate did not pass." };
}

function planDefinitionMaterial(steps) {
  return steps.map(({ stepId, agentId, resources, execution, title, successCriterion, dependsOn }) => ({
    stepId, ...(agentId === undefined ? {} : { agentId }),
    ...(resources === undefined ? {} : { resources }), ...(execution === undefined ? {} : { execution }),
    title, successCriterion, dependsOn
  }));
}

function validGoalPlan(plan) {
  if (!(plan && plan.schema === GOAL_PLAN_SCHEMA && plan.authority === "context-only-plan"
    && Number.isInteger(plan.revision) && plan.revision >= 0 && Array.isArray(plan.steps)
    && plan.steps.length > 0 && plan.steps.length <= 32 && /^[a-f0-9]{64}$/.test(plan.definitionsDigest || "")
    && (plan.currentStepId === null || ID_RE.test(plan.currentStepId || "")))) return false;
  const ids = new Set(plan.steps.map((step) => step?.stepId));
  if (ids.size !== plan.steps.length || ids.has(undefined)) return false;
  for (const step of plan.steps) {
    if (!(ID_RE.test(step.stepId || "") && typeof step.title === "string" && step.title.length > 0 && step.title.length <= 500
      && (step.agentId === undefined || ID_RE.test(step.agentId || ""))
      && (step.resources === undefined || (Array.isArray(step.resources) && step.resources.length <= 16
        && new Set(step.resources).size === step.resources.length && step.resources.every((resource) => ID_RE.test(resource || ""))))
      && (step.execution === undefined || step.execution === null || validExecutionDecision(step.execution))
      && (step.executionOutcomes === undefined || (Array.isArray(step.executionOutcomes) && step.executionOutcomes.length <= 8
        && new Set(step.executionOutcomes.map((outcome) => outcome.outcomeId)).size === step.executionOutcomes.length
        && (step.executionOutcomes.length === 0 || (step.execution
          && step.executionOutcomes.every((outcome) => validExecutionOutcome(outcome, step.execution))))))
      && typeof step.successCriterion === "string" && step.successCriterion.length > 0 && step.successCriterion.length <= 1000
      && Array.isArray(step.dependsOn) && new Set(step.dependsOn).size === step.dependsOn.length
      && step.dependsOn.every((dependency) => ids.has(dependency) && dependency !== step.stepId)
      && PLAN_STEP_STATUSES.has(step.status)
      && (step.checkpoint === null || (() => { try { safeCheckpoint(step.checkpoint); return true; } catch { return false; } })())
      && (step.blocker === null || (typeof step.blocker === "string" && step.blocker.length <= 500 && !SECRET_RE.test(step.blocker)))
      && (step.completedAt === null || Number.isFinite(new Date(step.completedAt).getTime()))
      && (step.completedByQueueId === null || ID_RE.test(step.completedByQueueId || ""))
      && (step.knowledgeGaps === undefined || (Array.isArray(step.knowledgeGaps) && step.knowledgeGaps.length <= 16
        && new Set(step.knowledgeGaps.map((gap) => gap.gapId)).size === step.knowledgeGaps.length
        && step.knowledgeGaps.every((gap) => validKnowledgeGap(gap)
          && gap.goalStepId === step.stepId && gap.planDefinitionsDigest === plan.definitionsDigest)))
      && Number.isFinite(new Date(step.updatedAt).getTime()))) return false;
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (stepId) => {
    if (visiting.has(stepId)) return false;
    if (visited.has(stepId)) return true;
    visiting.add(stepId);
    const step = plan.steps.find((entry) => entry.stepId === stepId);
    if (!step.dependsOn.every(visit)) return false;
    visiting.delete(stepId); visited.add(stepId); return true;
  };
  if (!plan.steps.every((step) => visit(step.stepId))) return false;
  const completed = new Set(plan.steps.filter((step) => step.status === "completed").map((step) => step.stepId));
  if (plan.steps.some((step) => ["completed", "active", "blocked"].includes(step.status)
    && !step.dependsOn.every((dependency) => completed.has(dependency)))) return false;
  if (plan.steps.some((step) => (step.status === "completed") !== (step.completedAt !== null && step.completedByQueueId !== null))) return false;
  if (plan.steps.some((step) => (step.status === "blocked") !== (step.blocker !== null))) return false;
  if (plan.steps.some((step) => (step.knowledgeGaps || []).filter((gap) => gap.status === "open").length > 1)) return false;
  if (plan.steps.some((step) => (step.knowledgeGaps || []).some((gap) => gap.status === "open")
    && step.status !== "blocked")) return false;
  if (plan.steps.some((step) => step.execution && step.status === "completed"
    && !(step.executionOutcomes || []).some((outcome) => outcome.passed))) return false;
  if (plan.definitionsDigest !== sha256(JSON.stringify(planDefinitionMaterial(plan.steps)))) return false;
  const current = plan.steps.filter((step) => ["active", "blocked"].includes(step.status));
  return current.length <= 1 && (plan.currentStepId === null
    ? current.length === 0 : current.length === 1 && current[0].stepId === plan.currentStepId);
}

function activateNextPlanStep(plan, now) {
  const completed = new Set(plan.steps.filter((step) => step.status === "completed").map((step) => step.stepId));
  const next = plan.steps.find((step) => step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency)));
  if (!next) { plan.currentStepId = null; return null; }
  next.status = "active"; next.updatedAt = now; plan.currentStepId = next.stepId; plan.revision += 1;
  return next;
}

function createGoalPlan(steps, now, defaultAgentId, transferContext) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 32) throw new Error("goal plan requires 1-32 steps");
  const normalized = steps.map((step, index) => ({
    stepId: exactId(step?.stepId ?? step?.id, `steps[${index}].stepId`),
    agentId: exactId(step?.agentId ?? defaultAgentId, `steps[${index}].agentId`),
    resources: Array.isArray(step?.resources)
      ? step.resources.map((resource) => exactId(resource, `steps[${index}].resources`)) : [],
    execution: createExecutionDecision(step?.execution, `steps[${index}].execution`, transferContext),
    title: safeText(step?.title, `steps[${index}].title`, 500),
    successCriterion: safeText(step?.successCriterion, `steps[${index}].successCriterion`),
    dependsOn: Array.isArray(step?.dependsOn) ? step.dependsOn.map((dependency) => exactId(dependency, `steps[${index}].dependsOn`)) : [],
    status: "pending", checkpoint: null, blocker: null, completedAt: null, completedByQueueId: null,
    knowledgeGaps: [], executionOutcomes: [], updatedAt: now
  }));
  const plan = { schema: GOAL_PLAN_SCHEMA, revision: 0, currentStepId: null, steps: normalized,
    definitionsDigest: sha256(JSON.stringify(planDefinitionMaterial(normalized))), authority: "context-only-plan" };
  if (!validGoalPlan(plan)) throw new Error("goal plan must be an acyclic dependency graph with exact unique step IDs");
  activateNextPlanStep(plan, now);
  return plan;
}

function currentPlanStep(goal) {
  return goal.plan?.steps.find((step) => step.stepId === goal.plan.currentStepId) || null;
}

function planStepAgentId(goal, step) {
  return step?.agentId ?? goal.agentId;
}

function planStepResources(step) {
  return Array.isArray(step?.resources) ? step.resources : [];
}

function queuePlanStep(policy, item) {
  if (!item.goalStepId) return null;
  return policy.goals.find((goal) => goal.goalId === item.goalId)?.plan?.steps
    .find((step) => step.stepId === item.goalStepId) || null;
}

function conflictingResources(policy, candidate, leased) {
  const wanted = new Set(planStepResources(queuePlanStep(policy, candidate)));
  if (!wanted.size || candidate.projectId !== leased.projectId || candidate.groupId !== leased.groupId) return [];
  return planStepResources(queuePlanStep(policy, leased)).filter((resource) => wanted.has(resource));
}

function effectiveQueuePriority(policy, item) {
  if (!item.goalId) return item.priority;
  return policy.goals.find((goal) => goal.goalId === item.goalId)?.priority ?? item.priority;
}

function createKnowledgeGap(goal, step, queueId, request, now) {
  const gap = {
    schema: KNOWLEDGE_GAP_SCHEMA, gapId: null, goalId: goal.goalId, goalStepId: step.stepId,
    planDefinitionsDigest: goal.plan.definitionsDigest,
    question: safeKnowledgeText(request?.question, "knowledgeGap.question", 500),
    reason: safeKnowledgeText(request?.reason, "knowledgeGap.reason", 500),
    requiredEvidence: request?.requiredEvidence,
    requestedAt: now, requestedByQueueId: exactId(queueId, "requestedByQueueId"),
    subjectDigest: null, requestDigest: null, status: "open", answer: null, answerSource: null,
    sourceDigest: null, resolvedAt: null, resolvedBySubjectId: null, resolutionDigest: null,
    authority: "context-only"
  };
  if (!KNOWLEDGE_EVIDENCE.has(gap.requiredEvidence)) {
    throw new Error("knowledgeGap.requiredEvidence must be owner-input or objective-observation");
  }
  gap.subjectDigest = sha256(JSON.stringify(knowledgeGapSubjectMaterial(gap)));
  gap.gapId = "knowledge-gap:" + gap.subjectDigest.slice(0, 32);
  gap.requestDigest = sha256(JSON.stringify(knowledgeGapRequestMaterial(gap)));
  if (!validKnowledgeGap(gap)) throw new Error("knowledge gap request is invalid");
  return gap;
}

function planQueueKey(goalId, stepId, phase, suffix = "") {
  return ["goal", goalId, "step", stepId, phase, suffix].filter(Boolean).join(":");
}

function newGoalQueue(goal, step, kind, key, current, availableAt = current) {
  return { queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind,
    agentId: planStepAgentId(goal, step), projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
    goalStepId: step?.stepId || null, channelEventId: null, priority: goal.priority, status: "pending",
    attempts: 0, lease: null, availableAt, createdAt: current, updatedAt: current,
    completedAt: null, lastError: null, authority: "execution-state-only" };
}

function validGoal(goal) {
  return goal && ID_RE.test(goal.goalId || "") && ID_RE.test(goal.agentId || "")
    && ID_RE.test(goal.ownerSubjectId || "") && ID_RE.test(goal.projectId || "")
    && (goal.groupId === null || ID_RE.test(goal.groupId || "")) && GOAL_STATUSES.has(goal.status)
    && typeof goal.successCriterion === "string" && goal.successCriterion.length > 0
    && typeof goal.nextSafeStep === "string" && goal.nextSafeStep.length > 0
    && (goal.deadline === null || Number.isFinite(new Date(goal.deadline).getTime()))
    && Number.isInteger(goal.priority) && goal.priority >= 0 && goal.priority <= 100
    && (goal.checkpoint === null || (() => { try { safeCheckpoint(goal.checkpoint); return true; } catch { return false; } })())
    && (goal.blocker === null || (typeof goal.blocker === "string" && goal.blocker.length <= 500 && !SECRET_RE.test(goal.blocker)))
    && (goal.heartbeatAt === null || Number.isFinite(new Date(goal.heartbeatAt).getTime()))
    && goal.authority === "authenticated-goal-policy" && Number.isFinite(new Date(goal.createdAt).getTime())
    && Number.isFinite(new Date(goal.updatedAt).getTime())
    && (goal.plan === undefined || goal.plan === null || (validGoalPlan(goal.plan)
      && goal.plan.steps.every((step) => (step.knowledgeGaps || []).every((gap) => gap.goalId === goal.goalId))
      && (goal.status !== "active" || (currentPlanStep(goal)?.status === "active" && goal.nextSafeStep === currentPlanStep(goal).title))
      && (goal.status !== "blocked" || currentPlanStep(goal)?.status === "blocked")
      && (goal.status !== "completed" || goal.plan.steps.every((step) => step.status === "completed"))));
}

function validPolicyHistory(item) {
  if (!item || item.authority !== "authenticated-goal-policy" || !Number.isFinite(new Date(item.at).getTime())) return false;
  if (item.kind === "goal") return validGoal(item.value);
  return item.kind === "control" && item.value && typeof item.value.enabled === "boolean" && typeof item.value.killSwitch === "boolean";
}

function validQueue(item) {
  return item && ID_RE.test(item.queueId || "") && WAKE_KINDS.has(item.kind)
    && ID_RE.test(item.dedupeKey || "") && item.queueId === "gateway-queue:" + sha256(item.dedupeKey).slice(0, 32)
    && ID_RE.test(item.agentId || "") && ID_RE.test(item.projectId || "")
    && (item.groupId === null || ID_RE.test(item.groupId || ""))
    && (item.goalId === null || ID_RE.test(item.goalId || ""))
    && (item.goalStepId === undefined || item.goalStepId === null || (item.goalId !== null && ID_RE.test(item.goalStepId || "")))
    && (item.channelEventId === null || ID_RE.test(item.channelEventId || ""))
    && QUEUE_STATUSES.has(item.status) && Number.isInteger(item.priority) && item.priority >= 0 && item.priority <= 100
    && Number.isInteger(item.attempts) && item.attempts >= 0 && item.attempts <= 20
    && item.authority === "execution-state-only" && Number.isFinite(new Date(item.createdAt).getTime())
    && Number.isFinite(new Date(item.availableAt).getTime()) && Number.isFinite(new Date(item.updatedAt).getTime())
    && (item.completedAt === null || Number.isFinite(new Date(item.completedAt).getTime()))
    && (item.lastError === null || (typeof item.lastError === "string" && item.lastError.length <= 500 && !SECRET_RE.test(item.lastError)))
    && (item.lease === null || (item.status === "leased" && ID_RE.test(item.lease.workerId || "")
      && Number.isFinite(new Date(item.lease.expiresAt).getTime())));
}

function validOutbox(item) {
  return item && ID_RE.test(item.outboxId || "") && ID_RE.test(item.queueId || "")
    && ID_RE.test(item.idempotencyKey || "") && ID_RE.test(item.bindingId || "")
    && item.outboxId === "gateway-outbox:" + sha256(item.idempotencyKey).slice(0, 32)
    && ID_RE.test(item.eventId || "") && ROUTE_RE.test(item.provider || "") && ROUTE_RE.test(item.tenantId || "")
    && ROUTE_RE.test(item.accountId || "") && ROUTE_RE.test(item.chatId || "")
    && (item.threadId === null || ROUTE_RE.test(item.threadId || "")) && (item.replyTo === null || ROUTE_RE.test(item.replyTo || ""))
    && OUTBOX_STATUSES.has(item.status)
    && typeof item.text === "string" && item.text.length > 0 && item.text.length <= 16000 && !SECRET_RE.test(item.text)
    && Number.isInteger(item.attempts) && item.attempts >= 0 && item.attempts <= 20
    && item.authority === "delivery-state-only" && Number.isFinite(new Date(item.createdAt).getTime())
    && Number.isFinite(new Date(item.updatedAt).getTime()) && Number.isFinite(new Date(item.nextAttemptAt).getTime())
    && (item.deliveredAt === null || Number.isFinite(new Date(item.deliveredAt).getTime()))
    && (item.adapterReceipt === null || (typeof item.adapterReceipt === "string" && item.adapterReceipt.length <= 500))
    && (item.lastError === null || (typeof item.lastError === "string" && item.lastError.length <= 500 && !SECRET_RE.test(item.lastError)));
}

function validLane(item) {
  return item && ID_RE.test(item.agentId || "") && ID_RE.test(item.queueId || "") && ID_RE.test(item.workerId || "")
    && new Set(["leased", "completed", "expired"]).has(item.status)
    && Number.isFinite(new Date(item.claimedAt).getTime()) && Number.isFinite(new Date(item.expiresAt).getTime())
    && Number.isFinite(new Date(item.updatedAt).getTime()) && item.authority === "execution-state-only";
}

function validReceipt(item) {
  if (!(item && ID_RE.test(item.id || "") && ID_RE.test(item.kind || "") && ID_RE.test(item.objectId || "")
    && Number.isFinite(new Date(item.at).getTime()) && item.details && typeof item.details === "object"
    && !Array.isArray(item.details) && !SECRET_RE.test(JSON.stringify(item.details))
    && item.authority === "execution-state-only" && /^[a-f0-9]{64}$/.test(item.digest || ""))) return false;
  const material = { kind: item.kind, objectId: item.objectId, at: item.at, details: item.details, authority: "execution-state-only" };
  return item.digest === sha256(JSON.stringify(material)) && item.id === "gateway-receipt:" + item.digest.slice(0, 24);
}

function validHistory(item) {
  if (!(item && new Set(["queue", "outbox"]).has(item.kind) && ID_RE.test(item.objectId || "")
    && ID_RE.test(item.transition || "") && Number.isFinite(new Date(item.at).getTime())
    && item.value && item.authority === "execution-state-only")) return false;
  return item.kind === "queue" ? validQueue(item.value) && item.objectId === item.value.queueId
    : validOutbox(item.value) && item.objectId === item.value.outboxId;
}

function validHealth(health) {
  return health && ["gateway", "adapter", "scheduler", "queue", "worker", "host"].every((key) => HEALTH_VALUES.has(health[key]))
    && (health.lastTickAt === null || Number.isFinite(new Date(health.lastTickAt).getTime()))
    && (health.lastReconciledAt === null || Number.isFinite(new Date(health.lastReconciledAt).getTime()));
}

function normalizePolicy(value, root) {
  if (!value || value.schema !== GATEWAY_POLICY_SCHEMA || value.root !== root
    || !Number.isInteger(value.revision) || typeof value.enabled !== "boolean" || typeof value.killSwitch !== "boolean"
    || !Array.isArray(value.goals) || !Array.isArray(value.history) || value.goals.some((item) => !validGoal(item))
    || value.goals.some((item) => !validGoalTransferProofs(item, value.goals))
    || value.history.some((item) => !validPolicyHistory(item))) {
    throw new Error("gateway policy is invalid; autonomous runtime is disabled");
  }
  return value;
}

function normalizeRuntime(value, root) {
  const baseValid = value && value.schema === GATEWAY_RUNTIME_SCHEMA && value.root === root && Number.isInteger(value.revision)
    && Array.isArray(value.queue) && Array.isArray(value.lanes) && Array.isArray(value.outbox)
    && Array.isArray(value.receipts) && Array.isArray(value.history);
  if (!baseValid) throw new Error("gateway runtime structure is invalid; worker is disabled");
  const invalid = [];
  if (!validHealth(value.health)) invalid.push("health");
  const queueIndex = value.queue.findIndex((item) => !validQueue(item));
  const laneIndex = value.lanes.findIndex((item) => !validLane(item));
  const outboxIndex = value.outbox.findIndex((item) => !validOutbox(item));
  const receiptIndex = value.receipts.findIndex((item) => !validReceipt(item));
  const historyIndex = value.history.findIndex((item) => !validHistory(item));
  if (queueIndex >= 0) invalid.push("queue:" + queueIndex);
  if (laneIndex >= 0) invalid.push("lanes:" + laneIndex);
  if (outboxIndex >= 0) invalid.push("outbox:" + outboxIndex);
  if (receiptIndex >= 0) invalid.push("receipts:" + receiptIndex);
  if (historyIndex >= 0) invalid.push("history:" + historyIndex);
  if (invalid.length) throw new Error("gateway runtime is invalid (" + invalid.join(",") + "); worker is disabled");
  return value;
}

async function pathsFor(root, catalog = null) {
  catalog ||= await buildCatalog(root);
  const directory = await projectStateDir(catalog.root);
  return { catalog, directory, gatewayPolicyPath: join(directory, "gateway-policy.json"), gatewayRuntimePath: join(directory, "gateway-runtime.json") };
}

async function readJson(path, root, normalize, empty) {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_BYTES) throw new Error("gateway state exceeds 8 MiB");
    return normalize(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return empty(root);
  }
}

async function writeJson(path, value) {
  const content = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("gateway state exceeds 8 MiB");
  const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
  try { await writeFile(temporary, content, { mode: 0o600 }); await replaceFileWithRetry(temporary, path); }
  finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function withLock(paths, task) {
  const lockPath = join(paths.directory, "gateway-runtime.lock");
  let handle;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { handle = await open(lockPath, "wx", 0o600); break; } catch (error) {
      if (!isFileLockContention(error)) throw error;
      try { const metadata = await stat(lockPath); if (Date.now() - metadata.mtimeMs > 120000) await unlink(lockPath); }
      catch (lockError) { if (lockError.code !== "ENOENT") throw lockError; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("gateway state is busy; retry later");
  try { return await task(); } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function appendReceipt(runtime, kind, objectId, now, details = {}) {
  const material = { kind, objectId, at: now, details, authority: "execution-state-only" };
  const digest = sha256(JSON.stringify(material));
  const id = "gateway-receipt:" + digest.slice(0, 24);
  const previous = runtime.receipts.find((item) => item.id === id);
  if (previous) return previous;
  const receipt = { id, ...material, digest };
  runtime.receipts.push(receipt);
  return receipt;
}

function preserve(runtime, kind, value, transition, now) {
  runtime.history.push({ kind, objectId: kind === "outbox" ? value.outboxId : value.queueId, transition, at: now,
    value: structuredClone(value), authority: "execution-state-only" });
}

function currentLane(runtime, agentId) {
  return runtime.lanes.find((item) => item.agentId === agentId && item.status === "leased") || null;
}

function assertActivePersona(personaPolicy, personaRuntime, agentId, projectId, groupId) {
  const findings = personaRuntimeFindings(personaPolicy, personaRuntime);
  if (findings.length) throw new Error("persona runtime is unhealthy: " + findings.join(", "));
  const persona = personaRuntime.personas.find((item) => item.personaId === agentId && item.status === "active");
  if (!persona || !["agent", "bot"].includes(persona.kind)) throw new Error("gateway work requires an active authenticated agent or bot");
  if (groupId !== null && persona.groupId !== groupId) throw new Error("gateway work group does not match authenticated persona membership");
  const binding = personaPolicy.bindings.find((item) => item.id === persona.bindingId && item.active);
  if (!binding || !binding.tenantId || !binding.profileId || !projectId) throw new Error("gateway work lacks an active authenticated identity binding");
  return { persona, binding };
}

export async function setGatewayControl({ root = process.cwd(), enabled, killSwitch, confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("gateway control changes require explicit local owner confirmation");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const policy = await readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy);
    const previous = { enabled: policy.enabled, killSwitch: policy.killSwitch };
    if (enabled !== undefined) policy.enabled = Boolean(enabled);
    if (killSwitch !== undefined) policy.killSwitch = Boolean(killSwitch);
    policy.revision += 1;
    policy.history.push({ kind: "control", at: timestamp(now), value: previous, authority: "authenticated-goal-policy" });
    await writeJson(paths.gatewayPolicyPath, policy);
    return { enabled: policy.enabled, killSwitch: policy.killSwitch, revision: policy.revision };
  });
}

export async function assignGoal({ root = process.cwd(), goalId, agentId, ownerSubjectId, projectId, groupId = null,
  priority = 70, successCriterion, nextSafeStep = null, steps = null, deadline = null, confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("goal assignment requires explicit local owner confirmation");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    goalId = exactId(goalId, "goalId"); agentId = exactId(agentId, "agentId");
    projectId = exactId(projectId, "projectId"); groupId = exactId(groupId, "groupId", true);
    const leadIdentity = assertActivePersona(personas.policy, personas.runtime, agentId, projectId, groupId);
    const createdAt = timestamp(now);
    const active = policy.goals.find((item) => item.agentId === agentId && item.status === "active" && item.goalId !== goalId);
    if (active) throw new Error("an agent may have only one active focused goal");
    const plan = steps === null ? null : createGoalPlan(steps, createdAt, agentId, {
      goals: policy.goals, scope: { goalId, projectId, groupId, before: createdAt }
    });
    if (plan) {
      for (const stepAgentId of new Set(plan.steps.map((step) => step.agentId))) {
        const stepIdentity = assertActivePersona(personas.policy, personas.runtime, stepAgentId, projectId, groupId);
        if (stepIdentity.binding.tenantId !== leadIdentity.binding.tenantId) {
          throw new Error("goal-plan team members must share the authenticated tenant and exact project group");
        }
      }
    }
    const firstStep = plan ? plan.steps.find((step) => step.stepId === plan.currentStepId) : null;
    const goal = { goalId, agentId, ownerSubjectId: exactId(ownerSubjectId, "ownerSubjectId"),
      projectId, groupId, priority: Number(priority), successCriterion: safeText(successCriterion, "successCriterion"),
      nextSafeStep: safeText(firstStep?.title || nextSafeStep, "nextSafeStep"), deadline: deadline === null ? null : timestamp(deadline),
      status: "active", checkpoint: null, heartbeatAt: null, blocker: null, createdAt, updatedAt: createdAt,
      plan, authority: "authenticated-goal-policy" };
    if (!validGoal(goal)) throw new Error("goal assignment is invalid");
    const previous = policy.goals.find((item) => item.goalId === goal.goalId);
    if (previous && [previous.agentId, previous.ownerSubjectId, previous.projectId, previous.groupId].join("\0")
      !== [goal.agentId, goal.ownerSubjectId, goal.projectId, goal.groupId].join("\0")) throw new Error("goal scope is immutable");
    if (previous?.plan && previous.plan.definitionsDigest !== goal.plan?.definitionsDigest) {
      throw new Error("goal plan definitions are immutable; assign a new goal ID");
    }
    if (previous?.plan && previous.status === "blocked") {
      const blockedStep = currentPlanStep(previous);
      if (!blockedStep || blockedStep.status !== "blocked") throw new Error("blocked goal plan has no bound blocked step");
      if ((blockedStep.knowledgeGaps || []).some((gap) => gap.status === "open")) {
        throw new Error("blocked goal plan has an open knowledge gap; resolve it with goal-clarify");
      }
      policy.history.push({ kind: "goal", at: createdAt, value: structuredClone(previous), authority: "authenticated-goal-policy" });
      blockedStep.status = "active"; blockedStep.blocker = null; blockedStep.updatedAt = createdAt;
      previous.status = "active"; previous.blocker = null; previous.updatedAt = createdAt; previous.plan.revision += 1;
      policy.revision += 1;
      const key = planQueueKey(previous.goalId, blockedStep.stepId, "owner-resume", String(previous.plan.revision));
      const queued = newGoalQueue(previous, blockedStep, "follow-up", key, createdAt);
      runtime.queue.push(queued); runtime.revision += 1;
      appendReceipt(runtime, "goal-step-resumed", queued.queueId, createdAt, { goalStepId: blockedStep.stepId });
      await Promise.all([writeJson(paths.gatewayPolicyPath, policy), writeJson(paths.gatewayRuntimePath, runtime)]);
      return { goal: structuredClone(previous), gatewayPolicyPath: paths.gatewayPolicyPath, resumed: true };
    }
    if (previous?.plan) return { goal: structuredClone(previous), gatewayPolicyPath: paths.gatewayPolicyPath, duplicate: true };
    if (previous) {
      policy.history.push({ kind: "goal", at: createdAt, value: structuredClone(previous), authority: "authenticated-goal-policy" });
      goal.createdAt = previous.createdAt;
    }
    policy.goals = policy.goals.filter((item) => item.goalId !== goal.goalId);
    policy.goals.push(goal);
    policy.revision += 1;
    const key = firstStep ? planQueueKey(goal.goalId, firstStep.stepId, "assignment") : "goal:" + goal.goalId + ":assignment";
    if (!runtime.queue.some((item) => item.dedupeKey === key)) {
      runtime.queue.push(newGoalQueue(goal, firstStep, "assignment", key, createdAt));
      runtime.revision += 1;
      appendReceipt(runtime, "queued", "gateway-queue:" + sha256(key).slice(0, 32), createdAt, { kind: "assignment", dedupeKey: key });
    }
    await Promise.all([writeJson(paths.gatewayPolicyPath, policy), writeJson(paths.gatewayRuntimePath, runtime)]);
    return { goal, gatewayPolicyPath: paths.gatewayPolicyPath };
  });
}

export async function resolveGoalKnowledgeGap({ root = process.cwd(), goalId, gapId, answer,
  answerSource = "owner-input", sourceDigest = null, confirmation, now = new Date() }) {
  if (confirmation !== CONFIRMATION) throw new Error("knowledge gap resolution requires explicit local owner confirmation");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    goalId = exactId(goalId, "goalId"); gapId = exactId(gapId, "gapId");
    const goal = policy.goals.find((item) => item.goalId === goalId);
    const step = goal && currentPlanStep(goal);
    if (!goal?.plan || !step) throw new Error("knowledge gap resolution requires the exact current goal-plan step");
    assertActivePersona(personas.policy, personas.runtime, goal.agentId, goal.projectId, goal.groupId);
    const gap = (step.knowledgeGaps || []).find((item) => item.gapId === gapId);
    if (!gap) throw new Error("knowledge gap is not bound to the current goal-plan step");
    answer = safeKnowledgeText(answer, "answer", 2000);
    if (!KNOWLEDGE_EVIDENCE.has(answerSource) || answerSource !== gap.requiredEvidence) {
      throw new Error("answer source does not satisfy the requested evidence class");
    }
    sourceDigest = sourceDigest === null || sourceDigest === undefined || sourceDigest === "" ? null : String(sourceDigest);
    if ((answerSource === "objective-observation") !== (/^[a-f0-9]{64}$/.test(sourceDigest || ""))) {
      throw new Error("objective observation answers require one exact SHA-256 source digest");
    }
    if (gap.status === "resolved") {
      if (gap.answer !== answer || gap.answerSource !== answerSource || gap.sourceDigest !== sourceDigest) {
        throw new Error("knowledge gap already has a different bound resolution");
      }
      return { goal: structuredClone(goal), gap: structuredClone(gap), duplicate: true };
    }
    if (goal.status !== "blocked" || step.status !== "blocked") {
      throw new Error("open knowledge gap resolution requires the exact blocked goal-plan step");
    }
    const resolvedAt = timestamp(now);
    const candidate = { ...gap, status: "resolved", answer, answerSource, sourceDigest,
      resolvedAt, resolvedBySubjectId: goal.ownerSubjectId, resolutionDigest: null };
    candidate.resolutionDigest = sha256(JSON.stringify(knowledgeGapResolutionMaterial(candidate)));
    if (!validKnowledgeGap(candidate)) throw new Error("knowledge gap resolution is invalid");
    policy.history.push({ kind: "goal", at: resolvedAt, value: structuredClone(goal), authority: "authenticated-goal-policy" });
    Object.assign(gap, candidate);
    step.status = "active"; step.blocker = null; step.updatedAt = resolvedAt;
    goal.status = "active"; goal.blocker = null; goal.updatedAt = resolvedAt; goal.nextSafeStep = step.title;
    goal.plan.revision += 1; policy.revision += 1;
    const key = planQueueKey(goal.goalId, step.stepId, "clarified", gap.resolutionDigest.slice(0, 20));
    let queued = runtime.queue.find((item) => item.dedupeKey === key);
    if (!queued) {
      queued = newGoalQueue(goal, step, "follow-up", key, resolvedAt);
      runtime.queue.push(queued); runtime.revision += 1;
      appendReceipt(runtime, "knowledge-gap-resolved", queued.queueId, resolvedAt, {
        goalStepId: step.stepId, gapId: gap.gapId, answerSource
      });
    }
    await Promise.all([writeJson(paths.gatewayPolicyPath, policy), writeJson(paths.gatewayRuntimePath, runtime)]);
    return { goal: structuredClone(goal), gap: structuredClone(gap), queueId: queued.queueId, duplicate: false };
  });
}

export async function enqueueGatewayWake({ root = process.cwd(), kind, agentId, projectId, groupId = null, goalId = null,
  channelEventId = null, dedupeKey, availableAt = null, now = new Date() }) {
  if (!WAKE_KINDS.has(kind)) throw new Error("unsupported gateway wake kind");
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway is disabled by local policy");
    agentId = exactId(agentId, "agentId"); projectId = exactId(projectId, "projectId"); groupId = exactId(groupId, "groupId", true);
    assertActivePersona(personas.policy, personas.runtime, agentId, projectId, groupId);
    goalId = exactId(goalId, "goalId", true); channelEventId = exactId(channelEventId, "channelEventId", true);
    const key = exactId(dedupeKey, "dedupeKey");
    const existing = runtime.queue.find((item) => item.dedupeKey === key);
    if (existing) return { item: existing, duplicate: true };
    const createdAt = timestamp(now);
    const item = { queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind, agentId, projectId, groupId,
      goalId, goalStepId: null, channelEventId, priority: PRIORITY[kind], status: "pending", attempts: 0, lease: null,
      availableAt: availableAt === null ? createdAt : timestamp(availableAt), createdAt, updatedAt: createdAt,
      completedAt: null, lastError: null, authority: "execution-state-only" };
    runtime.queue.push(item); runtime.revision += 1;
    appendReceipt(runtime, "queued", item.queueId, createdAt, { kind, dedupeKey: key });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item, duplicate: false };
  });
}

export async function reconcileGateway({ root = process.cwd(), now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channel, attention, personas, { graph }] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadAttention(paths.catalog.root, paths.catalog), loadPersonaRuntime(paths.catalog.root, paths.catalog),
      loadGraph(paths.catalog.root, paths.catalog)
    ]);
    const current = timestamp(now);
    const findings = personaRuntimeFindings(personas.policy, personas.runtime, graph);
    if (findings.length) throw new Error("persona runtime is unhealthy: " + findings.join(", "));
    const channelFindings = channelRuntimeFindings(channel.runtime, channelPolicy.policy, graph);
    if (channelFindings.length) throw new Error("channel runtime is unhealthy: " + channelFindings.join(", "));
    const attentionIssues = attentionFindings(attention.attention);
    if (attentionIssues.length) throw new Error("attention runtime is unhealthy: " + attentionIssues.join(", "));
    for (const lane of runtime.lanes.filter((item) => item.status === "leased" && new Date(item.expiresAt) <= new Date(current))) {
      const item = runtime.queue.find((entry) => entry.queueId === lane.queueId && entry.status === "leased");
      if (item) { preserve(runtime, "queue", item, "lease-expired", current); item.status = item.attempts >= 3 ? "dead-letter" : "pending"; item.lease = null; item.updatedAt = current; }
      lane.status = "expired"; lane.updatedAt = current;
    }
    for (const outbox of runtime.outbox.filter((item) => item.status === "sending")) {
      preserve(runtime, "outbox", outbox, "ambiguous-send-recovery", current);
      outbox.status = "delivery-unknown"; outbox.updatedAt = current;
      appendReceipt(runtime, "delivery-unknown", outbox.outboxId, current, { reason: "crash-during-send" });
    }
    let policyChanged = false;
    if (policy.enabled && !policy.killSwitch) {
      for (const goal of policy.goals.filter((item) => item.status === "active" && item.plan)) {
        const step = currentPlanStep(goal);
        if (!step) throw new Error("active goal plan has no current step");
        try {
          assertActivePersona(personas.policy, personas.runtime, planStepAgentId(goal, step), goal.projectId, goal.groupId);
        } catch {
          policy.history.push({ kind: "goal", at: current, value: structuredClone(goal), authority: "authenticated-goal-policy" });
          const blocker = "Assigned team member is unavailable in this exact project group.";
          step.status = "blocked"; step.blocker = blocker; step.updatedAt = current;
          goal.status = "blocked"; goal.blocker = blocker; goal.updatedAt = current; goal.plan.revision += 1;
          for (const queued of runtime.queue.filter((item) => item.goalId === goal.goalId
            && item.goalStepId === step.stepId && ["pending", "leased"].includes(item.status))) {
            preserve(runtime, "queue", queued, "step-agent-unavailable", current);
            queued.status = "cancelled"; queued.lease = null; queued.completedAt = current; queued.updatedAt = current;
            for (const lane of runtime.lanes.filter((item) => item.queueId === queued.queueId && item.status === "leased")) {
              lane.status = "expired"; lane.updatedAt = current;
            }
            appendReceipt(runtime, "step-agent-unavailable", queued.queueId, current, { goalStepId: step.stepId });
          }
          policy.revision += 1; policyChanged = true;
          continue;
        }
        const runnable = runtime.queue.some((item) => item.goalId === goal.goalId && item.goalStepId === step.stepId
          && item.agentId === planStepAgentId(goal, step)
          && ["pending", "leased", "awaiting-delivery"].includes(item.status));
        if (!runnable) {
          const key = planQueueKey(goal.goalId, step.stepId, "recovery", String(goal.plan.revision));
          if (!runtime.queue.some((item) => item.dedupeKey === key)) {
            const queued = newGoalQueue(goal, step, "follow-up", key, current);
            runtime.queue.push(queued);
            appendReceipt(runtime, "queued", queued.queueId, current, { kind: "follow-up", goalStepId: step.stepId });
          }
        }
      }
      for (const goal of policy.goals.filter((item) => item.status === "active" && item.deadline
        && new Date(item.deadline) <= new Date(current))) {
        const step = currentPlanStep(goal);
        const deadlineAgentId = planStepAgentId(goal, step);
        try { assertActivePersona(personas.policy, personas.runtime, deadlineAgentId, goal.projectId, goal.groupId); }
        catch { continue; }
        const key = "goal:" + goal.goalId + ":deadline:" + goal.deadline;
        if (!runtime.queue.some((item) => item.dedupeKey === key)) runtime.queue.push({
          queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind: "deadline",
          agentId: deadlineAgentId, projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
          goalStepId: step?.stepId || null, channelEventId: null, priority: PRIORITY.deadline, status: "pending", attempts: 0, lease: null,
          availableAt: current, createdAt: current, updatedAt: current, completedAt: null, lastError: null,
          authority: "execution-state-only"
        });
      }
      for (const event of channel.runtime.events.filter((item) => item.status === "pending")) {
        if (!personas.runtime.personas.some((persona) => persona.personaId === event.agentId && persona.status === "active")) continue;
        const key = "channel:" + event.eventId;
        if (!runtime.queue.some((item) => item.dedupeKey === key)) runtime.queue.push({ queueId: "gateway-queue:" + sha256(key).slice(0, 32),
          dedupeKey: key, kind: "direct-message", agentId: event.agentId, projectId: event.projectId, groupId: event.groupId,
          goalId: null, goalStepId: null, channelEventId: event.eventId, priority: PRIORITY["direct-message"], status: "pending", attempts: 0,
          lease: null, availableAt: current, createdAt: current, updatedAt: current, completedAt: null, lastError: null, authority: "execution-state-only" });
      }
      for (const event of attention.attention.events.filter((item) => item.entityId
        && ((item.kind === "promise" && item.status === "open") || (item.kind === "blocker" && item.status === "resolved")))) {
        try { assertActivePersona(personas.policy, personas.runtime, event.entityId, event.projectId, event.groupId); }
        catch { continue; }
        const kind = event.kind === "promise" ? "promise" : "resolved-blocker";
        const key = "attention:" + event.id + ":" + event.status;
        if (!runtime.queue.some((entry) => entry.dedupeKey === key)) runtime.queue.push({ queueId: "gateway-queue:" + sha256(key).slice(0, 32),
          dedupeKey: key, kind, agentId: event.entityId, projectId: event.projectId, groupId: event.groupId,
          goalId: null, goalStepId: null, channelEventId: null, priority: PRIORITY[kind], status: "pending", attempts: 0, lease: null,
          availableAt: event.dueAt || current, createdAt: current, updatedAt: current, completedAt: null, lastError: null, authority: "execution-state-only" });
      }
    }
    runtime.health.gateway = policy.enabled && !policy.killSwitch ? "running" : "stopped";
    runtime.health.scheduler = "healthy"; runtime.health.queue = "healthy"; runtime.health.lastReconciledAt = current;
    runtime.revision += 1;
    if (policyChanged) await Promise.all([
      writeJson(paths.gatewayPolicyPath, policy), writeJson(paths.gatewayRuntimePath, runtime)
    ]);
    else await writeJson(paths.gatewayRuntimePath, runtime);
    return { policy, runtime, recovered: true };
  });
}

export async function claimGatewayWork({ root = process.cwd(), workerId, leaseSeconds = 120, now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) return { item: null, reason: "disabled" };
    const current = timestamp(now); workerId = exactId(workerId, "workerId");
    const seconds = Number(leaseSeconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 900) throw new Error("leaseSeconds must be 15-900");
    const items = runtime.queue.filter((item) => item.status === "pending" && new Date(item.availableAt) <= new Date(current)
      && !currentLane(runtime, item.agentId));
    items.sort((a, b) => effectiveQueuePriority(policy, b) - effectiveQueuePriority(policy, a)
      || a.createdAt.localeCompare(b.createdAt) || a.queueId.localeCompare(b.queueId));
    let item = null; let revoked = false;
    for (const candidate of items) {
      try {
        assertActivePersona(personas.policy, personas.runtime, candidate.agentId, candidate.projectId, candidate.groupId);
      } catch {
        preserve(runtime, "queue", candidate, "identity-revoked", current);
        candidate.status = "cancelled"; candidate.completedAt = current; candidate.updatedAt = current;
        appendReceipt(runtime, "identity-revoked", candidate.queueId, current, {});
        runtime.revision += 1; revoked = true;
        continue;
      }
      if (candidate.goalStepId) {
        const goal = policy.goals.find((entry) => entry.goalId === candidate.goalId);
        const step = goal && currentPlanStep(goal);
        if (!goal?.plan || goal.status !== "active" || step?.stepId !== candidate.goalStepId || step.status !== "active"
          || candidate.agentId !== planStepAgentId(goal, step)) {
          preserve(runtime, "queue", candidate, "plan-step-stale", current);
          candidate.status = "cancelled"; candidate.completedAt = current; candidate.updatedAt = current;
          appendReceipt(runtime, "plan-step-stale", candidate.queueId, current, { goalStepId: candidate.goalStepId });
          runtime.revision += 1; revoked = true;
          continue;
        }
      }
      const resourceConflict = runtime.queue.some((leased) => leased.status === "leased"
        && leased.queueId !== candidate.queueId && conflictingResources(policy, candidate, leased).length > 0);
      if (resourceConflict) continue;
      item = candidate;
      break;
    }
    if (!item && revoked) await writeJson(paths.gatewayRuntimePath, runtime);
    if (!item) return { item: null, reason: runtime.queue.some((entry) => entry.status === "pending") ? "waiting" : "idle/needs-goal" };
    preserve(runtime, "queue", item, "leased", current);
    item.status = "leased"; item.attempts += 1; item.updatedAt = current;
    item.lease = { workerId, claimedAt: current, expiresAt: new Date(new Date(current).getTime() + seconds * 1000).toISOString() };
    runtime.lanes = runtime.lanes.filter((lane) => lane.agentId !== item.agentId || lane.status !== "leased");
    runtime.lanes.push({ agentId: item.agentId, queueId: item.queueId, workerId, status: "leased", claimedAt: current,
      expiresAt: item.lease.expiresAt, updatedAt: current, authority: "execution-state-only" });
    runtime.health.worker = "healthy"; runtime.health.lastTickAt = current; runtime.revision += 1;
    const receipt = appendReceipt(runtime, "leased", item.queueId, current, { workerId, attempt: item.attempts });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item: structuredClone(item), receipt };
  });
}

function exactReplyBinding(channelPolicy, event) {
  const binding = channelPolicy.bindings.find((item) => item.id === event.bindingId && item.status === "active"
    && item.agentId === event.agentId && item.projectId === event.projectId && item.groupId === event.groupId
    && item.provider === event.provider && item.tenantId === event.tenantId && item.accountId === event.accountId
    && item.chatId === event.chatId && item.threadId === event.threadId && item.capabilities.includes("reply"));
  if (!binding) throw new Error("current exact channel reply capability is unavailable");
  return binding;
}

export async function completeGatewayRun({ root = process.cwd(), queueId, workerId, result, now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channelRuntime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway was disabled before run completion");
    const item = runtime.queue.find((entry) => entry.queueId === exactId(queueId, "queueId"));
    workerId = exactId(workerId, "workerId");
    if (!item || item.status !== "leased" || item.lease?.workerId !== workerId) throw new Error("run completion requires the exact active queue lease");
    assertActivePersona(personas.policy, personas.runtime, item.agentId, item.projectId, item.groupId);
    const current = timestamp(now);
    const lane = runtime.lanes.find((entry) => entry.queueId === item.queueId && entry.workerId === workerId && entry.status === "leased");
    if (!lane) throw new Error("agent lane lease is missing");
    const boundGoal = item.goalId ? policy.goals.find((entry) => entry.goalId === item.goalId) : null;
    const boundStep = item.goalStepId ? boundGoal && currentPlanStep(boundGoal) : null;
    if (item.goalStepId) {
      if (!boundGoal?.plan || boundGoal.status !== "active" || boundStep?.stepId !== item.goalStepId
        || boundStep.status !== "active" || item.agentId !== planStepAgentId(boundGoal, boundStep)) {
        throw new Error("run completion is not bound to the current active goal step");
      }
    }
    const knowledgeGapRequest = result?.knowledgeGap === undefined || result?.knowledgeGap === null
      ? null : result.knowledgeGap;
    if (knowledgeGapRequest && (item.channelEventId || !item.goalStepId || !boundGoal?.plan)) {
      throw new Error("knowledge gaps require an exact goal-plan step without a channel obligation");
    }
    if (knowledgeGapRequest && (result?.blocked || result?.completed)) {
      throw new Error("knowledge gap result cannot also complete or generically block a step");
    }
    let executionReview = boundStep?.execution && result?.completed
      ? reviewExecutionResult(boundStep.execution, item.queueId, result.execution, current) : null;
    if (executionReview && (boundStep.executionOutcomes || []).length >= 8) {
      executionReview = { passed: false, outcome: null, reason: "Execution outcome history is full." };
    }
    const text = result?.text ? safeText(result.text, "result.text", 16000) : null;
    let clarification = null;
    preserve(runtime, "queue", item, "run-completed", current);
    if (item.channelEventId) {
      if (!text) throw new Error("a channel obligation requires a non-empty response");
      const voice = evaluateVoiceOutput(text);
      if (!voice.ok) throw new Error("channel response contains a prohibited attachment or consciousness claim");
      const event = channelRuntime.runtime.events.find((entry) => entry.eventId === item.channelEventId);
      if (!event) throw new Error("channel event disappeared before delivery preparation");
      const binding = exactReplyBinding(channelPolicy.policy, event);
      const idempotencyKey = "delivery:" + sha256([event.eventId, binding.id, event.chatId, event.threadId || "", event.replyTo || ""].join("\0")).slice(0, 32);
      let outbox = runtime.outbox.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (!outbox) {
        outbox = { outboxId: "gateway-outbox:" + sha256(idempotencyKey).slice(0, 32), queueId: item.queueId,
          idempotencyKey, bindingId: binding.id, eventId: event.eventId, provider: event.provider, tenantId: event.tenantId,
          accountId: event.accountId, chatId: event.chatId, threadId: event.threadId, replyTo: event.replyTo,
          text, status: "prepared", attempts: 0, nextAttemptAt: current, createdAt: current, updatedAt: current,
          deliveredAt: null, adapterReceipt: null, lastError: null, authority: "delivery-state-only" };
        runtime.outbox.push(outbox);
      }
      item.status = "awaiting-delivery";
    } else {
      item.status = result?.blocked || knowledgeGapRequest || (executionReview && !executionReview.passed)
        ? "blocked" : "completed"; item.completedAt = current;
      const goal = boundGoal;
      if (goal) {
        policy.history.push({ kind: "goal", at: current, value: structuredClone(goal), authority: "authenticated-goal-policy" });
        const checkpoint = result?.checkpoint === undefined ? goal.checkpoint : safeCheckpoint(result.checkpoint);
        goal.checkpoint = checkpoint; goal.heartbeatAt = current;
        goal.blocker = result?.blocked ? safeText(result.blocker || "Run blocked.", "blocker", 500)
          : executionReview && !executionReview.passed ? executionReview.reason : null;
        if (goal.plan && item.goalStepId) {
          const step = currentPlanStep(goal);
          step.checkpoint = checkpoint; step.updatedAt = current;
          if (knowledgeGapRequest) {
            if (!Array.isArray(step.knowledgeGaps)) step.knowledgeGaps = [];
            const proposed = createKnowledgeGap(goal, step, item.queueId, knowledgeGapRequest, current);
            const existing = step.knowledgeGaps.find((gap) => gap.gapId === proposed.gapId);
            if (!existing && step.knowledgeGaps.length >= 16) throw new Error("goal step exceeds 16 knowledge gaps");
            if (existing?.status === "resolved") {
              goal.blocker = "The host repeated an already resolved knowledge gap.";
              step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
              appendReceipt(runtime, "knowledge-gap-regression", item.queueId, current, {
                goalStepId: step.stepId, gapId: existing.gapId
              });
            } else {
              const gap = existing || proposed;
              if (!existing) step.knowledgeGaps.push(gap);
              goal.blocker = gap.question; step.status = "blocked"; step.blocker = gap.question; goal.status = "blocked";
              clarification = structuredClone(gap);
              appendReceipt(runtime, "knowledge-gap-opened", item.queueId, current, {
                goalStepId: step.stepId, gapId: gap.gapId, requiredEvidence: gap.requiredEvidence
              });
            }
            goal.plan.revision += 1;
          } else if (result?.blocked) {
            step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
          } else if (executionReview && !executionReview.passed) {
            if (executionReview.outcome) step.executionOutcomes.push(executionReview.outcome);
            step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
            appendReceipt(runtime, executionReview.outcome ? "execution-gate-failed" : "execution-proof-invalid",
              item.queueId, current, { goalStepId: step.stepId,
                outcomeId: executionReview.outcome?.outcomeId || null });
          } else if (result?.completed) {
            if (executionReview?.outcome) {
              step.executionOutcomes.push(executionReview.outcome);
              appendReceipt(runtime, "execution-gate-passed", item.queueId, current, {
                goalStepId: step.stepId, outcomeId: executionReview.outcome.outcomeId
              });
            }
            step.status = "completed"; step.completedAt = current; step.completedByQueueId = item.queueId; step.blocker = null;
            goal.plan.currentStepId = null; goal.plan.revision += 1;
            const next = activateNextPlanStep(goal.plan, current);
            if (next) {
              goal.status = "active"; goal.nextSafeStep = next.title; goal.blocker = null;
              const key = planQueueKey(goal.goalId, next.stepId, "ready", String(goal.plan.revision));
              if (!runtime.queue.some((entry) => entry.dedupeKey === key)) {
                const queued = newGoalQueue(goal, next, "follow-up", key, current);
                runtime.queue.push(queued);
                appendReceipt(runtime, "goal-step-ready", queued.queueId, current, { goalStepId: next.stepId });
              }
            } else {
              goal.status = "completed";
            }
          } else {
            goal.status = "active"; step.blocker = null;
          }
        } else if (!goal.plan) {
          goal.status = result?.completed ? "completed" : result?.blocked ? "blocked" : "active";
        }
        goal.updatedAt = current;
        policy.revision += 1;
        if (goal.status === "active" && (!goal.plan || !result?.completed)) {
          const checkpointDigest = sha256(JSON.stringify(goal.checkpoint || { heartbeatAt: current })).slice(0, 20);
          const step = currentPlanStep(goal);
          const key = step ? planQueueKey(goal.goalId, step.stepId, "follow-up", checkpointDigest)
            : "goal:" + goal.goalId + ":follow-up:" + checkpointDigest;
          if (!runtime.queue.some((entry) => entry.dedupeKey === key)) runtime.queue.push({
            queueId: "gateway-queue:" + sha256(key).slice(0, 32), dedupeKey: key, kind: "follow-up",
            agentId: planStepAgentId(goal, step), projectId: goal.projectId, groupId: goal.groupId, goalId: goal.goalId,
            goalStepId: step?.stepId || null, channelEventId: null, priority: goal.priority, status: "pending", attempts: 0, lease: null,
            availableAt: new Date(new Date(current).getTime() + 60000).toISOString(), createdAt: current, updatedAt: current,
            completedAt: null, lastError: null, authority: "execution-state-only"
          });
        }
      }
    }
    item.lease = null; item.updatedAt = current; lane.status = "completed"; lane.updatedAt = current;
    runtime.health.host = "healthy"; runtime.health.worker = "healthy"; runtime.health.lastTickAt = current;
    appendReceipt(runtime, "run-terminal", item.queueId, current, { status: item.status, goalStepId: item.goalStepId || null }); runtime.revision += 1;
    await Promise.all([writeJson(paths.gatewayPolicyPath, policy), writeJson(paths.gatewayRuntimePath, runtime)]);
    return { item, outbox: runtime.outbox.find((entry) => entry.queueId === item.queueId) || null,
      clarification, executionReview };
  });
}

export async function failGatewayRun({ root = process.cwd(), queueId, workerId, error, retryAfterMs = 5000,
  now = new Date() }) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const [policy, runtime] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
    ]);
    const item = runtime.queue.find((entry) => entry.queueId === exactId(queueId, "queueId"));
    workerId = exactId(workerId, "workerId");
    if (!item || item.status !== "leased" || item.lease?.workerId !== workerId) {
      throw new Error("run failure requires the exact active queue lease");
    }
    const lane = runtime.lanes.find((entry) => entry.queueId === item.queueId && entry.workerId === workerId
      && entry.status === "leased");
    if (!lane) throw new Error("agent lane lease is missing");
    const current = timestamp(now);
    const message = safeText(String(error || "host runtime unavailable"), "runError", 500);
    const delay = Number(retryAfterMs);
    if (!Number.isFinite(delay) || delay < 250 || delay > 300000) throw new Error("retryAfterMs must be 250-300000");
    preserve(runtime, "queue", item, "run-failed", current);
    item.status = item.attempts >= 3 ? "dead-letter" : "pending";
    item.lease = null; item.lastError = message; item.updatedAt = current;
    item.availableAt = new Date(new Date(current).getTime() + delay).toISOString();
    if (item.status === "dead-letter") item.completedAt = current;
    lane.status = "completed"; lane.updatedAt = current;
    runtime.health.host = "failed"; runtime.health.worker = "degraded"; runtime.health.lastTickAt = current;
    runtime.revision += 1;
    const receipt = appendReceipt(runtime, item.status === "dead-letter" ? "run-dead-letter" : "run-retry",
      item.queueId, current, { attempt: item.attempts });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { item, receipt, policyEnabled: policy.enabled && !policy.killSwitch };
  });
}

export async function deliverPrepared({ root = process.cwd(), outboxId, adapter, now = new Date() }) {
  if (!adapter || typeof adapter.send !== "function") throw new Error("delivery adapter is unavailable");
  const paths = await pathsFor(root);
  let prepared;
  await withLock(paths, async () => {
    const [policy, runtime, channelPolicy, channelRuntime, personas] = await Promise.all([
      readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
      readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime),
      loadChannelPolicy(paths.catalog.root, paths.catalog), loadChannelRuntime(paths.catalog.root, paths.catalog),
      loadPersonaRuntime(paths.catalog.root, paths.catalog)
    ]);
    if (!policy.enabled || policy.killSwitch) throw new Error("gateway was disabled before delivery");
    const outbox = runtime.outbox.find((item) => item.outboxId === exactId(outboxId, "outboxId"));
    if (!outbox) throw new Error("unknown outbox item");
    if (["delivered", "acknowledged"].includes(outbox.status)) { prepared = { duplicate: true, outbox: structuredClone(outbox) }; return; }
    if (outbox.status !== "prepared" && outbox.status !== "failed") throw new Error("outbox item is not safely retryable");
    if (new Date(outbox.nextAttemptAt) > new Date(timestamp(now))) throw new Error("outbox retry is not due");
    const event = channelRuntime.runtime.events.find((item) => item.eventId === outbox.eventId);
    if (!event) throw new Error("outbox channel event is missing");
    try {
      assertActivePersona(personas.policy, personas.runtime, event.agentId, event.projectId, event.groupId);
      exactReplyBinding(channelPolicy.policy, event);
    }
    catch (error) {
      const current = timestamp(now);
      preserve(runtime, "outbox", outbox, "capability-revoked", current);
      outbox.status = "dead-letter"; outbox.lastError = safeText(error.message, "adapterError", 500);
      outbox.updatedAt = current;
      const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
      if (queue) { queue.status = "dead-letter"; queue.completedAt = current; queue.updatedAt = current; }
      runtime.health.adapter = "failed"; runtime.revision += 1;
      const receipt = appendReceipt(runtime, "dead-letter", outbox.outboxId, current, { reason: "identity-or-capability-revoked" });
      await writeJson(paths.gatewayRuntimePath, runtime);
      prepared = { duplicate: false, terminal: true, outbox: structuredClone(outbox), receipt };
      return;
    }
    preserve(runtime, "outbox", outbox, "sending", timestamp(now));
    outbox.status = "sending"; outbox.attempts += 1; outbox.updatedAt = timestamp(now); runtime.revision += 1;
    appendReceipt(runtime, "sending", outbox.outboxId, outbox.updatedAt, { attempt: outbox.attempts });
    await writeJson(paths.gatewayRuntimePath, runtime);
    prepared = { duplicate: false, outbox: structuredClone(outbox) };
  });
  if (prepared.duplicate || prepared.terminal) return prepared;
  let outcome;
  try { outcome = await adapter.send(structuredClone(prepared.outbox)); }
  catch (error) { outcome = { ok: false, effect: "unknown", error: error.message }; }
  return withLock(paths, async () => {
    const runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime);
    const outbox = runtime.outbox.find((item) => item.outboxId === prepared.outbox.outboxId);
    if (!outbox || outbox.status !== "sending") throw new Error("outbox sending state changed unexpectedly");
    const current = timestamp(now);
    preserve(runtime, "outbox", outbox, outcome?.ok ? "delivered" : "send-failed", current);
    if (outcome?.ok) {
      outbox.status = "delivered"; outbox.deliveredAt = current; outbox.adapterReceipt = safeText(String(outcome.receipt || "delivered"), "adapterReceipt", 500);
      runtime.health.adapter = "healthy";
      const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
      if (queue) { queue.status = "completed"; queue.completedAt = current; queue.updatedAt = current; }
    } else if (outcome?.effect === "none") {
      outbox.status = outbox.attempts < 3 ? "failed" : "dead-letter";
      outbox.lastError = safeText(String(outcome.error || "adapter failure"), "adapterError", 500);
      runtime.health.adapter = outbox.status === "failed" ? "degraded" : "failed";
      if (outbox.status === "failed") {
        const delay = Math.min(300000, Number(outcome.retryAfterMs) || 1000 * (2 ** outbox.attempts));
        outbox.nextAttemptAt = new Date(new Date(current).getTime() + delay).toISOString();
      } else {
        const queue = runtime.queue.find((item) => item.queueId === outbox.queueId);
        if (queue) { queue.status = "dead-letter"; queue.completedAt = current; queue.updatedAt = current; }
      }
    } else {
      outbox.status = "delivery-unknown"; outbox.lastError = safeText(String(outcome?.error || "delivery outcome is ambiguous"), "adapterError", 500);
      runtime.health.adapter = "failed";
    }
    outbox.updatedAt = current; runtime.revision += 1;
    const receipt = appendReceipt(runtime, outbox.status, outbox.outboxId, current, { adapterReceipt: outbox.adapterReceipt });
    await writeJson(paths.gatewayRuntimePath, runtime);
    return { outbox, receipt, duplicate: false };
  });
}

export async function updateGatewayHealth({ root = process.cwd(), worker = null, adapter = null, host = null,
  now = new Date() } = {}) {
  const paths = await pathsFor(root);
  return withLock(paths, async () => {
    const runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime);
    for (const [key, value] of Object.entries({ worker, adapter, host })) {
      if (value !== null) {
        if (!HEALTH_VALUES.has(value)) throw new Error("unsupported gateway health value");
        runtime.health[key] = value;
      }
    }
    runtime.health.lastTickAt = timestamp(now); runtime.revision += 1;
    await writeJson(paths.gatewayRuntimePath, runtime);
    return structuredClone(runtime.health);
  });
}

export async function loadGatewayRuntime(root = process.cwd(), catalog = null) {
  const paths = await pathsFor(root, catalog);
  const [policy, runtime] = await Promise.all([
    readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy),
    readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime)
  ]);
  return { policy, runtime, ...paths };
}

export async function inspectGatewayRuntime(root = process.cwd(), catalog = null) {
  const paths = await pathsFor(root, catalog); const errors = [];
  let policy = emptyPolicy(paths.catalog.root); let runtime = emptyRuntime(paths.catalog.root);
  try { policy = await readJson(paths.gatewayPolicyPath, paths.catalog.root, normalizePolicy, emptyPolicy); } catch (error) { errors.push("policy:" + error.message); }
  try { runtime = await readJson(paths.gatewayRuntimePath, paths.catalog.root, normalizeRuntime, emptyRuntime); } catch (error) { errors.push("runtime:" + error.message); }
  return { policy, runtime, errors, ...paths };
}

export function gatewayRuntimeFindings(policy, runtime) {
  const findings = [];
  const active = new Set();
  const goalIds = new Set();
  for (const goal of policy.goals) {
    if (!validGoal(goal)) findings.push("invalid-goal:" + (goal?.goalId || "unknown"));
    else if (!validGoalTransferProofs(goal, policy.goals)) findings.push("invalid-strategy-transfer:" + goal.goalId);
    if (goalIds.has(goal.goalId)) findings.push("duplicate-goal:" + goal.goalId);
    goalIds.add(goal.goalId);
    if (goal.status === "active" && active.has(goal.agentId)) findings.push("multiple-active-goals:" + goal.agentId);
    if (goal.status === "active") active.add(goal.agentId);
  }
  for (const item of policy.history) if (!validPolicyHistory(item)) findings.push("invalid-gateway-policy-history");
  const queueIds = new Set(); const dedupeKeys = new Set();
  for (const item of runtime.queue) {
    if (!validQueue(item)) findings.push("invalid-queue-item:" + (item?.queueId || "unknown"));
    if (queueIds.has(item.queueId)) findings.push("duplicate-queue-item:" + item.queueId);
    if (dedupeKeys.has(item.dedupeKey)) findings.push("duplicate-queue-dedupe:" + item.dedupeKey);
    queueIds.add(item.queueId); dedupeKeys.add(item.dedupeKey);
    if (item.goalStepId) {
      const goal = policy.goals.find((entry) => entry.goalId === item.goalId);
      const step = goal?.plan?.steps.find((entry) => entry.stepId === item.goalStepId);
      if (!step) findings.push("orphan-goal-step:" + item.queueId);
      else if (item.agentId !== planStepAgentId(goal, step)) findings.push("goal-step-agent-mismatch:" + item.queueId);
    }
  }
  const outboxIds = new Set(); const idempotencyKeys = new Set();
  for (const item of runtime.outbox) {
    if (!validOutbox(item)) findings.push("invalid-outbox-item:" + (item?.outboxId || "unknown"));
    if (!queueIds.has(item.queueId)) findings.push("orphan-outbox-item:" + item.outboxId);
    if (outboxIds.has(item.outboxId)) findings.push("duplicate-outbox-item:" + item.outboxId);
    if (idempotencyKeys.has(item.idempotencyKey)) findings.push("duplicate-outbox-idempotency:" + item.idempotencyKey);
    outboxIds.add(item.outboxId); idempotencyKeys.add(item.idempotencyKey);
  }
  for (const item of runtime.receipts) if (!validReceipt(item)
    || (!queueIds.has(item.objectId) && !outboxIds.has(item.objectId))) findings.push("invalid-gateway-receipt:" + (item?.id || "unknown"));
  for (const item of runtime.history) if (!validHistory(item)) findings.push("invalid-gateway-history:" + (item?.objectId || "unknown"));
  const leased = runtime.lanes.filter((item) => item.status === "leased");
  for (const lane of runtime.lanes) {
    if (!validLane(lane)) findings.push("invalid-agent-lane:" + (lane?.queueId || "unknown"));
    const queue = runtime.queue.find((item) => item.queueId === lane.queueId);
    if (!queue || (lane.status === "leased" && (queue.status !== "leased" || queue.lease?.workerId !== lane.workerId))) {
      findings.push("agent-lane-queue-mismatch:" + (lane.queueId || "unknown"));
    }
  }
  if (new Set(leased.map((item) => item.agentId)).size !== leased.length) findings.push("duplicate-agent-lane");
  if (!validHealth(runtime.health)) findings.push("invalid-gateway-health");
  return findings;
}

export function gatewayHealthFindings(policy, runtime, { now = new Date(), staleAfterMs = 180000 } = {}) {
  if (!policy.enabled || policy.killSwitch) return [];
  const findings = [];
  if (runtime.health.gateway !== "running") findings.push("gateway-not-running");
  if (runtime.health.scheduler !== "healthy") findings.push("scheduler-not-healthy");
  if (runtime.health.queue !== "healthy") findings.push("queue-not-healthy");
  if (!new Set(["healthy", "degraded"]).has(runtime.health.worker)) findings.push("worker-not-healthy");
  if (!new Set(["healthy", "degraded"]).has(runtime.health.adapter)) findings.push("adapter-not-healthy");
  const current = now instanceof Date ? now : new Date(now);
  const tick = runtime.health.lastTickAt === null ? null : new Date(runtime.health.lastTickAt);
  const reconciliation = runtime.health.lastReconciledAt === null ? null : new Date(runtime.health.lastReconciledAt);
  if (!tick || current.getTime() - tick.getTime() > staleAfterMs) findings.push("worker-heartbeat-stale");
  if (!reconciliation || current.getTime() - reconciliation.getTime() > staleAfterMs) findings.push("scheduler-heartbeat-stale");
  return findings;
}

export async function gatewayContext({ root = process.cwd(), agentId = null } = {}) {
  const { policy, runtime } = await loadGatewayRuntime(root);
  const findings = gatewayRuntimeFindings(policy, runtime);
  if (findings.length) throw new Error("gateway runtime failed closed: " + findings.join(", "));
  const exactAgentId = agentId === null ? null : exactId(agentId, "agentId");
  const goals = policy.goals.filter((item) => exactAgentId === null || item.agentId === exactAgentId
    || item.plan?.steps.some((step) => planStepAgentId(item, step) === exactAgentId));
  const queue = runtime.queue.filter((item) => exactAgentId === null || item.agentId === exactAgentId);
  const queueIds = new Set(queue.map((item) => item.queueId));
  const leased = runtime.queue.filter((item) => item.status === "leased");
  const resourceWaits = queue.filter((item) => item.status === "pending").map((item) => {
    const blockers = leased.map((entry) => ({ entry, resources: conflictingResources(policy, item, entry) }))
      .filter(({ resources }) => resources.length > 0);
    return blockers.length ? {
      queueId: item.queueId,
      resources: [...new Set(blockers.flatMap(({ resources }) => resources))].sort(),
      blockedByQueueIds: blockers.map(({ entry }) => entry.queueId).sort(),
      authority: "execution-state-only"
    } : null;
  }).filter(Boolean);
  return { schema: "agentspine.gateway-context/v1", enabled: policy.enabled, killSwitch: policy.killSwitch,
    goals: structuredClone(goals), queue: structuredClone(queue),
    outbox: structuredClone(runtime.outbox.filter((item) => queueIds.has(item.queueId))),
    resourceWaits,
    health: structuredClone(runtime.health), healthFindings: gatewayHealthFindings(policy, runtime),
    authority: "execution-state-only" };
}
