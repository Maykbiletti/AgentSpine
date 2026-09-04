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

test("case-bound outcomes reject cherry-picked subsets and dataset drift", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  await proposeLearning({
    root, id: "learning:coverage", kind: "behavior", claim: "Use the fixed synthetic coverage strategy.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:coverage-one", 0.97)
  });
  await addLearningEvidence({ root, id: "learning:coverage", evidence: evidence("evidence:coverage-two", 0.97) });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  const registered = await evaluation(root, "learning:coverage");
  assert.equal(registered.contract.schema, "agentspine.learning-evaluation/v28");
  assert.deepEqual(registered.contract.pairing, {
    mode: "same-evaluator", maxOutcomesPerEvaluatorPerPhase: 1,
    matchMeasurementKind: true, matchCaseCount: true, authority: "context-only"
  });

  await assert.rejects(commitLearningOutcome({
    root, id: "outcome:missing-measurement", learningId: "learning:coverage",
    evaluationId: "evaluation:fixed"
  }), /immutable measurement receipt/);

  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:provenance-missing", "before", 0.4, "evaluator:test-a", { sourceDigest: null })
  }), /sourceDigest/);

  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-missing", "before", 0.4, "evaluator:test-a"), coverage: null
  }), /caseCount/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-small", "before", 0.4, "evaluator:test-a", { caseCount: 11 })
  }), /at least 12 cases/);
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-drift", "before", 0.4, "evaluator:test-a", { datasetDigest: hash("other dataset") })
  }), /dataset does not match/);

  await recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-before-a", "before", 0.4, "evaluator:test-a") });
  await assert.rejects(recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-before-a-overweight", "before", 0.1, "evaluator:test-a")
  }), /evaluator run cannot be replayed|exactly one outcome per evaluator and phase/,
  "one evaluator cannot overweight the baseline with repeated runs");
  await assert.rejects(recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-replay", "before", 0.5, "evaluator:test-b", {
      sourceDigest: hash("measurement:outcome:coverage-before-a")
    })
  }), /source provenance cannot be reused/);
  const firstMeasurement = (await loadLearning(root)).learning.measurements
    .find((item) => item.id === "measurement:outcome:coverage-before-a");
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:run-replay", learningId: "learning:coverage", evaluationId: "evaluation:fixed",
    phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.5, blockingDefects: 0 },
    measurement: {
      kind: "objective", evaluatorId: "evaluator:test-a", runId: firstMeasurement.measurement.runId,
      sourceDigest: hash("different-source-for-same-run")
    },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, confirmLocalMeasurement: true
  }), /evaluator run cannot be replayed/);
  await assert.rejects(commitLearningOutcome({
    root, id: "outcome:metric-tamper", learningId: "learning:coverage", evaluationId: "evaluation:fixed",
    measurementReceiptId: firstMeasurement.id,
    metric: { name: "fixed-task-success", direction: "higher", value: 1, blockingDefects: 0 }
  }), /metric conflicts/);
  await recordLearningOutcome({ root, learningId: "learning:coverage",
    ...outcome("outcome:coverage-before-b", "before", 0.5, "evaluator:test-b") });
  const promoted = await evaluateLearning({ root });
  assert.equal(promoted.accepted[0].promotion.canary.coverage.minCases, 12);
  assert.equal(promoted.accepted[0].promotion.canary.coverage.datasetDigest, syntheticDatasetDigest);

  const applied = await application(root, "learning:coverage", "coverage-a");
  await assert.rejects(recordLearningOutcome({
    root, learningId: "learning:coverage", applicationId: applied.id, deliveryId: applied.deliveryId,
    ...outcome("outcome:coverage-after-small", "after", 0.8, "evaluator:test-a", { caseCount: 1 })
  }), /at least 12 cases/);
  const recorded = await recordLearningOutcome({
    root, learningId: "learning:coverage", applicationId: applied.id, deliveryId: applied.deliveryId,
    ...outcome("outcome:coverage-after-valid", "after", 0.8, "evaluator:test-a")
  });
  assert.equal(recorded.receipt.schema, "agentspine.learning-outcome/v9");
  assert.deepEqual(recorded.receipt.coverage, {
    datasetDigest: syntheticDatasetDigest, caseCount: 12, authority: "context-only"
  });
  assert.equal(JSON.stringify(recorded.receipt).includes("fixed synthetic coverage strategy"), false);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);

  const stored = await loadLearning(root);
  const original = stored.learning.outcomes.find((item) => item.id === "outcome:coverage-before-a");
  const { digest: _storedDigest, ...replayedPayload } = { ...original, id: "outcome:coverage-corrupt-replay" };
  stored.learning.outcomes.push({ ...replayedPayload, digest: hash(JSON.stringify(replayedPayload)) });
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /(paired evaluator outcome is duplicated|outcome measurement binding is invalid or replayed)/);
});

test("initial trials reject favorable reruns and retain the first admitted crashed turn", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2036-01-01T00:00:00.000Z");
  await proposeLearning({
    root, id: "learning:initial-trials", kind: "behavior", claim: "Use the fixed initial-trial strategy.",
    scope: scopedTurn, evidence: evidence("evidence:initial-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:initial-trials",
    evidence: evidence("evidence:initial-two", 0.97), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 }, now: start });
  const registered = await evaluation(root, "learning:initial-trials", {
    id: "evaluation:initial-trials", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"], now: start,
    expiresAt: "2036-02-01T00:00:00.000Z"
  });
  assert.equal(registered.contract.schema, "agentspine.learning-evaluation/v28");
  assert.equal(registered.contract.initialTrials.mode, "first-admitted-trials");
  assert.deepEqual(registered.contract.initialTrials.before.map((entry) => entry.slot), [1, 2]);
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:favorable-rerun", learningId: "learning:initial-trials",
    evaluationId: "evaluation:initial-trials", phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.99, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a", runId: "run:favorable-rerun",
      sourceDigest: hash("source:favorable-rerun") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start
  }), /precommitted initial trial/);
  await recordLearningOutcome({ root, learningId: "learning:initial-trials",
    ...outcome("outcome:initial-before-a", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:initial-trials", measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:initial-trials",
    ...outcome("outcome:initial-before-b", "before", 0.5, "evaluator:test-b", {
      evaluationId: "evaluation:initial-trials", measuredAt: start
    }), now: start });
  await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  const crashed = await projectedApplication(root, "learning:initial-trials", "initial-crashed",
    new Date(start.getTime() + 2000));
  const second = await application(root, "learning:initial-trials", "initial-second",
    new Date(start.getTime() + 3000));
  const later = await projectedApplication(root, "learning:initial-trials", "initial-later",
    new Date(start.getTime() + 4000));
  assert.equal(crashed.schema, "agentspine.learning-application/v7");
  assert.equal(crashed.initialAdmission.slot, 1);
  assert.equal(second.schema, "agentspine.learning-application/v7");
  assert.equal(second.initialAdmission.slot, 2);
  assert.equal(later.schema, "agentspine.learning-application/v2");
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:initial-replacement", learningId: "learning:initial-trials",
    evaluationId: "evaluation:initial-trials", phase: "after", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.99, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a",
      runId: registered.contract.initialTrials.after[0].runId,
      sourceDigest: hash("source:initial-replacement") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: new Date(start.getTime() + 5000), confirmLocalMeasurement: true,
    now: new Date(start.getTime() + 5000)
  }), /first-admitted trial and completed delivery/);
  await recordLearningOutcome({ root, learningId: "learning:initial-trials", applicationId: second.id,
    deliveryId: second.deliveryId, ...outcome("outcome:initial-after-b", "after", 0.9, "evaluator:test-b", {
      evaluationId: "evaluation:initial-trials", measuredAt: new Date(start.getTime() + 5000)
    }), now: new Date(start.getTime() + 5000) });
  const status = await learningOutcomeStatus({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 6 * 60_000) });
  assert.equal(status.records[0].initialTrialSlots, 2);
  assert.equal(status.records[0].initialAdmittedApplications, 2);
  assert.equal(status.records[0].initialCompletedDeliveries, 1);
  assert.equal((await purgeStaleLearningApplications({ root, confirmation: "local-user-purge-confirmed",
    now: new Date(start.getTime() + 6 * 60_000) })).purged, 1,
  "only the later ordinary crash residue is purgeable; the admitted crash remains");
  const tampered = await loadLearning(root);
  const admitted = tampered.learning.applications.find((entry) => entry.id === crashed.id);
  admitted.initialAdmission.runId = "run:tampered-initial";
  const { digest: _applicationDigest, ...applicationPayload } = admitted;
  admitted.digest = hash(JSON.stringify(applicationPayload));
  await writeFile(tampered.learningPath, `${JSON.stringify(tampered.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /initial trial admission state is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("evaluation targets freeze the exact evidence-backed lesson revision across projection and restart", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2037-01-01T00:00:00.000Z");
  const claim = "Use the immutable synthetic target strategy.";
  await proposeLearning({
    root, id: "learning:target-lock", kind: "behavior", claim, scope: scopedTurn,
    evidence: evidence("evidence:target-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:target-lock",
    evidence: evidence("evidence:target-two", 0.97), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 }, now: start });
  const registered = await evaluation(root, "learning:target-lock", {
    id: "evaluation:target-lock", now: start, expiresAt: "2037-02-01T00:00:00.000Z"
  });
  assert.equal(registered.contract.schema, "agentspine.learning-evaluation/v28");
  assert.equal(registered.contract.target.schema, "agentspine.learning-target/v1");
  assert.equal(registered.contract.target.learningId, "learning:target-lock");
  assert.deepEqual(Object.keys(registered.contract.target).sort(), ["authority", "claimDigest", "digest",
    "evidenceDigest", "learningId", "revisionDigest", "schema", "scopeDigest"]);
  assert.equal(JSON.stringify(registered.contract).includes(claim), false,
    "the immutable target must expose digests, not lesson text");
  await assert.rejects(addLearningEvidence({ root, id: "learning:target-lock",
    evidence: evidence("evidence:target-late", 0.99), now: new Date(start.getTime() + 1) }),
  /evaluated learning target is immutable/);

  await recordLearningOutcome({ root, learningId: "learning:target-lock",
    ...outcome("outcome:target-before-a", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:target-lock", measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:target-lock",
    ...outcome("outcome:target-before-b", "before", 0.5, "evaluator:test-b", {
      evaluationId: "evaluation:target-lock", measuredAt: start
    }), now: start });
  const promoted = await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  assert.equal(promoted.accepted[0].promotion.canary.targetDigest, registered.contract.target.digest);
  const projected = await projectedApplication(root, "learning:target-lock", "target-turn",
    new Date(start.getTime() + 2000));
  assert.equal(projected.schema, "agentspine.learning-application/v7");
  assert.equal(projected.initialAdmission.targetDigest, registered.contract.target.digest);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 2001) });
  assert.equal(status.records[0].targetBoundEvaluationContracts, 1);
  assert.equal(status.records[0].targetBoundApplications, 1);
  assert.equal(status.records[0].activeTargetDigest, registered.contract.target.digest);

  const clean = await loadLearning(root);
  const cleanBytes = `${JSON.stringify(clean.learning)}\n`;
  const tamperedApplication = clean.learning.applications.find((item) => item.id === projected.id);
  tamperedApplication.initialAdmission.targetDigest = hash("substituted target");
  const { digest: _tamperedDigest, ...tamperedPayload } = tamperedApplication;
  tamperedApplication.digest = hash(JSON.stringify(tamperedPayload));
  await writeFile(clean.learningPath, `${JSON.stringify(clean.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /initial trial admission state is invalid/);
  await writeFile(clean.learningPath, cleanBytes, "utf8");

  const drifted = await loadLearning(root);
  drifted.learning.candidates.find((item) => item.id === "learning:target-lock").claim =
    "Use a substituted synthetic target strategy.";
  await writeFile(drifted.learningPath, `${JSON.stringify(drifted.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning evaluation target is invalid or changed/);
  await writeFile(drifted.learningPath, cleanBytes, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations[0].target.digest,
    registered.contract.target.digest, "the exact target remains readable after restart");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("immutable trial deadlines turn missing delivery or outcome into one blocking receipt and rollback", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2038-01-01T00:00:00.000Z");
  await configureLearning({ root, config: {
    autoPromote: true, minConfidence: 0.9, minEvidence: 2,
    minOutcomeReceipts: 2, canaryReceipts: 2, initialTrialOutcomeTimeoutMinutes: 5
  }, now: start });

  const prepare = async (suffix, offsetMs) => {
    const base = new Date(start.getTime() + offsetMs);
    const learningId = `learning:deadline-${suffix}`;
    const evaluationId = `evaluation:deadline-${suffix}`;
    await proposeLearning({ root, id: learningId, kind: "behavior",
      claim: `Use deadline-bound synthetic strategy ${suffix}.`, scope: scopedTurn,
      evidence: evidence(`evidence:deadline-${suffix}-one`, 0.97), now: base });
    await addLearningEvidence({ root, id: learningId,
      evidence: evidence(`evidence:deadline-${suffix}-two`, 0.97), now: base });
    const registered = await evaluation(root, learningId, {
      id: evaluationId, evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
      now: base, expiresAt: new Date(base.getTime() + 86400000)
    });
    assert.equal(registered.contract.schema, "agentspine.learning-evaluation/v28");
    assert.equal(registered.contract.completionPolicy.schema, "agentspine.learning-completion-policy/v1");
    assert.equal(registered.contract.completionPolicy.deliveryTimeoutMs, 300000);
    assert.equal(registered.contract.completionPolicy.outcomeTimeoutMs, 300000);
    for (const [index, evaluatorId] of ["evaluator:test-a", "evaluator:test-b"].entries()) {
      await recordLearningOutcome({ root, learningId,
        ...outcome(`outcome:deadline-${suffix}-before-${index}`, "before", 0.4 + index * 0.05, evaluatorId, {
          evaluationId, measuredAt: base
        }), now: base });
    }
    await evaluateLearning({ root, now: new Date(base.getTime() + 1000) });
    return { base, learningId, evaluationId, contract: registered.contract };
  };

  const missingDelivery = await prepare("delivery", 0);
  const deliveryApplication = await projectedApplication(root, missingDelivery.learningId, "deadline-delivery",
    new Date(missingDelivery.base.getTime() + 2000));
  assert.equal(deliveryApplication.schema, "agentspine.learning-application/v7");
  assert.equal(deliveryApplication.completionPolicyDigest, missingDelivery.contract.completionPolicy.digest);
  assert.equal(new Date(deliveryApplication.deliveryExpiresAt).getTime()
    - new Date(deliveryApplication.projectedAt).getTime(), 300000);
  const deliveryDeadlinePassed = new Date(new Date(deliveryApplication.deliveryExpiresAt).getTime() + 1);
  const withheld = await learningContext({ root, scope: scopedTurn, now: deliveryDeadlinePassed });
  assert.equal(withheld.items.some((item) => item.id === missingDelivery.learningId), false,
    "a missed delivery is withheld before reconciliation can project it again");
  assert.equal(withheld.diagnostics.includes(`blocking-initial-trial-timeout:${missingDelivery.learningId}`), true);
  const reconciliations = await Promise.all(Array.from({ length: 4 }, () =>
    evaluateLearning({ root, now: deliveryDeadlinePassed })));
  assert.equal(reconciliations.flatMap((entry) => entry.reconciled)
    .filter((entry) => entry.id === missingDelivery.learningId).length, 1,
  "parallel reconciliation records one atomic rollback");
  const afterDeliveryFailure = await loadLearning(root);
  assert.equal(afterDeliveryFailure.learning.trialFailures.length, 1);
  const deliveryFailure = afterDeliveryFailure.learning.trialFailures[0];
  assert.equal(deliveryFailure.failure, "delivery-timeout");
  assert.equal(deliveryFailure.applicationId, deliveryApplication.id);
  assert.equal(JSON.stringify(deliveryFailure).includes("deadline-bound synthetic strategy"), false);
  assert.equal(afterDeliveryFailure.learning.candidates.find((item) => item.id === missingDelivery.learningId)
    .rollback.trialFailureDigest, deliveryFailure.digest);
  assert.equal((await recordLearningDeliveries({ root, sessionId: "session:deadline-delivery",
    scope: scopedTurn, hookEvent: "Stop", completedAt: deliveryDeadlinePassed })).status, "stale");

  const missingOutcome = await prepare("outcome", 2 * 86400000);
  const outcomeApplication = await application(root, missingOutcome.learningId, "deadline-outcome",
    new Date(missingOutcome.base.getTime() + 2000));
  const outcomeDeadlinePassed = new Date(new Date(outcomeApplication.outcomeExpiresAt).getTime() + 1);
  const firstAfterTrial = missingOutcome.contract.initialTrials.after[0];
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:deadline-outcome-late", learningId: missingOutcome.learningId,
    evaluationId: missingOutcome.evaluationId, phase: "after", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.99, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: firstAfterTrial.evaluatorId,
      runId: firstAfterTrial.runId, sourceDigest: hash("late synthetic outcome") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: firstAfterTrial.caseCount },
    measuredAt: new Date(missingOutcome.base.getTime() + 3000),
    confirmLocalMeasurement: true, now: outcomeDeadlinePassed
  }), /missed its immutable initial trial outcome deadline/,
  "backdating a late measurement cannot rescue the admitted trial");
  assert.equal((await learningContext({ root, scope: scopedTurn, now: outcomeDeadlinePassed })).items
    .some((item) => item.id === missingOutcome.learningId), false);
  await evaluateLearning({ root, now: outcomeDeadlinePassed });
  const failedState = await loadLearning(root);
  const outcomeFailure = failedState.learning.trialFailures.find((item) =>
    item.learningId === missingOutcome.learningId);
  assert.equal(outcomeFailure.failure, "outcome-timeout");
  assert.equal(outcomeFailure.deadline, outcomeApplication.outcomeExpiresAt);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn, now: outcomeDeadlinePassed });
  const outcomeRecord = status.records.find((item) => item.id === missingOutcome.learningId);
  assert.equal(outcomeRecord.deadlineBoundEvaluationContracts, 1);
  assert.equal(outcomeRecord.deadlineBoundApplications, 1);
  assert.equal(outcomeRecord.trialFailureReceipts, 1);
  assert.equal(outcomeRecord.outcomeTimeoutFailures, 1);
  assert.equal(outcomeRecord.canaryStatus, "not-applicable");
  assert.equal(outcomeRecord.incompleteInitialAdmissions, 0,
    "a handled blocking failure is retained as evidence, not reported as unresolved work");

  const cleanBytes = `${JSON.stringify(failedState.learning)}\n`;
  outcomeFailure.applicationDigest = hash("substituted application");
  const { digest: _failureDigest, ...failurePayload } = outcomeFailure;
  outcomeFailure.digest = hash(JSON.stringify(failurePayload));
  await writeFile(failedState.learningPath, `${JSON.stringify(failedState.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning trial failure state is invalid/);
  await writeFile(failedState.learningPath, cleanBytes, "utf8");
  assert.equal((await loadLearning(root)).learning.trialFailures.length, 2,
    "failure receipts survive restart and cannot be replaced");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
