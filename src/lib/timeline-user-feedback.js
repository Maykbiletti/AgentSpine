import { createHash } from "node:crypto";
import { recordWorldAssertion, worldContext } from "./world-model.js";

export const USER_FEEDBACK_SCHEMA = "agentspine.timeline-user-feedback/v1";
const KIND = "uninterpreted-user-message";
const KEYS = ["schema", "sourceText", "speakerRole", "sourceProvider", "sourceDigest",
  "targetAssertionId", "interpretationStatus", "completionVerified"];

// Provenance is checked by timeline capture. This contract never interprets the quoted language.
export function validateUserFeedback(input, value) {
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
    || !/^assertion:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(value.targetAssertionId || "")
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
