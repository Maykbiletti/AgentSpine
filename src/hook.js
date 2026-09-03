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
import { isMainModule } from "./lib/runtime.js";
import {
  recordDeliveryPause, recordDeliveryToolUse, verifyDeliveryStop
} from "./lib/delivery-verification.js";
import { blunRuntimeContext, blunRuntimeMessage, hookOutput } from "./lib/hook-output.js";
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

export { blunRuntimeContext, blunRuntimeMessage } from "./lib/hook-output.js";

const MAX_STDIN_BYTES = 64 * 1024;
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);
const KNOWN_EVENTS = new Set([
  ...CONTEXT_EVENTS, "InstructionsLoaded", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"
]);
const SILENT_OVERSIZE_POST_TOOL_USE = Symbol("silent-oversize-post-tool-use");
const SILENT_OVERSIZE_POST_TOOL_USE_ARG = "--silent-oversize-post-tool-use";

async function readStdin({ silentOversizePostToolUse = false } = {}) {
  const chunks = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, MAX_STDIN_BYTES - bytes);
    if (remaining) chunks.push(buffer.subarray(0, remaining));
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) oversized = true;
  }
  if (oversized) {
    if (silentOversizePostToolUse) return SILENT_OVERSIZE_POST_TOOL_USE;
    throw new Error("hook input exceeds the 64 KiB limit");
  }
  const value = Buffer.concat(chunks, bytes).toString("utf8");
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hook input must be one JSON object");
  return parsed;
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  })}\n`);
}

function blockPrompt(reason) {
  process.stdout.write(`${JSON.stringify({
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", decision: "block", reason }
  })}\n`);
}

function blockStop(event, reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason,
    hookSpecificOutput: { hookEventName: event, decision: "block", reason } })}\n`);
}

async function runHookCore(input, payload) {
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
      deny(reason);
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
  const catalogPath = await saveCatalog(catalog);
  let scope = null;
  let selfstarter = null;
  let channelEvent = null;
  let learningDelivery = null;
  let deliveryVerification = null;
  let artifactGuard = null;

  if (event === "PreToolUse" && isScanFailOpenTool(input.tool_name) && resolvedSources.diagnostics.skipped?.length) {
    await auditSkippedScans(input, "source-resolution", resolvedSources.diagnostics.skipped);
  }

  if (event === "PreToolUse") {
    try {
      artifactGuard = await verifyBaselineBeforeWrite({ input, cwd });
      if (["no-stand", "no-baseline", "invalid-stand", "ambiguous-baseline"].includes(artifactGuard.status)) {
        await auditGuard(input, "baseline-guard", artifactGuard, true);
      }
      if (artifactGuard.blocked) {
        if (payload) return { blocked: true, reason: artifactGuard.reason, artifactGuard };
        deny(artifactGuard.reason);
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
      deny(reason);
      return;
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
      deny(reason);
      return;
    }
  }

  if (["PostToolUse", "Stop", "SubagentStop"].includes(event)) {
    scope ||= await runtimeScope(input, root, resolvedSources.userStateRoot, catalog);
    const deliveryScope = {
      entityId: scope.entityId, tenantId: scope.tenantId, groupId: scope.groupId,
      projectId: scope.projectId, currentTaskId: scope.currentTaskId
    };
    if (event === "PostToolUse") {
      deliveryVerification = await recordDeliveryToolUse({
        root, host: scope.host, sessionId: sessionId(input), scope: deliveryScope,
        input, success: toolSucceeded(input)
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
      const requestedStatus = selfstarterInput(input)?.status || null;
      deliveryVerification = activeJob && requestedStatus !== "completed"
        ? await recordDeliveryPause({
          root, host: scope.host, sessionId: sessionId(input), scope: deliveryScope,
          eventId: input.event_id ?? input.hook_event_id ?? null
        })
        : await verifyDeliveryStop({
          root, host: scope.host, sessionId: sessionId(input), scope: deliveryScope,
          eventId: input.event_id ?? input.hook_event_id ?? null
        });
      if (deliveryVerification.blocked) {
        if (payload) return { blocked: true, reason: deliveryVerification.reason, deliveryVerification };
        blockStop(event, deliveryVerification.reason);
        return;
      }
      try {
        artifactGuard = await verifyDeliveredArtifacts({ input, cwd });
        if (artifactGuard.blocked) {
          if (payload) return { blocked: true, reason: artifactGuard.reason, deliveryVerification, artifactGuard };
          blockStop(event, artifactGuard.reason);
          return;
        }
      } catch (error) {
        artifactGuard = { status: "scan-failed-open", blocked: false, path: error.path || cwd, reason: error.message };
        await auditGuard(input, "delivery-artifact-guard", artifactGuard);
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
      let context = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent, resolvedSources.diagnostics, preflight);
      if (event === "UserPromptSubmit" && Buffer.byteLength(context) > hostContextLimit(preflight)) {
        throw new Error("mandatory preflight context exceeds the host hook injection limit");
      }
      if (event === "UserPromptSubmit" && !await verifyPreflightReceipt({
        receipt: preflight.receipt, input, scope, resolvedSources, prompt: promptFromInput(input),
        now: input.timestamp || new Date(), env: process.env, consume: true
      })) throw new Error("preflight receipt could not be consumed atomically for this exact turn");
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
          resolvedSources.diagnostics, preflight);
        if (Buffer.byteLength(enriched) <= hostContextLimit(preflight)) context = enriched;
        else if (preflight.learningApplications.status === "degraded") {
          preflight.learningApplications = null;
          context = renderContext(event, catalog, briefing, signal, attentionEvent, selfstarter, channelEvent,
            resolvedSources.diagnostics, preflight);
        }
      }
      if (payload) return { blocked: false, context, briefing, preflight, signal, attentionEvent, channelEvent, catalogPath };
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
      attentionEvent, selfstarter, learningDelivery, deliveryVerification };
    blockStop(event, artifactGuard.reason);
    return;
  }
  if (payload) return { blocked: false, artifactGuard, attentionEvent, selfstarter, learningDelivery, deliveryVerification };
  if (artifactGuard?.reason) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: event, additionalContext: artifactGuard.reason
    } })}\n`);
    return;
  }
  process.stdout.write("{}\n");
}

export async function runHook(payload = null, options = {}) {
  let input = payload;
  try {
    input ||= await readStdin(options);
    if (input === SILENT_OVERSIZE_POST_TOOL_USE) return;
    return await runHookCore(input, payload);
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
