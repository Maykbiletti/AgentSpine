export { buildCatalog, loadCatalog, saveCatalog, scanAndSave, verifyCatalog } from "./lib/catalog.js";
export { resolveContext, readDocument } from "./lib/context.js";
export { discoverDocuments } from "./lib/documents.js";
export { runAudit } from "./lib/audit.js";
export {
  annotateDocument, linkDocuments, linkEntities, loadGraph,
  relationshipContext, upsertEntity
} from "./lib/graph.js";
