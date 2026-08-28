import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningIdentity, trustSigner } from "../src/lib/authentication.js";
import {
  exportHttpsSnapshot, fetchHttpsSnapshot, importHttpsSnapshot, pullHttpsSnapshot,
  resolveHttpsEndpoint, validateHttpsEndpoint, validateHttpsSnapshot
} from "../src/lib/https-transport.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import {
  initDirectoryAdapter, loadSharing, publishLearning, reviewShared, sharedContext, sharedInbox
} from "../src/lib/sharing.js";

async function fixture(t) {
  const rootA = await mkdtemp(join(tmpdir(), "agentspine-https-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "agentspine-https-b-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-https-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-https-adapter-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    await rm(rootA, { recursive: true }); await rm(rootB, { recursive: true });
    await rm(state, { recursive: true }); await rm(adapter, { recursive: true });
  });
  await writeFile(join(rootA, "AGENTS.md"), "# HTTPS publisher\n\nRemain byte exact.\n", "utf8");
  await writeFile(join(rootB, "CLAUDE.md"), "# HTTPS receiver\n\nRemain byte exact.\n", "utf8");
  const publicOut = join(state, "publisher.json");
  await generateSigningIdentity({
    root: rootA, signerId: "signer:https", publicOut,
    confirmation: "local-share-confirmed"
  });
  await trustSigner({ root: rootB, publicIdentityPath: publicOut, confirmation: "local-share-confirmed" });
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:https", adapterId: "adapter:https",
    signerId: "signer:https", confirmation: "local-share-confirmed"
  });
  await proposeLearning({
    root: rootA, id: "learning:https", kind: "project-fact",
    claim: "The synthetic HTTPS snapshot uses signed immutable events.", privacy: "shared",
    evidence: { id: "evidence:https", type: "test", summary: "Synthetic HTTPS evidence.", confidence: 1 }
  });
  await reviewLearning({
    root: rootA, id: "learning:https", decision: "accept",
    reason: "Synthetic local confirmation.", confirmedByUser: true
  });
  await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:https", eventId: "shared:https",
    signerId: "signer:https", confirmation: "local-share-confirmed"
  });
  const output = join(state, `snapshot-${Date.now()}-${Math.random()}.json`);
  await exportHttpsSnapshot({
    root: rootA, directory: adapter, output, snapshotId: "snapshot:https",
    confirmation: "local-share-confirmed"
  });
  const snapshot = JSON.parse(await readFile(output, "utf8"));
  return { rootA, rootB, state, adapter, output, snapshot };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function redigest(snapshot) {
  const { digest: _digest, ...body } = snapshot;
  return createHash("sha256").update(canonical(body)).digest("hex");
}

function fakeRequest({ body, status = 200, headers = { "content-type": "application/json" } }, capture = () => {}) {
  return (options, callback) => {
    capture(options);
    const active = new EventEmitter();
    active.setTimeout = () => active;
    active.destroy = (error) => active.emit("error", error);
    active.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = headers;
      callback(response);
      response.end(body);
    });
    return active;
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function runCli(args, state) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("signed HTTPS snapshot stays quarantined until a second local review and preserves sources", async (t) => {
  const { rootA, rootB, output, snapshot } = await fixture(t);
  const beforeA = hash(await readFile(join(rootA, "AGENTS.md")));
  const beforeB = hash(await readFile(join(rootB, "CLAUDE.md")));
  const imported = await importHttpsSnapshot({ root: rootB, snapshot });
  assert.deepEqual(imported.imported, ["shared:https"]);
  assert.equal(imported.transport, "https-snapshot");
  assert.equal((await sharedContext({ root: rootB })).items.length, 0);
  assert.equal((await sharedInbox({ root: rootB })).items[0].authentication.signerId, "signer:https");
  await reviewShared({
    root: rootB, id: "shared:https", decision: "accept",
    reason: "Confirmed after HTTPS transport.", confirmedByUser: true
  });
  assert.equal((await sharedContext({ root: rootB })).items[0].claim, "The synthetic HTTPS snapshot uses signed immutable events.");
  assert.equal(hash(await readFile(join(rootA, "AGENTS.md"))), beforeA);
  assert.equal(hash(await readFile(join(rootB, "CLAUDE.md"))), beforeB);
  if (process.platform !== "win32") assert.equal((await lstat(output)).mode & 0o077, 0);
});

test("snapshot and nested signature tampering fail before quarantine writes", async (t) => {
  const { rootB, snapshot } = await fixture(t);
  const damaged = structuredClone(snapshot);
  damaged.generatedAt = "2030-01-01T00:00:00.000Z";
  await assert.rejects(importHttpsSnapshot({ root: rootB, snapshot: damaged }), /integrity check/);
  const forged = structuredClone(snapshot);
  forged.events[0].payload.claim = "A forged remote claim.";
  forged.digest = redigest(forged);
  await assert.rejects(importHttpsSnapshot({ root: rootB, snapshot: forged }), /signature is invalid/);
  assert.equal((await loadSharing(rootB)).sharing.records.length, 0);
});

test("snapshot schema rejects unsigned, duplicate, oversized, and metadata-mismatched content", async (t) => {
  const { snapshot } = await fixture(t);
  const unsigned = structuredClone(snapshot);
  unsigned.events[0] = unsigned.events[0].payload;
  unsigned.digest = redigest(unsigned);
  assert.throws(() => validateHttpsSnapshot(unsigned), /signed envelope/);
  const duplicate = structuredClone(snapshot);
  duplicate.events.push(structuredClone(duplicate.events[0]));
  duplicate.digest = redigest(duplicate);
  assert.throws(() => validateHttpsSnapshot(duplicate), /duplicate event/);
  const mismatch = structuredClone(snapshot);
  mismatch.adapterId = "adapter:other";
  mismatch.digest = redigest(mismatch);
  assert.throws(() => validateHttpsSnapshot(mismatch), /does not match/);
});

test("untrusted snapshot signers fail before any local sharing mutation", async (t) => {
  const { rootB, snapshot, state } = await fixture(t);
  const isolatedState = await mkdtemp(join(tmpdir(), "agentspine-https-untrusted-"));
  t.after(() => rm(isolatedState, { recursive: true }));
  process.env.AGENTSPINE_STATE_DIR = isolatedState;
  await assert.rejects(importHttpsSnapshot({ root: rootB, snapshot }), /untrusted or revoked signing key/);
  assert.equal((await loadSharing(rootB)).sharing.records.length, 0);
  process.env.AGENTSPINE_STATE_DIR = state;
});

test("HTTPS endpoint validation rejects downgrade, embedded credentials, ambiguity, and redirects", async (t) => {
  assert.throws(() => validateHttpsEndpoint("http://example.com/snapshot.json"), /https:\/\//);
  assert.throws(() => validateHttpsEndpoint("https://user:pass@example.com/snapshot.json"), /embedded/);
  assert.throws(() => validateHttpsEndpoint("https://example.com/snapshot.json?token=x"), /query or fragment/);
  assert.throws(() => validateHttpsEndpoint("https://example.com/snapshots/"), /explicit JSON resource/);
  await assert.rejects(fetchHttpsSnapshot({
    url: "https://example.com/snapshot.json", lookup: publicLookup,
    request: fakeRequest({ body: "", status: 302, headers: { location: "https://other.example/x" } })
  }), /redirects are not followed/);
});

test("DNS pinning rejects private, reserved, documentation, and mixed public answers", async () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "169.254.169.254", "192.0.2.10",
    "::1", "1::1", "fc00::1", "2001::1", "2001:db8::1", "2002:7f00::1", "3fff::1"
  ]) {
    const family = address.includes(":") ? 6 : 4;
    await assert.rejects(resolveHttpsEndpoint("https://example.com/snapshot.json", {
      lookup: async () => [{ address, family }]
    }), /private, local, reserved, or documentation/);
  }
  await assert.rejects(resolveHttpsEndpoint("https://example.com/snapshot.json", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]
  }), /private, local, reserved, or documentation/);
  await assert.rejects(resolveHttpsEndpoint("https://[::1]/snapshot.json"), /private, local, reserved, or documentation/);
});

test("private-network access needs explicit confirmation even when deliberately enabled", async (t) => {
  const { snapshot } = await fixture(t);
  const options = {
    url: "https://internal.example/snapshot.json",
    allowPrivateNetwork: true,
    lookup: async () => [{ address: "10.0.0.8", family: 4 }],
    request: fakeRequest({ body: JSON.stringify(snapshot) })
  };
  await assert.rejects(fetchHttpsSnapshot(options), /explicit local owner confirmation/);
  const fetched = await fetchHttpsSnapshot({ ...options, confirmation: "local-share-confirmed" });
  assert.equal(fetched.snapshot.snapshotId, "snapshot:https");
});

test("bearer tokens come only from a named environment variable and never enter results", async (t) => {
  const { rootB, snapshot } = await fixture(t);
  let requestOptions;
  const result = await pullHttpsSnapshot({
    root: rootB, url: "https://example.com/snapshot.json", tokenEnv: "AGENTSPINE_TEST_TOKEN",
    environment: { AGENTSPINE_TEST_TOKEN: "synthetic-secret-token-value" }, lookup: publicLookup,
    request: fakeRequest({ body: JSON.stringify(snapshot) }, (value) => { requestOptions = value; })
  });
  assert.equal(requestOptions.headers.authorization, "Bearer synthetic-secret-token-value");
  assert.equal(result.authenticatedRequest, true);
  assert.equal(JSON.stringify(result).includes("synthetic-secret-token-value"), false);
  await assert.rejects(fetchHttpsSnapshot({
    url: "https://example.com/snapshot.json", tokenEnv: "lowercase", environment: {}, lookup: publicLookup,
    request: fakeRequest({ body: JSON.stringify(snapshot) })
  }), /uppercase environment variable/);
});

test("HTTPS client enforces status, media type, compression, timeout range, and declared size", async (t) => {
  const { snapshot } = await fixture(t);
  const base = { url: "https://example.com/snapshot.json", lookup: publicLookup };
  await assert.rejects(fetchHttpsSnapshot({ ...base, request: fakeRequest({ body: "no", status: 401 }) }), /status 401/);
  await assert.rejects(fetchHttpsSnapshot({
    ...base, request: fakeRequest({ body: JSON.stringify(snapshot), headers: { "content-type": "text/plain" } })
  }), /application\/json/);
  await assert.rejects(fetchHttpsSnapshot({
    ...base, request: fakeRequest({
      body: JSON.stringify(snapshot), headers: { "content-type": "application/json", "content-encoding": "gzip" }
    })
  }), /compressed/);
  await assert.rejects(fetchHttpsSnapshot({ ...base, timeoutMs: 50 }), /between 1000 and 30000/);
  await assert.rejects(fetchHttpsSnapshot({
    ...base, request: fakeRequest({
      body: "", headers: { "content-type": "application/json", "content-length": String(22 * 1024 * 1024) }
    })
  }), /21 MiB/);
});

test("CLI exports a strict signed snapshot outside the project without altering source Markdown", async (t) => {
  const { rootA, state, adapter } = await fixture(t);
  const before = hash(await readFile(join(rootA, "AGENTS.md")));
  const output = join(state, "cli-snapshot.json");
  const result = runCli([
    "share-snapshot-export", adapter, "--root", rootA, "--out", output,
    "--id", "snapshot:cli", "--confirm-local-share", "--json"
  ], state);
  assert.equal(result.snapshotId, "snapshot:cli");
  assert.equal(result.events, 1);
  assert.equal(validateHttpsSnapshot(JSON.parse(await readFile(output, "utf8"))).snapshotId, "snapshot:cli");
  assert.equal(hash(await readFile(join(rootA, "AGENTS.md"))), before);
  const insideDirectory = join(rootA, "must-not-be-created");
  const inside = join(insideDirectory, "nested", "snapshot.json");
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const rejected = spawnSync(process.execPath, [cli,
    "share-snapshot-export", adapter, "--root", rootA, "--out", inside,
    "--confirm-local-share", "--json"
  ], { encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state } });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /outside the scanned project/);
  await assert.rejects(lstat(insideDirectory), { code: "ENOENT" });

  const aliasParent = await mkdtemp(join(tmpdir(), "agentspine-https-alias-"));
  t.after(() => rm(aliasParent, { recursive: true }));
  const rootAlias = join(aliasParent, "project-alias");
  await symlink(rootA, rootAlias, process.platform === "win32" ? "junction" : "dir");
  const aliasedInside = join(rootAlias, "alias-must-not-be-created", "snapshot.json");
  const aliasRejected = spawnSync(process.execPath, [cli,
    "share-snapshot-export", adapter, "--root", rootAlias, "--out", aliasedInside,
    "--confirm-local-share", "--json"
  ], { encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state } });
  assert.notEqual(aliasRejected.status, 0);
  assert.match(aliasRejected.stderr, /outside the scanned project/);
  await assert.rejects(lstat(join(rootA, "alias-must-not-be-created")), { code: "ENOENT" });
});
