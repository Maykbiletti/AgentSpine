import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { replaceFileWithRetry } from "./filesystem-retry.js";
import { readGatewayJson, writeGatewayJson } from "./gateway-policy-provenance.js";
import { withOwnedFileLock } from "./owned-file-lock.js";

const TRANSACTION_SCHEMA = "agentspine.gateway-state-transaction/v1";
const AUTHORITY = "state-coordination-only";
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSACTION_BYTES = 16 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STAGE_RE = /^gateway-pair-[a-f0-9-]{36}-(?:policy|runtime)\.next\.json$/;
const contextStore = new AsyncLocalStorage();
const testHookStore = new AsyncLocalStorage();

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stateContent(value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("gateway state exceeds 8 MiB");
  return content;
}

async function fileDigest(path, maximum = MAX_STATE_BYTES) {
  try {
    const metadata = await stat(path);
    if (metadata.size > maximum) throw new Error("gateway transaction file exceeds its byte limit");
    return sha256(await readFile(path));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readBounded(path, maximum) {
  const metadata = await stat(path);
  if (metadata.size > maximum) throw new Error("gateway transaction file exceeds its byte limit");
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content) > maximum) throw new Error("gateway transaction file exceeds its byte limit");
  return content;
}

function transactionPaths(paths, transactionId = null) {
  const prefix = transactionId ? `gateway-pair-${transactionId}` : null;
  return {
    lockPath: join(paths.directory, "gateway-runtime.lock"),
    journalPath: join(paths.directory, "gateway-state-transaction.json"),
    policyStagePath: prefix ? join(paths.directory, `${prefix}-policy.next.json`) : null,
    runtimeStagePath: prefix ? join(paths.directory, `${prefix}-runtime.next.json`) : null
  };
}

function transactionMaterial(value) {
  return {
    schema: value.schema,
    transactionId: value.transactionId,
    projectRootDigest: value.projectRootDigest,
    before: value.before,
    after: value.after,
    stages: value.stages,
    authority: value.authority
  };
}

function exactKeys(value, keys) {
  return value && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

function validDigestPair(value, nullable) {
  return exactKeys(value, ["policy", "runtime"])
    && [value.policy, value.runtime].every((digest) => (nullable && digest === null) || DIGEST_RE.test(digest || ""));
}

function validTransaction(value, paths) {
  if (!exactKeys(value, ["schema", "transactionId", "projectRootDigest", "before", "after", "stages", "authority", "digest"])
    || value.schema !== TRANSACTION_SCHEMA || !UUID_RE.test(value.transactionId || "")
    || value.projectRootDigest !== sha256(paths.catalog.root) || value.authority !== AUTHORITY
    || !validDigestPair(value.before, true) || !validDigestPair(value.after, false)
    || !exactKeys(value.stages, ["policy", "runtime"])) return false;
  const expected = transactionPaths(paths, value.transactionId);
  return value.stages.policy === basename(expected.policyStagePath)
    && value.stages.runtime === basename(expected.runtimeStagePath)
    && value.digest === sha256(canonical(transactionMaterial(value)));
}

async function atomicWrite(path, content, { assertOwned, beforeFinalCheck, expectedDigest, maximum }) {
  if (Buffer.byteLength(content) > maximum) throw new Error("gateway transaction file exceeds its byte limit");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path, { beforeAttempt: async () => {
      await assertOwned();
      if (await fileDigest(path, maximum) !== expectedDigest) {
        throw new Error("gateway transaction predecessor changed before atomic replace");
      }
      await beforeFinalCheck?.();
      await assertOwned();
    } });
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function writeStage(path, content, assertOwned) {
  await assertOwned();
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
}

async function readTransaction(paths) {
  const { journalPath } = transactionPaths(paths);
  try {
    const value = JSON.parse(await readBounded(journalPath, MAX_TRANSACTION_BYTES));
    if (!validTransaction(value, paths)) throw new Error("gateway state transaction journal is invalid");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("gateway state transaction journal is invalid");
    throw error;
  }
}

async function readStage(path, expectedDigest, schema, root) {
  const content = await readBounded(path, MAX_STATE_BYTES);
  if (sha256(content) !== expectedDigest) throw new Error("gateway state transaction stage digest mismatch");
  let value;
  try { value = JSON.parse(content); }
  catch { throw new Error("gateway state transaction stage is invalid"); }
  if (value?.schema !== schema || value.root !== root) throw new Error("gateway state transaction stage scope mismatch");
  return { content, value };
}

async function currentPair(paths) {
  return {
    policy: await fileDigest(paths.gatewayPolicyPath),
    runtime: await fileDigest(paths.gatewayRuntimePath)
  };
}

function pairMatches(pair, expected) {
  return pair.policy === expected.policy && pair.runtime === expected.runtime;
}

function pairWithinTransaction(pair, transaction) {
  return ["policy", "runtime"].every((key) =>
    pair[key] === transaction.before[key] || pair[key] === transaction.after[key]);
}

async function removeTransactionFiles(paths, transaction, assertOwned) {
  const names = transactionPaths(paths, transaction.transactionId);
  await assertOwned();
  await unlink(names.journalPath);
  await Promise.all([names.policyStagePath, names.runtimeStagePath].map((path) =>
    unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; })));
}

async function runTestHook(context, phase) {
  if (typeof context.testHook === "function") await context.testHook(phase, {
    paths: context.paths,
    transactionId: context.transactionId || null
  });
}

async function validateStatePair(context, policy, runtime) {
  if (typeof context.validatePair !== "function") {
    throw new Error("gateway state pair validation is unavailable");
  }
  await context.validatePair(structuredClone(policy), structuredClone(runtime));
}

async function installTransaction(context, transaction) {
  const paths = context.paths;
  const names = transactionPaths(paths, transaction.transactionId);
  const [policyStage, runtimeStage] = await Promise.all([
    readStage(names.policyStagePath, transaction.after.policy, "agentspine.gateway-policy/v2", paths.catalog.root),
    readStage(names.runtimeStagePath, transaction.after.runtime, "agentspine.gateway-runtime/v1", paths.catalog.root)
  ]);
  await validateStatePair(context, policyStage.value, runtimeStage.value);
  const current = await currentPair(paths);
  if (!pairWithinTransaction(current, transaction)) {
    throw new Error("gateway state changed outside the prepared transaction");
  }
  await writeGatewayJson(paths.gatewayPolicyPath, policyStage.value, {
    assertOwned: context.assertOwned,
    expectedDigest: current.policy
  });
  await runTestHook(context, "after-policy-install");
  const runtimeBase = await fileDigest(paths.gatewayRuntimePath);
  if (![transaction.before.runtime, transaction.after.runtime].includes(runtimeBase)) {
    throw new Error("gateway runtime changed outside the prepared transaction");
  }
  await writeGatewayJson(paths.gatewayRuntimePath, runtimeStage.value, {
    assertOwned: context.assertOwned,
    expectedDigest: runtimeBase
  });
  await runTestHook(context, "after-runtime-install");
  if (!pairMatches(await currentPair(paths), transaction.after)) {
    throw new Error("gateway state transaction did not install the exact pair");
  }
  await removeTransactionFiles(paths, transaction, context.assertOwned);
  context.expected = { ...transaction.after };
}

async function cleanOrphanStages(paths, assertOwned) {
  let entries;
  try { entries = await readdir(paths.directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries.filter((item) => item.isFile() && STAGE_RE.test(item.name)).slice(0, 64)) {
    await assertOwned();
    await unlink(join(paths.directory, entry.name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function recoverPreparedTransaction(context) {
  const transaction = await readTransaction(context.paths);
  if (!transaction) {
    await cleanOrphanStages(context.paths, context.assertOwned);
    return;
  }
  context.transactionId = transaction.transactionId;
  await installTransaction(context, transaction);
  context.transactionId = null;
}

export async function withGatewayStateLock(paths, task, options = {}) {
  if (!paths?.catalog?.root || !paths.directory || typeof task !== "function") {
    throw new Error("gateway state lock requires exact paths and a task");
  }
  const names = transactionPaths(paths);
  const lockOptions = options.lockOptions || {
    staleAfterMs: 120000,
    heartbeatIntervalMs: 1000,
    retryDelayMs: 25,
    maxAttempts: 160
  };
  return withOwnedFileLock(names.lockPath, async ({ assertOwned, token }) => {
    const context = { paths, assertOwned, token, expected: null, validatePair: options.validatePair || null,
      transactionId: null, testHook: options.testHook || testHookStore.getStore() || null };
    return contextStore.run(context, async () => {
      await recoverPreparedTransaction(context);
      context.expected = await currentPair(paths);
      const result = await task();
      await assertOwned();
      if (!pairMatches(await currentPair(paths), context.expected)
        || await fileDigest(names.journalPath, MAX_TRANSACTION_BYTES) !== null) {
        throw new Error("gateway state changed outside its owned transaction");
      }
      return result;
    });
  }, lockOptions);
}

export async function withGatewayStateTestHook(testHook, task) {
  if (typeof testHook !== "function" || typeof task !== "function") {
    throw new Error("gateway state test hook requires two functions");
  }
  return testHookStore.run(testHook, task);
}

function activeContext() {
  const context = contextStore.getStore();
  if (!context) throw new Error("gateway state write requires the owned gateway lock");
  return context;
}

function stateKey(context, path) {
  if (path === context.paths.gatewayPolicyPath) return "policy";
  if (path === context.paths.gatewayRuntimePath) return "runtime";
  throw new Error("gateway state write target is outside the bound pair");
}

export async function writeGatewayStateJson(path, value) {
  const context = activeContext();
  const key = stateKey(context, path);
  await writeGatewayJson(path, value, {
    assertOwned: context.assertOwned,
    expectedDigest: context.expected[key]
  });
  context.expected[key] = sha256(stateContent(value));
}

export async function readGatewayStateJson(path, root, normalize, empty) {
  const context = activeContext();
  const key = stateKey(context, path);
  return readGatewayJson(path, root, normalize, empty, { assertOwned: context.assertOwned,
    afterWrite: (digest) => { context.expected[key] = digest; } });
}

export async function writeGatewayStatePair(policy, runtime) {
  const context = activeContext();
  const paths = context.paths;
  if (policy?.root !== paths.catalog.root || runtime?.root !== paths.catalog.root
    || policy?.schema !== "agentspine.gateway-policy/v2"
    || runtime?.schema !== "agentspine.gateway-runtime/v1") {
    throw new Error("gateway state transaction pair has an invalid scope or schema");
  }
  await validateStatePair(context, policy, runtime);
  if (!pairMatches(await currentPair(paths), context.expected)) {
    throw new Error("gateway state predecessor changed before transaction prepare");
  }
  const transactionId = randomUUID();
  const names = transactionPaths(paths, transactionId);
  const policyContent = stateContent(policy);
  const runtimeContent = stateContent(runtime);
  await writeStage(names.policyStagePath, policyContent, context.assertOwned);
  try {
    await writeStage(names.runtimeStagePath, runtimeContent, context.assertOwned);
    const material = {
      schema: TRANSACTION_SCHEMA,
      transactionId,
      projectRootDigest: sha256(paths.catalog.root),
      before: { ...context.expected },
      after: { policy: sha256(policyContent), runtime: sha256(runtimeContent) },
      stages: { policy: basename(names.policyStagePath), runtime: basename(names.runtimeStagePath) },
      authority: AUTHORITY
    };
    const transaction = { ...material, digest: sha256(canonical(material)) };
    await atomicWrite(names.journalPath, `${JSON.stringify(transaction, null, 2)}\n`, {
      assertOwned: context.assertOwned,
      beforeFinalCheck: () => runTestHook(context, "after-journal-predecessor-check"),
      expectedDigest: null,
      maximum: MAX_TRANSACTION_BYTES
    });
    context.transactionId = transactionId;
    await runTestHook(context, "after-prepare");
    await installTransaction(context, transaction);
    context.transactionId = null;
  } catch (error) {
    if (!await fileDigest(names.journalPath, MAX_TRANSACTION_BYTES)) {
      await Promise.all([names.policyStagePath, names.runtimeStagePath].map((path) =>
        unlink(path).catch((cleanupError) => { if (cleanupError.code !== "ENOENT") throw cleanupError; })));
    }
    throw error;
  }
}

export async function inspectGatewayStateTransaction(paths) {
  try {
    const transaction = await readTransaction(paths);
    return { status: transaction ? "prepared" : "none", transaction };
  } catch (error) {
    return { status: "invalid", transaction: null, error: error.message };
  }
}
