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

test("measurement lineage blocks cross-contract reuse and purges only stale unconsumed runs", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2026-01-01T00:00:00.000Z");
  for (const suffix of ["one", "two"]) {
    await proposeLearning({
      root, id: `learning:lineage-${suffix}`, kind: "behavior", claim: `Use synthetic strategy ${suffix}.`,
      scope: scopedTurn, evidence: evidence(`evidence:lineage-${suffix}-one`), now: start
    });
    await addLearningEvidence({ root, id: `learning:lineage-${suffix}`,
      evidence: evidence(`evidence:lineage-${suffix}-two`), now: start });
    await evaluation(root, `learning:lineage-${suffix}`, {
      id: `evaluation:lineage-${suffix}`, now: start,
      expiresAt: "2026-01-10T00:00:00.000Z"
    });
  }
  const lineageContracts = (await loadLearning(root)).learning.evaluations;
  const initialRun = (evaluationId, evaluatorId) => lineageContracts.find((entry) => entry.id === evaluationId)
    .initialTrials.before.find((entry) => entry.evaluatorId === evaluatorId).runId;
  const sharedSource = hash("one immutable provider run manifest");
  await recordLearningMeasurement({
    root, id: "measurement:lineage-one", learningId: "learning:lineage-one", evaluationId: "evaluation:lineage-one",
    phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.4, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a",
      runId: initialRun("evaluation:lineage-one", "evaluator:test-a"), sourceDigest: sharedSource },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start
  });
  const validState = await loadLearning(root);
  const originalMeasurement = validState.learning.measurements[0];
  const { digest: _originalDigest, ...injectedPayload } = originalMeasurement;
  const injectedMeasurement = {
    ...injectedPayload,
    id: "measurement:lineage-injected",
    measurement: { ...injectedPayload.measurement, runId: "run:lineage-injected" }
  };
  validState.learning.measurements.push({
    ...injectedMeasurement,
    digest: hash(JSON.stringify(injectedMeasurement))
  });
  const originalLineage = validState.learning.measurementLineage[0];
  const { digest: _lineageDigest, ...injectedLineagePayload } = originalLineage;
  const injectedLineage = {
    ...injectedLineagePayload,
    measurementReceiptId: "measurement:lineage-injected",
    runDigest: hash(JSON.stringify(["evaluator:test-a", "run:lineage-injected"]))
  };
  validState.learning.measurementLineage.push({
    ...injectedLineage,
    digest: hash(JSON.stringify(injectedLineage))
  });
  await writeFile(validState.learningPath, `${JSON.stringify(validState.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /initial trial measurement binding is invalid|measurement lineage is replayed/);
  validState.learning.measurements.pop();
  validState.learning.measurementLineage.pop();
  await writeFile(validState.learningPath, `${JSON.stringify(validState.learning)}\n`, "utf8");
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:lineage-two", learningId: "learning:lineage-two", evaluationId: "evaluation:lineage-two",
    phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-b",
      runId: initialRun("evaluation:lineage-two", "evaluator:test-b"), sourceDigest: sharedSource },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start
  }), /cannot be reused across evaluation contracts/);
  await assert.rejects(purgeStaleLearningMeasurements({ root }), /explicit local confirmation/);
  const purged = await purgeStaleLearningMeasurements({
    root, confirmation: "local-user-purge-confirmed", now: new Date("2026-03-01T00:00:00.000Z")
  });
  assert.deepEqual(purged.measurementReceiptIds, ["measurement:lineage-one"]);
  const purgedState = (await loadLearning(root)).learning;
  assert.equal(purgedState.measurements.length, 0);
  assert.equal(purgedState.measurementLineage.length, 1, "content-free replay tombstones survive receipt purge");
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:lineage-reuse-after-purge", learningId: "learning:lineage-two",
    evaluationId: "evaluation:lineage-two", phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-b",
      runId: initialRun("evaluation:lineage-two", "evaluator:test-b"), sourceDigest: sharedSource },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start
  }), /cannot be reused across evaluation contracts/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("evaluator roots prevent alias independence and bind measurements fail closed", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2026-01-01T00:00:00.000Z");
  const sharedRoot = hash("one synthetic evaluator principal");
  for (const suffix of ["primary", "alias"]) {
    await proposeLearning({
      root, id: `learning:root-${suffix}`, kind: "behavior", claim: `Use root-bound strategy ${suffix}.`,
      scope: scopedTurn, evidence: evidence(`evidence:root-${suffix}-one`), now: start
    });
    await addLearningEvidence({ root, id: `learning:root-${suffix}`,
      evidence: evidence(`evidence:root-${suffix}-two`), now: start });
  }
  await assert.rejects(registerLearningEvaluator({
    root, id: "evaluator:root-a", principalDigest: sharedRoot, now: start
  }), /explicit local confirmation/);
  await registerLearningEvaluator({
    root, id: "evaluator:root-a", principalDigest: sharedRoot, confirmLocalEvaluator: true, now: start
  });
  await assert.rejects(registerLearningEvaluator({
    root, id: "evaluator:root-alias", principalDigest: sharedRoot, confirmLocalEvaluator: true, now: start
  }), /IDs and principal roots are immutable/);
  const primary = await evaluation(root, "learning:root-primary", {
    id: "evaluation:root-primary", evaluatorIds: ["evaluator:root-a", "evaluator:root-b"],
    evaluatorRoots: [
      { evaluatorId: "evaluator:root-a", principalDigest: sharedRoot },
      { evaluatorId: "evaluator:root-b", principalDigest: hash("second synthetic evaluator principal") }
    ], now: start, expiresAt: "2026-01-10T00:00:00.000Z"
  });
  assert.equal(primary.contract.schema, "agentspine.learning-evaluation/v28");
  assert.equal(primary.binding.schema, "agentspine.learning-evaluator-binding/v1");
  assert.equal(primary.binding.evaluationDigest, primary.contract.digest);
  assert.deepEqual(primary.contract.evaluatorRoots[0], {
    evaluatorId: "evaluator:root-a", principalDigest: sharedRoot, authority: "context-only"
  });
  const first = await recordLearningMeasurement({
    root, id: "measurement:root-primary", learningId: "learning:root-primary",
    evaluationId: "evaluation:root-primary", phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.4, blockingDefects: 0 },
    measurement: {
      kind: "objective", evaluatorId: "evaluator:root-a",
      runId: primary.contract.initialTrials.before[0].runId,
      sourceDigest: hash("root-primary-source")
    },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: start, confirmLocalMeasurement: true, now: start
  });
  assert.equal(first.receipt.schema, "agentspine.learning-measurement/v2");
  assert.equal(first.receipt.measurement.evaluatorRootDigest, sharedRoot);
  assert.equal(first.lineage.schema, "agentspine.learning-measurement-lineage/v2");
  assert.equal(first.lineage.evaluatorRootDigest, sharedRoot);
  assert.equal(first.lineage.rootRunDigest,
    hash(JSON.stringify([sharedRoot, primary.contract.initialTrials.before[0].runId])));
  const committed = await commitLearningOutcome({
    root, id: "outcome:root-primary", learningId: "learning:root-primary",
    evaluationId: "evaluation:root-primary", measurementReceiptId: first.receipt.id
  });
  assert.equal(committed.receipt.schema, "agentspine.learning-outcome/v9");
  assert.equal(committed.receipt.measurement.evaluatorRootDigest, sharedRoot);
  await revokeLearningEvaluator({ root, id: "evaluator:root-a", reason: "Synthetic evaluator retired.",
    confirmLocalEvaluator: true, now: new Date("2026-01-01T00:00:01.000Z") });
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:root-after-revoke", learningId: "learning:root-primary",
    evaluationId: "evaluation:root-primary", phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: {
      kind: "objective", evaluatorId: "evaluator:root-b", runId: "run:after-revoke",
      sourceDigest: hash("root-after-revoke-source")
    },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: start, confirmLocalMeasurement: true, now: start
  }), /registry binding is missing, changed, or revoked/);

  const stored = await loadLearning(root);
  const contract = stored.learning.evaluations.find((item) => item.id === "evaluation:root-primary");
  const { digest: _contractDigest, ...contractPayload } = contract;
  const tamperedPayload = {
    ...contractPayload,
    evaluatorRoots: contractPayload.evaluatorRoots.map((item) => item.evaluatorId === "evaluator:root-a"
      ? { ...item, principalDigest: hash("tampered root") } : item)
  };
  stored.learning.evaluations = stored.learning.evaluations.map((item) => item.id === contract.id
    ? { ...tamperedPayload, digest: hash(JSON.stringify(tamperedPayload)) } : item);
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evaluation state is invalid|evaluator binding state is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("local evaluator revocation removes canary context and forces automatic rollback", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2032-01-01T00:00:00.000Z");
  await proposeLearning({
    root, id: "learning:revoked-evaluator", kind: "behavior", claim: "Use the registry-bound synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:registry-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:revoked-evaluator",
    evidence: evidence("evidence:registry-two", 0.97), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2,
    minOutcomeReceipts: 2, canaryReceipts: 2 }, now: start });
  await evaluation(root, "learning:revoked-evaluator", {
    id: "evaluation:revoked-evaluator", evaluatorIds: ["evaluator:registry-a", "evaluator:registry-b"],
    now: start, expiresAt: "2032-01-10T00:00:00.000Z"
  });
  await recordLearningOutcome({ root, learningId: "learning:revoked-evaluator",
    ...outcome("outcome:registry-before-a", "before", 0.4, "evaluator:registry-a", {
      evaluationId: "evaluation:revoked-evaluator", measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:revoked-evaluator",
    ...outcome("outcome:registry-before-b", "before", 0.5, "evaluator:registry-b", {
      evaluationId: "evaluation:revoked-evaluator", measuredAt: start
    }), now: start });
  const promotedAt = new Date("2032-01-01T00:00:01.000Z");
  const promoted = await evaluateLearning({ root, now: promotedAt });
  assert.equal(promoted.accepted[0].promotion.canary.status, "active");
  await revokeLearningEvaluator({ root, id: "evaluator:registry-a", reason: "Synthetic root retired.",
    confirmLocalEvaluator: true, now: new Date("2032-01-01T00:00:02.000Z") });
  const context = await learningContext({ root, scope: scopedTurn, now: new Date("2032-01-01T00:00:03.000Z") });
  assert.equal(context.items.length, 0, "revoked evaluator evidence must not remain in preflight context");
  assert.equal(context.degraded, true);
  assert.deepEqual(context.diagnostics, ["revoked-evaluator-canary:learning:revoked-evaluator"]);
  const reconciled = await evaluateLearning({ root, now: new Date("2032-01-01T00:00:03.000Z") });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:revoked-evaluator", decision: "rolled-back" }]);
  const status = await learningOutcomeStatus({ root });
  assert.deepEqual(status.evaluatorRegistry, {
    active: 1, revoked: 1, bindings: 1, validationLeases: 0, authority: "context-only"
  });
  assert.equal(status.records[0].inactiveEvaluatorRegistryContracts, 1);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("outcome-bound behavior learning completes before, canary, after, and validation with objective evidence", async (t) => {
  const { root } = await fixture(t);
  const beforeBytes = await readFile(join(root, "AGENTS.md"));
  await proposeLearning({
    root, id: "learning:measured", kind: "behavior", claim: "Check the fixed synthetic invariant before answering.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:measured-one", 0.96)
  });
  await addLearningEvidence({ root, id: "learning:measured", evidence: evidence("evidence:measured-two", 0.94) });
  await configureLearning({
    root, config: {
      autoPromote: true, minConfidence: 0.9, minEvidence: 2, minOutcomeReceipts: 2,
      canaryReceipts: 2, minImprovement: 0.1
    }
  });
  await evaluation(root, "learning:measured", {
    evaluatorIds: ["evaluator:test-a", "evaluator:user-b", "evaluator:test-b"]
  });
  await recordLearningOutcome({ root, learningId: "learning:measured", ...outcome("outcome:before-a", "before", 0.4, "evaluator:test-a") });
  await recordLearningOutcome({
    root, learningId: "learning:measured",
    ...outcome("outcome:before-b", "before", 0.5, "evaluator:user-b", { kind: "user-feedback" })
  });
  const promoted = await evaluateLearning({ root });
  assert.equal(promoted.accepted[0].promotion.mode, "outcome-canary");
  assert.equal(promoted.accepted[0].promotion.canary.status, "active");
  assert.equal((await learningContext({ root, scope: scopedTurn })).items[0].outcomeStatus, "active");
  assert.equal((await learningContext({ root, scope: { ...scopedTurn, tenantId: "tenant:other" } })).items.length, 0);

  const applicationA = await application(root, "learning:measured", "measured-a");
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:after-drifted-evaluator", "after", 0.9, "evaluator:test-b")
  }), /matching immutable measurement receipt|same evaluator as a frozen before measurement/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:after-drifted-kind", "after", 0.9, "evaluator:user-b")
  }), /precommitted first-admitted trial and completed delivery|measurement kind and case count/);
  const first = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationA.id, deliveryId: applicationA.deliveryId,
    ...outcome("outcome:after-a", "after", 0.7, "evaluator:test-a")
  });
  assert.equal(first.decision, "active");
  const applicationB = await application(root, "learning:measured", "measured-b");
  const second = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:after-b", "after", 0.8, "evaluator:user-b", { kind: "user-feedback" })
  });
  assert.equal(second.decision, "validated");
  assert.ok(Math.abs(second.candidate.promotion.canary.improvement - 0.3) < 1e-12,
    "paired deltas, not a driftable aggregate cohort, prove improvement");
  assert.match(second.candidate.promotion.canary.validationLeaseId, /^validation:/);
  const validatedState = await loadLearning(root);
  const validationLease = validatedState.learning.validationLeases[0];
  assert.equal(validationLease.schema, "agentspine.learning-validation/v1");
  assert.equal(validationLease.learningId, "learning:measured");
  assert.equal(validationLease.evaluatorRegistryBindingDigest,
    validatedState.learning.evaluationBindings.find((item) => item.evaluationId === "evaluation:fixed").digest);
  assert.deepEqual(validationLease.beforeOutcomes.map((item) => item.id), ["outcome:before-a", "outcome:before-b"]);
  assert.deepEqual(validationLease.afterOutcomes.map((item) => item.id), ["outcome:after-a", "outcome:after-b"]);
  assert.equal(JSON.stringify(validationLease).includes("Check the fixed synthetic invariant"), false,
    "validation proof must remain content-free");
  const retryAfterValidation = await recordLearningOutcome({
    root, learningId: "learning:measured", applicationId: applicationB.id, deliveryId: applicationB.deliveryId,
    ...outcome("outcome:after-b", "after", 0.8, "evaluator:user-b", { kind: "user-feedback" })
  });
  assert.equal(retryAfterValidation.unchanged, true);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn });
  assert.equal(status.records[0].canaryStatus, "validated");
  assert.equal(status.records[0].validationLeaseStatus, "current-validated");
  assert.equal(status.evaluatorRegistry.validationLeases, 1);
  assert.equal(status.records[0].beforeReceipts, 2);
  assert.equal(status.records[0].afterReceipts, 2);
  assert.equal(status.records[0].boundAfterReceipts, 2);
  assert.equal(status.records[0].applicationReceipts, 2);
  assert.equal(status.records[0].deliveryReceipts, 2);
  assert.equal(status.records[0].deliveredAfterReceipts, 2);
  assert.equal(status.records[0].pairedOutcomeReceipts, 4);
  assert.equal(status.records[0].pairedEvaluatorPairs, 2);
  assert.equal(status.records[0].pendingApplications, 0);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), beforeBytes);
});
