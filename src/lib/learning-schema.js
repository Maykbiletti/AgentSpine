export const KINDS = new Set(["preference", "no-go", "goal", "correction", "personal-fact", "project-fact", "reference", "behavior"]);

export const EVIDENCE_TYPES = new Set(["user-statement", "document", "interaction", "test"]);

export const PRIVACY = new Set(["private", "shared", "group"]);

export const STATUSES = new Set(["candidate", "accepted", "rejected", "superseded", "rolled-back"]);

export const AUTO_KINDS = new Set(["project-fact", "reference"]);

export const OUTCOME_AUTO_KINDS = new Set(["behavior"]);

export const CONTINUITY_AUTO_KINDS = new Set(["preference", "no-go", "correction", "project-fact", "reference"]);

export const OUTCOME_PHASES = new Set(["before", "after"]);

export const MEASUREMENT_KINDS = new Set(["objective", "user-feedback", "model-suggestion"]);

export const METRIC_DIRECTIONS = new Set(["higher", "lower"]);

export const SCOPE_FIELDS = ["personaId", "userId", "tenantId", "projectId", "groupId", "taskId"];

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;

export const DIGEST_RE = /^[a-f0-9]{64}$/;

export const MAX_STATE_BYTES = 5 * 1024 * 1024;

export const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusu])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;

export const AUTHORITY_ASSERTION_RE = /\b(?:user|agent|person|they|he|she|i|ich|wir|nutzer|benutzer).{0,60}\b(?:may|can|is allowed|is authorized|has|have|darf|berechtigt|hat|haben).{0,50}\b(?:admin(?:istrator)?|permissions?|rights?|authorization|production access|deploy|billing|spending|policy exception|bypass|zugang|rechte|berechtigung|produktion|abrechnung|ausnahme|umgehen)\b/i;

export const PROTECTED_LESSON_RE = /\b(?:security|safety|identity|authentication|authorization|permissions?|credentials?|secrets?|policy|production|deployment|payments?|billing|tool access|file access|network access|database access|sicherheit|identität|authentifizierung|berechtigungen?|zugang|richtlinie|produktion|zahlungen?)\b/i;

export const EVALUATION_SCHEMAS = new Set(Array.from({ length: 29 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 1}`));

export const COVERAGE_EVALUATIONS = new Set(Array.from({ length: 28 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 2}`));

export const LINEAGE_EVALUATIONS = new Set(Array.from({ length: 26 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 4}`));

export const PAIRED_EVALUATIONS = new Set(Array.from({ length: 25 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 5}`));

export const ROOT_BOUND_EVALUATIONS = new Set(Array.from({ length: 24 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 6}`));

export const REGISTRY_BOUND_EVALUATIONS = new Set(Array.from({ length: 23 }, (_, index) =>
  `agentspine.learning-evaluation/v${index + 7}`));

export const INITIAL_TRIAL_EVALUATIONS = new Set(["agentspine.learning-evaluation/v8", "agentspine.learning-evaluation/v9",
  "agentspine.learning-evaluation/v10", "agentspine.learning-evaluation/v11", "agentspine.learning-evaluation/v12",
  "agentspine.learning-evaluation/v13", "agentspine.learning-evaluation/v14", "agentspine.learning-evaluation/v15",
  "agentspine.learning-evaluation/v16", "agentspine.learning-evaluation/v17",
  "agentspine.learning-evaluation/v18", "agentspine.learning-evaluation/v19",
  "agentspine.learning-evaluation/v20", "agentspine.learning-evaluation/v21",
  "agentspine.learning-evaluation/v22", "agentspine.learning-evaluation/v23",
  "agentspine.learning-evaluation/v24", "agentspine.learning-evaluation/v25",
  "agentspine.learning-evaluation/v26", "agentspine.learning-evaluation/v27",
  "agentspine.learning-evaluation/v28", "agentspine.learning-evaluation/v29"]);

export const TARGET_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v9", "agentspine.learning-evaluation/v10",
  "agentspine.learning-evaluation/v11", "agentspine.learning-evaluation/v12", "agentspine.learning-evaluation/v13",
  "agentspine.learning-evaluation/v14", "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v16",
  "agentspine.learning-evaluation/v17", "agentspine.learning-evaluation/v18",
  "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v20",
  "agentspine.learning-evaluation/v21", "agentspine.learning-evaluation/v22",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24",
  "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const DEADLINE_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v10", "agentspine.learning-evaluation/v11",
  "agentspine.learning-evaluation/v12", "agentspine.learning-evaluation/v13", "agentspine.learning-evaluation/v14",
  "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v16", "agentspine.learning-evaluation/v17",
  "agentspine.learning-evaluation/v18", "agentspine.learning-evaluation/v19",
  "agentspine.learning-evaluation/v20", "agentspine.learning-evaluation/v21",
  "agentspine.learning-evaluation/v22", "agentspine.learning-evaluation/v23",
  "agentspine.learning-evaluation/v24", "agentspine.learning-evaluation/v25",
  "agentspine.learning-evaluation/v26", "agentspine.learning-evaluation/v27",
  "agentspine.learning-evaluation/v28", "agentspine.learning-evaluation/v29"]);

export const TRIAL_RETRY_EVALUATIONS = new Set(["agentspine.learning-evaluation/v11", "agentspine.learning-evaluation/v12",
  "agentspine.learning-evaluation/v13", "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v17",
  "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v21",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v25",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v29"]);

export const COMPARABLE_TRIAL_RETRY_EVALUATIONS = new Set(["agentspine.learning-evaluation/v12",
  "agentspine.learning-evaluation/v13", "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v17",
  "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v21",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v25",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v29"]);

export const BOUNDED_TRIAL_RETRY_EVALUATIONS = new Set(["agentspine.learning-evaluation/v13",
  "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v17",
  "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v21",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v25",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v29"]);

export const STALENESS_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v14",
  "agentspine.learning-evaluation/v15", "agentspine.learning-evaluation/v16", "agentspine.learning-evaluation/v17",
  "agentspine.learning-evaluation/v18", "agentspine.learning-evaluation/v19",
  "agentspine.learning-evaluation/v20", "agentspine.learning-evaluation/v21",
  "agentspine.learning-evaluation/v22", "agentspine.learning-evaluation/v23",
  "agentspine.learning-evaluation/v24", "agentspine.learning-evaluation/v25",
  "agentspine.learning-evaluation/v26", "agentspine.learning-evaluation/v27",
  "agentspine.learning-evaluation/v28", "agentspine.learning-evaluation/v29"]);

export const PROMOTION_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v16",
  "agentspine.learning-evaluation/v17", "agentspine.learning-evaluation/v18",
  "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v20",
  "agentspine.learning-evaluation/v21", "agentspine.learning-evaluation/v22",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24",
  "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const CANDIDATE_ADMISSION_EVALUATIONS = new Set(["agentspine.learning-evaluation/v18",
  "agentspine.learning-evaluation/v19", "agentspine.learning-evaluation/v20",
  "agentspine.learning-evaluation/v21", "agentspine.learning-evaluation/v22",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24",
  "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const CANDIDATE_EVIDENCE_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v20",
  "agentspine.learning-evaluation/v21", "agentspine.learning-evaluation/v22",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24",
  "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const BLOCKING_DEFECT_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v22",
  "agentspine.learning-evaluation/v23", "agentspine.learning-evaluation/v24",
  "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const EVIDENCE_SOURCE_BOUND_EVALUATIONS = new Set(["agentspine.learning-evaluation/v24",
  "agentspine.learning-evaluation/v25", "agentspine.learning-evaluation/v26",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const EVIDENCE_SOURCE_ATTESTED_EVALUATIONS = new Set(["agentspine.learning-evaluation/v26",
  "agentspine.learning-evaluation/v27", "agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const CANDIDATE_EVIDENCE_LINEAGE_EVALUATIONS = new Set(["agentspine.learning-evaluation/v28",
  "agentspine.learning-evaluation/v29"]);

export const DELIVERABLE_APPLICATIONS = new Set(Array.from({ length: 6 }, (_, index) =>
  `agentspine.learning-application/v${index + 2}`));

export const INITIAL_TRIAL_APPLICATIONS = new Set(["agentspine.learning-application/v5", "agentspine.learning-application/v6",
  "agentspine.learning-application/v7"]);

export const TARGET_BOUND_APPLICATIONS = new Set(["agentspine.learning-application/v6", "agentspine.learning-application/v7"]);

export const DEADLINE_BOUND_APPLICATIONS = new Set(["agentspine.learning-application/v7"]);

export const EVIDENCE_REVOCATION_REASONS = new Set(["retracted", "source-invalid", "measurement-invalid", "duplicate", "other"]);

export const MEASUREMENT_REVOCATION_REASONS = new Set(["source-invalid", "evaluator-invalid", "protocol-invalid", "duplicate", "other"]);

export const DELIVERY_REVOCATION_REASONS = new Set(["host-invalid", "session-invalid", "hook-invalid", "duplicate", "other"]);

export const OUTCOME_REVOCATION_REASONS = new Set(["binding-invalid", "phase-invalid", "scope-invalid", "duplicate", "other"]);

export const APPLICATION_REVOCATION_REASONS = new Set(["preflight-invalid", "scope-invalid", "projection-invalid", "duplicate", "other"]);

export const EVALUATION_REVOCATION_REASONS = new Set(["benchmark-invalid", "protocol-invalid", "scope-invalid", "threshold-invalid", "duplicate", "other"]);

export const EVIDENCE_SOURCE_ATTESTATION_REVOCATION_REASONS = new Set([
  "source-class-invalid", "confirmation-invalid", "scope-invalid", "duplicate", "other"
]);

export const VALIDATION_REVOCATION_REASONS = new Set(["decision-invalid", "cohort-invalid", "binding-invalid", "scope-invalid", "duplicate", "other"]);

export const TRIAL_FAILURE_REVOCATION_REASONS = new Set(["clock-invalid", "host-invalid", "receipt-invalid", "scope-invalid", "duplicate", "other"]);

export function defaults() {
  return {
    autoPromote: false,
    minConfidence: 0.85,
    minEvidence: 2,
    maxContextItems: 12,
    minOutcomeReceipts: 2,
    minImprovement: 0.05,
    regressionTolerance: 0,
    outcomeMaxAgeDays: 30,
    canaryReceipts: 2,
    canaryTtlDays: 14,
    initialTrialOutcomeTimeoutMinutes: 1440
  };
}

export function emptyLearning(root) {
  return {
    schema: "agentspine.learning/v1",
    root,
    config: defaults(),
    candidates: [],
    outcomes: [],
    measurements: [],
    measurementLineage: [],
    candidateEvidenceLineage: [],
    applications: [],
    deliveries: [],
    evaluations: [],
    evaluatorRegistry: [],
    evaluationBindings: [],
    validationLeases: [],
    trialFailures: [],
    trialFailureRevocations: [],
    trialRetryExhaustions: [],
    evaluationRevocations: [],
    evidenceSourceAttestationRevocations: [],
    validationRevocations: [],
    evidenceRevocations: [],
    measurementRevocations: [],
    applicationRevocations: [],
    deliveryRevocations: [],
    outcomeRevocations: [],
    history: []
  };
}
