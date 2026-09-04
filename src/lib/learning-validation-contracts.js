import {
  METRIC_DIRECTIONS, SCOPE_FIELDS, ID_RE, DIGEST_RE, REGISTRY_BOUND_EVALUATIONS, INITIAL_TRIAL_EVALUATIONS,
  TARGET_BOUND_EVALUATIONS, DEADLINE_BOUND_EVALUATIONS, STALENESS_BOUND_EVALUATIONS, INITIAL_TRIAL_APPLICATIONS, TARGET_BOUND_APPLICATIONS
} from "./learning-schema.js";
import {
  exactScope, digest, learningTargetMatchesCandidate
} from "./learning-scope-targets.js";
import {
  improvement
} from "./learning-reconciliation.js";

export function revokedEvaluationForCandidate(state, candidate) {
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  if (canary?.evaluationId) {
    return state.evaluationRevocations.find((receipt) => receipt.learningId === candidate.id
      && receipt.evaluationId === canary.evaluationId
      && receipt.evaluationDigest === canary.evaluationDigest) || null;
  }
  return state.evaluationRevocations.find((receipt) => receipt.learningId === candidate?.id) || null;
}

export function validationOutcomeReferences(receipts) {
  return receipts.map((receipt) => ({ id: receipt.id, digest: receipt.digest, authority: "context-only" }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function revalidationWindowPayload({
  id, status, startedAt, expiresAt, predecessorValidationId, predecessorValidationDigest, selection,
  schema = "agentspine.learning-revalidation-window/v1"
}) {
  const selectionBound = ["agentspine.learning-revalidation-window/v2",
    "agentspine.learning-revalidation-window/v3", "agentspine.learning-revalidation-window/v4"].includes(schema);
  return {
    schema,
    ...(selectionBound ? { id } : {}),
    status,
    startedAt,
    expiresAt,
    predecessorValidationId,
    predecessorValidationDigest,
    ...(selectionBound ? { selection } : {}),
    authority: "context-only"
  };
}

export function revalidationTrialPayload({ evaluationId, evaluationDigest, predecessorValidationId,
  predecessorValidationDigest, slot, evaluatorId, evaluatorRootDigest, runId, benchmark, caseCount }) {
  return {
    schema: "agentspine.learning-revalidation-trial/v1",
    evaluationId,
    evaluationDigest,
    predecessorValidationId,
    predecessorValidationDigest,
    slot,
    evaluatorId,
    evaluatorRootDigest,
    runId,
    benchmarkDigest: digest(benchmark),
    caseCount,
    authority: "context-only"
  };
}

export function revalidationTrialDigest(input) {
  return digest(revalidationTrialPayload(input));
}

export function storedRevalidationWindowStructure(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return false;
  const payload = revalidationWindowPayload(window);
  const common = ["agentspine.learning-revalidation-window/v1", "agentspine.learning-revalidation-window/v2",
    "agentspine.learning-revalidation-window/v3", "agentspine.learning-revalidation-window/v4"]
    .includes(window.schema)
    && window.status === "active" && window.authority === "context-only"
    && Number.isFinite(new Date(window.startedAt).getTime())
    && Number.isFinite(new Date(window.expiresAt).getTime())
    && new Date(window.expiresAt).getTime() > new Date(window.startedAt).getTime()
    && ID_RE.test(window.predecessorValidationId || "")
    && DIGEST_RE.test(window.predecessorValidationDigest || "");
  if (!common) return false;
  if (window.schema === "agentspine.learning-revalidation-window/v1") return true;
  const roots = window.selection?.evaluatorRoots;
  const validMode = window.schema === "agentspine.learning-revalidation-window/v2"
    ? window.selection?.mode === "first-completed-turns"
    : window.schema === "agentspine.learning-revalidation-window/v3"
      ? window.selection?.mode === "first-admitted-turns"
      : window.selection?.mode === "first-admitted-trials";
  return ID_RE.test(window.id || "") && validMode
    && Number.isInteger(window.selection?.requiredDeliveries)
    && window.selection.requiredDeliveries >= 2 && window.selection.requiredDeliveries <= 10
    && Array.isArray(roots) && roots.length === window.selection.requiredDeliveries
    && roots.every((entry, index) => entry?.slot === index + 1
      && DIGEST_RE.test(entry?.evaluatorRootDigest || "")
      && (window.schema !== "agentspine.learning-revalidation-window/v4"
        || (ID_RE.test(entry?.evaluatorId || "") && ID_RE.test(entry?.runId || "")
          && Number.isInteger(entry?.caseCount) && entry.caseCount >= 1 && entry.caseCount <= 1000000
          && DIGEST_RE.test(entry?.trialDigest || "")))
      && entry?.authority === "context-only")
    && new Set(roots.map((entry) => entry.evaluatorRootDigest)).size === roots.length
    && window.selection.authority === "context-only" && window.digest === digest(payload);
}

export function revalidationWindowMatchesState(state, candidate) {
  const window = candidate?.promotion?.canary?.revalidation;
  if (!window) return true;
  const predecessor = state.validationLeases.find((lease) => lease.id === window.predecessorValidationId
    && lease.digest === window.predecessorValidationDigest && lease.learningId === candidate.id);
  if (!storedRevalidationWindowStructure(window) || candidate.promotion?.canary?.status !== "validated"
    || !predecessor || window.expiresAt !== predecessor.expiresAt) return false;
  if (window.schema === "agentspine.learning-revalidation-window/v1") return true;
  const references = predecessor.schema === "agentspine.learning-validation/v1"
    ? predecessor.beforeOutcomes : predecessor.baselineOutcomes;
  const baselines = references.map((reference) => state.outcomes.find((outcome) =>
    outcome.id === reference.id && outcome.digest === reference.digest))
    .filter(Boolean).sort((a, b) => a.measurement.evaluatorId.localeCompare(b.measurement.evaluatorId));
  const contract = state.evaluations.find((entry) => entry.id === candidate.promotion?.canary?.evaluationId
    && entry.digest === candidate.promotion.canary.evaluationDigest);
  return baselines.length === references.length && baselines.length === window.selection.requiredDeliveries
    && window.selection.evaluatorRoots.every((entry, index) => {
      const baseline = baselines[index];
      if (entry.evaluatorRootDigest !== baseline.measurement.evaluatorRootDigest) return false;
      if (window.schema !== "agentspine.learning-revalidation-window/v4") return true;
      return contract && entry.evaluatorId === baseline.measurement.evaluatorId
        && entry.caseCount === baseline.coverage.caseCount
        && entry.trialDigest === revalidationTrialDigest({
          evaluationId: contract.id, evaluationDigest: contract.digest,
          predecessorValidationId: predecessor.id, predecessorValidationDigest: predecessor.digest,
          slot: entry.slot, evaluatorId: entry.evaluatorId, evaluatorRootDigest: entry.evaluatorRootDigest,
          runId: entry.runId, benchmark: contract.benchmark, caseCount: entry.caseCount
        });
    });
}

export function validationLeasePayload({
  id, learningId, evaluationId, evaluationDigest, evaluatorRegistryBindingDigest,
  scope, metric, beforeOutcomes, afterOutcomes, baselineOutcomes, predecessorValidation,
  renewalEvidence, selectionProof, improvement, validatedAt, expiresAt,
  schema = "agentspine.learning-validation/v1"
}) {
  return {
    schema,
    id,
    learningId,
    evaluationId,
    evaluationDigest,
    evaluatorRegistryBindingDigest,
    scope,
    metric,
    ...(schema === "agentspine.learning-validation/v1"
      ? { beforeOutcomes, afterOutcomes }
      : { baselineOutcomes, predecessorValidation, renewalEvidence,
          ...(["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
            "agentspine.learning-validation/v5"].includes(schema)
            ? { selectionProof } : {}) }),
    improvement,
    validatedAt,
    expiresAt,
    authority: "context-only"
  };
}

export function storedValidationLeaseStructure(lease) {
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) return false;
  const payload = validationLeasePayload(lease);
  const validReferences = (items) => Array.isArray(items) && items.length >= 2
    && items.every((entry) => ID_RE.test(entry?.id || "") && DIGEST_RE.test(entry?.digest || "")
      && entry?.authority === "context-only")
    && new Set(items.map((entry) => entry.id)).size === items.length;
  const validPredecessor = lease.predecessorValidation && ID_RE.test(lease.predecessorValidation.id || "")
    && DIGEST_RE.test(lease.predecessorValidation.digest || "")
    && lease.predecessorValidation.authority === "context-only";
  const validRenewalEvidence = Array.isArray(lease.renewalEvidence) && lease.renewalEvidence.length >= 2
    && lease.renewalEvidence.every((entry) => ID_RE.test(entry?.measurementId || "")
      && DIGEST_RE.test(entry?.measurementDigest || "") && ID_RE.test(entry?.applicationId || "")
      && DIGEST_RE.test(entry?.applicationDigest || "") && ID_RE.test(entry?.deliveryId || "")
      && DIGEST_RE.test(entry?.deliveryDigest || "") && DIGEST_RE.test(entry?.evaluatorRootDigest || "")
      && entry?.authority === "context-only")
    && new Set(lease.renewalEvidence.map((entry) => entry.measurementId)).size === lease.renewalEvidence.length
    && new Set(lease.renewalEvidence.map((entry) => entry.applicationId)).size === lease.renewalEvidence.length
    && new Set(lease.renewalEvidence.map((entry) => entry.deliveryId)).size === lease.renewalEvidence.length
    && new Set(lease.renewalEvidence.map((entry) => entry.evaluatorRootDigest)).size === lease.renewalEvidence.length;
  const admissionBound = ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema);
  const trialBound = lease.schema === "agentspine.learning-validation/v5";
  const selectionEntries = admissionBound
    ? lease.selectionProof?.applications : lease.selectionProof?.deliveries;
  const validSelectionProof = lease.selectionProof && ID_RE.test(lease.selectionProof.revalidationWindowId || "")
    && DIGEST_RE.test(lease.selectionProof.revalidationWindowDigest || "")
    && (trialBound
      ? lease.selectionProof.mode === "first-admitted-trials"
      : lease.schema === "agentspine.learning-validation/v4"
        ? lease.selectionProof.mode === "first-admitted-turns"
      : lease.selectionProof.mode === "first-completed-turns")
    && Number.isInteger(lease.selectionProof.requiredDeliveries)
    && lease.selectionProof.requiredDeliveries >= 2 && lease.selectionProof.requiredDeliveries <= 10
    && Array.isArray(selectionEntries)
    && selectionEntries.length === lease.selectionProof.requiredDeliveries
    && selectionEntries.every((entry, index) => entry?.slot === index + 1
      && (!admissionBound
        || (ID_RE.test(entry?.applicationId || "") && DIGEST_RE.test(entry?.applicationDigest || "")))
      && ID_RE.test(entry?.deliveryId || "") && DIGEST_RE.test(entry?.deliveryDigest || "")
      && DIGEST_RE.test(entry?.evaluatorRootDigest || "")
      && (!trialBound || (ID_RE.test(entry?.evaluatorId || "") && ID_RE.test(entry?.runId || "")
        && DIGEST_RE.test(entry?.trialDigest || "")))
      && entry?.authority === "context-only")
    && new Set(selectionEntries.map((entry) => entry.deliveryId)).size === selectionEntries.length
    && new Set(selectionEntries.map((entry) => entry.evaluatorRootDigest)).size === selectionEntries.length
    && (!admissionBound
      || new Set(selectionEntries.map((entry) => entry.applicationId)).size === selectionEntries.length)
    && lease.selectionProof.authority === "context-only";
  return ["agentspine.learning-validation/v1", "agentspine.learning-validation/v2",
    "agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
    "agentspine.learning-validation/v5"].includes(lease.schema)
    && ID_RE.test(lease.id || "")
    && ID_RE.test(lease.learningId || "") && ID_RE.test(lease.evaluationId || "")
    && DIGEST_RE.test(lease.evaluationDigest || "") && DIGEST_RE.test(lease.evaluatorRegistryBindingDigest || "")
    && lease.scope && SCOPE_FIELDS.every((field) => Object.hasOwn(lease.scope, field))
    && Object.keys(lease.scope).every((field) => SCOPE_FIELDS.includes(field))
    && Object.values(lease.scope).every((value) => value === null || ID_RE.test(value))
    && typeof lease.metric?.name === "string" && lease.metric.name.length > 0
    && METRIC_DIRECTIONS.has(lease.metric?.direction)
    && (lease.schema === "agentspine.learning-validation/v1"
      ? validReferences(lease.beforeOutcomes) && validReferences(lease.afterOutcomes)
      : validReferences(lease.baselineOutcomes) && validPredecessor && validRenewalEvidence
        && (!["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
          "agentspine.learning-validation/v5"].includes(lease.schema)
          || validSelectionProof))
    && Number.isFinite(lease.improvement) && lease.improvement >= -1 && lease.improvement <= 1
    && Number.isFinite(new Date(lease.validatedAt).getTime()) && Number.isFinite(new Date(lease.expiresAt).getTime())
    && new Date(lease.expiresAt).getTime() > new Date(lease.validatedAt).getTime()
    && lease.authority === "context-only" && lease.digest === digest(payload);
}

export function validationLeaseMatchesState(state, lease) {
  const candidate = state.candidates.find((item) => item.id === lease.learningId);
  const canary = candidate?.promotion?.mode === "outcome-canary" ? candidate.promotion.canary : null;
  const contract = state.evaluations.find((item) => item.id === lease.evaluationId);
  const binding = state.evaluationBindings.find((item) => item.evaluationId === lease.evaluationId);
  const referencesMatch = (references, phase) => references.every((reference) => state.outcomes.some((outcome) =>
    outcome.id === reference.id && outcome.digest === reference.digest && outcome.learningId === lease.learningId
    && outcome.evaluationId === lease.evaluationId && outcome.phase === phase && exactScope(outcome.scope, lease.scope)));
  const common = candidate && canary && canary.status === "validated"
    && canary.validationLeaseId === lease.id && canary.validationLeaseDigest === lease.digest
    && canary.validatedAt === lease.validatedAt && canary.expiresAt === lease.expiresAt
    && Math.abs(canary.improvement - lease.improvement) <= 1e-12
    && REGISTRY_BOUND_EVALUATIONS.has(contract?.schema)
    && contract.digest === lease.evaluationDigest
    && (!INITIAL_TRIAL_EVALUATIONS.has(contract.schema)
      || canary.initialTrialsDigest === digest(contract.initialTrials))
    && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
      || (canary.targetDigest === contract.target.digest && learningTargetMatchesCandidate(contract.target, candidate)))
    && (!DEADLINE_BOUND_EVALUATIONS.has(contract.schema)
      || canary.completionPolicyDigest === contract.completionPolicy.digest)
    && (!STALENESS_BOUND_EVALUATIONS.has(contract.schema)
      || canary.stalenessPolicyDigest === contract.stalenessPolicy.digest)
    && binding?.digest === lease.evaluatorRegistryBindingDigest
    && exactScope(contract.scope, lease.scope) && digest(contract.metric) === digest(lease.metric);
  const evidenceMatches = lease.schema === "agentspine.learning-validation/v1"
    ? lease.beforeOutcomes.length >= contract.thresholds.beforeReceipts
        && lease.afterOutcomes.length >= contract.thresholds.afterReceipts
        && referencesMatch(lease.beforeOutcomes, "before") && referencesMatch(lease.afterOutcomes, "after")
        && canary.beforeReceipts.length === lease.beforeOutcomes.length
        && lease.beforeOutcomes.every((reference) => canary.beforeReceipts.includes(reference.id))
        && canary.afterReceipts.length === lease.afterOutcomes.length
        && lease.afterOutcomes.every((reference) => canary.afterReceipts.includes(reference.id))
      : lease.baselineOutcomes.length >= contract.thresholds.beforeReceipts
        && referencesMatch(lease.baselineOutcomes, "before")
        && lease.renewalEvidence.length >= contract.thresholds.afterReceipts
        && state.history.some((entry) => entry.kind === "learning-validation"
          && entry.value?.id === lease.predecessorValidation.id
          && entry.value?.digest === lease.predecessorValidation.digest
          && storedValidationLeaseStructure(entry.value))
      && lease.renewalEvidence.every((evidence) => {
          const measurement = state.measurements.find((entry) => entry.id === evidence.measurementId
            && entry.digest === evidence.measurementDigest);
          const application = state.applications.find((entry) => entry.id === evidence.applicationId
            && entry.digest === evidence.applicationDigest);
          const delivery = state.deliveries.find((entry) => entry.id === evidence.deliveryId
            && entry.digest === evidence.deliveryDigest);
          return measurement?.phase === "after" && measurement.evaluationId === lease.evaluationId
            && measurement.measurement?.evaluatorRootDigest === evidence.evaluatorRootDigest
            && application?.learningId === lease.learningId && delivery?.applicationId === application.id
            && delivery.learningId === lease.learningId && exactScope(measurement.scope, lease.scope)
            && exactScope(application.scope, lease.scope) && exactScope(delivery.scope, lease.scope);
      });
  const selectionMatches = !["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
    "agentspine.learning-validation/v5"]
    .includes(lease.schema) || (() => {
    const historicalWindow = state.history.find((entry) => entry.kind === "learning-candidate"
      && entry.value?.id === lease.learningId
      && entry.value?.promotion?.canary?.revalidation?.id === lease.selectionProof.revalidationWindowId
      && entry.value.promotion.canary.revalidation.digest === lease.selectionProof.revalidationWindowDigest)
      ?.value?.promotion?.canary?.revalidation;
    if (!storedRevalidationWindowStructure(historicalWindow)
      || (lease.schema === "agentspine.learning-validation/v3"
        ? historicalWindow.schema !== "agentspine.learning-revalidation-window/v2"
        : lease.schema === "agentspine.learning-validation/v4"
          ? historicalWindow.schema !== "agentspine.learning-revalidation-window/v3"
          : historicalWindow.schema !== "agentspine.learning-revalidation-window/v4")
      || historicalWindow.selection.mode !== lease.selectionProof.mode
      || historicalWindow.selection.requiredDeliveries !== lease.selectionProof.requiredDeliveries) return false;
    const selectedEntries = ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema)
      ? lease.selectionProof.applications : lease.selectionProof.deliveries;
    return selectedEntries.every((selected, index) => {
      const frozen = historicalWindow.selection.evaluatorRoots[index];
      const evidence = lease.renewalEvidence.find((entry) => entry.deliveryId === selected.deliveryId);
      const measurement = evidence ? state.measurements.find((entry) => entry.id === evidence.measurementId
        && entry.digest === evidence.measurementDigest) : null;
      const application = ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema)
        ? state.applications.find((entry) => entry.id === selected.applicationId
          && entry.digest === selected.applicationDigest) : null;
      return frozen?.slot === selected.slot && frozen.evaluatorRootDigest === selected.evaluatorRootDigest
        && (lease.schema !== "agentspine.learning-validation/v5"
          || (frozen.evaluatorId === selected.evaluatorId && frozen.runId === selected.runId
            && frozen.trialDigest === selected.trialDigest
            && measurement?.measurement?.evaluatorId === selected.evaluatorId
            && measurement?.measurement?.runId === selected.runId
            && measurement?.coverage?.caseCount === frozen.caseCount
            && selected.trialDigest === revalidationTrialDigest({
              evaluationId: lease.evaluationId, evaluationDigest: lease.evaluationDigest,
              predecessorValidationId: lease.predecessorValidation.id,
              predecessorValidationDigest: lease.predecessorValidation.digest,
              slot: selected.slot, evaluatorId: selected.evaluatorId,
              evaluatorRootDigest: selected.evaluatorRootDigest, runId: selected.runId,
              benchmark: contract.benchmark, caseCount: frozen.caseCount
            })))
        && (!["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(lease.schema)
          || (evidence?.applicationId === selected.applicationId
            && evidence.applicationDigest === selected.applicationDigest
            && application?.schema === (lease.schema === "agentspine.learning-validation/v5"
              ? "agentspine.learning-application/v4" : "agentspine.learning-application/v3")
            && application.revalidationAdmission.revalidationWindowId === historicalWindow.id
            && application.revalidationAdmission.revalidationWindowDigest === historicalWindow.digest
            && application.revalidationAdmission.slot === selected.slot
            && application.revalidationAdmission.evaluatorRootDigest === selected.evaluatorRootDigest
            && (lease.schema !== "agentspine.learning-validation/v5"
              || (application.revalidationAdmission.trialDigest === selected.trialDigest
                && application.revalidationAdmission.runId === selected.runId
                && application.revalidationAdmission.evaluatorId === selected.evaluatorId))))
        && evidence?.deliveryDigest === selected.deliveryDigest
        && evidence.evaluatorRootDigest === selected.evaluatorRootDigest;
    });
  })();
  const initialSelectionMatches = !INITIAL_TRIAL_EVALUATIONS.has(contract?.schema)
    || lease.schema !== "agentspine.learning-validation/v1" || (() => {
    if (lease.beforeOutcomes.length !== contract.initialTrials.requiredTrials
      || lease.afterOutcomes.length !== contract.initialTrials.requiredTrials) return false;
    const outcomeMatchesTrial = (reference, phase, trial) => {
      const outcome = state.outcomes.find((entry) => entry.id === reference.id && entry.digest === reference.digest);
      const measurement = outcome && state.measurements.find((entry) => entry.id === outcome.measurementReceiptId
        && entry.digest === outcome.measurementReceiptDigest);
      if (!outcome || !measurement || outcome.phase !== phase
        || measurement.measurement.evaluatorId !== trial.evaluatorId
        || measurement.measurement.evaluatorRootDigest !== trial.evaluatorRootDigest
        || measurement.measurement.runId !== trial.runId || measurement.coverage.caseCount !== trial.caseCount) return false;
      if (phase === "before") return true;
      const application = state.applications.find((entry) => entry.id === outcome.applicationId
        && INITIAL_TRIAL_APPLICATIONS.has(entry.schema)
        && entry.initialAdmission.evaluationId === contract.id
        && entry.initialAdmission.evaluationDigest === contract.digest
        && entry.initialAdmission.slot === trial.slot
        && entry.initialAdmission.trialDigest === trial.trialDigest
        && (!TARGET_BOUND_EVALUATIONS.has(contract.schema)
          || (TARGET_BOUND_APPLICATIONS.has(entry.schema)
            && entry.initialAdmission.targetDigest === contract.target.digest)));
      const delivery = application && state.deliveries.find((entry) => entry.id === outcome.deliveryId
        && entry.applicationId === application.id);
      return Boolean(application && delivery);
    };
    return contract.initialTrials.before.every((trial, index) =>
      outcomeMatchesTrial(lease.beforeOutcomes[index], "before", trial))
      && contract.initialTrials.after.every((trial, index) =>
        outcomeMatchesTrial(lease.afterOutcomes[index], "after", trial));
  })();
  return Boolean(common && evidenceMatches && selectionMatches && initialSelectionMatches);
}
