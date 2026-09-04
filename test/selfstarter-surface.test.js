import test from "node:test";
import assert from "node:assert/strict";
import * as selfstarter from "../src/lib/selfstarter.js";

const PUBLIC_EXPORTS = [
  "authorizeJobEffect",
  "cancelJob",
  "checkpointJobEffect",
  "closeJobLease",
  "collectWorkspaceFiles",
  "deleteJob",
  "executionPolicyFindings",
  "grantExecution",
  "inspectSelfstarter",
  "loadExecutionPolicy",
  "loadSelfstarter",
  "registerJob",
  "resolveSessionJob",
  "revokeExecution",
  "selfstarterContext",
  "selfstarterFindings",
  "startOrResumeJob",
  "workspaceFingerprint"
];

test("self-starter facade preserves its exact public surface", () => {
  assert.deepEqual(Object.keys(selfstarter).sort(), PUBLIC_EXPORTS);
});
