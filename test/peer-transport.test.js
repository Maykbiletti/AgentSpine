import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  generateSigningIdentity, revokeTrustedSigner, signEnvelope, trustSigner
} from "../src/lib/authentication.js";
import {
  buildPeerResponse, createPeerRequest, importPeerResponse,
  pullPeerCommand, servePeerOnce, validatePeerRequest, validatePeerResponse
} from "../src/lib/peer-transport.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import {
  initDirectoryAdapter, publishLearning, sharedContext, sharedInbox
} from "../src/lib/sharing.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const publisher = await mkdtemp(join(tmpdir(), "agentspine-peer-publisher-"));
  const receiver = await mkdtemp(join(tmpdir(), "agentspine-peer-receiver-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-peer-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-peer-adapter-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    await rm(publisher, { recursive: true }); await rm(receiver, { recursive: true });
    await rm(state, { recursive: true }); await rm(adapter, { recursive: true });
  });
  await writeFile(join(publisher, "AGENTS.md"), "# Peer publisher\n\nPreserve exactly.\n", "utf8");
  await writeFile(join(receiver, "CLAUDE.md"), "# Peer receiver\n\nPreserve exactly.\n", "utf8");
  const publicOut = join(state, "peer-signer.json");
  await generateSigningIdentity({
    root: publisher, signerId: "signer:peer", publicOut,
    confirmation: "local-share-confirmed", now: new Date("2030-01-01T00:00:00.000Z")
  });
  await trustSigner({
    root: receiver, publicIdentityPath: publicOut,
    confirmation: "local-share-confirmed", now: new Date("2030-01-01T00:00:01.000Z")
  });
  await initDirectoryAdapter({
    root: publisher, directory: adapter, scopeId: "team:peer", adapterId: "adapter:peer",
    signerId: "signer:peer", confirmation: "local-share-confirmed"
  });
  await proposeLearning({
    root: publisher, id: "learning:peer", kind: "project-fact",
    claim: "The synthetic peer exchange proves live key possession.", privacy: "shared",
    evidence: { id: "evidence:peer", type: "test", summary: "Synthetic peer evidence.", confidence: 1 }
  });
  await reviewLearning({
    root: publisher, id: "learning:peer", decision: "accept",
    reason: "Synthetic confirmation.", confirmedByUser: true
  });
  await publishLearning({
    root: publisher, directory: adapter, learningId: "learning:peer", eventId: "shared:peer",
    signerId: "signer:peer", confirmation: "local-share-confirmed"
  });
  return { publisher, receiver, state, adapter };
}

function fixedRequest() {
  return createPeerRequest({
    requestId: "request:peer-test", challenge: "a".repeat(64), maxBytes: 2 * 1024 * 1024
  });
}

test("live challenge response authenticates the peer and imports only into quarantine", async (t) => {
  const value = await fixture(t);
  const beforePublisher = hash(await readFile(join(value.publisher, "AGENTS.md")));
  const beforeReceiver = hash(await readFile(join(value.receiver, "CLAUDE.md")));
  const request = fixedRequest();
  const envelope = await buildPeerResponse({
    root: value.publisher, directory: value.adapter, signerId: "signer:peer", request,
    snapshotId: "snapshot:peer-test", now: new Date("2030-01-02T00:00:00.000Z")
  });
  const validated = validatePeerResponse(envelope, request);
  assert.equal(validated.response.challenge, request.challenge);
  assert.equal(validated.publicIdentity.signerId, "signer:peer");
  const imported = await importPeerResponse({
    root: value.receiver, envelope, request, now: new Date("2030-01-02T00:00:01.000Z")
  });
  assert.equal(imported.transport, "peer-stdio");
  assert.deepEqual(imported.imported, ["shared:peer"]);
  assert.equal(imported.authority, "context-only");
  assert.equal((await sharedContext({ root: value.receiver })).items.length, 0);
  assert.equal((await sharedInbox({ root: value.receiver })).items[0].id, "shared:peer");
  assert.equal(hash(await readFile(join(value.publisher, "AGENTS.md"))), beforePublisher);
  assert.equal(hash(await readFile(join(value.receiver, "CLAUDE.md"))), beforeReceiver);
});

test("replay under a different challenge, tampering, and signer substitution fail before local mutation", async (t) => {
  const value = await fixture(t);
  const request = fixedRequest();
  const envelope = await buildPeerResponse({
    root: value.publisher, directory: value.adapter, signerId: "signer:peer", request,
    snapshotId: "snapshot:peer-replay", now: new Date("2030-01-02T00:00:00.000Z")
  });
  const otherRequest = createPeerRequest({
    requestId: request.requestId, challenge: "b".repeat(64), maxBytes: request.maxBytes
  });
  assert.throws(() => validatePeerResponse(envelope, otherRequest), /live request/);
  const damaged = structuredClone(envelope);
  damaged.payload.challenge = otherRequest.challenge;
  assert.throws(() => validatePeerResponse(damaged, otherRequest), /signature is invalid/);

  const otherPublic = join(value.state, "other-peer-signer.json");
  await generateSigningIdentity({
    root: value.publisher, signerId: "signer:other-peer", publicOut: otherPublic,
    confirmation: "local-share-confirmed", now: new Date("2030-01-02T00:00:02.000Z")
  });
  await assert.rejects(buildPeerResponse({
    root: value.publisher, directory: value.adapter, signerId: "signer:other-peer", request,
    snapshotId: "snapshot:wrong-live-signer", now: new Date("2030-01-02T00:00:02.500Z")
  }), /must match the snapshot manifest signer/);
  const substituted = await signEnvelope({
    root: value.publisher, signerId: "signer:other-peer", kind: "manifest",
    payload: envelope.payload, now: new Date("2030-01-02T00:00:03.000Z")
  });
  assert.throws(() => validatePeerResponse(substituted, request), /does not match the snapshot manifest signer/);
  assert.equal((await sharedInbox({ root: value.receiver })).items.length, 0);
});

test("one-shot server emits exactly one bounded JSON frame and requires local confirmation", async (t) => {
  const value = await fixture(t);
  const request = fixedRequest();
  const input = new PassThrough();
  const output = new PassThrough();
  let response = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { response += chunk; });
  input.end(`${JSON.stringify(request)}\n`);
  await servePeerOnce({
    root: value.publisher, directory: value.adapter, signerId: "signer:peer",
    input, output, confirmation: "local-share-confirmed", timeoutMs: 2000,
    now: new Date("2030-01-02T00:00:00.000Z")
  });
  assert.equal(response.trim().split("\n").length, 1);
  assert.equal(validatePeerResponse(JSON.parse(response), request).snapshot.scopeId, "team:peer");
  await assert.rejects(servePeerOnce({
    root: value.publisher, directory: value.adapter, signerId: "signer:peer",
    input: new PassThrough(), output: new PassThrough(), timeoutMs: 1000
  }), /explicit local owner confirmation/);
});

test("request and response schemas reject malformed, oversized, and foreign frames", async (t) => {
  const value = await fixture(t);
  assert.throws(() => createPeerRequest({ challenge: "short" }), /32 random bytes/);
  assert.throws(() => createPeerRequest({ maxBytes: 100 }), /between 1 MiB and 22 MiB/);
  assert.throws(() => validatePeerRequest({ schema: "foreign" }), /invalid/);
  const request = fixedRequest();
  const envelope = await buildPeerResponse({
    root: value.publisher, directory: value.adapter, signerId: "signer:peer", request,
    snapshotId: "snapshot:peer-schema"
  });
  const foreign = structuredClone(envelope);
  foreign.payload.schema = "foreign.peer/v1";
  assert.throws(() => validatePeerResponse(foreign, request), /signature is invalid|live request/);
});

test("revoked peer identities fail before quarantine mutation", async (t) => {
  const value = await fixture(t);
  const request = fixedRequest();
  const envelope = await buildPeerResponse({
    root: value.publisher, directory: value.adapter, signerId: "signer:peer", request,
    snapshotId: "snapshot:revoked-peer"
  });
  await revokeTrustedSigner({
    root: value.receiver, keyId: envelope.signer.keyId,
    reason: "Synthetic peer revocation.", confirmation: "local-share-confirmed"
  });
  await assert.rejects(importPeerResponse({
    root: value.receiver, envelope, request
  }), /untrusted or revoked signing key/);
  assert.equal((await sharedInbox({ root: value.receiver })).items.length, 0);
});

test("CLI performs an end-to-end peer pull through an argument array without a shell", async (t) => {
  const value = await fixture(t);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const command = JSON.stringify([
    process.execPath, cli, "share-peer-serve", value.adapter,
    "--root", value.publisher, "--signer", "signer:peer",
    "--timeout-ms", "5000", "--confirm-local-share"
  ]);
  const result = spawnSync(process.execPath, [cli,
    "share-peer-pull", "--root", value.receiver,
    "--command-json", command, "--timeout-ms", "5000",
    "--max-bytes", String(2 * 1024 * 1024), "--confirm-local-share", "--json"
  ], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, AGENTSPINE_STATE_DIR: value.state }
  });
  assert.equal(result.status, 0, result.stderr);
  const pulled = JSON.parse(result.stdout);
  assert.equal(pulled.transport, "peer-stdio");
  assert.equal(pulled.executable, process.execPath);
  assert.equal(pulled.commandArguments, 10);
  assert.equal(pulled.authority, "context-only");
});

test("CLI refuses both peer serving and command execution without explicit confirmation", async (t) => {
  const value = await fixture(t);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const environment = { ...process.env, AGENTSPINE_STATE_DIR: value.state };
  const serve = spawnSync(process.execPath, [cli,
    "share-peer-serve", value.adapter, "--root", value.publisher, "--signer", "signer:peer"
  ], { encoding: "utf8", env: environment });
  assert.notEqual(serve.status, 0);
  assert.match(serve.stderr, /explicit local owner confirmation/);
  const pull = spawnSync(process.execPath, [cli,
    "share-peer-pull", "--root", value.receiver, "--command-json", '["ssh","host"]'
  ], { encoding: "utf8", env: environment });
  assert.notEqual(pull.status, 0);
  assert.match(pull.stderr, /explicit local owner confirmation/);
});

test("peer command execution disables the shell and strips unrelated environment secrets", async (t) => {
  const value = await fixture(t);
  const previous = process.env.AGENTSPINE_SYNTHETIC_SECRET;
  process.env.AGENTSPINE_SYNTHETIC_SECRET = "must-not-reach-peer-process";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTSPINE_SYNTHETIC_SECRET;
    else process.env.AGENTSPINE_SYNTHETIC_SECRET = previous;
  });
  const spawnProcess = (executable, args, options) => {
    assert.equal(executable, "synthetic-peer");
    assert.deepEqual(args, ["literal;not-a-shell-command"]);
    assert.equal(options.shell, false);
    assert.equal(options.env.AGENTSPINE_SYNTHETIC_SECRET, undefined);
    assert.equal(options.env.AGENTSPINE_STATE_DIR, value.state);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => {
      child.exitCode = 0; child.stdout.end(); child.stderr.end();
    };
    let input = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => { input += chunk; });
    child.stdin.on("end", async () => {
      const request = JSON.parse(input);
      const envelope = await buildPeerResponse({
        root: value.publisher, directory: value.adapter, signerId: "signer:peer", request,
        snapshotId: "snapshot:sanitized-process"
      });
      child.stdout.end(`${JSON.stringify(envelope)}\n`);
    });
    return child;
  };
  const result = await pullPeerCommand({
    root: value.receiver,
    commandJson: ["synthetic-peer", "literal;not-a-shell-command"],
    confirmation: "local-share-confirmed", maxBytes: 2 * 1024 * 1024,
    timeoutMs: 5000, spawnProcess
  });
  assert.equal(result.transport, "peer-stdio");
});

test("peer transport and process execution stay absent from MCP and hooks", async () => {
  const [mcp, hook] = await Promise.all([
    readFile(new URL("../src/mcp.js", import.meta.url), "utf8"),
    readFile(new URL("../src/hook.js", import.meta.url), "utf8")
  ]);
  for (const content of [mcp, hook]) {
    assert.equal(/pullPeerCommand|servePeerOnce|share-peer|peer-stdio/.test(content), false);
  }
});
