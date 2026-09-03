import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";

const PROVENANCE_SCHEMA = "agentspine.gateway-policy-provenance/v1";
const REGISTRY_AUTHORITY = "context-only-contract-provenance";
const POLICY_SCHEMA = "agentspine.gateway-policy/v2";
const POLICY_BYTES = 8 * 1024 * 1024;
const PROVENANCE_BYTES = 8 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PROVENANCE_FILE_DIGEST = Symbol("gateway-policy-provenance-file-digest");
export const GOAL_PREMORTEM_CONTRACT = "agentspine.goal-premortem/v1";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}
function exactKeys(value, keys) {
  return value && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}
function seal(value) {
  return { ...value, digest: sha256(value) };
}
function validSeal(value) {
  if (!value || !DIGEST_RE.test(value.digest || "")) return false;
  const material = { ...value };
  delete material.digest;
  return value.digest === sha256(material);
}
function policyProvenance(root, policySchema, state, previousPolicyDigest, nextPolicyDigest) {
  return seal({ schema: PROVENANCE_SCHEMA, projectRootDigest: sha256(root), policySchema,
    contract: GOAL_PREMORTEM_CONTRACT, state, previousPolicyDigest, nextPolicyDigest,
    authority: REGISTRY_AUTHORITY });
}

export function validGatewayPolicyProvenance(value, root, policySchema) {
  return exactKeys(value, ["schema", "projectRootDigest", "policySchema", "contract", "state",
    "previousPolicyDigest", "nextPolicyDigest", "authority", "digest"])
    && value.schema === PROVENANCE_SCHEMA && value.projectRootDigest === sha256(root)
    && value.policySchema === policySchema && value.contract === GOAL_PREMORTEM_CONTRACT
    && new Set(["prepared", "committed"]).has(value.state)
    && (value.previousPolicyDigest === null || DIGEST_RE.test(value.previousPolicyDigest || ""))
    && DIGEST_RE.test(value.nextPolicyDigest || "")
    && value.authority === REGISTRY_AUTHORITY && validSeal(value);
}

async function readPolicyProvenance(path) {
  const provenancePath = join(dirname(path), "gateway-policy-provenance.json");
  try {
    const metadata = await stat(provenancePath);
    if (metadata.size > PROVENANCE_BYTES) throw new Error("gateway policy provenance exceeds 8 KiB");
    const text = await readFile(provenancePath, "utf8");
    if (Buffer.byteLength(text) > PROVENANCE_BYTES) throw new Error("gateway policy provenance exceeds 8 KiB");
    const value = JSON.parse(text);
    if (value && typeof value === "object") {
      Object.defineProperty(value, PROVENANCE_FILE_DIGEST, { value: sha256(text) });
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function currentGatewayDigest(path) {
  try { return sha256(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function atomicGatewayWrite(path, content, maximum = POLICY_BYTES, guard = {}) {
  if (Buffer.byteLength(content) > maximum) throw new Error("gateway state exceeds its byte limit");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path, { beforeAttempt: async () => {
      await guard.assertOwned?.();
      if (Object.hasOwn(guard, "expectedDigest")
        && await currentGatewayDigest(path) !== guard.expectedDigest) {
        throw new Error("gateway state predecessor changed before atomic replace");
      }
      await guard.assertRelated?.();
      await guard.assertOwned?.();
    } });
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
async function commitObservedPolicyProvenance(path, root, provenance, match, policyDigest, assertOwned) {
  if (provenance.state !== "prepared" || typeof assertOwned !== "function") return;
  const provenancePath = join(dirname(path), "gateway-policy-provenance.json");
  const priorDigest = match === "next" ? provenance.previousPolicyDigest : provenance.nextPolicyDigest;
  const committed = policyProvenance(root, provenance.policySchema, "committed", priorDigest, policyDigest);
  const assertObserved = async () => {
    if (await currentGatewayDigest(path) !== policyDigest) {
      throw new Error("gateway policy changed before prepared provenance recovery");
    }
  };
  await atomicGatewayWrite(provenancePath, `${JSON.stringify(committed, null, 2)}\n`, PROVENANCE_BYTES, {
    assertOwned, assertRelated: assertObserved, expectedDigest: provenance[PROVENANCE_FILE_DIGEST]
  });
}

export async function readGatewayJson(path, root, normalize, empty, guard = {}) {
  const policyFile = basename(path) === "gateway-policy.json";
  for (let attempt = 0; attempt < (policyFile ? 4 : 1); attempt += 1) {
    const provenance = policyFile ? await readPolicyProvenance(path) : null;
    let text;
    try {
      const metadata = await stat(path);
      if (metadata.size > POLICY_BYTES) throw new Error("gateway state exceeds 8 MiB");
      text = await readFile(path, "utf8");
      if (Buffer.byteLength(text) > POLICY_BYTES) throw new Error("gateway state exceeds 8 MiB");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const after = policyFile ? await readPolicyProvenance(path) : null;
      if (canonical(provenance) !== canonical(after)) continue;
      if (provenance && (!validGatewayPolicyProvenance(provenance, root, POLICY_SCHEMA)
        || provenance.state !== "prepared" || provenance.previousPolicyDigest !== null)) {
        throw new Error("gateway policy is missing while provenance exists");
      }
      if (provenance && typeof guard.assertOwned === "function") {
        const value = normalize(empty(root), root, { record: provenance, match: "previous" });
        await writeGatewayJson(path, value, { assertOwned: guard.assertOwned,
          afterWrite: guard.afterWrite, expectedDigest: null });
        return value;
      }
      return empty(root);
    }
    const after = policyFile ? await readPolicyProvenance(path) : null;
    if (canonical(provenance) !== canonical(after)) continue;
    let anchored = null;
    if (provenance) {
      if (!validGatewayPolicyProvenance(provenance, root, POLICY_SCHEMA)) {
        throw new Error("gateway policy provenance is invalid");
      }
      const policyDigest = sha256(text);
      const match = policyDigest === provenance.nextPolicyDigest ? "next"
        : policyDigest === provenance.previousPolicyDigest ? "previous" : null;
      if (!match) throw new Error("gateway policy does not match its persisted provenance");
      anchored = { record: provenance, match };
    }
    const parsed = JSON.parse(text);
    const legacyPolicy = policyFile && parsed?.schema === "agentspine.gateway-policy/v1";
    const value = normalize(parsed, root, anchored);
    if (legacyPolicy && typeof guard.assertOwned === "function") {
      await writeGatewayJson(path, value, { assertOwned: guard.assertOwned,
        afterWrite: guard.afterWrite, expectedDigest: sha256(text) });
      return value;
    }
    if (anchored) await commitObservedPolicyProvenance(path, root, provenance,
      anchored.match, sha256(text), guard.assertOwned);
    return value;
  }
  throw new Error("gateway policy changed during bounded provenance read");
}

export async function writeGatewayJson(path, value, guard = {}) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (basename(path) === "gateway-policy.json" && value.schema === POLICY_SCHEMA) {
    const provenancePath = join(dirname(path), "gateway-policy-provenance.json");
    const previousPolicyDigest = await currentGatewayDigest(path);
    if (Object.hasOwn(guard, "expectedDigest") && previousPolicyDigest !== guard.expectedDigest) {
      throw new Error("gateway state predecessor changed before policy provenance");
    }
    const nextPolicyDigest = sha256(content);
    const prepared = policyProvenance(value.root, value.schema, "prepared",
      previousPolicyDigest, nextPolicyDigest);
    const preparedContent = `${JSON.stringify(prepared, null, 2)}\n`;
    const previousProvenanceDigest = await currentGatewayDigest(provenancePath);
    const assertPreviousPolicy = async () => {
      if (await currentGatewayDigest(path) !== previousPolicyDigest) {
        throw new Error("gateway state predecessor changed before policy provenance");
      }
    };
    await atomicGatewayWrite(provenancePath, preparedContent, PROVENANCE_BYTES,
      { assertOwned: guard.assertOwned, assertRelated: assertPreviousPolicy,
        expectedDigest: previousProvenanceDigest });
    await atomicGatewayWrite(path, content, POLICY_BYTES, guard);
    const committed = policyProvenance(value.root, value.schema, "committed",
      previousPolicyDigest, nextPolicyDigest);
    const assertNextPolicy = async () => {
      if (await currentGatewayDigest(path) !== nextPolicyDigest) {
        throw new Error("gateway policy changed before provenance commit");
      }
    };
    await atomicGatewayWrite(provenancePath, `${JSON.stringify(committed, null, 2)}\n`, PROVENANCE_BYTES,
      { assertOwned: guard.assertOwned, assertRelated: assertNextPolicy,
        expectedDigest: sha256(preparedContent) });
    await guard.afterWrite?.(nextPolicyDigest);
    return;
  }
  await atomicGatewayWrite(path, content, POLICY_BYTES, guard);
  await guard.afterWrite?.(sha256(content));
}
