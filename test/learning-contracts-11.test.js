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

test("0.14 through 0.27 evaluation contracts remain readable while new contracts freeze exact targets", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:legacy-contract", kind: "behavior", claim: "Use the legacy synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:legacy-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:legacy-contract",
    evidence: evidence("evidence:legacy-contract-two") });
  await evaluation(root, "learning:legacy-contract");
  const { learning, learningPath } = await loadLearning(root);
  const { digest: _digest, pairing: _pairing, evaluatorRoots: _roots, initialTrials: _initial, target: _target,
    completionPolicy: _completionPolicy, stalenessPolicy: _stalenessPolicy,
    blockingDefectPolicy: _blockingPolicy1,
    evidenceSourcePolicy: _evidenceSourcePolicy1,
    candidateAdmission: _candidateAdmission,
    ...currentPayload } = learning.evaluations[0];
  const v1Payload = { ...currentPayload, schema: "agentspine.learning-evaluation/v1" };
  learning.evaluations[0] = { ...v1Payload, digest: hash(JSON.stringify(v1Payload)) };
  learning.evaluationBindings = learning.evaluationBindings.filter((entry) => entry.evaluationId !== "evaluation:fixed");
  await writeFile(learningPath, `${JSON.stringify(learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations[0].schema, "agentspine.learning-evaluation/v1");
  const legacyReceipt = await recordLearningOutcome({
    root, learningId: "learning:legacy-contract",
    ...outcome("outcome:legacy-contract", "before", 0.4, "evaluator:test-a"), coverage: null
  });
  assert.equal(legacyReceipt.receipt.schema, "agentspine.learning-outcome/v4");

  await proposeLearning({
    root, id: "learning:coverage-contract", kind: "behavior", claim: "Use the 0.15 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:coverage-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:coverage-contract",
    evidence: evidence("evidence:coverage-contract-two") });
  await evaluation(root, "learning:coverage-contract", { id: "evaluation:coverage-contract" });
  const coverageState = await loadLearning(root);
  const current = coverageState.learning.evaluations.find((item) => item.id === "evaluation:coverage-contract");
  const { digest: _coverageDigest, pairing: _coveragePairing, evaluatorRoots: _coverageRoots,
    initialTrials: _coverageInitial, target: _coverageTarget, completionPolicy: _coveragePolicy,
    stalenessPolicy: _coverageStaleness, blockingDefectPolicy: _blockingPolicy2,
    evidenceSourcePolicy: _evidenceSourcePolicy2,
    candidateAdmission: _coverageAdmission, ...v3Payload } = current;
  const v2Payload = { ...v3Payload, schema: "agentspine.learning-evaluation/v2" };
  coverageState.learning.evaluations = coverageState.learning.evaluations.map((item) => item.id === current.id
    ? { ...v2Payload, digest: hash(JSON.stringify(v2Payload)) } : item);
  coverageState.learning.evaluationBindings = coverageState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== current.id);
  await writeFile(coverageState.learningPath, `${JSON.stringify(coverageState.learning)}\n`, "utf8");
  const coverageReceipt = await recordLearningOutcome({
    root, learningId: "learning:coverage-contract",
    ...outcome("outcome:coverage-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:coverage-contract", sourceDigest: null
    })
  });
  assert.equal(coverageReceipt.receipt.schema, "agentspine.learning-outcome/v5");

  await proposeLearning({
    root, id: "learning:provenance-contract", kind: "behavior", claim: "Use the 0.16 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:provenance-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:provenance-contract",
    evidence: evidence("evidence:provenance-contract-two") });
  await evaluation(root, "learning:provenance-contract", { id: "evaluation:provenance-contract" });
  const provenanceState = await loadLearning(root);
  const lineageContract = provenanceState.learning.evaluations.find((item) => item.id === "evaluation:provenance-contract");
  const { digest: _lineageDigest, pairing: _lineagePairing, evaluatorRoots: _lineageRoots,
    initialTrials: _lineageInitial, target: _lineageTarget, completionPolicy: _lineagePolicy,
    stalenessPolicy: _lineageStaleness, blockingDefectPolicy: _blockingPolicy3,
    evidenceSourcePolicy: _evidenceSourcePolicy3,
    candidateAdmission: _lineageAdmission, ...v4Payload } = lineageContract;
  const v3ContractPayload = { ...v4Payload, schema: "agentspine.learning-evaluation/v3" };
  provenanceState.learning.evaluations = provenanceState.learning.evaluations.map((item) => item.id === lineageContract.id
    ? { ...v3ContractPayload, digest: hash(JSON.stringify(v3ContractPayload)) } : item);
  provenanceState.learning.evaluationBindings = provenanceState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== lineageContract.id);
  await writeFile(provenanceState.learningPath, `${JSON.stringify(provenanceState.learning)}\n`, "utf8");
  const provenanceReceipt = await recordLearningOutcome({
    root, learningId: "learning:provenance-contract",
    ...outcome("outcome:provenance-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:provenance-contract"
    })
  });
  assert.equal(provenanceReceipt.receipt.schema, "agentspine.learning-outcome/v6");

  await proposeLearning({
    root, id: "learning:lineage-contract", kind: "behavior", claim: "Use the 0.17 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:lineage-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:lineage-contract",
    evidence: evidence("evidence:lineage-contract-two") });
  await evaluation(root, "learning:lineage-contract", { id: "evaluation:lineage-contract" });
  const pairedState = await loadLearning(root);
  const pairedContract = pairedState.learning.evaluations.find((item) => item.id === "evaluation:lineage-contract");
  const { digest: _pairedDigest, pairing: _pairedConfig, evaluatorRoots: _pairedRoots,
    initialTrials: _pairedInitial, target: _pairedTarget, completionPolicy: _pairedPolicy,
    stalenessPolicy: _pairedStaleness, blockingDefectPolicy: _blockingPolicy4,
    evidenceSourcePolicy: _evidenceSourcePolicy4,
    candidateAdmission: _pairedAdmission, ...v4ContractPayload } = pairedContract;
  const compatibleV4Payload = { ...v4ContractPayload, schema: "agentspine.learning-evaluation/v4" };
  pairedState.learning.evaluations = pairedState.learning.evaluations.map((item) => item.id === pairedContract.id
    ? { ...compatibleV4Payload, digest: hash(JSON.stringify(compatibleV4Payload)) } : item);
  pairedState.learning.evaluationBindings = pairedState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== pairedContract.id);
  await writeFile(pairedState.learningPath, `${JSON.stringify(pairedState.learning)}\n`, "utf8");
  const lineageReceipt = await recordLearningOutcome({
    root, learningId: "learning:lineage-contract",
    ...outcome("outcome:lineage-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:lineage-contract"
    })
  });
  assert.equal(lineageReceipt.receipt.schema, "agentspine.learning-outcome/v7");

  await proposeLearning({
    root, id: "learning:paired-contract", kind: "behavior", claim: "Use the 0.18 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:paired-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:paired-contract",
    evidence: evidence("evidence:paired-contract-two") });
  await evaluation(root, "learning:paired-contract", { id: "evaluation:paired-contract" });
  const legacyPairedState = await loadLearning(root);
  const currentPaired = legacyPairedState.learning.evaluations.find((item) => item.id === "evaluation:paired-contract");
  const { digest: _currentPairedDigest, evaluatorRoots: _currentPairedRoots,
    initialTrials: _currentPairedInitial, target: _currentPairedTarget, completionPolicy: _currentPairedPolicy,
    stalenessPolicy: _currentPairedStaleness, blockingDefectPolicy: _blockingPolicy5,
    evidenceSourcePolicy: _evidenceSourcePolicy5,
    candidateAdmission: _currentPairedAdmission,
    ...v5ContractPayload } = currentPaired;
  const compatibleV5Payload = { ...v5ContractPayload, schema: "agentspine.learning-evaluation/v5" };
  legacyPairedState.learning.evaluations = legacyPairedState.learning.evaluations.map((item) => item.id === currentPaired.id
    ? { ...compatibleV5Payload, digest: hash(JSON.stringify(compatibleV5Payload)) } : item);
  legacyPairedState.learning.evaluationBindings = legacyPairedState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== currentPaired.id);
  await writeFile(legacyPairedState.learningPath, `${JSON.stringify(legacyPairedState.learning)}\n`, "utf8");
  const pairedReceipt = await recordLearningOutcome({
    root, learningId: "learning:paired-contract",
    ...outcome("outcome:paired-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:paired-contract"
    })
  });
  assert.equal(pairedReceipt.receipt.schema, "agentspine.learning-outcome/v8");
  const pairedMeasurement = (await loadLearning(root)).learning.measurements
    .find((item) => item.id === "measurement:outcome:paired-contract");
  assert.equal(pairedMeasurement.schema, "agentspine.learning-measurement/v1");

  await proposeLearning({
    root, id: "learning:root-contract", kind: "behavior", claim: "Use the 0.19 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:root-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:root-contract",
    evidence: evidence("evidence:root-contract-two") });
  await evaluation(root, "learning:root-contract", { id: "evaluation:root-contract" });
  const legacyRootState = await loadLearning(root);
  const currentRoot = legacyRootState.learning.evaluations.find((item) => item.id === "evaluation:root-contract");
  const { digest: _currentRootDigest, initialTrials: _currentRootInitial,
    target: _currentRootTarget, completionPolicy: _currentRootPolicy,
    stalenessPolicy: _currentRootStaleness, blockingDefectPolicy: _blockingPolicy6,
    evidenceSourcePolicy: _evidenceSourcePolicy6,
    candidateAdmission: _currentRootAdmission,
    ...v6ContractPayload } = currentRoot;
  const compatibleV6Payload = { ...v6ContractPayload, schema: "agentspine.learning-evaluation/v6" };
  legacyRootState.learning.evaluations = legacyRootState.learning.evaluations.map((item) => item.id === currentRoot.id
    ? { ...compatibleV6Payload, digest: hash(JSON.stringify(compatibleV6Payload)) } : item);
  legacyRootState.learning.evaluationBindings = legacyRootState.learning.evaluationBindings
    .filter((entry) => entry.evaluationId !== currentRoot.id);
  await writeFile(legacyRootState.learningPath, `${JSON.stringify(legacyRootState.learning)}\n`, "utf8");
  const rootReceipt = await recordLearningOutcome({
    root, learningId: "learning:root-contract",
    ...outcome("outcome:root-contract", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:root-contract"
    })
  });
  assert.equal(rootReceipt.receipt.schema, "agentspine.learning-outcome/v9");
  const rootMeasurement = (await loadLearning(root)).learning.measurements
    .find((item) => item.id === "measurement:outcome:root-contract");
  assert.equal(rootMeasurement.schema, "agentspine.learning-measurement/v2");

  await proposeLearning({
    root, id: "learning:initial-contract", kind: "behavior", claim: "Use the 0.26 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:initial-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:initial-contract",
    evidence: evidence("evidence:initial-contract-two") });
  await evaluation(root, "learning:initial-contract", { id: "evaluation:initial-contract" });
  const initialState = await loadLearning(root);
  const targetContract = initialState.learning.evaluations.find((item) => item.id === "evaluation:initial-contract");
  const { digest: _targetContractDigest, target: _targetContractTarget,
    completionPolicy: _targetContractPolicy, stalenessPolicy: _targetContractStaleness,
    blockingDefectPolicy: _blockingPolicy7,
    evidenceSourcePolicy: _evidenceSourcePolicy7,
    candidateAdmission: _targetContractAdmission,
    ...v8ContractPayload } = targetContract;
  const compatibleV8Payload = { ...v8ContractPayload, schema: "agentspine.learning-evaluation/v8" };
  initialState.learning.evaluations = initialState.learning.evaluations.map((item) => item.id === targetContract.id
    ? { ...compatibleV8Payload, digest: hash(JSON.stringify(compatibleV8Payload)) } : item);
  const binding = initialState.learning.evaluationBindings.find((item) => item.evaluationId === targetContract.id);
  const { digest: _bindingDigest, ...bindingPayload } = binding;
  const compatibleBindingPayload = { ...bindingPayload, evaluationDigest: initialState.learning.evaluations
    .find((item) => item.id === targetContract.id).digest };
  initialState.learning.evaluationBindings = initialState.learning.evaluationBindings.map((item) =>
    item.evaluationId === targetContract.id
      ? { ...compatibleBindingPayload, digest: hash(JSON.stringify(compatibleBindingPayload)) } : item);
  await writeFile(initialState.learningPath, `${JSON.stringify(initialState.learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations
    .find((item) => item.id === targetContract.id).schema, "agentspine.learning-evaluation/v8");

  await proposeLearning({
    root, id: "learning:target-contract", kind: "behavior", claim: "Use the 0.27 synthetic strategy.",
    scope: scopedTurn, evidence: evidence("evidence:target-contract-one")
  });
  await addLearningEvidence({ root, id: "learning:target-contract",
    evidence: evidence("evidence:target-contract-two") });
  await evaluation(root, "learning:target-contract", { id: "evaluation:target-contract" });
  const targetState = await loadLearning(root);
  const currentTarget = targetState.learning.evaluations.find((item) => item.id === "evaluation:target-contract");
  const { digest: _currentTargetDigest, completionPolicy: _currentTargetPolicy,
    stalenessPolicy: _currentTargetStaleness, blockingDefectPolicy: _blockingPolicy8,
    evidenceSourcePolicy: _evidenceSourcePolicy8,
    candidateAdmission: _currentTargetAdmission,
    ...v9ContractPayload } = currentTarget;
  const compatibleV9Payload = { ...v9ContractPayload, schema: "agentspine.learning-evaluation/v9" };
  targetState.learning.evaluations = targetState.learning.evaluations.map((item) => item.id === currentTarget.id
    ? { ...compatibleV9Payload, digest: hash(JSON.stringify(compatibleV9Payload)) } : item);
  const targetBinding = targetState.learning.evaluationBindings.find((item) => item.evaluationId === currentTarget.id);
  const { digest: _targetBindingDigest, ...targetBindingPayload } = targetBinding;
  const compatibleTargetBindingPayload = { ...targetBindingPayload, evaluationDigest: targetState.learning.evaluations
    .find((item) => item.id === currentTarget.id).digest };
  targetState.learning.evaluationBindings = targetState.learning.evaluationBindings.map((item) =>
    item.evaluationId === currentTarget.id
      ? { ...compatibleTargetBindingPayload, digest: hash(JSON.stringify(compatibleTargetBindingPayload)) } : item);
  await writeFile(targetState.learningPath, `${JSON.stringify(targetState.learning)}\n`, "utf8");
  assert.equal((await loadLearning(root)).learning.evaluations
    .find((item) => item.id === currentTarget.id).schema, "agentspine.learning-evaluation/v9");
});

test("0.10 learning state upgrades in place and corrupt outcome receipts fail closed", async (t) => {
  const { root } = await fixture(t);
  const { learningPath, catalog } = await loadLearning(root);
  const legacy = {
    schema: "agentspine.learning/v1", root: catalog.root,
    config: { autoPromote: false, minConfidence: 0.85, minEvidence: 2, maxContextItems: 12 },
    candidates: [], history: []
  };
  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const upgraded = (await loadLearning(root)).learning;
  assert.deepEqual(upgraded.outcomes, []);
  assert.deepEqual(upgraded.applications, []);
  assert.deepEqual(upgraded.deliveries, []);
  assert.deepEqual(upgraded.evaluations, []);
  assert.deepEqual(upgraded.measurements, []);
  assert.deepEqual(upgraded.measurementLineage, []);
  assert.deepEqual(upgraded.trialFailures, []);
  assert.deepEqual(upgraded.trialFailureRevocations, []);
  assert.deepEqual(upgraded.trialRetryExhaustions, []);
  assert.deepEqual(upgraded.evaluationRevocations, []);
  assert.deepEqual(upgraded.validationRevocations, []);
  assert.deepEqual(upgraded.evidenceRevocations, []);
  assert.deepEqual(upgraded.measurementRevocations, []);
  assert.deepEqual(upgraded.applicationRevocations, []);
  assert.deepEqual(upgraded.deliveryRevocations, []);
  assert.deepEqual(upgraded.outcomeRevocations, []);
  assert.equal(upgraded.config.minOutcomeReceipts, 2);
  assert.equal(upgraded.config.initialTrialOutcomeTimeoutMinutes, 1440);
  await configureLearning({ root, config: { canaryTtlDays: 7 } });
  assert.equal((await loadLearning(root)).learning.config.canaryTtlDays, 7);

  const corruptApplication = (await loadLearning(root)).learning;
  corruptApplication.applications.push({ schema: "agentspine.learning-application/v1", id: "application:bad" });
  await writeFile(learningPath, `${JSON.stringify(corruptApplication)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning application state is invalid/);

  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const corruptDelivery = (await loadLearning(root)).learning;
  corruptDelivery.deliveries.push({ schema: "agentspine.learning-delivery/v1", id: "delivery:bad" });
  await writeFile(learningPath, `${JSON.stringify(corruptDelivery)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning delivery state is invalid/);

  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const corruptEvaluation = (await loadLearning(root)).learning;
  corruptEvaluation.evaluations.push({ schema: "agentspine.learning-evaluation/v1", id: "evaluation:bad" });
  await writeFile(learningPath, `${JSON.stringify(corruptEvaluation)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning evaluation state is invalid/);

  await writeFile(learningPath, `${JSON.stringify(legacy)}\n`, "utf8");
  const corrupt = (await loadLearning(root)).learning;
  corrupt.outcomes.push({ schema: "agentspine.learning-outcome/v1", id: "outcome:bad" });
  await writeFile(learningPath, `${JSON.stringify(corrupt)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /learning outcome state is invalid/);
  await assert.rejects(configureLearning({ root, config: { canaryTtlDays: 8 } }), /learning outcome state is invalid/);
});

test("concurrent evidence appends serialize without losing observations", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:concurrent", kind: "reference", claim: "Synthetic observations can accumulate.",
    evidence: evidence("evidence:initial")
  });
  await Promise.all(Array.from({ length: 8 }, (_, index) => addLearningEvidence({
    root, id: "learning:concurrent", evidence: evidence(`evidence:parallel-${index}`)
  })));
  const { learning } = await loadLearning(root);
  assert.equal(learning.candidates[0].evidence.length, 9);
  assert.equal(learning.history.filter((entry) => entry.recordId === "learning:concurrent").length, 8);
});

test("session hooks inject accepted learning without a model-side MCP call", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:hook", kind: "correction", claim: "Sensitive synthetic wording stays behind an explicit read.",
    privacy: "shared", evidence: evidence("evidence:hook")
  });
  await reviewLearning({ root, id: "learning:hook", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  const result = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const injected = JSON.parse(result.context);
  assert.equal(injected.briefing.learning.length, 1);
  assert.equal(injected.briefing.learning[0].kind, "correction");
  assert.equal(injected.briefing.learning[0].claim, "Sensitive synthetic wording stays behind an explicit read.");
});

test("malformed learning state fails closed without breaking source indexing or being overwritten", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadLearning(root);
  const corrupt = "{\"schema\":\"wrong\",\"candidates\":[]}";
  await writeFile(loaded.learningPath, corrupt, "utf8");
  await assert.rejects(learningContext({ root }), /structure is invalid/);
  await assert.rejects(
    proposeLearning({ root, kind: "reference", claim: "This must not replace corrupt state.", evidence: evidence("evidence:blocked") }),
    /structure is invalid/
  );
  assert.equal(await readFile(loaded.learningPath, "utf8"), corrupt);
  const hook = await runHook({ hook_event_name: "SessionStart", cwd: root });
  const injected = JSON.parse(hook.context);
  assert.ok(injected.indexedSources >= 2, "both project sources remain indexed alongside any host-global sources");
  assert.equal(injected.failedClosed, true);
  assert.match(injected.error, /learning state structure is invalid/);
});

test("CLI learning workflow proposes, confirms, reads, rolls back, and deletes a fact", async (t) => {
  const { root, state } = await fixture(t);
  runCli([
    "learn-propose", "learning:cli", "--root", root, "--kind", "goal", "--claim", "The synthetic goal is complete.",
    "--evidence", "User stated the goal.", "--privacy", "shared", "--confidence", "0.9", "--json"
  ], state);
  runCli([
    "learn-review", "learning:cli", "--root", root, "--decision", "accept", "--reason", "Confirmed.",
    "--confirmed-by-user", "--json"
  ], state);
  assert.equal(runCli(["learn-context", root, "--json"], state).items[0].id, "learning:cli");
  runCli(["learn-rollback", "learning:cli", "--root", root, "--reason", "No longer current.", "--json"], state);
  assert.equal(runCli(["learn-context", root, "--json"], state).items.length, 0);
  assert.equal(runCli(["learn-delete", "learning:cli", "--root", root, "--json"], state).deleted, true);
});
