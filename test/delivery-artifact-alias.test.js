import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { verifyDeliveredArtifacts } from "../src/lib/hook-artifact-guards.js";
import { hookScanAuditPath } from "../src/lib/hook-audit.js";

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-delivery-alias-"));
  const root = join(workspace, "project");
  const exchange = join(workspace, "exchange");
  const state = join(workspace, "state");
  await Promise.all([mkdir(join(root, ".git"), { recursive: true }), mkdir(exchange), mkdir(state)]);
  await writeFile(join(root, "AGENTS.md"), "# Synthetic delivery rules\n");
  const prior = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    if (prior === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = prior;
    await rm(workspace, { recursive: true, force: true });
  });
  return { root, exchange, state };
}

const claim = `Delivered \`missing.zip\` sha256 ${"a".repeat(16)}`;
const noClaim = "Synthetic read-only answer with no delivered artifact.";

test("direct delivery verification degrades on conflicting or malformed aliases", async (t) => {
  const { root, exchange, state } = await fixture(t);
  const common = { hook_event_name: "Stop", agent_spine_exchange_directory: exchange };
  for (const aliases of [
    { final_assistant_message: claim, response: noClaim },
    { final_assistant_message: noClaim, response: claim },
    { final_assistant_message: claim, response: { text: claim } }
  ]) {
    const result = await verifyDeliveredArtifacts({ input: { ...common, ...aliases }, cwd: root });
    assert.equal(result.status, "degraded");
    assert.equal(result.blocked, false);
    assert.deepEqual(result.mismatches, []);
  }
  const records = (await readFile(hookScanAuditPath({
    ...process.env, AGENTSPINE_STATE_DIR: state
  }), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.filter((record) => record.phase === "delivery-artifact-guard"
    && record.decision === "allow").length, 3);
});

test("identical delivery aliases retain verified mismatch blocking", async (t) => {
  const { root, exchange } = await fixture(t);
  const result = await verifyDeliveredArtifacts({ cwd: root, input: {
    hook_event_name: "Stop", agent_spine_exchange_directory: exchange,
    final_assistant_message: claim, response: claim
  } });
  assert.equal(result.status, "mismatch");
  assert.equal(result.blocked, true);
  assert.match(result.reason, /missing\.zip.*actual missing/s);
});

test("end-to-end Stop fails open in both conflicting alias orders", async (t) => {
  const { root, exchange, state } = await fixture(t);
  for (const [index, aliases] of [
    { final_assistant_message: claim, response: noClaim },
    { final_assistant_message: noClaim, response: claim }
  ].entries()) {
    const result = await runHook({
      hook_event_name: "Stop", host: "codex", cwd: root,
      session_id: `session:delivery-alias-${index}`,
      agent_spine_exchange_directory: exchange, ...aliases
    });
    assert.equal(result.blocked, false);
    assert.equal(result.artifactGuard.status, "degraded");
    assert.equal(result.premortem.status, "degraded");
  }
  const records = (await readFile(hookScanAuditPath({
    ...process.env, AGENTSPINE_STATE_DIR: state
  }), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.filter((record) => record.phase === "delivery-artifact-guard").length >= 2, true);
  assert.equal(records.filter((record) => record.phase === "premortem-stop").length >= 2, true);
});
