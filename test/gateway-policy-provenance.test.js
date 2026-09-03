import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadGatewayRuntime } from "../src/lib/gateway-runtime.js";
import { GOAL_PREMORTEM_CONTRACT, planDefinitionMaterial } from "../src/lib/gateway-premortem.js";
import { assignPremortemPlan as assignPlan,
  premortemGoalFixture as fixture } from "./goal-premortem-fixture.js";
import { markLegacyGatewayPolicy } from "./legacy-goal-fixture.js";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

async function writeProvenance(policyPath, root, state, previousPolicyDigest, nextPolicyDigest) {
  const material = { schema: "agentspine.gateway-policy-provenance/v1",
    projectRootDigest: digest(root), policySchema: "agentspine.gateway-policy/v2",
    contract: GOAL_PREMORTEM_CONTRACT, state, previousPolicyDigest, nextPolicyDigest,
    authority: "context-only-contract-provenance" };
  const value = { ...material, digest: digest(material) };
  await writeFile(join(dirname(policyPath), "gateway-policy-provenance.json"),
    `${JSON.stringify(value, null, 2)}\n`);
}

test("prepared provenance recovers either side of the policy replace", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadGatewayRuntime(root);
  const bytes = await readFile(loaded.gatewayPolicyPath, "utf8");
  await writeProvenance(loaded.gatewayPolicyPath, root, "prepared", digest(bytes), "a".repeat(64));
  assert.equal((await loadGatewayRuntime(root)).policy.schema, "agentspine.gateway-policy/v2");
  const recovered = JSON.parse(await readFile(join(dirname(loaded.gatewayPolicyPath),
    "gateway-policy-provenance.json"), "utf8"));
  assert.equal(recovered.state, "committed");
  assert.equal(recovered.nextPolicyDigest, digest(bytes));
  await writeProvenance(loaded.gatewayPolicyPath, root, "prepared", "b".repeat(64), digest(bytes));
  assert.equal((await loadGatewayRuntime(root)).policy.schema, "agentspine.gateway-policy/v2");
});

test("prepared provenance migrates an exact markerless v1 predecessor", async (t) => {
  const { root, agentId } = await fixture(t);
  await assignPlan(root, agentId, "goal:provenance-legacy");
  const loaded = await loadGatewayRuntime(root);
  const policy = structuredClone(loaded.policy);
  markLegacyGatewayPolicy(policy);
  policy.goals[0].plan.definitionsDigest = createHash("sha256")
    .update(JSON.stringify(planDefinitionMaterial(policy.goals[0].plan.steps))).digest("hex");
  const bytes = `${JSON.stringify(policy, null, 2)}\n`;
  await writeFile(loaded.gatewayPolicyPath, bytes);
  await writeProvenance(loaded.gatewayPolicyPath, root, "prepared", digest(bytes), "c".repeat(64));
  const migrated = await loadGatewayRuntime(root);
  assert.equal(migrated.policy.schema, "agentspine.gateway-policy/v2");
  assert.equal(migrated.policy.premortemContractRegistry.entries[0].contractVersion, 0);
  assert.equal((await loadGatewayRuntime(root)).policy.schema, "agentspine.gateway-policy/v2");
  const persisted = JSON.parse(await readFile(loaded.gatewayPolicyPath, "utf8"));
  assert.equal(persisted.schema, "agentspine.gateway-policy/v2");
});

test("committed provenance rejects replay of the previous valid v2 policy", async (t) => {
  const { root, agentId } = await fixture(t);
  const before = await loadGatewayRuntime(root);
  const previousBytes = await readFile(before.gatewayPolicyPath, "utf8");
  await assignPlan(root, agentId, "goal:premortem-policy-replay");
  await writeFile(before.gatewayPolicyPath, previousBytes);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});

test("committed provenance makes deletion of its policy fail closed", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadGatewayRuntime(root);
  await unlink(loaded.gatewayPolicyPath);
  await assert.rejects(loadGatewayRuntime(root), /policy is missing while provenance exists/i);
});

test("prepared provenance commits the observed next policy and rejects predecessor replay", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadGatewayRuntime(root);
  const previousBytes = await readFile(loaded.gatewayPolicyPath, "utf8");
  const next = structuredClone(loaded.policy);
  next.killSwitch = true;
  next.revision += 1;
  next.history.push({ kind: "control", at: "2032-02-01T00:00:00.200Z",
    value: { enabled: true, killSwitch: false }, authority: "authenticated-goal-policy" });
  const nextBytes = `${JSON.stringify(next, null, 2)}\n`;
  await writeProvenance(loaded.gatewayPolicyPath, root, "prepared", digest(previousBytes), digest(nextBytes));
  await writeFile(loaded.gatewayPolicyPath, nextBytes);

  assert.equal((await loadGatewayRuntime(root)).policy.killSwitch, true);
  const provenance = JSON.parse(await readFile(join(dirname(loaded.gatewayPolicyPath),
    "gateway-policy-provenance.json"), "utf8"));
  assert.equal(provenance.state, "committed");
  assert.equal(provenance.nextPolicyDigest, digest(nextBytes));

  await writeFile(loaded.gatewayPolicyPath, previousBytes);
  await assert.rejects(loadGatewayRuntime(root), /gateway policy/i);
});
