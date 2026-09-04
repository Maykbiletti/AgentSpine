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

test("locally attested evidence sources reject relabeling before measurement and survive race and tampering", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2043-06-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:evidence-source-alpha" };
  const betaScope = { ...alphaScope, groupId: "group:evidence-source-beta" };
  await upsertEntity({ root, id: alphaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: betaScope.groupId, kind: "group", privacy: "shared" });
  await configureLearning({ root, config: { minConfidence: 0.9, minEvidence: 2 }, now: start });
  await proposeLearning({
    root, id: "learning:evidence-source", kind: "behavior",
    claim: "Use the objectively anchored synthetic source-quorum procedure.",
    privacy: "group", groupId: alphaScope.groupId, scope: alphaScope,
    evidence: { ...evidence("evidence:source-chat-one", 0.97), type: "interaction" }, now: start
  });
  await addLearningEvidence({ root, id: "learning:evidence-source",
    evidence: { ...evidence("evidence:source-chat-two", 0.97), type: "interaction" }, now: start });
  const input = {
    id: "evaluation:evidence-source", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2043-07-01T00:00:00.000Z"
  };
  await assert.rejects(evaluation(root, "learning:evidence-source", input),
    /explicit-user or objective-test evidence; interaction- or document-only cohorts are insufficient/);
  assert.equal((await loadLearning(root)).learning.evaluations.length, 0,
    "chat-only evidence cannot open a measurement contract");
  await addLearningEvidence({ root, id: "learning:evidence-source",
    evidence: { ...evidence("evidence:source-test-anchor", 0.97), type: "test" }, now: start });
  await assert.rejects(evaluation(root, "learning:evidence-source", {
    ...input, confirmLocalEvidenceSources: false
  }), /qualifying evidence sources require explicit local confirmation/);
  assert.equal((await loadLearning(root)).learning.evaluations.length, 0,
    "a self-labeled source cannot open a contract without local attestation");
  const attempts = await Promise.all(Array.from({ length: 6 }, () =>
    evaluation(root, "learning:evidence-source", input)));
  assert.equal(attempts.filter((entry) => entry.unchanged === false).length, 1);
  const contract = attempts[0].contract;
  assert.equal(contract.schema, "agentspine.learning-evaluation/v28");
  assert.deepEqual(contract.evidenceSourcePolicy, {
    schema: "agentspine.learning-evidence-source-policy/v2",
    qualifyingTypes: ["user-statement", "test"],
    minimumQualifyingEvidence: 1,
    documentOnly: "insufficient",
    interactionOnly: "insufficient",
    qualifyingEvidence: "explicit-local-attestation-required",
    insufficientCohort: "reject-before-evaluation",
    authority: "context-only",
    digest: contract.evidenceSourcePolicy.digest
  });
  assert.equal(contract.candidateAdmission.schema, "agentspine.learning-candidate-admission/v4");
  assert.equal(contract.candidateAdmission.evidenceSourceAttestations.length, 1);
  assert.equal(contract.candidateAdmission.evidenceSourceAttestations[0].sourceClass, "objective-test");
  assert.doesNotMatch(JSON.stringify(contract.candidateAdmission.evidenceSourceAttestations),
    /Synthetic evidence|source-test-anchor/);
  assert.doesNotMatch(JSON.stringify(contract.evidenceSourcePolicy), /Synthetic evidence|source-test-anchor/);
  const status = await learningOutcomeStatus({ root, scope: alphaScope, now: start });
  assert.equal(status.evidenceSourceBoundEvaluationContracts, 1);
  assert.equal(status.evidenceSourceAttestedEvaluationContracts, 1);
  assert.equal(status.records[0].activeEvidenceSourcePolicyDigest,
    contract.evidenceSourcePolicy.digest);
  assert.equal(status.records[0].activeEvidenceSourceAttestationDigest,
    hash(JSON.stringify(contract.candidateAdmission.evidenceSourceAttestations)));
  assert.equal((await learningOutcomeStatus({ root, scope: betaScope, now: start }))
    .evidenceSourceBoundEvaluationContracts, 0);
  assert.equal((await learningOutcomeStatus({ root, scope: betaScope, now: start }))
    .evidenceSourceAttestedEvaluationContracts, 0);
  assert.equal(runCli(["doctor", root, "--json"], state)
    .learningOutcomes.evidenceSourceBoundEvaluationContracts, 1);
  assert.equal(runCli(["doctor", root, "--json"], state)
    .learningOutcomes.evidenceSourceAttestedEvaluationContracts, 1);
  assert.match(runCli(["audit", root, "--json"], state)
    .gates.find((gate) => gate.name === "Context privacy").detail,
  /1 evidence-source-bound contracts, 1 evidence-source-attested contracts/);

  const stored = await loadLearning(root);
  const manipulated = stored.learning.evaluations[0];
  manipulated.candidateAdmission.evidenceSourceAttestations[0].sourceClass = "explicit-user-feedback";
  const admissionPayload = { ...manipulated.candidateAdmission };
  delete admissionPayload.digest;
  manipulated.candidateAdmission.digest = hash(JSON.stringify(admissionPayload));
  const contractPayload = { ...manipulated };
  delete contractPayload.digest;
  manipulated.digest = hash(JSON.stringify(contractPayload));
  const binding = stored.learning.evaluationBindings[0];
  binding.evaluationDigest = manipulated.digest;
  const bindingPayload = { ...binding };
  delete bindingPayload.digest;
  binding.digest = hash(JSON.stringify(bindingPayload));
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evaluation (?:contract structure|state) is invalid/,
    "a re-signed false source attestation fails closed after restart");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

+test("qualifying candidate evidence is single-use per exact scope across races, deletion, purge, and restart", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2043-08-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:evidence-lineage-alpha" };
  const betaScope = { ...scopedTurn, groupId: "group:evidence-lineage-beta" };
  const subjectId = "person:evidence-lineage-member";
  await upsertEntity({ root, id: alphaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: betaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: subjectId, kind: "person", privacy: "group" });
  await linkEntities({ root, from: subjectId, to: alphaScope.groupId,
    relation: "member-of", privacy: "group" });
  await linkEntities({ root, from: subjectId, to: betaScope.groupId,
    relation: "member-of", privacy: "group" });
  await configureLearning({ root, config: { minConfidence: 0.9, minEvidence: 2 }, now: start });
  const sharedUserEvidence = evidence("evidence:single-use-user", 0.97);
  const sharedTestEvidence = { ...evidence("evidence:single-use-test", 0.97), type: "test" };
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    id: `learning:evidence-lineage-race-${index}`,
    claim: `Use synthetic single-use evidence strategy ${index}.`
  }));
  for (const candidate of candidates) {
    await proposeLearning({ root, ...candidate, kind: "behavior", subjectId,
      privacy: "group", groupId: alphaScope.groupId, scope: alphaScope,
      evidence: sharedUserEvidence, now: start });
    await addLearningEvidence({ root, id: candidate.id, evidence: sharedTestEvidence, now: start });
  }
  const attempts = await Promise.allSettled(candidates.map((candidate, index) =>
    evaluation(root, candidate.id, {
      id: `evaluation:evidence-lineage-race-${index}`,
      evaluatorIds: ["evaluator:test-a", "evaluator:test-b"], scope: alphaScope,
      now: start, expiresAt: "2043-09-01T00:00:00.000Z"
    })));
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected"
    && /already admitted in this exact scope/.test(entry.reason.message)).length, 5);
  const winnerIndex = attempts.findIndex((entry) => entry.status === "fulfilled");
  const winner = candidates[winnerIndex];
  const winnerResult = attempts[winnerIndex].value;
  assert.equal(winnerResult.contract.schema, "agentspine.learning-evaluation/v28");
  assert.equal(winnerResult.contract.candidateAdmission.schema,
    "agentspine.learning-candidate-admission/v4");
  let stored = await loadLearning(root);
  assert.equal(stored.learning.candidateEvidenceLineage.length, 2);
  assert.equal(stored.learning.candidateEvidenceLineage.every((entry) =>
    entry.schema === "agentspine.learning-candidate-evidence-lineage/v1"), true);
  assert.equal(winnerResult.contract.candidateAdmission.evidenceLineageDigest,
    hash(JSON.stringify(stored.learning.candidateEvidenceLineage)));
  assert.doesNotMatch(JSON.stringify(stored.learning.candidateEvidenceLineage),
    /Synthetic evidence|single-use-user|single-use-test/);
  const alphaStatus = await learningOutcomeStatus({ root, scope: alphaScope, now: start });
  assert.equal(alphaStatus.candidateEvidenceLineageReceipts, 2);
  assert.equal(alphaStatus.candidateEvidenceLineageEvaluationContracts, 1);
  assert.equal(alphaStatus.records.find((record) => record.id === winner.id)
    .activeCandidateEvidenceLineageDigest,
  winnerResult.contract.candidateAdmission.evidenceLineageDigest);
  assert.equal((await learningOutcomeStatus({ root, scope: betaScope, now: start }))
    .candidateEvidenceLineageReceipts, 0);

  await deleteLearning({ root, id: winner.id });
  stored = await loadLearning(root);
  assert.equal(stored.learning.candidateEvidenceLineage.length, 2,
    "single-use lineage survives ordinary candidate deletion");
  await proposeLearning({ root, id: "learning:evidence-lineage-replay", kind: "behavior",
    claim: "Use a replayed synthetic evidence strategy.", subjectId,
    privacy: "group", groupId: alphaScope.groupId, scope: alphaScope,
    evidence: sharedUserEvidence, now: start });
  await addLearningEvidence({ root, id: "learning:evidence-lineage-replay",
    evidence: sharedTestEvidence, now: start });
  await assert.rejects(evaluation(root, "learning:evidence-lineage-replay", {
    id: winnerResult.contract.id, evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2043-09-01T00:00:00.000Z"
  }), /already admitted in this exact scope/,
  "deleting the original evaluation cannot reopen an exact-ID replay");

  await proposeLearning({ root, id: "learning:evidence-lineage-beta", kind: "behavior",
    claim: "Use a scope-isolated synthetic evidence strategy.", subjectId,
    privacy: "group", groupId: betaScope.groupId, scope: betaScope,
    evidence: sharedUserEvidence, now: start });
  await addLearningEvidence({ root, id: "learning:evidence-lineage-beta",
    evidence: sharedTestEvidence, now: start });
  await evaluation(root, "learning:evidence-lineage-beta", {
    id: "evaluation:evidence-lineage-beta", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: betaScope, now: start, expiresAt: "2043-09-01T00:00:00.000Z"
  });
  assert.equal((await learningOutcomeStatus({ root, scope: betaScope, now: start }))
    .candidateEvidenceLineageReceipts, 2, "foreign exact scope has an independent lineage");
  assert.equal((await learningOutcomeStatus({ root, scope: alphaScope, now: start }))
    .candidateEvidenceLineageReceipts, 2, "foreign lineage count does not leak");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.candidateEvidenceLineageReceipts, 4);
  assert.equal(doctor.learningOutcomes.candidateEvidenceLineageEvaluationContracts, 1);
  assert.equal(runCli(["audit", root, "--json"], state)
    .learningDiagnostics.candidateEvidenceLineageReceipts, 4);

  stored = await loadLearning(root);
  const original = JSON.stringify(stored.learning);
  stored.learning.candidateEvidenceLineage[0].independenceDigest = hash("redirected single-use evidence");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /candidate evidence lineage state is invalid/,
    "re-signed or redirected lineage fails closed after restart");
  await writeFile(stored.learningPath, `${original}\n`, "utf8");
  assert.equal((await purgeLearningBySubject({ root, subjectId })).deleted, 7);
  stored = await loadLearning(root);
  assert.equal(stored.learning.candidates.length, 0);
  assert.equal(stored.learning.candidateEvidenceLineage.length, 4,
    "content-free replay tombstones survive subject purge");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("locally revoked evidence source attestations withhold and roll back their complete learning lineage", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2043-09-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:source-revocation-alpha" };
  const betaScope = { ...scopedTurn, groupId: "group:source-revocation-beta" };
  await upsertEntity({ root, id: alphaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: betaScope.groupId, kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:source-revocation-member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:source-revocation-member", to: alphaScope.groupId,
    relation: "member-of", privacy: "group" });
  await proposeLearning({ root, id: "learning:source-revocation-prior", kind: "behavior",
    claim: "Use the prior synthetic source-confirmation procedure.",
    subjectId: "person:source-revocation-member", privacy: "group", groupId: alphaScope.groupId,
    scope: alphaScope,
    evidence: evidence("evidence:source-revocation-prior", 0.97), now: start });
  await reviewLearning({ root, id: "learning:source-revocation-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await establishValidatedLearning(root, {
    learningId: "learning:source-revocation-current",
    evaluationId: "evaluation:source-revocation-current",
    start,
    expiresAt: "2043-10-01T00:00:00.000Z",
    supersedesId: "learning:source-revocation-prior",
    subjectId: "person:source-revocation-member",
    privacy: "group",
    groupId: alphaScope.groupId,
    scope: alphaScope
  });
  const before = (await loadLearning(root)).learning;
  const contract = before.evaluations.find((item) => item.id === "evaluation:source-revocation-current");
  const candidate = before.candidates.find((item) => item.id === "learning:source-revocation-current");
  const attestation = contract.candidateAdmission.evidenceSourceAttestations[0];
  const after = before.outcomes.find((item) => item.id === candidate.promotion.canary.afterReceipts[0]);
  await assert.rejects(revokeLearningEvidenceSourceAttestation({ root, evaluationId: contract.id,
    evidenceDigest: attestation.evidenceDigest, reasonCode: "source-class-invalid",
    reason: "Synthetic source classification invalidated." }), /explicit local confirmation/);
  const input = { root, evaluationId: contract.id, evidenceDigest: attestation.evidenceDigest,
    reasonCode: "source-class-invalid", reason: "Synthetic source classification invalidated.",
    confirmation: "local-evidence-source-attestation-revocation-confirmed", now: start };
  const attempts = await Promise.all(Array.from({ length: 6 }, () =>
    revokeLearningEvidenceSourceAttestation(input)));
  assert.equal(attempts.filter((entry) => entry.unchanged === false).length, 1);
  assert.equal((await revokeLearningEvidenceSourceAttestation({ ...input,
    now: new Date(start.getTime() + 1000) })).unchanged, true);
  await assert.rejects(revokeLearningEvidenceSourceAttestation({ ...input, reasonCode: "confirmation-invalid",
    reason: "Synthetic conflicting reason." }), /immutable/);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.evidenceSourceAttestationRevocations.length, 1);
  const receipt = stored.learning.evidenceSourceAttestationRevocations[0];
  assert.equal(receipt.evaluationDigest, contract.digest);
  assert.equal(receipt.candidateAdmissionDigest, contract.candidateAdmission.digest);
  assert.equal(receipt.independenceDigest, attestation.independenceDigest);
  assert.equal(receipt.sourceClass, attestation.sourceClass);
  assert.equal(receipt.targetDigest, contract.target.digest);
  assert.equal(JSON.stringify(receipt).includes("Synthetic source classification invalidated"), false);
  assert.deepEqual((await learningContext({ root, groupId: alphaScope.groupId, scope: alphaScope,
    now: new Date(start.getTime() + 2000) })).diagnostics,
  ["revoked-learning-evidence-source-attestation:learning:source-revocation-current"]);
  assert.deepEqual((await learningContext({ root, groupId: betaScope.groupId, scope: betaScope,
    now: new Date(start.getTime() + 2000) })).diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: alphaScope,
    now: new Date(start.getTime() + 2000) });
  assert.equal(status.evidenceSourceAttestationRevocations, 1);
  assert.equal(status.records.find((item) => item.id === candidate.id).canaryStatus,
    "revoked-evidence-source-attestation");
  assert.equal((await learningOutcomeStatus({ root,
    scope: betaScope,
    now: new Date(start.getTime() + 2000) })).evidenceSourceAttestationRevocations, 0);
  const cli = runCli(["learn-evidence-source-attestation-revoke", contract.id, "--root", root,
    "--evidence-digest", attestation.evidenceDigest, "--reason-code", "source-class-invalid",
    "--reason", "Synthetic source classification invalidated.",
    "--confirm-local-evidence-source-attestation-revocation", "--json"], state);
  assert.equal(cli.receipt.schema, "agentspine.learning-evidence-source-attestation-revocation/v1");
  assert.equal(runCli(["doctor", root, "--json"], state)
    .learningOutcomes.evidenceSourceAttestationRevocationReceipts, 1);
  await assert.rejects(recordLearningMeasurement({ root, id: "measurement:source-revocation-replay",
    learningId: candidate.id, evaluationId: contract.id, phase: "after", scope: alphaScope,
    metric: { name: contract.metric.name, direction: contract.metric.direction, value: 0.9 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a",
      runId: "run:source-revocation-replay", sourceDigest: hash("source-revocation-replay") },
    coverage: { datasetDigest: contract.benchmark.datasetDigest, caseCount: contract.benchmark.minCases },
    confirmLocalMeasurement: true, now: new Date(start.getTime() + 2000) }),
  /evidence source attestation was explicitly revoked/);
  await assert.rejects(commitLearningOutcome({ root, id: "outcome:source-revocation-replay",
    learningId: candidate.id, evaluationId: contract.id, measurementReceiptId: after.measurementReceiptId,
    applicationId: after.applicationId, deliveryId: after.deliveryId,
    now: new Date(start.getTime() + 2000) }), /evidence source attestation was explicitly revoked/);
  const original = JSON.stringify(stored.learning);
  stored.learning.evidenceSourceAttestationRevocations[0].independenceDigest = hash("redirected attestation");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evidence source attestation revocation state is invalid/);
  await writeFile(stored.learningPath, `${original}\n`, "utf8");
  const reconciliations = await Promise.all(Array.from({ length: 6 }, () =>
    evaluateLearning({ root, now: new Date(start.getTime() + 3000) })));
  assert.equal(reconciliations.flatMap((result) => result.reconciled)
    .filter((item) => item.id === candidate.id && item.decision === "rolled-back").length, 1);
  const rolledBack = (await loadLearning(root)).learning.candidates.find((item) => item.id === candidate.id);
  assert.equal(rolledBack.rollback.mode, "automatic-evidence-source-attestation-revocation");
  assert.equal(runCli(["audit", root, "--json"], state)
    .learningDiagnostics.evidenceSourceAttestationRevocations, 1);
  assert.deepEqual((await learningContext({ root, groupId: alphaScope.groupId, scope: alphaScope,
    now: new Date(start.getTime() + 4000) })).items.map((item) => item.id),
  ["learning:source-revocation-prior"]);
  await deleteLearning({ root, id: candidate.id });
  assert.equal((await loadLearning(root)).learning.evidenceSourceAttestationRevocations.length, 0);
  assert.equal((await purgeLearningBySubject({ root,
    subjectId: "person:source-revocation-member" })).deleted, 1);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("one frozen baseline blocking defect prevents Canary admission and cannot be averaged away", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2044-01-01T00:00:00.000Z");
  await configureLearning({ root, config: {
    autoPromote: true, minConfidence: 0.9, minEvidence: 2, minOutcomeReceipts: 2
  }, now: start });
  await proposeLearning({
    root, id: "learning:blocking-baseline", kind: "behavior",
    claim: "Use the synthetic blocking-defect-safe procedure.", scope: scopedTurn,
    evidence: evidence("evidence:blocking-baseline-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:blocking-baseline",
    evidence: evidence("evidence:blocking-baseline-two", 0.97), now: start });
  const registered = await evaluation(root, "learning:blocking-baseline", {
    id: "evaluation:blocking-baseline", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    now: start, expiresAt: "2044-02-01T00:00:00.000Z"
  });
  assert.equal(registered.contract.schema, "agentspine.learning-evaluation/v28");
  assert.equal(registered.contract.blockingDefectPolicy.aggregation, "any-defect-overrides-average");
  assert.equal(registered.contract.blockingDefectPolicy.beforeAction, "block-canary-admission");
  await recordLearningOutcome({ root, learningId: "learning:blocking-baseline",
    ...outcome("outcome:blocking-before-a", "before", 0.99, "evaluator:test-a", {
      evaluationId: registered.contract.id, blockingDefects: 1, measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:blocking-baseline",
    ...outcome("outcome:blocking-before-b", "before", 0.99, "evaluator:test-b", {
      evaluationId: registered.contract.id, measuredAt: start
    }), now: start });
  const evaluated = await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  assert.equal(evaluated.accepted.length, 0, "a positive average cannot override one blocking defect");
  await assert.rejects(recordLearningOutcome({ root, learningId: "learning:blocking-baseline",
    ...outcome("outcome:blocking-before-replacement", "before", 1, "evaluator:test-a", {
      evaluationId: registered.contract.id, measuredAt: new Date(start.getTime() + 2000)
    }), now: new Date(start.getTime() + 2000) }), /already|replay|single-use|precommitted|immutable|one outcome/);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn, now: start });
  assert.equal(status.blockingDefectBoundEvaluationContracts, 1);
  assert.equal(status.blockingDefectOutcomeReceipts, 1);
  assert.equal(status.records[0].activeBlockingDefectPolicyDigest,
    registered.contract.blockingDefectPolicy.digest);
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.blockingDefectBoundEvaluationContracts, 1);
  assert.equal(doctor.learningOutcomes.blockingDefectOutcomeReceipts, 1);
  const audit = runCli(["audit", root, "--json"], state);
  assert.equal(audit.ok, true);
  assert.match(audit.gates.find((gate) => gate.name === "Context privacy").detail,
    /1 blocking-defect-bound contracts/);
  const foreign = await learningOutcomeStatus({ root,
    scope: { ...scopedTurn, tenantId: "tenant:foreign" }, now: start });
  assert.equal(foreign.blockingDefectBoundEvaluationContracts, 0);
  assert.equal(foreign.blockingDefectOutcomeReceipts, 0);

  const stored = await loadLearning(root);
  const contract = stored.learning.evaluations[0];
  contract.blockingDefectPolicy.beforeAction = "ignore";
  const policyPayload = { ...contract.blockingDefectPolicy };
  delete policyPayload.digest;
  contract.blockingDefectPolicy.digest = hash(JSON.stringify(policyPayload));
  const contractPayload = { ...contract };
  delete contractPayload.digest;
  contract.digest = hash(JSON.stringify(contractPayload));
  const binding = stored.learning.evaluationBindings[0];
  binding.evaluationDigest = contract.digest;
  const bindingPayload = { ...binding };
  delete bindingPayload.digest;
  binding.digest = hash(JSON.stringify(bindingPayload));
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evaluation (?:contract structure|state) is invalid/,
    "a re-signed policy weakening fails closed after restart");
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
