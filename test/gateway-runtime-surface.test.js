import test from "node:test";
import assert from "node:assert/strict";
import * as gatewayRuntime from "../src/lib/gateway-runtime.js";

test("gateway compatibility entrypoint preserves the exact public surface", () => {
  assert.deepEqual(Object.keys(gatewayRuntime).sort(), [
    "EXECUTION_ATTEMPT_SCHEMA",
    "EXECUTION_OUTCOME_SCHEMA",
    "GATEWAY_EVENT_SCHEMA",
    "GATEWAY_POLICY_SCHEMA",
    "GATEWAY_RUNTIME_SCHEMA",
    "GOAL_PLAN_SCHEMA",
    "KNOWLEDGE_GAP_SCHEMA",
    "STRATEGY_TRANSFER_PROOF_SCHEMA",
    "assignGoal",
    "claimGatewayWork",
    "completeGatewayRun",
    "deliverPrepared",
    "enqueueGatewayWake",
    "executionAttemptForStep",
    "failGatewayRun",
    "gatewayContext",
    "gatewayHealthFindings",
    "gatewayRuntimeFindings",
    "inspectGatewayRuntime",
    "loadGatewayRuntime",
    "markGatewayHostStarted",
    "reconcileGateway",
    "resolveGoalKnowledgeGap",
    "setGatewayControl",
    "updateGatewayHealth"
  ]);
});
