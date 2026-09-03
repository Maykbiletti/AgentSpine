import { createHash } from "node:crypto";
import { basename } from "node:path";
import { inspectDeliveryPremortems } from "./delivery-premortem.js";
import { createPremortemAttachment } from "./delivery-premortem-closure.js";
import { premortemGoalBindingSummary } from "./delivery-premortem-binding.js";
import { inspectPremortemLaneIndexes, premortemScopeDigest } from "./delivery-premortem-index.js";
import {
  inspectPremortemWriteIndexes,
  inspectPremortemWriteProof
} from "./delivery-premortem-write-ledger.js";

const WRITE_INDEX_MISMATCH = "AGENTSPINE_PREMORTEM_MISMATCH";

export function premortemIndexCrossReferenceFindings(premortems, indexes, gatewayPolicy) {
  const findings = [];
  const statesByLane = new Map(premortems.states.map((state) => [state.laneDigest, state]));
  const pointersByLane = new Map();
  for (const pointer of indexes.pointers) {
    const values = pointersByLane.get(pointer.laneDigest) || [];
    values.push(pointer);
    pointersByLane.set(pointer.laneDigest, values);
  }
  const stateScanComplete = !premortems.errors.length && !premortems.truncations.length;
  const indexScanComplete = !indexes.errors.length && !indexes.truncations.length;
  if (stateScanComplete) for (const pointer of indexes.pointers) {
    const state = statesByLane.get(pointer.laneDigest);
    if (!state) {
      findings.push({ laneDigest: pointer.laneDigest, reason: "premortem index pointer has no state" });
      continue;
    }
    const binding = state.binding;
    const sessionDigest = createHash("sha256").update(binding.sessionId).digest("hex");
    if (pointer.sessionDigest !== sessionDigest || pointer.goalId !== binding.goalId
      || pointer.goalStepId !== binding.goalStepId || pointer.queueId !== binding.queueId
      || pointer.gatewayAttempt !== binding.gatewayAttempt
      || pointer.planDefinitionsDigest !== binding.planDefinitionsDigest) {
      findings.push({ laneDigest: pointer.laneDigest,
        reason: "premortem index pointer does not match state binding" });
    }
  }
  if (indexScanComplete) for (const state of premortems.states.filter((item) => item.binding.goalId)) {
    const pointers = pointersByLane.get(state.laneDigest) || [];
    if (!pointers.length) findings.push({ laneDigest: state.laneDigest,
      reason: "goal premortem state has no index pointer" });
    else if (pointers.length > 1) findings.push({ laneDigest: state.laneDigest,
      reason: "goal premortem state has multiple index pointers" });
    const consumed = state.events.some((event) => event.type === "premortem-consumed");
    const finalized = indexes.finalizations.some((item) => item.laneDigest === state.laneDigest);
    if (consumed && !finalized) findings.push({ laneDigest: state.laneDigest,
      reason: "consumed goal premortem state has no scope finalization" });
  }
  if (stateScanComplete && indexScanComplete) for (const finalization of indexes.finalizations) {
    const scopedPointers = indexes.pointers.filter((item) => item.scopeDigest === finalization.scopeDigest);
    const scopedStates = premortems.states.filter((state) => state.binding.goalId
      && premortemScopeDigest(state.binding.goalId, state.binding.goalStepId,
        state.binding.queueId, state.binding.gatewayAttempt) === finalization.scopeDigest);
    if (finalization.status === "read-only") {
      if (scopedPointers.length || scopedStates.length) findings.push({ laneDigest: null,
        reason: "read-only premortem finalization retains state or index evidence" });
      continue;
    }
    const pointer = scopedPointers.length === 1 ? scopedPointers[0] : null;
    const state = scopedStates.length === 1 ? scopedStates[0] : null;
    if (!pointer || !state || pointer.laneDigest !== finalization.laneDigest) {
      findings.push({ laneDigest: finalization.laneDigest,
        reason: "closed premortem finalization is orphaned" });
      continue;
    }
    if (pointer.digest !== finalization.pointerDigest) findings.push({ laneDigest: state.laneDigest,
      reason: "closed premortem finalization has the wrong pointer digest" });
    const consumed = state.events.some((event) => event.type === "premortem-consumed");
    if (!consumed || !state.closure || !state.lastWrite) findings.push({ laneDigest: state.laneDigest,
      reason: "closed premortem finalization has no consumed closed state" });
    else if (createPremortemAttachment(state).attachmentDigest !== finalization.attachmentDigest) {
      findings.push({ laneDigest: state.laneDigest,
        reason: "closed premortem finalization has the wrong attachment digest" });
    }
    const binding = state.binding;
    const exact = finalization.goalId === binding.goalId && finalization.goalStepId === binding.goalStepId
      && finalization.queueId === binding.queueId && finalization.gatewayAttempt === binding.gatewayAttempt
      && finalization.planDefinitionsDigest === binding.planDefinitionsDigest
      && finalization.host === binding.host && finalization.projectId === binding.projectId
      && finalization.entityId === binding.entityId && finalization.groupId === binding.groupId
      && finalization.taskId === binding.taskId;
    const summaryDigest = createHash("sha256")
      .update(JSON.stringify([premortemGoalBindingSummary(state).digest])).digest("hex");
    if (!exact || finalization.bindingSummaryDigest !== summaryDigest) findings.push({ laneDigest: state.laneDigest,
      reason: "closed premortem finalization has the wrong binding evidence" });
  }
  if (indexScanComplete) for (const goal of gatewayPolicy.goals || []) {
    for (const step of goal.plan?.steps || []) {
      const checkpoint = step.deliveryCheckpoint;
      const outcome = step.outcomeReceipt;
      if (step.status !== "completed" || !new Set(["closed", "read-only"]).has(checkpoint?.status)) continue;
      const finalization = indexes.finalizations.find((item) => item.digest === checkpoint.scopeFinalizationDigest);
      if (!finalization) {
        findings.push({ laneDigest: checkpoint.bindingDigest ?? null,
          reason: "completed goal premortem has no bound scope finalization" });
        continue;
      }
      const exact = finalization.status === checkpoint.status && finalization.goalId === goal.goalId
        && finalization.goalStepId === step.stepId && finalization.queueId === checkpoint.queueId
        && finalization.gatewayAttempt === checkpoint.gatewayAttempt
        && finalization.planDefinitionsDigest === checkpoint.planDefinitionsDigest
        && finalization.host === checkpoint.host && finalization.projectId === checkpoint.projectId
        && finalization.entityId === checkpoint.entityId && finalization.groupId === checkpoint.groupId
        && finalization.taskId === (checkpoint.taskId ?? null);
      if (!exact) findings.push({ laneDigest: checkpoint.bindingDigest ?? null,
        reason: "completed goal premortem scope finalization has the wrong binding" });
      if (checkpoint.status === "closed" && (checkpoint.sourceAttachmentDigest
        !== finalization.attachmentDigest || outcome?.sourceAttachmentDigest
        !== finalization.attachmentDigest)) {
        findings.push({ laneDigest: checkpoint.bindingDigest ?? null,
          reason: "completed goal premortem source attachment does not match scope finalization" });
      }
    }
  }
  return findings;
}

function boundedWrites(state) {
  const writes = [state.firstWrite, state.lastWrite, ...(state.writeLedger || [])].filter(Boolean);
  return [...new Map(writes.map((write) => [write.idDigest, {
    idDigest: write.idDigest, inputDigest: write.inputDigest,
    inputKnown: write.inputKnown, writeDigest: write.writeDigest || write.digest
  }])).values()];
}

function sameWrite(entry, expected) {
  return entry?.idDigest === expected.idDigest && entry.inputDigest === expected.inputDigest
    && entry.inputKnown === expected.inputKnown && entry.writeDigest === expected.writeDigest;
}

function addIssue(target, seen, laneDigest, item, fallbackPath) {
  const issue = { laneDigest, path: item.path || fallbackPath,
    reason: String(item.reason || "premortem write-index inspection failed").slice(0, 400),
    code: typeof item.code === "string" ? item.code : null };
  const key = `${laneDigest}:${issue.code}:${issue.reason}`;
  if (!seen.has(key)) {
    seen.add(key);
    target.push(issue);
  }
}

export async function inspectPremortemWriteIndexAudit(premortems, {
  inspectIndexes = inspectPremortemWriteIndexes,
  inspectProof = inspectPremortemWriteProof
} = {}) {
  const combined = { directories: [], paths: [], nodes: [], errors: [], uncertainties: [],
    truncations: [], states: 0, attemptedProofs: 0, verifiedProofs: 0,
    authority: "context-only" };
  const paths = new Set();
  const errorKeys = new Set();
  const uncertaintyKeys = new Set();
  for (const state of premortems.states.filter((item) => item.writeIndexRoot)) {
    const statePath = premortems.paths.find((path) => basename(path) === `${state.laneDigest}.json`);
    if (!statePath) {
      addIssue(combined.uncertainties, uncertaintyKeys, state.laneDigest, {
        path: premortems.directory,
        reason: `premortem state ${state.laneDigest} has no inspected path`
      }, premortems.directory);
      if (premortems.directory) paths.add(premortems.directory);
      continue;
    }
    combined.states += 1;
    let inspected;
    try {
      inspected = await inspectIndexes({ statePath, state });
    } catch (error) {
      const target = error.code === WRITE_INDEX_MISMATCH
        ? [combined.errors, errorKeys] : [combined.uncertainties, uncertaintyKeys];
      addIssue(target[0], target[1], state.laneDigest, {
        path: error.path || statePath, reason: error.message, code: error.code
      }, statePath);
      paths.add(error.path || statePath);
      continue;
    }
    combined.directories.push(inspected.directory);
    for (const path of inspected.paths) paths.add(path);
    combined.nodes.push(...inspected.nodes);
    combined.truncations.push(...inspected.truncations);
    for (const item of inspected.errors) {
      if (item.path) paths.add(item.path);
      const target = item.code === WRITE_INDEX_MISMATCH
        ? [combined.errors, errorKeys] : [combined.uncertainties, uncertaintyKeys];
      addIssue(target[0], target[1], state.laneDigest, item, statePath);
    }
    for (const item of inspected.truncations) if (item.path) paths.add(item.path);
    for (const expected of boundedWrites(state)) {
      combined.attemptedProofs += 1;
      try {
        const proof = await inspectProof({ statePath, laneDigest: state.laneDigest,
          rootDigest: state.writeIndexRoot, idDigest: expected.idDigest });
        for (const path of proof.paths) paths.add(path);
        if (!sameWrite(proof.entry, expected)) {
          addIssue(combined.errors, errorKeys, state.laneDigest, {
            path: proof.paths.at(-1) || statePath, code: WRITE_INDEX_MISMATCH,
            reason: "premortem write index does not prove a bounded write"
          }, statePath);
        } else combined.verifiedProofs += 1;
      } catch (error) {
        const item = { path: error.path || inspected.paths[0] || statePath,
          reason: error.message, code: error.code };
        const target = error.code === WRITE_INDEX_MISMATCH
          ? [combined.errors, errorKeys] : [combined.uncertainties, uncertaintyKeys];
        addIssue(target[0], target[1], state.laneDigest, item, statePath);
      }
    }
  }
  combined.paths = [...paths].sort();
  return combined;
}

export async function inspectPremortemAudit(root, gatewayPolicy) {
  const premortems = await inspectDeliveryPremortems(root);
  const indexes = premortems.directory
    ? await inspectPremortemLaneIndexes(premortems.directory)
    : { directory: null, directories: [], paths: [], pointers: [], errors: [],
      finalizations: [], tamperedPointers: [], tamperedFinalizations: [], truncations: [] };
  const writeIndexes = await inspectPremortemWriteIndexAudit(premortems);
  const crossReferenceIssues = premortemIndexCrossReferenceFindings(premortems, indexes, gatewayPolicy);
  return { premortems, indexes, writeIndexes, crossReferenceIssues };
}
