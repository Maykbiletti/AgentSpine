import { createHash } from "node:crypto";

export const HONCHO_ADMISSION_SCHEMA = "agentspine.honcho-admission/v1";

const PHASES = new Set(["evaluation", "honcho-primary"]);
const SCOPE_FIELDS = ["tenantId", "workspaceId", "userId", "projectId", "threadId"];
const PRODUCTION_EVIDENCE = [
  "serverHealth", "embeddingCompatibility", "derivationIsolation", "crossSessionRecall", "deletion"
];
const SHA256 = /^[a-f0-9]{64}$/;
const PRODUCTION_EVIDENCE_PATHS = new Set([
  ...PRODUCTION_EVIDENCE.map((field) => `acceptance.${field}`), "governance.sourceOfferDigest"
]);

function blocker(code, field) { return { code, field }; }

function endpoint(value, field, blockers) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    blockers.push(blocker("endpoint-missing", field));
    return null;
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    blockers.push(blocker("endpoint-invalid", field));
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    blockers.push(blocker("endpoint-unsafe", field));
    return null;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return { origin: parsed.origin, path: parsed.pathname, hostname: parsed.hostname.toLowerCase() };
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function isPrivateNetworkHost(hostname) {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (host === "localhost" || host === "::1") return true;
  if (isPrivateIpv4(host)) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(host);
}

function boundedText(value, maximum = 256) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function honchoEvidenceBindingDigest(field, evidenceDigest, scope) {
  if (!PRODUCTION_EVIDENCE_PATHS.has(field) || !SHA256.test(evidenceDigest)
    || SCOPE_FIELDS.some((name) => !boundedText(scope?.[name]))) return null;
  const payload = JSON.stringify({ schema: HONCHO_ADMISSION_SCHEMA, field, evidenceDigest,
    scope: Object.fromEntries(SCOPE_FIELDS.map((name) => [name, scope[name]])) });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function rawCredentialPath(value, path = "", seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value) || depth > 20) return null;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (/^(?:apiKey|token|authorization|password|secret)$/i.test(key) && boundedText(child, 4096)) return childPath;
    const nested = rawCredentialPath(child, childPath, seen, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function checkEndpointRoles(plan, blockers) {
  const server = endpoint(plan?.honcho?.serverUrl, "honcho.serverUrl", blockers);
  const embedding = endpoint(plan?.embedding?.baseUrl, "embedding.baseUrl", blockers);
  const derivation = endpoint(plan?.derivation?.baseUrl, "derivation.baseUrl", blockers);
  const endpoints = { server, embedding, derivation };
  const origins = new Map();
  for (const [role, current] of Object.entries(endpoints)) {
    if (!current) continue;
    if (!isPrivateNetworkHost(current.hostname)) {
      blockers.push(blocker("endpoint-not-private-network", role));
    }
    const previous = origins.get(current.origin);
    if (previous) blockers.push(blocker("endpoint-role-collision", `${previous},${role}`));
    else origins.set(current.origin, role);
  }
  if (server && (server.path !== "/" || server.hostname === "api.honcho.dev"
    || server.hostname.endsWith(".honcho.dev"))) {
    blockers.push(blocker("honcho-server-not-self-hosted-root", "honcho.serverUrl"));
  }
  if (embedding && (embedding.path !== "/v1" || plan?.embedding?.transport !== "openai-compatible")) {
    blockers.push(blocker("embedding-protocol-unverified", "embedding"));
  }
  if (derivation && (derivation.path !== "/v1" || plan?.derivation?.transport !== "openai-compatible")) {
    blockers.push(blocker("derivation-protocol-unverified", "derivation"));
  }
  const approvedValues = Array.isArray(plan?.network?.approvedOrigins) ? plan.network.approvedOrigins : [];
  if (approvedValues.length === 0 || approvedValues.length > 8
    || approvedValues.some((value) => typeof value !== "string" || value.length > 2048)) {
    blockers.push(blocker("approved-origin-list-invalid", "network.approvedOrigins"));
  }
  const approved = new Set(approvedValues);
  for (const [role, current] of Object.entries(endpoints)) {
    if (current && !approved.has(current.origin)) blockers.push(blocker("origin-not-approved", role));
  }
}

function checkRuntimeOwnership(plan, blockers) {
  const agentspine = plan?.writes?.agentspine === true;
  const honcho = plan?.writes?.honcho === true;
  if (agentspine === honcho) blockers.push(blocker("memory-writer-not-exclusive", "writes"));
  if (plan?.phase === "evaluation" && (!agentspine || honcho)) {
    blockers.push(blocker("evaluation-write-boundary-invalid", "writes"));
  }
  if (plan?.phase === "honcho-primary" && (agentspine || !honcho)) {
    blockers.push(blocker("cutover-write-boundary-invalid", "writes"));
  }
  if (plan?.agentSpineRole !== "scope-gateway") blockers.push(blocker("agentspine-role-invalid", "agentSpineRole"));
}

function checkProductionEvidence(plan, blockers) {
  const evidence = PRODUCTION_EVIDENCE.map((field) => ({
    field: `acceptance.${field}`, digest: plan?.acceptance?.[field],
    binding: plan?.acceptance?.evidenceBindings?.[field], bindingField: `acceptance.evidenceBindings.${field}`
  }));
  evidence.push({ field: "governance.sourceOfferDigest", digest: plan?.governance?.sourceOfferDigest,
    binding: plan?.governance?.sourceOfferBinding, bindingField: "governance.sourceOfferBinding" });
  const seen = new Map();
  for (const { field, digest, binding, bindingField } of evidence) {
    if (!SHA256.test(digest)) {
      blockers.push(blocker(field === "governance.sourceOfferDigest"
        ? "agpl-source-offer-not-ready" : "production-evidence-missing", field));
      continue;
    }
    const expected = honchoEvidenceBindingDigest(field, digest, plan.scope);
    if (!SHA256.test(binding) || binding !== expected) {
      blockers.push(blocker("production-evidence-scope-mismatch", bindingField));
    }
    const previous = seen.get(digest);
    if (previous) blockers.push(blocker("production-evidence-reused", `${previous},${field}`));
    else seen.set(digest, field);
  }
}

export function evaluateHonchoAdmission(plan) {
  const blockers = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { schema: HONCHO_ADMISSION_SCHEMA, admitted: false, phase: null,
      blockers: [blocker("plan-invalid", "plan")] };
  }
  if (plan.schema !== HONCHO_ADMISSION_SCHEMA) blockers.push(blocker("schema-invalid", "schema"));
  if (!PHASES.has(plan.phase)) blockers.push(blocker("phase-invalid", "phase"));
  checkRuntimeOwnership(plan, blockers);
  checkEndpointRoles(plan, blockers);
  if (plan?.sourcePolicy !== "confirmed-private-only") blockers.push(blocker("source-policy-invalid", "sourcePolicy"));
  if (plan?.telemetryEnabled !== false) blockers.push(blocker("telemetry-not-disabled", "telemetryEnabled"));
  if (plan?.governance?.dataResidency !== "blun-self-hosted") blockers.push(blocker("data-residency-invalid", "governance.dataResidency"));
  if (plan?.governance?.upstreamLicense !== "AGPL-3.0") blockers.push(blocker("license-review-missing", "governance.upstreamLicense"));
  for (const field of SCOPE_FIELDS) {
    if (!boundedText(plan?.scope?.[field])) blockers.push(blocker("scope-binding-missing", `scope.${field}`));
  }
  if (!boundedText(plan?.embedding?.model, 128) || !Number.isInteger(plan?.embedding?.dimensions)
    || plan.embedding.dimensions <= 0) blockers.push(blocker("embedding-contract-incomplete", "embedding"));
  if (!boundedText(plan?.derivation?.model, 128)) blockers.push(blocker("derivation-model-missing", "derivation.model"));
  if (plan?.derivation?.asynchronous !== true || plan?.derivation?.failOpen !== true
    || plan?.derivation?.maxRetries !== 0 || plan?.derivation?.tools !== false
    || plan?.derivation?.parentHistory !== false) {
    blockers.push(blocker("derivation-isolation-incomplete", "derivation"));
  }
  const credential = rawCredentialPath(plan);
  if (credential) blockers.push(blocker("raw-credential-forbidden", credential));
  if (plan.phase === "honcho-primary") checkProductionEvidence(plan, blockers);
  return { schema: HONCHO_ADMISSION_SCHEMA, admitted: blockers.length === 0,
    phase: PHASES.has(plan.phase) ? plan.phase : null, blockers };
}
