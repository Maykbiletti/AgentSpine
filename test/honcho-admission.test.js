import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import {
  evaluateHonchoAdmission, honchoEvidenceBindingDigest, honchoReceiptPublicKeyDigest,
  honchoReceiptTrustStoreDigest, HONCHO_ADMISSION_SCHEMA
} from "../src/lib/honcho-admission.js";
const DEFAULT_SCOPE = {
  tenantId: "tenant:a", workspaceId: "workspace:a", userId: "user:a",
  projectId: "project:a", threadId: "thread:a"
};
function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKey.export({ format: "pem", type: "spki" }).toString("utf8") };
}
const TRUSTED_SIGNER = signer();
const ROTATED_SIGNER = signer();
const TRUST_REVISION = 7;
const TRUST_STORE = {
  revision: TRUST_REVISION,
  publicKeys: [TRUSTED_SIGNER.publicKey, ROTATED_SIGNER.publicKey], revokedKeyDigests: []
};
const TRUST_STORE_DIGEST = honchoReceiptTrustStoreDigest(TRUST_STORE);
const TRUSTED_OPTIONS = { receiptTrustStore: TRUST_STORE,
  minimumReceiptTrustRevision: TRUST_REVISION,
  trustedReceiptTrustStoreDigest: TRUST_STORE_DIGEST };
function productionEvidence(scope = DEFAULT_SCOPE, digests = {}, observedAt = new Date().toISOString(),
  receiptSigner = TRUSTED_SIGNER, receiptTrustRevision = TRUST_REVISION,
  receiptTrustStoreDigest = TRUST_STORE_DIGEST) {
  const values = { serverHealth: "b".repeat(64), embeddingCompatibility: "c".repeat(64),
    derivationIsolation: "d".repeat(64), crossSessionRecall: "e".repeat(64),
    deletion: "f".repeat(64), sourceOffer: "a".repeat(64), ...digests };
  const acceptance = {};
  const evidenceBindings = {};
  const evidenceSignatures = {};
  const evidenceObservedAt = {};
  for (const field of ["serverHealth", "embeddingCompatibility", "derivationIsolation", "crossSessionRecall", "deletion"]) {
    acceptance[field] = values[field];
    evidenceObservedAt[field] = observedAt;
    const binding = honchoEvidenceBindingDigest(`acceptance.${field}`, values[field], scope, observedAt,
      receiptTrustRevision, receiptTrustStoreDigest);
    evidenceBindings[field] = binding;
    evidenceSignatures[field] = signMessage(
      null, Buffer.from(binding, "utf8"), receiptSigner.privateKey
    ).toString("base64");
  }
  acceptance.evidenceBindings = evidenceBindings;
  acceptance.evidenceSignatures = evidenceSignatures;
  acceptance.evidenceObservedAt = evidenceObservedAt;
  const sourceOfferBinding = honchoEvidenceBindingDigest(
    "governance.sourceOfferDigest", values.sourceOffer, scope, observedAt, receiptTrustRevision,
    receiptTrustStoreDigest
  );
  return { acceptance, governance: { dataResidency: "blun-self-hosted", upstreamLicense: "AGPL-3.0",
    receiptIssuerKeyDigest: honchoReceiptPublicKeyDigest(receiptSigner.publicKey),
    receiptTrustRevision, receiptTrustStoreDigest,
    sourceOfferDigest: values.sourceOffer,
    sourceOfferObservedAt: observedAt,
    sourceOfferBinding,
    sourceOfferSignature: signMessage(
      null, Buffer.from(sourceOfferBinding, "utf8"), receiptSigner.privateKey
    ).toString("base64") } };
}
function plan(overrides = {}) {
  return {
    schema: HONCHO_ADMISSION_SCHEMA,
    phase: "evaluation",
    agentSpineRole: "scope-gateway",
    writes: { agentspine: true, honcho: false },
    sourcePolicy: "confirmed-private-only",
    telemetryEnabled: false,
    network: { approvedOrigins: [
      "http://127.0.0.1:18000", "http://100.74.238.1:11434", "http://100.74.238.1:8000"
    ] },
    honcho: { serverUrl: "http://127.0.0.1:18000" },
    embedding: { baseUrl: "http://100.74.238.1:11434/v1", transport: "openai-compatible", model: "bge-m3", dimensions: 1024 },
    derivation: { baseUrl: "http://100.74.238.1:8000/v1", transport: "openai-compatible", model: "king",
      asynchronous: true, failOpen: true, maxRetries: 0, tools: false, parentHistory: false },
    governance: { dataResidency: "blun-self-hosted", upstreamLicense: "AGPL-3.0" },
    scope: { ...DEFAULT_SCOPE },
    ...overrides
  };
}
test("evaluation admits one AgentSpine writer and three separately approved self-hosted endpoint roles", () => {
  assert.deepEqual(evaluateHonchoAdmission(plan()), {
    schema: HONCHO_ADMISSION_SCHEMA, admitted: true, phase: "evaluation", blockers: []
  });
});
test("King vLLM cannot be mistaken for the Honcho server even when both use port 8000", () => {
  const value = plan({ honcho: { serverUrl: "http://100.74.238.1:8000" } });
  const result = evaluateHonchoAdmission(value);
  assert.equal(result.admitted, false);
  assert.ok(result.blockers.some((item) => item.code === "endpoint-role-collision"));
});
test("the supplied native Ollama api/embed endpoint is not claimed as direct upstream Honcho compatibility", () => {
  const value = plan({ embedding: {
    baseUrl: "http://100.74.238.1:11434/api/embed", transport: "ollama-native", model: "bge-m3", dimensions: 1024
  } });
  const result = evaluateHonchoAdmission(value);
  assert.equal(result.admitted, false);
  assert.ok(result.blockers.some((item) => item.code === "embedding-protocol-unverified"));
});
test("an allowlisted public endpoint cannot satisfy BLUN self-hosted data residency", () => {
  const value = plan({
    honcho: { serverUrl: "https://memory.example" },
    network: { approvedOrigins: [
      "https://memory.example", "http://100.74.238.1:11434", "http://100.74.238.1:8000"
    ] }
  });
  const result = evaluateHonchoAdmission(value);
  assert.equal(result.admitted, false);
  assert.deepEqual(result.blockers.filter((item) => item.code === "endpoint-not-private-network"), [
    { code: "endpoint-not-private-network", field: "server" }
  ]);
});
test("loopback, RFC1918, Tailscale CGNAT and IPv6 ULA hosts are private-network eligible", () => {
  const serverUrls = ["http://localhost:18000", "http://10.0.0.4:18000",
    "http://172.31.0.4:18000", "http://192.168.0.4:18000", "http://100.127.255.254:18000",
    "http://[fd7a:115c:a1e0::1]:18000"];
  for (const serverUrl of serverUrls) {
    const origin = new URL(serverUrl).origin;
    const value = plan({ honcho: { serverUrl }, network: { approvedOrigins: [
      origin, "http://100.74.238.1:11434", "http://100.74.238.1:8000"
    ] } });
    assert.equal(evaluateHonchoAdmission(value).admitted, true, serverUrl);
  }
});
test("public, link-local and ambiguous hostname forms fail the private-network boundary", () => {
  for (const serverUrl of ["https://203.0.113.10", "http://169.254.169.254", "http://internal.example",
    "http://010.0.0.4", "http://localhost.example"]) {
    const origin = new URL(serverUrl).origin;
    const value = plan({ honcho: { serverUrl }, network: { approvedOrigins: [
      origin, "http://100.74.238.1:11434", "http://100.74.238.1:8000"
    ] } });
    assert.ok(evaluateHonchoAdmission(value).blockers.some((item) =>
      item.code === "endpoint-not-private-network" && item.field === "server"), serverUrl);
  }
});
test("evaluation and cutover reject parallel memory writers", () => {
  const evaluation = evaluateHonchoAdmission(plan({ writes: { agentspine: true, honcho: true } }));
  assert.ok(evaluation.blockers.some((item) => item.code === "memory-writer-not-exclusive"));
  const cutover = evaluateHonchoAdmission(plan({ phase: "honcho-primary", writes: { agentspine: true, honcho: true } }));
  assert.ok(cutover.blockers.some((item) => item.code === "cutover-write-boundary-invalid"));
});
test("production cutover requires host acceptance, deletion proof and AGPL source readiness", () => {
  const denied = evaluateHonchoAdmission(
    plan({ phase: "honcho-primary", writes: { agentspine: false, honcho: true } }), TRUSTED_OPTIONS
  );
  assert.equal(denied.admitted, false);
  assert.equal(denied.blockers.filter((item) => item.code === "production-evidence-missing").length, 5);
  const accepted = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence()
  }), TRUSTED_OPTIONS);
  assert.equal(accepted.admitted, true);
});
test("production cutover rejects one receipt reused across independent evidence gates", () => {
  const shared = "a".repeat(64);
  const result = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, { serverHealth: shared, embeddingCompatibility: shared,
      derivationIsolation: shared, crossSessionRecall: shared, deletion: shared, sourceOffer: shared })
  }), TRUSTED_OPTIONS);
  assert.equal(result.admitted, false);
  assert.deepEqual(result.blockers.filter((item) => item.code === "production-evidence-reused"), [
    { code: "production-evidence-reused", field: "acceptance.serverHealth,acceptance.embeddingCompatibility" },
    { code: "production-evidence-reused", field: "acceptance.serverHealth,acceptance.derivationIsolation" },
    { code: "production-evidence-reused", field: "acceptance.serverHealth,acceptance.crossSessionRecall" },
    { code: "production-evidence-reused", field: "acceptance.serverHealth,acceptance.deletion" },
    { code: "production-evidence-reused", field: "acceptance.serverHealth,governance.sourceOfferDigest" }
  ]);
  assert.equal(JSON.stringify(result).includes(shared), false);
});

test("production evidence from one tenant and thread cannot unlock another scope", () => {
  const evidence = productionEvidence(DEFAULT_SCOPE);
  assert.equal(evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, ...evidence
  }), TRUSTED_OPTIONS).admitted, true);
  const otherScope = { ...DEFAULT_SCOPE, tenantId: "tenant:b", userId: "user:b", threadId: "thread:b" };
  const replay = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, scope: otherScope, ...evidence
  }), TRUSTED_OPTIONS);
  assert.equal(replay.admitted, false);
  assert.equal(replay.blockers.filter((item) => item.code === "production-evidence-scope-mismatch").length, 6);
});

test("scope-correct production evidence expires before a later cutover", () => {
  const staleObservedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, {}, staleObservedAt)
  }), TRUSTED_OPTIONS);
  assert.equal(result.admitted, false);
  assert.equal(result.blockers.filter((item) => item.code === "production-evidence-stale").length, 6);
  assert.equal(result.blockers.some((item) => item.code === "production-evidence-scope-mismatch"), false);
  assert.equal(JSON.stringify(result).includes(staleObservedAt), false);
});

test("production evidence requires the externally pinned BLUN host signer", () => {
  const rogueSigner = signer();
  const substituted = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, {}, new Date().toISOString(), rogueSigner)
  }), TRUSTED_OPTIONS);
  assert.equal(substituted.admitted, false);
  assert.deepEqual(substituted.blockers.filter((item) =>
    item.code === "production-evidence-issuer-untrusted"), [
    { code: "production-evidence-issuer-untrusted", field: "governance.receiptIssuerKeyDigest" }
  ]);

  const unsigned = productionEvidence();
  unsigned.acceptance.evidenceSignatures = {};
  delete unsigned.governance.sourceOfferSignature;
  const missingSignatures = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, ...unsigned
  }), TRUSTED_OPTIONS);
  assert.equal(missingSignatures.admitted, false);
  assert.equal(missingSignatures.blockers.filter((item) =>
    item.code === "production-evidence-signature-invalid").length, 6);
  assert.equal(JSON.stringify(substituted).includes(rogueSigner.publicKey), false);
});

test("receipt issuer rotation admits the new key while explicit revocation wins", () => {
  const rotatedPlan = plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, {}, new Date().toISOString(), ROTATED_SIGNER)
  });
  assert.equal(evaluateHonchoAdmission(rotatedPlan, TRUSTED_OPTIONS).admitted, true);

  const revokedDigest = honchoReceiptPublicKeyDigest(TRUSTED_SIGNER.publicKey);
  const revokedStore = { revision: TRUST_REVISION,
    publicKeys: [TRUSTED_SIGNER.publicKey, ROTATED_SIGNER.publicKey],
    revokedKeyDigests: [revokedDigest] };
  const revokedStoreDigest = honchoReceiptTrustStoreDigest(revokedStore);
  const revoked = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, {}, new Date().toISOString(), TRUSTED_SIGNER,
      TRUST_REVISION, revokedStoreDigest)
  }), { receiptTrustStore: revokedStore, minimumReceiptTrustRevision: TRUST_REVISION,
    trustedReceiptTrustStoreDigest: revokedStoreDigest });
  assert.equal(revoked.admitted, false);
  assert.deepEqual(revoked.blockers.filter((item) =>
    item.code === "production-evidence-issuer-revoked"), [
    { code: "production-evidence-issuer-revoked", field: "governance.receiptIssuerKeyDigest" }
  ]);
  assert.equal(JSON.stringify(revoked).includes(revokedDigest), false);
});

test("malformed receipt trust stores fail closed without inspecting signatures", () => {
  const value = plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, ...productionEvidence()
  });
  for (const receiptTrustStore of [
    null,
    { revision: 0, publicKeys: [TRUSTED_SIGNER.publicKey], revokedKeyDigests: [] },
    { revision: TRUST_REVISION,
      publicKeys: [TRUSTED_SIGNER.publicKey, TRUSTED_SIGNER.publicKey], revokedKeyDigests: [] },
    { revision: TRUST_REVISION,
      publicKeys: [TRUSTED_SIGNER.publicKey], revokedKeyDigests: ["not-a-digest"] },
    { revision: TRUST_REVISION,
      publicKeys: [TRUSTED_SIGNER.privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8")],
      revokedKeyDigests: [] }
  ]) {
    const result = evaluateHonchoAdmission(value, {
      receiptTrustStore, minimumReceiptTrustRevision: TRUST_REVISION,
      trustedReceiptTrustStoreDigest: TRUST_STORE_DIGEST
    });
    assert.equal(result.admitted, false);
    assert.deepEqual(result.blockers.filter((item) =>
      item.code === "production-evidence-trust-store-invalid"), [
      { code: "production-evidence-trust-store-invalid", field: "receiptTrustStore" }
    ]);
  }
});

test("a protected trust revision floor rejects rolled-back stores and mismatched plans", () => {
  const nextRevision = TRUST_REVISION + 1;
  const currentStore = {
    revision: nextRevision,
    publicKeys: [TRUSTED_SIGNER.publicKey, ROTATED_SIGNER.publicKey], revokedKeyDigests: []
  };
  const currentStoreDigest = honchoReceiptTrustStoreDigest(currentStore);
  const currentOptions = { receiptTrustStore: currentStore,
    minimumReceiptTrustRevision: nextRevision,
    trustedReceiptTrustStoreDigest: currentStoreDigest };
  const current = plan({ phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, {}, new Date().toISOString(), ROTATED_SIGNER, nextRevision,
      currentStoreDigest) });
  assert.equal(evaluateHonchoAdmission(current, currentOptions).admitted, true);

  const rolledBack = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, ...productionEvidence()
  }), { receiptTrustStore: {
    revision: TRUST_REVISION, publicKeys: [TRUSTED_SIGNER.publicKey], revokedKeyDigests: []
  }, minimumReceiptTrustRevision: nextRevision,
  trustedReceiptTrustStoreDigest: honchoReceiptTrustStoreDigest({
    revision: TRUST_REVISION, publicKeys: [TRUSTED_SIGNER.publicKey], revokedKeyDigests: []
  }) });
  assert.deepEqual(rolledBack.blockers.filter((item) =>
    item.code === "production-evidence-trust-store-rollback"), [
    { code: "production-evidence-trust-store-rollback", field: "receiptTrustStore.revision" }
  ]);

  const mismatched = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, {}, new Date().toISOString(), TRUSTED_SIGNER,
      TRUST_REVISION, currentStoreDigest)
  }), currentOptions);
  assert.deepEqual(mismatched.blockers.filter((item) =>
    item.code === "production-evidence-trust-revision-mismatch"), [
    { code: "production-evidence-trust-revision-mismatch", field: "governance.receiptTrustRevision" }
  ]);

  const missingFloor = evaluateHonchoAdmission(current, {
    receiptTrustStore: currentOptions.receiptTrustStore,
    trustedReceiptTrustStoreDigest: currentStoreDigest
  });
  assert.deepEqual(missingFloor.blockers.filter((item) =>
    item.code === "production-evidence-trust-floor-invalid"), [
    { code: "production-evidence-trust-floor-invalid", field: "minimumReceiptTrustRevision" }
  ]);

  const relabelledEvidence = productionEvidence();
  relabelledEvidence.governance.receiptTrustRevision = nextRevision;
  relabelledEvidence.governance.receiptTrustStoreDigest = currentStoreDigest;
  const relabelled = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, ...relabelledEvidence
  }), currentOptions);
  assert.equal(relabelled.blockers.filter((item) =>
    item.code === "production-evidence-scope-mismatch").length, 6);
});

test("a protected digest rejects same-revision trust-store substitution", () => {
  const rogueSigner = signer();
  const substitutedStore = { revision: TRUST_REVISION,
    publicKeys: [rogueSigner.publicKey, ROTATED_SIGNER.publicKey], revokedKeyDigests: [] };
  const substitutedDigest = honchoReceiptTrustStoreDigest(substitutedStore);
  const substitutedEvidence = productionEvidence(DEFAULT_SCOPE, {}, new Date().toISOString(),
    rogueSigner, TRUST_REVISION, substitutedDigest);
  const result = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, ...substitutedEvidence
  }), { receiptTrustStore: substitutedStore, minimumReceiptTrustRevision: TRUST_REVISION,
    trustedReceiptTrustStoreDigest: TRUST_STORE_DIGEST });
  assert.deepEqual(result.blockers.filter((item) =>
    item.code === "production-evidence-trust-store-tampered"), [
    { code: "production-evidence-trust-store-tampered", field: "receiptTrustStore" }
  ]);
  assert.equal(JSON.stringify(result).includes(rogueSigner.publicKey), false);

  const missingAnchor = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, ...productionEvidence()
  }), { receiptTrustStore: TRUST_STORE, minimumReceiptTrustRevision: TRUST_REVISION });
  assert.deepEqual(missingAnchor.blockers.filter((item) =>
    item.code === "production-evidence-trust-anchor-invalid"), [
    { code: "production-evidence-trust-anchor-invalid", field: "trustedReceiptTrustStoreDigest" }
  ]);
});

test("trust-store digests are canonical across key and revocation ordering", () => {
  const first = honchoReceiptPublicKeyDigest(TRUSTED_SIGNER.publicKey);
  const second = honchoReceiptPublicKeyDigest(ROTATED_SIGNER.publicKey);
  const forward = { revision: TRUST_REVISION,
    publicKeys: [TRUSTED_SIGNER.publicKey, ROTATED_SIGNER.publicKey],
    revokedKeyDigests: [first, second] };
  const reverse = { revision: TRUST_REVISION,
    publicKeys: [ROTATED_SIGNER.publicKey, TRUSTED_SIGNER.publicKey],
    revokedKeyDigests: [second, first] };
  assert.equal(honchoReceiptTrustStoreDigest(forward), honchoReceiptTrustStoreDigest(reverse));
  assert.equal(honchoReceiptTrustStoreDigest({ ...forward, revision: TRUST_REVISION + 1 })
    === honchoReceiptTrustStoreDigest(forward), false);
});

test("managed Honcho, unapproved origins, raw credentials, missing scope and unsafe derivation fail closed", () => {
  const value = plan({
    honcho: { serverUrl: "https://api.honcho.dev", apiKey: "must-not-live-here" },
    network: { approvedOrigins: [] },
    scope: { tenantId: "tenant:a" },
    derivation: { baseUrl: "http://100.74.238.1:8000/v1", transport: "openai-compatible", model: "king",
      asynchronous: false, failOpen: false, maxRetries: 3, tools: true, parentHistory: true }
  });
  const result = evaluateHonchoAdmission(value);
  const codes = new Set(result.blockers.map((item) => item.code));
  for (const code of ["honcho-server-not-self-hosted-root", "origin-not-approved", "raw-credential-forbidden",
    "scope-binding-missing", "derivation-isolation-incomplete"]) assert.ok(codes.has(code), code);
  assert.equal(JSON.stringify(result).includes("must-not-live-here"), false);
});

test("credential aliases and provider environment keys cannot hide raw access material", () => {
  const cases = [
    { overrides: { honcho: { serverUrl: "http://127.0.0.1:18000",
      headers: { Authorization: "Bearer synthetic-access-material" } } } },
    { overrides: { embedding: { ...plan().embedding, access_token: "synthetic-access-material" } } },
    { overrides: { derivation: { ...plan().derivation, clientSecret: "synthetic-access-material" } } },
    { overrides: { environment: { OPENAI_API_KEY: "synthetic-access-material" } } },
    { overrides: { honcho: { serverUrl: "http://127.0.0.1:18000",
      authToken: `synthetic-${"x".repeat(5000)}` } } },
    { overrides: { honcho: { serverUrl: "http://127.0.0.1:18000",
      authorization: { scheme: "Bearer", value: "synthetic-access-material" } } } }
  ];
  for (const { overrides } of cases) {
    const result = evaluateHonchoAdmission(plan(overrides));
    assert.deepEqual(result.blockers.filter((item) => item.code === "raw-credential-forbidden"), [
      { code: "raw-credential-forbidden", field: "plan.<credential>" }
    ]);
    assert.equal(JSON.stringify(result).includes("synthetic-access-material"), false);
  }

  assert.equal(evaluateHonchoAdmission(plan({
    credentialEnv: "HONCHO_API_KEY"
  })).admitted, true);
});

test("credential containers and common access-key aliases cannot hide raw material", () => {
  const cases = [
    { credentials: { bearer: "synthetic-access-material" } },
    { secrets: ["synthetic-access-material"] }, { tokens: ["synthetic-access-material"] },
    { passwords: { primary: "synthetic-access-material" } },
    { cookies: { session: "synthetic-access-material" } }, { privateKeys: ["synthetic-access-material"] },
    { auth: { bearer: "synthetic-access-material" } }, { passphrase: "synthetic-access-material" },
    { environment: { AWS_ACCESS_KEY_ID: "synthetic-access-material" } },
    { headers: { Authentication: "synthetic-access-material" } }
  ];
  for (const overrides of cases) {
    const result = evaluateHonchoAdmission(plan(overrides));
    assert.deepEqual(result.blockers.filter((item) => item.code === "raw-credential-forbidden"), [
      { code: "raw-credential-forbidden", field: "plan.<credential>" }
    ]);
    assert.equal(JSON.stringify(result).includes("synthetic-access-material"), false);
  }
});
test("numeric token metrics do not masquerade as raw credentials", () => {
  const quota = { maxTokens: 2048, maxInputTokens: 1536, maxOutputTokens: 512, inputTokens: 320,
    outputTokens: 160, promptTokens: 320, completionTokens: 160, cachedInputTokens: 64, reasoningTokens: 32, totalTokens: 480 };
  assert.equal(evaluateHonchoAdmission(plan({ derivation: { ...plan().derivation, quota } })).admitted, true);
  for (const [key, unsafe] of [["maxTokens", "synthetic-access-material"],
    ["maxInputTokens", ["synthetic-access-material"]], ["accessToken", 1234], ["tokens", 2048]]) {
    const result = evaluateHonchoAdmission(plan({
      derivation: { ...plan().derivation, quota: { [key]: unsafe } }
    }));
    assert.deepEqual(result.blockers.filter((item) => item.code === "raw-credential-forbidden"),
      [{ code: "raw-credential-forbidden", field: "plan.<credential>" }]);
    assert.equal(JSON.stringify(result).includes("synthetic-access-material"), false);
  }
});
test("cyclic and overdeep plans cannot bypass the recursive credential gate", () => {
  const cyclic = plan({ metadata: {} });
  cyclic.metadata.self = cyclic.metadata;
  const cyclicResult = evaluateHonchoAdmission(cyclic);
  assert.deepEqual(cyclicResult.blockers.filter((item) => item.code === "plan-traversal-invalid"),
    [{ code: "plan-traversal-invalid", field: "plan.<traversal>" }]);

  const overdeep = plan({ metadata: {} });
  let cursor = overdeep.metadata;
  for (let index = 0; index < 21; index += 1) { cursor.next = {}; cursor = cursor.next; }
  cursor.accessToken = "synthetic-access-material";
  const overdeepResult = evaluateHonchoAdmission(overdeep);
  assert.equal(overdeepResult.admitted, false);
  assert.deepEqual(overdeepResult.blockers.filter((item) => item.code === "plan-traversal-invalid"),
    [{ code: "plan-traversal-invalid", field: "plan.<traversal>" }]);
  assert.equal(JSON.stringify(overdeepResult).includes("synthetic-access-material"), false);
});
test("untrusted plan keys cannot escape through blocker diagnostics", () => {
  const marker = "synthetic-diagnostic-secret-marker";
  const cyclic = plan({ [marker]: {} });
  cyclic[marker].self = cyclic[marker];
  const results = [evaluateHonchoAdmission(plan({ [`${marker}-secret`]: "value" })),
    evaluateHonchoAdmission(cyclic)];
  for (const result of results) assert.equal(JSON.stringify(result).includes(marker), false);
});
test("accessors and overwide plans fail closed before untrusted code can run", () => {
  let reads = 0, accessorResult;
  const accessor = plan();
  Object.defineProperty(accessor, "schema", { enumerable: true, get() { reads += 1; throw new Error("untrusted getter ran"); } });
  assert.doesNotThrow(() => { accessorResult = evaluateHonchoAdmission(accessor); });
  assert.equal(reads, 0);
  const wide = plan({ metadata: Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`field${index}`, index])) });
  for (const result of [accessorResult, evaluateHonchoAdmission(wide)]) assert.deepEqual(result.blockers,
    [{ code: "plan-traversal-invalid", field: "plan.<traversal>" }]);
});
test("proxy traps cannot execute during plan validation", () => {
  let traps = 0;
  const trap = () => { traps += 1; throw new Error("untrusted proxy trap ran"); };
  const root = new Proxy(plan(), { getPrototypeOf: trap, ownKeys: trap });
  const nested = plan({ metadata: new Proxy({}, { getPrototypeOf: trap, ownKeys: trap }) });
  const revoked = Proxy.revocable(plan(), {});
  revoked.revoke();
  for (const candidate of [root, nested, revoked.proxy]) {
    let result;
    assert.doesNotThrow(() => { result = evaluateHonchoAdmission(candidate); });
    assert.deepEqual(result.blockers, [{ code: "plan-traversal-invalid", field: "plan.<traversal>" }]);
  }
  assert.equal(traps, 0);
});
test("shared acyclic plan metadata does not look like a traversal cycle", () => {
  const shared = { label: "synthetic-shared-config" };
  const result = evaluateHonchoAdmission(plan({ metadata: { first: shared, second: shared } }));
  assert.equal(result.admitted, true);
  assert.equal(result.blockers.some((item) => item.code === "plan-traversal-invalid"), false);
});
