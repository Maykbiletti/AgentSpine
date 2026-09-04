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

test("CLI records content-free outcome receipts and reports scoped canary diagnostics", async (t) => {
  const { root, state } = await fixture(t);
  runCli([
    "learn-propose", "learning:cli-outcome", "--root", root, "--kind", "behavior",
    "--claim", "Check the synthetic invariant.", "--evidence", "A fixed task missed the invariant.",
    "--evidence-id", "evidence:cli-outcome-one", "--confidence", "0.97",
    "--privacy", "shared", "--persona", "agent:synthetic", "--user", "user:synthetic",
    "--tenant", "tenant:synthetic", "--project", "project:synthetic", "--task", "task:synthetic", "--json"
  ], state);
  runCli(["learn-evidence", "learning:cli-outcome", "--root", root,
    "--evidence-id", "evidence:cli-outcome-two", "--type", "test",
    "--summary", "A second fixed synthetic run confirmed the invariant miss.",
    "--confidence", "0.97", "--json"], state);
  runCli(["learn-evaluator-register", "evaluator:cli", "--root", root,
    "--principal-digest", hash("root:cli"), "--confirm-local-evaluator", "--json"], state);
  runCli(["learn-evaluator-register", "evaluator:cli-two", "--root", root,
    "--principal-digest", hash("root:cli-two"), "--confirm-local-evaluator", "--json"], state);
  const cliEvaluation = runCli([
    "learn-evaluation", "evaluation:cli", "--root", root, "--learning", "learning:cli-outcome",
    "--metric", "fixed-task-success", "--direction", "higher", "--task-digest", hash("cli-task"),
    "--dataset-digest", hash("cli-dataset"), "--protocol-digest", hash("cli-protocol"),
    "--min-cases", "8", "--evaluators", "evaluator:cli,evaluator:cli-two",
    "--evaluator-roots", `evaluator:cli=${hash("root:cli")},evaluator:cli-two=${hash("root:cli-two")}`,
    "--persona", "agent:synthetic", "--user", "user:synthetic", "--tenant", "tenant:synthetic",
    "--project", "project:synthetic", "--task", "task:synthetic", "--confirm-local-evaluation",
    "--confirm-local-evidence-sources", "--json"
  ], state);
  runCli([
    "learn-measurement", "measurement:cli-before", "--root", root, "--learning", "learning:cli-outcome",
    "--evaluation", "evaluation:cli", "--phase", "before", "--metric", "fixed-task-success", "--direction", "higher", "--value", "0.4",
    "--measurement", "objective", "--evaluator", "evaluator:cli", "--run", cliEvaluation.contract.initialTrials.before[0].runId, "--source-digest", hash("cli-source"),
    "--dataset-digest", hash("cli-dataset"), "--case-count", "8",
    "--persona", "agent:synthetic",
    "--user", "user:synthetic", "--tenant", "tenant:synthetic", "--project", "project:synthetic",
    "--task", "task:synthetic", "--confirm-local-measurement", "--json"
  ], state);
  runCli([
    "learn-outcome", "learning:cli-outcome", "--root", root, "--id", "outcome:cli-before",
    "--evaluation", "evaluation:cli", "--measurement-receipt", "measurement:cli-before", "--json"
  ], state);
  const status = runCli([
    "learn-status", root, "--persona", "agent:synthetic", "--user", "user:synthetic",
    "--tenant", "tenant:synthetic", "--project", "project:synthetic", "--task", "task:synthetic", "--json"
  ], state);
  assert.equal(status.records[0].beforeReceipts, 1);
  assert.equal(status.records[0].coverageBoundReceipts, 1);
  assert.equal(status.records[0].legacyCoverageReceipts, 0);
  assert.equal(status.records[0].provenanceBoundReceipts, 1);
  assert.equal(status.records[0].legacyProvenanceReceipts, 0);
  assert.equal(status.records[0].lineageBoundReceipts, 1);
  assert.equal(status.records[0].pairedOutcomeReceipts, 1);
  assert.equal(status.records[0].pairedEvaluatorPairs, 0);
  assert.equal(status.records[0].evaluatorRootBoundReceipts, 1);
  assert.equal(status.records[0].independentEvaluatorRoots, 1);
  assert.equal(status.records[0].evaluatorRegistryContracts, 1);
  assert.equal(status.records[0].inactiveEvaluatorRegistryContracts, 0);
  assert.equal(status.records[0].targetBoundEvaluationContracts, 1);
  assert.equal(status.records[0].targetBoundApplications, 0);
  assert.equal(status.records[0].deadlineBoundEvaluationContracts, 1);
  assert.equal(status.records[0].deadlineBoundApplications, 0);
  assert.equal(status.records[0].trialFailureReceipts, 0);
  assert.deepEqual(status.evaluatorRegistry, {
    active: 2, revoked: 0, bindings: 1, validationLeases: 0, authority: "context-only"
  });
  assert.equal(status.records[0].measurementReceipts, 1);
  assert.equal(status.records[0].measurementLineageReceipts, 1);
  assert.equal(status.records[0].consumedMeasurementReceipts, 1);
  assert.equal(status.records[0].canaryStatus, "not-applicable");
  const doctor = runCli(["doctor", root, "--json"], state);
  assert.equal(doctor.learningOutcomes.pairedOutcomeReceipts, 1);
  assert.equal(doctor.learningOutcomes.pairedEvaluatorPairs, 0);
  assert.equal(doctor.learningOutcomes.evaluatorRootBoundReceipts, 1);
  assert.equal(doctor.learningOutcomes.independentEvaluatorRoots, 1);
  assert.equal(doctor.learningOutcomes.activeEvaluatorRoots, 2);
  assert.equal(doctor.learningOutcomes.revokedEvaluatorRoots, 0);
  assert.equal(doctor.learningOutcomes.evaluatorRegistryBindings, 1);
  assert.equal(doctor.learningOutcomes.evaluatorRegistryContracts, 1);
  assert.equal(doctor.learningOutcomes.inactiveEvaluatorRegistryContracts, 0);
  assert.equal(doctor.learningOutcomes.targetBoundEvaluationContracts, 1);
  assert.equal(doctor.learningOutcomes.targetBoundApplications, 0);
  assert.equal(doctor.learningOutcomes.deadlineBoundEvaluationContracts, 1);
  assert.equal(doctor.learningOutcomes.deadlineBoundApplications, 0);
  assert.equal(doctor.learningOutcomes.trialFailureReceipts, 0);
  assert.equal(doctor.learningOutcomes.initialTrialContracts, 1);
  assert.equal(doctor.learningOutcomes.requiredInitialTrials, 2);
  assert.equal(doctor.learningOutcomes.admittedInitialApplications, 0);
  assert.equal(doctor.learningOutcomes.completedInitialDeliveries, 0);
});
