import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { withOwnedFileLock } from "./owned-file-lock.js";
import { canonicalPath, projectStateDir } from "./paths.js";

const SCHEMA = "agentspine.world-model/v1";
const ASSERTION_SCHEMA = "agentspine.world-assertion/v1";
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_VALUE_BYTES = 8192;
const EVIDENCE_KINDS = new Set([
  "objective-measurement", "explicit-user-feedback", "model-suggestion"
]);
const PRIVACY = new Set(["private", "shared", "group"]);
const STABLE_ID = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const PREDICATE = /^[a-z][a-z0-9.-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FORBIDDEN = /(^|[-_.])(permissions?|rights?|authori[sz]ation|credentials?|secrets?|tokens?|api[-_]?keys?|delegation|tool[-_]?access|production[-_]?access|payments?|spending)([-_.]|$)/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value, path = "value") {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} numbers must be finite`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must be JSON data`);
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN.test(key)) throw new Error(`${path}.${key} is authority data and cannot enter the world model`);
    result[key] = canonicalValue(value[key], `${path}.${key}`);
  }
  return result;
}

function exactTime(value, field, fallback = null) {
  if ((value === null || value === undefined) && fallback !== null) return fallback;
  if (typeof value !== "string" || !value) throw new Error(`${field} is required`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${field} must be an exact ISO timestamp`);
  }
  return value;
}

function stableId(value, field) {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new Error(`${field} must be a stable namespaced id`);
  return value;
}

function optionalStableId(value, field) {
  return value === null || value === undefined ? null : stableId(value, field);
}

function emptyModel(root) {
  return { schema: SCHEMA, root, revision: 0, assertions: [], events: [], authority: "context-only" };
}

function validateStoredAssertion(assertion) {
  if (!assertion || assertion.schema !== ASSERTION_SCHEMA || assertion.authority !== "context-only") return false;
  if (!STABLE_ID.test(assertion.id || "") || !STABLE_ID.test(assertion.subjectId || "")) return false;
  if (!PREDICATE.test(assertion.predicate || "") || FORBIDDEN.test(assertion.predicate)
    || !EVIDENCE_KINDS.has(assertion.evidenceKind)) return false;
  if (!PRIVACY.has(assertion.privacy) || !DIGEST.test(assertion.evidenceDigest || "")) return false;
  if ((assertion.privacy === "group") !== Boolean(assertion.groupId)
    || (assertion.groupId && !STABLE_ID.test(assertion.groupId))
    || (assertion.projectId && !STABLE_ID.test(assertion.projectId))
    || !STABLE_ID.test(assertion.evidenceId || "") || !Array.isArray(assertion.supersedes)
    || assertion.supersedes.some((item) => !STABLE_ID.test(item))) return false;
  try {
    if (exactTime(assertion.observedAt, "observedAt") !== assertion.observedAt) return false;
    if (assertion.expiresAt) exactTime(assertion.expiresAt, "expiresAt");
    const value = canonicalValue(assertion.value);
    if (sha256(JSON.stringify(value)) !== assertion.valueDigest) return false;
  } catch {
    return false;
  }
  return assertion.status === (assertion.evidenceKind === "model-suggestion" ? "proposed" : "established");
}

function normalizeModel(value, root) {
  if (!value || value.schema !== SCHEMA || value.root !== root || value.authority !== "context-only"
    || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.assertions)
    || !Array.isArray(value.events) || value.assertions.some((item) => !validateStoredAssertion(item))
    || value.events.some((item) => !item || item.authority !== "context-only")) {
    throw new Error("world model state is invalid");
  }
  return value;
}

async function stateNames(root) {
  const canonicalRoot = await canonicalPath(root);
  const directory = await projectStateDir(canonicalRoot);
  const path = join(directory, "world-model.json");
  return { root: canonicalRoot, path, lockPath: `${path}.lock` };
}

async function readModel(names) {
  try {
    const metadata = await stat(names.path);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("world model exceeds the 5 MiB read limit");
    return normalizeModel(JSON.parse(await readFile(names.path, "utf8")), names.root);
  } catch (error) {
    if (error.code === "ENOENT") return emptyModel(names.root);
    if (error instanceof SyntaxError) throw new Error("world model state is not valid JSON");
    throw error;
  }
}

async function writeModel(model, names, assertOwned) {
  const content = `${JSON.stringify(model, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("world model exceeds 5 MiB");
  const temporary = `${names.path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await replaceFileWithRetry(temporary, names.path, { beforeAttempt: assertOwned });
}

function assertionInput(input, now) {
  const id = stableId(input.id, "id");
  const subjectId = stableId(input.subjectId, "subjectId");
  if (typeof input.predicate !== "string" || !PREDICATE.test(input.predicate)) {
    throw new Error("predicate must be a lowercase dotted key");
  }
  if (FORBIDDEN.test(input.predicate)) throw new Error("authority predicates cannot enter the world model");
  if (!EVIDENCE_KINDS.has(input.evidenceKind)) throw new Error("unsupported evidenceKind");
  const evidenceId = stableId(input.evidenceId, "evidenceId");
  if (!DIGEST.test(input.evidenceDigest || "")) throw new Error("evidenceDigest must be a lowercase SHA-256 digest");
  const observedAt = exactTime(input.observedAt, "observedAt");
  const nowTime = new Date(now).getTime();
  if (new Date(observedAt).getTime() > nowTime) throw new Error("observedAt cannot be in the future");
  const expiresAt = input.expiresAt === null || input.expiresAt === undefined
    ? null : exactTime(input.expiresAt, "expiresAt");
  if (expiresAt && new Date(expiresAt).getTime() <= new Date(observedAt).getTime()) {
    throw new Error("expiresAt must be after observedAt");
  }
  const privacy = input.privacy || "private";
  if (!PRIVACY.has(privacy)) throw new Error("unsupported privacy");
  const groupId = optionalStableId(input.groupId, "groupId");
  if ((privacy === "group") !== Boolean(groupId)) throw new Error("group privacy requires exactly one groupId");
  const value = canonicalValue(input.value);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_VALUE_BYTES) throw new Error("value exceeds 8 KiB");
  const supersedes = [...new Set((input.supersedes || []).map((item) => stableId(item, "supersedes")))].sort();
  return {
    schema: ASSERTION_SCHEMA, id, subjectId, predicate: input.predicate, value,
    valueDigest: sha256(JSON.stringify(value)), evidenceKind: input.evidenceKind,
    evidenceId, evidenceDigest: input.evidenceDigest, observedAt, expiresAt,
    projectId: optionalStableId(input.projectId, "projectId"), groupId, privacy,
    supersedes, reason: typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "",
    status: input.evidenceKind === "model-suggestion" ? "proposed" : "established",
    recordedAt: new Date(now).toISOString(), authority: "context-only"
  };
}

function assertionDigest(assertion) {
  const { recordedAt: _recordedAt, ...material } = assertion;
  return sha256(JSON.stringify(material));
}

export async function recordWorldAssertion(input = {}) {
  const now = input.now || new Date();
  const candidate = assertionInput(input, now);
  const names = await stateNames(input.root || process.cwd());
  return withOwnedFileLock(names.lockPath, async ({ assertOwned }) => {
    const model = await readModel(names);
    const existing = model.assertions.find((item) => item.id === candidate.id);
    if (existing) {
      if (assertionDigest(existing) !== assertionDigest(candidate)) throw new Error(`world assertion id is already used: ${candidate.id}`);
      return { status: "duplicate", assertion: structuredClone(existing), revision: model.revision, authority: "context-only" };
    }
    for (const id of candidate.supersedes) {
      const previous = model.assertions.find((item) => item.id === id);
      if (!previous) throw new Error(`superseded assertion does not exist: ${id}`);
      if (previous.subjectId !== candidate.subjectId || previous.predicate !== candidate.predicate) {
        throw new Error("supersession must keep the same subject and predicate");
      }
      if (candidate.status !== "established") throw new Error("model suggestions cannot supersede established context");
    }
    model.revision += 1;
    model.assertions.push(candidate);
    model.events.push({ kind: candidate.supersedes.length ? "resolved" : "recorded", assertionId: candidate.id,
      supersedes: candidate.supersedes, at: candidate.recordedAt, authority: "context-only" });
    await writeModel(model, names, assertOwned);
    return { status: "recorded", assertion: structuredClone(candidate), revision: model.revision, authority: "context-only" };
  });
}

function visible(assertion, { includePrivate, groupId, projectId }) {
  if (assertion.privacy === "private" && (!includePrivate || groupId)) return false;
  if (assertion.privacy === "group" && assertion.groupId !== groupId) return false;
  return assertion.projectId === null || assertion.projectId === projectId;
}

function publicAssertion(assertion) {
  return structuredClone(assertion);
}

export async function worldContext({
  root = process.cwd(), subjectId = null, projectId = null, groupId = null,
  includePrivate = false, maxItems = 100, now = new Date()
} = {}) {
  if (groupId !== null && includePrivate) throw new Error("private world context cannot be assembled for a group audience");
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 500) throw new Error("maxItems must be between 1 and 500");
  subjectId = optionalStableId(subjectId, "subjectId");
  projectId = optionalStableId(projectId, "projectId");
  groupId = optionalStableId(groupId, "groupId");
  const names = await stateNames(root);
  const model = await readModel(names);
  const cutoff = new Date(now).getTime();
  if (!Number.isFinite(cutoff)) throw new Error("now is invalid");
  const candidates = model.assertions.filter((item) => visible(item, { includePrivate, groupId, projectId })
    && (!subjectId || item.subjectId === subjectId));
  const stale = candidates.filter((item) => item.expiresAt && new Date(item.expiresAt).getTime() <= cutoff);
  const current = candidates.filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > cutoff);
  const superseded = new Set(current.flatMap((item) => item.status === "established" ? item.supersedes : []));
  const active = current.filter((item) => !superseded.has(item.id));
  const proposals = active.filter((item) => item.status === "proposed");
  const established = active.filter((item) => item.status === "established");
  const buckets = new Map();
  for (const item of established) {
    const key = `${item.subjectId}\0${item.predicate}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const facts = [];
  const conflicts = [];
  for (const assertions of buckets.values()) {
    const values = new Set(assertions.map((item) => item.valueDigest));
    if (values.size > 1) {
      conflicts.push({ subjectId: assertions[0].subjectId, predicate: assertions[0].predicate,
        assertions: assertions.map(publicAssertion), authority: "context-only" });
      continue;
    }
    const newest = [...assertions].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    facts.push({ subjectId: newest.subjectId, predicate: newest.predicate, value: structuredClone(newest.value),
      assertionIds: assertions.map((item) => item.id).sort(), evidenceKinds: [...new Set(assertions.map((item) => item.evidenceKind))].sort(),
      latestObservedAt: newest.observedAt, expiresAt: newest.expiresAt, privacy: newest.privacy,
      groupId: newest.groupId, projectId: newest.projectId, authority: "context-only" });
  }
  const order = (left, right) => left.subjectId.localeCompare(right.subjectId) || left.predicate.localeCompare(right.predicate);
  facts.sort(order); conflicts.sort(order); proposals.sort(order); stale.sort(order);
  return {
    schema: "agentspine.world-context/v1", root: names.root, revision: model.revision,
    facts: facts.slice(0, maxItems), conflicts: conflicts.slice(0, maxItems),
    proposals: proposals.slice(0, maxItems).map(publicAssertion), stale: stale.slice(0, maxItems).map(publicAssertion),
    omitted: { facts: Math.max(0, facts.length - maxItems), conflicts: Math.max(0, conflicts.length - maxItems),
      proposals: Math.max(0, proposals.length - maxItems), stale: Math.max(0, stale.length - maxItems) },
    uncertainty: { requiresResolution: conflicts.length > 0, conflicts: conflicts.length,
      proposals: proposals.length, stale: stale.length },
    authority: "context-only",
    note: "Only unexpired, non-conflicting measured or explicitly user-confirmed assertions are facts. Model suggestions remain proposals and grant no authority."
  };
}

export async function worldModelStatePath(root = process.cwd()) {
  return (await stateNames(root)).path;
}
