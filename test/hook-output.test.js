import test from "node:test";
import assert from "node:assert/strict";
import { PREMORTEM_REQUIREMENT_TEXT, premortemRequirementText } from "../src/lib/delivery-premortem.js";
import {
  blockedHookOutput, blunRuntimeMessage, hookOutput, lifecycleOutput, preAnswerRecallCapsule
} from "../src/lib/hook-output.js";

function recallContext(groupId = null) {
  return {
    event: "UserPromptSubmit", loaded: true, indexedSources: 7,
    sourceResolution: { status: "loaded" },
    briefing: {
      focus: { currentTaskId: "task:synthetic" }, scope: { groupId },
      preAnswerRecall: {
        schema: "agentspine.pre-answer-recall/v1", order: "review-before-claims-and-actions",
        authority: "context-only",
        task: {
          taskId: "task:synthetic", status: "active", objective: "Prepare result.txt",
          lastVerifiedStep: { summary: "Created result.txt", result: "passed" },
          nextStep: { summary: "Migrate result.txt" }
        },
        feedback: { text: "Nein, erst die Prüfsumme prüfen", status: "unresolved",
          completionVerified: false,
          provider: "claude", digest: "b".repeat(64), session: "session-ref:old",
          message: "message:correction", at: "2026-09-07T02:00:00.000Z" },
        interpretationInput: {
          feedbackAssertionId: "assertion:user-feedback", targetAssertionId: "assertion:task"
        }
      },
      world: { knowledge: {
        continuation: { tasks: [{
          assertionId: "assertion:task", taskId: "task:synthetic", status: "active",
          objective: "Prepare result.txt",
          lastVerifiedStep: { summary: "Created result.txt", result: "passed",
            evidenceDigest: "a".repeat(64), observedAt: "2026-09-07T01:00:00.000Z" },
          nextStep: { summary: "Migrate result.txt" }, observedAt: "2026-09-07T01:00:00.000Z"
        }], terminal: [] },
        taskContext: { items: [{
          id: "assertion:user-feedback",
          value: { targetAssertionId: "assertion:task", sourceText: "Nein, erst die Prüfsumme prüfen",
            interpretationStatus: "unresolved", completionVerified: false,
            sourceProvider: "claude", sourceDigest: "b".repeat(64) },
          source: { kind: "uninterpreted-user-message", sessionRef: "session-ref:old",
            messageRef: "message:correction" }, observedAt: "2026-09-07T02:00:00.000Z"
        }] }
      } }
    },
    preflight: { briefing: {
      mustRemember: [{ id: "remember:access-check", claim: "Check configured access before claiming it is unavailable.",
        checksum: "c".repeat(64) }], retrieval: []
    } }
  };
}

function multipleFeedbackContext() {
  const context = recallContext();
  const first = context.briefing.preAnswerRecall.feedback;
  delete context.briefing.preAnswerRecall.feedback;
  delete context.briefing.preAnswerRecall.interpretationInput;
  context.briefing.preAnswerRecall.feedbackCandidates = [first, { ...first,
    text: "Nimm dafür die andere Datei", digest: "d".repeat(64),
    message: "message:ambiguous", at: "2026-09-07T02:01:00.000Z" }]
    .map(({ text, provider, digest, session, message, at }, index) =>
      ({ id: `assertion:feedback-${index + 1}`, text, provider, digest, session, message, at }));
  delete context.briefing.preAnswerRecall.task.assertionId;
  delete context.briefing.preAnswerRecall.task.lastVerifiedStep.evidenceDigest;
  delete context.briefing.preAnswerRecall.task.lastVerifiedStep.observedAt;
  context.briefing.preAnswerRecall.feedbackReview = {
    status: "multiple-unresolved", completionVerified: false
  };
  return context;
}

test("pre-answer recall carries actionable source bindings in every host output", () => {
  const context = JSON.stringify(recallContext());
  for (const env of [{ CLAUDE_PLUGIN_ROOT: "/synthetic/claude" },
    { PLUGIN_ROOT: "/synthetic/codex" }]) {
    const output = hookOutput("UserPromptSubmit", context, env);
    assert.match(output.hookSpecificOutput.additionalContext, /result\.txt/);
    assert.match(output.hookSpecificOutput.additionalContext, /Nein, erst die Prüfsumme prüfen/);
    assert.match(output.hookSpecificOutput.additionalContext, /Check configured access/);
    for (const id of ["assertion:user-feedback", "assertion:task"]) {
      assert.match(output.hookSpecificOutput.additionalContext, new RegExp(id));
    }
  }
  const blun = hookOutput("UserPromptSubmit", context, { BLUN_PLUGIN_ROOT: "/synthetic/blun" });
  assert.equal(Buffer.byteLength(blun.hookSpecificOutput.message) <= 1200, true);
  assert.match(blun.hookSpecificOutput.message, /review-before-claims-and-actions/);
  assert.match(blun.hookSpecificOutput.message, /result\.txt/);
  assert.match(blun.hookSpecificOutput.message, /Nein, erst die Prüfsumme prüfen/);
  assert.match(blun.hookSpecificOutput.message, /Check configured access/);
  for (const id of ["assertion:user-feedback", "assertion:task"]) {
    assert.match(blun.hookSpecificOutput.message, new RegExp(id));
  }
  assert.doesNotMatch(blun.hookSpecificOutput.message, /only on demand/);
});

test("bounded recall preserves uncertainty and suppresses private group projection", () => {
  const capsule = preAnswerRecallCapsule(recallContext());
  assert.equal(capsule.feedback.status, "unresolved");
  assert.equal(capsule.feedback.completionVerified, false);
  assert.equal(capsule.feedback.digest, "b".repeat(64));
  assert.equal(recallContext().briefing.world.knowledge.taskContext.items[0].source.sessionRef,
    "session-ref:old");
  assert.equal(recallContext().briefing.world.knowledge.taskContext.items[0].source.messageRef,
    "message:correction");
  assert.equal(capsule.task.lastVerifiedStep.result, "passed");
  assert.equal(capsule.authority, "context-only");
  assert.equal(preAnswerRecallCapsule(recallContext("group:foreign")), null);
  assert.doesNotMatch(blunRuntimeMessage(JSON.stringify(recallContext("group:foreign"))),
    /result\.txt|Prüfsumme|configured access/);
});

test("multiple source messages remain visible so hosts cannot hide ambiguity", () => {
  const context = multipleFeedbackContext();
  const capsule = preAnswerRecallCapsule(context);
  assert.equal(capsule.feedbackCandidates.rows.length, 2);
  assert.deepEqual(capsule.feedbackCandidates.fields,
    ["id", "text", "digest", "message", "at"]);
  assert.deepEqual(capsule.feedbackCandidates.common,
    { provider: "claude", session: "session-ref:old" });
  assert.equal(capsule.feedbackReview.status, "multiple-unresolved");
  assert.equal(capsule.feedbackReview.completionVerified, false);
  assert.equal("omitted" in capsule.feedbackReview, false);
  assert.equal(capsule.feedbackCandidates.rows[0][2], "b".repeat(64));
  assert.match(JSON.stringify(capsule.mustRemember), /Check configured access/);
  for (const env of [{ CLAUDE_PLUGIN_ROOT: "/synthetic/claude" },
    { PLUGIN_ROOT: "/synthetic/codex" }, { BLUN_PLUGIN_ROOT: "/synthetic/blun" }]) {
    const output = hookOutput("UserPromptSubmit", JSON.stringify(context), env);
    const value = output.hookSpecificOutput.additionalContext || output.hookSpecificOutput.message;
    assert.match(value, /Nein, erst die Prüfsumme prüfen/);
    assert.match(value, /Nimm dafür die andere Datei/);
    assert.match(value, /multiple-unresolved/);
    if (env.BLUN_PLUGIN_ROOT) assert.equal(Buffer.byteLength(value) <= 1200, true);
  }
});

test("bounded King recall keeps three ordinary candidates instead of dropping the task", () => {
  const context = multipleFeedbackContext();
  delete context.briefing.preAnswerRecall.task.observedAt;
  const candidates = context.briefing.preAnswerRecall.feedbackCandidates;
  candidates.push({ ...candidates[0], text: "Das hatten wir gestern schon erledigt",
    id: "assertion:feedback-3", digest: "e".repeat(64), message: "message:completion-claim" });
  const capsule = preAnswerRecallCapsule(context);
  const message = blunRuntimeMessage(JSON.stringify(context));
  assert.equal(Buffer.byteLength(message) <= 1200, true);
  assert.match(message, /result\.txt/);
  const restored = capsule.feedbackCandidates.rows.map((row) => Object.fromEntries(
    capsule.feedbackCandidates.fields.map((field, index) =>
      [field, `${capsule.feedbackCandidates.prefixes[index]}${row[index]}`])));
  assert.deepEqual(restored.map((item) => item.id), candidates.map((item) => item.id));
  assert.deepEqual(restored.map((item) => item.message), candidates.map((item) => item.message));
  for (const candidate of candidates) {
    assert.match(message, new RegExp(candidate.digest));
    assert.match(message, new RegExp(candidate.text));
  }
  assert.match(message, /multiple-unresolved/);
  assert.match(message, /"completionVerified":false/);
  assert.doesNotMatch(message, /Recall unavailable/);
});

test("bounded King recall hands off loaded retrieval beside three source candidates", (t) => {
  const context = multipleFeedbackContext();
  delete context.briefing.preAnswerRecall.task.observedAt;
  const candidates = context.briefing.preAnswerRecall.feedbackCandidates;
  candidates.push({ ...candidates[0], text: "Das hatten wir gestern schon erledigt",
    id: "assertion:feedback-3", digest: "e".repeat(64), message: "message:completion-claim" });
  context.preflight.briefing.mustRemember = [];
  context.preflight.briefing.retrieval = [{ providerId: "memory:synthetic", items: [{
    id: "memory:access-check", revision: "1",
    claim: "Check configured access before claiming it is unavailable.",
    source: "source:synthetic", validity: "current", confidence: 1
  }] }];
  const capsule = preAnswerRecallCapsule(context);
  assert.deepEqual(capsule.feedbackCandidates.fields, ["id", "text", "digest", "message", "at"]);
  assert.deepEqual(capsule.feedbackCandidates.common,
    { provider: "claude", session: "session-ref:old" });
  assert.equal(capsule.feedbackCandidates.rows.length, 3);
  assert.ok(capsule.retrieval);
  assert.doesNotMatch(JSON.stringify(capsule.omitted || []), /retrieval/);
  assert.equal(capsule.retrieval[0].claim,
    "Check configured access before claiming it is unavailable.");
  const message = blunRuntimeMessage(JSON.stringify(context));
  assert.equal(Buffer.byteLength(message) <= 1200, true);
  assert.match(message, /Check configured access before claiming it is unavailable/);
  assert.match(message, /memory:synthetic/);
  assert.match(message, /result\.txt/);
  const restored = capsule.feedbackCandidates.rows.map((row) => Object.fromEntries(
    capsule.feedbackCandidates.fields.map((field, index) =>
      [field, `${capsule.feedbackCandidates.prefixes[index]}${row[index]}`])));
  assert.deepEqual(restored.map((item) => item.id), candidates.map((item) => item.id));
  assert.deepEqual(restored.map((item) => item.message), candidates.map((item) => item.message));
  for (const candidate of candidates) {
    assert.match(message, new RegExp(candidate.digest));
    assert.match(message, new RegExp(candidate.text));
  }
  assert.match(message, /multiple-unresolved/);
  assert.match(message, /"completionVerified":false/);
  t.diagnostic(JSON.stringify({ retrievalClaimsBefore: 0, retrievalClaimsAfter: 1,
    candidatesPreserved: 3, preAnswerBytes: Buffer.byteLength(message), maximumBytes: 1200,
    realModelRuns: 0, semanticApplication: "unverified" }));
});

test("long-path BLUN messages retain mandatory premortem text and bound optional detail", () => {
  const root = `/tmp/${"deep-profile/".repeat(80)}project`;
  const requirementId = `premortem-requirement:${"a".repeat(64)}:${"b".repeat(64)}`;
  const mandatory = premortemRequirementText(requirementId);
  const instruction = `${mandatory}\nCall record_delivery_premortem with root ${
    JSON.stringify(root)} and requirementId ${JSON.stringify(requirementId)}.`;
  const context = JSON.stringify({
    event: "UserPromptSubmit", loaded: true, indexedSources: 145,
    sourceResolution: { status: "loaded" },
    signal: { captured: true, reason: `rejected:${"🧭".repeat(80)}` },
    preflight: { premortem: { instruction, registration: { root, requirementId } } }
  });
  const message = blunRuntimeMessage(context);
  assert.equal(Buffer.byteLength(message) <= 1200, true);
  assert.match(message, /^AgentSpine ready: 145 sources indexed\./);
  assert.match(message, /advisory; does not block coding or replies/);
  assert.match(message, /session_briefing, delivery_knowledge_query, then record_delivery_premortem/);
  assert.match(message, /Premortem closure sha256 <64hex>/);
  assert.match(message, new RegExp(requirementId));
  assert.match(message, /\[optional runtime detail omitted: 1200-byte bound\]/);
  assert.equal(message.includes(JSON.stringify(root)), false);
  assert.doesNotMatch(message, /�|🧭/u);
  assert.equal(blunRuntimeMessage(context), message);
});

test("Codex blocking output contains only its strict top-level schema", () => {
  const output = blockedHookOutput("PreToolUse", "synthetic denial", {
    PLUGIN_ROOT: "/synthetic/codex", CLAUDE_PLUGIN_ROOT: "/synthetic/codex"
  });
  assert.deepEqual(output, { decision: "block", reason: "synthetic denial" });
});

test("Claude blocking output follows each event's exact decision schema", () => {
  const tool = blockedHookOutput("PreToolUse", "synthetic denial", {
    CLAUDE_PLUGIN_ROOT: "/synthetic/claude"
  });
  assert.deepEqual(tool, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "synthetic denial"
    }
  });
  const stop = blockedHookOutput("SubagentStop", "synthetic stop", {
    CLAUDE_PLUGIN_ROOT: "/synthetic/claude"
  });
  assert.deepEqual(stop, { decision: "block", reason: "synthetic stop" });
});

test("PostToolUse lifecycle receipts preserve each host's context field", () => {
  const digest = "a".repeat(64);
  const blun = lifecycleOutput("PostToolUse", null, {
    writeDigest: digest, writeIntent: false
  }, null, { BLUN_PLUGIN_ROOT: "/synthetic/blun" });
  assert.deepEqual(Object.keys(blun.hookSpecificOutput).sort(), ["hookEventName", "message"]);
  assert.match(blun.hookSpecificOutput.message, new RegExp(`Premortem latest write sha256 ${digest}`));

  const claude = lifecycleOutput("PostToolUse", null, {
    writeDigest: digest, writeIntent: false
  }, null, { CLAUDE_PLUGIN_ROOT: "/synthetic/claude" });
  assert.deepEqual(Object.keys(claude.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.match(claude.hookSpecificOutput.additionalContext,
    new RegExp(`Premortem latest write sha256 ${digest}`));
});
