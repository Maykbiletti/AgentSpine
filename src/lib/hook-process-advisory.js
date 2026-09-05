import { recordHookScanAudit } from "./hook-audit.js";

// This is deliberately called only for process evidence and code-quality
// findings, after effect authorization. It must never wrap access denials.
export async function processAdvisory(input, payload, root, scope, details) {
  const event = input.hook_event_name || input.event_name;
  const status = details.premortem?.status || details.deliveryVerification?.status || details.artifactGuard?.status;
  const diagnostic = {
    schema: "agentspine.process-advisory/v1", presentation: "internal-only",
    status: /^[a-z-]{1,64}$/.test(status || "") ? status : "unavailable",
    completionVerified: false, action: "continue-authorized-task", automaticRetry: false,
    authority: "context-only",
    instruction: "Do not quote this diagnostic. Continue working or answer normally. "
      + "Mention only relevant evidence-backed limitations in the user's language; never invent a risk or a passed test. "
      + "Ask only for a consequential user decision. Do not reset receipts or repeat work to satisfy process bookkeeping."
  };
  const fresh = await recordHookScanAudit({
    event,
    phase: "process-advisory",
    error: { code: "UNVERIFIED_DELIVERY", message: JSON.stringify(diagnostic) },
    onceKey: JSON.stringify(["process-advisory", root, scope,
      input.session_id || input.sessionId, input.assignment_id || input.assignmentId || null]),
  });
  const result = {
    ...details,
    blocked: false,
    advisory: true,
    completionVerified: false,
    diagnostic: fresh ? diagnostic : null
  };
  if (payload) return result;
  const field = process.env.BLUN_PLUGIN_ROOT ? "message" : "additionalContext";
  const output = fresh ? { hookSpecificOutput: {
    hookEventName: event, [field]: JSON.stringify(diagnostic)
  } } : {};
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
