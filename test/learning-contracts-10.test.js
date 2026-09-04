import {
  test, assert, readFile, writeFile, join, fileURLToPath, commitLearningOutcome,
  addLearningEvidence, beginLearningRevalidation,
  configureLearning, deleteLearning, evaluateLearning, learningContext, learningOutcomeStatus, loadLearning, proposeLearning,
  purgeLearningBySubject, purgeStaleLearningApplications, purgeStaleLearningMeasurements, recordLearningApplications, recordLearningDeliveries, recordLearningMeasurement, registerLearningEvaluation,
  registerLearningEvaluator, renewLearningValidation, revokeLearningEvaluator, revokeLearningEvidence, revokeLearningApplication, revokeLearningDelivery, revokeLearningEvaluation,
  revokeLearningMeasurement, revokeLearningOutcome, revokeLearningTrialFailure, revokeLearningValidation, revokeLearningEvidenceSourceAttestation, reviewLearning, rollbackLearning,
  linkEntities, upsertEntity, runHook, fixture, hash, evidence, scopedTurn,
  syntheticDatasetDigest, outcome, recordLearningOutcome, syntheticEvaluators, evaluatorRoots, evaluation, projectedApplication,
  application, establishValidatedLearning, runCli
} from "./learning-fixture.js";

test("a forged validated state without its immutable lease is withheld and rolled back", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2035-01-01T00:00:00.000Z");
  await establishValidatedLearning(root, {
    learningId: "learning:lease-missing", evaluationId: "evaluation:lease-missing", start,
    expiresAt: "2035-02-01T00:00:00.000Z"
  });
  const stored = await loadLearning(root);
  stored.learning.validationLeases = [];
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  const context = await learningContext({ root, scope: scopedTurn, now: new Date("2035-01-01T00:00:05.000Z") });
  assert.equal(context.items.length, 0);
  assert.deepEqual(context.diagnostics, ["missing-validation-lease:learning:lease-missing"]);
  const status = await learningOutcomeStatus({ root, now: new Date("2035-01-01T00:00:05.000Z") });
  assert.equal(status.records[0].canaryStatus, "unproven");
  const reconciled = await evaluateLearning({ root, now: new Date("2035-01-01T00:00:05.000Z") });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:lease-missing", decision: "rolled-back" }]);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("after outcomes require distinct exact-turn application receipts", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:application-bound", kind: "behavior", claim: "Apply the fixed synthetic check.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:application-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:application-bound", evidence: evidence("evidence:application-two", 0.97) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  await evaluation(root, "learning:application-bound", {
    evaluatorIds: ["evaluator:baseline-a", "evaluator:baseline-b"]
  });
  await recordLearningOutcome({
    root, learningId: "learning:application-bound",
    ...outcome("outcome:application-before-a", "before", 0.4, "evaluator:baseline-a")
  });
  await recordLearningOutcome({
    root, learningId: "learning:application-bound",
    ...outcome("outcome:application-before-b", "before", 0.5, "evaluator:baseline-b")
  });
  await evaluateLearning({ root });
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:application-bound",
    ...outcome("outcome:unbound-after", "after", 0.9, "evaluator:baseline-a")
  }), /precommitted first-admitted trial and completed delivery|recorded learning application receipt/);

  const firstApplication = await application(root, "learning:application-bound", "application-a");
  const retryApplications = await Promise.all(Array.from({ length: 6 }, () =>
    application(root, "learning:application-bound", "application-a")));
  assert.equal(retryApplications.every((item) => item.id === firstApplication.id), true,
    "parallel crash retries must reuse the immutable application receipt");
  assert.equal((await loadLearning(root)).learning.applications.length, 1);
  const crossTenantScope = { ...scopedTurn, tenantId: "tenant:other" };
  const now = new Date();
  await assert.rejects(recordLearningApplications({
    root, items: [{ id: "learning:application-bound", outcomeStatus: "active" }], scope: crossTenantScope,
    preflightReceipt: {
      schema: "agentspine.preflight/v2", id: "preflight:cross-tenant", status: "ready",
      sessionId: "session:cross-tenant",
      promptDigest: hash("prompt:cross-tenant"), briefingDigest: hash("preflight:cross-tenant"),
      agentId: crossTenantScope.personaId, userId: crossTenantScope.userId, tenantId: crossTenantScope.tenantId,
      projectId: crossTenantScope.projectId, groupId: crossTenantScope.groupId, taskId: crossTenantScope.taskId,
      createdAt: new Date(now.getTime() - 1000).toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString()
    },
    sessionBriefingDigest: hash("briefing:cross-tenant"), projectedAt: now
  }), /exact scope/);
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: firstApplication.id, deliveryId: firstApplication.deliveryId,
    ...outcome("outcome:application-after-a", "after", 0.8, "evaluator:baseline-a")
  })).decision, "active");
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: firstApplication.id, deliveryId: firstApplication.deliveryId,
    ...outcome("outcome:application-after-b-same-turn", "after", 0.8, "evaluator:baseline-b")
  }), /precommitted first-admitted trial and completed delivery|distinct completed turn/,
  "two evaluators of one turn must not simulate two applications");

  const secondApplication = await application(root, "learning:application-bound", "application-b");
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:application-bound", applicationId: secondApplication.id, deliveryId: secondApplication.deliveryId,
    ...outcome("outcome:application-after-b", "after", 0.8, "evaluator:baseline-b")
  })).decision, "validated");
});

test("UserPromptSubmit records the canary application only after the hard preflight is consumed", async (t) => {
  const { root, state } = await fixture(t);
  const hookScope = { ...scopedTurn, taskId: null };
  await writeFile(join(root, "CLAUDE.md"), "# Synthetic host rules\n\nKeep the fixed invariant.\n", "utf8");
  await upsertEntity({ root, id: scopedTurn.personaId, kind: "agent", displayName: "Synthetic Agent", privacy: "shared" });
  await proposeLearning({
    root, id: "learning:hook-application", kind: "behavior", claim: "Run the fixed invariant check.",
    privacy: "shared", scope: hookScope, evidence: evidence("evidence:hook-application-one", 0.98)
  });
  await addLearningEvidence({ root, id: "learning:hook-application", evidence: evidence("evidence:hook-application-two", 0.98) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  await evaluation(root, "learning:hook-application", { scope: hookScope,
    evaluatorIds: ["evaluator:hook-before-a", "evaluator:hook-before-b"] });
  await recordLearningOutcome({
    root, learningId: "learning:hook-application",
    ...outcome("outcome:hook-before-a", "before", 0.4, "evaluator:hook-before-a", { scope: hookScope })
  });
  await recordLearningOutcome({
    root, learningId: "learning:hook-application",
    ...outcome("outcome:hook-before-b", "before", 0.5, "evaluator:hook-before-b", { scope: hookScope })
  });
  await evaluateLearning({ root });
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = state;
  t.after(() => {
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
  });
  const hook = await runHook({
    hook_event_name: "UserPromptSubmit", host: "claude", cwd: root,
    session_id: "session:learning-application", event_id: "turn:learning-application",
    entity_id: scopedTurn.personaId, user_id: scopedTurn.userId, tenant_id: scopedTurn.tenantId,
    project_id: scopedTurn.projectId, prompt: "Run the synthetic task."
  });
  assert.equal(hook.blocked, false, hook.reason);
  const injected = JSON.parse(hook.context);
  assert.equal(injected.preflight.learningApplications.status, "recorded");
  assert.equal(injected.preflight.learningApplications.receipts[0].learningId, "learning:hook-application");
  assert.equal(injected.briefing.learning[0].id, "learning:hook-application");
  const persisted = (await loadLearning(root)).learning.applications;
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].preflightReceiptId, injected.preflight.receiptId);
  assert.equal(persisted[0].sessionId, "session:learning-application");
  assert.equal(JSON.stringify(persisted).includes("Run the synthetic task"), false);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:hook-application", applicationId: persisted[0].id,
    ...outcome("outcome:hook-undelivered", "after", 0.8, "evaluator:hook-before-a", { scope: hookScope })
  }), /precommitted first-admitted trial and completed delivery|completed model-turn delivery/);
  const crossSessionStop = await runHook({
    hook_event_name: "Stop", host: "claude", cwd: root, session_id: "session:other",
    entity_id: scopedTurn.personaId, user_id: scopedTurn.userId, tenant_id: scopedTurn.tenantId,
    project_id: scopedTurn.projectId
  });
  assert.equal(crossSessionStop.learningDelivery.status, "not-applicable");
  const stopped = await runHook({
    hook_event_name: "Stop", host: "claude", cwd: root, session_id: "session:learning-application",
    entity_id: scopedTurn.personaId, user_id: scopedTurn.userId, tenant_id: scopedTurn.tenantId,
    project_id: scopedTurn.projectId
  });
  assert.equal(stopped.learningDelivery.status, "completed");
  const delivery = stopped.learningDelivery.receipts[0];
  assert.equal(delivery.applicationId, persisted[0].id);
  assert.equal(JSON.stringify(delivery).includes("Run the synthetic task"), false);
  assert.equal((await recordLearningOutcome({
    root, learningId: "learning:hook-application", applicationId: persisted[0].id, deliveryId: delivery.id,
    ...outcome("outcome:hook-delivered", "after", 0.8, "evaluator:hook-before-a", { scope: hookScope })
  })).decision, "active");
  const pendingAt = new Date();
  await recordLearningApplications({
    root, items: [{ id: "learning:hook-application", outcomeStatus: "active" }], scope: hookScope,
    preflightReceipt: {
      schema: "agentspine.preflight/v2", id: "preflight:crash-pending", status: "ready",
      sessionId: "session:crash-pending", promptDigest: hash("prompt:crash-pending"),
      briefingDigest: hash("briefing:crash-pending"), agentId: hookScope.personaId,
      userId: hookScope.userId, tenantId: hookScope.tenantId, projectId: hookScope.projectId,
      groupId: hookScope.groupId, taskId: hookScope.taskId,
      createdAt: new Date(pendingAt.getTime() - 1000).toISOString(),
      expiresAt: new Date(pendingAt.getTime() + 60_000).toISOString()
    },
    sessionBriefingDigest: hash("session-briefing:crash-pending"), projectedAt: pendingAt
  });
  assert.equal((await learningOutcomeStatus({ root })).records[0].pendingApplications, 1);
  await assert.rejects(purgeStaleLearningApplications({ root, now: new Date(pendingAt.getTime() + 6 * 60_000) }),
    /explicit local confirmation/);
  const purged = await purgeStaleLearningApplications({ root, confirmation: "local-user-purge-confirmed",
    now: new Date(pendingAt.getTime() + 6 * 60_000) });
  assert.equal(purged.purged, 0, "a crashed initial admission remains immutable cohort evidence");
  assert.equal((await learningOutcomeStatus({ root, now: new Date(pendingAt.getTime() + 6 * 60_000) }))
    .records[0].stalePendingApplications, 1);
});

test("model suggestions cannot self-promote and contradictory behavior candidates remain blocked", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:model-only", kind: "behavior", claim: "Use synthetic strategy alpha.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:model-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:model-only", evidence: evidence("evidence:model-two", 0.97) });
  await proposeLearning({
    root, id: "learning:contradiction", kind: "behavior", claim: "Use synthetic strategy beta.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:contradiction-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:contradiction", evidence: evidence("evidence:contradiction-two", 0.97) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  for (const learningId of ["learning:model-only", "learning:contradiction"]) {
    const evaluationId = `evaluation:${learningId.split(":").at(-1)}`;
    await evaluation(root, learningId, { id: evaluationId,
      evaluatorIds: ["evaluator:model-a", "evaluator:model-b"] });
    await recordLearningOutcome({
      root, learningId, ...outcome(`outcome:${learningId}:a`, "before", 0.4, "evaluator:model-a",
        { kind: "model-suggestion", evaluationId })
    });
    await recordLearningOutcome({
      root, learningId, ...outcome(`outcome:${learningId}:b`, "before", 0.5, "evaluator:model-b",
        { kind: "model-suggestion", evaluationId })
    });
  }
  const protectedScope = { ...scopedTurn, taskId: "task:protected" };
  await proposeLearning({
    root, id: "learning:protected", kind: "behavior", claim: "Change the synthetic security policy.",
    privacy: "shared", scope: protectedScope, evidence: evidence("evidence:protected-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:protected", evidence: evidence("evidence:protected-two", 0.97) });
  await assert.rejects(evaluation(root, "learning:protected", { id: "evaluation:protected", scope: protectedScope }),
    /low-risk behavior candidates/);
  assert.equal((await evaluateLearning({ root })).accepted.length, 0);
  const status = await learningOutcomeStatus({ root });
  assert.deepEqual(status.records.find((item) => item.id === "learning:model-only").conflictsWith, ["learning:contradiction"]);
});

test("a blocking canary defect rolls back automatically and restores the superseded lesson", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:prior-behavior", kind: "behavior", claim: "Use the stable synthetic path.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:prior")
  });
  await reviewLearning({ root, id: "learning:prior-behavior", decision: "accept", reason: "Confirmed locally.", confirmedByUser: true });
  await proposeLearning({
    root, id: "learning:new-behavior", kind: "behavior", claim: "Use the candidate synthetic path.",
    privacy: "shared", scope: scopedTurn, supersedesId: "learning:prior-behavior",
    evidence: evidence("evidence:new-one", 0.98)
  });
  await addLearningEvidence({ root, id: "learning:new-behavior", evidence: evidence("evidence:new-two", 0.98) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  await evaluation(root, "learning:new-behavior");
  await recordLearningOutcome({ root, learningId: "learning:new-behavior", ...outcome("outcome:new-before-a", "before", 0.4, "evaluator:test-a") });
  await recordLearningOutcome({ root, learningId: "learning:new-behavior", ...outcome("outcome:new-before-b", "before", 0.5, "evaluator:test-b") });
  await evaluateLearning({ root });
  const applied = await application(root, "learning:new-behavior", "blocking");
  const regressed = await recordLearningOutcome({
    root, learningId: "learning:new-behavior", applicationId: applied.id, deliveryId: applied.deliveryId,
    ...outcome("outcome:new-after-blocking", "after", 0.9, "evaluator:test-a", { blockingDefects: 1 })
  });
  assert.equal(regressed.decision, "rolled-back");
  assert.deepEqual(regressed.restored, ["learning:prior-behavior"]);
  assert.deepEqual((await learningContext({ root, scope: scopedTurn })).items.map((item) => item.id), ["learning:prior-behavior"]);
});

test("stale canaries degrade context and evaluation rolls them back", async (t) => {
  const { root } = await fixture(t);
  const start = new Date("2026-01-01T00:00:00.000Z");
  await proposeLearning({
    root, id: "learning:stale", kind: "behavior", claim: "Use the temporary synthetic strategy.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:stale-one", 0.96), now: start
  });
  await addLearningEvidence({ root, id: "learning:stale", evidence: evidence("evidence:stale-two", 0.96), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2, canaryTtlDays: 1 }, now: start });
  await evaluation(root, "learning:stale", { now: start, expiresAt: new Date("2026-02-01T00:00:00.000Z") });
  await recordLearningOutcome({ root, learningId: "learning:stale", ...outcome("outcome:stale-a", "before", 0.4, "evaluator:test-a", { measuredAt: start }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:stale", ...outcome("outcome:stale-b", "before", 0.5, "evaluator:test-b", { measuredAt: start }), now: start });
  await evaluateLearning({ root, now: start });
  const later = new Date("2026-01-03T00:00:00.000Z");
  const context = await learningContext({ root, scope: scopedTurn, now: later });
  assert.equal(context.items.length, 0);
  assert.equal(context.degraded, true);
  assert.deepEqual((await evaluateLearning({ root, now: later })).reconciled, [{ id: "learning:stale", decision: "rolled-back" }]);
});

test("parallel duplicate outcome receipts are idempotent and remain one immutable measurement", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:outcome-race", kind: "behavior", claim: "Use one synthetic race-safe action.",
    scope: scopedTurn, evidence: evidence("evidence:race-one")
  });
  await addLearningEvidence({ root, id: "learning:outcome-race", evidence: evidence("evidence:race-two") });
  await evaluation(root, "learning:outcome-race", {
    evaluatorIds: ["evaluator:test-race", "evaluator:test-a"]
  });
  const input = { root, learningId: "learning:outcome-race", ...outcome("outcome:race", "before", 0.4, "evaluator:test-race") };
  const results = await Promise.all(Array.from({ length: 6 }, () => recordLearningOutcome(input)));
  assert.equal(results.filter((item) => item.unchanged === false).length, 1);
  assert.equal((await loadLearning(root)).learning.outcomes.length, 1);
});
