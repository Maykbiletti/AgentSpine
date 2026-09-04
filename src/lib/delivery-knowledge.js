import { createHash } from "node:crypto";
import { sessionBriefing } from "./briefing.js";
import { readDocument } from "./context.js";
import { inspectPremortemState } from "./delivery-premortem.js";
import { canonicalPath } from "./paths.js";
import { resolveMcpSources } from "./mcp-source-context.js";
import { targetSnapshot } from "./delivery-target.js";

const MAX_TARGETS = 32;
const MAX_CONTRACTS = 8;
const MAX_TERMS = 16;
const AUTHORITY = "context-only";

function boundedStrings(value, name, maximum) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum
    || value.some((item) => typeof item !== "string" || !item.trim()
      || item.length > 512 || /[\0\r\n]/.test(item))) {
    throw new Error(`${name} must contain one to ${maximum} bounded strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function contractMatches(document, terms) {
  const content = document.content.toLowerCase();
  return terms.filter((term) => content.includes(term.toLowerCase()));
}

export async function deliveryKnowledgeQuery({ root, requirementId, targetPaths,
  contractPaths, recentErrorTerms, maxBytes = 16384 }) {
  const canonicalRoot = await canonicalPath(root);
  const targets = boundedStrings(targetPaths, "targetPaths", MAX_TARGETS);
  const contracts = boundedStrings(contractPaths, "contractPaths", MAX_CONTRACTS);
  const terms = boundedStrings(recentErrorTerms, "recentErrorTerms", MAX_TERMS);
  const current = await inspectPremortemState({ root: canonicalRoot, requirementId });
  if (current.blocked || current.status === "degraded" || current.status === "absent") return current;
  const binding = current.binding;
  const sources = await resolveMcpSources({ root: canonicalRoot, host: binding.host,
    entityId: binding.entityId, groupId: binding.groupId, projectId: binding.projectId,
    currentTaskId: binding.taskId, required: true });
  const [targetResults, contractDocuments, briefing] = await Promise.all([
    Promise.all(targets.map((path) => targetSnapshot(canonicalRoot, path))),
    Promise.all(contracts.map((path) => readDocument({ root: canonicalRoot,
      path, offset: 0, length: 65536, catalog: sources.catalog }))),
    sessionBriefing({ root: canonicalRoot, cwd: canonicalRoot,
      host: binding.host, entityId: binding.entityId, groupId: binding.groupId,
      projectId: binding.projectId, currentTaskId: binding.taskId,
      includePrivate: false, focusActive: true, includeSourceContent: false, maxBytes,
      catalog: sources.catalog, userStateRoot: sources.userStateRoot,
      sourceDiagnostics: sources.diagnostics })
  ]);
  const result = {
    schema: "agentspine.delivery-knowledge-query/v1",
    requirementId,
    binding: {
      host: binding.host, projectId: binding.projectId, groupId: binding.groupId,
      taskId: binding.taskId, assignmentId: binding.assignmentId,
      goalId: binding.goalId, goalStepId: binding.goalStepId,
      queueId: binding.queueId, gatewayAttempt: binding.gatewayAttempt
    },
    targets: targetResults,
    contracts: contractDocuments.map((document) => ({ path: document.path,
      sha256: document.sha256, bytes: document.totalBytes,
      matchedRecentErrorTerms: contractMatches(document, terms), authority: AUTHORITY })),
    recentErrorTerms: terms,
    context: briefing,
    authority: AUTHORITY
  };
  return { ...result, digest: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
