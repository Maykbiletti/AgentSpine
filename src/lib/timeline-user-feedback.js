import { createHash } from "node:crypto";
import { recordWorldAssertion, worldContext } from "./world-model.js";
import { TIMELINE_CLARIFICATION_SCHEMA, TIMELINE_INTERPRETATION_SCHEMA } from "./mcp-timeline-tools.js";

export const USER_FEEDBACK_SCHEMA = "agentspine.timeline-user-feedback/v1";
export const USER_FEEDBACK_INTERPRETATION_SCHEMA = "agentspine.timeline-user-feedback-interpretation/v1";
export const USER_FEEDBACK_CLARIFICATION_SCHEMA = "agentspine.timeline-user-feedback-clarification/v1";
const KIND = "uninterpreted-user-message";
const KEYS = ["schema", "sourceText", "speakerRole", "sourceProvider", "sourceDigest",
  "targetAssertionId", "interpretationStatus", "completionVerified"];
const INTERPRETATION_KEYS = ["schema", "sourceFeedbackAssertionId", "targetAssertionId",
  "sourceProvider", "sourceDigest", "modelProvider", "interpretationStatus", "interpretationKind",
  "proposedNextStepSummary", "clarificationQuestion", "replacedNextStepId", "completionVerified"];
const CLARIFICATION_KEYS = ["schema", "sourceFeedbackAssertionIds", "targetAssertionId",
  "sourceProvider", "sourceDigest", "modelProvider", "interpretationStatus", "clarificationQuestion",
  "replacedNextStepId", "completionVerified"];
const ASSERTION_ID = /^assertion:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const STABLE_ID = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;

function exactKeys(value, keys) {
  return value && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateInterpretation(input, value) {
  const clarification = value?.schema === USER_FEEDBACK_CLARIFICATION_SCHEMA;
  if (input.predicate !== "task.user-feedback-interpretation"
    || (!clarification && value?.schema !== USER_FEEDBACK_INTERPRETATION_SCHEMA)) return false;
  const next = value?.proposedNextStepSummary;
  const question = value?.clarificationQuestion;
  const kind = value?.interpretationKind;
  if (input.evidenceKind !== "model-suggestion" || input.knowledgeKind !== "task-state"
    || input.predicate !== "task.user-feedback-interpretation" || input.privacy !== "private" || input.groupId
    || !input.portalRef || !input.threadRef || !input.sessionRef || !input.messageRef
    || input.supersedes?.length || input.requireActiveSupersedes
    || !exactKeys(value, clarification ? CLARIFICATION_KEYS : INTERPRETATION_KEYS)
    || value.interpretationStatus !== "model-proposed"
    || value.completionVerified !== false
    || (clarification ? !Array.isArray(value.sourceFeedbackAssertionIds)
      || value.sourceFeedbackAssertionIds.length < 2 || value.sourceFeedbackAssertionIds.length > 3
      || value.sourceFeedbackAssertionIds.some((id) => !ASSERTION_ID.test(id))
      || new Set(value.sourceFeedbackAssertionIds).size !== value.sourceFeedbackAssertionIds.length
      || ![...value.sourceFeedbackAssertionIds].sort().every((id, index) => id === value.sourceFeedbackAssertionIds[index])
      : !ASSERTION_ID.test(value.sourceFeedbackAssertionId || ""))
    || !ASSERTION_ID.test(value.targetAssertionId || "") || !STABLE_ID.test(value.replacedNextStepId || "")
    || !["claude", "codex", "king"].includes(value.sourceProvider)
    || !["claude", "codex", "king"].includes(value.modelProvider)
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest || "")
    || (!clarification && !["next-step-correction", "completion-claim", "not-current-instruction", "ambiguous"].includes(kind))
    || (!clarification && (kind === "next-step-correction"
      ? typeof next !== "string" || !next.trim() || next.length > 500 || /[\r\n]/u.test(next) || question !== null
      : next !== null || (kind === "ambiguous"
        ? typeof question !== "string" || !question.trim() || question.length > 300 || /[\r\n]/u.test(question)
        : question !== null)))
    || (clarification && (typeof question !== "string" || !question.trim()
      || question.length > 300 || /[\r\n]/u.test(question)))) {
    throw new Error("user feedback interpretation must remain a source-bound model proposal");
  }
  return true;
}

// Provenance only.
export function validateUserFeedback(input, value) {
  if (validateInterpretation(input, value)) return;
  if (input.evidenceKind !== KIND && value?.schema !== USER_FEEDBACK_SCHEMA) return;
  if (input.evidenceKind !== KIND || input.knowledgeKind !== "task-state"
    || input.predicate !== "task.user-feedback" || input.privacy !== "private" || input.groupId
    || !input.portalRef || !input.threadRef || !input.sessionRef || !input.messageRef
    || input.supersedes?.length || input.requireActiveSupersedes
    || !value || Object.keys(value).sort().join("\0") !== [...KEYS].sort().join("\0")
    || value.schema !== USER_FEEDBACK_SCHEMA || value.speakerRole !== "user"
    || value.interpretationStatus !== "unresolved" || value.completionVerified !== false
    || !["claude", "codex", "king"].includes(value.sourceProvider)
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest || "")
    || !ASSERTION_ID.test(value.targetAssertionId || "")
    || typeof value.sourceText !== "string" || !value.sourceText.trim()
    || /[\r\n]/u.test(value.sourceText) || Buffer.byteLength(value.sourceText) > 2048) {
    throw new Error("user feedback must remain a private, source-bound, uninterpreted candidate");
  }
}

export async function captureTimelineUserFeedback({ root, scope, event, now }) {
  if (!scope.portalRef || !scope.threadRef) return { reason: "timeline-feedback-route-required" };
  const context = await worldContext({ root, subjectId: scope.currentTaskId, projectId: scope.projectId,
    groupId: null, includePrivate: true, includeKnowledgeHistory: true,
    continuationTaskId: scope.currentTaskId, portalRef: scope.portalRef, threadRef: scope.threadRef,
    maxItems: 100, now });
  const replay = context.knowledge.current.find((item) => item.source.kind === KIND
    && item.source.id === event.id && item.source.digest === event.messageDigest
    && item.value.sourceDigest === event.sourceDigest);
  if (replay) return { status: "duplicate", assertion: replay };
  const tasks = [...context.knowledge.continuation.tasks, ...context.knowledge.continuation.terminal];
  const target = tasks.find((item) => item.taskId === scope.currentTaskId);
  if (!target) return { reason: "timeline-feedback-target-unresolved" };
  if (new Date(event.at).getTime() < new Date(target.observedAt).getTime()) {
    return { reason: "timeline-feedback-stale" };
  }
  const material = [scope.currentTaskId, scope.projectId, scope.portalRef, scope.threadRef,
    event.id, event.sourceDigest, event.messageDigest].join("\0");
  const id = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return recordWorldAssertion({ root, id: `assertion:user-feedback-${id}`,
    subjectId: scope.currentTaskId, predicate: "task.user-feedback",
    value: { schema: USER_FEEDBACK_SCHEMA, sourceText: event.sourceText, speakerRole: "user",
      sourceProvider: event.sourceProvider, sourceDigest: event.sourceDigest,
      targetAssertionId: target.assertionId, interpretationStatus: "unresolved", completionVerified: false },
    evidenceKind: KIND, evidenceId: event.id, evidenceDigest: event.messageDigest,
    observedAt: new Date(event.at).toISOString(), projectId: scope.projectId, groupId: null,
    privacy: "private", knowledgeKind: "task-state", sessionRef: event.sessionRef, messageRef: event.messageRef,
    portalRef: scope.portalRef, threadRef: scope.threadRef, now,
    reason: "Source and speaker are verified, not meaning. The target is the contemporaneous scoped task, not a resolved semantic referent. Quotations, hypotheses, negation and completion claims are not confirmed instructions or outcomes." });
}

export function relevantUserFeedback(entry, task) {
  return entry.kind === "task-state" && entry.status === "assumption"
    && entry.source.kind === KIND && entry.subjectId === task.taskId
    && entry.value?.schema === USER_FEEDBACK_SCHEMA
    && entry.value.targetAssertionId === task.assertionId
    && entry.observedAt >= task.observedAt;
}

export function relevantUserFeedbackInterpretation(entry, task) {
  return entry.kind === "task-state" && entry.status === "assumption"
    && entry.source.kind === "model-suggestion" && entry.subjectId === task.taskId
    && entry.predicate === "task.user-feedback-interpretation"
    && [USER_FEEDBACK_INTERPRETATION_SCHEMA, USER_FEEDBACK_CLARIFICATION_SCHEMA].includes(entry.value?.schema)
    && entry.value.targetAssertionId === task.assertionId
    && entry.observedAt >= task.observedAt;
}

export async function captureTimelineUserInterpretation({
  root, scope, events, event, feedback, request, modelProvider, sessionRef, now
}) {
  if (!request || ![TIMELINE_INTERPRETATION_SCHEMA, TIMELINE_CLARIFICATION_SCHEMA].includes(request.schema)
    || !["claude", "codex", "king"].includes(modelProvider) || !sessionRef) {
    return { reason: "timeline-feedback-interpretation-invalid" };
  }
  const context = await worldContext({ root, subjectId: scope.currentTaskId, projectId: scope.projectId,
    groupId: null, includePrivate: true, includeKnowledgeHistory: true,
    continuationTaskId: scope.currentTaskId, portalRef: scope.portalRef, threadRef: scope.threadRef,
    maxItems: 100, now });
  const task = [...context.knowledge.continuation.tasks, ...context.knowledge.continuation.terminal]
    .find((item) => item.taskId === scope.currentTaskId);
  const candidates = context.knowledge.current.filter((item) => relevantUserFeedback(item, task || {}));
  const clarification = request.schema === TIMELINE_CLARIFICATION_SCHEMA;
  const source = candidates.find((item) => item.id === feedback.id && item.source.id === event.id);
  const ids = candidates.map((item) => item.id).sort();
  const requestedIds = clarification ? request.feedbackAssertionIds : [request.feedbackAssertionId];
  const sourcesVerified = candidates.every((item) =>
    item.value.sourceDigest === source?.value.sourceDigest
    && item.value.sourceProvider === source?.value.sourceProvider
    && events.some((candidate) => candidate.id === item.source.id
      && candidate.messageDigest === item.source.digest
      && candidate.sourceDigest === item.value.sourceDigest
      && candidate.sourceProvider === item.value.sourceProvider));
  if (!task || !source || request.targetAssertionId !== task.assertionId
    || source.value.targetAssertionId !== task.assertionId || !sourcesVerified
    || requestedIds.length !== ids.length || !requestedIds.every((id, index) => id === ids[index])) {
    return { reason: "timeline-feedback-interpretation-source-mismatch" };
  }
  if (task.status === "completed") return { reason: "timeline-feedback-interpretation-task-completed" };
  if (clarification !== (candidates.length > 1) || candidates.length > 3) {
    return { reason: "timeline-feedback-interpretation-ambiguous-set" };
  }
  const value = clarification ? {
    schema: USER_FEEDBACK_CLARIFICATION_SCHEMA, sourceFeedbackAssertionIds: ids,
    targetAssertionId: task.assertionId, sourceProvider: source.value.sourceProvider,
    sourceDigest: source.value.sourceDigest, modelProvider, interpretationStatus: "model-proposed",
    clarificationQuestion: request.clarificationQuestion, replacedNextStepId: task.nextStep.id,
    completionVerified: false
  } : {
    schema: USER_FEEDBACK_INTERPRETATION_SCHEMA, sourceFeedbackAssertionId: source.id,
    targetAssertionId: task.assertionId, sourceProvider: source.value.sourceProvider,
    sourceDigest: source.value.sourceDigest, modelProvider, interpretationStatus: "model-proposed",
    interpretationKind: request.kind, proposedNextStepSummary: request.proposedNextStepSummary,
    clarificationQuestion: request.clarificationQuestion, replacedNextStepId: task.nextStep.id,
    completionVerified: false
  };
  const id = `assertion:user-feedback-interpretation-${createHash("sha256")
    .update(`${requestedIds.join("\0")}\0${task.assertionId}`).digest("hex").slice(0, 24)}`;
  const existing = context.knowledge.current.find((item) => item.id === id);
  if (existing) {
    return Object.keys(value).every((key) => JSON.stringify(existing.value[key]) === JSON.stringify(value[key]))
      ? { status: "duplicate", assertion: existing }
      : { reason: "timeline-feedback-interpretation-conflicted" };
  }
  const material = JSON.stringify({ request, sourceIds: requestedIds, targetId: task.assertionId,
    sourceDigest: source.value.sourceDigest, modelProvider, sessionRef });
  const evidenceDigest = createHash("sha256").update(material).digest("hex");
  return recordWorldAssertion({ root, id, subjectId: scope.currentTaskId,
    predicate: "task.user-feedback-interpretation", value, evidenceKind: "model-suggestion",
    evidenceId: `evidence:model-interpretation-${evidenceDigest.slice(0, 24)}`, evidenceDigest,
    observedAt: new Date(now).toISOString(), projectId: scope.projectId, groupId: null,
    privacy: "private", knowledgeKind: "task-state", sessionRef,
    messageRef: `message:model-interpretation-${evidenceDigest.slice(0, 24)}`,
    portalRef: scope.portalRef, threadRef: scope.threadRef, now,
    reason: clarification
      ? "The model proposed one question for an exact source-verified ambiguity set, not user meaning, completion, or authority."
      : "The model proposed a meaning for one source-verified user message. This records interpretation, not user authority, correctness, completion, or objective evidence." });
}
