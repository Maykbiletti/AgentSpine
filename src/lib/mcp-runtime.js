import { runAudit } from "./audit.js";
import {
  attentionContext, configureAttention, deleteAttention,
  recordActivity, resolveAttention, upsertAttention
} from "./attention.js";
import { sessionBriefing } from "./briefing.js";
import { deliveryKnowledgeQuery } from "./delivery-knowledge.js";
import { recordDeliveryBriefingUse, recordDeliveryKnowledgeUse,
  verifyDeliveryAgentUse } from "./delivery-agent-usage.js";
import { scanAndSave, verifyCatalog } from "./catalog.js";
import { checkDelegation, createTask, taskContext, updateTask } from "./coordination.js";
import { readDocument, resolveContext } from "./context.js";
import { recordDeliveryPremortem } from "./delivery-premortem.js";
import {
  annotateDocument, linkDocuments, linkEntities,
  relationshipContext, upsertEntity
} from "./graph.js";
import {
  addLearningEvidence, configureLearning, deleteLearning, evaluateLearning,
  learningContext, learningOutcomeStatus, proposeLearning, reviewLearning, rollbackLearning
} from "./learning.js";
import { sharedContext } from "./sharing.js";
import { recordWorldAssertion, worldContext } from "./world-model.js";

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function callTool(name, args = {}) {
  const root = args.root || process.cwd();
  if (name === "scan") return textResult(await scanAndSave(root));
  if (name === "resolve_context") return textResult(await resolveContext({
    root,
    cwd: args.cwd || root,
    host: args.host || "generic",
    maxBytes: args.maxBytes ?? 65536,
    includeContent: args.includeContent ?? true
  }));
  if (name === "session_briefing") {
    const briefing = await sessionBriefing({ ...args, root });
    if (!args.requirementId) return textResult(briefing);
    const receipt = await recordDeliveryBriefingUse({ root,
      requirementId: args.requirementId, input: args, result: briefing });
    return textResult({ ...briefing, deliveryUseReceipt: receipt }, receipt.blocked);
  }
  if (name === "delivery_knowledge_query") {
    const knowledge = await deliveryKnowledgeQuery({ ...args, root });
    if (knowledge.blocked) return textResult(knowledge, true);
    const receipt = await recordDeliveryKnowledgeUse({ root,
      requirementId: args.requirementId, input: args, result: knowledge });
    return textResult({ ...knowledge, deliveryUseReceipt: receipt }, receipt.blocked);
  }
  if (name === "read_document") return textResult(await readDocument({
    root, path: args.path, offset: args.offset ?? 0, length: args.length ?? 65536
  }));
  if (name === "verify") return textResult(await verifyCatalog(root));
  if (name === "link_documents") return textResult(await linkDocuments({ ...args, root }));
  if (name === "annotate_document") return textResult(await annotateDocument({ ...args, root }));
  if (name === "upsert_entity") return textResult(await upsertEntity({ ...args, root }));
  if (name === "link_entities") return textResult(await linkEntities({ ...args, root }));
  if (name === "relationship_context") return textResult(await relationshipContext({ ...args, root }));
  if (name === "upsert_attention") return textResult(await upsertAttention({ ...args, root }));
  if (name === "record_activity") return textResult(await recordActivity({ ...args, root }));
  if (name === "attention_context") return textResult(await attentionContext({ ...args, root }));
  if (name === "resolve_attention") return textResult(await resolveAttention({ ...args, root }));
  if (name === "configure_attention") return textResult(await configureAttention({ ...args, root }));
  if (name === "delete_attention") return textResult(await deleteAttention({ ...args, root }));
  if (name === "propose_learning") return textResult(await proposeLearning({ ...args, root }));
  if (name === "add_learning_evidence") return textResult(await addLearningEvidence({ ...args, root }));
  if (name === "review_learning") return textResult(await reviewLearning({ ...args, root }));
  if (name === "learning_context") return textResult(await learningContext({ ...args, root }));
  if (name === "learning_outcome_status") return textResult(await learningOutcomeStatus({ ...args, root }));
  if (name === "evaluate_learning") return textResult(await evaluateLearning({ ...args, root }));
  if (name === "rollback_learning") return textResult(await rollbackLearning({ ...args, root }));
  if (name === "configure_learning") return textResult(await configureLearning({ ...args, root }));
  if (name === "delete_learning") return textResult(await deleteLearning({ ...args, root }));
  if (name === "check_delegation") return textResult(await checkDelegation({ ...args, root }));
  if (name === "create_task") return textResult(await createTask({ ...args, root }));
  if (name === "update_task") return textResult(await updateTask({ ...args, root }));
  if (name === "task_context") return textResult(await taskContext({ ...args, root }));
  if (name === "shared_context") return textResult(await sharedContext({ ...args, root }));
  if (name === "record_world_assertion") return textResult(await recordWorldAssertion({ ...args, root }));
  if (name === "world_context") return textResult(await worldContext({ ...args, root }));
  if (name === "audit") return textResult(await runAudit(root));
  if (name === "record_delivery_premortem") {
    if (typeof args.root !== "string" || !args.root) {
      throw new Error("record_delivery_premortem requires the exact project root");
    }
    const usage = await verifyDeliveryAgentUse({ root: args.root,
      requirementId: args.requirementId });
    if (usage.blocked) return textResult(usage, true);
    const premortem = await recordDeliveryPremortem({
      root: args.root,
      requirementId: args.requirementId,
      items: args.items
    });
    return textResult({ ...premortem, agentSpineUse: usage }, premortem.blocked);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function dispatch(message, tools, version) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-spine", version }
      }
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
  if (method === "tools/call") {
    try {
      return { jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments) };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: textResult({ error: error.message }, true) };
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function startMcpProtocol({ input, output, tools, version }) {
  input.setEncoding("utf8");
  let buffer = "";
  let queue = Promise.resolve();
  input.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      queue = queue.then(async () => {
        let response;
        try {
          response = await dispatch(JSON.parse(line), tools, version);
        } catch (error) {
          response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
        }
        if (response) output.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}
