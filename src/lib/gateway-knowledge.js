import {
  createKnowledgeGap, createSelfHelpRequirement, createSelfHelpResolution,
  pendingSelfHelpRequirement
} from "./knowledge-evidence.js";

function blockKnowledgeLimit({ goal, step, item, runtime, current, appendReceipt }, kind) {
  const reason = `Goal step reached the bounded limit of 16 ${kind}; local review is required.`;
  item.status = "blocked"; item.lastError = reason; item.completedAt = current;
  step.status = "blocked"; step.blocker = reason; step.updatedAt = current;
  goal.status = "blocked"; goal.blocker = reason; goal.updatedAt = current;
  appendReceipt(runtime, "self-help-limit-exhausted", item.queueId, current,
    { goalStepId: step.stepId, limit: 16, category: kind });
  return null;
}

function resolvedSelfHelp({ goal, step, item, runtime, current, request,
  appendReceipt, newGoalQueue, planQueueKey }) {
  if (!Array.isArray(step.knowledgeGaps)) step.knowledgeGaps = [];
  if (!Array.isArray(step.selfHelpReports)) step.selfHelpReports = [];
  const resolved = createSelfHelpResolution({ goal, step, queueId: item.queueId,
    report: request, agentId: item.agentId, now: current });
  const existingGap = step.knowledgeGaps.find((gap) => gap.gapId === resolved.gap.gapId);
  if (existingGap) {
    goal.blocker = "The host repeated an already resolved self-help question.";
    step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
    appendReceipt(runtime, "self-help-research-regression", item.queueId, current,
      { goalStepId: step.stepId, reportId: resolved.report.reportId, gapId: existingGap.gapId });
    return null;
  }
  if (step.knowledgeGaps.length >= 16 || step.selfHelpReports.length >= 16) {
    return blockKnowledgeLimit({ goal, step, item, runtime, current, appendReceipt },
      "self-help research resolutions");
  }
  step.knowledgeGaps.push(resolved.gap); step.selfHelpReports.push(resolved.report);
  if (resolved.status === "needs-owner-input") {
    item.status = "blocked"; step.status = "blocked"; step.blocker = resolved.gap.question;
    goal.status = "blocked"; goal.blocker = resolved.gap.question;
    appendReceipt(runtime, "self-help-research-exhausted", item.queueId, current,
      { goalStepId: step.stepId, reportId: resolved.report.reportId, gapId: resolved.gap.gapId });
    appendReceipt(runtime, "knowledge-gap-opened", item.queueId, current,
      { goalStepId: step.stepId, gapId: resolved.gap.gapId, requiredEvidence: "owner-input" });
    return { clarification: structuredClone(resolved.gap), report: structuredClone(resolved.report) };
  }
  step.status = "active"; step.blocker = null; goal.status = "active"; goal.blocker = null;
  goal.nextSafeStep = step.title;
  const key = planQueueKey(goal.goalId, step.stepId, "self-help", resolved.report.reportDigest.slice(0, 20));
  let queued = runtime.queue.find((entry) => entry.dedupeKey === key);
  if (!queued) { queued = newGoalQueue(goal, step, "follow-up", key, current); runtime.queue.push(queued); }
  appendReceipt(runtime, "self-help-research-resolved", queued.queueId, current,
    { goalStepId: step.stepId, reportId: resolved.report.reportId, gapId: resolved.gap.gapId });
  return { report: structuredClone(resolved.report), queueId: queued.queueId };
}

function requireSelfHelp({ goal, step, item, runtime, current, request,
  appendReceipt, newGoalQueue, planQueueKey }) {
  if (!Array.isArray(step.selfHelpRequirements)) step.selfHelpRequirements = [];
  const pending = pendingSelfHelpRequirement(step);
  if (pending) {
    const same = pending.question === request.question?.trim().replace(/\s+/g, " ")
      && pending.reason === request.reason?.trim().replace(/\s+/g, " ");
    goal.blocker = same
      ? "The host repeated a question before completing required repository-first self-help."
      : "The host changed an objective question before completing required repository-first self-help.";
    item.status = "blocked"; step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
    appendReceipt(runtime, "self-help-requirement-regression", item.queueId, current,
      { goalStepId: step.stepId, requirementId: pending.requirementId, repeated: same });
    return null;
  }
  if (step.selfHelpRequirements.length >= 16) {
    return blockKnowledgeLimit({ goal, step, item, runtime, current, appendReceipt },
      "self-help requirements");
  }
  const requirement = createSelfHelpRequirement(goal, step, item.queueId, request, current);
  step.selfHelpRequirements.push(requirement); item.status = "completed";
  step.status = "active"; step.blocker = null; goal.status = "active"; goal.blocker = null;
  goal.nextSafeStep = step.title;
  const key = planQueueKey(goal.goalId, step.stepId, "self-help-required",
    requirement.requirementDigest.slice(0, 20));
  let queued = runtime.queue.find((entry) => entry.dedupeKey === key);
  if (!queued) { queued = newGoalQueue(goal, step, "follow-up", key, current); runtime.queue.push(queued); }
  appendReceipt(runtime, "self-help-required", queued.queueId, current,
    { goalStepId: step.stepId, requirementId: requirement.requirementId });
  return { requirement: structuredClone(requirement), queueId: queued.queueId };
}

function openOwnerGap({ goal, step, item, runtime, current, request, appendReceipt }) {
  const pending = pendingSelfHelpRequirement(step);
  if (pending) {
    goal.blocker = "The host asked the owner before completing required repository-first self-help.";
    item.status = "blocked"; step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
    appendReceipt(runtime, "self-help-requirement-regression", item.queueId, current,
      { goalStepId: step.stepId, requirementId: pending.requirementId, prematureOwnerQuestion: true });
    return null;
  }
  if (!Array.isArray(step.knowledgeGaps)) step.knowledgeGaps = [];
  const proposed = createKnowledgeGap(goal, step, item.queueId, request, current);
  const existing = step.knowledgeGaps.find((gap) => gap.gapId === proposed.gapId);
  if (!existing && step.knowledgeGaps.length >= 16) {
    return blockKnowledgeLimit({ goal, step, item, runtime, current, appendReceipt }, "knowledge gaps");
  }
  if (existing?.status === "resolved") {
    goal.blocker = "The host repeated an already resolved knowledge gap.";
    step.status = "blocked"; step.blocker = goal.blocker; goal.status = "blocked";
    appendReceipt(runtime, "knowledge-gap-regression", item.queueId, current,
      { goalStepId: step.stepId, gapId: existing.gapId });
    return null;
  }
  const gap = existing || proposed;
  if (!existing) step.knowledgeGaps.push(gap);
  goal.blocker = gap.question; step.status = "blocked"; step.blocker = gap.question; goal.status = "blocked";
  appendReceipt(runtime, "knowledge-gap-opened", item.queueId, current,
    { goalStepId: step.stepId, gapId: gap.gapId, requiredEvidence: gap.requiredEvidence });
  return structuredClone(gap);
}

export function handlePlanKnowledge(options) {
  const { goal, step, item, runtime, current, selfHelpRequest, knowledgeGapRequest } = options;
  if (!selfHelpRequest && !knowledgeGapRequest) return null;
  let result;
  if (selfHelpRequest) {
    const handled = resolvedSelfHelp({ ...options, request: selfHelpRequest });
    result = handled?.clarification ? handled : { selfHelp: handled };
  }
  else if (knowledgeGapRequest.requiredEvidence === "objective-observation") {
    result = { selfHelpRequired: requireSelfHelp({ ...options, request: knowledgeGapRequest }) };
  } else result = { clarification: openOwnerGap({ ...options, request: knowledgeGapRequest }) };
  goal.plan.revision += 1;
  return result;
}
