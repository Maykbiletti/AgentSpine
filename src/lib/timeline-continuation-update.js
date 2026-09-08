import { createHash } from "node:crypto";
import { recordWorldAssertion, worldContext } from "./world-model.js";
import { TIMELINE_OUTCOME_CONTRACT_SCHEMA } from "./world-knowledge.js";

const CONTINUATION_SCHEMA = "agentspine.task-continuation/v1";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameStep(left, right) {
  return Boolean(left && right && left.id === right.id && left.summary === right.summary);
}

function measuredResult(event, contract) {
  if (event.testLabel !== contract.measurement.testLabel) return null;
  const expectedTotal = contract.measurement.total;
  if ((expectedTotal === null) !== (event.count === null)
    || (event.count && event.count.total !== expectedTotal)) return null;
  const succeeded = event.outcome === "pass"
    && (event.count === null || event.count.value === contract.measurement.successCount);
  const result = succeeded ? "passed"
    : event.outcome === "blocked" || event.outcome === "skipped" ? "blocked" : "failed";
  return { succeeded, result };
}

function response(status, reason = null, assertion = null) {
  return { schema: "agentspine.timeline-continuation-update/v1", status, reason, assertion,
    completionVerified: assertion?.value?.status === "completed", automaticRetry: false,
    authority: "context-only" };
}

export async function updateTimelineContinuationFromObjective({ root, scope, event, now }) {
  try {
    const context = await worldContext({ root, subjectId: scope.currentTaskId,
      projectId: scope.projectId, groupId: null, includePrivate: true, includeKnowledgeHistory: true,
      continuationTaskId: scope.currentTaskId, portalRef: scope.portalRef, threadRef: scope.threadRef,
      maxItems: 100, now });
    const continuations = context.knowledge.current.filter((item) => item.subjectId === scope.currentTaskId
      && item.predicate === "task.continuation" && item.value?.schema === CONTINUATION_SCHEMA);
    const replay = continuations.find((item) => item.status === "confirmed"
      && item.source.id === event.id && item.value.lastVerifiedStep?.evidenceId === event.id);
    if (replay) return response("duplicate", null, replay);
    if (continuations.length !== 1 || continuations[0].status !== "confirmed") {
      return response("unavailable", continuations.length ? "timeline-continuation-conflicted"
        : "timeline-continuation-missing");
    }
    const current = continuations[0];
    const contracts = context.knowledge.current.filter((item) => item.subjectId === scope.currentTaskId
      && item.predicate === "task.timeline-outcome-contract"
      && item.value?.schema === TIMELINE_OUTCOME_CONTRACT_SCHEMA);
    if (contracts.length !== 1 || contracts[0].status !== "confirmed") {
      return response("unavailable", contracts.length ? "timeline-outcome-contract-conflicted"
        : "timeline-outcome-contract-missing");
    }
    const contract = contracts[0];
    if (!sameStep(current.value.nextStep, contract.value.step)) {
      return response("unavailable", "timeline-outcome-contract-superseded");
    }
    const eventTime = new Date(event.at).getTime();
    if (eventTime < new Date(contract.recordedAt).getTime()) {
      return response("unavailable", "timeline-outcome-contract-postdated");
    }
    if (eventTime < new Date(current.observedAt).getTime()
      || eventTime < new Date(contract.observedAt).getTime()) {
      return response("unavailable", "timeline-outcome-event-stale");
    }
    const measured = measuredResult(event, contract.value);
    if (!measured) return response("unavailable", "timeline-outcome-contract-mismatch");
    const value = structuredClone(current.value);
    value.lastVerifiedStep = {
      id: contract.value.step.id, summary: contract.value.step.summary, result: measured.result,
      evidenceId: event.id, evidenceDigest: event.messageDigest,
      observedAt: new Date(event.at).toISOString(), sessionRef: event.sessionRef,
      messageRef: event.messageRef
    };
    if (measured.succeeded) {
      value.status = contract.value.onSuccess.status;
      value.nextStep = structuredClone(contract.value.onSuccess.nextStep);
      if (value.status === "completed" && value.openQuestions.length) {
        return response("unavailable", "timeline-outcome-completion-questions-open");
      }
    }
    const material = [scope.currentTaskId, scope.projectId, scope.portalRef, scope.threadRef,
      contract.id, current.id, event.id, event.messageDigest].join("\0");
    const recorded = await recordWorldAssertion({ root,
      id: `assertion:timeline-continuation-${digest(material).slice(0, 32)}`,
      subjectId: scope.currentTaskId, predicate: "task.continuation", value,
      evidenceKind: "objective-measurement", evidenceId: event.id,
      evidenceDigest: event.messageDigest, observedAt: new Date(event.at).toISOString(),
      projectId: scope.projectId, groupId: null, privacy: "private", knowledgeKind: "task-state",
      sessionRef: event.sessionRef, messageRef: event.messageRef,
      supersedes: [current.id], requireActiveSupersedes: true,
      reason: `The source-verified timeline result matched pre-existing contract ${contract.id}.`,
      portalRef: scope.portalRef, threadRef: scope.threadRef, now });
    return response(recorded.status === "duplicate" ? "duplicate" : "updated", null, recorded.assertion);
  } catch {
    return response("unavailable", "timeline-continuation-update-unavailable");
  }
}
