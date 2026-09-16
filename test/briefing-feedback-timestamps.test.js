import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./mcp-bounded-fixture.js";
import { recordWorldAssertion } from "../src/lib/world-model.js";
import { captureTimelineUserFeedback } from "../src/lib/timeline-user-feedback.js";
import { sessionBriefing } from "../src/lib/briefing.js";
import { hookOutput } from "../src/lib/hook-output.js";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const scope = { projectId: "project:timestamps", currentTaskId: "task:timestamps",
  portalRef: `portal-ref:${"a".repeat(32)}`, threadRef: `thread-ref:${"b".repeat(32)}` };

function restore(packet) {
  return packet.rows.map((row) => ({ ...packet.common, ...Object.fromEntries(
    packet.fields.map((field, index) => [field, `${packet.prefixes[index]}${row[index]}`])) }));
}

for (const [label, times] of Object.entries({
  "same hour": ["2026-09-08T05:10:00.000Z", "2026-09-08T05:20:00.000Z", "2026-09-08T05:30:00.000Z"],
  "different hours": ["2026-09-08T05:10:00.000Z", "2026-09-08T06:20:00.000Z", "2026-09-08T07:30:00.000Z"],
  "different dates": ["2026-09-07T23:10:00.000Z", "2026-09-08T00:20:00.000Z", "2026-09-09T01:30:00.000Z"]
})) {
  test(`briefing feedback round-trips exact source times across ${label}`, async (t) => {
    const item = await fixture(t, { homeRoot: false });
    await recordWorldAssertion({ root: item.root, id: "assertion:timestamp-task",
      subjectId: scope.currentTaskId, predicate: "task.continuation",
      value: { schema: "agentspine.task-continuation/v1", taskId: scope.currentTaskId,
        status: "active", objective: "Check result.txt", lastVerifiedStep: null,
        openQuestions: [], nextStep: { id: "step:check", summary: "Check result.txt" } },
      evidenceKind: "explicit-user-feedback", evidenceId: "evidence:synthetic-task",
      evidenceDigest: hash("synthetic task"), observedAt: "2026-09-07T00:00:00.000Z",
      projectId: scope.projectId, groupId: null, privacy: "private", knowledgeKind: "task-state",
      sessionRef: `session-ref:${"c".repeat(32)}`, messageRef: "message:synthetic-task",
      portalRef: scope.portalRef, threadRef: scope.threadRef, now: NOW });
    // Synthetic source/projection test, not native enrollment or model acceptance.
    const source = Buffer.from(times.map((at, index) => JSON.stringify({ at,
      text: `Synthetic correction ${index}` })).join("\r\n") + "\r\n");
    const path = join(item.root, "synthetic-feedback.jsonl");
    await writeFile(path, source);
    const expected = [];
    for (const [index, at] of times.entries()) {
      const event = { id: `timeline-event:${index}`, at, sourceText: `Synthetic correction ${index}`,
        sourceProvider: "claude", sourceDigest: hash(source), messageDigest: hash(`${index}:${at}`),
        sessionRef: `session-ref:${String(index).repeat(32)}`, messageRef: `timeline-event:${index}` };
      const result = await captureTimelineUserFeedback({ root: item.root, scope, event, now: NOW });
      assert.equal(result.status, "recorded");
      expected.unshift({ id: result.assertion.id, text: event.sourceText, provider: event.sourceProvider,
        digest: event.sourceDigest, session: event.sessionRef, message: event.messageRef, at });
    }
    const options = { root: item.root, cwd: item.root, host: "claude", ...scope,
      groupId: null, includePrivate: true, includeSourceContent: false, now: NOW };
    for (const preAnswer of [false, true]) {
      const briefing = await sessionBriefing({ ...options, preAnswer });
      assert.deepEqual(restore(briefing.preAnswerRecall.feedbackCandidates), expected);
      assert.equal(briefing.preAnswerRecall.feedbackReview.completionVerified, false);
      const context = JSON.stringify({ event: "UserPromptSubmit", loaded: true, briefing,
        preflight: { briefing: { mustRemember: [], retrieval: [] } } });
      for (const env of [{ CLAUDE_PLUGIN_ROOT: "/synthetic/claude" },
        { PLUGIN_ROOT: "/synthetic/codex" }, { BLUN_PLUGIN_ROOT: "/synthetic/king" }]) {
        const output = hookOutput("UserPromptSubmit", context, env).hookSpecificOutput;
        const text = output.additionalContext;
        const recall = env.BLUN_PLUGIN_ROOT
          ? JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
          : JSON.parse(text).briefing.preAnswerRecall;
        assert.deepEqual(restore(recall.feedbackCandidates), expected);
        assert.equal(output.message, undefined);
        if (env.BLUN_PLUGIN_ROOT) assert.ok(Buffer.byteLength(text) <= 1200);
      }
    }
    await assert.rejects(sessionBriefing({ ...options, preAnswer: true,
      threadRef: `thread-ref:${"f".repeat(32)}` }), /current task is not visible/);
    assert.deepEqual(await readFile(path), source);
    await item.preserve();
  });
}
