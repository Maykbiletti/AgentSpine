import assert from "node:assert/strict";
import { runHook } from "../src/hook.js";
import { client } from "./mcp-bounded-fixture.js";

export const PROJECT = "project:continuation";
export const SESSION = "session:continuation";
export const ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline changed",
    check: "Compare source bytes." },
  { category: "contract-tests",
    failure: "this delivery fails because continuation loses its exact binding",
    check: "Exercise multiple turns and restart." },
  { category: "delivery-path",
    failure: "this delivery fails because the continued delivery cannot close",
    check: "Complete the real Hook and MCP path." }
];

export function context(root, extra = {}) {
  return { host: "codex", cwd: root, session_id: SESSION,
    agent_spine_scope: { project_id: PROJECT }, ...extra };
}

export async function prompt(root, eventId, extra = {}) {
  const result = await runHook({ ...context(root),
    hook_event_name: "UserPromptSubmit", event_id: eventId,
    prompt: "Continue the synthetic delivery.", ...extra });
  return result.preflight.premortem;
}

export async function register(root, requirementId) {
  const call = client();
  const briefing = await call("session_briefing", { root, host: "codex",
    requirementId, includeSourceContent: false, maxBytes: 4096 });
  assert.equal(briefing.isError, false);
  const knowledge = await call("delivery_knowledge_query", { root, requirementId,
    targetPaths: ["target.js", "artifact.txt"], contractPaths: ["AGENTS.md"],
    recentErrorTerms: ["assignment", "continuation"], maxBytes: 4096 });
  assert.equal(knowledge.isError, false);
  const artifact = await call("record_delivery_premortem", { root, requirementId, items: ITEMS });
  assert.equal(artifact.isError, false);
  return artifact.artifact;
}

export function closure(artifact, writeDigest) {
  return [`Premortem closure sha256 ${artifact.digest}`,
    `Premortem latest write sha256 ${writeDigest}`,
    ...artifact.items.map(item =>
      `- ${item.category} ${item.checkId}: PASS — measured synthetic continuation passed`)
  ].join("\n");
}
