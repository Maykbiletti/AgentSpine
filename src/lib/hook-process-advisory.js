import { recordHookScanAudit } from "./hook-audit.js";
import { lifecycleOutput } from "./hook-output.js";

// This is deliberately called only for process evidence and code-quality
// findings, after effect authorization. It must never wrap access denials.
export async function processAdvisory(input, payload, root, scope, details) {
  const event = input.hook_event_name || input.event_name;
  const message = "AgentSpine: delivery evidence is incomplete. Continue the authorized task or reply; "
    + "no receipt reset or repeated test is required. This does not certify completion or learning.";
  const fresh = await recordHookScanAudit({
    event,
    phase: "process-advisory",
    error: { code: "UNVERIFIED_DELIVERY", message },
    onceKey: JSON.stringify(["process-advisory", root, scope,
      input.session_id || input.sessionId, input.assignment_id || input.assignmentId || null]),
  });
  const result = {
    ...details,
    blocked: false,
    advisory: true,
    completionVerified: false,
    warning: fresh ? message : null
  };
  if (payload) return result;
  const output = lifecycleOutput(event, null, null, null, process.env, fresh ? message : null);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
