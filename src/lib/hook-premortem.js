import {
  inspectPremortemState,
  preparePremortemRequirement,
  recordPremortemWriteIntent,
  recordPremortemWrite,
  verifyPremortemBeforeWrite,
  verifyPremortemStop
} from "./delivery-premortem.js";
import { consumeDeliveryAgentUse, deliveryAgentUseGuidance,
  removeDeliveryAgentUse, verifyDeliveryAgentUse } from "./delivery-agent-usage.js";
import { deliveryToolActions } from "./delivery-verification.js";
import { boundedId } from "./hook-context.js";
import { auditGuard } from "./hook-protection.js";
import { comparablePath, projectId as localProjectId } from "./paths.js";
import { resolveFinalAssistantMessage } from "./hook-final-message.js";

export function premortemBinding(input, scope, root = null) {
  return {
    host: scope?.host || null,
    sessionId: boundedId(input?.session_id ?? input?.sessionId, "sessionId"),
    entityId: scope?.entityId || null,
    groupId: scope?.groupId || null,
    projectId: scope?.projectId || (root ? `project:${localProjectId(comparablePath(root))}` : null),
    goalId: scope?.goalId || null,
    goalStepId: scope?.goalStepId || null,
    queueId: scope?.queueId || null,
    planDefinitionsDigest: scope?.planDefinitionsDigest || null,
    gatewayAttempt: scope?.gatewayAttempt || null
  };
}

export function isPremortemWrite(input) {
  return deliveryToolActions(input).some((item) => item.kind === "write");
}

async function diagnostic(input, phase, result) {
  if (result?.status === "degraded") await auditGuard(input, phase, result);
  return result;
}

function degraded(error, path) {
  return {
    status: "degraded", blocked: false, path,
    reason: String(error?.message || error || "premortem state unavailable").slice(0, 2048)
  };
}

function invalidWriteSession(error, path) {
  return {
    status: "invalid-session", blocked: true, path,
    reason: "AgentSpine denied this write before mutation because a valid host session_id is required: "
      + String(error?.message || error || "sessionId is missing").slice(0, 400)
  };
}

function withRegistrationGuidance(result, root) {
  const requirementId = result.requirementId || result.requirement?.requirementId || null;
  const registration = { tool: "record_delivery_premortem", root, requirementId };
  const agentSpineUse = deliveryAgentUseGuidance(root, requirementId);
  return {
    ...result, registration, agentSpineUse,
    instruction: [
      "Before the first Write/Edit/apply_patch or recognized shell mutation, make exactly three stored AgentSpine calls bound to this session and goal step, in order:",
      "1. session_briefing; 2. delivery_knowledge_query for targets, contracts, and recent errors; 3. record_delivery_premortem.",
      `Use root ${JSON.stringify(root)}; Requirement: ${requirementId || "<unavailable; retry the hook>"}.`,
      "The premortem needs exactly baseline-environment, contract-tests, and delivery-path; each failure starts `this delivery fails because ` and has a concrete check.",
      "Claims, foreign or reused receipts do not count. This is context only and grants no authority.",
      "Complete with `Premortem closure sha256 <64hex>`, `Premortem latest write sha256 <64hex>`, and:",
      "- <category> <checkId>: PASS — <nonempty result>"
    ].join("\n")
  };
}

export async function prepareHookPremortem({ input, root, scope }) {
  try {
    const result = await preparePremortemRequirement({
      root, binding: premortemBinding(input, scope, root), now: input.timestamp || new Date()
    });
    await diagnostic(input, "premortem-prepare", result);
    return withRegistrationGuidance(result, root);
  } catch (error) {
    const result = degraded(error, root);
    await diagnostic(input, "premortem-prepare", result);
    return withRegistrationGuidance(result, root);
  }
}

export async function verifyHookPremortemWrite({ input, root, scope }) {
  if (!isPremortemWrite(input)) return { status: "not-applicable", blocked: false };
  try {
    if (!boundedId(input?.session_id ?? input?.sessionId, "sessionId")) {
      throw new Error("sessionId is missing");
    }
  } catch (error) {
    return invalidWriteSession(error, root);
  }
  try {
    const binding = premortemBinding(input, scope, root);
    const result = await diagnostic(input, "premortem-before-write", await verifyPremortemBeforeWrite({
      root, binding, now: input.timestamp || new Date()
    }));
    let requirement = null;
    if (result.status === "missing") {
      requirement = await diagnostic(input, "premortem-prepare-on-write", await preparePremortemRequirement({
        root, binding, now: input.timestamp || new Date()
      }));
      if (requirement.status === "degraded") return withRegistrationGuidance(requirement, root);
      if (requirement.blocked) return requirement;
    }
    if (result.blocked && new Set(["conflict", "late", "finalized", "mismatch"]).has(result.status)) {
      return { ...result, reason: `${result.reason}\nPremortem status: ${result.status}.` };
    }
    const requirementId = requirement?.requirementId || result.requirementId;
    if (requirementId?.split(":").length === 3) {
      const usage = await diagnostic(input, "delivery-agent-use-before-write",
        await verifyDeliveryAgentUse({ root, requirementId }));
      if (usage.blocked) {
        const guidance = withRegistrationGuidance(requirement || result, root);
        return { ...usage, reason: `${usage.reason}\n${guidance.instruction}` };
      }
      if (!result.blocked) return { ...result, agentSpineUse: usage };
    } else if (!result.blocked) return result;
    const named = `${result.reason}\nPremortem status: ${result.status}.`;
    const guided = requirement ? withRegistrationGuidance(requirement, root) : null;
    return result.status === "missing"
      ? { ...result, requirementId: guided.requirementId, registration: guided.registration,
        reason: `${named}\n${guided.instruction}` }
      : { ...result, reason: named };
  } catch (error) {
    return diagnostic(input, "premortem-before-write", degraded(error, root));
  }
}

export async function recordHookPremortemWrite({ input, root, scope, success }) {
  if (!isPremortemWrite(input)) return { status: "not-applicable", blocked: false };
  if (success !== true) return { status: "write-failed", blocked: false };
  try {
    const result = await diagnostic(input, "premortem-write", await recordPremortemWrite({
      root, binding: premortemBinding(input, scope, root), input,
      now: input.timestamp || new Date()
    }));
    return result.status === "duplicate" ? { ...result, status: "write-recorded" } : result;
  } catch (error) {
    return diagnostic(input, "premortem-write", degraded(error, root));
  }
}

export async function recordHookPremortemWriteIntent({ input, root, scope }) {
  if (!isPremortemWrite(input)) return { status: "not-applicable", blocked: false };
  try {
    return await diagnostic(input, "premortem-write-intent", await recordPremortemWriteIntent({
      root, binding: premortemBinding(input, scope, root), input, now: input.timestamp || new Date()
    }));
  } catch (error) {
    return diagnostic(input, "premortem-write-intent", degraded(error, root));
  }
}

export async function verifyHookPremortemStop({ input, root, scope, paused = false,
  consume = false }) {
  if (paused) return { status: "paused-job", blocked: false };
  try {
    const message = resolveFinalAssistantMessage(input);
    if (!message.known) {
      return diagnostic(input, "premortem-stop", degraded(new Error(`premortem ${message.reason}`), root));
    }
    const binding = premortemBinding(input, scope, root);
    const inspection = await diagnostic(input, "premortem-stop-inspect",
      await inspectPremortemState({ root, binding }));
    let usage = null;
    if (inspection.hasWrite && inspection.requirementId) {
      usage = await diagnostic(input, "delivery-agent-use-stop",
        await verifyDeliveryAgentUse({ root, requirementId: inspection.requirementId }));
      if (usage.blocked) return usage;
    }
    const result = await diagnostic(input, "premortem-stop", await verifyPremortemStop({
      root, binding: premortemBinding(input, scope, root), message: message.text,
      now: input.timestamp || new Date()
    }));
    if (!inspection.hasWrite && inspection.requirementId) {
      await diagnostic(input, "delivery-agent-use-read-only-cleanup",
        await removeDeliveryAgentUse({ root, requirementId: inspection.requirementId }));
    }
    if (consume && result.status === "closed" && usage && inspection.requirementId) {
      const consumed = await diagnostic(input, "delivery-agent-use-consume",
        await consumeDeliveryAgentUse({ root, requirementId: inspection.requirementId,
          now: input.timestamp || new Date() }));
      return { ...result, agentSpineUse: { ...usage, consumption: consumed } };
    }
    return result;
  } catch (error) {
    return diagnostic(input, "premortem-stop", degraded(error, root));
  }
}
