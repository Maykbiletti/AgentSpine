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

test("validation revocation withdraws an exact decision through its immutable renewal chain", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2041-01-01T00:00:00.000Z");
  await upsertEntity({ root, id: "person:validation-member", kind: "person", privacy: "shared" });
  await proposeLearning({ root, id: "learning:validation-prior", kind: "behavior",
    claim: "Use the prior synthetic validation procedure.", subjectId: "person:validation-member",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:validation-prior", 0.97), now: start });
  await reviewLearning({ root, id: "learning:validation-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await establishValidatedLearning(root, {
    learningId: "learning:validation-current", evaluationId: "evaluation:validation-current", start,
    expiresAt: "2041-03-01T00:00:00.000Z", supersedesId: "learning:validation-prior",
    subjectId: "person:validation-member"
  });
  const initial = (await loadLearning(root)).learning.validationLeases[0];
  const renewalAt = new Date("2041-01-20T00:00:00.000Z");
  const window = await beginLearningRevalidation({ root, learningId: "learning:validation-current",
    confirmLocalValidation: true, now: renewalAt });
  const bindings = [];
  for (const [index, evaluatorId, value] of [[0, "evaluator:test-a", 0.84], [1, "evaluator:test-b", 0.89]]) {
    const at = new Date(renewalAt.getTime() + 1000 + index);
    const delivered = await application(root, "learning:validation-current", `validation-refresh-${index}`, at, "revalidating");
    const trial = window.revalidation.selection.evaluatorRoots[index];
    const measurement = (await recordLearningMeasurement({
      root, id: `measurement:validation-refresh-${index}`, learningId: "learning:validation-current",
      evaluationId: "evaluation:validation-current", phase: "after", scope: scopedTurn,
      metric: { name: "fixed-task-success", direction: "higher", value, blockingDefects: 0 },
      measurement: { kind: "objective", evaluatorId, runId: trial.runId,
        sourceDigest: hash(`validation-refresh-source-${index}`) },
      coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: new Date(at.getTime() + 1),
      confirmLocalMeasurement: true, now: new Date(at.getTime() + 1)
    })).receipt;
    bindings.push({ measurementId: measurement.id, applicationId: delivered.id, deliveryId: delivered.deliveryId });
  }
  const renewed = await renewLearningValidation({ root, learningId: "learning:validation-current", evidence: bindings,
    confirmLocalValidation: true, now: new Date(renewalAt.getTime() + 5000) });
  assert.equal(renewed.lease.predecessorValidation.digest, initial.digest);
  await assert.rejects(revokeLearningValidation({ root, validationLeaseId: initial.id,
    reasonCode: "decision-invalid", reason: "Synthetic validation decision invalidated." }), /explicit local confirmation/);
  const input = { root, validationLeaseId: initial.id, reasonCode: "decision-invalid",
    reason: "Synthetic validation decision invalidated.", confirmation: "local-validation-revocation-confirmed",
    now: new Date(renewalAt.getTime() + 6000) };
  const attempts = await Promise.all(Array.from({ length: 6 }, () => revokeLearningValidation(input)));
  assert.equal(attempts.filter((result) => result.unchanged === false).length, 1);
  assert.equal((await revokeLearningValidation({ ...input, now: new Date(renewalAt.getTime() + 7000) })).unchanged, true);
  await assert.rejects(revokeLearningValidation({ ...input, reasonCode: "scope-invalid",
    reason: "Synthetic conflicting reason." }), /immutable/);
  const stored = await loadLearning(root);
  const receipt = stored.learning.validationRevocations[0];
  const contract = stored.learning.evaluations.find((item) => item.id === "evaluation:validation-current");
  const binding = stored.learning.evaluationBindings.find((item) => item.evaluationId === contract.id);
  assert.equal(receipt.validationLeaseDigest, initial.digest);
  assert.equal(receipt.evaluationDigest, contract.digest);
  assert.equal(receipt.evaluatorBindingDigest, binding.digest);
  assert.equal(receipt.targetDigest, contract.target.digest);
  assert.equal(JSON.stringify(receipt).includes("Synthetic validation decision invalidated"), false);
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date(renewalAt.getTime() + 8000) })).diagnostics,
  ["revoked-learning-validation:learning:validation-current"]);
  assert.deepEqual((await learningContext({ root, scope: { ...scopedTurn, projectId: "project:foreign" },
    now: new Date(renewalAt.getTime() + 8000) })).diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn, now: new Date(renewalAt.getTime() + 8000) });
  assert.equal(status.validationRevocations, 1);
  assert.equal(status.records.find((item) => item.id === "learning:validation-current").canaryStatus,
    "revoked-validation");
  assert.equal((await learningOutcomeStatus({ root, scope: { ...scopedTurn, projectId: "project:foreign" },
    now: new Date(renewalAt.getTime() + 8000) })).validationRevocations, 0);
  const cli = runCli(["learn-validation-revoke", initial.id, "--root", root,
    "--reason-code", "decision-invalid", "--reason", "Synthetic validation decision invalidated.",
    "--confirm-local-validation-revocation", "--json"], state);
  assert.equal(cli.receipt.schema, "agentspine.learning-validation-revocation/v1");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.status, "degraded");
  assert.equal(doctor.learningOutcomes.validationRevocationReceipts, 1);
  await assert.rejects(beginLearningRevalidation({ root, learningId: "learning:validation-current",
    confirmLocalValidation: true, now: new Date(renewalAt.getTime() + 9000) }), /current registry-bound validation lease/);
  const originalState = JSON.stringify(stored.learning);
  stored.learning.validationRevocations[0].validationLeaseDigest = hash("redirected validation");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /validation revocation state is invalid/);
  await writeFile(stored.learningPath, `${originalState}\n`, "utf8");
  const reconciliations = await Promise.all(Array.from({ length: 6 }, () =>
    evaluateLearning({ root, now: new Date(renewalAt.getTime() + 10000) })));
  assert.equal(reconciliations.flatMap((result) => result.reconciled)
    .filter((item) => item.id === "learning:validation-current" && item.decision === "rolled-back").length, 1);
  const finalState = (await loadLearning(root)).learning;
  assert.equal(finalState.candidates.find((item) => item.id === "learning:validation-current").rollback.mode,
    "automatic-validation-revocation");
  assert.equal(finalState.outcomes.length, stored.learning.outcomes.length,
    "validation revocation must not mutate its underlying outcomes");
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date(renewalAt.getTime() + 11000) })).items.map((item) => item.id), ["learning:validation-prior"]);
  await deleteLearning({ root, id: "learning:validation-current" });
  const deletedState = (await loadLearning(root)).learning;
  assert.equal(deletedState.validationRevocations.length, 0);
  assert.equal(deletedState.history.some((entry) => entry.value?.learningId === "learning:validation-current"), false,
    "candidate purge must also remove historical validation decisions");
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:validation-member" })).deleted, 1);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("outcome revocation withdraws only the exact result and rolls back its validation lineage", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2040-01-01T00:00:00.000Z");
  await upsertEntity({ root, id: "person:outcome-member", kind: "person", privacy: "shared" });
  await proposeLearning({
    root, id: "learning:outcome-prior", kind: "behavior", claim: "Use the prior synthetic outcome procedure.",
    subjectId: "person:outcome-member", privacy: "shared", scope: scopedTurn,
    evidence: evidence("evidence:outcome-prior", 0.97), now: start
  });
  await reviewLearning({ root, id: "learning:outcome-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await establishValidatedLearning(root, {
    learningId: "learning:outcome-current", evaluationId: "evaluation:outcome-current", start,
    expiresAt: "2040-03-01T00:00:00.000Z", supersedesId: "learning:outcome-prior",
    subjectId: "person:outcome-member"
  });
  const beforeRevocation = (await loadLearning(root)).learning;
  const candidate = beforeRevocation.candidates.find((item) => item.id === "learning:outcome-current");
  const outcomeId = candidate.promotion.canary.afterReceipts[0];
  const outcomeReceipt = beforeRevocation.outcomes.find((item) => item.id === outcomeId);
  await assert.rejects(revokeLearningOutcome({ root, outcomeId, reasonCode: "binding-invalid",
    reason: "Synthetic outcome binding invalidated." }), /explicit local confirmation/);
  const input = { root, outcomeId, reasonCode: "binding-invalid",
    reason: "Synthetic outcome binding invalidated.", confirmation: "local-outcome-revocation-confirmed", now: start };
  const attempts = await Promise.all(Array.from({ length: 6 }, () => revokeLearningOutcome(input)));
  assert.equal(attempts.filter((result) => result.unchanged === false).length, 1);
  assert.equal((await revokeLearningOutcome({ ...input, now: new Date(start.getTime() + 4000) })).unchanged, true);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.outcomeRevocations.length, 1);
  assert.equal(stored.learning.measurementRevocations.length, 0,
    "withdrawing an outcome must not over-revoke its immutable measurement");
  assert.equal(JSON.stringify(stored.learning.outcomeRevocations).includes("Synthetic outcome binding invalidated"), false);
  const receipt = stored.learning.outcomeRevocations[0];
  assert.equal(receipt.outcomeDigest, outcomeReceipt.digest);
  assert.equal(receipt.measurementDigest, stored.learning.measurements
    .find((item) => item.id === outcomeReceipt.measurementReceiptId).digest);
  assert.equal(receipt.applicationDigest, stored.learning.applications
    .find((item) => item.id === outcomeReceipt.applicationId).digest);
  assert.equal(receipt.deliveryDigest, stored.learning.deliveries
    .find((item) => item.id === outcomeReceipt.deliveryId).digest);

  const withheld = await learningContext({ root, scope: scopedTurn, now: new Date(start.getTime() + 5000) });
  assert.deepEqual(withheld.items, []);
  assert.deepEqual(withheld.diagnostics, ["revoked-learning-outcome:learning:outcome-current"]);
  const foreign = await learningContext({ root, scope: { ...scopedTurn, projectId: "project:foreign" },
    now: new Date(start.getTime() + 5000) });
  assert.deepEqual(foreign.items, []);
  assert.deepEqual(foreign.diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn, now: new Date(start.getTime() + 5000) });
  assert.equal(status.outcomeRevocations, 1);
  assert.equal(status.records.find((item) => item.id === "learning:outcome-current").canaryStatus, "revoked-outcome");
  assert.equal((await learningOutcomeStatus({ root, scope: { ...scopedTurn, projectId: "project:foreign" },
    now: new Date(start.getTime() + 5000) })).outcomeRevocations, 0);
  const cli = runCli(["learn-outcome-revoke", outcomeId, "--root", root, "--reason-code", "binding-invalid",
    "--reason", "Synthetic outcome binding invalidated.", "--confirm-local-outcome-revocation", "--json"], state);
  assert.equal(cli.receipt.schema, "agentspine.learning-outcome-revocation/v1");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.status, "degraded");
  assert.equal(doctor.learningOutcomes.outcomeRevocationReceipts, 1);
  await assert.rejects(commitLearningOutcome({ root, id: outcomeId, learningId: "learning:outcome-current",
    evaluationId: "evaluation:outcome-current", measurementReceiptId: outcomeReceipt.measurementReceiptId,
    applicationId: outcomeReceipt.applicationId, deliveryId: outcomeReceipt.deliveryId,
    now: new Date(start.getTime() + 5000) }), /outcome was explicitly revoked/);

  const originalState = JSON.stringify(stored.learning);
  stored.learning.outcomeRevocations[0].outcomeDigest = hash("redirected outcome");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /outcome revocation state is invalid/);
  await writeFile(stored.learningPath, `${originalState}\n`, "utf8");
  const reconciliations = await Promise.all(Array.from({ length: 6 }, () =>
    evaluateLearning({ root, now: new Date(start.getTime() + 6000) })));
  assert.equal(reconciliations.flatMap((result) => result.reconciled)
    .filter((item) => item.id === "learning:outcome-current" && item.decision === "rolled-back").length, 1);
  const rolledBack = (await loadLearning(root)).learning.candidates
    .find((item) => item.id === "learning:outcome-current");
  assert.equal(rolledBack.rollback.mode, "automatic-outcome-revocation");
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 7000) })).items.map((item) => item.id), ["learning:outcome-prior"]);
  await deleteLearning({ root, id: "learning:outcome-current" });
  assert.equal((await loadLearning(root)).learning.outcomeRevocations.length, 0);
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:outcome-member" })).deleted, 1);

  await proposeLearning({ root, id: "learning:outcome-active", kind: "behavior",
    claim: "Use the active synthetic outcome procedure.", privacy: "shared", scope: scopedTurn,
    evidence: evidence("evidence:outcome-active-one", 0.97), now: start });
  await addLearningEvidence({ root, id: "learning:outcome-active",
    evidence: evidence("evidence:outcome-active-two", 0.97), now: start });
  await evaluation(root, "learning:outcome-active", { id: "evaluation:outcome-active",
    evaluatorIds: ["evaluator:test-a", "evaluator:test-b"], now: start,
    expiresAt: "2040-03-01T00:00:00.000Z" });
  for (const [suffix, evaluatorId, value] of [["a", "evaluator:test-a", 0.4], ["b", "evaluator:test-b", 0.5]]) {
    await recordLearningOutcome({ root, learningId: "learning:outcome-active",
      ...outcome(`outcome:active-before-${suffix}`, "before", value, evaluatorId,
        { evaluationId: "evaluation:outcome-active", measuredAt: start }), now: start });
  }
  await evaluateLearning({ root, now: new Date(start.getTime() + 8000) });
  const activeApplication = await application(root, "learning:outcome-active", "outcome-active-a",
    new Date(start.getTime() + 9000));
  await recordLearningOutcome({ root, learningId: "learning:outcome-active", applicationId: activeApplication.id,
    deliveryId: activeApplication.deliveryId,
    ...outcome("outcome:active-after-a", "after", 0.8, "evaluator:test-a",
      { evaluationId: "evaluation:outcome-active", measuredAt: new Date(start.getTime() + 9000) }),
    now: new Date(start.getTime() + 9000) });
  await revokeLearningOutcome({ root, outcomeId: "outcome:active-after-a", reasonCode: "phase-invalid",
    reason: "Synthetic active outcome phase invalidated.", confirmation: "local-outcome-revocation-confirmed",
    now: new Date(start.getTime() + 10000) });
  const activeWithheld = await learningContext({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 11000) });
  assert.deepEqual(activeWithheld.items, []);
  assert.deepEqual(activeWithheld.diagnostics, ["revoked-learning-outcome:learning:outcome-active"]);
  await deleteLearning({ root, id: "learning:outcome-active" });
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("immutable evaluation contracts prevent benchmark drift and freeze promotion thresholds", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  await proposeLearning({
    root, id: "learning:planned", kind: "behavior", claim: "Use the measured synthetic strategy.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:planned-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:planned", evidence: evidence("evidence:planned-two", 0.97) });
  await configureLearning({
    root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2, minImprovement: 0.2,
      minOutcomeReceipts: 2, canaryReceipts: 2 }
  });
  const registeredAt = new Date();
  const expiresAt = new Date(registeredAt.getTime() + 7 * 86400000);
  await assert.rejects(registerLearningEvaluation({
    root, id: "evaluation:planned", learningId: "learning:planned", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher" },
    benchmark: { taskDigest: hash("fixed task"), datasetDigest: hash("fixed data"), protocolDigest: hash("fixed protocol"), minCases: 10 },
    evaluatorIds: syntheticEvaluators, evaluatorRoots: evaluatorRoots(), expiresAt, now: registeredAt
  }), /explicit local confirmation/);
  const registered = await evaluation(root, "learning:planned", {
    id: "evaluation:planned", now: registeredAt, expiresAt
  });
  assert.equal(registered.contract.thresholds.minImprovement, 0.2);
  assert.equal(JSON.stringify(registered.contract).includes("fixed task"), false);
  await assert.rejects(registerLearningEvaluation({
    root, id: "evaluation:planned", learningId: "learning:planned", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher" },
    benchmark: { taskDigest: hash("changed task"), datasetDigest: hash("fixed data"), protocolDigest: hash("fixed protocol"), minCases: 10 },
    evaluatorIds: syntheticEvaluators, evaluatorRoots: evaluatorRoots(), expiresAt, now: registeredAt,
    confirmLocalEvaluation: true, confirmLocalEvidenceSources: true
  }), /immutable/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:planned",
    ...outcome("outcome:wrong-evaluator", "before", 0.4, "evaluator:not-listed", { evaluationId: "evaluation:planned" })
  }), /matching immutable measurement receipt|not allowed/);
  await configureLearning({ root, config: { minImprovement: 0 } });
  await recordLearningOutcome({ root, learningId: "learning:planned",
    ...outcome("outcome:planned-before-a", "before", 0.4, "evaluator:test-a", { evaluationId: "evaluation:planned" }) });
  await recordLearningOutcome({ root, learningId: "learning:planned",
    ...outcome("outcome:planned-before-b", "before", 0.5, "evaluator:test-b", { evaluationId: "evaluation:planned" }) });
  const promoted = await evaluateLearning({ root });
  assert.equal(promoted.accepted[0].promotion.canary.evaluationId, "evaluation:planned");
  const { learning: plannedState, learningPath } = await loadLearning(root);
  const preservedState = JSON.stringify(plannedState);
  await writeFile(learningPath, `${JSON.stringify({ ...plannedState, evaluations: [] })}\n`, "utf8");
  await assert.rejects(loadLearning(root), /binding.*invalid/);
  await writeFile(learningPath, `${preservedState}\n`, "utf8");
  const applicationA = await application(root, "learning:planned", "planned-a");
  await recordLearningOutcome({ root, learningId: "learning:planned", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:planned-after-a", "after", 0.55, "evaluator:test-a", { evaluationId: "evaluation:planned" }) });
  const applicationB = await application(root, "learning:planned", "planned-b");
  const result = await recordLearningOutcome({ root, learningId: "learning:planned", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:planned-after-b", "after", 0.56, "evaluator:test-b", { evaluationId: "evaluation:planned" }) });
  assert.equal(result.decision, "rolled-back", "later config changes must not weaken the registered threshold");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("staleness policy freezes outcome freshness and Canary lifetime across config drift", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2036-01-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:staleness-alpha", taskId: "task:staleness" };
  const canaryScope = { ...alphaScope, taskId: "task:staleness-canary" };
  const betaScope = { ...canaryScope, groupId: "group:staleness-beta" };
  await upsertEntity({ root, id: alphaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: betaScope.groupId, kind: "group", privacy: "shared" });
  await configureLearning({ root, config: {
    autoPromote: true, minConfidence: 0.9, minEvidence: 2, minOutcomeReceipts: 2,
    canaryReceipts: 2, outcomeMaxAgeDays: 1, canaryTtlDays: 2
  }, now: start });
  await proposeLearning({
    root, id: "learning:staleness-old", kind: "behavior", claim: "Use the measured synthetic old-window strategy.",
    privacy: "group", groupId: alphaScope.groupId, scope: alphaScope,
    evidence: evidence("evidence:staleness-old-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:staleness-old",
    evidence: evidence("evidence:staleness-old-two", 0.97), now: start });
  const staleContract = await evaluation(root, "learning:staleness-old", {
    id: "evaluation:staleness-old", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2036-01-20T00:00:00.000Z"
  });
  assert.equal(staleContract.contract.schema, "agentspine.learning-evaluation/v28");
  assert.deepEqual(staleContract.contract.stalenessPolicy, {
    schema: "agentspine.learning-staleness-policy/v1",
    outcomeMaxAgeDays: 1,
    canaryTtlDays: 2,
    staleOutcome: "ineligible",
    expiredCanary: "automatic-rollback",
    authority: "context-only",
    digest: staleContract.contract.stalenessPolicy.digest
  });
  await recordLearningOutcome({ root, learningId: "learning:staleness-old",
    ...outcome("outcome:staleness-old-a", "before", 0.4, "evaluator:test-a", {
      evaluationId: staleContract.contract.id, scope: alphaScope, measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:staleness-old",
    ...outcome("outcome:staleness-old-b", "before", 0.5, "evaluator:test-b", {
      evaluationId: staleContract.contract.id, scope: alphaScope, measuredAt: start
    }), now: start });
  await configureLearning({ root, config: { outcomeMaxAgeDays: 30, canaryTtlDays: 90 },
    now: new Date(start.getTime() + 60_000) });
  const staleEvaluation = await evaluateLearning({ root, now: new Date(start.getTime() + 3 * 86400000) });
  assert.deepEqual(staleEvaluation.accepted, [], "a mutable wider window must not resurrect old evidence");

  const canaryStart = new Date(start.getTime() + 4 * 86400000);
  await proposeLearning({
    root, id: "learning:staleness-canary", kind: "behavior",
    claim: "Use the measured synthetic fixed-window strategy.",
    privacy: "group", groupId: canaryScope.groupId, scope: canaryScope,
    evidence: evidence("evidence:staleness-canary-one", 0.97), now: canaryStart
  });
  await addLearningEvidence({ root, id: "learning:staleness-canary",
    evidence: evidence("evidence:staleness-canary-two", 0.97), now: canaryStart });
  await configureLearning({ root, config: { outcomeMaxAgeDays: 30, canaryTtlDays: 2 }, now: canaryStart });
  const canaryContract = await evaluation(root, "learning:staleness-canary", {
    id: "evaluation:staleness-canary", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: canaryScope, now: canaryStart, expiresAt: "2036-01-20T00:00:00.000Z"
  });
  await configureLearning({ root, config: { canaryTtlDays: 90 }, now: new Date(canaryStart.getTime() + 60_000) });
  for (const [suffix, evaluatorId, value] of [["a", "evaluator:test-a", 0.4], ["b", "evaluator:test-b", 0.5]]) {
    await recordLearningOutcome({ root, learningId: "learning:staleness-canary",
      ...outcome(`outcome:staleness-canary-${suffix}`, "before", value, evaluatorId, {
        evaluationId: canaryContract.contract.id, scope: canaryScope, measuredAt: canaryStart
      }), now: canaryStart });
  }
  const promotedAt = new Date(canaryStart.getTime() + 120_000);
  const promoted = await evaluateLearning({ root, now: promotedAt });
  const promotedCandidate = promoted.accepted.find((entry) => entry.id === "learning:staleness-canary");
  assert.ok(promotedCandidate, JSON.stringify(promoted));
  const canary = promotedCandidate.promotion.canary;
  assert.equal(canary.expiresAt, new Date(promotedAt.getTime() + 2 * 86400000).toISOString());
  assert.equal(canary.stalenessPolicyDigest, canaryContract.contract.stalenessPolicy.digest);
  const status = await learningOutcomeStatus({ root, scope: canaryScope, now: promotedAt });
  assert.equal(status.stalenessBoundEvaluationContracts, 1);
  assert.equal(status.records.find((entry) => entry.id === "learning:staleness-canary")
    .activeStalenessPolicyDigest, canaryContract.contract.stalenessPolicy.digest);
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.stalenessBoundEvaluationContracts, 2);
  const audit = runCli(["audit", root, "--json"], state);
  assert.equal(audit.ok, true);
  assert.match(audit.gates.find((gate) => gate.name === "Context privacy").detail,
    /2 staleness-bound contracts/);
  const foreignStatus = await learningOutcomeStatus({ root, scope: betaScope, now: promotedAt });
  assert.equal(foreignStatus.stalenessBoundEvaluationContracts, 0);
  assert.deepEqual(foreignStatus.records, []);
  assert.deepEqual(foreignStatus.evaluatorRegistry,
    { active: 0, revoked: 0, bindings: 0, validationLeases: 0, authority: "context-only" });
  const saved = await loadLearning(root);
  const tampered = saved.learning.evaluations.find((entry) => entry.id === canaryContract.contract.id);
  tampered.stalenessPolicy.canaryTtlDays = 90;
  await writeFile(saved.learningPath, `${JSON.stringify(saved.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning evaluation state is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
