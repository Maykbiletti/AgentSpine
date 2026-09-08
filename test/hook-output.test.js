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
          lastVerifiedStep: { summary: "Created result.txt", result: "passed",
            evidenceDigest: "a".repeat(64), observedAt: "2026-09-07T01:00:00.000Z" },
          nextStep: { summary: "Migrate result.txt" }, observedAt: "2026-09-07T01:00:00.000Z"
        },
        feedback: { text: "Nein, erst die Prüfsumme prüfen", interpretationStatus: "unresolved",
          sourceProvider: "claude", sourceDigest: "b".repeat(64), sessionRef: "session-ref:old",
          messageRef: "message:correction", observedAt: "2026-09-07T02:00:00.000Z" }
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
          value: { targetAssertionId: "assertion:task", sourceText: "Nein, erst die Prüfsumme prüfen",
            interpretationStatus: "unresolved", sourceProvider: "claude", sourceDigest: "b".repeat(64) },
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
  context.briefing.preAnswerRecall.feedbackCandidates = [first, { ...first,
    text: "Nimm dafür die andere Datei", sourceDigest: "d".repeat(64),
    messageRef: "message:ambiguous", observedAt: "2026-09-07T02:01:00.000Z" }]
    .map(({ text, sourceProvider, sourceDigest, sessionRef, messageRef, observedAt }) =>
      ({ text, sourceProvider, sourceDigest, sessionRef, messageRef, observedAt }));
  delete context.briefing.preAnswerRecall.task.assertionId;
  delete context.briefing.preAnswerRecall.task.lastVerifiedStep.evidenceDigest;
  delete context.briefing.preAnswerRecall.task.lastVerifiedStep.observedAt;
  context.briefing.preAnswerRecall.feedbackReview = { status: "multiple-unresolved", omitted: 0 };
  return context;
}

test("pre-answer recall is carried by every host output before claims", () => {
  const context = JSON.stringify(recallContext());
  for (const env of [{ CLAUDE_PLUGIN_ROOT: "/synthetic/claude" },
    { PLUGIN_ROOT: "/synthetic/codex" }]) {
    const output = hookOutput("UserPromptSubmit", context, env);
    assert.match(output.hookSpecificOutput.additionalContext, /result\.txt/);
    assert.match(output.hookSpecificOutput.additionalContext, /Nein, erst die Prüfsumme prüfen/);
    assert.match(output.hookSpecificOutput.additionalContext, /Check configured access/);
  }
  const blun = hookOutput("UserPromptSubmit", context, { BLUN_PLUGIN_ROOT: "/synthetic/blun" });
  assert.equal(Buffer.byteLength(blun.hookSpecificOutput.message) <= 1200, true);
  assert.match(blun.hookSpecificOutput.message, /review-before-claims-and-actions/);
  assert.match(blun.hookSpecificOutput.message, /result\.txt/);
  assert.match(blun.hookSpecificOutput.message, /Nein, erst die Prüfsumme prüfen/);
  assert.match(blun.hookSpecificOutput.message, /Check configured access/);
  assert.doesNotMatch(blun.hookSpecificOutput.message, /only on demand/);
});

test("bounded recall preserves uncertainty and suppresses private group projection", () => {
  const capsule = preAnswerRecallCapsule(recallContext());
  assert.equal(capsule.feedback.interpretationStatus, "unresolved");
  assert.equal(capsule.feedback.sourceDigest, "b".repeat(64));
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
  assert.equal(capsule.feedbackCandidates.length, 2);
  assert.equal(capsule.feedbackReview.status, "multiple-unresolved");
  assert.equal(capsule.feedbackCandidates[0].sourceDigest, "b".repeat(64));
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
