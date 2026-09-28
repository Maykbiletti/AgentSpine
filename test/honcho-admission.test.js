import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHonchoAdmission, HONCHO_ADMISSION_SCHEMA } from "../src/lib/honcho-admission.js";

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
    scope: { tenantId: "tenant:a", workspaceId: "workspace:a", userId: "user:a", projectId: "project:a", threadId: "thread:a" },
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
    governance: { dataResidency: "blun-self-hosted", upstreamLicense: "AGPL-3.0", sourceOfferDigest: "a".repeat(64) },
    acceptance: { serverHealth: "b".repeat(64), embeddingCompatibility: "c".repeat(64),
      derivationIsolation: "d".repeat(64), crossSessionRecall: "e".repeat(64), deletion: "f".repeat(64) }
  }));
  assert.equal(accepted.admitted, true);
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
