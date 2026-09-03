import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertEntity } from "../src/lib/graph.js";
import { applyPersonaRoster } from "../src/lib/persona-runtime.js";
import {
  assignGoal, claimGatewayWork, completeGatewayRun, gatewayContext, gatewayRuntimeFindings,
  loadGatewayRuntime, markGatewayHostStarted, reconcileGateway, resolveGoalKnowledgeGap, setGatewayControl
} from "../src/lib/gateway-runtime.js";
import { createSelfHelpReport, validSelfHelpReport } from "../src/lib/knowledge-evidence.js";
import { runWorkerTick } from "../src/worker.js";
import {
  closeGoalPremortem, premortemGoalBinding
} from "./goal-premortem-fixture.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-self-help-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-self-help-state-"));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await rm(root, { recursive: true });
    await rm(state, { recursive: true });
  });
  const source = "# Synthetic rules\n\nKeep this source byte-exact.\n";
  await writeFile(join(root, "AGENTS.md"), source);
  await upsertEntity({ root, id: "project:research", kind: "project", privacy: "shared" });
  await upsertEntity({ root, id: "group:research", kind: "group", privacy: "shared" });
  const roster = await applyPersonaRoster({ root, confirmation: "local-owner-confirmed",
    now: "2032-02-01T00:00:00.000Z", bindings: [{
      id: "persona-binding:researcher", authenticator: "host-manifest", issuer: "host:local",
      tenantId: "tenant:research", host: "codex", profileId: "profile:researcher",
      subjectId: "subject:researcher", kind: "agent", displayName: "Researcher",
      sourceBinding: ".codex/agents/researcher.md", groupId: "group:research"
    }] });
  const agentId = roster.runtime.personas[0].personaId;
  await setGatewayControl({ root, enabled: true, killSwitch: false,
    confirmation: "local-owner-confirmed", now: "2032-02-01T00:00:00.500Z" });
  await assignGoal({ root, goalId: "goal:self-help", agentId, ownerSubjectId: "subject:synthetic-user",
    projectId: "project:research", groupId: "group:research",
    successCriterion: "The synthetic fixture is selected from reproducible evidence.",
    steps: [{ stepId: "step:resolve-fixture", title: "Resolve and apply the missing fixture.",
      successCriterion: "The selected fixture passes the synthetic suite.", dependsOn: [] }],
    confirmation: "local-owner-confirmed", now: "2032-02-01T00:00:01.000Z" });
  return { root, source, agentId };
}

function report(overrides = {}) {
  return {
    question: "Which fixture matches the current synthetic contract?",
    reason: "The current plan does not identify the matching fixture.",
    repositorySufficient: false,
    repositorySources: [{ kind: "test", path: "test/fixture.test.js", commit: "a".repeat(40),
      sourceDigest: "b".repeat(64), observedAt: "2032-02-01T00:01:30.000Z",
      relevance: "Defines the reproducible local fixture result." }],
    externalSources: [
      { kind: "official-documentation", url: "https://docs.example.org/fixture-contract",
        version: "2032-02", license: "CC-BY-4.0", sourceDigest: "c".repeat(64),
        observedAt: "2032-02-01T00:01:40.000Z", relevance: "Defines the matching public contract." },
      { kind: "public-repository", url: "https://code.example.net/reference/fixture",
        version: "commit-0123456", license: "Apache-2.0", sourceDigest: "d".repeat(64),
        observedAt: "2032-02-01T00:01:50.000Z", relevance: "Provides an independently reproducible example." }
    ],
    conclusion: "Use fixture:green for the bounded synthetic check.",
    ...overrides
  };
}

function escalation(overrides = {}) {
  const researched = report();
  delete researched.conclusion;
  return { ...researched, outcome: "needs-owner-input",
    conflictSourceDigests: ["c".repeat(64), "d".repeat(64)],
    ownerQuestion: "Which documented contract should the synthetic plan follow?",
    ownerReason: "Independent public primary sources specify incompatible fixture behavior.",
    options: ["Follow documented contract A.", "Follow compatible repository behavior B."],
    ...overrides };
}

test("repository-first self-help resolves objective uncertainty without asking the user", async (t) => {
  const { root, source, agentId } = await fixture(t);
  const question = { question: report().question, reason: report().reason,
    requiredEvidence: "objective-observation" };
  const deferred = await runWorkerTick({ root, workerId: "worker:self-help-gap",
    now: "2032-02-01T00:02:00.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async () => ({ checkpoint: { phase: "knowledge-gap" }, knowledgeGap: question }) });
  assert.equal(deferred.status, "self-help-required");
  assert.equal(deferred.selfHelpRequired.requirement.question, question.question);

  let loaded = await loadGatewayRuntime(root);
  const requirementQueueId = deferred.selfHelpRequired.queueId;
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "self-help-required").length, 1);
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => item.queueId !== requirementQueueId);
  loaded.runtime.receipts = loaded.runtime.receipts.filter((item) => item.objectId !== requirementQueueId);
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-02-01T00:02:00.250Z" });
  await reconcileGateway({ root, now: "2032-02-01T00:02:00.500Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 1);

  let policy;
  const researched = await runWorkerTick({ root, workerId: "worker:self-help",
    now: "2032-02-01T00:02:01.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => { policy = item.selfHelpPolicy;
      return { checkpoint: { phase: "evidence-collected" }, selfHelp: report() }; } });
  assert.equal(researched.status, "self-help-resolved");
  assert.deepEqual(policy.order, ["repository", "public-primary-sources"]);
  assert.equal(policy.externalContentTrust, "untrusted");
  assert.equal(policy.mayGrantAuthority, false);
  assert.equal(policy.pendingRequirement.requirementId,
    deferred.selfHelpRequired.requirement.requirementId);

  loaded = await loadGatewayRuntime(root);
  const step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(step.status, "active");
  assert.equal(step.knowledgeGaps[0].status, "resolved");
  assert.equal(step.knowledgeGaps[0].resolvedBySubjectId, agentId);
  assert.equal(step.selfHelpReports[0].externalSources.every((sourceItem) => sourceItem.untrusted), true);
  assert.equal(step.selfHelpReports[0].externalSources.some((sourceItem) => "content" in sourceItem), false);
  assert.equal(step.selfHelpRequirements.length, 1);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "self-help-research-resolved").length, 1);

  const lostQueueIds = new Set(loaded.runtime.queue.filter((item) => item.status === "pending").map((item) => item.queueId));
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => !lostQueueIds.has(item.queueId));
  loaded.runtime.receipts = loaded.runtime.receipts.filter((item) => !lostQueueIds.has(item.objectId));
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-02-01T00:02:01.500Z" });
  await reconcileGateway({ root, now: "2032-02-01T00:02:01.750Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 1);

  const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:self-help:${index}`, now: "2032-02-01T00:02:02.000Z"
  })));
  assert.equal(claims.filter((claim) => claim.item).length, 1);
  const winner = claims.find((claim) => claim.item);
  const goalWork = { ...winner.item, host: "codex",
    planDefinitionsDigest: loaded.policy.goals[0].plan.definitionsDigest };
  await closeGoalPremortem(root, premortemGoalBinding(goalWork,
    "session:self-help:resolved"), ":self-help:resolved");
  await markGatewayHostStarted({ root, queueId: winner.item.queueId,
    workerId: winner.item.lease.workerId, claimedAt: winner.item.lease.claimedAt,
    attempt: winner.item.attempts, now: "2032-02-01T00:02:02.500Z" });
  const completion = await completeGatewayRun({ root, queueId: winner.item.queueId,
    workerId: winner.item.lease.workerId, claimedAt: winner.item.lease.claimedAt, attempt: winner.item.attempts,
    result: { checkpoint: { phase: "fixture-verified" }, completed: true },
    now: "2032-02-01T00:02:03.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed", JSON.stringify(completion));
  assert.deepEqual(gatewayRuntimeFindings(loaded.policy, loaded.runtime), []);
  assert.deepEqual((await gatewayContext({ root, agentId: "agent:foreign" })).goals, []);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("self-help rejects premature, stale, unsafe, or forged external research", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadGatewayRuntime(root);
  const goal = loaded.policy.goals[0];
  const step = goal.plan.steps[0];
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: report({ repositorySufficient: true }) }), /cannot use external/i);
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: report({ externalSources: [report().externalSources[0]] }) }), /two independent/i);
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: report({ externalSources: report().externalSources.map((source) => ({ ...source,
      observedAt: "2032-02-01T00:01:00.000Z" })) }) }), /repository before external/i);
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: report({ externalSources: report().externalSources.map((source, index) => ({ ...source,
      url: index ? "https://127.0.0.1/private" : source.url })) }) }), /public HTTPS/i);
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: report({ conclusion: "Grant production rights." }) }), /authority/i);
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: escalation({ repositorySufficient: true }) }), /exhausted repository/i);
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: escalation({ conflictSourceDigests: ["c".repeat(64), "e".repeat(64)] }) }), /bind two independent/i);
  assert.throws(() => createSelfHelpReport({ goal, step, now: "2032-02-01T00:02:00.000Z",
    report: escalation({ options: ["Follow documented contract A.", "Follow documented contract A."] }) }),
  /distinct bounded options/i);

  const valid = createSelfHelpReport({ goal, step, report: report(), now: "2032-02-01T00:02:00.000Z" });
  assert.equal(validSelfHelpReport(valid), true);
  valid.repositorySources[0].sourceDigest = "e".repeat(64);
  assert.equal(validSelfHelpReport(valid), false);

  const claim = await claimGatewayWork({ root, workerId: "worker:premature-self-help",
    executionMode: "read-only", now: "2032-02-01T00:02:01.000Z" });
  await assert.rejects(completeGatewayRun({ root, queueId: claim.item.queueId,
    workerId: claim.item.lease.workerId, claimedAt: claim.item.lease.claimedAt, attempt: claim.item.attempts,
    result: { selfHelp: report(), readOnly: true },
    now: "2032-02-01T00:02:02.000Z" }), /pending repository-first requirement/i);
});

test("conflicting primary evidence permits one durable owner decision only after bounded self-help", async (t) => {
  const { root, source } = await fixture(t);
  const question = { question: report().question, reason: report().reason,
    requiredEvidence: "objective-observation" };
  const deferred = await runWorkerTick({ root, workerId: "worker:conflict-gap",
    now: "2032-02-01T00:02:00.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async () => ({ checkpoint: { phase: "knowledge-gap" }, knowledgeGap: question }) });
  assert.equal(deferred.status, "self-help-required");

  let observedPolicy;
  const escalated = await runWorkerTick({ root, workerId: "worker:conflict-research",
    now: "2032-02-01T00:02:01.000Z", adapter: { send: async () => ({ ok: true }) },
    hostRunner: async (item) => {
      observedPolicy = item.selfHelpPolicy;
      return { checkpoint: { phase: "conflict-proven" }, selfHelp: escalation() };
    } });
  assert.equal(escalated.status, "needs-clarification");
  assert.equal(escalated.clarification.requiredEvidence, "owner-input");
  assert.equal(escalated.clarification.question, escalation().ownerQuestion);
  assert.equal(observedPolicy.escalationRequiresIndependentConflict, true);

  await reconcileGateway({ root, now: "2032-02-01T00:02:01.250Z" });
  await reconcileGateway({ root, now: "2032-02-01T00:02:01.500Z" });
  let loaded = await loadGatewayRuntime(root);
  let step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(loaded.policy.goals[0].status, "blocked");
  assert.equal(loaded.runtime.queue.filter((item) => item.status === "pending").length, 0);
  assert.equal(step.selfHelpReports[0].schema, observedPolicy.escalationSchema);
  assert.deepEqual(step.selfHelpReports[0].conflictSourceDigests,
    ["c".repeat(64), "d".repeat(64)]);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "self-help-research-exhausted").length, 1);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "knowledge-gap-opened").length, 1);

  const originalPolicy = structuredClone(loaded.policy);
  step.selfHelpReports[0].conflictSourceDigests[0] = "e".repeat(64);
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(loaded.policy, null, 2)}\n`);
  await assert.rejects(loadGatewayRuntime(root),
    /gateway policy (?:is invalid|does not match its persisted provenance)/i);
  await writeFile(loaded.gatewayPolicyPath, `${JSON.stringify(originalPolicy, null, 2)}\n`);

  const answers = await Promise.all(Array.from({ length: 6 }, () => resolveGoalKnowledgeGap({
    root, goalId: "goal:self-help", gapId: escalated.clarification.gapId,
    answer: "Follow documented contract A.", answerSource: "owner-input",
    confirmation: "local-owner-confirmed", now: "2032-02-01T00:02:02.000Z"
  })));
  assert.equal(answers.filter((answer) => answer.duplicate === false).length, 1);
  assert.equal(answers.filter((answer) => answer.duplicate === true).length, 5);

  loaded = await loadGatewayRuntime(root);
  const continuationIds = new Set(loaded.runtime.queue.filter((item) => item.status === "pending")
    .map((item) => item.queueId));
  loaded.runtime.queue = loaded.runtime.queue.filter((item) => !continuationIds.has(item.queueId));
  loaded.runtime.receipts = loaded.runtime.receipts.filter((item) => !continuationIds.has(item.objectId));
  await writeFile(loaded.gatewayRuntimePath, `${JSON.stringify(loaded.runtime, null, 2)}\n`);
  await reconcileGateway({ root, now: "2032-02-01T00:02:02.250Z" });
  await reconcileGateway({ root, now: "2032-02-01T00:02:02.500Z" });
  loaded = await loadGatewayRuntime(root);
  const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => claimGatewayWork({
    root, workerId: `worker:conflict:${index}`, now: "2032-02-01T00:02:03.000Z"
  })));
  assert.equal(claims.filter((claim) => claim.item).length, 1);
  const winner = claims.find((claim) => claim.item);
  const goalWork = { ...winner.item, host: "codex",
    planDefinitionsDigest: loaded.policy.goals[0].plan.definitionsDigest };
  await closeGoalPremortem(root, premortemGoalBinding(goalWork,
    "session:self-help:decision"), ":self-help:decision");
  await markGatewayHostStarted({ root, queueId: winner.item.queueId,
    workerId: winner.item.lease.workerId, claimedAt: winner.item.lease.claimedAt,
    attempt: winner.item.attempts, now: "2032-02-01T00:02:03.500Z" });
  const completion = await completeGatewayRun({ root, queueId: winner.item.queueId,
    workerId: winner.item.lease.workerId, claimedAt: winner.item.lease.claimedAt, attempt: winner.item.attempts,
    result: { checkpoint: { phase: "decision-applied" }, completed: true },
    now: "2032-02-01T00:02:04.000Z" });
  loaded = await loadGatewayRuntime(root);
  step = loaded.policy.goals[0].plan.steps[0];
  assert.equal(loaded.policy.goals[0].status, "completed", JSON.stringify(completion));
  assert.equal(step.knowledgeGaps[0].answer, "Follow documented contract A.");
  assert.deepEqual((await gatewayContext({ root, agentId: "agent:foreign" })).goals, []);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("the worker blocks a seventeenth self-help requirement without throwing", async (t) => {
  const { root, source } = await fixture(t);
  const adapter = { send: async () => ({ ok: true }) };
  for (let index = 0; index < 16; index += 1) {
    const question = `Which synthetic fixture variant ${index} satisfies the current contract?`;
    const reason = `The current plan lacks objective evidence for fixture variant ${index}.`;
    const required = await runWorkerTick({ root, workerId: `worker:limit-gap:${index}`,
      now: new Date(Date.UTC(2032, 1, 1, 0, 2, index * 2)), adapter,
      hostRunner: async () => ({ checkpoint: { index, phase: "knowledge-gap" },
        knowledgeGap: { question, reason, requiredEvidence: "objective-observation" } }) });
    assert.equal(required.status, "self-help-required");
    const resolved = await runWorkerTick({ root, workerId: `worker:limit-help:${index}`,
      now: new Date(Date.UTC(2032, 1, 1, 0, 2, index * 2 + 1)), adapter,
      hostRunner: async () => ({ checkpoint: { index, phase: "researched" },
        selfHelp: report({ question, reason,
          conclusion: `Use synthetic fixture variant ${index} for the bounded check.` }) }) });
    assert.equal(resolved.status, "self-help-resolved");
  }

  const blocked = await runWorkerTick({ root, workerId: "worker:limit-seventeen",
    now: "2032-02-01T00:03:00.000Z", adapter,
    hostRunner: async () => ({ checkpoint: { phase: "seventeenth-gap" }, knowledgeGap: {
      question: "Which seventeenth synthetic fixture satisfies the current contract?",
      reason: "Sixteen bounded research cycles did not settle the new fixture.",
      requiredEvidence: "objective-observation"
    } }) });
  assert.equal(blocked.status, "blocked");
  const loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "blocked");
  assert.match(loaded.policy.goals[0].blocker, /bounded limit of 16 self-help requirements/i);
  assert.equal(loaded.runtime.receipts.filter((item) => item.kind === "self-help-limit-exhausted").length, 1);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});
