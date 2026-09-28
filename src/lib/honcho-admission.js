export const HONCHO_ADMISSION_SCHEMA = "agentspine.honcho-admission/v1";

const PHASES = new Set(["evaluation", "honcho-primary"]);
const SCOPE_FIELDS = ["tenantId", "workspaceId", "userId", "projectId", "threadId"];
const PRODUCTION_EVIDENCE = [
  "serverHealth", "embeddingCompatibility", "derivationIsolation", "crossSessionRecall", "deletion"
];
const SHA256 = /^[a-f0-9]{64}$/;

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

function boundedText(value, maximum = 256) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
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
  if (plan.phase === "honcho-primary") {
    for (const field of PRODUCTION_EVIDENCE) {
      if (!SHA256.test(plan?.acceptance?.[field])) blockers.push(blocker("production-evidence-missing", `acceptance.${field}`));
    }
    if (!SHA256.test(plan?.governance?.sourceOfferDigest)) {
      blockers.push(blocker("agpl-source-offer-not-ready", "governance.sourceOfferDigest"));
    }
  }
  return { schema: HONCHO_ADMISSION_SCHEMA, admitted: blockers.length === 0,
    phase: PHASES.has(plan.phase) ? plan.phase : null, blockers };
}
