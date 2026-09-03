export function blunRuntimeContext(context) {
  const detailed = JSON.parse(context);
  const sourceResolution = detailed.sourceResolution ? {
    status: detailed.sourceResolution.status || null,
    reason: detailed.sourceResolution.reason || null
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
  return JSON.stringify(runtime);
}

export function blunRuntimeMessage(context) {
  const runtime = JSON.parse(blunRuntimeContext(context));
  const base = runtime.loaded
    ? `AgentSpine ready: ${runtime.indexedSources} sources indexed. Load detailed continuity only on demand through session_briefing.`
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
  return Object.keys(active).length === 0
    ? base
    : `${base}\nActive AgentSpine runtime data: ${JSON.stringify(active)}`;
}

export function hookOutput(event, context, env = process.env) {
  if (env.BLUN_PLUGIN_ROOT) {
    return { hookSpecificOutput: { hookEventName: event, message: blunRuntimeMessage(context) } };
  }
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}
