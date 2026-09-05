import { inspectPremortemState, verifyPremortemBeforeWrite,
  verifyPremortemStop } from "./delivery-premortem.js";
import { verifyDeliveryAgentUse } from "./delivery-agent-usage.js";
import { verifyDeliveryStop } from "./delivery-verification.js";
import { normalizePremortemBinding } from "./delivery-premortem-binding.js";
import { hasSecretShapedText } from "./delivery-premortem-closure.js";
import { canonicalPremortem } from "./delivery-premortem-codec.js";
import { withActiveDeliveryAssignment } from "./delivery-assignment.js";

const DIGEST = { type: "string", pattern: "^[a-f0-9]{64}$" };
const ID = { type: "string", minLength: 1, maxLength: 512 };
const OPTIONAL_ID = { anyOf: [ID, { type: "null" }] };
const CATEGORIES = ["baseline-environment", "contract-tests", "delivery-path"];
const BINDING_FIELDS = ["host", "sessionId", "projectId", "entityId", "groupId",
  "taskId", "assignmentId", "goalId", "goalStepId", "queueId", "gatewayAttempt",
  "planDefinitionsDigest"];

export const deliveryCompletionTool = {
  name: "complete_delivery",
  description: "Store structured completion checks for an ordinary assignment after observed post-write tests. Stop still rechecks all gates. No permissions, tests, goal outcomes, or host identity are created.",
  inputSchema: {
    type: "object", additionalProperties: false,
    required: ["root", "requirementId", "binding", "artifactDigest", "lastWriteDigest", "checks"],
    properties: {
      root: ID,
      requirementId: { type: "string", pattern: "^premortem-requirement:[a-f0-9]{64}:[a-f0-9]{64}$" },
      binding: {
        type: "object", additionalProperties: false,
        required: ["host", "sessionId", "projectId", "assignmentId"],
        properties: Object.fromEntries(BINDING_FIELDS.map(key => [key,
          key === "gatewayAttempt" ? { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }
            : ["host", "sessionId", "projectId", "assignmentId"].includes(key) ? ID : OPTIONAL_ID]))
      },
      artifactDigest: DIGEST, lastWriteDigest: DIGEST,
      checks: {
        type: "array", minItems: 3, maxItems: 3,
        items: { type: "object", additionalProperties: false,
          required: ["category", "checkId", "status", "result"],
          properties: {
            category: { type: "string", enum: CATEGORIES }, checkId: ID,
            status: { const: "PASS" }, result: { type: "string", minLength: 1, maxLength: 1024 }
          } }
      }
    }
  }
};

function reject(status, reason) {
  return { status, blocked: true, reason, authority: "context-only" };
}

function strictKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}

function closureMessage(args) {
  if (![args.artifactDigest, args.lastWriteDigest].every(value =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw new Error("completion digests are invalid");
  if (!Array.isArray(args.checks) || args.checks.length !== 3) throw new Error("completion requires three checks");
  const lines = args.checks.map(check => {
    if (!strictKeys(check, ["category", "checkId", "status", "result"])
      || !CATEGORIES.includes(check.category) || check.status !== "PASS"
      || !/^check-[a-f0-9]{20}$/.test(check.checkId || "")
      || typeof check.result !== "string" || !check.result.trim() || check.result.length > 1024
      || /[\0\r\n]/.test(check.result) || hasSecretShapedText(check.result)) {
      throw new Error("completion check is invalid or contains secret-shaped content");
    }
    return `- ${check.category} ${check.checkId}: PASS — ${check.result.trim()}`;
  });
  return [`Premortem closure sha256 ${args.artifactDigest}`,
    `Premortem latest write sha256 ${args.lastWriteDigest}`, ...lines].join("\n");
}

export async function completeDelivery(args) {
  try {
    if (!strictKeys(args, ["root", "requirementId", "binding", "artifactDigest", "lastWriteDigest", "checks"])
      || typeof args.root !== "string" || !args.root
      || !strictKeys(args.binding, BINDING_FIELDS)) throw new Error("completion requires exact bound arguments");
    const message = closureMessage(args);
    const binding = normalizePremortemBinding(args.binding);
    return await withActiveDeliveryAssignment({ root: args.root, binding },
      assertOwned => completeBoundDelivery(args, binding, message, assertOwned));
  } catch (error) {
    return reject("invalid-completion", String(error.message).slice(0, 400));
  }
}

async function completeBoundDelivery(args, binding, message, assertOwned) {
  const current = await inspectPremortemState({ root: args.root, requirementId: args.requirementId });
  if (current.blocked || current.status === "degraded") return current;
  if (!current.hasWrite || !binding.assignmentId
    || canonicalPremortem(binding) !== canonicalPremortem(current.binding)) {
    return reject("foreign-completion", "Completion requires the exact written assignment binding.");
  }
  // Goal verification has a distinct task/queue lane. Preserve its existing
  // checkpoint and outcome route until a host supplies that verified lane.
  if (binding.goalId || binding.queueId) {
    return reject("goal-completion-required", "Use the existing goal checkpoint and outcome completion route.");
  }
  const usage = await verifyDeliveryAgentUse({ root: args.root, requirementId: args.requirementId });
  if (usage.blocked || usage.status !== "verified") return usage;
  const prepared = await verifyPremortemBeforeWrite({ root: args.root, binding });
  if (prepared.blocked || prepared.status !== "verified") return prepared;
  if (prepared.digest !== args.artifactDigest) return reject("stale", "Completion artifact digest is stale.");
  const verificationArgs = { root: args.root, host: binding.host, sessionId: binding.sessionId,
    scope: { ...binding, currentTaskId: binding.taskId } };
  const before = await verifyDeliveryStop(verificationArgs);
  if (before.blocked) return before;
  if (before.status !== "verified") return reject("untested", "No observed successful post-write test is available.");
  await assertOwned();
  const closed = await verifyPremortemStop({ root: args.root, binding, message,
    testStateDigest: before.stateDigest });
  if (closed.blocked || closed.status !== "closed") return closed;
  const after = await verifyDeliveryStop(verificationArgs);
  if (after.blocked) return after;
  if (after.status !== "verified" || after.stateDigest !== before.stateDigest) {
    return reject("changed", "Test evidence changed during completion; recheck the latest write before Stop.");
  }
  return { status: "recorded", blocked: false, requirementId: args.requirementId,
    closure: closed.closure, testStateDigest: before.stateDigest,
    instruction: "Finish with a normal user-facing summary. Stop rechecks all delivery gates.",
    authority: "context-only" };
}
