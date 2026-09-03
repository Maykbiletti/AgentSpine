import { createHash } from "node:crypto";

const CLOSURE_SCHEMA = "agentspine.delivery-premortem-closure/v1";
const ATTACHMENT_SCHEMA = "agentspine.goal-premortem-attachment/v1";
const ARTIFACT_SCHEMA = "agentspine.delivery-premortem-artifact/v1";
const AUTHORITY = "context-only";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CATEGORIES = ["baseline-environment", "contract-tests", "delivery-path"];
const RESULT_LIMIT = 1024;
const VALUE_LIMIT = 512;
const FAILURE_RE = /^this delivery fails because \S/i;
export const DELIVERY_PREMORTEM_SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusr])_[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[-_ ]?key|token|password|passwort|secret|geheimnis|credential)\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;

export function hasSecretShapedText(value) {
  return typeof value === "string" && DELIVERY_PREMORTEM_SECRET_RE.test(value);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function sealed(value, key = "digest") {
  const material = { ...value };
  delete material[key];
  return { ...material, [key]: sha256(material) };
}

function validSeal(value, key = "digest") {
  if (!value || typeof value !== "object" || Array.isArray(value) || !DIGEST_RE.test(value[key] || "")) return false;
  const material = { ...value };
  delete material[key];
  return value[key] === sha256(material);
}

function bounded(value, name, limit = VALUE_LIMIT) {
  if (typeof value !== "string" || !value || value.length > limit || /[\0\r\n]/.test(value)) {
    throw new Error(`premortem ${name} is invalid`);
  }
  return value;
}

function normalizedItems(items) {
  if (!Array.isArray(items) || items.length !== CATEGORIES.length) {
    throw new Error("premortem requires exactly three items");
  }
  const output = items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("premortem item is invalid");
    const category = bounded(item.category, "category", 64);
    if (!CATEGORIES.includes(category)) throw new Error(`premortem category is invalid: ${category}`);
    const failure = bounded(item.failure, "failure");
    if (!FAILURE_RE.test(failure)) {
      throw new Error(`premortem ${category} failure must start with 'this delivery fails because '`);
    }
    const check = bounded(item.check, "check");
    if (!check.trim()) throw new Error(`premortem ${category} check is invalid`);
    if (hasSecretShapedText(failure) || hasSecretShapedText(check)) {
      const error = new Error(`premortem ${category} contains secret-shaped content`);
      error.code = "AGENTSPINE_PREMORTEM_SECRET";
      throw error;
    }
    return { category, failure, checkId: `check-${sha256({ category, failure, check }).slice(0, 20)}`, check };
  });
  if (new Set(output.map((item) => item.category)).size !== CATEGORIES.length) {
    throw new Error("premortem categories must appear exactly once");
  }
  return CATEGORIES.map((category) => output.find((item) => item.category === category));
}

export function createPremortemArtifact({ requirement, items, recordedAt }) {
  return sealed({ schema: ARTIFACT_SCHEMA, requirementId: requirement.requirementId,
    laneDigest: requirement.laneDigest, items: normalizedItems(items), recordedAt,
    authority: AUTHORITY });
}

export function validPremortemArtifact(value, state) {
  if (!value || value.schema !== ARTIFACT_SCHEMA || value.authority !== AUTHORITY
    || value.laneDigest !== state.laneDigest || value.requirementId !== state.requirement?.requirementId
    || typeof value.recordedAt !== "string" || !Number.isFinite(new Date(value.recordedAt).getTime())
    || !validSeal(value)) return false;
  try {
    return canonical(value.items) === canonical(normalizedItems(value.items.map(({ category, failure, check }) =>
      ({ category, failure, check }))));
  } catch {
    return false;
  }
}

function parsedClosure(message) {
  const text = typeof message === "string" ? message.replace(/\r\n/g, "\n").trimEnd() : "";
  const lines = text.split("\n").slice(-5);
  const artifact = lines[0]?.match(/^Premortem closure sha256 ([a-f0-9]{64})$/i);
  const write = lines[1]?.match(/^Premortem latest write sha256 ([a-f0-9]{64})$/i);
  const artifactDigests = artifact ? [artifact[1].toLowerCase()] : [];
  const writeDigests = write ? [write[1].toLowerCase()] : [];
  const checks = [];
  const expression = /^- (baseline-environment|contract-tests|delivery-path) ([^:\s]{1,80}): (PASS|FAIL|PENDING) — (.*)$/i;
  for (const line of lines.slice(2)) {
    const match = line.match(expression);
    if (match) checks.push({ category: match[1].toLowerCase(),
      checkId: match[2], status: match[3].toUpperCase(), result: match[4].trim() });
  }
  return { artifactDigests, writeDigests, checks };
}

export function reviewPremortemClosure(message, artifact, lastWriteDigest) {
  const parsed = parsedClosure(message);
  const missing = [];
  if (parsed.artifactDigests.length !== 1 || parsed.artifactDigests[0] !== artifact.digest) {
    missing.push("closure-digest");
  }
  if (parsed.writeDigests.length !== 1 || parsed.writeDigests[0] !== lastWriteDigest) {
    missing.push("latest-write-digest");
  }
  const checks = [];
  for (const item of artifact.items) {
    const found = parsed.checks.filter((check) => check.category === item.category);
    if (found.length !== 1 || found[0].checkId !== item.checkId || found[0].status !== "PASS"
      || !found[0].result || found[0].result.length > RESULT_LIMIT
      || /[\0\r\n]/.test(found[0].result) || hasSecretShapedText(found[0].result)) missing.push(item.category);
    else checks.push(found[0]);
  }
  return { missing: [...new Set(missing)], checks };
}

export function createPremortemClosure({ requirementId, artifactDigest, lastWriteDigest, checks, closedAt }) {
  return sealed({ schema: CLOSURE_SCHEMA, requirementId, artifactDigest, lastWriteDigest,
    checks, closedAt, authority: AUTHORITY });
}

export function validPremortemClosure(value, state) {
  if (!value || !state.artifact || !state.lastWrite || value.schema !== CLOSURE_SCHEMA
    || value.authority !== AUTHORITY || value.requirementId !== state.requirement?.requirementId
    || value.artifactDigest !== state.artifact.digest || value.lastWriteDigest !== state.lastWrite.digest
    || typeof value.closedAt !== "string" || !Number.isFinite(new Date(value.closedAt).getTime())
    || !validSeal(value) || !Array.isArray(value.checks) || value.checks.length !== CATEGORIES.length) return false;
  return CATEGORIES.every((category) => {
    const expected = state.artifact.items.find((item) => item.category === category);
    const matches = value.checks.filter((item) => item.category === category);
    return matches.length === 1 && matches[0].checkId === expected?.checkId && matches[0].status === "PASS"
      && typeof matches[0].result === "string" && matches[0].result.trim().length > 0
      && matches[0].result.length <= RESULT_LIMIT && !/[\0\r\n]/.test(matches[0].result)
      && !hasSecretShapedText(matches[0].result);
  });
}

export function createPremortemAttachment(state) {
  return sealed({ schema: ATTACHMENT_SCHEMA, goalId: state.binding.goalId,
    goalStepId: state.binding.goalStepId, queueId: state.binding.queueId,
    planDefinitionsDigest: state.binding.planDefinitionsDigest, laneDigest: state.laneDigest,
    sessionDigest: sha256(state.binding.sessionId), host: state.binding.host,
    projectId: state.binding.projectId, entityId: state.binding.entityId,
    groupId: state.binding.groupId, taskId: state.binding.taskId,
    gatewayAttempt: state.binding.gatewayAttempt,
    premortemText: state.artifact.items.map((item) => `${item.failure} Check: ${item.check}`).join("\n"),
    premortemDigest: state.artifact.digest, lastWriteDigest: state.lastWrite.digest,
    checkResults: structuredClone(state.closure.checks), closureDigest: state.closure.digest,
    authority: AUTHORITY }, "attachmentDigest");
}
