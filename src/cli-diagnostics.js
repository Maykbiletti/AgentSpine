import { fileURLToPath } from "node:url";
import { runAudit } from "./lib/audit.js";
import { learningOutcomeStatus } from "./lib/learning.js";
import { checkHosts } from "../scripts/check-hosts.js";
import { resolveHostSourceCatalog } from "./lib/source-roots.js";
import { scanIndexedMemoryOrphans } from "./lib/indexed-memory-offline.js";
import { preflightStatus } from "./lib/preflight.js";
import { VERSION } from "./version.js";
import { booleanFlag, output } from "./cli-common.js";

export const diagnosticsCommands = new Set([
  "doctor",
  "audit",
  "mcp"
]);

export async function runDiagnosticsCommand({ command, flags, positional, json }) {
  if (command === "doctor") {
    let hostIntegration;
    try {
      hostIntegration = await checkHosts(fileURLToPath(new URL("..", import.meta.url)));
    } catch (error) {
      hostIntegration = { ok: false, error: error.message };
    }
    let sourceResolution = null;
    let orphanScan = null;
    const sourceHost = flags.host || process.env.AGENTSPINE_HOST;
    if (["claude", "codex"].includes(sourceHost)) {
      try {
        const resolved = await resolveHostSourceCatalog({ host: sourceHost, cwd: flags.cwd || process.cwd() });
        sourceResolution = resolved.diagnostics;
        if (booleanFlag(flags["offline-memory-orphans"])) {
          if (sourceHost !== "claude" || !resolved.memoryRoot) throw new Error("offline memory orphan scan requires a resolved Claude project-memory root");
          orphanScan = await scanIndexedMemoryOrphans(resolved.memoryRoot);
        }
      }
      catch (error) { sourceResolution = { status: "failed-closed", reason: error.message }; }
    }
    let preflight;
    try { preflight = await preflightStatus(); }
    catch (error) { preflight = { status: "failed-closed", error: error.message }; }
    let learningOutcomes;
    try {
      const status = await learningOutcomeStatus({ root: positional[0] || process.cwd() });
      const unboundAfterReceipts = status.records.reduce((sum, item) => sum + item.afterReceipts - item.boundAfterReceipts, 0);
      const undeliveredAfterReceipts = status.records.reduce((sum, item) => sum + item.afterReceipts - item.deliveredAfterReceipts, 0);
      const stalePendingApplications = status.records.reduce((sum, item) => sum + item.stalePendingApplications, 0);
      const totalOutcomeReceipts = status.records.reduce((sum, item) => sum + item.beforeReceipts + item.afterReceipts, 0);
      const plannedOutcomeReceipts = status.records.reduce((sum, item) => sum + item.plannedOutcomeReceipts, 0);
      const coverageBoundReceipts = status.records.reduce((sum, item) => sum + item.coverageBoundReceipts, 0);
      const legacyCoverageReceipts = status.records.reduce((sum, item) => sum + item.legacyCoverageReceipts, 0);
      const provenanceBoundReceipts = status.records.reduce((sum, item) => sum + item.provenanceBoundReceipts, 0);
      const legacyProvenanceReceipts = status.records.reduce((sum, item) => sum + item.legacyProvenanceReceipts, 0);
      const measurementReceipts = status.records.reduce((sum, item) => sum + item.measurementReceipts, 0);
      const measurementLineageReceipts = status.records.reduce((sum, item) => sum + item.measurementLineageReceipts, 0);
      const candidateEvidenceLineageReceipts = status.candidateEvidenceLineageReceipts;
      const consumedMeasurementReceipts = status.records.reduce((sum, item) => sum + item.consumedMeasurementReceipts, 0);
      const staleUnconsumedMeasurements = status.records.reduce((sum, item) => sum + item.staleUnconsumedMeasurements, 0);
      const lineageBoundReceipts = status.records.reduce((sum, item) => sum + item.lineageBoundReceipts, 0);
      const pairedOutcomeReceipts = status.records.reduce((sum, item) => sum + item.pairedOutcomeReceipts, 0);
      const pairedEvaluatorPairs = status.records.reduce((sum, item) => sum + item.pairedEvaluatorPairs, 0);
      const evaluatorRootBoundReceipts = status.records.reduce((sum, item) => sum + item.evaluatorRootBoundReceipts, 0);
      const independentEvaluatorRoots = status.records.reduce((sum, item) => sum + item.independentEvaluatorRoots, 0);
      const evaluatorRegistryContracts = status.records.reduce((sum, item) => sum + item.evaluatorRegistryContracts, 0);
      const inactiveEvaluatorRegistryContracts = status.records.reduce((sum, item) => sum + item.inactiveEvaluatorRegistryContracts, 0);
      const currentValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "current-validated").length;
      const staleValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "stale-validated").length;
      const unprovenValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "unproven-validated").length;
      const revokedValidatedLessons = status.records.filter((item) => item.validationLeaseStatus === "revoked-validated").length;
      const renewedValidationLeases = status.records.filter((item) =>
        ["agentspine.learning-validation/v2", "agentspine.learning-validation/v3",
          "agentspine.learning-validation/v4", "agentspine.learning-validation/v5"].includes(item.validationLeaseSchema)).length;
      const fixedCohortValidationLeases = status.records.filter((item) =>
        ["agentspine.learning-validation/v3", "agentspine.learning-validation/v4",
          "agentspine.learning-validation/v5"]
          .includes(item.validationLeaseSchema)).length;
      const admissionBoundValidationLeases = status.records.filter((item) =>
        ["agentspine.learning-validation/v4", "agentspine.learning-validation/v5"]
          .includes(item.validationLeaseSchema)).length;
      const trialBoundValidationLeases = status.records.filter((item) =>
        item.validationLeaseSchema === "agentspine.learning-validation/v5").length;
      const activeRevalidations = status.records.filter((item) => item.revalidationStatus === "active").length;
      const staleRevalidations = status.records.filter((item) => item.revalidationStatus === "stale").length;
      const fixedCohortRevalidations = status.records.filter((item) =>
        item.revalidationStatus === "active"
          && ["first-completed-turns", "first-admitted-turns",
            "first-admitted-trials"].includes(item.revalidationSelectionMode)).length;
      const admissionBoundRevalidations = status.records.filter((item) =>
        item.revalidationStatus === "active" && ["first-admitted-turns", "first-admitted-trials"]
          .includes(item.revalidationSelectionMode)).length;
      const trialBoundRevalidations = status.records.filter((item) =>
        item.revalidationStatus === "active" && item.revalidationSelectionMode === "first-admitted-trials").length;
      const requiredRevalidationDeliveries = status.records.reduce((sum, item) =>
        sum + item.revalidationRequiredDeliveries, 0);
      const completedRevalidationDeliveries = status.records.reduce((sum, item) =>
        sum + item.revalidationCompletedDeliveries, 0);
      const admittedRevalidationApplications = status.records.reduce((sum, item) =>
        sum + item.revalidationAdmittedApplications, 0);
      const initialTrialContracts = status.records.filter((item) => item.initialTrialMode === "first-admitted-trials").length;
      const requiredInitialTrials = status.records.reduce((sum, item) => sum + item.initialTrialSlots, 0);
      const admittedInitialApplications = status.records.reduce((sum, item) =>
        sum + item.initialAdmittedApplications, 0);
      const completedInitialDeliveries = status.records.reduce((sum, item) =>
        sum + item.initialCompletedDeliveries, 0);
      const incompleteInitialAdmissions = status.records.reduce((sum, item) =>
        sum + item.incompleteInitialAdmissions, 0);
      const targetBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.targetBoundEvaluationContracts, 0);
      const targetBoundApplications = status.records.reduce((sum, item) =>
        sum + item.targetBoundApplications, 0);
      const deadlineBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.deadlineBoundEvaluationContracts, 0);
      const stalenessBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.stalenessBoundEvaluationContracts, 0);
      const promotionBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.promotionBoundEvaluationContracts, 0);
      const candidateAdmissionEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.candidateAdmissionEvaluationContracts, 0);
      const evidenceSourceAttestedEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.evidenceSourceAttestedEvaluationContracts, 0);
      const candidateEvidenceLineageEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.candidateEvidenceLineageEvaluationContracts, 0);
      const candidateEvidenceCohortEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.candidateEvidenceCohortEvaluationContracts, 0);
      const blockingDefectBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.blockingDefectBoundEvaluationContracts, 0);
      const evidenceSourceBoundEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.evidenceSourceBoundEvaluationContracts, 0);
      const blockingDefectOutcomeReceipts = status.records.reduce((sum, item) =>
        sum + item.blockingDefectOutcomeReceipts, 0);
      const deadlineBoundApplications = status.records.reduce((sum, item) =>
        sum + item.deadlineBoundApplications, 0);
      const trialRetryEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.trialRetryEvaluationContracts, 0);
      const comparableTrialRetryEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.comparableTrialRetryEvaluationContracts, 0);
      const boundedTrialRetryEvaluationContracts = status.records.reduce((sum, item) =>
        sum + item.boundedTrialRetryEvaluationContracts, 0);
      const trialRetryExhaustionReceipts = status.records.reduce((sum, item) =>
        sum + item.trialRetryExhaustionReceipts, 0);
      const trialFailureReceipts = status.records.reduce((sum, item) => sum + item.trialFailureReceipts, 0);
      const trialFailureRevocationReceipts = status.records.reduce((sum, item) =>
        sum + item.trialFailureRevocationReceipts, 0);
      const evaluationRevocationReceipts = status.records.reduce((sum, item) => sum + item.evaluationRevocationReceipts, 0);
      const evidenceSourceAttestationRevocationReceipts = status.records.reduce((sum, item) =>
        sum + item.evidenceSourceAttestationRevocationReceipts, 0);
      const validationRevocationReceipts = status.records.reduce((sum, item) => sum + item.validationRevocationReceipts, 0);
      const evidenceRevocationReceipts = status.records.reduce((sum, item) => sum + item.evidenceRevocationReceipts, 0);
      const measurementRevocationReceipts = status.records.reduce((sum, item) => sum + item.measurementRevocationReceipts, 0);
      const applicationRevocationReceipts = status.records.reduce((sum, item) => sum + item.applicationRevocationReceipts, 0);
      const deliveryRevocationReceipts = status.records.reduce((sum, item) => sum + item.deliveryRevocationReceipts, 0);
      const outcomeRevocationReceipts = status.records.reduce((sum, item) => sum + item.outcomeRevocationReceipts, 0);
      const deliveryTimeoutFailures = status.records.reduce((sum, item) => sum + item.deliveryTimeoutFailures, 0);
      const outcomeTimeoutFailures = status.records.reduce((sum, item) => sum + item.outcomeTimeoutFailures, 0);
      const pendingInitialOutcomes = status.records.reduce((sum, item) => sum + item.pendingInitialOutcomes, 0);
      const staleInitialOutcomes = status.records.reduce((sum, item) => sum + item.staleInitialOutcomes, 0);
      const unplannedOutcomeReceipts = totalOutcomeReceipts - plannedOutcomeReceipts;
      learningOutcomes = {
        status: status.records.some((item) => ["stale", "revoked", "revoked-evaluation",
          "revoked-evidence-source-attestation", "revoked-validation", "revoked-evidence",
          "revoked-measurement", "revoked-application", "revoked-delivery", "revoked-outcome",
          "unproven", "failed-trial"].includes(item.canaryStatus))
          || unboundAfterReceipts > 0 || undeliveredAfterReceipts > 0 || unplannedOutcomeReceipts > 0
          || stalePendingApplications > 0 || staleUnconsumedMeasurements > 0
          || inactiveEvaluatorRegistryContracts > 0 || staleRevalidations > 0
          || staleInitialOutcomes > 0 || trialFailureRevocationReceipts > 0 ? "degraded" : "healthy",
        candidates: status.records.length,
        activeCanaries: status.records.filter((item) => item.canaryStatus === "active").length,
        validatedCanaries: status.records.filter((item) => item.canaryStatus === "validated").length,
        staleCanaries: status.records.filter((item) => item.canaryStatus === "stale").length,
        awaitingApplication: status.records.filter((item) => item.canaryStatus === "active" && item.applicationReceipts === 0).length,
        applicationReceipts: status.records.reduce((sum, item) => sum + item.applicationReceipts, 0),
        deliveryReceipts: status.records.reduce((sum, item) => sum + item.deliveryReceipts, 0),
        pendingApplications: status.records.reduce((sum, item) => sum + item.pendingApplications, 0),
        stalePendingApplications,
        evaluationContracts: status.records.reduce((sum, item) => sum + item.evaluationContracts, 0),
        targetBoundEvaluationContracts,
        targetBoundApplications,
        deadlineBoundEvaluationContracts,
        stalenessBoundEvaluationContracts,
        promotionBoundEvaluationContracts,
        candidateAdmissionEvaluationContracts,
        evidenceSourceAttestedEvaluationContracts,
        candidateEvidenceLineageEvaluationContracts,
        candidateEvidenceLineageReceipts,
        candidateEvidenceCohortEvaluationContracts,
        blockingDefectBoundEvaluationContracts,
        evidenceSourceBoundEvaluationContracts,
        blockingDefectOutcomeReceipts,
        deadlineBoundApplications,
        trialRetryEvaluationContracts,
        comparableTrialRetryEvaluationContracts,
        boundedTrialRetryEvaluationContracts,
        trialRetryExhaustionReceipts,
        trialFailureReceipts,
        trialFailureRevocationReceipts,
        evaluationRevocationReceipts,
        evidenceSourceAttestationRevocationReceipts,
        validationRevocationReceipts,
        evidenceRevocationReceipts,
        measurementRevocationReceipts,
        applicationRevocationReceipts,
        deliveryRevocationReceipts,
        outcomeRevocationReceipts,
        deliveryTimeoutFailures,
        outcomeTimeoutFailures,
        pendingInitialOutcomes,
        staleInitialOutcomes,
        plannedOutcomeReceipts,
        coverageBoundReceipts,
        legacyCoverageReceipts,
        provenanceBoundReceipts,
        legacyProvenanceReceipts,
        measurementReceipts,
        measurementLineageReceipts,
        consumedMeasurementReceipts,
        staleUnconsumedMeasurements,
        lineageBoundReceipts,
        pairedOutcomeReceipts,
        pairedEvaluatorPairs,
        evaluatorRootBoundReceipts,
        independentEvaluatorRoots,
        activeEvaluatorRoots: status.evaluatorRegistry.active,
        revokedEvaluatorRoots: status.evaluatorRegistry.revoked,
        evaluatorRegistryBindings: status.evaluatorRegistry.bindings,
        validationLeases: status.evaluatorRegistry.validationLeases,
        renewedValidationLeases,
        fixedCohortValidationLeases,
        admissionBoundValidationLeases,
        trialBoundValidationLeases,
        initialTrialContracts,
        requiredInitialTrials,
        admittedInitialApplications,
        completedInitialDeliveries,
        incompleteInitialAdmissions,
        activeRevalidations,
        staleRevalidations,
        fixedCohortRevalidations,
        admissionBoundRevalidations,
        trialBoundRevalidations,
        requiredRevalidationDeliveries,
        admittedRevalidationApplications,
        completedRevalidationDeliveries,
        currentValidatedLessons,
        staleValidatedLessons,
        unprovenValidatedLessons,
        revokedValidatedLessons,
        evaluatorRegistryContracts,
        inactiveEvaluatorRegistryContracts,
        unplannedOutcomeReceipts,
        boundAfterReceipts: status.records.reduce((sum, item) => sum + item.boundAfterReceipts, 0),
        unboundAfterReceipts,
        deliveredAfterReceipts: status.records.reduce((sum, item) => sum + item.deliveredAfterReceipts, 0),
        undeliveredAfterReceipts,
        contradictions: status.records.filter((item) => item.conflictsWith.length > 0).length,
        authority: "context-only"
      };
    } catch (error) { learningOutcomes = { status: "failed-closed", error: error.message, authority: "context-only" }; }
    const result = {
      ok: Number(process.versions.node.split(".")[0]) >= 20 && hostIntegration.ok
        && (!sourceResolution || sourceResolution.status === "loaded")
        && learningOutcomes.status !== "failed-closed",
      version: VERSION,
      node: process.versions.node,
      platform: process.platform,
      preservationMode: "read-only-source-overlay",
      stateDirectory: process.env.AGENTSPINE_STATE_DIR || "platform-default",
      hostIntegration,
      sourceResolution,
      orphanScan,
      preflight,
      learningOutcomes
    };
    output(result, json);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "audit") {
    const result = await runAudit(positional[0] || process.cwd(), { host: flags.host || process.env.AGENTSPINE_HOST || null });
    output(result, json);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "mcp") {
    const { startMcpServer } = await import("./mcp.js");
    startMcpServer();
    return;
  }
}
