import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAudit } from "../src/lib/audit.js";
import { inspectPremortemWriteIndexAudit } from "../src/lib/audit-premortem.js";
import {
  deliveryPremortemPath,
  inspectDeliveryPremortems,
  preparePremortemRequirement,
  recordDeliveryPremortem,
  recordPremortemWrite
} from "../src/lib/delivery-premortem.js";
import { deliveryPremortemWriteNodePath } from
  "../src/lib/delivery-premortem-write-ledger.js";

const ITEMS = [
  { category: "baseline-environment",
    failure: "this delivery fails because the synthetic baseline moved",
    check: "Compare the exact synthetic baseline digest." },
  { category: "contract-tests",
    failure: "this delivery fails because the synthetic contract regressed",
    check: "Run the exact synthetic contract test." },
  { category: "delivery-path",
    failure: "this delivery fails because the synthetic artifact moved",
    check: "Verify the exact synthetic delivery path." }
];

async function fixture(t, suffix) {
  const root = await mkdtemp(join(tmpdir(), `agentspine-write-audit-${suffix}-`));
  const stateRoot = await mkdtemp(join(tmpdir(), `agentspine-write-audit-state-${suffix}-`));
  const previous = process.env.AGENTSPINE_STATE_DIR;
  process.env.AGENTSPINE_STATE_DIR = stateRoot;
  const source = "# Synthetic write-audit rules\n\nRemain byte-exact.\n";
  await writeFile(join(root, "AGENTS.md"), source, "utf8");
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSPINE_STATE_DIR;
    else process.env.AGENTSPINE_STATE_DIR = previous;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRoot, { recursive: true, force: true })
    ]);
  });
  const binding = { host: "codex", sessionId: `session:write-audit-${suffix}`,
    projectId: "project:write-audit", entityId: "agent:write-audit" };
  const requirement = await preparePremortemRequirement({ root, binding });
  const recorded = await recordDeliveryPremortem({ root,
    requirementId: requirement.requirementId, items: ITEMS });
  assert.equal(recorded.status, "recorded");
  return { root, binding, source };
}

async function recordWrites(root, binding, count) {
  for (let index = 0; index < count; index += 1) {
    const result = await recordPremortemWrite({ root, binding, phase: "intent",
      input: { tool_use_id: `write:audit-${index}`,
        tool_input: { file_path: "synthetic.js", content: `version ${index}` } } });
    assert.equal(result.status, "write-recorded");
  }
}

test("audit proves first, last, and recent writes while ignoring an unrelated orphan", async (t) => {
  const { root, binding, source } = await fixture(t, "healthy");
  await recordWrites(root, binding, 3);
  const statePath = await deliveryPremortemPath({ root, binding });
  const [state] = (await inspectDeliveryPremortems(root)).states;
  const orphanPath = deliveryPremortemWriteNodePath(
    statePath, state.laneDigest, "f".repeat(64));
  await writeFile(orphanPath, "{not-json\n", "utf8");

  const result = await runAudit(root);
  assert.equal(result.ok, true);
  assert.equal(result.gates.find((gate) => gate.id === 3).ok, true);
  assert.equal(result.gates.find((gate) => gate.id === 8).ok, true);
  assert.equal(result.premortemDiagnostics.writeIndex.states, 1);
  assert.equal(result.premortemDiagnostics.writeIndex.attemptedProofs, 3);
  assert.equal(result.premortemDiagnostics.writeIndex.verifiedProofs, 3);
  assert.deepEqual(result.premortemDiagnostics.writeIndex.errors, []);
  assert.deepEqual(result.premortemDiagnostics.writeIndex.uncertainties, []);
  assert.equal(result.premortemDiagnostics.writeIndex.paths.includes(orphanPath), false);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("malformed reachable write-index JSON is audited but fails open", async (t) => {
  const { root, binding, source } = await fixture(t, "parser");
  await recordWrites(root, binding, 1);
  const statePath = await deliveryPremortemPath({ root, binding });
  const [state] = (await inspectDeliveryPremortems(root)).states;
  const rootPath = deliveryPremortemWriteNodePath(
    statePath, state.laneDigest, state.writeIndexRoot);
  await writeFile(rootPath, "{not-json\n", "utf8");

  const result = await runAudit(root);
  assert.equal(result.ok, true);
  assert.equal(result.gates.find((gate) => gate.id === 8).ok, true);
  assert.deepEqual(result.premortemDiagnostics.writeIndex.errors, []);
  assert.equal(result.premortemDiagnostics.writeIndex.uncertainties.some((item) =>
    /not valid JSON/.test(item.reason) && item.path === rootPath), true);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});

test("EACCES while reading the write index is uncertainty, never an integrity finding", async () => {
  const laneDigest = "a".repeat(64);
  const write = { idDigest: "b".repeat(64), inputDigest: "c".repeat(64),
    inputKnown: true, digest: "d".repeat(64) };
  const denied = Object.assign(new Error("permission denied"), {
    code: "EACCES", path: "/synthetic/state/denied.json"
  });
  const result = await inspectPremortemWriteIndexAudit({ directory: "/synthetic/state",
    paths: [`/synthetic/state/${laneDigest}.json`], states: [{ laneDigest,
      writeIndexRoot: "e".repeat(64), firstWrite: write, lastWrite: write,
      writeLedger: [] }] }, {
    inspectIndexes: async () => ({ directory: "/synthetic/state/index", paths: [], nodes: [],
      errors: [{ path: denied.path, reason: denied.message, code: denied.code }], truncations: [] }),
    inspectProof: async () => { throw denied; }
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.uncertainties.length, 1);
  assert.equal(result.uncertainties[0].code, "EACCES");
  assert.equal(result.attemptedProofs, 1);
  assert.equal(result.verifiedProofs, 0);
});

test("bounded traversal truncation stays diagnostic when bounded write proofs succeed", async () => {
  const laneDigest = "1".repeat(64);
  const expected = { idDigest: "2".repeat(64), inputDigest: "3".repeat(64),
    inputKnown: false, digest: "4".repeat(64) };
  const statePath = `/synthetic/state/${laneDigest}.json`;
  const result = await inspectPremortemWriteIndexAudit({ directory: "/synthetic/state",
    paths: [statePath], states: [{ laneDigest, writeIndexRoot: "5".repeat(64),
      firstWrite: expected, lastWrite: expected, writeLedger: [] }] }, {
    inspectIndexes: async () => ({ directory: "/synthetic/state/index", paths: [], nodes: [],
      errors: [], truncations: [{ path: "/synthetic/state/index",
        reason: "limited to 512 reachable write-index nodes" }] }),
    inspectProof: async () => ({ paths: ["/synthetic/state/index/proof.json"], entry: {
      idDigest: expected.idDigest, inputDigest: expected.inputDigest,
      inputKnown: expected.inputKnown, writeDigest: expected.digest
    } })
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.uncertainties, []);
  assert.equal(result.truncations.length, 1);
  assert.equal(result.verifiedProofs, 1);
});
