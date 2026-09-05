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
import { recoverDeliveryPremortem } from "./delivery-premortem-correction.js";
import { completeDelivery } from "./mcp-delivery-completion.js";
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
import { indexSessionTimeline, searchSessionTimeline } from "./session-timeline.js";
import { gatewayEnvironmentContext } from "./hook-context.js";
import {
  timelineInvocationInput, timelineInvocationRequest
} from "./mcp-timeline-tools.js";
import { sessionTimelineBinding } from "./session-timeline-contract.js";
import { timelineTransportDigest } from "./session-timeline-transport.js";
import { boundBriefingArguments, rejectInternalSourceArguments, resolveMcpSources } from "./mcp-source-context.js";

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function timelineTransport(input, root, environment) {
  const { scope } = input;
  return { scope, transportDigest: timelineTransportDigest({ root,
    binding: sessionTimelineBinding({ host: "claude", sessionId: input.request.sessionId, scope }), environment }) };
}

function absent(value) { return value === undefined || value === null || value === ""; }

// The MCP process can outlive a host turn.  A group claim that appears after a
// private permit was issued must therefore suppress consumption here as well
// as in PreToolUse; tool arguments cannot clear an authenticated environment.
function runtimeTimelineGroup(environment, input) {
  try {
    const gateway = gatewayEnvironmentContext(environment);
    return Boolean(input?.groupClaim) || !absent(environment?.AGENTSPINE_GROUP_ID) || !absent(gateway?.groupId);
  } catch {
    return true;
  }
}

function runtimeGatewayMatchesTimeline(environment, scope) {
  let gateway;
  try { gateway = gatewayEnvironmentContext(environment); }
  catch { return false; }
  if (!gateway) return true;
  if (!absent(gateway.groupId)) return false;
  const claims = [
    [gateway.host, "claude"], [gateway.entityId, scope.entityId], [gateway.projectId, scope.projectId],
    [gateway.taskId, scope.currentTaskId], [gateway.goalId, scope.goalId], [gateway.goalStepId, scope.goalStepId]
  ];
  if (!claims.every(([actual, expected]) => actual === expected)) return false;
  // Gateway context predates these two claims.  In an authenticated gateway
  // process, accepting an unverifiable user or tenant would let a stale private
  // permit cross a newly selected identity, so their canonical env claims are
  // deliberately mandatory until the gateway context carries them itself.
  return environment?.AGENTSPINE_USER_ID === scope.userId
    && environment?.AGENTSPINE_TENANT_ID === scope.tenantId;
}

function unavailableTimelineInvocation(reason) {
  return { status: "unavailable", reason, authority: "context-only" };
}

async function callTool(name, args = {}, environment = process.env) {
  const root = args.root || process.cwd();
  if (name === "scan") return textResult(await scanAndSave(root));
  if (name === "resolve_context") {
    rejectInternalSourceArguments(args);
    const sources = await resolveMcpSources({ root, cwd: args.cwd || root, host: args.host });
    return textResult(await resolveContext({
      root,
      cwd: args.cwd || root,
      host: sources.host,
      maxBytes: args.maxBytes ?? 65536,
      includeContent: args.includeContent ?? true,
      catalog: sources.catalog
    }));
  }
  if (name === "session_briefing") {
    const scoped = await boundBriefingArguments({ ...args, root });
    const sources = await resolveMcpSources({ ...scoped, required: Boolean(args.requirementId) });
    const briefing = await sessionBriefing({ ...scoped, host: sources.host,
      catalog: sources.catalog, userStateRoot: sources.userStateRoot, sourceDiagnostics: sources.diagnostics });
    if (!args.requirementId) return textResult(briefing);
    const receipt = await recordDeliveryBriefingUse({ root,
      requirementId: args.requirementId, input: args, result: briefing });
    return textResult({ ...briefing, deliveryUseReceipt: receipt }, receipt.blocked);
  }
  if (name === "delivery_knowledge_query") {
    rejectInternalSourceArguments(args);
    const knowledge = await deliveryKnowledgeQuery({ ...args, root });
    if (knowledge.blocked) return textResult(knowledge, true);
    const receipt = await recordDeliveryKnowledgeUse({ root,
      requirementId: args.requirementId, input: args, result: knowledge });
    return textResult({ ...knowledge, deliveryUseReceipt: receipt }, receipt.blocked);
  }
  if (name === "read_document") {
    rejectInternalSourceArguments(args);
    const sources = await resolveMcpSources({ root, host: args.host });
    return textResult(await readDocument({
      root, path: args.path, offset: args.offset ?? 0, length: args.length ?? 65536,
      catalog: sources.catalog
    }));
  }
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
  if (name === "session_timeline_index") {
    const input = timelineInvocationInput(args);
    if (runtimeTimelineGroup(environment, input)) return textResult(unavailableTimelineInvocation("timeline-group-suppressed"));
    if (!input.valid) return textResult(unavailableTimelineInvocation(input.reason || "timeline-scope-invalid"));
    const timeline = timelineTransport(input, root, environment);
    if (!runtimeGatewayMatchesTimeline(environment, timeline.scope)) {
      return textResult(unavailableTimelineInvocation("timeline-gateway-binding-mismatch"));
    }
    const invocationRequest = timelineInvocationRequest("index", args, root);
    if (!invocationRequest) return textResult(unavailableTimelineInvocation("timeline-invocation-unavailable"));
    return textResult(await indexSessionTimeline({ root, host: "claude", sessionId: input.request.sessionId, scope: timeline.scope,
      maxBytes: args.maxBytes, enrollmentDigest: input.request.enrollmentDigest,
      hostHome: environment.CLAUDE_CONFIG_DIR ?? null, transportDigest: timeline.transportDigest, invocationRequest }));
  }
  if (name === "session_timeline_search") {
    const input = timelineInvocationInput(args);
    if (runtimeTimelineGroup(environment, input)) return textResult(unavailableTimelineInvocation("timeline-group-suppressed"));
    if (!input.valid) return textResult(unavailableTimelineInvocation(input.reason || "timeline-scope-invalid"));
    const timeline = timelineTransport(input, root, environment);
    if (!runtimeGatewayMatchesTimeline(environment, timeline.scope)) {
      return textResult(unavailableTimelineInvocation("timeline-gateway-binding-mismatch"));
    }
    const invocationRequest = timelineInvocationRequest("search", args, root);
    if (!invocationRequest) return textResult(unavailableTimelineInvocation("timeline-invocation-unavailable"));
    return textResult(await searchSessionTimeline({ root, host: "claude", sessionId: input.request.sessionId, scope: timeline.scope,
      at: args.at, query: args.query, windowSeconds: args.windowSeconds, enrollmentDigest: input.request.enrollmentDigest,
      hostHome: environment.CLAUDE_CONFIG_DIR ?? null, transportDigest: timeline.transportDigest,
      invocationRequest }));
  }
  if (name === "audit") return textResult(await runAudit(root));
  if (name === "complete_delivery") {
    const completed = await completeDelivery(args);
    return textResult(completed, completed.blocked || completed.status === "degraded");
  }
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
  if (name === "recover_delivery_premortem") {
    if (typeof args.root !== "string" || !args.root) {
      throw new Error("recover_delivery_premortem requires the exact project root");
    }
    const recovery = await recoverDeliveryPremortem({ root: args.root,
      predecessorRequirementId: args.predecessorRequirementId,
      taskId: args.taskId || null });
    return textResult(recovery, recovery.blocked);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function dispatch(message, tools, version, environment) {
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
      return { jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments, environment) };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: textResult({ error: error.message }, true) };
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function startMcpProtocol({ input, output, tools, version, environment = process.env }) {
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
          response = await dispatch(JSON.parse(line), tools, version, environment);
        } catch (error) {
          response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } };
        }
        if (response) output.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}
