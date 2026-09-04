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

test("trial failure revocation withdraws false blocking proof without resurrecting its canary", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2039-01-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:failure-alpha" };
  await upsertEntity({ root, id: "group:failure-alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:failure-beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:failure-member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:failure-member", to: "group:failure-alpha",
    relation: "member-of", privacy: "group" });
  await proposeLearning({ root, id: "learning:failure-prior", kind: "behavior",
    claim: "Use the prior synthetic group procedure.", subjectId: "person:failure-member",
    privacy: "group", groupId: "group:failure-alpha", scope: alphaScope,
    evidence: evidence("evidence:failure-prior", 0.97), now: start });
  await reviewLearning({ root, id: "learning:failure-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await proposeLearning({ root, id: "learning:failure-current", kind: "behavior",
    claim: "Use the measured synthetic group procedure.", subjectId: "person:failure-member",
    privacy: "group", groupId: "group:failure-alpha", scope: alphaScope,
    supersedesId: "learning:failure-prior",
    evidence: evidence("evidence:failure-current-one", 0.97), now: start });
  await addLearningEvidence({ root, id: "learning:failure-current",
    evidence: evidence("evidence:failure-current-two", 0.97), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2,
    minOutcomeReceipts: 2, canaryReceipts: 2, initialTrialOutcomeTimeoutMinutes: 5 }, now: start });
  const registered = await evaluation(root, "learning:failure-current", {
    id: "evaluation:failure-current", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: new Date(start.getTime() + 86400000)
  });
  for (const [index, evaluatorId] of ["evaluator:test-a", "evaluator:test-b"].entries()) {
    await recordLearningOutcome({ root, learningId: "learning:failure-current",
      ...outcome(`outcome:failure-before-${index}`, "before", 0.4 + index * 0.05, evaluatorId, {
        evaluationId: registered.contract.id, scope: alphaScope, measuredAt: start
      }), now: start });
  }
  await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  const applicationReceipt = await projectedApplication(root, "learning:failure-current", "failure-current",
    new Date(start.getTime() + 2000), "active", alphaScope);
  const deadlinePassed = new Date(new Date(applicationReceipt.deliveryExpiresAt).getTime() + 1);
  await evaluateLearning({ root, now: deadlinePassed });
  const failed = await loadLearning(root);
  const failure = failed.learning.trialFailures[0];
  assert.equal(failed.learning.candidates.find((item) => item.id === "learning:failure-current").status,
    "rolled-back");
  assert.equal(failed.learning.candidates.find((item) => item.id === "learning:failure-prior").status,
    "accepted");
  await assert.rejects(revokeLearningTrialFailure({ root, trialFailureId: failure.id,
    reasonCode: "clock-invalid", reason: "Synthetic local clock invalidation." }),
  /explicit local confirmation/);
  const input = { root, trialFailureId: failure.id, reasonCode: "clock-invalid",
    reason: "Synthetic local clock invalidation.", confirmation: "local-trial-failure-revocation-confirmed",
    now: new Date(deadlinePassed.getTime() + 1000) };
  const attempts = await Promise.all(Array.from({ length: 6 }, () => revokeLearningTrialFailure(input)));
  assert.equal(attempts.filter((result) => result.unchanged === false).length, 1);
  assert.equal(attempts.every((result) => result.requiresFreshCandidate === true), true);
  assert.equal((await revokeLearningTrialFailure({ ...input,
    now: new Date(deadlinePassed.getTime() + 2000) })).unchanged, true);
  await assert.rejects(revokeLearningTrialFailure({ ...input, reasonCode: "host-invalid",
    reason: "Synthetic conflicting invalidation." }), /immutable/);
  const revoked = await loadLearning(root);
  const receipt = revoked.learning.trialFailureRevocations[0];
  const binding = revoked.learning.evaluationBindings.find((item) =>
    item.evaluationId === registered.contract.id);
  assert.equal(receipt.trialFailureDigest, failure.digest);
  assert.equal(receipt.evaluationDigest, registered.contract.digest);
  assert.equal(receipt.evaluatorBindingDigest, binding.digest);
  assert.equal(receipt.applicationDigest, applicationReceipt.digest);
  assert.equal(receipt.targetDigest, registered.contract.target.digest);
  assert.equal(receipt.retryPolicy, "fresh-candidate-and-contract-required");
  assert.equal(JSON.stringify(receipt).includes("Synthetic local clock invalidation"), false);
  const alpha = await learningContext({ root, groupId: "group:failure-alpha", scope: alphaScope,
    now: new Date(deadlinePassed.getTime() + 3000) });
  assert.deepEqual(alpha.items.map((item) => item.id), ["learning:failure-prior"]);
  assert.deepEqual(alpha.diagnostics, ["revoked-learning-trial-failure:learning:failure-current"]);
  assert.equal(alpha.degraded, true);
  assert.deepEqual((await learningContext({ root, groupId: "group:failure-beta",
    scope: { ...alphaScope, groupId: "group:failure-beta" },
    now: new Date(deadlinePassed.getTime() + 3000) })).diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: alphaScope,
    now: new Date(deadlinePassed.getTime() + 3000) });
  const record = status.records.find((item) => item.id === "learning:failure-current");
  assert.equal(status.trialFailureRevocations, 1);
  assert.equal(record.trialFailureReceipts, 1);
  assert.equal(record.trialFailureRevocationReceipts, 1);
  assert.deepEqual(record.revokedTrialFailureIds, [failure.id]);
  assert.equal(record.status, "rolled-back", "revocation must never resurrect a failed Canary");
  assert.equal((await learningOutcomeStatus({ root,
    scope: { ...alphaScope, groupId: "group:failure-beta" },
    now: new Date(deadlinePassed.getTime() + 3000) })).trialFailureRevocations, 0);
  const cli = runCli(["learn-trial-failure-revoke", failure.id, "--root", root,
    "--reason-code", "clock-invalid", "--reason", "Synthetic local clock invalidation.",
    "--confirm-local-trial-failure-revocation", "--json"], state);
  assert.equal(cli.receipt.schema, "agentspine.learning-trial-failure-revocation/v1");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.status, "degraded");
  assert.equal(doctor.learningOutcomes.trialFailureRevocationReceipts, 1);
  assert.equal((await recordLearningDeliveries({ root, sessionId: "session:failure-current",
    scope: alphaScope, hookEvent: "Stop", completedAt: new Date(deadlinePassed.getTime() + 4000) })).status,
  "stale", "revocation must not make a late Stop valid");
  const retryBase = new Date(deadlinePassed.getTime() + 5000);
  await proposeLearning({ root, id: "learning:failure-retry-stale", kind: "behavior",
    claim: "Use the measured synthetic group procedure.", subjectId: "person:failure-member",
    privacy: "group", groupId: "group:failure-alpha", scope: alphaScope,
    supersedesId: "learning:failure-prior",
    evidence: { ...evidence("evidence:failure-retry-stale", 0.97), observedAt: start }, now: retryBase });
  await assert.rejects(evaluation(root, "learning:failure-retry-stale", {
    id: "evaluation:failure-retry-stale", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    benchmark: registered.contract.benchmark,
    scope: alphaScope, retryTrialFailureId: failure.id, confirmLocalTrialRetry: true,
    now: retryBase, expiresAt: new Date(retryBase.getTime() + 86400000)
  }), /(?:fresh candidate and independently observed evidence|already admitted in this exact scope)/);
  await deleteLearning({ root, id: "learning:failure-retry-stale" });
  await proposeLearning({ root, id: "learning:failure-retry-reused", kind: "behavior",
    claim: "Use the measured synthetic group procedure.", subjectId: "person:failure-member",
    privacy: "group", groupId: "group:failure-alpha", scope: alphaScope,
    supersedesId: "learning:failure-prior",
    evidence: evidence("evidence:failure-current-one", 0.97), now: new Date(retryBase.getTime() + 1000) });
  await assert.rejects(evaluation(root, "learning:failure-retry-reused", {
    id: "evaluation:failure-retry-reused", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    benchmark: registered.contract.benchmark,
    scope: alphaScope, retryTrialFailureId: failure.id, confirmLocalTrialRetry: true,
    now: new Date(retryBase.getTime() + 1000), expiresAt: new Date(retryBase.getTime() + 86400000)
  }), /already admitted in this exact scope/);
  await deleteLearning({ root, id: "learning:failure-retry-reused" });
  await proposeLearning({ root, id: "learning:failure-retry", kind: "behavior",
    claim: "Use the measured synthetic group procedure.", subjectId: "person:failure-member",
    privacy: "group", groupId: "group:failure-alpha", scope: alphaScope,
    supersedesId: "learning:failure-prior",
    evidence: evidence("evidence:failure-retry-one", 0.97), now: new Date(retryBase.getTime() + 2000) });
  await addLearningEvidence({ root, id: "learning:failure-retry",
    evidence: evidence("evidence:failure-retry-two", 0.97), now: new Date(retryBase.getTime() + 3000) });
  const retryNow = new Date(retryBase.getTime() + 4000);
  const retryExtra = {
    id: "evaluation:failure-retry", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    benchmark: registered.contract.benchmark,
    scope: alphaScope, now: retryNow, expiresAt: new Date(retryNow.getTime() + 86400000)
  };
  await assert.rejects(evaluation(root, "learning:failure-retry", retryExtra),
    /explicit local trial-retry confirmation/);
  await assert.rejects(evaluation(root, "learning:failure-retry", {
    ...retryExtra,
    benchmark: { ...registered.contract.benchmark, datasetDigest: hash("drifted synthetic dataset") },
    retryTrialFailureId: failure.id, confirmLocalTrialRetry: true
  }), /objective contract drift/, "a retry cannot move to a different dataset");
  await assert.rejects(evaluation(root, "learning:failure-retry", {
    ...retryExtra,
    metric: { name: "different-success-metric", direction: "higher" },
    retryTrialFailureId: failure.id, confirmLocalTrialRetry: true
  }), /objective contract drift/, "a retry cannot change its metric");
  await assert.rejects(evaluation(root, "learning:failure-retry", {
    ...retryExtra,
    evaluatorIds: ["evaluator:test-c", "evaluator:user-b"],
    retryTrialFailureId: failure.id, confirmLocalTrialRetry: true
  }), /objective contract drift/, "a retry cannot replace its evaluator roots");
  await configureLearning({ root, config: { outcomeMaxAgeDays: 45 }, now: retryNow });
  await assert.rejects(evaluation(root, "learning:failure-retry", {
    ...retryExtra, retryTrialFailureId: failure.id, confirmLocalTrialRetry: true
  }), /objective contract drift/, "a retry cannot widen its frozen staleness window");
  await configureLearning({ root, config: { outcomeMaxAgeDays: 30 }, now: retryNow });
  await configureLearning({ root, config: { minImprovement: 0.01 }, now: retryNow });
  await assert.rejects(evaluation(root, "learning:failure-retry", {
    ...retryExtra, retryTrialFailureId: failure.id, confirmLocalTrialRetry: true
  }), /objective contract drift/, "a retry cannot lower its promotion threshold");
  await configureLearning({ root, config: { minImprovement: registered.contract.thresholds.minImprovement },
    now: retryNow });
  await configureLearning({ root, config: { minConfidence: 0.5 }, now: retryNow });
  await assert.rejects(evaluation(root, "learning:failure-retry", {
    ...retryExtra, retryTrialFailureId: failure.id, confirmLocalTrialRetry: true
  }), /objective contract drift/, "a retry cannot lower its candidate confidence gate");
  await configureLearning({ root, config: { minConfidence: 0.9 }, now: retryNow });
  const retryAttempts = await Promise.all(Array.from({ length: 6 }, () =>
    evaluation(root, "learning:failure-retry", { ...retryExtra,
      retryTrialFailureId: failure.id, confirmLocalTrialRetry: true })));
  assert.equal(retryAttempts.filter((result) => result.unchanged === false).length, 1);
  const retryContract = retryAttempts[0].contract;
  assert.equal(retryContract.schema, "agentspine.learning-evaluation/v29");
  assert.equal(retryContract.evidenceSourcePolicy.digest,
    registered.contract.evidenceSourcePolicy.digest);
  assert.equal(retryContract.retry.schema, "agentspine.learning-trial-retry/v3");
  assert.equal(retryContract.retry.trialFailureId, failure.id);
  assert.equal(retryContract.retry.trialFailureRevocationId, receipt.id);
  assert.equal(retryContract.retry.predecessorLearningId, "learning:failure-current");
  assert.equal(retryContract.retry.predecessorEvaluationId, registered.contract.id);
  assert.equal(retryContract.retry.predecessorEvaluationDigest, registered.contract.digest);
  assert.equal(retryContract.retry.rootEvaluationId, registered.contract.id);
  assert.equal(retryContract.retry.rootEvaluationDigest, registered.contract.digest);
  assert.equal(retryContract.retry.attempt, 2);
  assert.equal(retryContract.retry.maxAttempts, 2);
  assert.match(retryContract.retry.comparisonDigest, /^[a-f0-9]{64}$/);
  assert.equal(retryContract.retry.learningId, "learning:failure-retry");
  assert.equal(retryContract.retry.targetDigest, retryContract.target.digest);
  assert.equal(retryContract.retry.minimumEvidenceObservedAt, receipt.revokedAt);
  await configureLearning({ root, config: { minEvidence: 10 }, now: retryNow });
  assert.equal((await loadLearning(root)).learning.evaluations.find((item) => item.id === retryContract.id)
    .thresholds.minEvidence, 2,
  "raising mutable evidence requirements cannot invalidate a frozen retry contract after restart");
  await configureLearning({ root, config: { minEvidence: 2 }, now: retryNow });
  const retryStatus = await learningOutcomeStatus({ root, scope: alphaScope, now: retryNow });
  assert.equal(retryStatus.trialRetryEvaluationContracts, 1);
  assert.equal(retryStatus.comparableTrialRetryEvaluationContracts, 1);
  assert.equal(retryStatus.boundedTrialRetryEvaluationContracts, 1);
  assert.equal(retryStatus.records.find((item) => item.id === "learning:failure-retry")
    .trialRetryEvaluationContracts, 1);
  assert.equal(retryStatus.records.find((item) => item.id === "learning:failure-retry")
    .comparableTrialRetryEvaluationContracts, 1);
  assert.equal(retryStatus.records.find((item) => item.id === "learning:failure-retry")
    .boundedTrialRetryEvaluationContracts, 1);
  const foreignRetryStatus = await learningOutcomeStatus({ root,
    scope: { ...alphaScope, groupId: "group:failure-beta" }, now: retryNow });
  assert.deepEqual(foreignRetryStatus.records, []);
  assert.equal(foreignRetryStatus.trialRetryEvaluationContracts, 0);
  assert.equal(foreignRetryStatus.comparableTrialRetryEvaluationContracts, 0);
  assert.equal(foreignRetryStatus.boundedTrialRetryEvaluationContracts, 0);
  const retryDoctor = runCli(["doctor", root, "--json"], state);
  assert.equal(retryDoctor.learningOutcomes.trialRetryEvaluationContracts, 1);
  assert.equal(retryDoctor.learningOutcomes.comparableTrialRetryEvaluationContracts, 1);
  assert.equal(retryDoctor.learningOutcomes.boundedTrialRetryEvaluationContracts, 1);
  const retryAudit = runCli(["audit", root, "--json"], state);
  assert.equal(retryAudit.ok, true);
  assert.match(retryAudit.gates.find((gate) => gate.name === "Context privacy").detail,
    /1 bounded retry contracts/);
  for (const [index, evaluatorId] of ["evaluator:test-a", "evaluator:test-b"].entries()) {
    await recordLearningOutcome({ root, learningId: "learning:failure-retry",
      ...outcome(`outcome:failure-retry-before-${index}`, "before", 0.4 + index * 0.05, evaluatorId, {
        evaluationId: retryContract.id, scope: alphaScope, measuredAt: retryNow
      }), now: retryNow });
  }
  await evaluateLearning({ root, now: new Date(retryNow.getTime() + 1000) });
  const retryApplication = await projectedApplication(root, "learning:failure-retry", "failure-retry",
    new Date(retryNow.getTime() + 2000), "active", alphaScope);
  const retryDeadlinePassed = new Date(new Date(retryApplication.deliveryExpiresAt).getTime() + 1);
  await Promise.all(Array.from({ length: 6 }, () => evaluateLearning({ root, now: retryDeadlinePassed })));
  const retryFailedState = await loadLearning(root);
  const retryFailure = retryFailedState.learning.trialFailures.find((item) =>
    item.learningId === "learning:failure-retry");
  assert.ok(retryFailure, "the corrective Canary must retain its own terminal failure");
  assert.equal(retryFailedState.learning.trialRetryExhaustions.length, 1,
    "parallel reconciliation creates one immutable terminal receipt");
  const exhaustion = retryFailedState.learning.trialRetryExhaustions[0];
  assert.equal(exhaustion.schema, "agentspine.learning-trial-retry-exhaustion/v1");
  assert.equal(exhaustion.learningId, "learning:failure-retry");
  assert.equal(exhaustion.rootEvaluationId, registered.contract.id);
  assert.equal(exhaustion.rootEvaluationDigest, registered.contract.digest);
  assert.equal(exhaustion.correctiveEvaluationId, retryContract.id);
  assert.equal(exhaustion.correctiveEvaluationDigest, retryContract.digest);
  assert.equal(exhaustion.trialFailureId, retryFailure.id);
  assert.equal(exhaustion.trialFailureDigest, retryFailure.digest);
  assert.equal(exhaustion.targetDigest, retryContract.target.digest);
  assert.equal(exhaustion.attempt, 2);
  assert.equal(exhaustion.maxAttempts, 2);
  assert.equal(exhaustion.terminalPolicy, "no-further-retry");
  assert.equal(["claim", "evidence", "reason", "summary"].some((field) => field in exhaustion), false,
    "terminal receipts remain content-free");
  const exhaustedStatus = await learningOutcomeStatus({ root, scope: alphaScope, now: retryDeadlinePassed });
  assert.equal(exhaustedStatus.trialRetryExhaustions, 1);
  assert.equal(exhaustedStatus.records.find((item) => item.id === "learning:failure-retry")
    .trialRetryExhaustionReceipts, 1);
  assert.equal(exhaustedStatus.records.find((item) => item.id === "learning:failure-retry")
    .trialRetryBudgetStatus, "exhausted");
  const foreignExhaustedStatus = await learningOutcomeStatus({ root,
    scope: { ...alphaScope, groupId: "group:failure-beta" }, now: retryDeadlinePassed });
  assert.equal(foreignExhaustedStatus.trialRetryExhaustions, 0,
    "group-scoped diagnostics do not expose foreign exhaustion counts");
  const exhaustedDoctor = runCli(["doctor", root, "--json"], state);
  assert.equal(exhaustedDoctor.learningOutcomes.trialRetryExhaustionReceipts, 1);
  const exhaustedAudit = runCli(["audit", root, "--json"], state);
  assert.equal(exhaustedAudit.ok, true);
  assert.match(exhaustedAudit.gates.find((gate) => gate.name === "Context privacy").detail,
    /1 terminal retry-exhaustion receipts/);
  const retryRevokedAt = new Date(retryDeadlinePassed.getTime() + 1000);
  await revokeLearningTrialFailure({ root, trialFailureId: retryFailure.id, reasonCode: "clock-invalid",
    reason: "Synthetic corrective-trial clock invalidation.",
    confirmation: "local-trial-failure-revocation-confirmed", now: retryRevokedAt });
  await proposeLearning({ root, id: "learning:failure-retry-exhausted", kind: "behavior",
    claim: "Use the measured synthetic group procedure.", subjectId: "person:failure-member",
    privacy: "group", groupId: "group:failure-alpha", scope: alphaScope,
    supersedesId: "learning:failure-prior",
    evidence: evidence("evidence:failure-retry-exhausted-one", 0.97),
    now: new Date(retryRevokedAt.getTime() + 1000) });
  await addLearningEvidence({ root, id: "learning:failure-retry-exhausted",
    evidence: evidence("evidence:failure-retry-exhausted-two", 0.97),
    now: new Date(retryRevokedAt.getTime() + 2000) });
  const exhaustedInput = {
    id: "evaluation:failure-retry-exhausted", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    benchmark: registered.contract.benchmark, scope: alphaScope,
    retryTrialFailureId: retryFailure.id, confirmLocalTrialRetry: true,
    now: new Date(retryRevokedAt.getTime() + 3000),
    expiresAt: new Date(retryRevokedAt.getTime() + 86403000)
  };
  const exhaustedAttempts = await Promise.allSettled(Array.from({ length: 6 }, () =>
    evaluation(root, "learning:failure-retry-exhausted", exhaustedInput)));
  assert.equal(exhaustedAttempts.every((result) => result.status === "rejected"
    && /trial retry budget is exhausted/.test(result.reason?.message || "")), true,
  "parallel callers cannot admit a third selectively favorable trial");
  assert.equal((await loadLearning(root)).learning.evaluations.some((item) =>
    item.learningId === "learning:failure-retry-exhausted"), false);
  await assert.rejects(deleteLearning({ root, id: "learning:failure-current" }), /dependent trial-retry/);
  const compatibleState = await loadLearning(root);
  const compatibleSnapshot = JSON.stringify(compatibleState.learning);
  compatibleState.learning.trialFailures = compatibleState.learning.trialFailures.filter((item) =>
    item.learningId !== "learning:failure-retry");
  compatibleState.learning.trialFailureRevocations = compatibleState.learning.trialFailureRevocations.filter((item) =>
    item.learningId !== "learning:failure-retry");
  compatibleState.learning.trialRetryExhaustions = compatibleState.learning.trialRetryExhaustions.filter((item) =>
    item.learningId !== "learning:failure-retry");
  compatibleState.learning.applications = compatibleState.learning.applications.filter((item) =>
    item.learningId !== "learning:failure-retry");
  compatibleState.learning.deliveries = compatibleState.learning.deliveries.filter((item) =>
    item.learningId !== "learning:failure-retry");
  compatibleState.learning.measurements = compatibleState.learning.measurements.filter((item) =>
    item.learningId !== "learning:failure-retry");
  compatibleState.learning.measurementLineage = compatibleState.learning.measurementLineage.filter((item) =>
    item.learningId !== "learning:failure-retry");
  compatibleState.learning.outcomes = compatibleState.learning.outcomes.filter((item) =>
    item.learningId !== "learning:failure-retry");
  const predecessorContract = compatibleState.learning.evaluations.find((item) =>
    item.id === retryContract.retry.predecessorEvaluationId);
  const { digest: _predecessorContractDigest, stalenessPolicy: _predecessorStaleness,
    candidateAdmission: _predecessorCandidateAdmission,
    blockingDefectPolicy: _predecessorBlockingDefectPolicy,
    evidenceSourcePolicy: _predecessorEvidenceSourcePolicy,
    ...predecessorContractFields } = predecessorContract;
  const predecessorContractPayload = {
    ...predecessorContractFields, schema: "agentspine.learning-evaluation/v10"
  };
  Object.assign(predecessorContract, predecessorContractPayload, {
    digest: hash(JSON.stringify(predecessorContractPayload))
  });
  delete predecessorContract.stalenessPolicy;
  delete predecessorContract.candidateAdmission;
  const predecessorBinding = compatibleState.learning.evaluationBindings.find((item) =>
    item.evaluationId === predecessorContract.id);
  predecessorBinding.evaluationDigest = predecessorContract.digest;
  const predecessorBindingPayload = { ...predecessorBinding };
  delete predecessorBindingPayload.digest;
  predecessorBinding.digest = hash(JSON.stringify(predecessorBindingPayload));
  const predecessorFailure = compatibleState.learning.trialFailures.find((item) =>
    item.id === retryContract.retry.trialFailureId);
  const predecessorApplication = compatibleState.learning.applications.find((item) =>
    item.id === predecessorFailure.applicationId);
  predecessorApplication.initialAdmission.evaluationDigest = predecessorContract.digest;
  const predecessorApplicationPayload = { ...predecessorApplication };
  delete predecessorApplicationPayload.digest;
  predecessorApplication.digest = hash(JSON.stringify(predecessorApplicationPayload));
  predecessorFailure.evaluationDigest = predecessorContract.digest;
  predecessorFailure.applicationDigest = predecessorApplication.digest;
  const predecessorFailurePayload = { ...predecessorFailure };
  delete predecessorFailurePayload.digest;
  predecessorFailure.digest = hash(JSON.stringify(predecessorFailurePayload));
  const predecessorCandidate = compatibleState.learning.candidates.find((item) =>
    item.id === predecessorFailure.learningId);
  predecessorCandidate.rollback.trialFailureDigest = predecessorFailure.digest;
  const predecessorRevocation = compatibleState.learning.trialFailureRevocations.find((item) =>
    item.id === retryContract.retry.trialFailureRevocationId);
  predecessorRevocation.evaluationDigest = predecessorContract.digest;
  predecessorRevocation.evaluatorBindingDigest = predecessorBinding.digest;
  predecessorRevocation.applicationDigest = predecessorApplication.digest;
  predecessorRevocation.trialFailureDigest = predecessorFailure.digest;
  const predecessorRevocationPayload = { ...predecessorRevocation };
  delete predecessorRevocationPayload.digest;
  predecessorRevocation.digest = hash(JSON.stringify(predecessorRevocationPayload));
  const comparisonDigest = hash(JSON.stringify({
    schema: "agentspine.learning-trial-comparison/v1",
    metric: predecessorContract.metric,
    benchmark: predecessorContract.benchmark,
    evaluatorRoots: predecessorContract.evaluatorRoots,
    thresholds: {
      ...predecessorContract.thresholds,
      minConfidence: predecessorCandidate.promotion.minConfidence,
      minEvidence: predecessorCandidate.promotion.minEvidence
    },
    pairing: predecessorContract.pairing,
    authority: "context-only"
  }));
  const legacyContract = compatibleState.learning.evaluations.find((item) => item.id === retryContract.id);
  const { rootEvaluationId: _rootEvaluationId,
    rootEvaluationDigest: _rootEvaluationDigest, attempt: _attempt, maxAttempts: _maxAttempts,
    digest: _boundedRetryDigest, ...comparableRetryFields } = legacyContract.retry;
  const comparableRetryPayload = {
    ...comparableRetryFields,
    schema: "agentspine.learning-trial-retry/v2",
    trialFailureDigest: predecessorFailure.digest,
    trialFailureRevocationDigest: predecessorRevocation.digest,
    predecessorEvaluationDigest: predecessorContract.digest,
    comparisonDigest
  };
  legacyContract.retry = {
    ...comparableRetryPayload, digest: hash(JSON.stringify(comparableRetryPayload))
  };
  const { digest: _boundedContractDigest, stalenessPolicy: _retryStaleness,
    candidateAdmission: _retryCandidateAdmission,
    blockingDefectPolicy: _retryBlockingDefectPolicy,
    evidenceSourcePolicy: _retryEvidenceSourcePolicy,
    ...comparableContractFields } = legacyContract;
  const comparableContractPayload = {
    ...comparableContractFields, schema: "agentspine.learning-evaluation/v12"
  };
  Object.assign(legacyContract, comparableContractPayload, {
    digest: hash(JSON.stringify(comparableContractPayload))
  });
  delete legacyContract.stalenessPolicy;
  delete legacyContract.candidateAdmission;
  delete legacyContract.blockingDefectPolicy;
  delete legacyContract.evidenceSourcePolicy;
  const legacyBinding = compatibleState.learning.evaluationBindings.find((item) =>
    item.evaluationId === legacyContract.id);
  const { digest: _legacyBindingDigest, ...legacyBindingFields } = legacyBinding;
  Object.assign(legacyBinding, { ...legacyBindingFields, evaluationDigest: legacyContract.digest });
  const legacyBindingPayload = { ...legacyBinding };
  delete legacyBindingPayload.digest;
  legacyBinding.digest = hash(JSON.stringify(legacyBindingPayload));
  await writeFile(compatibleState.learningPath, `${JSON.stringify(compatibleState.learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations.find((item) => item.id === retryContract.id).schema,
    "agentspine.learning-evaluation/v12", "historical v12 retry contracts remain readable");
  const { predecessorEvaluationId: _predecessorEvaluationId,
    predecessorEvaluationDigest: _predecessorEvaluationDigest,
    comparisonDigest: _comparisonDigest, digest: _comparableRetryDigest,
    ...legacyRetryFields } = legacyContract.retry;
  const legacyRetryPayload = { ...legacyRetryFields, schema: "agentspine.learning-trial-retry/v1" };
  legacyContract.retry = { ...legacyRetryPayload, digest: hash(JSON.stringify(legacyRetryPayload)) };
  const { digest: _comparableContractDigest, ...legacyContractFields } = legacyContract;
  const legacyContractPayload = { ...legacyContractFields, schema: "agentspine.learning-evaluation/v11" };
  Object.assign(legacyContract, legacyContractPayload, { digest: hash(JSON.stringify(legacyContractPayload)) });
  legacyBinding.evaluationDigest = legacyContract.digest;
  const legacyV11BindingPayload = { ...legacyBinding };
  delete legacyV11BindingPayload.digest;
  legacyBinding.digest = hash(JSON.stringify(legacyV11BindingPayload));
  await writeFile(compatibleState.learningPath, `${JSON.stringify(compatibleState.learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations.find((item) => item.id === retryContract.id).schema,
    "agentspine.learning-evaluation/v11", "historical v11 retry contracts remain readable");
  await writeFile(compatibleState.learningPath, `${compatibleSnapshot}\n`, "utf8");
  const retryState = await loadLearning(root);
  const originalState = JSON.stringify(retryState.learning);
  const storedExhaustion = retryState.learning.trialRetryExhaustions[0];
  storedExhaustion.rootEvaluationDigest = hash("manipulated synthetic retry root");
  const exhaustionPayload = { ...storedExhaustion };
  delete exhaustionPayload.digest;
  storedExhaustion.digest = hash(JSON.stringify(exhaustionPayload));
  await writeFile(retryState.learningPath, `${JSON.stringify(retryState.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /trial retry exhaustion state is invalid/,
    "a rewritten terminal receipt must fail closed after restart");
  await writeFile(retryState.learningPath, `${originalState}\n`, "utf8");
  const restoredRetryState = await loadLearning(root);
  const storedRetry = restoredRetryState.learning.evaluations.find((item) => item.id === retryContract.id);
  storedRetry.retry.attempt = 1;
  const retryPayload = { ...storedRetry.retry };
  delete retryPayload.digest;
  storedRetry.retry.digest = hash(JSON.stringify(retryPayload));
  const contractPayload = { ...storedRetry };
  delete contractPayload.digest;
  storedRetry.digest = hash(JSON.stringify(contractPayload));
  const storedBinding = restoredRetryState.learning.evaluationBindings.find((item) =>
    item.evaluationId === storedRetry.id);
  storedBinding.evaluationDigest = storedRetry.digest;
  const bindingPayload = { ...storedBinding };
  delete bindingPayload.digest;
  storedBinding.digest = hash(JSON.stringify(bindingPayload));
  await writeFile(restoredRetryState.learningPath, `${JSON.stringify(restoredRetryState.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evaluation state is invalid|trial retry state is invalid|trial failure state is invalid/,
    "a rewritten retry budget must fail closed after restart");
  await writeFile(restoredRetryState.learningPath, `${originalState}\n`, "utf8");
  await assert.rejects(deleteLearning({ root, id: "learning:failure-retry" }),
    /purge the shared subject atomically/);
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:failure-member" })).deleted, 4);
  const deleted = (await loadLearning(root)).learning;
  assert.equal(deleted.trialFailures.length, 0);
  assert.equal(deleted.trialFailureRevocations.length, 0);
  assert.equal(deleted.trialRetryExhaustions.length, 0);
  assert.equal(deleted.history.some((entry) => entry.value?.learningId === "learning:failure-current"), false);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
