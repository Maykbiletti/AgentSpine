import test from "node:test";
import assert from "node:assert/strict";
import { hookOutput, lifecycleOutput, blockedHookOutput } from "../src/lib/hook-output.js";
import { hostContextLimit } from "../src/lib/hook-context.js";

const env = { BLUN_PLUGIN_ROOT: "/synthetic/plugin", BLUN_HOME: "/synthetic/home" };

test("King preparation and compaction hooks carry model context without visible messages", () => {
  for (const event of ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]) {
    const context = JSON.stringify({ event, loaded: true, indexedSources: 1,
      sourceResolution: { status: "loaded" } });
    const output = hookOutput(event, context, env);
    assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
    assert.match(output.hookSpecificOutput.additionalContext, /AgentSpine ready:/);
    assert.equal(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 1200, true);
  }
});

test("King lifecycle receipts remain model-only without hiding actual denials", () => {
  const digest = "a".repeat(64);
  for (const event of ["PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) {
    const output = lifecycleOutput(event, null, { writeDigest: digest }, null, env);
    assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(digest));
    assert.deepEqual(blockedHookOutput(event, "source integrity failed", env),
      { decision: "block", reason: "source integrity failed" });
  }
});

test("King lifecycle warnings stay visible while successful context stays hidden", () => {
  const digest = "a".repeat(64);
  const warning = "Source context is incomplete; one rule was not verified.";
  const output = lifecycleOutput("PostToolUse", null, { writeDigest: digest }, {
    status: "test-failed", reason: "The synthetic verification failed."
  }, env, warning);
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(),
    ["additionalContext", "hookEventName", "message"]);
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(digest));
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /incomplete|failed/);
  assert.match(output.hookSpecificOutput.message, /source warning: .*incomplete/i);
  assert.match(output.hookSpecificOutput.message, /synthetic verification failed/i);
  assert.doesNotMatch(output.hookSpecificOutput.message, new RegExp(digest));
});

test("Codex instruction contexts account for JSON escaping, including standard-size files", () => {
  for (const bytes of [8192, 32768, 44000]) {
    const preflight = { receipt: { instructionHost: "codex", instructionBudget: {
      mode: bytes <= 8192 ? "standard" : "codex-required-overflow"
    } }, briefing: { instructions: [{ content: '"'.repeat(bytes) }] } };
    assert.equal(hostContextLimit(preflight) >= Buffer.byteLength(JSON.stringify(preflight.briefing)) + 9500, true);
  }
  assert.equal(hostContextLimit(null), 9500);
  assert.equal(hostContextLimit({ receipt: { instructionHost: "claude",
    instructionBudget: { mode: "claude-required-overflow" } } }), 32768);
});
