export { buildCatalog, loadCatalog, saveCatalog, scanAndSave, verifyCatalog } from "./lib/catalog.js";
export { resolveContext, readDocument } from "./lib/context.js";
export { sessionBriefing } from "./lib/briefing.js";
export { discoverDocuments } from "./lib/documents.js";
export {
  bindSourceRoot, inspectSourceRegistry, purgeSourceBinding, resolveHostSourceCatalog,
  rollbackSourceBinding, SOURCE_REGISTRY_SCHEMA
} from "./lib/source-roots.js";
export { runAudit } from "./lib/audit.js";
export {
  attentionContext, attentionFindings, configureAttention, deleteAttention, inspectAttention, loadAttention,
  recordActivity, recordAttentionEvent, resolveAttention, upsertAttention
} from "./lib/attention.js";
export {
  acceptContinuityLearning, addLearningEvidence, beginLearningRevalidation, configureLearning, deleteLearning, evaluateLearning,
  learningContext, learningOutcomeStatus, loadLearning, proposeLearning, purgeLearningBySubject,
  purgeStaleLearningApplications, recordLearningOutcome, registerLearningEvaluation, renewLearningValidation,
  reviewLearning, revokeLearningApplication, revokeLearningDelivery, revokeLearningEvaluation, revokeLearningEvidence, revokeLearningMeasurement, revokeLearningOutcome, revokeLearningValidation,
  rollbackLearning
} from "./lib/learning.js";
export {
  captureContinuityPrompt, configureContinuity, continuityFindings,
  inspectContinuity, loadContinuity, purgeContinuity
} from "./lib/continuity.js";
export {
  checkDelegation, createTask, deleteTask, grantDelegation, loadCoordination,
  loadDelegationPolicy, revokeDelegation, taskContext, updateTask
} from "./lib/coordination.js";
export {
  authorizeJobEffect, cancelJob, checkpointJobEffect, closeJobLease, deleteJob,
  executionPolicyFindings, grantExecution, inspectSelfstarter, loadExecutionPolicy,
  loadSelfstarter, registerJob, resolveSessionJob, revokeExecution, selfstarterContext,
  selfstarterFindings, startOrResumeJob, workspaceFingerprint
} from "./lib/selfstarter.js";
export {
  CHANNEL_EVENT_SCHEMA, CHANNEL_POLICY_SCHEMA, CHANNEL_RUNTIME_SCHEMA,
  channelEventSigningPayload, channelPolicyFindings, channelRuntimeContext,
  channelRuntimeFindings, claimChannelEvent, completeChannelEvent,
  grantChannelBinding, ingestChannelEvent, inspectChannelRuntime,
  loadChannelPolicy, loadChannelRuntime, revokeChannelBinding
} from "./lib/channel-runtime.js";
export {
  PERSONA_EVENT_SCHEMA, PERSONA_POLICY_SCHEMA, PERSONA_ROSTER_SCHEMA, PERSONA_RUNTIME_SCHEMA,
  applyPersonaRoster, inspectPersonaRuntime, loadPersonaRuntime, personaContext,
  personaRuntimeFindings, syncPersonaRosterFromEnvironment
} from "./lib/persona-runtime.js";
export {
  GATEWAY_EVENT_SCHEMA, GATEWAY_POLICY_SCHEMA, GATEWAY_RUNTIME_SCHEMA,
  assignGoal, claimGatewayWork, completeGatewayRun, deliverPrepared,
  enqueueGatewayWake, gatewayContext, gatewayRuntimeFindings,
  inspectGatewayRuntime, loadGatewayRuntime, reconcileGateway, setGatewayControl
} from "./lib/gateway-runtime.js";
export { createTelegramAdapter } from "./lib/telegram-adapter.js";
export { evaluateVoiceOutput, voiceCue } from "./lib/voice-runtime.js";
export {
  MUST_REMEMBER_SCHEMA, PREFLIGHT_POLICY_SCHEMA, PREFLIGHT_SCHEMA, RETRIEVAL_QUERY_SCHEMA,
  RETRIEVAL_RESULT_SCHEMA, captureMustRememberPrompt, configurePreflightPolicy, confirmMustRemember, preflightStatus,
  recordPreflightFailure,
  proposeMustRemember, purgeMustRemember, rollbackMustRemember, runPreflight, verifyPreflightReceipt
} from "./lib/preflight.js";
export { runWorker, runWorkerTick } from "./worker.js";
export {
  configureSharing, deleteShared, initDirectoryAdapter, inspectSharing, loadSharing,
  publishLearning, pullShared, readDirectoryExchange, reviewShared, rollbackShared, sharedContext, sharedInbox,
  sharingAuthenticationFindings, sharingFindings, validateSharedEvent
} from "./lib/sharing.js";
export {
  buildHttpsSnapshot, exportHttpsSnapshot, fetchHttpsSnapshot, importHttpsSnapshot, pullHttpsSnapshot,
  resolveHttpsEndpoint, validateHttpsEndpoint, validateHttpsSnapshot
} from "./lib/https-transport.js";
export {
  httpsObjectUrl, publishHttpsSnapshot, putHttpsSnapshot, validateHttpsObjectBase
} from "./lib/object-transport.js";
export {
  fetchHttpsFeed, httpsFeedUrl, inspectHttpsFeedState, loadHttpsFeedState, publishHttpsFeed,
  pullHttpsFeed, validateHttpsFeed
} from "./lib/feed-transport.js";
export {
  buildPeerResponse, createPeerRequest, importPeerResponse, pullPeerCommand,
  servePeerOnce, validatePeerRequest, validatePeerResponse
} from "./lib/peer-transport.js";
export {
  initSqliteAdapter, inspectSqliteAdapter, publishSqliteSnapshot, pullSqliteSnapshot
} from "./lib/sqlite-transport.js";
export {
  assertTrustedIdentity, generateSigningIdentity, inspectSignerRegistry, inspectTrust, listSigningIdentities,
  loadTrust, revokeTrustedSigner, signEnvelope, trustedSignerContext, trustFindings,
  trustSigner, validatePublicIdentity, verifyEnvelope
} from "./lib/authentication.js";
export {
  annotateDocument, linkDocuments, linkEntities, loadGraph, unlinkEntities,
  relationshipContext, upsertEntity
} from "./lib/graph.js";
