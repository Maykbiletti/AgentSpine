const BLUN_MESSAGE_MAX_BYTES = 1200;
const BLUN_BOUND_MARKER = "\n[optional runtime detail omitted: 1200-byte bound]";

function compactPremortemRegistration(premortem, includeRoot = true) {
  const root = premortem?.registration?.root;
  const requirementId = premortem?.requirementId || premortem?.registration?.requirementId;
  const target = includeRoot && typeof root === "string"
    ? ` with root ${JSON.stringify(root)}` : " for the current project";
  return [
    "Before the first Write/Edit/apply_patch or recognized shell mutation, make exactly three AgentSpine calls in order:",
    `session_briefing, delivery_knowledge_query, then record_delivery_premortem${target}.`,
    `Requirement: ${requirementId || "<unavailable; retry the hook>"}.`,
    "Only stored call receipts from this session and goal step count; the calls grant no authority.",
    "Completion: Premortem closure sha256 <64hex>, latest write digest, and all three check IDs with results."
  ].join("\n");
}

export function blunRuntimeContext(context) {
  const detailed = JSON.parse(context);
  const sourceResolution = detailed.sourceResolution ? {
    status: detailed.sourceResolution.status || null,
    reason: detailed.sourceResolution.reason || null,
    ...(detailed.sourceResolution.incomplete ? {
      incomplete: true,
      warning: detailed.sourceResolution.warning || "Host-native source context is incomplete."
    } : {})
  } : null;
  const runtime = {
    schema: "agentspine.blun-runtime-context/v1",
    event: detailed.event,
    loaded: Boolean(detailed.loaded),
    failedClosed: detailed.failedClosed ? true : undefined,
    indexedSources: detailed.indexedSources || 0,
    sourceResolution,
    instruction: detailed.loaded
      ? "Detailed AgentSpine context is available on demand through session_briefing. Load it only when the current request needs continuity."
      : detailed.instruction,
    authority: "context-only"
  };
  if (detailed.signal && (detailed.signal.captured || detailed.signal.accepted || detailed.signal.reason)) {
    runtime.signal = detailed.signal;
  }
  if (detailed.attentionEvent
    && (detailed.attentionEvent.captured || detailed.attentionEvent.duplicate || detailed.attentionEvent.reason)) {
    runtime.attentionEvent = detailed.attentionEvent;
  }
  if (detailed.selfstarter && (detailed.selfstarter.active || detailed.selfstarter.blocked)) {
    runtime.selfstarter = detailed.selfstarter;
  }
  if (detailed.channelEvent?.active) runtime.channelEvent = detailed.channelEvent;
  if (detailed.preflight?.premortem) runtime.premortem = detailed.preflight.premortem;
  return JSON.stringify(runtime);
}

export function blunRuntimeMessage(context) {
  const runtime = JSON.parse(blunRuntimeContext(context));
  const warning = runtime.sourceResolution?.incomplete ? ` Warning: ${runtime.sourceResolution.warning}` : "";
  const base = runtime.loaded
    ? `AgentSpine ready: ${runtime.indexedSources} sources indexed. Load detailed continuity only on demand through session_briefing.${warning}`
    : `AgentSpine unavailable${runtime.sourceResolution?.reason ? `: ${runtime.sourceResolution.reason}` : ""}. ${runtime.instruction}`;
  const active = {};
  if (runtime.signal && (runtime.signal.captured || runtime.signal.accepted
    || String(runtime.signal.reason || "").startsWith("rejected:"))) {
    active.signal = runtime.signal;
  }
  if (runtime.attentionEvent && (runtime.attentionEvent.captured || runtime.attentionEvent.duplicate
    || String(runtime.attentionEvent.reason || "").startsWith("rejected:"))) {
    active.attentionEvent = runtime.attentionEvent;
  }
  if (runtime.selfstarter) active.selfstarter = runtime.selfstarter;
  if (runtime.channelEvent) active.channelEvent = runtime.channelEvent;
  const details = Object.keys(active).length === 0
    ? ""
    : `\nActive AgentSpine runtime data: ${JSON.stringify(active)}`;
  const premortem = runtime.premortem?.instruction ? `\n${runtime.premortem.instruction}` : "";
  const message = `${base}${details}${premortem}`;
  if (Buffer.byteLength(message) <= BLUN_MESSAGE_MAX_BYTES) return message;
  const compact = `${base}${BLUN_BOUND_MARKER}\n${compactPremortemRegistration(runtime.premortem)}`;
  if (Buffer.byteLength(compact) <= BLUN_MESSAGE_MAX_BYTES) return compact;
  return `${base}${BLUN_BOUND_MARKER}\n${compactPremortemRegistration(runtime.premortem, false)}`;
}

export function hookOutput(event, context, env = process.env) {
  if (env.BLUN_PLUGIN_ROOT) {
    return { hookSpecificOutput: { hookEventName: event, message: blunRuntimeMessage(context) } };
  }
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

export function blockedHookOutput(event, reason, env = process.env) {
  const output = { decision: "block", reason };
  if (!env.CLAUDE_PLUGIN_ROOT || env.PLUGIN_ROOT) return output;
  if (event === "PreToolUse") return { hookSpecificOutput: {
    hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason
  } };
  return output;
}

export function denyTool(reason) {
  process.stdout.write(`${JSON.stringify(blockedHookOutput("PreToolUse", reason))}\n`);
}

export function blockPrompt(reason) {
  process.stdout.write(`${JSON.stringify(blockedHookOutput("UserPromptSubmit", reason))}\n`);
}

export function blockStop(event, reason) {
  process.stdout.write(`${JSON.stringify(blockedHookOutput(event, reason))}\n`);
}

export function lifecycleOutput(event, artifactGuard, premortem, deliveryVerification = null, env = process.env,
  sourceWarning = null) {
  const messages = sourceWarning ? [`AgentSpine source warning: ${sourceWarning}`] : [];
  if (artifactGuard?.reason) messages.push(artifactGuard.reason);
  if (deliveryVerification?.status === "test-failed" && deliveryVerification.reason) {
    messages.push(deliveryVerification.reason);
  }
  if (/^[a-f0-9]{64}$/.test(premortem?.writeDigest || "")) {
    messages.push([
      premortem.writeIntent
        ? "AgentSpine recorded the allowed mutation intent for the delivery premortem."
        : "AgentSpine recorded the direct write for the delivery premortem.",
      `Premortem latest write sha256 ${premortem.writeDigest}`
    ].join("\n"));
  }
  if (!messages.length) return {};
  const field = env.BLUN_PLUGIN_ROOT ? "message" : "additionalContext";
  return { hookSpecificOutput: { hookEventName: event, [field]: messages.join("\n") } };
}
