import test from "node:test";
import assert from "node:assert/strict";
import { PREMORTEM_REQUIREMENT_TEXT, premortemRequirementText } from "../src/lib/delivery-premortem.js";
import { blockedHookOutput, blunRuntimeMessage, lifecycleOutput } from "../src/lib/hook-output.js";

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
  assert.equal(message.includes(mandatory), true);
  assert.equal(message.includes(PREMORTEM_REQUIREMENT_TEXT), true);
  assert.match(message, /Call record_delivery_premortem for the current project/);
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
