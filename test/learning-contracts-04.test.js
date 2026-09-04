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

test("promotion gates are frozen before evaluation and survive config drift, races, and restart", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2041-01-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:promotion-alpha", taskId: "task:promotion" };
  const passingScope = { ...alphaScope, taskId: "task:promotion-pass" };
  const betaScope = { ...passingScope, groupId: "group:promotion-beta" };
  await upsertEntity({ root, id: alphaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: betaScope.groupId, kind: "group", privacy: "shared" });
  await configureLearning({ root, config: {
    autoPromote: true, minConfidence: 0.9, minEvidence: 2,
    minOutcomeReceipts: 2, canaryReceipts: 2
  }, now: start });

  await proposeLearning({
    root, id: "learning:promotion-low", kind: "behavior",
    claim: "Use the low-confidence synthetic promotion strategy.",
    privacy: "group", groupId: alphaScope.groupId, scope: alphaScope,
    evidence: evidence("evidence:promotion-low-one", 0.8), now: start
  });
  await addLearningEvidence({ root, id: "learning:promotion-low",
    evidence: evidence("evidence:promotion-low-two", 0.8), now: start });
  await assert.rejects(evaluation(root, "learning:promotion-low", {
    id: "evaluation:promotion-low", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2041-02-01T00:00:00.000Z"
  }), /already satisfies the frozen confidence and evidence gates/,
  "an ineligible candidate cannot consume a measurement contract");
  assert.equal((await loadLearning(root)).learning.evaluations.length, 0,
    "failed admission leaves no evaluation contract behind");

  const passingAt = new Date(start.getTime() + 3000);
  await configureLearning({ root, config: { minConfidence: 0.9, minEvidence: 2 }, now: passingAt });
  await proposeLearning({
    root, id: "learning:promotion-pass", kind: "behavior",
    claim: "Use the passing synthetic promotion strategy.",
    privacy: "group", groupId: passingScope.groupId, scope: passingScope,
    evidence: evidence("evidence:promotion-pass-one", 0.97), now: passingAt
  });
  await addLearningEvidence({ root, id: "learning:promotion-pass",
    evidence: evidence("evidence:promotion-pass-two", 0.97), now: passingAt });
  const contractInput = {
    id: "evaluation:promotion-pass", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: passingScope, now: passingAt, expiresAt: "2041-02-01T00:00:00.000Z"
  };
  const parallel = await Promise.all(Array.from({ length: 6 }, () =>
    evaluation(root, "learning:promotion-pass", contractInput)));
  assert.equal(parallel.filter((entry) => entry.unchanged === false).length, 1,
    "parallel registration creates exactly one immutable promotion-bound contract");
  const passingContract = parallel[0].contract;
  assert.deepEqual({ minConfidence: passingContract.thresholds.minConfidence,
    minEvidence: passingContract.thresholds.minEvidence }, { minConfidence: 0.9, minEvidence: 2 });
  assert.deepEqual({
    schema: passingContract.candidateAdmission.schema,
    learningId: passingContract.candidateAdmission.learningId,
    targetDigest: passingContract.candidateAdmission.targetDigest,
    minConfidence: passingContract.candidateAdmission.minConfidence,
    minEvidence: passingContract.candidateAdmission.minEvidence,
    observedConfidence: passingContract.candidateAdmission.observedConfidence,
    evidenceCount: passingContract.candidateAdmission.evidenceCount,
    decision: passingContract.candidateAdmission.decision,
    authority: passingContract.candidateAdmission.authority
  }, {
    schema: "agentspine.learning-candidate-admission/v4",
    learningId: "learning:promotion-pass",
    targetDigest: passingContract.target.digest,
    minConfidence: 0.9,
    minEvidence: 2,
    observedConfidence: 0.97,
    evidenceCount: 2,
    decision: "eligible",
    authority: "context-only"
  });
  assert.equal(passingContract.candidateAdmission.evidencePolicy.maxAgeDays, 30);
  assert.equal(passingContract.candidateAdmission.evidencePolicy.minimumIndependentEvidence, 2);
  assert.equal(passingContract.candidateAdmission.evidenceCohort.length, 2);
  assert.match(passingContract.candidateAdmission.digest, /^[a-f0-9]{64}$/);
  await configureLearning({ root, config: { minConfidence: 0.5, minEvidence: 1 },
    now: new Date(passingAt.getTime() + 500) });
  assert.deepEqual((await loadLearning(root)).learning.evaluations.find((entry) => entry.id === passingContract.id)
    .thresholds, passingContract.thresholds,
  "lowering mutable config does not change the pre-admitted candidate gates");
  await configureLearning({ root, config: { minConfidence: 1, minEvidence: 10 },
    now: new Date(passingAt.getTime() + 1000) });
  assert.equal((await loadLearning(root)).learning.evaluations.find((entry) => entry.id === passingContract.id)
    .thresholds.minEvidence, 2, "raising mutable config does not invalidate the contract after restart");
  for (const [index, evaluatorId] of ["evaluator:test-a", "evaluator:test-b"].entries()) {
    await recordLearningOutcome({ root, learningId: "learning:promotion-pass",
      ...outcome(`outcome:promotion-pass-${index}`, "before", 0.4 + index * 0.05, evaluatorId, {
        evaluationId: passingContract.id, scope: passingScope, measuredAt: passingAt
      }), now: passingAt });
  }
  const raised = await evaluateLearning({ root, now: new Date(passingAt.getTime() + 2000) });
  const promoted = raised.accepted.find((entry) => entry.id === "learning:promotion-pass");
  assert.ok(promoted, JSON.stringify(raised));
  assert.equal(promoted.promotion.minConfidence, 0.9);
  assert.equal(promoted.promotion.minEvidence, 2);

  const status = await learningOutcomeStatus({ root, scope: passingScope,
    now: new Date(passingAt.getTime() + 2001) });
  assert.equal(status.promotionBoundEvaluationContracts, 1);
  assert.equal(status.candidateAdmissionEvaluationContracts, 1);
  assert.equal(status.candidateEvidenceCohortEvaluationContracts, 1);
  assert.match(status.records.find((entry) => entry.id === "learning:promotion-pass")
    .activePromotionThresholdDigest, /^[a-f0-9]{64}$/);
  assert.equal(status.records.find((entry) => entry.id === "learning:promotion-pass")
    .activeCandidateAdmissionDigest, passingContract.candidateAdmission.digest);
  assert.equal(status.records.find((entry) => entry.id === "learning:promotion-pass")
    .activeCandidateEvidencePolicyDigest, passingContract.candidateAdmission.evidencePolicy.digest);
  const foreign = await learningOutcomeStatus({ root, scope: betaScope,
    now: new Date(passingAt.getTime() + 2001) });
  assert.equal(foreign.promotionBoundEvaluationContracts, 0);
  assert.equal(foreign.candidateAdmissionEvaluationContracts, 0);
  assert.equal(foreign.candidateEvidenceCohortEvaluationContracts, 0);
  assert.deepEqual(foreign.records, []);
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.promotionBoundEvaluationContracts, 1);
  assert.equal(doctor.learningOutcomes.candidateAdmissionEvaluationContracts, 1);
  assert.equal(doctor.learningOutcomes.candidateEvidenceCohortEvaluationContracts, 1);
  const audit = runCli(["audit", root, "--json"], state);
  assert.equal(audit.ok, true);
  assert.match(audit.gates.find((gate) => gate.name === "Context privacy").detail,
    /1 promotion-bound contracts, 1 candidate-admission contracts/);

  const clean = await loadLearning(root);
  const cleanBytes = `${JSON.stringify(clean.learning)}\n`;
  clean.learning.evaluations.find((entry) => entry.id === passingContract.id).thresholds.minConfidence = 0.5;
  await writeFile(clean.learningPath, `${JSON.stringify(clean.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning evaluation state is invalid/);
  await writeFile(clean.learningPath, cleanBytes, "utf8");
  const admissionTampered = await loadLearning(root);
  admissionTampered.learning.evaluations.find((entry) => entry.id === passingContract.id)
    .candidateAdmission.evidenceCount = 99;
  await writeFile(admissionTampered.learningPath, `${JSON.stringify(admissionTampered.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning evaluation state is invalid/);
  await writeFile(admissionTampered.learningPath, cleanBytes, "utf8");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("candidate admission freezes a fresh evidence cohort before measurement under race and tampering", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2042-01-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:admission-alpha", taskId: "task:admission" };
  const betaScope = { ...alphaScope, groupId: "group:admission-beta" };
  await upsertEntity({ root, id: alphaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: betaScope.groupId, kind: "group", privacy: "shared" });
  await configureLearning({ root, config: { minConfidence: 0.9, minEvidence: 2 }, now: start });
  await proposeLearning({
    root, id: "learning:admission-future", kind: "behavior",
    claim: "Use the independently measured synthetic future-check procedure.",
    privacy: "group", groupId: alphaScope.groupId, scope: alphaScope,
    evidence: evidence("evidence:admission-future-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:admission-future",
    evidence: { ...evidence("evidence:admission-future-two", 0.97),
      observedAt: new Date(start.getTime() + 60_000).toISOString() }, now: start });
  await assert.rejects(evaluation(root, "learning:admission-future", {
    id: "evaluation:admission-future", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2042-02-01T00:00:00.000Z"
  }), /cannot be observed in the future/);
  assert.equal((await loadLearning(root)).learning.evaluations.length, 0,
    "future-dated evidence cannot create a measurement contract");
  await proposeLearning({
    root, id: "learning:admission", kind: "behavior",
    claim: "Use the independently measured synthetic admission procedure.",
    privacy: "group", groupId: alphaScope.groupId, scope: alphaScope,
    evidence: { ...evidence("evidence:admission-old", 0.97),
      observedAt: new Date(start.getTime() - 31 * 86400000).toISOString() }, now: start
  });
  const input = {
    id: "evaluation:admission", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2042-02-01T00:00:00.000Z"
  };
  await addLearningEvidence({ root, id: "learning:admission",
    evidence: evidence("evidence:admission-one", 0.97), now: new Date(start.getTime() + 1000) });
  await assert.rejects(evaluation(root, "learning:admission", { ...input,
    now: new Date(start.getTime() + 1000) }),
    /already satisfies the frozen confidence and evidence gates/);
  assert.equal((await loadLearning(root)).learning.evaluations.length, 0,
    "one fresh observation plus stale history cannot create a measurement contract");
  await addLearningEvidence({ root, id: "learning:admission",
    evidence: evidence("evidence:admission-two", 0.97), now: new Date(start.getTime() + 2000) });
  const attempts = await Promise.all(Array.from({ length: 6 }, () =>
    evaluation(root, "learning:admission", { ...input, now: new Date(start.getTime() + 3000) })));
  assert.equal(attempts.filter((entry) => entry.unchanged === false).length, 1);
  const contract = attempts[0].contract;
  assert.equal(contract.schema, "agentspine.learning-evaluation/v28");
  assert.equal(contract.candidateAdmission.observedConfidence, 0.97);
  assert.equal(contract.candidateAdmission.evidenceCount, 2);
  assert.equal(contract.candidateAdmission.schema, "agentspine.learning-candidate-admission/v4");
  assert.equal(contract.candidateAdmission.evidencePolicy.maxAgeDays, 30);
  assert.equal(contract.candidateAdmission.evidenceCohort.length, 2,
    "stale evidence is excluded from the immutable admission cohort");
  assert.doesNotMatch(JSON.stringify(contract.candidateAdmission.evidenceCohort),
    /Synthetic evidence|evidence:admission/, "the cohort contains digests and metadata, not evidence content or IDs");
  assert.equal(contract.candidateAdmission.targetDigest, contract.target.digest);
  assert.equal((await learningOutcomeStatus({ root, scope: alphaScope, now: start }))
    .candidateAdmissionEvaluationContracts, 1);
  assert.equal((await learningOutcomeStatus({ root, scope: alphaScope, now: start }))
    .candidateEvidenceCohortEvaluationContracts, 1);
  assert.equal((await learningOutcomeStatus({ root, scope: betaScope, now: start }))
    .candidateAdmissionEvaluationContracts, 0);
  assert.equal((await learningOutcomeStatus({ root, scope: betaScope, now: start }))
    .candidateEvidenceCohortEvaluationContracts, 0);
  assert.equal(runCli(["doctor", root, "--json"], state)
    .learningOutcomes.candidateAdmissionEvaluationContracts, 1);
  assert.equal(runCli(["doctor", root, "--json"], state)
    .learningOutcomes.candidateEvidenceCohortEvaluationContracts, 1);
  assert.match(runCli(["audit", root, "--json"], state)
    .gates.find((gate) => gate.name === "Context privacy").detail,
  /1 candidate-admission contracts, 1 candidate-evidence-cohort contracts/);

  const stored = await loadLearning(root);
  const manipulated = stored.learning.evaluations.find((entry) => entry.id === contract.id);
  manipulated.candidateAdmission.evidenceCohort[0].observedAt = new Date(start.getTime() + 2500).toISOString();
  const admissionPayload = { ...manipulated.candidateAdmission };
  delete admissionPayload.digest;
  manipulated.candidateAdmission.digest = hash(JSON.stringify(admissionPayload));
  const contractPayload = { ...manipulated };
  delete contractPayload.digest;
  manipulated.digest = hash(JSON.stringify(contractPayload));
  const binding = stored.learning.evaluationBindings.find((entry) => entry.evaluationId === contract.id);
  binding.evaluationDigest = manipulated.digest;
  const bindingPayload = { ...binding };
  delete bindingPayload.digest;
  binding.digest = hash(JSON.stringify(bindingPayload));
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /candidate admission is invalid or changed/,
    "a re-signed but false evidence cohort fails closed after restart");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("candidate evidence policy survives config drift and historical v18 admission remains readable", async (t) => {
  const { root } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2043-01-01T00:00:00.000Z");
  await configureLearning({ root, config: {
    minConfidence: 0.9, minEvidence: 2, outcomeMaxAgeDays: 30
  }, now: start });
  await proposeLearning({
    root, id: "learning:evidence-policy", kind: "behavior",
    claim: "Use the synthetic fresh-evidence procedure.", scope: scopedTurn,
    evidence: evidence("evidence:policy-one", 0.96), now: start
  });
  await addLearningEvidence({ root, id: "learning:evidence-policy",
    evidence: evidence("evidence:policy-two", 0.96), now: start });
  const registered = await evaluation(root, "learning:evidence-policy", {
    id: "evaluation:evidence-policy", now: start, expiresAt: "2043-02-01T00:00:00.000Z"
  });
  assert.equal(registered.contract.candidateAdmission.evidencePolicy.maxAgeDays, 30);
  await configureLearning({ root, config: { outcomeMaxAgeDays: 1 },
    now: new Date(start.getTime() + 1000) });
  assert.equal((await loadLearning(root)).learning.evaluations[0]
    .candidateAdmission.evidencePolicy.maxAgeDays, 30,
  "mutable configuration cannot shorten an already admitted evidence cohort");

  const stored = await loadLearning(root);
  const current = stored.learning.evaluations.find((entry) => entry.id === registered.contract.id);
  const { digest: _admissionDigest, evidencePolicy: _evidencePolicy,
    evidenceCohort: _evidenceCohort, evidenceSourceAttestations: _evidenceSourceAttestations,
    evidenceLineageDigest: _evidenceLineageDigest,
    ...admissionFields } = current.candidateAdmission;
  const v1AdmissionPayload = {
    ...admissionFields,
    schema: "agentspine.learning-candidate-admission/v1"
  };
  const v1Admission = { ...v1AdmissionPayload, digest: hash(JSON.stringify(v1AdmissionPayload)) };
  const { digest: _contractDigest, blockingDefectPolicy: _blockingDefectPolicy,
    evidenceSourcePolicy: _evidenceSourcePolicy, ...contractFields } = current;
  const v18Payload = {
    ...contractFields,
    schema: "agentspine.learning-evaluation/v18",
    candidateAdmission: v1Admission
  };
  const v18Contract = { ...v18Payload, digest: hash(JSON.stringify(v18Payload)) };
  stored.learning.evaluations = stored.learning.evaluations.map((entry) => entry.id === current.id
    ? v18Contract : entry);
  const binding = stored.learning.evaluationBindings.find((entry) => entry.evaluationId === current.id);
  const { digest: _bindingDigest, ...bindingFields } = binding;
  const v18BindingPayload = { ...bindingFields, evaluationDigest: v18Contract.digest };
  stored.learning.evaluationBindings = stored.learning.evaluationBindings.map((entry) =>
    entry.evaluationId === current.id
      ? { ...v18BindingPayload, digest: hash(JSON.stringify(v18BindingPayload)) } : entry);
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations[0].schema,
    "agentspine.learning-evaluation/v18");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
