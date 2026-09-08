const BLUN_MESSAGE_MAX_BYTES = 1200;
const BLUN_BOUND_MARKER = "\n[optional runtime detail omitted: 1200-byte bound]";

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function addRecallField(packet, key, value, omitted) {
  if (value === undefined || value === null) return;
  packet[key] = value;
  if (byteSize(packet) <= 1020) return;
  delete packet[key];
  omitted.push(key);
}

export function preAnswerRecallCapsule(detailed) {
  if (detailed?.event !== "UserPromptSubmit" || !detailed.loaded) return null;
  const briefing = detailed.briefing;
  const preflight = detailed.preflight?.briefing;
  if (!briefing || !preflight) return null;
  if (briefing.scope?.groupId !== null && briefing.scope?.groupId !== undefined) return null;
  const omitted = [];
  const packet = briefing.preAnswerRecall ? { ...briefing.preAnswerRecall } : {
    schema: "agentspine.pre-answer-recall/v1",
    order: "review-before-claims-and-actions",
    authority: "context-only"
  };
  const mustRemember = (preflight.mustRemember || []).map((item) => ({
    id: item.id, claim: item.claim, checksum: item.checksum
  }));
  if (mustRemember.length) addRecallField(packet, "mustRemember", mustRemember, omitted);
  const retrieval = (preflight.retrieval || []).flatMap((provider) =>
    (provider.items || []).map((item) => ({ providerId: provider.providerId,
      id: item.id, revision: item.revision, claim: item.claim, source: item.source,
      validity: item.validity, confidence: item.confidence }))).slice(0, 3);
  if (retrieval.length) addRecallField(packet, "retrieval", retrieval, omitted);
  if (omitted.length && byteSize({ ...packet, omitted }) <= 1020) packet.omitted = omitted;
  return Object.keys(packet).length > 3 ? packet : null;
}

function compactPremortemRegistration(premortem, includeRoot = true) {
  const root = premortem?.registration?.root;
  const requirementId = premortem?.requirementId || premortem?.registration?.requirementId;
  const target = includeRoot && typeof root === "string"
    ? ` with root ${JSON.stringify(root)}` : " for the current project";
  return [
    "Recommended delivery preparation (advisory; does not block coding or replies):",
    `session_briefing, delivery_knowledge_query, then record_delivery_premortem${target}.`,
    `Requirement: ${requirementId || "<unavailable; continue the authorized task>"}.`,
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
  const recall = preAnswerRecallCapsule(detailed);
  if (recall) runtime.preAnswerRecall = recall;
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
    ? runtime.preAnswerRecall
      ? `AgentSpine ready: ${runtime.indexedSources} sources indexed.${warning}`
      : `AgentSpine ready: ${runtime.indexedSources} sources indexed. Load detailed continuity only on demand through session_briefing.${warning}`
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
  const recall = runtime.preAnswerRecall
    ? `\n${JSON.stringify(runtime.preAnswerRecall)}`
    : "";
  const root = runtime.premortem?.registration?.root;
  const instruction = typeof root === "string"
    ? runtime.premortem?.instruction?.replace("registration.root", () => `root ${JSON.stringify(root)}`)
    : runtime.premortem?.instruction;
  const premortem = instruction ? `\n${instruction}` : "";
  const message = `${base}${recall}${details}${premortem}`;
  if (Buffer.byteLength(message) <= BLUN_MESSAGE_MAX_BYTES) return message;
  const compact = `${base}${recall}${BLUN_BOUND_MARKER}\n${compactPremortemRegistration(runtime.premortem)}`;
  if (Buffer.byteLength(compact) <= BLUN_MESSAGE_MAX_BYTES) return compact;
  if (!runtime.preAnswerRecall) {
    return `${base}${BLUN_BOUND_MARKER}\n${compactPremortemRegistration(runtime.premortem, false)}`;
  }
  const recallOnly = `${base}${recall}${BLUN_BOUND_MARKER}`;
  if (Buffer.byteLength(recallOnly) <= BLUN_MESSAGE_MAX_BYTES) return recallOnly;
  return Buffer.byteLength(recall)<=BLUN_MESSAGE_MAX_BYTES+1?recall.slice(1):`${base}\nRecall unavailable.`;
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
  sourceWarning = null, lessonRecall = null) {
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
  if (lessonRecall?.status === "recalled") {
    messages.push(JSON.stringify({
      schema: lessonRecall.schema, receiptDigest: lessonRecall.receiptDigest,
      instruction: lessonRecall.instruction, items: lessonRecall.items,
      learning: lessonRecall.learning || [], learningDiagnostics: lessonRecall.learningDiagnostics || null,
      omitted: lessonRecall.omitted,
      authority: "context-only"
    }));
  }
  if (!messages.length) return {};
  const field = env.BLUN_PLUGIN_ROOT ? "message" : "additionalContext";
  return { hookSpecificOutput: { hookEventName: event, [field]: messages.join("\n") } };
}
