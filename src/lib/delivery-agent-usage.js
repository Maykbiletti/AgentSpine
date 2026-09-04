import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { canonicalPath, projectStateDir } from "./paths.js";
import { writePremortemFile } from "./delivery-premortem-file.js";
import { inspectPremortemState } from "./delivery-premortem.js";
import { parsePremortemRequirementId } from "./delivery-premortem-binding.js";
import { premortemBlock as block, premortemBoundary as boundary } from "./delivery-premortem-results.js";
import { premortemSha256 as sha256, premortemTime as at,
  sealPremortem as seal, validPremortemSeal as validSeal,
  validPremortemTime as validTime } from "./delivery-premortem-codec.js";

const STATE_SCHEMA = "agentspine.delivery-agent-usage/v1";
const RECEIPT_SCHEMA = "agentspine.delivery-agent-use-receipt/v1";
const AUTHORITY = "context-only";
const MAX_BYTES = 32 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;

export const DELIVERY_AGENT_USE_TEXT = [
  "Before the first mutation, make exactly three AgentSpine calls with this root and Requirement:",
  "1. session_briefing; 2. delivery_knowledge_query for targets, contracts, and recent errors; 3. record_delivery_premortem.",
  "Only matching stored MCP receipts count; claims, foreign or reused receipts do not. Context-only; no authority."
].join("\n");

function stateMaterial(state) {
  const material = { ...state };
  delete material.integrityDigest;
  return material;
}

function sealState(state) {
  return { ...state, integrityDigest: sha256(stateMaterial(state)) };
}

function validReceipt(value, stage, requirementId) {
  return value && value.schema === RECEIPT_SCHEMA && value.stage === stage
    && value.requirementId === requirementId && value.authority === AUTHORITY
    && DIGEST_RE.test(value.inputDigest || "") && DIGEST_RE.test(value.resultDigest || "")
    && validTime(value.recordedAt) && validSeal(value);
}

function validateState(state, parsed) {
  if (!state || state.schema !== STATE_SCHEMA || state.authority !== AUTHORITY
    || state.requirementId !== `premortem-requirement:${parsed.laneDigest}:${parsed.generationDigest}`
    || state.laneDigest !== parsed.laneDigest || state.generationDigest !== parsed.generationDigest
    || !Number.isInteger(state.revision) || state.revision < 0 || state.revision > 3
    || (state.briefing !== null && !validReceipt(state.briefing, "briefing", state.requirementId))
    || (state.knowledge !== null && !validReceipt(state.knowledge, "knowledge", state.requirementId))
    || Boolean(state.knowledge) > Boolean(state.briefing)
    || (state.consumedAt !== null && !validTime(state.consumedAt))
    || (state.consumedDigest !== null && !DIGEST_RE.test(state.consumedDigest))
    || Boolean(state.consumedAt) !== Boolean(state.consumedDigest)
    || !DIGEST_RE.test(state.integrityDigest || "")
    || state.integrityDigest !== sha256(stateMaterial(state))) {
    const error = new Error("delivery AgentSpine usage state failed integrity validation");
    error.code = "AGENTSPINE_USAGE_UNCERTAIN";
    throw error;
  }
  return state;
}

async function pathsFor(root, requirementId) {
  const parsed = parsePremortemRequirementId(requirementId);
  const directory = join(await projectStateDir(await canonicalPath(root)), "delivery-agent-usage");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${parsed.generationDigest}.json`);
  return { parsed, path, lockPath: `${path}.lock` };
}

async function readState(path, parsed) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("delivery AgentSpine usage state exceeds 32 KiB");
    return validateState(JSON.parse(text), parsed);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      const invalid = new Error("delivery AgentSpine usage state is not valid JSON");
      invalid.code = "AGENTSPINE_USAGE_UNCERTAIN";
      throw invalid;
    }
    throw error;
  }
}

function emptyState(requirementId, parsed) {
  return sealState({ schema: STATE_SCHEMA, requirementId,
    laneDigest: parsed.laneDigest, generationDigest: parsed.generationDigest,
    revision: 0, briefing: null, knowledge: null,
    consumedAt: null, consumedDigest: null, authority: AUTHORITY });
}

async function currentRequirement(root, requirementId) {
  const current = await inspectPremortemState({ root, requirementId });
  if (current.status === "degraded") return current;
  if (current.blocked) return current;
  if (current.status === "absent" || !current.requirement) {
    return block("stale", `AgentSpine cannot bind usage to current requirement ${requirementId}.`,
      { requirementId });
  }
  return current;
}

function receipt(stage, requirementId, input, result, now) {
  return seal({ schema: RECEIPT_SCHEMA, stage, requirementId,
    inputDigest: sha256(input), resultDigest: sha256(result),
    recordedAt: at(now), authority: AUTHORITY });
}

async function recordStage({ root, requirementId, stage, input, result, now = new Date() }) {
  try {
    const current = await currentRequirement(root, requirementId);
    if (current.status === "degraded" || current.blocked) return current;
    const paths = await pathsFor(root, requirementId);
    return await withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      let state = await readState(paths.path, paths.parsed)
        || emptyState(requirementId, paths.parsed);
      if (state.consumedAt && stage === "briefing" && current.closed && !current.consumed) {
        state = emptyState(requirementId, paths.parsed);
      } else if (state.consumedAt) return block("reused",
        `AgentSpine usage receipts for ${requirementId} were already consumed.`, { requirementId });
      if (stage === "knowledge" && !state.briefing) return block("missing-briefing",
        "AgentSpine delivery preflight is missing stage 1: session_briefing.", { requirementId });
      const proposed = receipt(stage, requirementId, input, result, now);
      if (state[stage]) {
        if (state[stage].inputDigest !== proposed.inputDigest
          || state[stage].resultDigest !== proposed.resultDigest) {
          return block(`conflicting-${stage}`,
            `AgentSpine delivery preflight has a conflicting ${stage} call.`, { requirementId });
        }
        return { status: "duplicate", blocked: false, requirementId,
          receipt: structuredClone(state[stage]), digest: state[stage].digest };
      }
      state[stage] = proposed;
      state.revision += 1;
      state = sealState(state);
      await writePremortemFile(paths.path, state, assertOwned, MAX_BYTES);
      return { status: "recorded", blocked: false, requirementId,
        receipt: structuredClone(proposed), digest: proposed.digest };
    });
  } catch (error) {
    return boundary(error);
  }
}

export function deliveryAgentUseGuidance(root, requirementId) {
  return { root, requirementId, calls: ["session_briefing", "delivery_knowledge_query",
    "record_delivery_premortem"], instruction: DELIVERY_AGENT_USE_TEXT };
}

export function recordDeliveryBriefingUse(input) {
  return recordStage({ ...input, stage: "briefing" });
}

export function recordDeliveryKnowledgeUse(input) {
  return recordStage({ ...input, stage: "knowledge" });
}

export async function verifyDeliveryAgentUse({ root, requirementId }) {
  try {
    const current = await currentRequirement(root, requirementId);
    if (current.status === "degraded" || current.blocked) return current;
    const paths = await pathsFor(root, requirementId);
    const state = await readState(paths.path, paths.parsed);
    if (!state?.briefing) return block("missing-briefing",
      "AgentSpine delivery preflight is missing stage 1: session_briefing.", { requirementId });
    if (!state.knowledge) return block("missing-knowledge",
      "AgentSpine delivery preflight is missing stage 2: delivery_knowledge_query.", { requirementId });
    if (state.consumedAt) return block("reused",
      `AgentSpine usage receipts for ${requirementId} were already consumed.`, { requirementId });
    return { status: "verified", blocked: false, requirementId,
      briefingReceipt: structuredClone(state.briefing),
      knowledgeReceipt: structuredClone(state.knowledge),
      digest: sha256({ briefing: state.briefing.digest, knowledge: state.knowledge.digest }) };
  } catch (error) {
    return boundary(error);
  }
}

export async function consumeDeliveryAgentUse({ root, requirementId, now = new Date() }) {
  try {
    const verified = await verifyDeliveryAgentUse({ root, requirementId });
    if (verified.blocked || verified.status === "degraded") return verified;
    const paths = await pathsFor(root, requirementId);
    return withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      let state = await readState(paths.path, paths.parsed);
      if (state.consumedAt) return { status: "duplicate", blocked: false,
        requirementId, digest: state.consumedDigest };
      state.consumedAt = at(now);
      state.consumedDigest = sha256({ requirementId, usageDigest: verified.digest });
      state.revision += 1;
      state = sealState(state);
      await writePremortemFile(paths.path, state, assertOwned, MAX_BYTES);
      return { status: "consumed", blocked: false, requirementId,
        digest: state.consumedDigest };
    });
  } catch (error) {
    return boundary(error);
  }
}

export async function removeDeliveryAgentUse({ root, requirementId }) {
  try {
    const paths = await pathsFor(root, requirementId);
    return withOwnedFileLock(paths.lockPath, async ({ assertOwned }) => {
      await assertOwned();
      await unlink(paths.path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return { status: "removed", blocked: false, requirementId };
    });
  } catch (error) {
    return boundary(error);
  }
}
