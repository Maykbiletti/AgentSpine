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

test("delivery revocation invalidates turn proof, withholds context, and rolls back atomically", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2038-01-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:delivery-alpha" };
  await upsertEntity({ root, id: "group:delivery-alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:delivery-beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:delivery-member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:delivery-member", to: "group:delivery-alpha",
    relation: "member-of", privacy: "group" });
  await proposeLearning({
    root, id: "learning:delivery-old", kind: "behavior", claim: "Use the stable synthetic delivered procedure.",
    subjectId: "person:delivery-member", privacy: "group", groupId: "group:delivery-alpha",
    scope: alphaScope, evidence: evidence("evidence:delivery-old", 0.97), now: start
  });
  await reviewLearning({ root, id: "learning:delivery-old", decision: "accept",
    reason: "Synthetic local review.", confirmedByUser: true, now: start });
  await proposeLearning({
    root, id: "learning:delivery-new", kind: "behavior", claim: "Use the improved synthetic delivered procedure.",
    subjectId: "person:delivery-member", privacy: "group", groupId: "group:delivery-alpha",
    scope: alphaScope, supersedesId: "learning:delivery-old",
    evidence: evidence("evidence:delivery-new-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:delivery-new",
    evidence: evidence("evidence:delivery-new-two", 0.97), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2,
    minOutcomeReceipts: 2, canaryReceipts: 2 }, now: start });
  await evaluation(root, "learning:delivery-new", {
    id: "evaluation:delivery-new", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2038-02-01T00:00:00.000Z"
  });
  await recordLearningOutcome({ root, learningId: "learning:delivery-new",
    ...outcome("outcome:delivery-before-a", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:delivery-new", scope: alphaScope, measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:delivery-new",
    ...outcome("outcome:delivery-before-b", "before", 0.5, "evaluator:test-b", {
      evaluationId: "evaluation:delivery-new", scope: alphaScope, measuredAt: start
    }), now: start });
  await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  const applied = await application(root, "learning:delivery-new", "delivery-a",
    new Date(start.getTime() + 2000), "active", alphaScope);
  await recordLearningOutcome({ root, learningId: "learning:delivery-new", applicationId: applied.id,
    deliveryId: applied.deliveryId,
    ...outcome("outcome:delivery-after-a", "after", 0.8, "evaluator:test-a", {
      evaluationId: "evaluation:delivery-new", scope: alphaScope,
      measuredAt: new Date(start.getTime() + 2000)
    }), now: new Date(start.getTime() + 2000) });

  await assert.rejects(revokeLearningDelivery({ root, deliveryId: applied.deliveryId,
    reasonCode: "hook-invalid", reason: "Synthetic hook evidence invalidated." }), /explicit local confirmation/);
  const revocationInput = {
    root, deliveryId: applied.deliveryId, reasonCode: "hook-invalid",
    reason: "Synthetic hook evidence invalidated.", confirmation: "local-delivery-revocation-confirmed", now: start
  };
  const retries = await Promise.all(Array.from({ length: 6 }, () => revokeLearningDelivery(revocationInput)));
  assert.equal(retries.filter((result) => result.unchanged === false).length, 1);
  assert.equal((await revokeLearningDelivery({ ...revocationInput,
    now: new Date(start.getTime() + 3000) })).unchanged, true);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.deliveryRevocations.length, 1);
  assert.equal(JSON.stringify(stored.learning.deliveryRevocations).includes("Synthetic hook evidence invalidated"), false);
  const receipt = stored.learning.deliveryRevocations[0];
  assert.equal(receipt.deliveryDigest, stored.learning.deliveries.find((item) => item.id === receipt.deliveryId).digest);
  assert.equal(receipt.applicationDigest,
    stored.learning.applications.find((item) => item.id === receipt.applicationId).digest);
  assert.equal(receipt.outcomeDigest, stored.learning.outcomes.find((item) => item.id === receipt.outcomeId).digest);
  const withheld = await learningContext({ root, groupId: "group:delivery-alpha", scope: alphaScope,
    now: new Date(start.getTime() + 4000) });
  assert.deepEqual(withheld.items, []);
  assert.deepEqual(withheld.diagnostics, ["revoked-learning-delivery:learning:delivery-new"]);
  const foreign = await learningContext({ root, groupId: "group:delivery-beta",
    scope: { ...scopedTurn, groupId: "group:delivery-beta" }, now: new Date(start.getTime() + 4000) });
  assert.deepEqual(foreign.items, []);
  assert.deepEqual(foreign.diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: alphaScope, now: new Date(start.getTime() + 4000) });
  assert.equal(status.deliveryRevocations, 1);
  assert.equal(status.records.find((item) => item.id === "learning:delivery-new").canaryStatus,
    "revoked-delivery");
  assert.equal((await learningOutcomeStatus({ root,
    scope: { ...alphaScope, groupId: "group:delivery-beta" },
    now: new Date(start.getTime() + 4000) })).deliveryRevocations, 0);
  const cliReceipt = runCli(["learn-delivery-revoke", applied.deliveryId, "--root", root,
    "--reason-code", "hook-invalid", "--reason", "Synthetic hook evidence invalidated.",
    "--confirm-local-delivery-revocation", "--json"], state);
  assert.equal(cliReceipt.receipt.schema, "agentspine.learning-delivery-revocation/v1");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.status, "degraded");
  assert.equal(doctor.learningOutcomes.deliveryRevocationReceipts, 1);

  await assert.rejects(commitLearningOutcome({ root, id: "outcome:delivery-replay",
    learningId: "learning:delivery-new", evaluationId: "evaluation:delivery-new",
    measurementReceiptId: "measurement:outcome:delivery-after-a", applicationId: applied.id,
    deliveryId: applied.deliveryId, now: new Date(start.getTime() + 4000) }), /delivery was explicitly revoked/);
  await assert.rejects(recordLearningMeasurement({
    root, id: "measurement:delivery-replay", learningId: "learning:delivery-new",
    evaluationId: "evaluation:delivery-new", phase: "after", scope: alphaScope,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.81, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a",
      runId: stored.learning.evaluations.find((item) => item.id === "evaluation:delivery-new")
        .initialTrials.after[0].runId, sourceDigest: hash("delivery-replay-source") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 },
    measuredAt: new Date(start.getTime() + 4000), confirmLocalMeasurement: true,
    now: new Date(start.getTime() + 4000)
  }), /completed delivery/);

  const originalState = JSON.stringify(stored.learning);
  stored.learning.deliveryRevocations[0].deliveryDigest = hash("redirected delivery");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /delivery revocation state is invalid/);
  await writeFile(stored.learningPath, `${originalState}\n`, "utf8");

  const reconciled = await evaluateLearning({ root, now: new Date(start.getTime() + 5000) });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:delivery-new", decision: "rolled-back" }]);
  assert.equal((await loadLearning(root)).learning.candidates.find((item) => item.id === "learning:delivery-new")
    .rollback.mode, "automatic-delivery-revocation");
  assert.deepEqual((await learningContext({ root, groupId: "group:delivery-alpha", scope: alphaScope,
    now: new Date(start.getTime() + 6000) })).items.map((item) => item.id), ["learning:delivery-old"]);
  await deleteLearning({ root, id: "learning:delivery-new" });
  assert.equal((await loadLearning(root)).learning.deliveryRevocations.length, 0);
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:delivery-member" })).deleted, 1);

  const validatedStart = new Date("2039-01-01T00:00:00.000Z");
  await establishValidatedLearning(root, {
    learningId: "learning:delivery-validated", evaluationId: "evaluation:delivery-validated",
    start: validatedStart, expiresAt: "2039-03-01T00:00:00.000Z"
  });
  const validatedState = (await loadLearning(root)).learning;
  const validatedCandidate = validatedState.candidates.find((item) => item.id === "learning:delivery-validated");
  const validatedAfter = validatedState.outcomes.find((item) =>
    item.id === validatedCandidate.promotion.canary.afterReceipts[0]);
  await revokeLearningDelivery({ root, deliveryId: validatedAfter.deliveryId, reasonCode: "session-invalid",
    reason: "Synthetic session completion invalidation.", confirmation: "local-delivery-revocation-confirmed",
    now: new Date(validatedStart.getTime() + 4000) });
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date(validatedStart.getTime() + 5000) })).diagnostics,
  ["revoked-learning-delivery:learning:delivery-validated"]);
  const validatedRollback = await evaluateLearning({ root, now: new Date(validatedStart.getTime() + 6000) });
  assert.deepEqual(validatedRollback.reconciled,
    [{ id: "learning:delivery-validated", decision: "rolled-back" }]);
  assert.equal((await loadLearning(root)).learning.candidates
    .find((item) => item.id === "learning:delivery-validated").rollback.mode,
  "automatic-delivery-revocation");
  await deleteLearning({ root, id: "learning:delivery-validated" });
  assert.equal((await loadLearning(root)).learning.deliveryRevocations.length, 0);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("application revocation withdraws the exact projection and blocks every downstream proof", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2039-04-01T00:00:00.000Z");
  await upsertEntity({ root, id: "person:application-member", kind: "person", privacy: "shared" });
  await proposeLearning({
    root, id: "learning:application-prior", kind: "behavior",
    claim: "Use the prior synthetic projection procedure.", subjectId: "person:application-member",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:application-prior", 0.97), now: start
  });
  await reviewLearning({ root, id: "learning:application-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await establishValidatedLearning(root, {
    learningId: "learning:application-current", evaluationId: "evaluation:application-current", start,
    expiresAt: "2039-06-01T00:00:00.000Z", supersedesId: "learning:application-prior",
    subjectId: "person:application-member"
  });
  const beforeRevocation = (await loadLearning(root)).learning;
  const candidate = beforeRevocation.candidates.find((item) => item.id === "learning:application-current");
  const outcomeReceipt = beforeRevocation.outcomes.find((item) =>
    item.id === candidate.promotion.canary.afterReceipts[0]);
  const applicationReceipt = beforeRevocation.applications.find((item) =>
    item.id === outcomeReceipt.applicationId);
  const deliveryReceipt = beforeRevocation.deliveries.find((item) =>
    item.id === outcomeReceipt.deliveryId);
  await assert.rejects(revokeLearningApplication({ root, applicationId: applicationReceipt.id,
    reasonCode: "projection-invalid", reason: "Synthetic projection binding invalidated." }),
  /explicit local confirmation/);
  const input = {
    root, applicationId: applicationReceipt.id, reasonCode: "projection-invalid",
    reason: "Synthetic projection binding invalidated.",
    confirmation: "local-application-revocation-confirmed", now: start
  };
  const attempts = await Promise.all(Array.from({ length: 6 }, () => revokeLearningApplication(input)));
  assert.equal(attempts.filter((result) => result.unchanged === false).length, 1);
  assert.equal((await revokeLearningApplication({ ...input,
    now: new Date(start.getTime() + 4000) })).unchanged, true);
  await assert.rejects(revokeLearningApplication({ ...input, reasonCode: "scope-invalid",
    reason: "Synthetic conflicting reason.", now: new Date(start.getTime() + 4000) }), /immutable/);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.applicationRevocations.length, 1);
  assert.equal(stored.learning.measurementRevocations.length, 0);
  assert.equal(stored.learning.deliveryRevocations.length, 0);
  assert.equal(stored.learning.outcomeRevocations.length, 0,
    "withdrawing a projection must not over-revoke immutable downstream evidence");
  assert.equal(JSON.stringify(stored.learning.applicationRevocations)
    .includes("Synthetic projection binding invalidated"), false);
  const receipt = stored.learning.applicationRevocations[0];
  assert.equal(receipt.applicationDigest, applicationReceipt.digest);
  assert.equal(receipt.deliveryDigest, deliveryReceipt.digest);
  assert.equal(receipt.outcomeDigest, outcomeReceipt.digest);
  assert.equal(receipt.evaluationDigest, stored.learning.evaluations
    .find((item) => item.id === "evaluation:application-current").digest);

  const withheld = await learningContext({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 5000) });
  assert.deepEqual(withheld.items, []);
  assert.deepEqual(withheld.diagnostics,
    ["revoked-learning-application:learning:application-current"]);
  const foreign = await learningContext({ root, scope: { ...scopedTurn, projectId: "project:foreign" },
    now: new Date(start.getTime() + 5000) });
  assert.deepEqual(foreign.items, []);
  assert.deepEqual(foreign.diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 5000) });
  assert.equal(status.applicationRevocations, 1);
  assert.equal(status.records.find((item) => item.id === "learning:application-current")
    .canaryStatus, "revoked-application");
  assert.equal((await learningOutcomeStatus({ root, scope: { ...scopedTurn, projectId: "project:foreign" },
    now: new Date(start.getTime() + 5000) })).applicationRevocations, 0);
  const cli = runCli(["learn-application-revoke", applicationReceipt.id, "--root", root,
    "--reason-code", "projection-invalid", "--reason", "Synthetic projection binding invalidated.",
    "--confirm-local-application-revocation", "--json"], state);
  assert.equal(cli.receipt.schema, "agentspine.learning-application-revocation/v1");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.status, "degraded");
  assert.equal(doctor.learningOutcomes.applicationRevocationReceipts, 1);
  await assert.rejects(commitLearningOutcome({ root, id: "outcome:application-replay",
    learningId: "learning:application-current", evaluationId: "evaluation:application-current",
    measurementReceiptId: outcomeReceipt.measurementReceiptId, applicationId: applicationReceipt.id,
    deliveryId: deliveryReceipt.id, now: new Date(start.getTime() + 5000) }),
  /application was explicitly revoked/);

  const originalState = JSON.stringify(stored.learning);
  stored.learning.applicationRevocations[0].applicationDigest = hash("redirected application");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /application revocation state is invalid/);
  await writeFile(stored.learningPath, `${originalState}\n`, "utf8");
  const reconciliations = await Promise.all(Array.from({ length: 6 }, () =>
    evaluateLearning({ root, now: new Date(start.getTime() + 6000) })));
  assert.equal(reconciliations.flatMap((result) => result.reconciled)
    .filter((item) => item.id === "learning:application-current" && item.decision === "rolled-back").length, 1);
  const rolledBack = (await loadLearning(root)).learning.candidates
    .find((item) => item.id === "learning:application-current");
  assert.equal(rolledBack.rollback.mode, "automatic-application-revocation");
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 7000) })).items.map((item) => item.id),
  ["learning:application-prior"]);
  await deleteLearning({ root, id: "learning:application-current" });
  assert.equal((await loadLearning(root)).learning.applicationRevocations.length, 0);
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:application-member" })).deleted, 1);

  await proposeLearning({ root, id: "learning:application-active", kind: "behavior",
    claim: "Use the active synthetic projection procedure.", privacy: "shared", scope: scopedTurn,
    evidence: evidence("evidence:application-active-one", 0.97), now: start });
  await addLearningEvidence({ root, id: "learning:application-active",
    evidence: evidence("evidence:application-active-two", 0.97), now: start });
  await evaluation(root, "learning:application-active", { id: "evaluation:application-active",
    evaluatorIds: ["evaluator:test-a", "evaluator:test-b"], now: start,
    expiresAt: "2039-06-01T00:00:00.000Z" });
  for (const [suffix, evaluatorId, value] of [["a", "evaluator:test-a", 0.4], ["b", "evaluator:test-b", 0.5]]) {
    await recordLearningOutcome({ root, learningId: "learning:application-active",
      ...outcome(`outcome:application-active-before-${suffix}`, "before", value, evaluatorId,
        { evaluationId: "evaluation:application-active", measuredAt: start }), now: start });
  }
  await evaluateLearning({ root, now: new Date(start.getTime() + 8000) });
  const completedFirst = await application(root, "learning:application-active", "application-active-first",
    new Date(start.getTime() + 9000));
  await recordLearningOutcome({ root, learningId: "learning:application-active",
    applicationId: completedFirst.id, deliveryId: completedFirst.deliveryId,
    ...outcome("outcome:application-active-after-a", "after", 0.8, "evaluator:test-a", {
      evaluationId: "evaluation:application-active", measuredAt: new Date(start.getTime() + 9000)
    }), now: new Date(start.getTime() + 9000) });
  await application(root, "learning:application-active", "application-active-second",
    new Date(start.getTime() + 10000));
  const pending = await projectedApplication(root, "learning:application-active", "application-pending",
    new Date(start.getTime() + 11000));
  assert.equal(pending.schema, "agentspine.learning-application/v2");
  await revokeLearningApplication({ root, applicationId: pending.id, reasonCode: "preflight-invalid",
    reason: "Synthetic preflight binding invalidated.",
    confirmation: "local-application-revocation-confirmed", now: new Date(start.getTime() + 12000) });
  await assert.rejects(recordLearningDeliveries({ root, sessionId: "session:application-pending",
    scope: scopedTurn, hookEvent: "Stop", completedAt: new Date(start.getTime() + 13000) }),
  /application was explicitly revoked/);
  const replacement = await recordLearningApplications({ root, items: [{ id: "learning:application-active",
    outcomeStatus: "active" }], scope: scopedTurn, preflightReceipt: {
    schema: "agentspine.preflight/v2", id: "preflight:application-replacement", status: "ready",
    sessionId: "session:application-replacement", promptDigest: hash("prompt:application-replacement"),
    briefingDigest: hash("preflight:application-replacement"), agentId: scopedTurn.personaId,
    userId: scopedTurn.userId, tenantId: scopedTurn.tenantId, projectId: scopedTurn.projectId,
    groupId: scopedTurn.groupId, taskId: scopedTurn.taskId,
    createdAt: new Date(start.getTime() + 13000).toISOString(),
    expiresAt: new Date(start.getTime() + 73000).toISOString()
  }, sessionBriefingDigest: hash("briefing:application-replacement"),
  projectedAt: new Date(start.getTime() + 13000) });
  assert.equal(replacement.receipts.length, 1,
    "an unconsumed ordinary projection revocation must not poison a later independent turn");
  const purged = await purgeStaleLearningApplications({ root,
    confirmation: "local-user-purge-confirmed", now: new Date(start.getTime() + 400000) });
  assert.equal(purged.purged, 1, "stale cleanup may remove the unrelated replacement projection only");
  assert.equal((await loadLearning(root)).learning.applications.some((item) => item.id === pending.id), true,
    "stale cleanup must retain an application referenced by a revocation");
  assert.equal((await loadLearning(root)).learning.applicationRevocations.length, 1);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});

test("evaluation revocation withdraws the exact contract and blocks its complete outcome lineage", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2040-01-01T00:00:00.000Z");
  await upsertEntity({ root, id: "person:evaluation-member", kind: "person", privacy: "shared" });
  await proposeLearning({ root, id: "learning:evaluation-prior", kind: "behavior",
    claim: "Use the prior synthetic evaluation procedure.", subjectId: "person:evaluation-member",
    privacy: "shared", scope: scopedTurn, evidence: evidence("evidence:evaluation-prior", 0.97), now: start });
  await reviewLearning({ root, id: "learning:evaluation-prior", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true, now: start });
  await establishValidatedLearning(root, {
    learningId: "learning:evaluation-current", evaluationId: "evaluation:evaluation-current", start,
    expiresAt: "2040-03-01T00:00:00.000Z", supersedesId: "learning:evaluation-prior",
    subjectId: "person:evaluation-member"
  });
  const before = (await loadLearning(root)).learning;
  const contract = before.evaluations.find((item) => item.id === "evaluation:evaluation-current");
  const binding = before.evaluationBindings.find((item) => item.evaluationId === contract.id);
  const candidate = before.candidates.find((item) => item.id === "learning:evaluation-current");
  const after = before.outcomes.find((item) => item.id === candidate.promotion.canary.afterReceipts[0]);
  await assert.rejects(revokeLearningEvaluation({ root, evaluationId: contract.id,
    reasonCode: "protocol-invalid", reason: "Synthetic protocol invalidation." }), /explicit local confirmation/);
  const input = { root, evaluationId: contract.id, reasonCode: "protocol-invalid",
    reason: "Synthetic protocol invalidation.", confirmation: "local-evaluation-revocation-confirmed", now: start };
  const attempts = await Promise.all(Array.from({ length: 6 }, () => revokeLearningEvaluation(input)));
  assert.equal(attempts.filter((result) => result.unchanged === false).length, 1);
  assert.equal((await revokeLearningEvaluation({ ...input, now: new Date(start.getTime() + 1000) })).unchanged, true);
  await assert.rejects(revokeLearningEvaluation({ ...input, reasonCode: "scope-invalid",
    reason: "Synthetic conflicting reason." }), /immutable/);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.evaluationRevocations.length, 1);
  assert.equal(JSON.stringify(stored.learning.evaluationRevocations).includes("Synthetic protocol invalidation"), false);
  const receipt = stored.learning.evaluationRevocations[0];
  assert.equal(receipt.evaluationDigest, contract.digest);
  assert.equal(receipt.evaluatorBindingDigest, binding.digest);
  assert.equal(receipt.targetDigest, contract.target.digest);
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 2000) })).diagnostics,
  ["revoked-learning-evaluation:learning:evaluation-current"]);
  assert.deepEqual((await learningContext({ root, scope: { ...scopedTurn, projectId: "project:foreign" },
    now: new Date(start.getTime() + 2000) })).diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: scopedTurn, now: new Date(start.getTime() + 2000) });
  assert.equal(status.evaluationRevocations, 1);
  assert.equal(status.records.find((item) => item.id === candidate.id).canaryStatus, "revoked-evaluation");
  const foreignStatus = await learningOutcomeStatus({ root,
    scope: { ...scopedTurn, projectId: "project:foreign" }, now: new Date(start.getTime() + 2000) });
  assert.equal(foreignStatus.evaluationRevocations, 0);
  assert.deepEqual(foreignStatus.evaluatorRegistry,
    { active: 0, revoked: 0, bindings: 0, validationLeases: 0, authority: "context-only" });
  const cli = runCli(["learn-evaluation-revoke", contract.id, "--root", root,
    "--reason-code", "protocol-invalid", "--reason", "Synthetic protocol invalidation.",
    "--confirm-local-evaluation-revocation", "--json"], state);
  assert.equal(cli.receipt.schema, "agentspine.learning-evaluation-revocation/v1");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.status, "degraded");
  assert.equal(doctor.learningOutcomes.evaluationRevocationReceipts, 1);
  await assert.rejects(recordLearningMeasurement({ root, id: "measurement:evaluation-replay",
    learningId: candidate.id, evaluationId: contract.id, phase: "after", scope: scopedTurn,
    metric: { name: contract.metric.name, direction: contract.metric.direction, value: 0.9 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-a", runId: "run:evaluation-replay",
      sourceDigest: hash("measurement:evaluation-replay") },
    coverage: { datasetDigest: contract.benchmark.datasetDigest, caseCount: contract.benchmark.minCases },
    confirmLocalMeasurement: true, now: new Date(start.getTime() + 2000) }), /evaluation contract was explicitly revoked/);
  await assert.rejects(commitLearningOutcome({ root, id: "outcome:evaluation-replay", learningId: candidate.id,
    evaluationId: contract.id, measurementReceiptId: after.measurementReceiptId,
    applicationId: after.applicationId, deliveryId: after.deliveryId,
    now: new Date(start.getTime() + 2000) }), /evaluation contract was explicitly revoked/);
  const original = JSON.stringify(stored.learning);
  stored.learning.evaluationRevocations[0].evaluationDigest = hash("redirected evaluation");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evaluation revocation state is invalid/);
  await writeFile(stored.learningPath, `${original}\n`, "utf8");
  const reconciliations = await Promise.all(Array.from({ length: 6 }, () =>
    evaluateLearning({ root, now: new Date(start.getTime() + 3000) })));
  assert.equal(reconciliations.flatMap((result) => result.reconciled)
    .filter((item) => item.id === candidate.id && item.decision === "rolled-back").length, 1);
  const rolledBack = (await loadLearning(root)).learning.candidates.find((item) => item.id === candidate.id);
  assert.equal(rolledBack.rollback.mode, "automatic-evaluation-revocation");
  assert.deepEqual((await learningContext({ root, scope: scopedTurn,
    now: new Date(start.getTime() + 4000) })).items.map((item) => item.id), ["learning:evaluation-prior"]);
  await deleteLearning({ root, id: candidate.id });
  assert.equal((await loadLearning(root)).learning.evaluationRevocations.length, 0);
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:evaluation-member" })).deleted, 1);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
