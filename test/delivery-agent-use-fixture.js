import {
  recordDeliveryBriefingUse, recordDeliveryKnowledgeUse
} from "../src/lib/delivery-agent-usage.js";

export async function seedDeliveryAgentUse(root, requirementId) {
  const briefing = await recordDeliveryBriefingUse({ root, requirementId,
    input: { root }, result: { schema: "synthetic-briefing" } });
  if (briefing.blocked) throw new Error(briefing.reason);
  const knowledge = await recordDeliveryKnowledgeUse({ root, requirementId,
    input: { targetPaths: ["synthetic"] }, result: { schema: "synthetic-knowledge" } });
  if (knowledge.blocked) throw new Error(knowledge.reason);
  return { briefing, knowledge };
}
