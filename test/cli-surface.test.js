import test from "node:test";
import assert from "node:assert/strict";
import { agentCommands } from "../src/cli-agent.js";
import { attentionCommands } from "../src/cli-attention.js";
import { continuityCommands } from "../src/cli-continuity.js";
import { coreCommands } from "../src/cli-core.js";
import { diagnosticsCommands } from "../src/cli-diagnostics.js";
import { learningCommands } from "../src/cli-learning.js";
import { sharingCommands } from "../src/cli-sharing.js";

const EXPECTED_COMMANDS = `
acceptance annotate attention attention-add attention-config attention-delete
attention-event-delete attention-events attention-purge attention-resolve attention-touch audit
briefing channel-bind channel-events channel-policy channel-revoke context continuity-config
continuity-purge continuity-status delegation-check delegation-grant delegation-policy delegation-revoke
doctor entity execution-grant execution-policy execution-revoke gateway-control gateway-status goal-assign
goal-clarify job-cancel job-delete job-register jobs learn-application-revoke learn-config learn-context
learn-delete learn-delivery-purge learn-delivery-revoke learn-evaluate learn-evaluation
learn-evaluation-revoke learn-evaluator-register learn-evaluator-revoke learn-evidence
learn-evidence-revoke learn-evidence-source-attestation-revoke learn-measurement
learn-measurement-purge learn-measurement-revoke learn-outcome learn-outcome-revoke learn-propose
learn-revalidate learn-revalidation-start learn-review learn-rollback learn-status
learn-trial-failure-revoke learn-validation-revoke link mcp persona-sync personas preflight-policy
preflight-status read relate relationships remember-confirm remember-propose remember-purge
remember-rollback scan share-config share-context share-delete share-feed-publish share-feed-pull
share-feed-state share-https-publish share-https-pull share-inbox share-init share-keygen
share-peer-pull share-peer-serve share-publish share-pull share-review share-rollback share-signers
share-snapshot-export share-sqlite-init share-sqlite-inspect share-sqlite-publish share-sqlite-pull
share-trust share-trust-list share-trust-revoke source-bind source-purge source-rollback source-status
task-create task-delete task-update tasks timeline-enroll timeline-enrollment-recover timeline-receipt verify
`.trim().split(/\s+/).sort();

test("CLI domain routes preserve the exact command surface without duplicate ownership", () => {
  const routes = [
    coreCommands, attentionCommands, learningCommands, continuityCommands,
    agentCommands, sharingCommands, diagnosticsCommands
  ];
  const commands = routes.flatMap((route) => [...route]);
  assert.equal(commands.length, new Set(commands).size);
  assert.deepEqual(commands.sort(), EXPECTED_COMMANDS);
});
