import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareHookPremortem } from "../src/lib/hook-premortem.js";
import { deliveryPremortemPath } from "../src/lib/delivery-premortem.js";
import { sealPremortem, premortemSha256 } from "../src/lib/delivery-premortem-codec.js";
import { fixture, measureReads, processCall } from "./mcp-bounded-fixture.js";
import { PROJECT, SESSION, prompt, register, ITEMS } from "./assignment-continuation-fixture.js";

test("unknown events and tampering are never migrated or authorized by continuation", async t => {
  const f = await fixture(t, { homeRoot: false });
  const first = await prompt(f.root, "prompt:unknown");
  await register(f.root, first.requirementId);
  const path = await deliveryPremortemPath({ root: f.root, binding: first.requirement.binding });
  const original = JSON.parse(await fs.readFile(path, "utf8"));
  for (const variant of ["unknown-event", "unknown-schema", "tampered"]) {
    const state = structuredClone(original);
    if (variant === "unknown-event") {
      state.events.push(sealPremortem({ schema: "agentspine.delivery-premortem-event/v1",
        type: "synthetic-unknown-transition", authority: "context-only",
        at: "2034-01-01T00:00:00.000Z", sequence: ++state.revision,
        payloadDigest: premortemSha256("synthetic-only; not the external event") }));
    } else if (variant === "unknown-schema") state.schema = "agentspine.delivery-premortem/v999";
    delete state.integrityDigest;
    state.integrityDigest = premortemSha256(state);
    if (variant === "tampered") state.integrityDigest = "0".repeat(64);
    await fs.writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    const frozen = await fs.readFile(path);
    const continued = await prompt(f.root, `prompt:${variant}`, { assignment_id: first.assignmentId });
    assert.equal(continued.blocked, true, variant);
    assert.equal(continued.requirement, undefined);
    const mcp = await processCall(f.root, "record_delivery_premortem",
      { root: f.root, requirementId: first.requirementId, items: ITEMS });
    assert.equal(mcp.isError, true, variant);
    const recovery = spawnSync(process.execPath,
      [fileURLToPath(new URL("../bin/agentspine.js", import.meta.url)),
        "premortem-recover", first.requirementId, "--root", f.root, "--json"],
      { encoding: "utf8", env: process.env });
    assert.equal(JSON.parse(recovery.stdout).blocked, true, variant);
    assert.deepEqual(await fs.readFile(path), frozen);
  }
  await f.preserve();
});

test("failed continuation reads preserve state and succeed after restart without repair writes", async t => {
  const f = await fixture(t, { homeRoot: false });
  const first = await prompt(f.root, "prompt:read-failure");
  const path = await deliveryPremortemPath({ root: f.root, binding: first.requirement.binding });
  const frozen = await fs.readFile(path);
  const readFile = fs.readFile;
  fs.readFile = async (target, ...args) => {
    if (String(target) === path) throw Object.assign(new Error("synthetic access denied"), { code: "EACCES" });
    return readFile(target, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await prepareHookPremortem({ root: f.root,
      scope: { host: "codex", projectId: PROJECT },
      input: { session_id: SESSION, event_id: "prompt:uncertain", assignment_id: first.assignmentId } });
    assert.equal(result.status, "degraded");
    assert.equal(result.blocked, false);
    assert.equal(result.requirementId, undefined);
  } finally {
    fs.readFile = readFile;
    syncBuiltinESMExports();
  }
  const entry = fileURLToPath(new URL("../src/lib/hook-premortem.js", import.meta.url));
  const args = { root: f.root, scope: { host: "codex", projectId: PROJECT },
    input: { session_id: SESSION, event_id: "prompt:restart", assignment_id: first.assignmentId } };
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { prepareHookPremortem } from ${JSON.stringify(pathToFileURL(entry).href)};
     const result = await prepareHookPremortem(JSON.parse(process.argv[1]));
     process.stdout.write(JSON.stringify(result));`, JSON.stringify(args)],
  { encoding: "utf8", env: process.env, timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).requirementId, first.requirementId);
  assert.deepEqual(await fs.readFile(path), frozen);
  await f.preserve();
});

test("a crash inside continuation leaves the same requirement and recovers after the lock lease", async t => {
  const f = await fixture(t, { homeRoot: false });
  const first = await prompt(f.root, "prompt:crash");
  const path = await deliveryPremortemPath({ root: f.root, binding: first.requirement.binding });
  const frozen = await fs.readFile(path);
  const entry = new URL("../src/lib/hook-premortem.js", import.meta.url).href;
  const args = { root: f.root, scope: { host: "codex", projectId: PROJECT },
    input: { session_id: SESSION, event_id: "prompt:crashed", assignment_id: first.assignmentId } };
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import fs from 'node:fs/promises';
     import { syncBuiltinESMExports } from 'node:module';
     const read = fs.readFile;
     fs.readFile = async (path, ...args) => {
       if (String(path) === process.argv[2]) process.exit(73);
       return read(path, ...args);
     };
     syncBuiltinESMExports();
     const { prepareHookPremortem } = await import(${JSON.stringify(entry)});
     await prepareHookPremortem(JSON.parse(process.argv[1]));`, JSON.stringify(args), path],
  { encoding: "utf8", env: process.env, timeout: 5000 });
  assert.equal(child.status, 73, child.stderr);
  assert.deepEqual(await fs.readFile(path), frozen);
  // Real lease expiry: do not edit lock timestamps, state or receipts to simulate recovery.
  await new Promise(resolve => setTimeout(resolve, 15100));
  const recovered = await prepareHookPremortem(args);
  assert.equal(recovered.requirementId, first.requirementId);
  assert.equal(recovered.blocked, false);
  assert.deepEqual(await fs.readFile(path), frozen);
  await f.preserve();
});

test("continuation performs no tree traversal and stays within the measured preparation budget", async t => {
  const f = await fixture(t, { homeRoot: false });
  const scope = { host: "codex", projectId: PROJECT };
  const prepare = input => prepareHookPremortem({ root: f.root, scope, input });
  const fresh = [];
  const resumed = [];
  for (let i = 0; i < 9; i++) {
    const start = await measureReads(() => prepare({ session_id: SESSION, event_id: `prompt:perf:${i}` }));
    const next = await measureReads(() => prepare({ session_id: SESSION,
      event_id: `prompt:perf:resume:${i}`, assignment_id: start.result.assignmentId }));
    assert.equal(next.result.requirementId, start.result.requirementId);
    assert.equal(next.accesses.filter(x => x.operation === "readdir" || x.operation === "opendir").length, 0);
    assert.ok(next.accesses.length <= 12, `bounded state reads: ${next.accesses.length}`);
    fresh.push(start.elapsed);
    resumed.push(next.elapsed);
  }
  const median = values => [...values].sort((a, b) => a - b)[4];
  t.diagnostic(JSON.stringify({ samples: 9, preparationMedianMs: median(fresh),
    continuationMedianMs: median(resumed), continuationTreeTraversals: 0 }));
  assert.ok(median(resumed) <= median(fresh) + 25, "continuation must not materially regress preparation");
  await f.preserve();
});
