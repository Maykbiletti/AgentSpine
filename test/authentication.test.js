import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateSigningIdentity, listSigningIdentities, loadTrust, revokeTrustedSigner,
  trustedSignerContext, trustSigner
} from "../src/lib/authentication.js";
import { runAudit } from "../src/lib/audit.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import { runHook } from "../src/hook.js";
import {
  initDirectoryAdapter, loadSharing, publishLearning, pullShared, reviewShared,
  sharedContext, sharedInbox
} from "../src/lib/sharing.js";

async function fixture(t) {
  const rootA = await mkdtemp(join(tmpdir(), "agentspine-auth-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "agentspine-auth-b-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-auth-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-auth-adapter-"));
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    await rm(rootA, { recursive: true }); await rm(rootB, { recursive: true });
    await rm(state, { recursive: true }); await rm(adapter, { recursive: true });
  });
  await writeFile(join(rootA, "AGENTS.md"), "# Publisher rules\n\nRemain unchanged.\n", "utf8");
  await writeFile(join(rootB, "CLAUDE.md"), "# Receiver rules\n\nRemain unchanged.\n", "utf8");
  return { rootA, rootB, state, adapter };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function acceptedLearning(root, id, claim) {
  await proposeLearning({
    root, id, kind: "project-fact", claim, privacy: "shared",
    evidence: { id: `evidence:${id}`, type: "test", summary: "Synthetic signing evidence.", confidence: 1 }
  });
  await reviewLearning({ root, id, decision: "accept", reason: "Synthetic confirmation.", confirmedByUser: true });
}

async function createSigner(root, state, signerId = "signer:publisher", filename = "publisher.json", rotate = false) {
  const publicOut = join(state, "public", filename);
  const result = await generateSigningIdentity({
    root, signerId, rotate, publicOut, confirmation: "local-share-confirmed"
  });
  return { ...result, publicOut };
}

function runCli(args, state) {
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, AGENTSPINE_STATE_DIR: state }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("signed sharing authenticates origin but still requires local content review", async (t) => {
  const { rootA, rootB, state, adapter } = await fixture(t);
  const beforeA = hash(await readFile(join(rootA, "AGENTS.md")));
  const beforeB = hash(await readFile(join(rootB, "CLAUDE.md")));
  const signer = await createSigner(rootA, state);
  assert.equal(JSON.stringify(signer).includes("PRIVATE KEY"), false);
  await trustSigner({ root: rootB, publicIdentityPath: signer.publicOut, confirmation: "local-share-confirmed" });
  const initialized = await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:signed", adapterId: "adapter:signed",
    signerId: "signer:publisher", confirmation: "local-share-confirmed"
  });
  assert.equal(initialized.signed, true);
  await acceptedLearning(rootA, "learning:signed", "The synthetic signed exchange is operational.");
  const published = await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:signed", eventId: "shared:signed",
    signerId: "signer:publisher", confirmation: "local-share-confirmed"
  });
  const manifest = JSON.parse(await readFile(join(adapter, ".agentspine-exchange.json"), "utf8"));
  const eventDocument = JSON.parse(await readFile(published.eventPath, "utf8"));
  assert.equal(manifest.schema, "agentspine.signed-envelope/v1");
  assert.equal(eventDocument.kind, "event");
  assert.equal(JSON.stringify(eventDocument).includes("Synthetic signing evidence"), false);
  const pulled = await pullShared({ root: rootB, directory: adapter, requireAuthenticated: true });
  assert.deepEqual(pulled.imported, ["shared:signed"]);
  assert.equal(pulled.manifestSigner.signerId, "signer:publisher");
  assert.equal((await sharedContext({ root: rootB })).items.length, 0);
  const inbox = await sharedInbox({ root: rootB });
  assert.equal(inbox.items[0].id, "shared:signed");
  assert.equal(inbox.items[0].authentication.signerId, "signer:publisher");
  assert.equal("signature" in inbox.items[0].authentication, false);
  await reviewShared({
    root: rootB, id: "shared:signed", decision: "accept", reason: "Confirmed locally.", confirmedByUser: true
  });
  const context = await sharedContext({ root: rootB, scopeId: "team:signed" });
  assert.equal(context.items[0].authentication.mode, "signed");
  assert.equal(context.items[0].authentication.signerId, "signer:publisher");
  assert.equal(context.items[0].authority, "context-only");
  const hook = await runHook({ hook_event_name: "SessionStart", cwd: rootB });
  const injected = JSON.parse(hook.context);
  assert.equal(injected.briefing.shared.length, 1);
  assert.equal(injected.briefing.shared[0].claim, "The synthetic signed exchange is operational.");
  assert.equal(hash(await readFile(join(rootA, "AGENTS.md"))), beforeA);
  assert.equal(hash(await readFile(join(rootB, "CLAUDE.md"))), beforeB);
  const privateFiles = await readdir(join(state, "signers", "private"));
  assert.equal(privateFiles.length, 1);
  if (process.platform !== "win32") assert.equal((await lstat(join(state, "signers", "private", privateFiles[0]))).mode & 0o077, 0);
});

test("untrusted signers and tampered signed payloads fail before quarantine writes", async (t) => {
  const { rootA, rootB, state, adapter } = await fixture(t);
  const signer = await createSigner(rootA, state);
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:untrusted", signerId: signer.signerId,
    confirmation: "local-share-confirmed"
  });
  await acceptedLearning(rootA, "learning:untrusted", "The synthetic signed fact is immutable.");
  const published = await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:untrusted", eventId: "shared:untrusted",
    signerId: signer.signerId, confirmation: "local-share-confirmed"
  });
  await assert.rejects(pullShared({ root: rootB, directory: adapter }), /untrusted or revoked signing key/);
  assert.equal((await loadSharing(rootB)).sharing.records.length, 0);
  await trustSigner({ root: rootB, publicIdentityPath: signer.publicOut, confirmation: "local-share-confirmed" });
  const document = JSON.parse(await readFile(published.eventPath, "utf8"));
  document.payload.claim = "A tampered synthetic claim.";
  await writeFile(published.eventPath, `${JSON.stringify(document)}\n`, "utf8");
  await assert.rejects(pullShared({ root: rootB, directory: adapter }), /signature is invalid/);
  assert.equal((await loadSharing(rootB)).sharing.records.length, 0);
});

test("a trusted manifest cannot authorize events from a different untrusted signer", async (t) => {
  const { rootA, rootB, state, adapter } = await fixture(t);
  const owner = await createSigner(rootA, state, "signer:owner", "owner.json");
  const writer = await createSigner(rootA, state, "signer:writer", "writer.json");
  await trustSigner({ root: rootB, publicIdentityPath: owner.publicOut, confirmation: "local-share-confirmed" });
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:multiwriter", signerId: owner.signerId,
    confirmation: "local-share-confirmed"
  });
  await acceptedLearning(rootA, "learning:writer", "A separate synthetic writer signed this event.");
  await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:writer", eventId: "shared:writer",
    signerId: writer.signerId, confirmation: "local-share-confirmed"
  });
  await assert.rejects(pullShared({ root: rootB, directory: adapter }), /untrusted or revoked signing key/);
  assert.equal((await loadSharing(rootB)).sharing.records.length, 0);
  await trustSigner({ root: rootB, publicIdentityPath: writer.publicOut, confirmation: "local-share-confirmed" });
  assert.deepEqual((await pullShared({ root: rootB, directory: adapter })).imported, ["shared:writer"]);
});

test("authentication can be required for an adapter without breaking legacy unsigned exchange", async (t) => {
  const { rootA, rootB, adapter } = await fixture(t);
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:legacy", confirmation: "local-share-confirmed"
  });
  await acceptedLearning(rootA, "learning:legacy", "The synthetic legacy exchange remains compatible.");
  await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:legacy", eventId: "shared:legacy",
    confirmation: "local-share-confirmed"
  });
  await assert.rejects(
    pullShared({ root: rootB, directory: adapter, requireAuthenticated: true }), /not authenticated/
  );
  assert.deepEqual((await pullShared({ root: rootB, directory: adapter })).imported, ["shared:legacy"]);
});

test("key rotation is explicit and revocation removes accepted signed context fail-closed", async (t) => {
  const { rootA, rootB, state, adapter } = await fixture(t);
  const oldSigner = await createSigner(rootA, state, "signer:rotating", "old.json");
  await trustSigner({ root: rootB, publicIdentityPath: oldSigner.publicOut, confirmation: "local-share-confirmed" });
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:rotation", signerId: "signer:rotating",
    confirmation: "local-share-confirmed"
  });
  await acceptedLearning(rootA, "learning:rotation", "The synthetic key rotation starts from a trusted event.");
  await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:rotation", eventId: "shared:rotation",
    signerId: "signer:rotating", confirmation: "local-share-confirmed"
  });
  await pullShared({ root: rootB, directory: adapter });
  await reviewShared({
    root: rootB, id: "shared:rotation", decision: "accept", reason: "Trusted before rotation.", confirmedByUser: true
  });
  const rotated = await createSigner(rootA, state, "signer:rotating", "new.json", true);
  assert.notEqual(rotated.keyId, oldSigner.keyId);
  assert.equal((await listSigningIdentities({ root: rootA })).retired[0].keyId, oldSigner.keyId);
  await revokeTrustedSigner({
    root: rootB, keyId: oldSigner.keyId, reason: "Synthetic rotation completed.",
    confirmation: "local-share-confirmed"
  });
  await assert.rejects(sharedContext({ root: rootB }), /untrusted-accepted-shared-event/);
  const audit = await runAudit(rootB);
  assert.equal(audit.gates.find((gate) => gate.name === "Context privacy").ok, false);
  await trustSigner({ root: rootB, publicIdentityPath: rotated.publicOut, confirmation: "local-share-confirmed" });
  const trusted = await trustedSignerContext({ root: rootB, includeRevoked: true });
  assert.deepEqual(trusted.signers.map((item) => item.status).sort(), ["revoked", "trusted"]);
  assert.equal(hash(await readFile(join(rootB, "CLAUDE.md"))), hash("# Receiver rules\n\nRemain unchanged.\n"));
});

test("stored signer spoofing is detected by replaying the original signature proof", async (t) => {
  const { rootA, rootB, state, adapter } = await fixture(t);
  const signerA = await createSigner(rootA, state, "signer:proof-a", "proof-a.json");
  const signerB = await createSigner(rootA, state, "signer:proof-b", "proof-b.json");
  for (const signer of [signerA, signerB]) {
    await trustSigner({ root: rootB, publicIdentityPath: signer.publicOut, confirmation: "local-share-confirmed" });
  }
  await initDirectoryAdapter({
    root: rootA, directory: adapter, scopeId: "team:proof", signerId: signerA.signerId,
    confirmation: "local-share-confirmed"
  });
  await acceptedLearning(rootA, "learning:proof", "The synthetic signature proof binds this exact signer.");
  await publishLearning({
    root: rootA, directory: adapter, learningId: "learning:proof", eventId: "shared:proof",
    signerId: signerA.signerId, confirmation: "local-share-confirmed"
  });
  await pullShared({ root: rootB, directory: adapter });
  const pending = await loadSharing(rootB);
  const originalAuthentication = structuredClone(pending.sharing.records[0].authentication);
  pending.sharing.records[0].authentication.signerId = signerB.signerId;
  pending.sharing.records[0].authentication.keyId = signerB.keyId;
  await writeFile(pending.sharingPath, `${JSON.stringify(pending.sharing)}\n`, "utf8");
  await assert.rejects(
    reviewShared({ root: rootB, id: "shared:proof", decision: "accept", reason: "Forged signer.", confirmedByUser: true }),
    /failed verification/
  );
  pending.sharing.records[0].authentication = originalAuthentication;
  await writeFile(pending.sharingPath, `${JSON.stringify(pending.sharing)}\n`, "utf8");
  await reviewShared({ root: rootB, id: "shared:proof", decision: "accept", reason: "Confirmed.", confirmedByUser: true });
  const loaded = await loadSharing(rootB);
  loaded.sharing.records[0].authentication.signerId = signerB.signerId;
  loaded.sharing.records[0].authentication.keyId = signerB.keyId;
  await writeFile(loaded.sharingPath, `${JSON.stringify(loaded.sharing)}\n`, "utf8");
  await assert.rejects(sharedContext({ root: rootB }), /invalid-stored-shared-signature/);
  assert.equal((await runAudit(rootB)).gates.find((gate) => gate.name === "Context privacy").ok, false);
});

test("audit detects a private key that no longer matches its public identity", async (t) => {
  const { rootA, state } = await fixture(t);
  await createSigner(rootA, state, "signer:key-audit", "key-audit.json");
  const [privateFile] = await readdir(join(state, "signers", "private"));
  const replacement = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" }
  }).privateKey;
  await writeFile(join(state, "signers", "private", privateFile), replacement, { mode: 0o600 });
  const audit = await runAudit(rootA);
  assert.equal(audit.gates.find((gate) => gate.name === "Context privacy").ok, false);
  assert.equal(audit.gates.find((gate) => gate.name === "Byte preservation").ok, true);
});

test("concurrent identity generation and trust imports retain every distinct key", async (t) => {
  const { rootA, rootB, state } = await fixture(t);
  const identities = await Promise.all(Array.from({ length: 6 }, (_, index) => createSigner(
    rootA, state, `signer:parallel-${index}`, `parallel-${index}.json`
  )));
  await Promise.all(identities.map((identity) => trustSigner({
    root: rootB, publicIdentityPath: identity.publicOut, confirmation: "local-share-confirmed"
  })));
  assert.equal((await listSigningIdentities({ root: rootA })).signers.length, 6);
  assert.equal((await loadTrust(rootB)).trust.records.length, 6);
});

test("CLI completes the signed adapter lifecycle without exposing private keys", async (t) => {
  const { rootA, rootB, state, adapter } = await fixture(t);
  const publicOut = join(state, "cli-publisher.json");
  const generated = runCli([
    "share-keygen", "signer:cli", "--root", rootA, "--public-out", publicOut,
    "--confirm-local-share", "--json"
  ], state);
  assert.equal(JSON.stringify(generated).includes("PRIVATE KEY"), false);
  runCli(["share-trust", publicOut, "--root", rootB, "--confirm-local-share", "--json"], state);
  runCli([
    "share-init", adapter, "--root", rootA, "--scope", "team:cli-auth", "--signer", "signer:cli",
    "--confirm-local-share", "--json"
  ], state);
  await acceptedLearning(rootA, "learning:cli-auth", "The synthetic CLI signed transport is operational.");
  runCli([
    "share-publish", adapter, "--root", rootA, "--learning", "learning:cli-auth", "--id", "shared:cli-auth",
    "--signer", "signer:cli", "--confirm-local-share", "--json"
  ], state);
  assert.deepEqual(runCli([
    "share-pull", adapter, "--root", rootB, "--require-authenticated", "--json"
  ], state).imported, ["shared:cli-auth"]);
  runCli([
    "share-review", "shared:cli-auth", "--root", rootB, "--decision", "accept",
    "--reason", "Confirmed locally.", "--confirmed-by-user", "--json"
  ], state);
  assert.equal(runCli(["share-context", rootB, "--json"], state).items[0].authentication.mode, "signed");
  assert.equal(runCli(["share-trust-list", rootB, "--json"], state).signers[0].signerId, "signer:cli");
});
