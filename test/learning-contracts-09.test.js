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

test("validated learning renews only from fresh independent delivered-turn evidence", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2032-04-01T00:00:00.000Z");
  await establishValidatedLearning(root, {
    learningId: "learning:renewed", evaluationId: "evaluation:renewed", start,
    expiresAt: "2032-06-01T00:00:00.000Z"
  });
  const original = (await loadLearning(root)).learning.validationLeases[0];
  const renewalStarted = new Date("2032-04-20T00:00:00.000Z");
  const window = await beginLearningRevalidation({ root, learningId: "learning:renewed",
    confirmLocalValidation: true, now: renewalStarted });
  assert.equal(window.revalidation.schema, "agentspine.learning-revalidation-window/v4");
  assert.equal(window.revalidation.selection.mode, "first-admitted-trials");
  assert.equal(window.revalidation.selection.requiredDeliveries, 2);
  assert.equal(window.revalidation.selection.evaluatorRoots.length, 2);
  assert.ok(window.revalidation.selection.evaluatorRoots.every((entry) =>
    /^run:revalidation:/.test(entry.runId) && /^[a-f0-9]{64}$/.test(entry.trialDigest)
      && entry.caseCount === 12));
  assert.match(window.revalidation.digest, /^[a-f0-9]{64}$/);
  const projected = await learningContext({ root, scope: scopedTurn, now: renewalStarted });
  assert.equal(projected.items[0].outcomeStatus, "revalidating");

  const evidenceBindings = [];
  for (const [suffix, evaluatorId, value, kind] of [
    ["a", "evaluator:test-a", 0.82, "objective"],
    ["b", "evaluator:test-b", 0.88, "objective"]
  ]) {
    const at = new Date(renewalStarted.getTime() + (suffix === "a" ? 1000 : 2000));
    const delivered = await application(root, "learning:renewed", `renewed-refresh-${suffix}`, at, "revalidating");
    const measurement = (await recordLearningMeasurement({
      root, id: `measurement:renewed-${suffix}`, learningId: "learning:renewed",
      evaluationId: "evaluation:renewed", phase: "after", scope: scopedTurn,
      metric: { name: "fixed-task-success", direction: "higher", value, blockingDefects: 0 },
      measurement: { kind, evaluatorId, runId: delivered.revalidationAdmission.runId,
        sourceDigest: hash(`renewed-source-${suffix}`) },
      coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
      measuredAt: new Date(at.getTime() + 1), confirmLocalMeasurement: true, now: new Date(at.getTime() + 1)
    })).receipt;
    evidenceBindings.push({ measurementId: measurement.id, applicationId: delivered.id,
      deliveryId: delivered.deliveryId });
  }
  const collectingStatus = await learningOutcomeStatus({ root, scope: scopedTurn,
    now: new Date("2032-04-20T00:00:03.000Z") });
  assert.equal(collectingStatus.records[0].revalidationSelectionMode, "first-admitted-trials");
  assert.equal(collectingStatus.records[0].revalidationRequiredDeliveries, 2);
  assert.equal(collectingStatus.records[0].revalidationAdmittedApplications, 2);
  assert.equal(collectingStatus.records[0].revalidationPrecommittedTrials, 2);
  assert.deepEqual(collectingStatus.records[0].revalidationTrials.map((entry) => entry.runId),
    evidenceBindings.map((entry, index) => window.revalidation.selection.evaluatorRoots[index].runId));
  assert.equal(collectingStatus.records[0].revalidationCompletedDeliveries, 2);
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => renewLearningValidation({
    root, learningId: "learning:renewed", evidence: evidenceBindings,
    confirmLocalValidation: true, now: new Date("2032-04-20T00:00:04.000Z")
  })));
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1,
    "parallel renewal must replace evidence exactly once");
  const renewedResult = attempts.find((item) => item.status === "fulfilled").value;
  assert.equal(renewedResult.decision, "renewed");
  assert.equal(renewedResult.lease.schema, "agentspine.learning-validation/v5");
  assert.equal(renewedResult.lease.predecessorValidation.digest, original.digest);
  assert.equal(renewedResult.lease.renewalEvidence.length, 2);
  assert.ok(new Date(renewedResult.lease.expiresAt) > new Date(original.expiresAt));
  assert.equal(JSON.stringify(renewedResult.lease).includes("Use validated synthetic strategy"), false);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.validationLeases.length, 1);
  assert.equal(stored.learning.validationLeases[0].schema, "agentspine.learning-validation/v5");
  assert.equal(stored.learning.history.filter((item) => item.kind === "learning-validation"
    && item.value?.id === original.id).length, 1);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn,
    now: new Date("2032-04-20T00:00:05.000Z") });
  assert.equal(status.records[0].validationLeaseSchema, "agentspine.learning-validation/v5");
  assert.equal(status.records[0].consumedMeasurementReceipts, 6,
    "original outcomes and renewal measurements remain independently accounted");
  assert.equal(status.records[0].revalidationStatus, "not-applicable");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.fixedCohortValidationLeases, 1);
  assert.equal(doctor.learningOutcomes.admissionBoundValidationLeases, 1);
  assert.equal(doctor.learningOutcomes.trialBoundValidationLeases, 1);
  assert.equal(doctor.learningOutcomes.fixedCohortRevalidations, 0);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
  const modernState = JSON.stringify(stored.learning);
  const legacy024 = structuredClone(stored.learning);
  const legacy024HistoricalCandidate = legacy024.history.find((entry) => entry.kind === "learning-candidate"
    && entry.value?.promotion?.canary?.revalidation)?.value;
  const legacy024Window = legacy024HistoricalCandidate.promotion.canary.revalidation;
  legacy024Window.schema = "agentspine.learning-revalidation-window/v3";
  legacy024Window.selection.mode = "first-admitted-turns";
  for (const entry of legacy024Window.selection.evaluatorRoots) {
    delete entry.evaluatorId;
    delete entry.runId;
    delete entry.caseCount;
    delete entry.trialDigest;
  }
  const { digest: _legacy024WindowDigest, ...legacy024WindowPayload } = legacy024Window;
  legacy024Window.digest = hash(JSON.stringify(legacy024WindowPayload));
  const legacy024Lease = legacy024.validationLeases[0];
  for (const applicationReceipt of legacy024.applications.filter((item) =>
    item.schema === "agentspine.learning-application/v4")) {
    applicationReceipt.schema = "agentspine.learning-application/v3";
    delete applicationReceipt.revalidationAdmission.evaluatorId;
    delete applicationReceipt.revalidationAdmission.runId;
    delete applicationReceipt.revalidationAdmission.trialDigest;
    applicationReceipt.revalidationAdmission.revalidationWindowDigest = legacy024Window.digest;
    const { digest: _applicationDigest, ...applicationPayload } = applicationReceipt;
    applicationReceipt.digest = hash(JSON.stringify(applicationPayload));
    const evidence = legacy024Lease.renewalEvidence.find((item) => item.applicationId === applicationReceipt.id);
    if (evidence) evidence.applicationDigest = applicationReceipt.digest;
    const proof = legacy024Lease.selectionProof.applications.find((item) => item.applicationId === applicationReceipt.id);
    if (proof) proof.applicationDigest = applicationReceipt.digest;
  }
  legacy024Lease.schema = "agentspine.learning-validation/v4";
  legacy024Lease.selectionProof.revalidationWindowDigest = legacy024Window.digest;
  legacy024Lease.selectionProof.mode = "first-admitted-turns";
  for (const entry of legacy024Lease.selectionProof.applications) {
    delete entry.evaluatorId;
    delete entry.runId;
    delete entry.trialDigest;
  }
  const { digest: _legacy024LeaseDigest, ...legacy024LeasePayload } = legacy024Lease;
  legacy024Lease.digest = hash(JSON.stringify(legacy024LeasePayload));
  legacy024.candidates.find((item) => item.id === "learning:renewed")
    .promotion.canary.validationLeaseDigest = legacy024Lease.digest;
  await writeFile(stored.learningPath, `${JSON.stringify(legacy024)}\n`, "utf8");
  const compatible024 = await loadLearning(root);
  assert.equal(compatible024.learning.validationLeases[0].schema, "agentspine.learning-validation/v4",
    "0.24 admission-bound leases remain readable after upgrade");
  await writeFile(stored.learningPath, `${modernState}\n`, "utf8");
  const legacy023 = structuredClone(stored.learning);
  const historicalCandidate = legacy023.history.find((entry) => entry.kind === "learning-candidate"
    && entry.value?.promotion?.canary?.revalidation)?.value;
  const historicalWindow = historicalCandidate.promotion.canary.revalidation;
  historicalWindow.schema = "agentspine.learning-revalidation-window/v2";
  historicalWindow.selection.mode = "first-completed-turns";
  const { digest: _windowDigest, ...windowPayload } = historicalWindow;
  historicalWindow.digest = hash(JSON.stringify(windowPayload));
  const legacyLease = legacy023.validationLeases[0];
  for (const applicationReceipt of legacy023.applications.filter((item) =>
    item.schema === "agentspine.learning-application/v4")) {
    applicationReceipt.schema = "agentspine.learning-application/v2";
    delete applicationReceipt.revalidationAdmission;
    const { digest: _applicationDigest, ...applicationPayload } = applicationReceipt;
    applicationReceipt.digest = hash(JSON.stringify(applicationPayload));
    const evidence = legacyLease.renewalEvidence.find((item) => item.applicationId === applicationReceipt.id);
    if (evidence) evidence.applicationDigest = applicationReceipt.digest;
  }
  legacyLease.schema = "agentspine.learning-validation/v3";
  legacyLease.selectionProof = {
    revalidationWindowId: historicalWindow.id,
    revalidationWindowDigest: historicalWindow.digest,
    mode: "first-completed-turns",
    requiredDeliveries: legacyLease.selectionProof.requiredDeliveries,
    deliveries: legacyLease.selectionProof.applications.map((item) => ({
      slot: item.slot, deliveryId: item.deliveryId, deliveryDigest: item.deliveryDigest,
      evaluatorRootDigest: item.evaluatorRootDigest, authority: "context-only"
    })),
    authority: "context-only"
  };
  const { digest: _leaseDigest, ...leasePayload } = legacyLease;
  legacyLease.digest = hash(JSON.stringify(leasePayload));
  legacy023.candidates.find((item) => item.id === "learning:renewed")
    .promotion.canary.validationLeaseDigest = legacyLease.digest;
  await writeFile(stored.learningPath, `${JSON.stringify(legacy023)}\n`, "utf8");
  const compatible = await loadLearning(root);
  assert.equal(compatible.learning.validationLeases[0].schema, "agentspine.learning-validation/v3",
    "0.23 fixed-completion leases remain readable after upgrade");
  await writeFile(stored.learningPath, `${modernState}\n`, "utf8");
  const tampered = await loadLearning(root);
  tampered.learning.validationLeases[0].renewalEvidence[0].measurementDigest = hash("tampered-renewal");
  await writeFile(tampered.learningPath, `${JSON.stringify(tampered.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /validation lease state is invalid|validation lease binding is invalid/);
  await writeFile(stored.learningPath, `${modernState}\n`, "utf8");
  await revokeLearningOutcome({ root, outcomeId: "outcome:renewed-after-a", reasonCode: "binding-invalid",
    reason: "Synthetic predecessor outcome invalidated.", confirmation: "local-outcome-revocation-confirmed",
    now: new Date("2032-04-20T00:00:06.000Z") });
  const transitive = await learningContext({ root, scope: scopedTurn,
    now: new Date("2032-04-20T00:00:07.000Z") });
  assert.deepEqual(transitive.items, []);
  assert.deepEqual(transitive.diagnostics, ["revoked-learning-outcome:learning:renewed"],
    "renewed validation must retain and honor revocation of predecessor outcomes");
  const rolledBack = await evaluateLearning({ root, now: new Date("2032-04-20T00:00:08.000Z") });
  assert.deepEqual(rolledBack.reconciled, [{ id: "learning:renewed", decision: "rolled-back" }]);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("revalidation cannot cherry-pick later turns or swap evaluator roots across fixed cohort slots", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2032-05-01T00:00:00.000Z");
  await establishValidatedLearning(root, {
    learningId: "learning:fixed-cohort", evaluationId: "evaluation:fixed-cohort", start,
    expiresAt: "2032-07-01T00:00:00.000Z"
  });
  const renewalStarted = new Date("2032-05-20T00:00:00.000Z");
  const started = await beginLearningRevalidation({ root, learningId: "learning:fixed-cohort",
    confirmLocalValidation: true, now: renewalStarted });
  const delivered = [];
  for (const [suffix, offset] of [["first", 1000], ["second", 2000], ["replacement", 3000]]) {
    delivered.push(await application(root, "learning:fixed-cohort", `fixed-cohort-${suffix}`,
      new Date(renewalStarted.getTime() + offset), "revalidating"));
  }
  const measurements = new Map();
  for (const [id, evaluatorId, value, runId] of [
    ["first-a", "evaluator:test-a", 0.82, delivered[0].revalidationAdmission.runId],
    ["second-b", "evaluator:test-b", 0.88, delivered[1].revalidationAdmission.runId]
  ]) {
    const measuredAt = new Date(renewalStarted.getTime() + 4000);
    const measurement = (await recordLearningMeasurement({
      root, id: `measurement:${id}`, learningId: "learning:fixed-cohort",
      evaluationId: "evaluation:fixed-cohort", phase: "after", scope: scopedTurn,
      metric: { name: "fixed-task-success", direction: "higher", value, blockingDefects: 0 },
      measurement: { kind: "objective", evaluatorId, runId, sourceDigest: hash(`source:${id}`) },
      coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
      measuredAt, confirmLocalMeasurement: true, now: measuredAt
    })).receipt;
    measurements.set(id, measurement);
  }
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:replacement-a", learningId: "learning:fixed-cohort",
    evaluationId: "evaluation:fixed-cohort", phase: "after", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.99, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a", runId: "run:replacement-a",
      sourceDigest: hash("source:replacement-a") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: new Date(renewalStarted.getTime() + 4000), confirmLocalMeasurement: true,
    now: new Date(renewalStarted.getTime() + 4000)
  }), /precommitted admission slot/,
  "a post-turn replacement run from the correct evaluator root must be rejected before storage");
  await assert.rejects(renewLearningValidation({
    root, learningId: "learning:fixed-cohort", confirmLocalValidation: true,
    evidence: [
      { measurementId: measurements.get("second-b").id, applicationId: delivered[0].id,
        deliveryId: delivered[0].deliveryId },
      { measurementId: measurements.get("first-a").id, applicationId: delivered[1].id,
        deliveryId: delivered[1].deliveryId }
    ], now: new Date(renewalStarted.getTime() + 5000)
  }), /precommitted admission slot/, "evaluator roots must not be reassigned after seeing turn results");
  const renewed = await renewLearningValidation({
    root, learningId: "learning:fixed-cohort", confirmLocalValidation: true,
    evidence: [
      { measurementId: measurements.get("first-a").id, applicationId: delivered[0].id,
        deliveryId: delivered[0].deliveryId },
      { measurementId: measurements.get("second-b").id, applicationId: delivered[1].id,
        deliveryId: delivered[1].deliveryId }
    ], now: new Date(renewalStarted.getTime() + 5000)
  });
  assert.equal(renewed.lease.schema, "agentspine.learning-validation/v5");
  assert.equal(renewed.lease.selectionProof.revalidationWindowDigest, started.revalidation.digest);
  assert.deepEqual(renewed.lease.selectionProof.applications.map((entry) => entry.deliveryId),
    delivered.slice(0, 2).map((entry) => entry.deliveryId));
  assert.equal(renewed.lease.selectionProof.applications.some((entry) =>
    entry.deliveryId === delivered[2].deliveryId), false);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
  const tampered = await loadLearning(root);
  tampered.learning.validationLeases[0].selectionProof.applications[0].trialDigest = hash("tampered-trial");
  await writeFile(tampered.learningPath, `${JSON.stringify(tampered.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /validation lease state is invalid|validation lease binding is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("an admitted turn that never completes cannot be hidden behind later successful turns", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2032-06-01T00:00:00.000Z");
  await establishValidatedLearning(root, {
    learningId: "learning:admission-cohort", evaluationId: "evaluation:admission-cohort", start,
    expiresAt: "2032-08-01T00:00:00.000Z"
  });
  const renewalStarted = new Date("2032-06-20T00:00:00.000Z");
  await beginLearningRevalidation({ root, learningId: "learning:admission-cohort",
    confirmLocalValidation: true, now: renewalStarted });
  const abandoned = await projectedApplication(root, "learning:admission-cohort", "admission-abandoned",
    new Date(renewalStarted.getTime() + 1000), "revalidating");
  const second = await application(root, "learning:admission-cohort", "admission-second",
    new Date(renewalStarted.getTime() + 2000), "revalidating");
  const later = await application(root, "learning:admission-cohort", "admission-later",
    new Date(renewalStarted.getTime() + 3000), "revalidating");
  assert.equal(abandoned.schema, "agentspine.learning-application/v4");
  assert.equal(abandoned.revalidationAdmission.slot, 1);
  assert.equal(second.schema, "agentspine.learning-application/v4");
  assert.equal(second.revalidationAdmission.slot, 2);
  assert.equal(later.schema, "agentspine.learning-application/v2",
    "turns after the bounded admission cohort remain normal evidence but cannot replace a slot");

  const secondMeasurement = (await recordLearningMeasurement({
    root, id: "measurement:admission-second", learningId: "learning:admission-cohort",
    evaluationId: "evaluation:admission-cohort", phase: "after", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.9, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-b",
      runId: second.revalidationAdmission.runId, sourceDigest: hash("source:admission-second") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: new Date(renewalStarted.getTime() + 4000), confirmLocalMeasurement: true,
    now: new Date(renewalStarted.getTime() + 4000)
  })).receipt;
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:admission-later", learningId: "learning:admission-cohort",
    evaluationId: "evaluation:admission-cohort", phase: "after", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.99, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a", runId: "run:admission-later",
      sourceDigest: hash("source:admission-later") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: new Date(renewalStarted.getTime() + 4000), confirmLocalMeasurement: true,
    now: new Date(renewalStarted.getTime() + 4000)
  }), /precommitted admission slot/);
  await assert.rejects(renewLearningValidation({
    root, learningId: "learning:admission-cohort", confirmLocalValidation: true,
    evidence: [
      { measurementId: secondMeasurement.id, applicationId: second.id, deliveryId: second.deliveryId }
    ], now: new Date(renewalStarted.getTime() + 5000)
  }), /complete precommitted admission cohort|exactly 2 evidence bindings|cannot omit or replace a precommitted admitted turn/);
  const purge = await purgeStaleLearningApplications({ root, confirmation: "local-user-purge-confirmed",
    now: new Date(renewalStarted.getTime() + 10 * 60_000) });
  assert.equal(purge.purged, 0, "an incomplete admitted slot is durable evidence and cannot be purged away");
  const status = await learningOutcomeStatus({ root, scope: scopedTurn,
    now: new Date(renewalStarted.getTime() + 10 * 60_000) });
  assert.equal(status.records[0].revalidationAdmittedApplications, 2);
  assert.equal(status.records[0].revalidationCompletedDeliveries, 1);
  assert.equal(status.records[0].stalePendingApplications, 1);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);

  const tampered = await loadLearning(root);
  const admitted = tampered.learning.applications.find((item) => item.id === abandoned.id);
  admitted.revalidationAdmission.evaluatorRootDigest = hash("swapped-admission-root");
  const { digest: _discarded, ...payload } = admitted;
  admitted.digest = hash(JSON.stringify(payload));
  await writeFile(tampered.learningPath, `${JSON.stringify(tampered.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /revalidation admission state is invalid/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("one blocking defect defeats positive revalidation averages and restores a superseded lesson", async (t) => {
  const { root } = await fixture(t);
  const start = new Date("2032-07-01T00:00:00.000Z");
  await proposeLearning({ root, id: "learning:renewal-prior", kind: "behavior",
    claim: "Use the prior synthetic strategy.", privacy: "shared", scope: scopedTurn,
    evidence: evidence("evidence:renewal-prior"), now: start });
  await reviewLearning({ root, id: "learning:renewal-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await establishValidatedLearning(root, {
    learningId: "learning:renewal-block", evaluationId: "evaluation:renewal-block", start,
    expiresAt: "2032-09-01T00:00:00.000Z", supersedesId: "learning:renewal-prior"
  });
  const renewalStarted = new Date("2032-07-20T00:00:00.000Z");
  await beginLearningRevalidation({ root, learningId: "learning:renewal-block",
    confirmLocalValidation: true, now: renewalStarted });
  const evidenceBindings = [];
  for (const [suffix, evaluatorId, blockingDefects] of [["a", "evaluator:test-a", 0], ["b", "evaluator:test-b", 1]]) {
    const at = new Date(renewalStarted.getTime() + (suffix === "a" ? 1000 : 2000));
    const delivered = await application(root, "learning:renewal-block", `renewal-block-refresh-${suffix}`, at, "revalidating");
    const measurement = (await recordLearningMeasurement({
      root, id: `measurement:renewal-block-${suffix}`, learningId: "learning:renewal-block",
      evaluationId: "evaluation:renewal-block", phase: "after", scope: scopedTurn,
      metric: { name: "fixed-task-success", direction: "higher", value: 1, blockingDefects },
      measurement: { kind: "objective", evaluatorId, runId: delivered.revalidationAdmission.runId,
        sourceDigest: hash(`renewal-block-source-${suffix}`) },
      coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
      measuredAt: new Date(at.getTime() + 1), confirmLocalMeasurement: true, now: new Date(at.getTime() + 1)
    })).receipt;
    evidenceBindings.push({ measurementId: measurement.id, applicationId: delivered.id, deliveryId: delivered.deliveryId });
  }
  const result = await renewLearningValidation({ root, learningId: "learning:renewal-block",
    evidence: evidenceBindings, confirmLocalValidation: true,
    now: new Date("2032-07-20T00:00:04.000Z") });
  assert.equal(result.decision, "rolled-back");
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date("2032-07-20T00:00:05.000Z") })).items.map((item) => item.id), ["learning:renewal-prior"]);
});

test("validated evidence leases expire before context and roll back atomically under parallel reconciliation", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2033-01-01T00:00:00.000Z");
  await proposeLearning({
    root, id: "learning:lease-prior", kind: "behavior", claim: "Use stable synthetic strategy prior.",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:lease-prior"), now: start
  });
  await reviewLearning({ root, id: "learning:lease-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  const validated = await establishValidatedLearning(root, {
    learningId: "learning:lease-expiry", evaluationId: "evaluation:lease-expiry", start,
    expiresAt: "2033-01-10T00:00:00.000Z", supersedesId: "learning:lease-prior"
  });
  assert.equal(validated.decision, "validated");
  const currentContext = await learningContext({ root, scope: scopedTurn,
    now: new Date("2033-01-02T00:00:00.000Z") });
  assert.deepEqual(currentContext.items.map((item) => item.id), ["learning:lease-expiry"], JSON.stringify(currentContext));

  const expiredAt = new Date("2033-01-10T00:00:00.000Z");
  const staleContext = await learningContext({ root, scope: scopedTurn, now: expiredAt });
  assert.equal(staleContext.degraded, true);
  assert.equal(staleContext.items.length, 0, "expired validated evidence must be absent before the next model turn");
  assert.deepEqual(staleContext.diagnostics, ["stale-validated-learning:learning:lease-expiry"]);
  const reconciliations = await Promise.all(Array.from({ length: 6 }, () => evaluateLearning({ root, now: expiredAt })));
  assert.equal(reconciliations.flatMap((item) => item.reconciled)
    .filter((item) => item.id === "learning:lease-expiry" && item.decision === "rolled-back").length, 1);
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date("2033-01-10T00:00:01.000Z") })).items.map((item) => item.id), ["learning:lease-prior"]);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.validationLeases.length, 0);
  assert.equal(stored.learning.history.filter((item) => item.kind === "learning-validation").length, 1,
    "expired proof remains immutable rollback history, not active context state");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("validated learning is removed when its evaluator root is revoked", async (t) => {
  const { root } = await fixture(t);
  const start = new Date("2034-01-01T00:00:00.000Z");
  const validated = await establishValidatedLearning(root, {
    learningId: "learning:lease-revoked", evaluationId: "evaluation:lease-revoked", start,
    expiresAt: "2034-02-01T00:00:00.000Z"
  });
  assert.equal(validated.decision, "validated");
  await revokeLearningEvaluator({ root, id: "evaluator:test-a", reason: "Synthetic evaluator retired.",
    confirmLocalEvaluator: true, now: new Date("2034-01-01T00:00:04.000Z") });
  const context = await learningContext({ root, scope: scopedTurn, now: new Date("2034-01-01T00:00:05.000Z") });
  assert.equal(context.items.length, 0);
  assert.deepEqual(context.diagnostics, ["revoked-evaluator-validated-learning:learning:lease-revoked"]);
  const reconciled = await evaluateLearning({ root, now: new Date("2034-01-01T00:00:05.000Z") });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:lease-revoked", decision: "rolled-back" }]);
  assert.equal((await learningOutcomeStatus({ root })).records[0].status, "rolled-back");
});
