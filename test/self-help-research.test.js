import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertEntity } from "../src/lib/graph.js";
import { applyPersonaRoster } from "../src/lib/persona-runtime.js";
import {
  assignGoal, claimGatewayWork, completeGatewayRun, gatewayContext, gatewayRuntimeFindings,
  loadGatewayRuntime, reconcileGateway, setGatewayControl
} from "../src/lib/gateway-runtime.js";
import { createSelfHelpReport, validSelfHelpReport } from "../src/lib/knowledge-evidence.js";
import { runWorkerTick } from "../src/worker.js";

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
  await completeGatewayRun({ root, queueId: winner.item.queueId, workerId: winner.item.lease.workerId,
    result: { checkpoint: { phase: "fixture-verified" }, completed: true },
    now: "2032-02-01T00:02:03.000Z" });
  loaded = await loadGatewayRuntime(root);
  assert.equal(loaded.policy.goals[0].status, "completed");
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

  const valid = createSelfHelpReport({ goal, step, report: report(), now: "2032-02-01T00:02:00.000Z" });
  assert.equal(validSelfHelpReport(valid), true);
  valid.repositorySources[0].sourceDigest = "e".repeat(64);
  assert.equal(validSelfHelpReport(valid), false);
});
