import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePremortemFile } from "./delivery-premortem-file.js";
import { canonicalPremortem as canonical, premortemMismatchError as mismatchError,
  premortemSha256 as sha256 } from "./delivery-premortem-codec.js";

const SCHEMA = "agentspine.delivery-premortem-write-index/v2";
const AUTHORITY = "context-only";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const EDGE_RE = /^[a-f0-9]{2}$/;
const MAX_RECENT_WRITE_IDS = 64;
const MAX_NODE_BYTES = 64 * 1024;
const BUCKET_KEYS = ["authority", "depth", "digest", "entries", "kind", "prefix", "schema"];
const BRANCH_KEYS = ["authority", "children", "depth", "digest", "kind", "prefix", "schema"];

function validEntry(entry) {
  return entry && DIGEST_RE.test(entry.idDigest || "")
    && DIGEST_RE.test(entry.inputDigest || "") && DIGEST_RE.test(entry.writeDigest || "")
    && typeof entry.inputKnown === "boolean"
    && Object.keys(entry).sort().join(",") === "idDigest,inputDigest,inputKnown,writeDigest";
}

function writeEntry(write) {
  const entry = { idDigest: write?.idDigest, inputDigest: write?.inputDigest,
    inputKnown: write?.inputKnown, writeDigest: write?.writeDigest || write?.digest };
  if (!validEntry(entry)) throw new Error("premortem write identity is invalid");
  return entry;
}

export function findPremortemWrite(entries, idDigest) {
  return entries.find((entry) => entry.idDigest === idDigest) || null;
}

export function premortemWriteIsLedgered(entries, write) {
  const entry = findPremortemWrite(entries, write?.idDigest);
  return entry?.inputDigest === write?.inputDigest && entry?.inputKnown === write?.inputKnown
    && entry?.writeDigest === write?.digest;
}

export function validPremortemWriteLedger(entries, firstWrite = null, lastWrite = null) {
  return Array.isArray(entries) && entries.length <= MAX_RECENT_WRITE_IDS
    && new Set(entries.map((entry) => entry?.idDigest)).size === entries.length
    && entries.every(validEntry) && (!lastWrite || premortemWriteIsLedgered(entries, lastWrite))
    && (!firstWrite || entries.length === MAX_RECENT_WRITE_IDS
      || premortemWriteIsLedgered(entries, firstWrite));
}

export function appendPremortemWrite(entries, write) {
  if (entries.length >= MAX_RECENT_WRITE_IDS) entries.shift();
  entries.push(writeEntry(write));
}

function indexDirectory(statePath, laneDigest) {
  if (!DIGEST_RE.test(laneDigest || "")) throw new Error("premortem write lane is invalid");
  return join(dirname(dirname(statePath)), "delivery-premortem-write-index", laneDigest, "nodes");
}

export function deliveryPremortemWriteNodePath(statePath, laneDigest, nodeDigest) {
  if (!DIGEST_RE.test(nodeDigest || "")) throw new Error("premortem write node digest is invalid");
  return join(indexDirectory(statePath, laneDigest), `${nodeDigest}.json`);
}

function nodeMaterial(kind, depth, prefix, payload) {
  return { schema: SCHEMA, kind, depth, prefix, ...payload, authority: AUTHORITY };
}

function sealedNode(kind, depth, prefix, payload) {
  const material = nodeMaterial(kind, depth, prefix, payload);
  return { ...material, digest: sha256(material) };
}

function nodeBytes(node) {
  return Buffer.byteLength(`${JSON.stringify(node, null, 2)}\n`);
}

function validDepth(depth) {
  return Number.isInteger(depth) && depth >= 0 && depth <= 64 && depth % 2 === 0;
}

function validNode(value, expectedDigest, expectedDepth, expectedPrefix) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== SCHEMA || value.authority !== AUTHORITY
    || value.digest !== expectedDigest || value.depth !== expectedDepth
    || value.prefix !== expectedPrefix || !validDepth(value.depth)
    || typeof value.prefix !== "string" || value.prefix.length !== value.depth
    || !/^[a-f0-9]*$/.test(value.prefix)) return false;
  const keys = value.kind === "bucket" ? BUCKET_KEYS : value.kind === "branch" ? BRANCH_KEYS : [];
  if (canonical(Object.keys(value).sort()) !== canonical(keys)) return false;
  if (value.kind === "bucket") {
    if (!Array.isArray(value.entries) || !value.entries.length
      || !value.entries.every(validEntry)
      || !value.entries.every((entry) => entry.idDigest.startsWith(value.prefix))
      || new Set(value.entries.map((entry) => entry.idDigest)).size !== value.entries.length
      || canonical(value.entries) !== canonical([...value.entries]
        .sort((left, right) => left.idDigest.localeCompare(right.idDigest)))) return false;
  } else {
    if (value.depth >= 64 || !value.children || typeof value.children !== "object"
      || Array.isArray(value.children)) return false;
    const edges = Object.keys(value.children);
    if (!edges.length || edges.length > 256 || !edges.every((edge) => EDGE_RE.test(edge)
      && DIGEST_RE.test(value.children[edge] || ""))
      || new Set(Object.values(value.children)).size !== edges.length) return false;
  }
  const material = { ...value };
  delete material.digest;
  return value.digest === sha256(material) && nodeBytes(value) <= MAX_NODE_BYTES;
}

async function readNode(statePath, laneDigest, nodeDigest, depth, prefix) {
  const path = deliveryPremortemWriteNodePath(statePath, laneDigest, nodeDigest);
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_NODE_BYTES) {
      throw mismatchError("premortem write index node exceeds 64 KiB");
    }
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("premortem write index node is not valid JSON"); }
    if (!validNode(value, nodeDigest, depth, prefix)) {
      throw mismatchError("premortem write index node failed integrity validation");
    }
    return { path, value };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw mismatchError("premortem write index references a missing node");
    }
    throw error;
  }
}

async function saveNode(statePath, laneDigest, node, assertOwned) {
  const directory = indexDirectory(statePath, laneDigest);
  const path = deliveryPremortemWriteNodePath(statePath, laneDigest, node.digest);
  await assertOwned();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = await readNode(statePath, laneDigest, node.digest, node.depth, node.prefix);
    if (canonical(existing.value) !== canonical(node)) {
      throw mismatchError("premortem write index node conflicts with its digest");
    }
    return node.digest;
  } catch (error) {
    if (error.code !== "AGENTSPINE_PREMORTEM_MISMATCH"
      || !/references a missing node/.test(error.message)) throw error;
  }
  await writePremortemFile(path, node, assertOwned, MAX_NODE_BYTES);
  return node.digest;
}

function bucket(depth, prefix, entries) {
  return sealedNode("bucket", depth, prefix, { entries: [...entries]
    .sort((left, right) => left.idDigest.localeCompare(right.idDigest)) });
}

function branch(depth, prefix, children) {
  return sealedNode("branch", depth, prefix, { children: Object.fromEntries(
    Object.entries(children).sort(([left], [right]) => left.localeCompare(right))) });
}

async function buildNode(statePath, laneDigest, depth, prefix, entries, assertOwned) {
  const candidate = bucket(depth, prefix, entries);
  if (nodeBytes(candidate) <= MAX_NODE_BYTES) {
    await saveNode(statePath, laneDigest, candidate, assertOwned);
    return candidate.digest;
  }
  if (depth >= 64) throw new Error("premortem write index bucket could not be split");
  const grouped = new Map();
  for (const entry of entries) {
    const edge = entry.idDigest.slice(depth, depth + 2);
    if (!grouped.has(edge)) grouped.set(edge, []);
    grouped.get(edge).push(entry);
  }
  const children = {};
  for (const [edge, group] of grouped) {
    children[edge] = await buildNode(statePath, laneDigest, depth + 2,
      `${prefix}${edge}`, group, assertOwned);
  }
  const candidateBranch = branch(depth, prefix, children);
  await saveNode(statePath, laneDigest, candidateBranch, assertOwned);
  return candidateBranch.digest;
}

async function insertNode(statePath, laneDigest, nodeDigest, depth, prefix, entry, assertOwned) {
  if (!nodeDigest) return buildNode(statePath, laneDigest, depth, prefix, [entry], assertOwned);
  const { value } = await readNode(statePath, laneDigest, nodeDigest, depth, prefix);
  if (value.kind === "bucket") {
    const prior = findPremortemWrite(value.entries, entry.idDigest);
    if (prior) {
      if (canonical(prior) !== canonical(entry)) {
        throw mismatchError("premortem write index has conflicting input for an existing ID");
      }
      return nodeDigest;
    }
    return buildNode(statePath, laneDigest, depth, prefix, [...value.entries, entry], assertOwned);
  }
  const edge = entry.idDigest.slice(depth, depth + 2);
  const next = await insertNode(statePath, laneDigest, value.children[edge] || null,
    depth + 2, `${prefix}${edge}`, entry, assertOwned);
  return saveNode(statePath, laneDigest,
    branch(depth, prefix, { ...value.children, [edge]: next }), assertOwned);
}

export async function inspectPremortemWriteProof({ statePath, laneDigest, rootDigest, idDigest }) {
  if (!DIGEST_RE.test(idDigest || "")) throw new Error("premortem write ID is invalid");
  if (rootDigest === null) return { entry: null, paths: [] };
  if (!DIGEST_RE.test(rootDigest || "")) throw mismatchError("premortem write index root is invalid");
  let digest = rootDigest;
  let depth = 0;
  let prefix = "";
  const paths = [];
  while (digest) {
    const loaded = await readNode(statePath, laneDigest, digest, depth, prefix);
    paths.push(loaded.path);
    if (loaded.value.kind === "bucket") {
      return { entry: findPremortemWrite(loaded.value.entries, idDigest), paths };
    }
    const edge = idDigest.slice(depth, depth + 2);
    digest = loaded.value.children[edge] || null;
    prefix += edge;
    depth += 2;
  }
  return { entry: null, paths };
}

export async function readPremortemWriteIndex(input) {
  return (await inspectPremortemWriteProof(input)).entry;
}

export async function verifyPremortemWriteIndex({ statePath, state }) {
  const writes = [state.firstWrite, state.lastWrite]
    .filter((write, index, all) => write && all.findIndex((item) => item?.idDigest === write.idDigest) === index);
  for (const write of writes) {
    const entry = await readPremortemWriteIndex({ statePath, laneDigest: state.laneDigest,
      rootDigest: state.writeIndexRoot, idDigest: write.idDigest });
    if (!entry || entry.inputDigest !== write.inputDigest || entry.inputKnown !== write.inputKnown
      || entry.writeDigest !== write.digest) {
      throw mismatchError("premortem write index does not prove a bound write");
    }
  }
  return true;
}

export async function inspectPremortemWriteIndexes({ statePath, state, maxNodes = 512 }) {
  const directory = indexDirectory(statePath, state.laneDigest);
  const result = { directory, paths: [], nodes: [], errors: [], truncations: [] };
  if (!state.writeIndexRoot) return result;
  const pending = [{ digest: state.writeIndexRoot, depth: 0, prefix: "" }];
  const seen = new Set();
  while (pending.length && seen.size < maxNodes) {
    const current = pending.shift();
    if (seen.has(current.digest)) continue;
    seen.add(current.digest);
    const path = deliveryPremortemWriteNodePath(statePath, state.laneDigest, current.digest);
    result.paths.push(path);
    try {
      const loaded = await readNode(statePath, state.laneDigest, current.digest,
        current.depth, current.prefix);
      result.nodes.push(structuredClone(loaded.value));
      if (loaded.value.kind === "branch") {
        for (const [edge, digest] of Object.entries(loaded.value.children)) {
          pending.push({ digest, depth: current.depth + 2, prefix: `${current.prefix}${edge}` });
        }
      }
    } catch (error) {
      result.errors.push({ path, reason: String(error.message).slice(0, 400),
        code: typeof error.code === "string" ? error.code : null });
    }
  }
  if (pending.length) result.truncations.push({ path: directory,
    reason: `limited to ${maxNodes} reachable write-index nodes` });
  try { await verifyPremortemWriteIndex({ statePath, state }); } catch (error) {
    result.errors.push({ path: statePath, reason: String(error.message).slice(0, 400),
      code: typeof error.code === "string" ? error.code : null });
  }
  return result;
}

export async function appendPremortemWriteIndex({ statePath, laneDigest, rootDigest,
  write, assertOwned }) {
  if (rootDigest !== null && !DIGEST_RE.test(rootDigest || "")) {
    throw mismatchError("premortem write index root is invalid");
  }
  const entry = writeEntry(write);
  const nextRoot = await insertNode(statePath, laneDigest, rootDigest, 0, "", entry, assertOwned);
  return { rootDigest: nextRoot, entry };
}
