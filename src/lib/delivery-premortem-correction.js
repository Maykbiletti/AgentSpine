import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { beginDeliveryAssignment, assignmentPremortemBinding } from "./delivery-assignment.js";
import { inspectPremortemState, preparePremortemRequirement } from "./delivery-premortem.js";
import { writePremortemFile } from "./delivery-premortem-file.js";
import { premortemBlock as block, premortemBoundary as boundary } from "./delivery-premortem-results.js";
import { canonicalPath, projectStateDir } from "./paths.js";
import { premortemSha256 as sha256, premortemTime as at,
  sealPremortem as seal, validPremortemSeal as validSeal,
  validPremortemTime as validTime } from "./delivery-premortem-codec.js";

const SCHEMA = "agentspine.delivery-premortem-recovery/v1";
const AUTHORITY = "context-only";
const MAX_BYTES = 12 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function valid(value) {
  return value && value.schema === SCHEMA && value.authority === AUTHORITY
    && typeof value.predecessorRequirementId === "string"
    && typeof value.requirementId === "string"
    && DIGEST_RE.test(value.predecessorArtifactDigest || "")
    && DIGEST_RE.test(value.bindingDigest || "")
    && /^assignment:[a-f0-9]{64}$/.test(value.assignmentId || "")
    && validTime(value.recoveredAt) && validSeal(value);
}

async function read(path) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("premortem recovery exceeds 12 KiB");
    const value = JSON.parse(text);
    if (!valid(value)) throw new Error("premortem recovery failed integrity validation");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("premortem recovery is not valid JSON");
    throw error;
  }
}

async function storeRecovery(root, receipt) {
  const digest = sha256({ predecessorRequirementId: receipt.predecessorRequirementId,
    requirementId: receipt.requirementId });
  const directory = join(await projectStateDir(await canonicalPath(root)),
    "delivery-premortem-recoveries");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}.json`);
  return withOwnedFileLock(`${path}.lock`, async ({ assertOwned }) => {
    const existing = await read(path);
    if (existing) {
      if (existing.predecessorRequirementId !== receipt.predecessorRequirementId
        || existing.requirementId !== receipt.requirementId) {
        throw new Error("premortem recovery receipt conflicts with history");
      }
      return existing;
    }
    await writePremortemFile(path, receipt, assertOwned, MAX_BYTES);
    return receipt;
  });
}

export async function recoverDeliveryPremortem({ root, predecessorRequirementId,
  taskId = null, now = new Date() }) {
  try {
    const predecessor = await inspectPremortemState({ root,
      requirementId: predecessorRequirementId });
    if (predecessor.status === "degraded" || predecessor.blocked) return predecessor;
    if (predecessor.status === "absent" || !predecessor.requirement) {
      return block("stale", "The predecessor premortem requirement does not exist.",
        { predecessorRequirementId });
    }
    if (!predecessor.conflicted) {
      return block("not-needed",
        "The predecessor was not poisoned; reuse its first valid registration or start the next assignment.",
        { predecessorRequirementId });
    }
    const source = { ...predecessor.binding, taskId: taskId || predecessor.binding.taskId,
      assignmentId: null };
    const assignment = await beginDeliveryAssignment({ root, binding: source,
      eventId: `recovery:${predecessorRequirementId}`, now });
    if (assignment.blocked) return assignment;
    const binding = assignmentPremortemBinding(source, assignment);
    const prepared = await preparePremortemRequirement({ root, binding, now });
    if (prepared.blocked || prepared.status === "degraded") return prepared;
    const receipt = seal({ schema: SCHEMA,
      predecessorRequirementId,
      predecessorArtifactDigest: predecessor.artifactDigest,
      requirementId: prepared.requirementId,
      assignmentId: assignment.assignmentId,
      bindingDigest: sha256(binding),
      recoveredAt: at(now), authority: AUTHORITY });
    const stored = await storeRecovery(root, receipt);
    return { status: "recovered", blocked: false,
      predecessorRequirementId, requirementId: prepared.requirementId,
      assignmentId: assignment.assignmentId, recoveryReceipt: stored,
      instruction: "Run session_briefing, delivery_knowledge_query, and record_delivery_premortem for the new requirement. Recovery grants no authority." };
  } catch (error) {
    return boundary(error);
  }
}
