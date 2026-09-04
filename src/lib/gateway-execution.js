import {
  EXECUTION_ATTEMPT_SCHEMA, EXECUTION_OUTCOME_SCHEMA, ID_RE, METRIC_OPERATORS,
  STRATEGY_TRANSFER_PROOF_SCHEMA, exactId, sha256, timestamp
} from "./gateway-common.js";

function executionDecisionMaterial(execution) {
  return {
    requiredCapabilities: execution.requiredCapabilities, strategies: execution.strategies,
    verification: execution.verification, selectedStrategyId: execution.selectedStrategyId,
    ...(execution.explorationMaxAttempts === undefined ? {} : {
      explorationMaxAttempts: execution.explorationMaxAttempts,
      explorationOrder: execution.explorationOrder
    }),
    ...(execution.transferKey === undefined ? {} : {
      transferKey: execution.transferKey, transferMaxAgeDays: execution.transferMaxAgeDays,
      transferProof: execution.transferProof
    }),
    authority: "context-only-decision"
  };
}

function sufficientExecutionStrategies(execution) {
  const required = new Set(execution.requiredCapabilities);
  return execution.strategies.filter((strategy) => strategy.capabilities.every((capability) => ID_RE.test(capability))
    && [...required].every((capability) => strategy.capabilities.includes(capability)))
    .sort((left, right) => left.risk - right.risk || left.cost - right.cost
      || left.strategyId.localeCompare(right.strategyId));
}

function selectedExecutionStrategy(execution) {
  const sufficient = sufficientExecutionStrategies(execution);
  const minimumRisk = sufficient[0]?.risk;
  const transferred = execution.transferProof && sufficient.find((strategy) =>
    strategy.strategyId === execution.transferProof.strategyId && strategy.risk === minimumRisk);
  return transferred || sufficient[0] || null;
}

function expectedExplorationOrder(execution) {
  const sufficient = sufficientExecutionStrategies(execution);
  const selected = selectedExecutionStrategy(execution);
  if (!selected) return [];
  return [selected, ...sufficient.filter((strategy) => strategy.risk === selected.risk
    && strategy.strategyId !== selected.strategyId)].map((strategy) => strategy.strategyId);
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
      if (!prior || prior.transferKey !== execution.transferKey
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

export function validGoalTransferProofs(goal, goals) {
  if (!goal.plan) return true;
  return goal.plan.steps.every((step) => {
    if (!step.execution?.transferProof) return true;
    const expected = createStrategyTransferProof(goals, step.execution, {
      goalId: goal.goalId, projectId: goal.projectId, groupId: goal.groupId, before: goal.createdAt
    });
    return JSON.stringify(expected) === JSON.stringify(step.execution.transferProof);
  });
}

export function validExecutionDecision(execution) {
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
    && (execution.explorationMaxAttempts === undefined || (Number.isInteger(execution.explorationMaxAttempts)
      && execution.explorationMaxAttempts >= 2 && execution.explorationMaxAttempts <= 4
      && Array.isArray(execution.explorationOrder)
      && execution.explorationOrder.length === execution.explorationMaxAttempts
      && new Set(execution.explorationOrder).size === execution.explorationOrder.length
      && execution.explorationOrder.every((strategyId) => ID_RE.test(strategyId || ""))))
    && (execution.transferKey === undefined || (ID_RE.test(execution.transferKey || "")
      && Number.isInteger(execution.transferMaxAgeDays) && execution.transferMaxAgeDays >= 1
      && execution.transferMaxAgeDays <= 90
      && (execution.transferProof === null || (validStrategyTransferProof(execution.transferProof)
        && execution.transferProof.transferKey === execution.transferKey
        && execution.transferProof.maxAgeDays === execution.transferMaxAgeDays))))
    && /^[a-f0-9]{64}$/.test(execution.decisionDigest || ""))) return false;
  const selected = selectedExecutionStrategy(execution);
  return selected?.strategyId === execution.selectedStrategyId
    && (execution.explorationMaxAttempts === undefined
      || JSON.stringify(execution.explorationOrder)
        === JSON.stringify(expectedExplorationOrder(execution).slice(0, execution.explorationMaxAttempts)))
    && execution.decisionDigest === sha256(JSON.stringify(executionDecisionMaterial(execution)));
}

export function createExecutionDecision(value, field, transferContext) {
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
  if (value.exploration !== undefined && value.exploration !== null) {
    execution.explorationMaxAttempts = Number(value.exploration?.maxAttempts);
    execution.explorationOrder = expectedExplorationOrder(execution).slice(0, execution.explorationMaxAttempts);
  }
  execution.decisionDigest = sha256(JSON.stringify(executionDecisionMaterial(execution)));
  if (!validExecutionDecision(execution)) {
    throw new Error(`${field} requires 2-8 bounded strategies and one objective verification gate`);
  }
  return execution;
}

function executionOutcomeMaterial(outcome) {
  return {
    queueId: outcome.queueId, decisionDigest: outcome.decisionDigest, strategyId: outcome.strategyId,
    ...(outcome.attempt === undefined ? {} : {
      attempt: outcome.attempt, previousOutcomeDigest: outcome.previousOutcomeDigest
    }),
    capabilitiesUsed: outcome.capabilitiesUsed, evaluatorId: outcome.evaluatorId, metric: outcome.metric,
    value: outcome.value, cases: outcome.cases, blockingDefect: outcome.blockingDefect,
    sourceDigest: outcome.sourceDigest, observedAt: outcome.observedAt, passed: outcome.passed,
    authority: "objective-evidence-only"
  };
}

export function currentExecutionAttempt(execution, outcomes = []) {
  if (execution.explorationMaxAttempts === undefined) return null;
  if (outcomes.length >= execution.explorationMaxAttempts || outcomes.some((outcome) => outcome.passed || outcome.blockingDefect)) {
    return null;
  }
  return {
    schema: EXECUTION_ATTEMPT_SCHEMA,
    attempt: outcomes.length + 1, maxAttempts: execution.explorationMaxAttempts,
    strategyId: execution.explorationOrder[outcomes.length],
    previousOutcomeDigest: outcomes.at(-1)?.digest || null,
    decisionDigest: execution.decisionDigest, authority: "context-only-attempt"
  };
}

export function executionAttemptForStep(step) {
  if (!step?.execution || !Array.isArray(step.executionOutcomes)) return null;
  return currentExecutionAttempt(step.execution, step.executionOutcomes);
}

function metricPassed(operator, value, threshold) {
  if (operator === "gte") return value >= threshold;
  if (operator === "lte") return value <= threshold;
  return value === threshold;
}

function validExecutionOutcome(outcome, execution, expectedStrategyId = execution.selectedStrategyId,
  expectedAttempt = null, previousOutcomeDigest = null) {
  if (!(outcome && outcome.schema === EXECUTION_OUTCOME_SCHEMA && ID_RE.test(outcome.outcomeId || "")
    && ID_RE.test(outcome.queueId || "") && outcome.decisionDigest === execution.decisionDigest
    && outcome.strategyId === expectedStrategyId
    && (execution.explorationMaxAttempts === undefined
      ? outcome.attempt === undefined && outcome.previousOutcomeDigest === undefined
      : outcome.attempt === expectedAttempt && outcome.previousOutcomeDigest === previousOutcomeDigest)
    && Array.isArray(outcome.capabilitiesUsed)
    && outcome.capabilitiesUsed.length <= 16 && new Set(outcome.capabilitiesUsed).size === outcome.capabilitiesUsed.length
    && outcome.capabilitiesUsed.every((capability) => ID_RE.test(capability || ""))
    && outcome.evaluatorId === execution.verification.evaluatorId && outcome.metric === execution.verification.metric
    && Number.isFinite(outcome.value) && Number.isInteger(outcome.cases) && outcome.cases >= 0
    && typeof outcome.blockingDefect === "boolean" && /^[a-f0-9]{64}$/.test(outcome.sourceDigest || "")
    && Number.isFinite(new Date(outcome.observedAt).getTime()) && typeof outcome.passed === "boolean"
    && /^[a-f0-9]{64}$/.test(outcome.digest || "") && outcome.authority === "objective-evidence-only")) return false;
  const strategy = execution.strategies.find((item) => item.strategyId === expectedStrategyId);
  const used = new Set(outcome.capabilitiesUsed);
  const expectedPass = execution.requiredCapabilities.every((capability) => used.has(capability))
    && outcome.capabilitiesUsed.every((capability) => strategy.capabilities.includes(capability))
    && outcome.cases >= execution.verification.minCases && !outcome.blockingDefect
    && metricPassed(execution.verification.operator, outcome.value, execution.verification.threshold);
  const digest = sha256(JSON.stringify(executionOutcomeMaterial(outcome)));
  return outcome.passed === expectedPass && outcome.digest === digest
    && outcome.outcomeId === "execution-outcome:" + digest.slice(0, 32);
}

export function validExecutionOutcomeSequence(execution, outcomes) {
  if (execution.explorationMaxAttempts === undefined) {
    return outcomes.every((outcome) => validExecutionOutcome(outcome, execution));
  }
  if (outcomes.length > execution.explorationMaxAttempts
    || new Set(outcomes.map((outcome) => outcome.sourceDigest)).size !== outcomes.length) return false;
  let previous = null;
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (!validExecutionOutcome(outcome, execution, execution.explorationOrder[index], index + 1, previous)) return false;
    if (index < outcomes.length - 1 && (outcome.passed || outcome.blockingDefect)) return false;
    previous = outcome.digest;
  }
  return true;
}

export function reviewExecutionResult(execution, priorOutcomes, queueId, report, now) {
  const attempt = currentExecutionAttempt(execution, priorOutcomes);
  const expectedStrategyId = attempt?.strategyId || execution.selectedStrategyId;
  if (!report || report.strategyId !== expectedStrategyId || !Array.isArray(report.capabilitiesUsed)
    || !report.outcome || report.outcome.evaluatorId !== execution.verification.evaluatorId
    || report.outcome.metric !== execution.verification.metric) {
    return { passed: false, outcome: null, reason: "Objective execution evidence is missing or invalid." };
  }
  let outcome;
  try {
    outcome = {
      schema: EXECUTION_OUTCOME_SCHEMA, outcomeId: null, queueId,
      decisionDigest: execution.decisionDigest, strategyId: report.strategyId,
      ...(attempt === null ? {} : { attempt: attempt.attempt, previousOutcomeDigest: attempt.previousOutcomeDigest }),
      capabilitiesUsed: report.capabilitiesUsed.map((capability) => exactId(capability, "execution.capabilitiesUsed")),
      evaluatorId: report.outcome.evaluatorId, metric: report.outcome.metric,
      value: Number(report.outcome.value), cases: Number(report.outcome.cases),
      blockingDefect: report.outcome.blockingDefect === true, sourceDigest: String(report.outcome.sourceDigest || ""),
      observedAt: timestamp(report.outcome.observedAt || now), passed: false, digest: null,
      authority: "objective-evidence-only"
    };
    if (new Date(outcome.observedAt) > new Date(now)
      || (attempt && priorOutcomes.some((prior) => prior.sourceDigest === outcome.sourceDigest))) {
      return { passed: false, outcome: null, reason: "Objective execution evidence is missing or invalid." };
    }
    const strategy = execution.strategies.find((item) => item.strategyId === expectedStrategyId);
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
  if (!validExecutionOutcome(outcome, execution, expectedStrategyId, attempt?.attempt ?? null,
    attempt?.previousOutcomeDigest ?? null)
    || !validExecutionOutcomeSequence(execution, [...priorOutcomes, outcome])) {
    return { passed: false, outcome: null, reason: "Objective execution evidence is missing or invalid." };
  }
  const nextAttempt = !outcome.passed && !outcome.blockingDefect
    ? currentExecutionAttempt(execution, [...priorOutcomes, outcome]) : null;
  return { passed: outcome.passed, outcome, nextAttempt,
    reason: outcome.passed ? null : "The objective execution gate did not pass." };
}
