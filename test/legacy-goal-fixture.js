import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadGatewayRuntime } from "../src/lib/gateway-runtime.js";
import { planDefinitionMaterial } from "../src/lib/gateway-premortem.js";

export function markLegacyGatewayPolicy(policy) {
  for (const goal of policy.goals.filter((item) => item.plan)) {
    delete goal.plan.premortemContractVersion;
    delete goal.plan.premortemContract;
    for (const step of goal.plan.steps) delete step.premortemContractVersion;
  }
  delete policy.premortemContractRegistry;
  policy.schema = "agentspine.gateway-policy/v1";
}

export async function writeLegacyGatewayPolicy(path, policy) {
  markLegacyGatewayPolicy(policy);
  await unlink(join(dirname(path), "gateway-policy-provenance.json"))
    .catch((error) => { if (error.code !== "ENOENT") throw error; });
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`);
}

// Explicit upgrade fixtures predate 0.66; this is not exposed as a production opt-out.
export async function persistLegacyGoalPolicy(root, goalId) {
  const loaded = await loadGatewayRuntime(root);
  const goal = loaded.policy.goals.find((item) => item.goalId === goalId);
  markLegacyGatewayPolicy(loaded.policy);
  goal.plan.definitionsDigest = createHash("sha256")
    .update(JSON.stringify(planDefinitionMaterial(goal.plan.steps))).digest("hex");
  await writeLegacyGatewayPolicy(loaded.gatewayPolicyPath, loaded.policy);
  return loadGatewayRuntime(root);
}
