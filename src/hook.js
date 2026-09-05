#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { catalogForStateRoot, saveCatalog } from "./lib/catalog.js";
import { loadGraph } from "./lib/graph.js";
import { canonicalPath } from "./lib/paths.js";
import { resolveHostSourceCatalog } from "./lib/source-roots.js";
import { sessionBriefing } from "./lib/briefing.js";
import { captureContinuityPrompt } from "./lib/continuity.js";
import { recordLearningApplications, recordLearningDeliveries } from "./lib/learning.js";
import { authorizeJobEffect, checkpointJobEffect, closeJobLease } from "./lib/selfstarter.js";
import { syncPersonaRosterFromEnvironment } from "./lib/persona-runtime.js";
import { captureMustRememberPrompt, recordPreflightFailure, runPreflight, verifyPreflightReceipt } from "./lib/preflight.js";
import { actionLessonRecall } from "./lib/action-lesson-recall.js";
import { captureSessionTimelineLifecycle, finalizeUserPromptSessionTimeline } from "./lib/hook-timeline.js";
import { timelineToolKind } from "./lib/mcp-timeline-tools.js";
import { emitTimelineToolGuard, runTimelineToolGuard } from "./lib/timeline-tool-guard.js";
import { readHookInput, SILENT_OVERSIZE_POST_TOOL_USE, SILENT_OVERSIZE_POST_TOOL_USE_ARG } from "./lib/hook-input.js";
import { isMainModule } from "./lib/runtime.js";
import { deliveryActorSession, deliverySuccessEvidence, recordDeliveryToolUse,
  recordDeliveryWriteIntent } from "./lib/delivery-verification.js";
import {
  blockPrompt, blockStop, blunRuntimeContext, blunRuntimeMessage, denyTool, hookOutput, lifecycleOutput
} from "./lib/hook-output.js";
import {
  ATTENTION_WRITE_EVENTS, boundedId, captureAttentionLifecycle, hookDeliveryId, hostContextLimit, hostFromInput,
  promptFromInput, renderContext, runtimeScope, selfstarterInput, selfstarterRootSkipped,
  selfstarterScope, sessionId, startChannelEvent, startSelfstarter, toolResult, toolSucceeded
} from "./lib/hook-context.js";
import {
  auditGuard, auditSkippedScans, candidatePaths, finishScanFailure, hookScanFailureFailsOpen,
  isMutationTool, isScanFailOpenTool, shellTargetsProtected
} from "./lib/hook-protection.js";
import {
  captureJavaScriptBeforeWrite, inspectWrittenJavaScript, verifyBaselineBeforeWrite, verifyDeliveredArtifacts
} from "./lib/hook-artifact-guards.js";
import { isPremortemWrite, prepareHookPremortem, recordHookPremortemWrite,
  recordHookPremortemWriteIntent, verifyHookPremortemWrite } from "./lib/hook-premortem.js";
import { denyHookStop, verifyHookStopContracts } from "./lib/hook-stop-verification.js";
export { blunRuntimeContext, blunRuntimeMessage } from "./lib/hook-output.js";
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);
const KNOWN_EVENTS = new Set([
  ...CONTEXT_EVENTS, "InstructionsLoaded", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"
]);
async function runHookCore(input, payload, options) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("hook input must be one JSON object");
  const event = input.hook_event_name || input.event_name || "";
  if (!KNOWN_EVENTS.has(event)) throw new Error(`unsupported hook event: ${event || "missing"}`);
  if (event === "InstructionsLoaded") {
    const file = input.file_path;
    if (typeof file !== "string" || !file || !["User", "Project", "Local", "Managed"].includes(input.memory_type)
      || !["session_start", "nested_traversal", "path_glob_match", "include", "compact"].includes(input.load_reason)) {
      throw new Error("InstructionsLoaded payload is invalid");
    }
    if (payload) return { blocked: false, observed: true };
    process.stdout.write("{}\n");
    return;
  }
  const cwd = await canonicalPath(input.cwd || process.cwd());
  const host = hostFromInput(input);
  const instructionHost = host === "generic" ? input.instruction_host : host;
  if (host === "generic" && !["claude", "codex"].includes(instructionHost)) {
    const reason = "AgentSpine generic hosts must bind instruction_host to claude or codex";
    if (event === "UserPromptSubmit") {
      if (payload) return { blocked: true, failedClosed: true, reason };
      blockPrompt(reason);
      return;
    }
    throw new Error(reason);
  }
  let resolvedSources;
  try {
    resolvedSources = await resolveHostSourceCatalog({ host: instructionHost, cwd, input });
  } catch (error) {
    if (hookScanFailureFailsOpen(error)) {
      return finishScanFailure(input, payload, "source-resolution", error);
    }
    const reason = `AgentSpine source resolution failed closed: ${error.message}`;
    if (event === "PreToolUse" && isMutationTool(input.tool_name)) {
      if (payload) return { blocked: true, failedClosed: true, reason };
      denyTool(reason);
      return;
    }
    if (event === "UserPromptSubmit") {
      if (payload) return { blocked: true, failedClosed: true, reason };
      blockPrompt(reason);
      return;
    }
    const context = JSON.stringify({
      schema: "agentspine.hook-context/v1", event, loaded: false, failedClosed: true,
      indexedSources: 0, sourceResolution: { status: "failed-closed", reason: error.message },
      instruction: "Do not claim AgentSpine recall succeeded. Continue under current native host rules; no remembered context or automatic effect was applied.",
      authority: "context-only"
    });
    if (payload) return { blocked: false, failedClosed: true, context, error: error.message };
    if (CONTEXT_EVENTS.has(event)) process.stdout.write(`${JSON.stringify(hookOutput(event, context))}\n`);
    else process.stdout.write("{}\n");
    return;
  }
  const root = resolvedSources.projectRoot;
  const catalog = resolvedSources.catalog;
  const catalogPath = await saveCatalog(catalog), sourceWarning = resolvedSources.diagnostics.warning || null;
  let scope = null;
  let selfstarter = null;
  let channelEvent = null;
  let learningDelivery = null;
  let deliveryVerification = null;
  let artifactGuard = null;
  let premortem = null;
  let lessonRecall = null;
  if (event === "PreToolUse" && isScanFailOpenTool(input.tool_name) && resolvedSources.diagnostics.skipped?.length) {
    await auditSkippedScans(input, "source-resolution", resolvedSources.diagnostics.skipped);
  }
  if (event === "PreToolUse" && isMutationTool(input.tool_name)) {
    const { graph } = await loadGraph(root, catalog);
    const inferredProtected = new Set(graph.annotations
      .filter((annotation) => ["constitution", "soul", "memory-index", "memory-fact"].includes(annotation.layer))
      .map((annotation) => annotation.path));
    const protectedRelative = new Set(catalog.documents
      .filter((doc) => doc.protected || inferredProtected.has(doc.relativePath))
      .map((doc) => doc.relativePath));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const edge of graph.edges) {
        if (protectedRelative.has(edge.from) && !protectedRelative.has(edge.to)) {
          protectedRelative.add(edge.to);
          expanded = true;
        }
      }
    }
    const protectedDocuments = catalog.documents.filter((doc) => protectedRelative.has(doc.relativePath));
    const protectedPaths = new Set(protectedDocuments.map((doc) => resolve(doc.path)));
    const targets = await Promise.all(candidatePaths(input.tool_input || input.tool_args).map(async (path) => {
      const target = resolve(cwd, path);
      try { return await canonicalPath(target); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return target;
      }
    }));
    const hit = targets.find((path) => protectedPaths.has(path));
    const shellHit = shellTargetsProtected(input, protectedDocuments, cwd, root);
    if (hit || shellHit) {
      const relativePath = shellHit?.relativePath || catalog.documents.find((doc) => resolve(doc.path) === hit)?.relativePath || hit;
      const reason = `AgentSpine protected source: ${relativePath}. Existing identity, rule, soul, and memory documents are read-only to agents.`;
      if (payload) return { blocked: true, reason };
      denyTool(reason);
      return;
    }
  }
  if (event === "PreToolUse") {
    try {
      artifactGuard = await verifyBaselineBeforeWrite({ input, cwd });
      if (["no-stand", "no-baseline", "invalid-stand", "ambiguous-baseline"].includes(artifactGuard.status)) {
        await auditGuard(input, "baseline-guard", artifactGuard, true);
      }
      if (artifactGuard.blocked) {
        if (payload) return { blocked: true, reason: artifactGuard.reason, artifactGuard };
        denyTool(artifactGuard.reason);
        return;
      }
    } catch (error) {
      artifactGuard = { status: "scan-failed-open", blocked: false, path: error.path || cwd, reason: error.message };
      await auditGuard(input, "baseline-guard", artifactGuard);
    }
    try { await captureJavaScriptBeforeWrite({ input, cwd, root }); }
    catch (error) {
      await auditGuard(input, "identifier-before-state", {
        status: "scan-failed-open", blocked: false, path: error.path || cwd, reason: error.message
      });
    }
  }
  if (event === "PreToolUse" && !selfstarterRootSkipped(resolvedSources.diagnostics)) {
    try {
      scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
      const exact = await selfstarterScope(input, scope, root, "effect");
      if (exact) {
        selfstarter = await authorizeJobEffect({
          root, ...exact, toolName: input.tool_name, toolUseId: hookDeliveryId(input),
          now: input.timestamp || new Date()
        });
      }
    } catch (error) {
      if (isScanFailOpenTool(input.tool_name) && hookScanFailureFailsOpen(error)) {
        return finishScanFailure(input, payload, "self-starter", error);
      }
      const reason = `AgentSpine self-starter denied this effect: ${error.message}`;
      if (payload) return { blocked: true, reason, selfstarter: { allowed: false, reason: error.message } };
      denyTool(reason);
      return;
    }
  }
  if (event === "PreToolUse" && isPremortemWrite(input)) {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    premortem = await verifyHookPremortemWrite({ input, root, scope });
    if (premortem.blocked) {
      if (payload) return { blocked: true, reason: premortem.reason, premortem };
      denyTool(premortem.reason);
      return;
    }
  }
  if (event === "PreToolUse") {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    deliveryVerification = await recordDeliveryWriteIntent({
      root, host: scope.host, sessionId: deliveryActorSession(input), scope, input
    });
    if (deliveryVerification.blocked) {
      if (payload) return { blocked: true, reason: deliveryVerification.reason, deliveryVerification };
      denyTool(deliveryVerification.reason); return;
    }
    if (typeof options.afterDeliveryWriteIntent === "function") await options.afterDeliveryWriteIntent();
    const premortemIntent = await recordHookPremortemWriteIntent({ input, root, scope });
    if (premortemIntent.blocked) {
      if (payload) return { blocked: true, reason: premortemIntent.reason, deliveryVerification, premortem: premortemIntent };
      denyTool(premortemIntent.reason); return;
    }
    premortem = { ...premortem, writeIntent: premortemIntent.status,
      writeDigest: premortemIntent.writeDigest || null };
    try { lessonRecall = actionLessonRecall({ catalog, event, input, scope }); }
    catch (error) { lessonRecall = { status: "degraded", items: [], reason: error.message, authority: "context-only" }; }
  }

  if (["PostToolUse", "Stop", "SubagentStop"].includes(event)) {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    if (event === "PostToolUse") {
      premortem = await recordHookPremortemWrite({
        input, root, scope, success: toolSucceeded(input)
      });
      deliveryVerification = await recordDeliveryToolUse({
        root, host: scope.host, sessionId: deliveryActorSession(input), scope,
        input, success: deliverySuccessEvidence(input)
      });
      if (toolSucceeded(input)) {
        try {
          artifactGuard = await inspectWrittenJavaScript({ input, cwd, root });
        } catch (error) {
          artifactGuard = { status: "scan-failed-open", blocked: false, path: error.path || cwd, reason: error.message };
          await auditGuard(input, "identifier-guard", artifactGuard);
        }
      }
    } else {
      const activeJob = selfstarterRootSkipped(resolvedSources.diagnostics)
        ? null : await selfstarterScope(input, scope, root, "resume");
      const pauseRequested = Boolean(activeJob && selfstarterInput(input)?.status !== "completed");
      let contracts = await verifyHookStopContracts({
        input,
        root,
        scope,
        recordPause: pauseRequested
      });
      ({ deliveryVerification, premortem } = contracts);
      if (contracts.blocked) {
        return denyHookStop(payload, event, contracts.reason, { deliveryVerification, premortem });
      }

      try {
        artifactGuard = await verifyDeliveredArtifacts({ input, cwd });
        if (artifactGuard.blocked) {
          return denyHookStop(payload, event, artifactGuard.reason, { deliveryVerification, artifactGuard });
        }
      } catch (error) {
        artifactGuard = { status: "scan-failed-open", blocked: false, path: error.path || cwd, reason: error.message };
        await auditGuard(input, "delivery-artifact-guard", artifactGuard);
      }
      if (typeof options.afterArtifactVerification === "function") await options.afterArtifactVerification();
      contracts = await verifyHookStopContracts({
        input,
        root,
        scope,
        recordPause: pauseRequested,
        completionFence: !pauseRequested,
        afterDeliveryVerification: options.afterFinalDeliveryVerification,
        afterPremortemVerification: options.afterFinalPremortemVerification
      });
      ({ deliveryVerification, premortem } = contracts);
      if (contracts.blocked) {
        return denyHookStop(payload, event, contracts.reason,
          { deliveryVerification, premortem, artifactGuard });
      }
    }
  }

  let attentionEvent = null;
  if (ATTENTION_WRITE_EVENTS.has(event) && !CONTEXT_EVENTS.has(event)) {
    scope = await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    attentionEvent = await captureAttentionLifecycle(input, event, root, scope, catalog);
  }

  if (event === "PostToolUse" && !selfstarterRootSkipped(resolvedSources.diagnostics)) {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    const exact = await selfstarterScope(input, scope, root, "effect");
    if (exact) {
      selfstarter = await checkpointJobEffect({
        root, ...exact, toolName: input.tool_name, toolUseId: hookDeliveryId(input),
        success: toolSucceeded(input), result: toolResult(input), now: input.timestamp || new Date()
      });
    }
  }

  if (["Stop", "SubagentStop"].includes(event)) {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    const exact = selfstarterRootSkipped(resolvedSources.diagnostics)
      ? null : await selfstarterScope(input, scope, root, "resume");
    if (exact && !scope.currentTaskId) scope.currentTaskId = exact.taskId;
    try {
      learningDelivery = await recordLearningDeliveries({
        root, sessionId: sessionId(input), hookEvent: event,
        scope: {
          personaId: scope.entityId, userId: scope.userId, tenantId: scope.tenantId,
          projectId: scope.projectId, groupId: scope.groupId, taskId: scope.currentTaskId
        },
        completedAt: input.timestamp || new Date()
      });
    } catch (error) {
      learningDelivery = { status: "degraded", receipts: [], reason: error.message, authority: "context-only" };
    }
    const requested = selfstarterInput(input);
    if (exact) {
      selfstarter = await closeJobLease({
        root, ...exact, status: requested?.status || "waiting", now: input.timestamp || new Date()
      });
    }
  }

  if (CONTEXT_EVENTS.has(event)) {
    let signal = null;
    let preflight = null;
    try {
      await syncPersonaRosterFromEnvironment({ root, env: process.env, now: input.timestamp || new Date(), catalog });
      scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
      if (event !== "UserPromptSubmit") {
        try { resolvedSources.diagnostics.timeline = await captureSessionTimelineLifecycle({ root, event, input, scope,
          hostHome: resolvedSources.hostHome, catalog }); }
        catch (error) { resolvedSources.diagnostics.timeline = { status: "degraded", reason: error.message, authority: "context-only" }; }
      }
      channelEvent = await startChannelEvent(input, event, root, scope, catalog);
      selfstarter = await startSelfstarter(input, event, root, scope, resolvedSources.diagnostics);
      if (selfstarter?.job && !scope.currentTaskId) scope.currentTaskId = selfstarter.job.taskId;
      if (event === "UserPromptSubmit") {
        const prompt = promptFromInput(input);
        if (prompt === null) throw new Error("mandatory preflight requires the exact current prompt");
        preflight = await runPreflight({
          input, scope, resolvedSources, prompt, now: input.timestamp || new Date(), env: process.env
        });
        if (!await verifyPreflightReceipt({
          receipt: preflight.receipt, input, scope, resolvedSources, prompt,
          now: input.timestamp || new Date(), env: process.env
        })) throw new Error("newly created preflight receipt failed exact turn verification");
        preflight.premortem = await prepareHookPremortem({ input, root, scope });
        preflight.pendingMustRemember = await captureMustRememberPrompt({ prompt, receipt: preflight.receipt, env: process.env });
        try {
          attentionEvent = await captureAttentionLifecycle(input, event, root, scope, catalog);
        } catch (error) {
          attentionEvent = { event: null, duplicate: false, reason: `rejected:${error.message}` };
        }
        if (prompt !== null) {
          try {
            signal = await captureContinuityPrompt({
              root, prompt, entityId: scope.entityId, groupId: scope.groupId,
              projectId: scope.projectId, userStateRoot: resolvedSources.userStateRoot,
              eventId: boundedId(input.event_id ?? input.hook_event_id, "eventId"), catalog,
              userCatalog: resolvedSources.userStateRoot && resolvedSources.userStateRoot !== root
                ? catalogForStateRoot(catalog, resolvedSources.userStateRoot) : catalog
            });
          } catch (error) {
            signal = { captured: false, accepted: false, reason: `rejected:${error.message}` };
          }
        }
      }
      const briefing = await sessionBriefing({
        root, cwd, host: scope.host, entityId: scope.entityId, groupId: scope.groupId,
        userId: scope.userId, tenantId: scope.tenantId, projectId: scope.projectId, currentTaskId: scope.currentTaskId,
        includePrivate: Boolean(scope.entityId && !scope.groupId),
        focusActive: true, includeSourceContent: event === "UserPromptSubmit" ? false : !scope.groupId,
        maxBytes: event === "UserPromptSubmit" ? 4096 : scope.config.maxBriefingBytes,
        now: input.timestamp || new Date(),
        catalog, userStateRoot: resolvedSources.userStateRoot, sourceDiagnostics: resolvedSources.diagnostics,
        prompt: event === "UserPromptSubmit" ? promptFromInput(input) : null
      });
      if (event === "PostCompact") {
        try { lessonRecall = actionLessonRecall({ catalog, event, input, scope }); }
        catch (error) { lessonRecall = { status: "degraded", items: [], reason: error.message, authority: "context-only" }; }
      }
      let context = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent, resolvedSources.diagnostics, preflight, lessonRecall);
      if (event === "UserPromptSubmit" && Buffer.byteLength(context) > hostContextLimit(preflight)) {
        throw new Error("mandatory preflight context exceeds the host hook injection limit");
      }
      if (event === "UserPromptSubmit") {
        const { preflightConsumed, timeline } = await finalizeUserPromptSessionTimeline({ root, input, scope, resolvedSources, preflight,
          prompt: promptFromInput(input), now: input.timestamp || new Date() });
        if (!preflightConsumed) throw new Error("preflight receipt could not be consumed atomically for this exact turn");
        resolvedSources.diagnostics.timeline = timeline;
      }
      if (event === "UserPromptSubmit") {
        const activeCanaries = briefing.learning.filter((item) => ["active", "revalidating"].includes(item.outcomeStatus));
        if (!activeCanaries.length) {
          preflight.learningApplications = {
            status: "not-applicable", receipts: [], authority: "context-only"
          };
        } else try {
          const application = await recordLearningApplications({
            root, items: briefing.learning,
            scope: {
              personaId: scope.entityId, userId: scope.userId, tenantId: scope.tenantId,
              projectId: scope.projectId, groupId: scope.groupId, taskId: scope.currentTaskId
            },
            preflightReceipt: preflight.receipt,
            sessionBriefingDigest: createHash("sha256").update(JSON.stringify(briefing)).digest("hex"),
            projectedAt: input.timestamp || new Date()
          });
          preflight.learningApplications = {
            status: application.receipts.length ? "recorded" : "not-applicable",
            receipts: application.receipts.map((item) => ({
              id: item.id, learningId: item.learningId, projectedAt: item.projectedAt, expiresAt: item.expiresAt
            })),
            authority: "context-only"
          };
        } catch (error) {
          briefing.learning = briefing.learning.filter((item) => !["active", "revalidating"].includes(item.outcomeStatus));
          preflight.learningApplications = {
            status: "degraded", receipts: [], reason: error.message, authority: "context-only"
          };
        }
        const enriched = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent,
          resolvedSources.diagnostics, preflight, lessonRecall);
        if (Buffer.byteLength(enriched) <= hostContextLimit(preflight)) context = enriched;
        else if (preflight.learningApplications.status === "degraded") {
          preflight.learningApplications = null;
          context = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent,
            resolvedSources.diagnostics, preflight, lessonRecall);
        }
      }
      if (payload) return { blocked: false, context, briefing, preflight, signal, attentionEvent, channelEvent, lessonRecall, catalogPath };
      process.stdout.write(`${JSON.stringify(hookOutput(event, context))}\n`);
      return;
    } catch (error) {
      if (hookScanFailureFailsOpen(error)) {
        return finishScanFailure(input, payload, "context-lifecycle", error);
      }
      if (event === "UserPromptSubmit") {
        await recordPreflightFailure({ receiptId: preflight?.receipt?.id || null, input, host,
          error, now: input.timestamp || new Date(), env: process.env }).catch(() => {});
        const reason = `AgentSpine pre-answer preflight blocked this turn: ${error.message}`;
        if (payload) return { blocked: true, failedClosed: true, reason, error: error.message, catalogPath };
        blockPrompt(reason);
        return;
      }
      const context = JSON.stringify({
        schema: "agentspine.hook-context/v1", event, loaded: false, failedClosed: true,
        indexedSources: catalog.summary.total,
        sourceResolution: resolvedSources.diagnostics,
        error: error.message,
        instruction: "Do not claim AgentSpine recall succeeded. Continue with the current request under native host rules and run agentspine audit before using remembered context.",
        authority: "context-only"
      });
      if (payload) return { blocked: false, failedClosed: true, context, error: error.message, catalogPath };
      process.stdout.write(`${JSON.stringify(hookOutput(event, context))}\n`);
      return;
    }
  }
  if (artifactGuard?.blocked) {
    if (payload) return { blocked: true, reason: artifactGuard.reason, artifactGuard,
      attentionEvent, selfstarter, learningDelivery, deliveryVerification, premortem };
    blockStop(event, artifactGuard.reason);
    return;
  }
  if (payload) return { blocked: false, sourceWarning, artifactGuard, attentionEvent, selfstarter,
    learningDelivery, deliveryVerification, premortem, lessonRecall };
  process.stdout.write(`${JSON.stringify(lifecycleOutput(event, artifactGuard, premortem, deliveryVerification, process.env, sourceWarning, lessonRecall))}\n`);
}

export async function runHook(payload = null, options = {}) {
  let input = payload;
  try {
    input ||= await readHookInput(options);
    if (input === SILENT_OVERSIZE_POST_TOOL_USE) return;
    if (input.hook_event_name === "PreToolUse" && timelineToolKind(input.tool_name)) {
      const result = await runTimelineToolGuard(input);
      if (!payload) emitTimelineToolGuard(result);
      return result;
    }
    return await runHookCore(input, payload, options);
  } catch (error) {
    if (!hookScanFailureFailsOpen(error) || input === SILENT_OVERSIZE_POST_TOOL_USE) throw error;
    return finishScanFailure(input, payload, "lifecycle", error);
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const silentOversizePostToolUse = args.length === 1 && args[0] === SILENT_OVERSIZE_POST_TOOL_USE_ARG;
  const argumentError = args.length && !silentOversizePostToolUse
    ? new Error(`unsupported hook argument: ${args[0]}`) : null;
  (argumentError ? Promise.reject(argumentError) : runHook(null, { silentOversizePostToolUse })).catch((error) => {
    process.stderr.write(`AgentSpine hook: ${String(error.message).slice(0, 2048)}\n`);
    // Claude command hooks treat exit 2 as a blocking failure. Exit 1 is
    // fail-open, which is unsafe for malformed pre-answer payloads.
    process.exitCode = 2;
  });
}
