import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { canonicalPath, projectStateDir } from "./paths.js";
import { writePremortemFile } from "./delivery-premortem-file.js";
import { premortemSha256 as sha256, premortemTime as at,
  sealPremortem as seal, validPremortemSeal as validSeal,
  validPremortemTime as validTime } from "./delivery-premortem-codec.js";

const SCHEMA = "agentspine.delivery-premortem-registration-rejection/v1";
const AUTHORITY = "context-only";
const MAX_BYTES = 8 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function valid(value) {
  return value && value.schema === SCHEMA && value.authority === AUTHORITY
    && typeof value.requirementId === "string"
    && DIGEST_RE.test(value.priorArtifactDigest || "")
    && DIGEST_RE.test(value.proposedArtifactDigest || "")
    && DIGEST_RE.test(value.laneDigest || "")
    && validTime(value.rejectedAt) && validSeal(value);
}

async function read(path) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("premortem rejection exceeds 8 KiB");
    const value = JSON.parse(text);
    if (!valid(value)) throw new Error("premortem rejection failed integrity validation");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("premortem rejection is not valid JSON");
    throw error;
  }
}

export async function recordPremortemRegistrationRejection({ root, state, proposed, now = new Date() }) {
  const receipt = seal({ schema: SCHEMA,
    requirementId: state.requirement.requirementId,
    laneDigest: state.laneDigest,
    priorArtifactDigest: state.artifact.digest,
    proposedArtifactDigest: proposed.digest,
    reason: "conflicts-with-first-registration",
    rejectedAt: at(now), authority: AUTHORITY });
  const digest = sha256({ laneDigest: state.laneDigest,
    priorArtifactDigest: state.artifact.digest, proposedArtifactDigest: proposed.digest });
  const directory = join(await projectStateDir(await canonicalPath(root)),
    "delivery-premortem-rejections", state.laneDigest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}.json`);
  return withOwnedFileLock(`${path}.lock`, async ({ assertOwned }) => {
    const existing = await read(path);
    if (existing) return { status: "duplicate", digest,
      receiptDigest: existing.digest, receipt: existing };
    await writePremortemFile(path, receipt, assertOwned, MAX_BYTES);
    return { status: "recorded", digest, receiptDigest: receipt.digest, receipt };
  });
}

export async function inspectPremortemRegistrationRejection({ root, laneDigest, digest }) {
  const directory = join(await projectStateDir(await canonicalPath(root)),
    "delivery-premortem-rejections", laneDigest);
  return read(join(directory, `${digest}.json`));
}
