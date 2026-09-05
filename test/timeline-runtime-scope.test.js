import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { startMcpServer } from "../src/mcp.js";
import { timelineInvocationInput, timelineInvocationRequest } from "../src/lib/mcp-timeline-tools.js";

function privateArgs(overrides = {}) {
  return {
    root: "/synthetic/project", sessionId: "session:runtime", entityId: "agent:runtime",
    userId: "person:runtime", tenantId: "tenant:runtime", projectId: "project:runtime",
    taskId: "task:runtime", goalId: "goal:runtime", goalStepId: "step:runtime",
    groupId: null, timelineVisibility: "private-verified", enrollmentDigest: "a".repeat(64),
    at: "2026-09-04T12:40:00.000Z", query: "runtime Suite", windowSeconds: 0,
    ...overrides
  };
}

function mcpClient(environment) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let sequence = 0;
  let buffered = "";
  const pending = new Map();
  output.on("data", (chunk) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n");
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      pending.get(message.id)?.(JSON.parse(message.result.content[0].text));
      pending.delete(message.id);
    }
  });
  startMcpServer(input, output, { environment });
  return (name, args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timed out`)), 2_000);
    pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
}

test("nested group claims cannot be erased by flat timeline arguments", async () => {
  const args = privateArgs({ agent_spine_scope: { group_id: "group:authenticated", groupId: null } });
  const input = timelineInvocationInput(args);
  assert.equal(input.valid, true);
  assert.equal(input.groupClaim, true);
  assert.equal(input.scope.groupId, "group:authenticated");
  assert.equal(timelineInvocationRequest("search", args, args.root), null);

  const result = await mcpClient({})("session_timeline_search", args);
  assert.deepEqual(result, { status: "unavailable", reason: "timeline-group-suppressed", authority: "context-only" });
});

test("stale private-shaped calls remain suppressed when runtime group context appears", async () => {
  const groupEnvironment = {
    AGENTSPINE_GATEWAY_CONTEXT: "agentspine.gateway-start/v1", AGENTSPINE_HOST: "claude",
    AGENTSPINE_ENTITY_ID: "agent:runtime", AGENTSPINE_GROUP_ID: "group:later",
    AGENTSPINE_PROJECT_ID: "project:runtime", AGENTSPINE_TASK_ID: "task:runtime",
    AGENTSPINE_GOAL_ID: "goal:runtime", AGENTSPINE_GOAL_STEP_ID: "step:runtime",
    AGENTSPINE_USER_ID: "person:runtime", AGENTSPINE_TENANT_ID: "tenant:runtime"
  };
  const result = await mcpClient(groupEnvironment)("session_timeline_search", privateArgs({
    agent_spine_scope: { groupId: null, entityId: "agent:runtime", userId: "person:runtime",
      tenantId: "tenant:runtime", projectId: "project:runtime", taskId: "task:runtime" }
  }));
  assert.deepEqual(result, { status: "unavailable", reason: "timeline-group-suppressed", authority: "context-only" });
});

test("conflicting nested private claims never form an invocation request", () => {
  const args = privateArgs({ agent_spine_scope: { entity_id: "agent:other" } });
  const input = timelineInvocationInput(args);
  assert.equal(input.valid, false);
  assert.equal(input.reason, "timeline-scope-conflict");
  assert.equal(timelineInvocationRequest("search", args, args.root), null);
});
