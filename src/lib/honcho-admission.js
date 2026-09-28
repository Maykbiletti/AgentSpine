import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

export const HONCHO_ADMISSION_SCHEMA = "agentspine.honcho-admission/v1";
export const HONCHO_RECEIPT_TRUST_STORE_SCHEMA = "agentspine.honcho-receipt-trust-store/v1";

const PHASES = new Set(["evaluation", "honcho-primary"]);
const SCOPE_FIELDS = ["tenantId", "workspaceId", "userId", "projectId", "threadId"];
const PRODUCTION_EVIDENCE = [
  "serverHealth", "embeddingCompatibility", "derivationIsolation", "crossSessionRecall", "deletion"
];
const SHA256 = /^[a-f0-9]{64}$/;
const PRODUCTION_EVIDENCE_PATHS = new Set([
  ...PRODUCTION_EVIDENCE.map((field) => `acceptance.${field}`), "governance.sourceOfferDigest"
]);
const PRODUCTION_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRODUCTION_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const RECEIPT_TRUSTED_KEY_LIMIT = 8;
const RECEIPT_REVOKED_KEY_LIMIT = 32;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RAW_CREDENTIAL_KEY_SUFFIXES = [
  "apikey", "token", "secret", "password", "passwort", "credential", "authorization",
  "authentication", "cookie", "privatekey", "passphrase", "accesskey", "accesskeyid",
  "secretkey"
];
const NUMERIC_TOKEN_METRIC_KEYS = new Set([
  "maxtokens", "maxinputtokens", "maxoutputtokens", "inputtokens", "outputtokens",
  "prompttokens", "completiontokens", "cachedinputtokens", "reasoningtokens", "totaltokens"
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

function evidenceTimestamp(value) {
  if (!UTC_TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
}

export function honchoEvidenceBindingDigest(field, evidenceDigest, scope, observedAt,
  receiptTrustRevision, receiptTrustStoreDigest) {
  if (!PRODUCTION_EVIDENCE_PATHS.has(field) || !SHA256.test(evidenceDigest)
    || SCOPE_FIELDS.some((name) => !boundedText(scope?.[name]))
    || evidenceTimestamp(observedAt) === null || !Number.isSafeInteger(receiptTrustRevision)
    || receiptTrustRevision <= 0 || !SHA256.test(receiptTrustStoreDigest)) return null;
  const payload = JSON.stringify({ schema: HONCHO_ADMISSION_SCHEMA, field, evidenceDigest,
    observedAt, receiptTrustRevision, receiptTrustStoreDigest,
    scope: Object.fromEntries(SCOPE_FIELDS.map((name) => [name, scope[name]])) });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function receiptPublicKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192
    || !/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(value)) return null;
  try {
    const key = createPublicKey(value);
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

function receiptKeyDigest(key) {
  return createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
}

export function honchoReceiptPublicKeyDigest(value) {
  const key = receiptPublicKey(value);
  return key ? receiptKeyDigest(key) : null;
}

function receiptSignature(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function rawCredentialKey(value, child) {
  const canonical = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (NUMERIC_TOKEN_METRIC_KEYS.has(canonical)
    && Number.isSafeInteger(child) && child >= 0) return false;
  const candidates = canonical.endsWith("s")
    ? [canonical, canonical.slice(0, -1)]
    : [canonical];
  return canonical === "auth"
    || candidates.some((candidate) => RAW_CREDENTIAL_KEY_SUFFIXES.some((suffix) =>
      candidate.endsWith(suffix)));
}

function rawCredentialValue(value) {
  if (typeof value === "string") return /\S/.test(value);
  return value !== null && value !== undefined && value !== false;
}

function rawCredentialScan(value, path = "", ancestors = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object") return null;
  if (depth > 20) return { kind: "traversal", path };
  if (ancestors.has(value)) return { kind: "traversal", path };
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (rawCredentialKey(key, child) && rawCredentialValue(child)) {
      ancestors.delete(value);
      return { kind: "credential", path: childPath };
    }
    const nested = rawCredentialScan(child, childPath, ancestors, depth + 1);
    if (nested) {
      ancestors.delete(value);
      return nested;
    }
  }
  ancestors.delete(value);
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

function receiptTrustStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const publicKeys = value.publicKeys;
  const revokedKeyDigests = value.revokedKeyDigests;
  if (!Number.isSafeInteger(value.revision) || value.revision <= 0
    || !Array.isArray(publicKeys) || publicKeys.length === 0
    || publicKeys.length > RECEIPT_TRUSTED_KEY_LIMIT
    || !Array.isArray(revokedKeyDigests) || revokedKeyDigests.length > RECEIPT_REVOKED_KEY_LIMIT
    || revokedKeyDigests.some((digest) => !SHA256.test(digest))) return null;
  const keys = new Map();
  for (const value of publicKeys) {
    const key = receiptPublicKey(value);
    if (!key) return null;
    const digest = receiptKeyDigest(key);
    if (keys.has(digest)) return null;
    keys.set(digest, key);
  }
  const revoked = new Set(revokedKeyDigests);
  if (revoked.size !== revokedKeyDigests.length) return null;
  const digestPayload = JSON.stringify({ schema: HONCHO_RECEIPT_TRUST_STORE_SCHEMA,
    revision: value.revision,
    publicKeyDigests: [...keys.keys()].sort(),
    revokedKeyDigests: [...revoked].sort() });
  const digest = createHash("sha256").update(digestPayload, "utf8").digest("hex");
  return { keys, revoked, revision: value.revision, digest };
}

export function honchoReceiptTrustStoreDigest(value) {
  return receiptTrustStore(value)?.digest ?? null;
}

function trustedReceiptKey(plan, configuredStore, minimumRevision, protectedDigest, blockers) {
  const store = receiptTrustStore(configuredStore);
  if (!store) {
    blockers.push(blocker("production-evidence-trust-store-invalid", "receiptTrustStore"));
    return null;
  }
  if (!Number.isSafeInteger(minimumRevision) || minimumRevision <= 0) {
    blockers.push(blocker("production-evidence-trust-floor-invalid", "minimumReceiptTrustRevision"));
    return null;
  }
  if (!SHA256.test(protectedDigest)) {
    blockers.push(blocker("production-evidence-trust-anchor-invalid",
      "trustedReceiptTrustStoreDigest"));
    return null;
  }
  if (store.digest !== protectedDigest) {
    blockers.push(blocker("production-evidence-trust-store-tampered", "receiptTrustStore"));
    return null;
  }
  if (store.revision < minimumRevision) {
    blockers.push(blocker("production-evidence-trust-store-rollback", "receiptTrustStore.revision"));
    return null;
  }
  if (plan?.governance?.receiptTrustStoreDigest !== protectedDigest) {
    blockers.push(blocker("production-evidence-trust-store-digest-mismatch",
      "governance.receiptTrustStoreDigest"));
    return null;
  }
  if (plan?.governance?.receiptTrustRevision !== store.revision) {
    blockers.push(blocker("production-evidence-trust-revision-mismatch",
      "governance.receiptTrustRevision"));
    return null;
  }
  const digest = plan?.governance?.receiptIssuerKeyDigest;
  if (store.revoked.has(digest)) {
    blockers.push(blocker("production-evidence-issuer-revoked", "governance.receiptIssuerKeyDigest"));
    return null;
  }
  const key = store.keys.get(digest);
  if (!key) {
    blockers.push(blocker("production-evidence-issuer-untrusted", "governance.receiptIssuerKeyDigest"));
    return null;
  }
  return key;
}

function checkProductionEvidence(plan, blockers, verifierKey) {
  const now = Date.now();
  const evidence = PRODUCTION_EVIDENCE.map((field) => ({
    field: `acceptance.${field}`, digest: plan?.acceptance?.[field],
    binding: plan?.acceptance?.evidenceBindings?.[field], bindingField: `acceptance.evidenceBindings.${field}`,
    signature: plan?.acceptance?.evidenceSignatures?.[field],
    signatureField: `acceptance.evidenceSignatures.${field}`,
    observedAt: plan?.acceptance?.evidenceObservedAt?.[field],
    observedAtField: `acceptance.evidenceObservedAt.${field}`
  }));
  evidence.push({ field: "governance.sourceOfferDigest", digest: plan?.governance?.sourceOfferDigest,
    binding: plan?.governance?.sourceOfferBinding, bindingField: "governance.sourceOfferBinding",
    signature: plan?.governance?.sourceOfferSignature,
    signatureField: "governance.sourceOfferSignature",
    observedAt: plan?.governance?.sourceOfferObservedAt,
    observedAtField: "governance.sourceOfferObservedAt" });
  const seen = new Map();
  for (const { field, digest, binding, bindingField, signature, signatureField,
    observedAt, observedAtField } of evidence) {
    if (!SHA256.test(digest)) {
      blockers.push(blocker(field === "governance.sourceOfferDigest"
        ? "agpl-source-offer-not-ready" : "production-evidence-missing", field));
      continue;
    }
    const observedMilliseconds = evidenceTimestamp(observedAt);
    if (observedMilliseconds === null) {
      blockers.push(blocker("production-evidence-time-invalid", observedAtField));
    } else {
      if (observedMilliseconds > now + PRODUCTION_EVIDENCE_FUTURE_SKEW_MS) {
        blockers.push(blocker("production-evidence-from-future", observedAtField));
      } else if (now - observedMilliseconds > PRODUCTION_EVIDENCE_MAX_AGE_MS) {
        blockers.push(blocker("production-evidence-stale", observedAtField));
      }
      const expected = honchoEvidenceBindingDigest(field, digest, plan.scope, observedAt,
        plan?.governance?.receiptTrustRevision, plan?.governance?.receiptTrustStoreDigest);
      const bindingMatches = SHA256.test(binding) && binding === expected;
      if (!bindingMatches) {
        blockers.push(blocker("production-evidence-scope-mismatch", bindingField));
      } else if (verifierKey) {
        const signatureBytes = receiptSignature(signature);
        if (!signatureBytes || !verifySignature(null, Buffer.from(expected, "utf8"), verifierKey, signatureBytes)) {
          blockers.push(blocker("production-evidence-signature-invalid", signatureField));
        }
      }
    }
    const previous = seen.get(digest);
    if (previous) blockers.push(blocker("production-evidence-reused", `${previous},${field}`));
    else seen.set(digest, field);
  }
}

export function evaluateHonchoAdmission(plan, options = {}) {
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
  const credentialScan = rawCredentialScan(plan);
  if (credentialScan?.kind === "credential") {
    blockers.push(blocker("raw-credential-forbidden", credentialScan.path));
  } else if (credentialScan) {
    blockers.push(blocker("plan-traversal-invalid", credentialScan.path));
  }
  if (plan.phase === "honcho-primary") {
    const verifierKey = trustedReceiptKey(plan, options?.receiptTrustStore,
      options?.minimumReceiptTrustRevision, options?.trustedReceiptTrustStoreDigest, blockers);
    checkProductionEvidence(plan, blockers, verifierKey);
  }
  return { schema: HONCHO_ADMISSION_SCHEMA, admitted: blockers.length === 0,
    phase: PHASES.has(plan.phase) ? plan.phase : null, blockers };
}
