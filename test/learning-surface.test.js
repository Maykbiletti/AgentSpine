import test from "node:test";
import assert from "node:assert/strict";
import * as learning from "../src/lib/learning.js";

const EXPECTED_EXPORTS = [
  "acceptContinuityLearning",
  "addLearningEvidence",
  "beginLearningRevalidation",
  "configureLearning",
  "deleteLearning",
  "evaluateLearning",
  "inspectLearning",
  "learningContext",
  "learningFindings",
  "learningOutcomeStatus",
  "loadLearning",
  "proposeLearning",
  "purgeLearningBySubject",
  "purgeStaleLearningApplications",
  "purgeStaleLearningMeasurements",
  "recordLearningApplications",
  "recordLearningDeliveries",
  "recordLearningMeasurement",
  "recordLearningOutcome",
  "registerLearningEvaluation",
  "registerLearningEvaluator",
  "renewLearningValidation",
  "reviewLearning",
  "revokeLearningApplication",
  "revokeLearningDelivery",
  "revokeLearningEvaluation",
  "revokeLearningEvaluator",
  "revokeLearningEvidence",
  "revokeLearningEvidenceSourceAttestation",
  "revokeLearningMeasurement",
  "revokeLearningOutcome",
  "revokeLearningTrialFailure",
  "revokeLearningValidation",
  "rollbackLearning"
];

test("learning compatibility surface retains exact export ownership", () => {
  assert.deepEqual(Object.keys(learning), EXPECTED_EXPORTS);
});
