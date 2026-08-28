export { buildCatalog, loadCatalog, saveCatalog, scanAndSave, verifyCatalog } from "./lib/catalog.js";
export { resolveContext, readDocument } from "./lib/context.js";
export { discoverDocuments } from "./lib/documents.js";
export { runAudit } from "./lib/audit.js";
export {
  attentionContext, configureAttention, deleteAttention, loadAttention,
  recordActivity, resolveAttention, upsertAttention
} from "./lib/attention.js";
export {
  addLearningEvidence, configureLearning, deleteLearning, evaluateLearning,
  learningContext, loadLearning, proposeLearning, reviewLearning, rollbackLearning
} from "./lib/learning.js";
export {
  checkDelegation, createTask, deleteTask, grantDelegation, loadCoordination,
  loadDelegationPolicy, revokeDelegation, taskContext, updateTask
} from "./lib/coordination.js";
export {
  annotateDocument, linkDocuments, linkEntities, loadGraph,
  relationshipContext, upsertEntity
} from "./lib/graph.js";
