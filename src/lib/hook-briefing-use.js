import { verifyPreflightReceipt } from "./preflight.js";
import { inspectPremortemState } from "./delivery-premortem.js";
import { recordDeliveryBriefingUse } from "./delivery-agent-usage.js";
import { canonicalPath, comparablePath, projectId } from "./paths.js";

const verified = new WeakMap();

// Process-local capability, issued only by the native pre-answer verifier.
// JSON, MCP arguments and model claims cannot reconstruct this capability.
export async function consumeHookBriefingOrigin({
  event, input, scope, resolvedSources, preflight, prompt,
  environment = process.env, now = new Date()
}) {
  if (event !== "UserPromptSubmit" || !input || !scope || !resolvedSources
    || typeof prompt !== "string") return null;
  try {
    if (!await verifyPreflightReceipt({ receipt: preflight?.receipt, input, scope,
      resolvedSources, prompt, now, env: environment, consume: true })) return null;
    const origin = Object.freeze({});
    verified.set(origin, { receipt: structuredClone(preflight.receipt),
      scope: structuredClone(scope), root: resolvedSources.projectRoot,
      requirementId: preflight.premortem?.requirementId || null });
    return origin;
  } catch { return null; }
}

function unverified(reason) {
  return { status: "unverified", blocked: false, verified: false, reason,
    automaticRetry: false, completionVerified: false, authority: "context-only" };
}

export async function recordHookBriefingUse({ origin, root, now = new Date() }) {
  const proof = verified.get(origin);
  if (!verified.delete(origin)) return unverified("host-briefing-origin-unavailable");
  try {
    if (await canonicalPath(root) !== proof.root || !proof.requirementId) {
      return unverified("host-briefing-requirement-unavailable");
    }
    const { receipt, scope, requirementId } = proof;
    if (Date.parse(receipt.expiresAt) <= new Date(now).getTime()) return unverified("host-briefing-expired");
    const current = await inspectPremortemState({ root, requirementId });
    const binding = current.binding;
    const expected = { host: receipt.host, sessionId: receipt.sessionId,
      entityId: scope.entityId, projectId: scope.projectId || `project:${projectId(comparablePath(root))}`,
      groupId: receipt.groupId,
      taskId: scope.goalId || scope.queueId ? null : receipt.taskId,
      goalId: scope.goalId, goalStepId: scope.goalStepId, queueId: scope.queueId,
      gatewayAttempt: scope.gatewayAttempt, planDefinitionsDigest: scope.planDefinitionsDigest };
    if (current.blocked || current.status === "degraded" || !binding
      || Object.entries(expected).some(([key, value]) => (binding[key] ?? null) !== (value ?? null))) {
      return unverified("host-briefing-binding-mismatch");
    }
    const usage = await recordDeliveryBriefingUse({ root, requirementId,
      preserveConsumed: true, verifiedHostBriefing: true,
      input: { origin: "verified-host-preflight", receiptId: receipt.id,
        promptDigest: receipt.promptDigest, requirementId },
      result: { briefingDigest: receipt.briefingDigest, sourceSnapshotDigest: receipt.bodyDigest }, now });
    return { ...usage, verified: ["recorded", "duplicate"].includes(usage.status),
      automaticRetry: false, completionVerified: false };
  } catch { return unverified("host-briefing-service-unavailable"); }
}

// Process diagnostics do not change the validity of evidence or native access.
export function advisoryDeliveryUse(value) {
  return { ...value, blocked: false, verificationBlocked: Boolean(value.blocked),
    verified: ["recorded", "duplicate", "verified", "satisfied-by-host"].includes(value.status),
    completionVerified: false, automaticRetry: false, authority: "context-only" };
}
