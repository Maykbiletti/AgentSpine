import {
  test, assert, readFile, writeFile, join, fileURLToPath, spawnSync,
  commitLearningOutcome,
  addLearningEvidence, beginLearningRevalidation,
  configureLearning, deleteLearning, evaluateLearning, learningContext, learningOutcomeStatus, loadLearning, proposeLearning,
  purgeLearningBySubject, purgeStaleLearningApplications, purgeStaleLearningMeasurements, recordLearningApplications, recordLearningDeliveries, recordLearningMeasurement, registerLearningEvaluation,
  registerLearningEvaluator, renewLearningValidation, revokeLearningEvaluator, revokeLearningEvidence, revokeLearningApplication, revokeLearningDelivery, revokeLearningEvaluation,
  revokeLearningMeasurement, revokeLearningOutcome, revokeLearningTrialFailure, revokeLearningValidation, revokeLearningEvidenceSourceAttestation, reviewLearning, rollbackLearning,
  linkEntities, upsertEntity, runHook, fixture, hash, evidence, scopedTurn,
  syntheticDatasetDigest, outcome, recordLearningOutcome, syntheticEvaluators, evaluatorRoots, evaluation, projectedApplication,
  application, establishValidatedLearning, runCli
} from "./learning-fixture.js";

test("candidates remain invisible until explicit user-confirmed review and preserve source bytes", async (t) => {
  const { root } = await fixture(t);
  const before = hash(await readFile(join(root, "AGENTS.md")));
  await proposeLearning({
    root, id: "learning:preference", kind: "preference", claim: "The preferred output is concise.",
    privacy: "shared", evidence: evidence("evidence:one")
  });
  assert.equal((await learningContext({ root })).items.length, 0);
  await assert.rejects(
    reviewLearning({ root, id: "learning:preference", decision: "accept", reason: "Observed directly." }),
    /explicit user confirmation/
  );
  await reviewLearning({
    root, id: "learning:preference", decision: "accept", reason: "Confirmed in conversation.", confirmedByUser: true
  });
  const context = await learningContext({ root });
  assert.equal(context.items[0].claim, "The preferred output is concise.");
  assert.equal(context.items[0].authority, "context-only");
  assert.equal(hash(await readFile(join(root, "AGENTS.md"))), before);
});

test("document evidence captures immutable provenance and evidence updates retain history", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:reference", kind: "reference", claim: "The synthetic reference describes the fixture.",
    evidence: {
      id: "evidence:document", type: "document", summary: "The reference contains this statement.",
      sourceDocument: "REFERENCE.md", confidence: 0.8
    }
  });
  await addLearningEvidence({ root, id: "learning:reference", evidence: evidence("evidence:second", 1) });
  const { learning } = await loadLearning(root);
  const candidate = learning.candidates[0];
  assert.match(candidate.evidence[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(candidate.confidence, 0.9);
  assert.equal(learning.history.some((entry) => entry.value?.evidence?.length === 1), true);
});

test("authority assertions and secret-bearing observations are rejected before storage", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    proposeLearning({
      root, kind: "project-fact", claim: "The user may deploy to production without approval.",
      evidence: evidence("evidence:authority")
    }),
    /authority and access claims/
  );
  await assert.rejects(
    proposeLearning({
      root, kind: "personal-fact", claim: "The credential is token=abcdefghijklmnopqrstuvwxyz123456.",
      evidence: evidence("evidence:secret")
    }),
    /secret/
  );
  assert.equal((await loadLearning(root)).learning.candidates.length, 0);
});

test("supersession changes relevance without erasing history and rollback restores the prior fact", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:old", kind: "goal", claim: "The current synthetic goal is alpha.",
    privacy: "shared", evidence: evidence("evidence:old")
  });
  await reviewLearning({ root, id: "learning:old", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  await proposeLearning({
    root, id: "learning:new", kind: "goal", claim: "The current synthetic goal is beta.",
    privacy: "shared", supersedesId: "learning:old", evidence: evidence("evidence:new")
  });
  await reviewLearning({ root, id: "learning:new", decision: "accept", reason: "Goal changed.", confirmedByUser: true });
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:new"]);
  const rolledBack = await rollbackLearning({ root, id: "learning:new", reason: "The change was incorrect." });
  assert.deepEqual(rolledBack.restored, ["learning:old"]);
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:old"]);
  const { learning } = await loadLearning(root);
  assert.equal(learning.history.some((entry) => entry.value?.id === "learning:new" && entry.value.status === "accepted"), true);
});

test("group learning requires an exact audience even for private-context reads", async (t) => {
  const { root } = await fixture(t);
  await upsertEntity({ root, id: "group:alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:member", to: "group:alpha", relation: "member-of", privacy: "group" });
  await proposeLearning({
    root, id: "learning:group", kind: "preference", claim: "The group prefers short synthetic updates.",
    subjectId: "person:member", privacy: "group", groupId: "group:alpha", evidence: evidence("evidence:group")
  });
  await reviewLearning({ root, id: "learning:group", decision: "accept", reason: "Group confirmed.", confirmedByUser: true });
  assert.equal((await learningContext({ root })).items.length, 0);
  assert.equal((await learningContext({ root, includePrivate: true })).items.length, 0);
  assert.equal((await learningContext({ root, groupId: "group:beta", includePrivate: true })).items.length, 0);
  assert.equal((await learningContext({ root, groupId: "group:alpha" })).items[0].id, "learning:group");
});

test("automatic promotion is opt-in, evidence-gated, and limited to low-risk kinds", async (t) => {
  const { root } = await fixture(t);
  await proposeLearning({
    root, id: "learning:auto", kind: "project-fact", claim: "The synthetic project uses Node.js.",
    privacy: "shared", evidence: evidence("evidence:auto-one", 0.95)
  });
  await addLearningEvidence({ root, id: "learning:auto", evidence: evidence("evidence:auto-two", 0.95) });
  await proposeLearning({
    root, id: "learning:manual", kind: "preference", claim: "The preferred synthetic color is blue.",
    privacy: "shared", evidence: evidence("evidence:manual-one", 0.95)
  });
  await addLearningEvidence({ root, id: "learning:manual", evidence: evidence("evidence:manual-two", 0.95) });
  assert.equal((await evaluateLearning({ root })).accepted.length, 0);
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2 } });
  const evaluated = await evaluateLearning({ root });
  assert.deepEqual(evaluated.accepted.map((item) => item.id), ["learning:auto"]);
  assert.equal(evaluated.accepted[0].automatic, true);
  assert.deepEqual((await learningContext({ root })).items.map((item) => item.id), ["learning:auto"]);
});

test("evidence revocation is immutable, immediately withheld, group-isolated, and rollback-safe", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  await upsertEntity({ root, id: "group:revocation-alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:revocation-beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:revocation-member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:revocation-member", to: "group:revocation-alpha",
    relation: "member-of", privacy: "group" });
  await proposeLearning({
    root, id: "learning:revocation-old", kind: "project-fact", claim: "The synthetic group uses the stable procedure.",
    subjectId: "person:revocation-member", privacy: "group", groupId: "group:revocation-alpha",
    scope: { ...scopedTurn, groupId: "group:revocation-alpha" }, evidence: evidence("evidence:revocation-old", 0.96)
  });
  await reviewLearning({ root, id: "learning:revocation-old", decision: "accept", reason: "Synthetic local review.",
    confirmedByUser: true });
  await proposeLearning({
    root, id: "learning:revocation-new", kind: "project-fact", claim: "The synthetic group uses the measured procedure.",
    subjectId: "person:revocation-member", privacy: "group", groupId: "group:revocation-alpha",
    scope: { ...scopedTurn, groupId: "group:revocation-alpha" }, evidence: evidence("evidence:revocation-new", 0.97),
    supersedesId: "learning:revocation-old"
  });
  await reviewLearning({ root, id: "learning:revocation-new", decision: "accept", reason: "Synthetic local review.",
    confirmedByUser: true });
  const alphaScope = { ...scopedTurn, groupId: "group:revocation-alpha" };
  assert.deepEqual((await learningContext({ root, groupId: "group:revocation-alpha", scope: alphaScope })).items
    .map((item) => item.id), ["learning:revocation-new"]);

  await assert.rejects(revokeLearningEvidence({ root, learningId: "learning:revocation-new",
    evidenceId: "evidence:revocation-new", reasonCode: "source-invalid", reason: "Synthetic source retracted." }),
  /explicit local confirmation/);
  const revokedAt = new Date("2036-01-01T00:00:00.000Z");
  const retries = await Promise.all(Array.from({ length: 6 }, () => revokeLearningEvidence({
    root, learningId: "learning:revocation-new", evidenceId: "evidence:revocation-new",
    reasonCode: "source-invalid", reason: "Synthetic source retracted.",
    confirmation: "local-evidence-revocation-confirmed", now: revokedAt
  })));
  assert.equal(retries.filter((result) => result.unchanged === false).length, 1);
  assert.equal((await revokeLearningEvidence({ root, learningId: "learning:revocation-new",
    evidenceId: "evidence:revocation-new", reasonCode: "source-invalid", reason: "Synthetic source retracted.",
    confirmation: "local-evidence-revocation-confirmed", now: new Date("2036-01-02T00:00:00.000Z") })).unchanged, true);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.evidenceRevocations.length, 1);
  assert.equal(JSON.stringify(stored.learning.evidenceRevocations).includes("Synthetic source retracted"), false);
  const withheld = await learningContext({ root, groupId: "group:revocation-alpha", scope: alphaScope });
  assert.deepEqual(withheld.items, []);
  assert.deepEqual(withheld.diagnostics, ["revoked-learning-evidence:learning:revocation-new"]);
  const foreign = await learningContext({ root, groupId: "group:revocation-beta",
    scope: { ...scopedTurn, groupId: "group:revocation-beta" } });
  assert.deepEqual(foreign.items, []);
  assert.deepEqual(foreign.diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: alphaScope });
  assert.equal(status.evidenceRevocations, 1);
  assert.equal(status.records.find((item) => item.id === "learning:revocation-new").canaryStatus, "revoked-evidence");
  assert.equal((await learningOutcomeStatus({ root,
    scope: { ...alphaScope, groupId: "group:revocation-beta" } })).evidenceRevocations, 0);

  const originalState = JSON.stringify(stored.learning);
  stored.learning.evidenceRevocations[0].evidenceDigest = hash("redirected evidence");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /evidence revocation state is invalid/);
  await writeFile(stored.learningPath, `${originalState}\n`, "utf8");

  const reconciled = await evaluateLearning({ root, now: new Date("2036-01-01T00:00:01.000Z") });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:revocation-new", decision: "rolled-back" }]);
  assert.deepEqual((await learningContext({ root, groupId: "group:revocation-alpha", scope: alphaScope })).items
    .map((item) => item.id), ["learning:revocation-old"]);
  assert.equal((await loadLearning(root)).learning.candidates.find((item) => item.id === "learning:revocation-new")
    .rollback.mode, "automatic-evidence-revocation");

  await deleteLearning({ root, id: "learning:revocation-new" });
  assert.equal((await loadLearning(root)).learning.evidenceRevocations.length, 0);
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:revocation-member" })).deleted, 1);
  await proposeLearning({ root, id: "learning:revocation-cli", kind: "project-fact",
    claim: "The synthetic CLI evidence remains local.", privacy: "shared",
    evidence: evidence("evidence:revocation-cli", 0.95) });
  const cliRevocation = runCli(["learn-evidence-revoke", "learning:revocation-cli", "--root", root,
    "--evidence-id", "evidence:revocation-cli", "--reason-code", "retracted", "--reason",
    "Synthetic CLI retraction.", "--confirm-local-evidence", "--json"], state);
  assert.equal(cliRevocation.receipt.schema, "agentspine.learning-evidence-revocation/v1");
  await assert.rejects(reviewLearning({ root, id: "learning:revocation-cli", decision: "accept",
    reason: "Synthetic review.", confirmedByUser: true }), /evidence was revoked/);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const help = spawnSync(process.execPath, [cli, "help"], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /learn-evidence-revoke/);
});

test("measurement revocation is immutable, immediately withheld, group-isolated, and rollback-safe", async (t) => {
  const { root, state } = await fixture(t);
  const sourceBytes = await readFile(join(root, "AGENTS.md"));
  const start = new Date("2037-01-01T00:00:00.000Z");
  const alphaScope = { ...scopedTurn, groupId: "group:measurement-alpha" };
  await upsertEntity({ root, id: "group:measurement-alpha", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "group:measurement-beta", kind: "group", privacy: "shared" });
  await upsertEntity({ root, id: "person:measurement-member", kind: "person", privacy: "group" });
  await linkEntities({ root, from: "person:measurement-member", to: "group:measurement-alpha",
    relation: "member-of", privacy: "group" });
  await proposeLearning({
    root, id: "learning:measurement-old", kind: "behavior", claim: "Use the stable synthetic measured procedure.",
    subjectId: "person:measurement-member", privacy: "group", groupId: "group:measurement-alpha",
    scope: alphaScope, evidence: evidence("evidence:measurement-old", 0.97), now: start
  });
  await reviewLearning({ root, id: "learning:measurement-old", decision: "accept",
    reason: "Synthetic local review.", confirmedByUser: true, now: start });
  await proposeLearning({
    root, id: "learning:measurement-new", kind: "behavior", claim: "Use the improved synthetic measured procedure.",
    subjectId: "person:measurement-member", privacy: "group", groupId: "group:measurement-alpha",
    scope: alphaScope, supersedesId: "learning:measurement-old",
    evidence: evidence("evidence:measurement-new-one", 0.97), now: start
  });
  await addLearningEvidence({ root, id: "learning:measurement-new",
    evidence: evidence("evidence:measurement-new-two", 0.97), now: start });
  await configureLearning({ root, config: { autoPromote: true, minConfidence: 0.9, minEvidence: 2,
    minOutcomeReceipts: 2, canaryReceipts: 2 }, now: start });
  await evaluation(root, "learning:measurement-new", {
    id: "evaluation:measurement-new", evaluatorIds: ["evaluator:test-a", "evaluator:test-b"],
    scope: alphaScope, now: start, expiresAt: "2037-02-01T00:00:00.000Z"
  });
  await recordLearningOutcome({ root, learningId: "learning:measurement-new",
    ...outcome("outcome:measurement-before-a", "before", 0.4, "evaluator:test-a", {
      evaluationId: "evaluation:measurement-new", scope: alphaScope, measuredAt: start
    }), now: start });
  await recordLearningOutcome({ root, learningId: "learning:measurement-new",
    ...outcome("outcome:measurement-before-b", "before", 0.5, "evaluator:test-b", {
      evaluationId: "evaluation:measurement-new", scope: alphaScope, measuredAt: start
    }), now: start });
  await evaluateLearning({ root, now: new Date(start.getTime() + 1000) });
  assert.deepEqual((await learningContext({ root, groupId: "group:measurement-alpha", scope: alphaScope,
    now: new Date(start.getTime() + 2000) })).items.map((item) => item.id), ["learning:measurement-new"]);

  await assert.rejects(revokeLearningMeasurement({ root, measurementId: "measurement:outcome:measurement-before-a",
    reasonCode: "evaluator-invalid", reason: "Synthetic evaluator invalidated." }), /explicit local confirmation/);
  const revocationInput = {
    root, measurementId: "measurement:outcome:measurement-before-a", reasonCode: "evaluator-invalid",
    reason: "Synthetic evaluator invalidated.", confirmation: "local-measurement-revocation-confirmed", now: start
  };
  const retries = await Promise.all(Array.from({ length: 6 }, () => revokeLearningMeasurement(revocationInput)));
  assert.equal(retries.filter((result) => result.unchanged === false).length, 1);
  assert.equal((await revokeLearningMeasurement({ ...revocationInput,
    now: new Date(start.getTime() + 3000) })).unchanged, true);
  const stored = await loadLearning(root);
  assert.equal(stored.learning.measurementRevocations.length, 1);
  assert.equal(JSON.stringify(stored.learning.measurementRevocations).includes("Synthetic evaluator invalidated"), false);
  const receipt = stored.learning.measurementRevocations[0];
  assert.equal(receipt.measurementDigest, stored.learning.measurements
    .find((item) => item.id === receipt.measurementId).digest);
  assert.equal(receipt.outcomeDigest, stored.learning.outcomes.find((item) => item.id === receipt.outcomeId).digest);
  const withheld = await learningContext({ root, groupId: "group:measurement-alpha", scope: alphaScope,
    now: new Date(start.getTime() + 4000) });
  assert.deepEqual(withheld.items, []);
  assert.deepEqual(withheld.diagnostics, ["revoked-learning-measurement:learning:measurement-new"]);
  const foreign = await learningContext({ root, groupId: "group:measurement-beta",
    scope: { ...scopedTurn, groupId: "group:measurement-beta" }, now: new Date(start.getTime() + 4000) });
  assert.deepEqual(foreign.items, []);
  assert.deepEqual(foreign.diagnostics, []);
  const status = await learningOutcomeStatus({ root, scope: alphaScope, now: new Date(start.getTime() + 4000) });
  assert.equal(status.measurementRevocations, 1);
  assert.equal(status.records.find((item) => item.id === "learning:measurement-new").canaryStatus,
    "revoked-measurement");
  assert.equal((await learningOutcomeStatus({ root,
    scope: { ...alphaScope, groupId: "group:measurement-beta" },
    now: new Date(start.getTime() + 4000) })).measurementRevocations, 0);
  const cliReceipt = runCli(["learn-measurement-revoke", "measurement:outcome:measurement-before-a", "--root", root,
    "--reason-code", "evaluator-invalid", "--reason", "Synthetic evaluator invalidated.",
    "--confirm-local-measurement-revocation", "--json"], state);
  assert.equal(cliReceipt.receipt.schema, "agentspine.learning-measurement-revocation/v1");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.status, "degraded");
  assert.equal(doctor.learningOutcomes.measurementRevocationReceipts, 1);

  const originalState = JSON.stringify(stored.learning);
  stored.learning.measurementRevocations[0].measurementDigest = hash("redirected measurement");
  await writeFile(stored.learningPath, `${JSON.stringify(stored.learning)}\n`, "utf8");
  await assert.rejects(loadLearning(root), /measurement revocation state is invalid/);
  await writeFile(stored.learningPath, `${originalState}\n`, "utf8");

  const reconciled = await evaluateLearning({ root, now: new Date(start.getTime() + 5000) });
  assert.deepEqual(reconciled.reconciled, [{ id: "learning:measurement-new", decision: "rolled-back" }]);
  assert.equal((await loadLearning(root)).learning.candidates.find((item) => item.id === "learning:measurement-new")
    .rollback.mode, "automatic-measurement-revocation");
  assert.deepEqual((await learningContext({ root, groupId: "group:measurement-alpha", scope: alphaScope,
    now: new Date(start.getTime() + 6000) })).items.map((item) => item.id), ["learning:measurement-old"]);
  await assert.rejects(commitLearningOutcome({ root, id: "outcome:measurement-replay",
    learningId: "learning:measurement-new", evaluationId: "evaluation:measurement-new",
    measurementReceiptId: "measurement:outcome:measurement-before-a", now: new Date(start.getTime() + 6000) }),
  /explicitly revoked/);
  await deleteLearning({ root, id: "learning:measurement-new" });
  assert.equal((await loadLearning(root)).learning.measurementRevocations.length, 0);
  assert.equal((await purgeLearningBySubject({ root, subjectId: "person:measurement-member" })).deleted, 1);

  await proposeLearning({ root, id: "learning:measurement-unconsumed", kind: "behavior",
    claim: "Use the synthetic unconsumed measurement procedure.", privacy: "shared", scope: scopedTurn,
    evidence: evidence("evidence:measurement-unconsumed-one", 0.97), now: start });
  await addLearningEvidence({ root, id: "learning:measurement-unconsumed",
    evidence: evidence("evidence:measurement-unconsumed-two", 0.97), now: start });
  const unconsumedContract = (await evaluation(root, "learning:measurement-unconsumed", {
    id: "evaluation:measurement-unconsumed", evaluatorIds: ["evaluator:test-c", "evaluator:user-b"],
    now: start, expiresAt: "2037-02-01T00:00:00.000Z"
  })).contract;
  await recordLearningMeasurement({ root, id: "measurement:unconsumed", learningId: "learning:measurement-unconsumed",
    evaluationId: unconsumedContract.id, phase: "before", scope: scopedTurn,
    metric: { name: "fixed-task-success", direction: "higher", value: 0.4, blockingDefects: 0 },
    measurement: { kind: "objective", evaluatorId: "evaluator:test-c",
      runId: unconsumedContract.initialTrials.before[0].runId, sourceDigest: hash("unconsumed-source") },
    coverage: { datasetDigest: syntheticDatasetDigest, caseCount: 12 }, measuredAt: start,
    confirmLocalMeasurement: true, now: start });
  await revokeLearningMeasurement({ root, measurementId: "measurement:unconsumed", reasonCode: "source-invalid",
    reason: "Synthetic source invalidation.", confirmation: "local-measurement-revocation-confirmed", now: start });
  const purge = await purgeStaleLearningMeasurements({ root, confirmation: "local-user-purge-confirmed",
    now: new Date("2038-01-01T00:00:00.000Z") });
  assert.equal(purge.purged, 0);
  assert.equal((await loadLearning(root)).learning.measurements.some((item) => item.id === "measurement:unconsumed"), true);
  await assert.rejects(reviewLearning({ root, id: "learning:measurement-unconsumed", decision: "accept",
    reason: "Synthetic local review.", confirmedByUser: true }), /measurement was revoked/);
  await deleteLearning({ root, id: "learning:measurement-unconsumed" });
  assert.equal((await loadLearning(root)).learning.measurementRevocations.length, 0);
  assert.deepEqual(await readFile(join(root, "AGENTS.md")), sourceBytes);
});
