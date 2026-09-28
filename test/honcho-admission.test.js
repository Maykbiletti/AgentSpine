import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateHonchoAdmission, honchoEvidenceBindingDigest, HONCHO_ADMISSION_SCHEMA
} from "../src/lib/honcho-admission.js";

const DEFAULT_SCOPE = {
  tenantId: "tenant:a", workspaceId: "workspace:a", userId: "user:a",
  projectId: "project:a", threadId: "thread:a"
};

function productionEvidence(scope = DEFAULT_SCOPE, digests = {}) {
  const values = { serverHealth: "b".repeat(64), embeddingCompatibility: "c".repeat(64),
    derivationIsolation: "d".repeat(64), crossSessionRecall: "e".repeat(64),
    deletion: "f".repeat(64), sourceOffer: "a".repeat(64), ...digests };
  const acceptance = {};
  const evidenceBindings = {};
  for (const field of ["serverHealth", "embeddingCompatibility", "derivationIsolation", "crossSessionRecall", "deletion"]) {
    acceptance[field] = values[field];
    evidenceBindings[field] = honchoEvidenceBindingDigest(`acceptance.${field}`, values[field], scope);
  }
  acceptance.evidenceBindings = evidenceBindings;
  return { acceptance, governance: { dataResidency: "blun-self-hosted", upstreamLicense: "AGPL-3.0",
    sourceOfferDigest: values.sourceOffer,
    sourceOfferBinding: honchoEvidenceBindingDigest("governance.sourceOfferDigest", values.sourceOffer, scope) } };
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
  const denied = evaluateHonchoAdmission(plan({ phase: "honcho-primary", writes: { agentspine: false, honcho: true } }));
  assert.equal(denied.admitted, false);
  assert.equal(denied.blockers.filter((item) => item.code === "production-evidence-missing").length, 5);
  const accepted = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence()
  }));
  assert.equal(accepted.admitted, true);
});

test("production cutover rejects one receipt reused across independent evidence gates", () => {
  const shared = "a".repeat(64);
  const result = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true },
    ...productionEvidence(DEFAULT_SCOPE, { serverHealth: shared, embeddingCompatibility: shared,
      derivationIsolation: shared, crossSessionRecall: shared, deletion: shared, sourceOffer: shared })
  }));
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
  })).admitted, true);
  const otherScope = { ...DEFAULT_SCOPE, tenantId: "tenant:b", userId: "user:b", threadId: "thread:b" };
  const replay = evaluateHonchoAdmission(plan({
    phase: "honcho-primary", writes: { agentspine: false, honcho: true }, scope: otherScope, ...evidence
  }));
  assert.equal(replay.admitted, false);
  assert.equal(replay.blockers.filter((item) => item.code === "production-evidence-scope-mismatch").length, 6);
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
