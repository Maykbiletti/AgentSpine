import { createHash } from "node:crypto";
import { finalizeReadOnlyPremortemForGoal } from "./delivery-premortem.js";
import { validPremortemScopeFinalization,
  validPremortemScopeFinalizationContext } from "./delivery-premortem-index.js";

const CHECKPOINT_SCHEMA = "agentspine.goal-delivery-checkpoint/v1";
const OUTCOME_SCHEMA = "agentspine.goal-outcome-receipt/v1";
const AUTHORITY = "context-only";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function seal(value) {
  return { ...value, digest: sha256(value) };
}

export function readOnlyDispositionDigest(expected) {
  return sha256({ status: "read-only", goalId: expected.goalId,
    goalStepId: expected.goalStepId, queueId: expected.queueId,
    gatewayAttempt: expected.gatewayAttempt, planDefinitionsDigest: expected.planDefinitionsDigest,
    projectRootDigest: sha256(expected.root), host: expected.host, projectId: expected.projectId,
    entityId: expected.entityId, groupId: expected.groupId, taskId: null, authority: AUTHORITY });
}

export function dispositionAttachments(status, expected, checkpoint, completedAt,
  reason = status, finalization = null) {
  const common = { status, queueId: expected.queueId, gatewayAttempt: expected.gatewayAttempt,
    goalId: expected.goalId, goalStepId: expected.goalStepId,
    planDefinitionsDigest: expected.planDefinitionsDigest, projectRootDigest: sha256(expected.root),
    checkpointDigest: sha256(checkpoint ?? null), host: expected.host,
    projectId: expected.projectId, entityId: expected.entityId, groupId: expected.groupId,
    scopeFinalizationDigest: finalization?.digest ?? null, diagnosticDigest: sha256(reason),
    authority: AUTHORITY };
  const deliveryCheckpoint = seal({ schema: CHECKPOINT_SCHEMA, ...common });
  const outcomeReceipt = seal({ schema: OUTCOME_SCHEMA, ...common, completedAt,
    deliveryCheckpointDigest: deliveryCheckpoint.digest });
  return { deliveryCheckpoint, outcomeReceipt };
}

export function finalizedReadOnlyAttachments(expected, checkpoint, completedAt, finalization) {
  if (!validPremortemScopeFinalizationContext(finalization, expected)
    || finalization.status !== "read-only"
    || finalization.attachmentDigest !== readOnlyDispositionDigest(expected)) return null;
  return dispositionAttachments("read-only", expected, checkpoint, completedAt,
    "host-confirmed-read-only", finalization);
}

export function validClosedFinalization(expected, attachment, finalization) {
  return validPremortemScopeFinalizationContext(finalization, expected)
    && finalization.status === "closed"
    && finalization.attachmentDigest === attachment.attachmentDigest;
}

export async function finalizeReadOnlyReview(expected, checkpoint, completedAt, bindings = []) {
  const dispositionDigest = readOnlyDispositionDigest(expected);
  const summaryDigests = bindings.map((binding) => binding.digest);
  const fenced = await finalizeReadOnlyPremortemForGoal({ root: expected.root,
    goalId: expected.goalId, goalStepId: expected.goalStepId, queueId: expected.queueId,
    gatewayAttempt: expected.gatewayAttempt, dispositionDigest, context: expected,
    bindingSummaryDigests: summaryDigests });
  if (!fenced || fenced.status === "degraded") return { status: "degraded", blocked: false,
    attachments: dispositionAttachments("degraded-fail-open", expected, checkpoint,
      completedAt, fenced?.reason) };
  if (fenced.blocked || fenced.status !== "finalized"
    || !validPremortemScopeFinalization(fenced.finalization, expected, summaryDigests)
    || fenced.finalization.attachmentDigest !== dispositionDigest) {
    return { status: fenced.status || "mismatch", blocked: true,
      reason: fenced.reason || "Read-only premortem finalization does not match the goal step.",
      attachments: null };
  }
  return { status: "read-only", blocked: false,
    attachments: dispositionAttachments("read-only", expected, checkpoint, completedAt,
      "host-confirmed-read-only", fenced.finalization) };
}
