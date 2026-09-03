import { runHook } from "../src/hook.js";
import { recordDeliveryPremortem } from "../src/lib/delivery-premortem.js";

const ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the frozen synthetic baseline." },
  { category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regressed",
    check: "Run the focused synthetic test." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact is missing",
    check: "Hash the synthetic delivered artifact." }
];

export async function registeredWriteContext({ root, sessionId, projectId, extra = {} }) {
  const context = {
    host: "codex", cwd: root, session_id: sessionId,
    agent_spine_scope: { project_id: projectId }, ...extra
  };
  const prompted = await runHook({
    ...context, hook_event_name: "UserPromptSubmit", event_id: `prompt:${sessionId}`,
    prompt: "Prepare the synthetic guard write."
  });
  if (prompted.blocked) throw new Error(prompted.reason || "synthetic premortem prompt was blocked");
  const recorded = await recordDeliveryPremortem({
    root, requirementId: prompted.preflight.premortem.requirementId, items: ITEMS
  });
  if (recorded.blocked) throw new Error(recorded.reason || "synthetic premortem registration was blocked");
  return context;
}
