import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningIdentity, trustSigner } from "../src/lib/authentication.js";
import { proposeLearning, reviewLearning } from "../src/lib/learning.js";
import { initDirectoryAdapter, publishLearning, sharedContext, sharedInbox } from "../src/lib/sharing.js";
import {
  initSqliteAdapter, inspectSqliteAdapter, publishSqliteSnapshot, pullSqliteSnapshot
} from "../src/lib/sqlite-transport.js";

const sqlite = await import("node:sqlite").catch(() => null);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const sqliteSupported = sqlite && (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13));
const sqliteOnly = { skip: sqliteSupported ? false : "hardened node:sqlite options require Node.js 22.13 or newer" };

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const publisher = await mkdtemp(join(tmpdir(), "agentspine-sqlite-publisher-"));
  const receiver = await mkdtemp(join(tmpdir(), "agentspine-sqlite-receiver-"));
  const state = await mkdtemp(join(tmpdir(), "agentspine-sqlite-state-"));
  const adapter = await mkdtemp(join(tmpdir(), "agentspine-sqlite-adapter-"));
  const transport = await mkdtemp(join(tmpdir(), "agentspine-sqlite-db-"));
  const database = join(transport, "shared.sqlite");
  process.env.AGENTSPINE_STATE_DIR = state;
  t.after(async () => {
    await rm(publisher, { recursive: true }); await rm(receiver, { recursive: true });
    await rm(state, { recursive: true }); await rm(adapter, { recursive: true });
    await rm(transport, { recursive: true });
  });
  await writeFile(join(publisher, "AGENTS.md"), "# SQLite publisher\n\nPreserve exactly.\n", "utf8");
  await writeFile(join(receiver, "CLAUDE.md"), "# SQLite receiver\n\nPreserve exactly.\n", "utf8");
  const publicOut = join(state, "sqlite-signer.json");
  await generateSigningIdentity({
    root: publisher, signerId: "signer:sqlite", publicOut,
    confirmation: "local-share-confirmed", now: new Date("2030-01-01T00:00:00.000Z")
  });
  await trustSigner({
    root: receiver, publicIdentityPath: publicOut,
    confirmation: "local-share-confirmed", now: new Date("2030-01-01T00:00:01.000Z")
  });
  await initDirectoryAdapter({
    root: publisher, directory: adapter, scopeId: "team:sqlite", adapterId: "adapter:sqlite",
    signerId: "signer:sqlite", confirmation: "local-share-confirmed",
    now: new Date("2030-01-01T00:00:02.000Z")
  });
  await proposeLearning({
    root: publisher, id: "learning:sqlite", kind: "project-fact",
    claim: "The synthetic SQLite adapter stores verified snapshots.", privacy: "shared",
    evidence: { id: "evidence:sqlite", type: "test", summary: "Synthetic SQLite evidence.", confidence: 1 }
  });
  await reviewLearning({
    root: publisher, id: "learning:sqlite", decision: "accept",
    reason: "Synthetic confirmation.", confirmedByUser: true
  });
  await publishLearning({
    root: publisher, directory: adapter, learningId: "learning:sqlite", eventId: "shared:sqlite",
    signerId: "signer:sqlite", confirmation: "local-share-confirmed",
    now: new Date("2030-01-01T00:00:03.000Z")
  });
  return { publisher, receiver, state, adapter, transport, database };
}

async function initialized(t) {
  const value = await fixture(t);
  await initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: value.database,
    confirmation: "local-share-confirmed", now: new Date("2030-01-02T00:00:00.000Z")
  });
  return value;
}

test("SQLite snapshots retain signed revisions and import only into quarantine", sqliteOnly, async (t) => {
  const value = await initialized(t);
  const beforePublisher = hash(await readFile(join(value.publisher, "AGENTS.md")));
  const beforeReceiver = hash(await readFile(join(value.receiver, "CLAUDE.md")));
  const published = await publishSqliteSnapshot({
    root: value.publisher, directory: value.adapter, database: value.database,
    snapshotId: "snapshot:sqlite-one", confirmation: "local-share-confirmed",
    now: new Date("2030-01-02T00:00:01.000Z")
  });
  assert.equal(published.created, true);
  assert.equal(published.sequence, 1);
  assert.equal(published.authority, "context-only");
  const inspected = await inspectSqliteAdapter({ root: value.publisher, database: value.database });
  assert.equal(inspected.revisions, 1);
  assert.equal(inspected.head.snapshotDigest, published.snapshotDigest);
  const pulled = await pullSqliteSnapshot({
    root: value.receiver, database: value.database, now: new Date("2030-01-02T00:00:02.000Z")
  });
  assert.equal(pulled.transport, "sqlite");
  assert.deepEqual(pulled.imported, ["shared:sqlite"]);
  assert.equal((await sharedContext({ root: value.receiver })).items.length, 0);
  assert.equal((await sharedInbox({ root: value.receiver })).items[0].id, "shared:sqlite");
  assert.equal(hash(await readFile(join(value.publisher, "AGENTS.md"))), beforePublisher);
  assert.equal(hash(await readFile(join(value.receiver, "CLAUDE.md"))), beforeReceiver);
});

test("publication is idempotent and later snapshots append a hash-linked history", sqliteOnly, async (t) => {
  const value = await initialized(t);
  const firstOptions = {
    root: value.publisher, directory: value.adapter, database: value.database,
    snapshotId: "snapshot:sqlite-idempotent", confirmation: "local-share-confirmed",
    now: new Date("2030-01-02T00:00:01.000Z")
  };
  const first = await publishSqliteSnapshot(firstOptions);
  const duplicate = await publishSqliteSnapshot(firstOptions);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.revisionDigest, first.revisionDigest);
  const second = await publishSqliteSnapshot({
    ...firstOptions, snapshotId: "snapshot:sqlite-two", now: new Date("2030-01-02T00:00:02.000Z")
  });
  assert.equal(second.sequence, 2);
  assert.equal(second.previousRevisionDigest, first.revisionDigest);
  const inspected = await inspectSqliteAdapter({ root: value.publisher, database: value.database });
  assert.equal(inspected.revisions, 2);
  assert.equal(inspected.snapshots[1].previousRevisionDigest, inspected.snapshots[0].revisionDigest);
});

test("tampered snapshot, head, and unexpected schema objects fail closed", sqliteOnly, async (t) => {
  const value = await initialized(t);
  await publishSqliteSnapshot({
    root: value.publisher, directory: value.adapter, database: value.database,
    snapshotId: "snapshot:sqlite-tamper", confirmation: "local-share-confirmed"
  });
  let connection = new sqlite.DatabaseSync(value.database);
  connection.prepare("UPDATE agentspine_revisions SET snapshot_json = ? WHERE sequence = 1").run('{"schema":"tampered"}');
  connection.close();
  const tamperedBytes = hash(await readFile(value.database));
  await assert.rejects(inspectSqliteAdapter({ root: value.publisher, database: value.database }), /snapshot|integrity/i);
  await assert.rejects(publishSqliteSnapshot({
    root: value.publisher, directory: value.adapter, database: value.database,
    snapshotId: "snapshot:must-not-repair", confirmation: "local-share-confirmed"
  }), /snapshot|integrity/i);
  assert.equal(hash(await readFile(value.database)), tamperedBytes);

  await rm(value.database);
  await initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: value.database,
    confirmation: "local-share-confirmed"
  });
  await publishSqliteSnapshot({
    root: value.publisher, directory: value.adapter, database: value.database,
    snapshotId: "snapshot:sqlite-head", confirmation: "local-share-confirmed"
  });
  connection = new sqlite.DatabaseSync(value.database);
  connection.prepare("UPDATE agentspine_head SET sequence = 99 WHERE id = 1").run();
  connection.close();
  await assert.rejects(inspectSqliteAdapter({ root: value.publisher, database: value.database }), /head/);

  await rm(value.database);
  await initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: value.database,
    confirmation: "local-share-confirmed"
  });
  connection = new sqlite.DatabaseSync(value.database);
  connection.exec("CREATE TRIGGER hostile AFTER INSERT ON agentspine_revisions BEGIN DELETE FROM agentspine_meta; END;");
  connection.close();
  await assert.rejects(inspectSqliteAdapter({ root: value.publisher, database: value.database }), /unexpected objects/);

  connection = new sqlite.DatabaseSync(value.database);
  connection.exec("DROP TRIGGER hostile; ALTER TABLE agentspine_head ADD COLUMN extra TEXT;");
  connection.close();
  await assert.rejects(inspectSqliteAdapter({ root: value.publisher, database: value.database }), /table layout/);
});

test("adapter identity is permanently bound to the signed manifest", sqliteOnly, async (t) => {
  const value = await initialized(t);
  const otherAdapter = await mkdtemp(join(tmpdir(), "agentspine-sqlite-other-adapter-"));
  t.after(() => rm(otherAdapter, { recursive: true }));
  await initDirectoryAdapter({
    root: value.publisher, directory: otherAdapter, scopeId: "team:other", adapterId: "adapter:other",
    signerId: "signer:sqlite", confirmation: "local-share-confirmed"
  });
  await assert.rejects(initSqliteAdapter({
    root: value.publisher, directory: otherAdapter, database: value.database,
    confirmation: "local-share-confirmed"
  }), /different signed adapter/);
});

test("database paths inside a project, symbolic links, and hard links are rejected", sqliteOnly, async (t) => {
  const value = await fixture(t);
  await assert.rejects(initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: join(value.publisher, "memory.sqlite"),
    confirmation: "local-share-confirmed"
  }), /outside the scanned project/);
  const real = join(value.transport, "real.sqlite");
  await writeFile(real, "not a database");
  const alias = join(value.transport, "alias.sqlite");
  await symlink(real, alias);
  await assert.rejects(initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: alias,
    confirmation: "local-share-confirmed"
  }), /real regular file/);
  const protectedSource = join(value.publisher, "AGENTS.md");
  const before = hash(await readFile(protectedSource));
  const hardlink = join(value.transport, "hardlink.sqlite");
  await link(protectedSource, hardlink);
  await assert.rejects(initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: hardlink,
    confirmation: "local-share-confirmed"
  }), /must not be a hard link/);
  assert.equal(hash(await readFile(protectedSource)), before);
  await symlink(protectedSource, `${value.database}-journal`);
  await assert.rejects(initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: value.database,
    confirmation: "local-share-confirmed"
  }), /sidecar exists without its database/);
  assert.equal(hash(await readFile(protectedSource)), before);
});

test("all database writes require local confirmation", sqliteOnly, async (t) => {
  const value = await fixture(t);
  await assert.rejects(initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: value.database
  }), /explicit local owner confirmation/);
  await initSqliteAdapter({
    root: value.publisher, directory: value.adapter, database: value.database,
    confirmation: "local-share-confirmed"
  });
  await assert.rejects(publishSqliteSnapshot({
    root: value.publisher, directory: value.adapter, database: value.database
  }), /explicit local owner confirmation/);
});

test("CLI initializes, publishes, inspects, and pulls the same SQLite transport", sqliteOnly, async (t) => {
  const value = await fixture(t);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const environment = { ...process.env, AGENTSPINE_STATE_DIR: value.state };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8", env: environment, timeout: 10000
  });
  const initializedResult = run(
    "share-sqlite-init", value.adapter, "--root", value.publisher,
    "--database", value.database, "--confirm-local-share"
  );
  assert.equal(initializedResult.status, 0, initializedResult.stderr);
  const publishResult = run(
    "share-sqlite-publish", value.adapter, "--root", value.publisher,
    "--database", value.database, "--id", "snapshot:sqlite-cli", "--confirm-local-share"
  );
  assert.equal(publishResult.status, 0, publishResult.stderr);
  assert.equal(JSON.parse(publishResult.stdout).sequence, 1);
  const inspectResult = run(
    "share-sqlite-inspect", "--root", value.publisher, "--database", value.database
  );
  assert.equal(inspectResult.status, 0, inspectResult.stderr);
  assert.equal(JSON.parse(inspectResult.stdout).revisions, 1);
  const pullResult = run(
    "share-sqlite-pull", "--root", value.receiver, "--database", value.database
  );
  assert.equal(pullResult.status, 0, pullResult.stderr);
  assert.equal(JSON.parse(pullResult.stdout).transport, "sqlite");
});

test("concurrent CLI publishers serialize into distinct retained revisions", sqliteOnly, async (t) => {
  const value = await initialized(t);
  const cli = fileURLToPath(new URL("../bin/agentspine.js", import.meta.url));
  const environment = { ...process.env, AGENTSPINE_STATE_DIR: value.state };
  const run = (snapshotId) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      cli, "share-sqlite-publish", value.adapter, "--root", value.publisher,
      "--database", value.database, "--id", snapshotId, "--confirm-local-share", "--json"
    ], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
  const results = await Promise.all([run("snapshot:sqlite-race-a"), run("snapshot:sqlite-race-b")]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const inspected = await inspectSqliteAdapter({ root: value.publisher, database: value.database });
  assert.equal(inspected.revisions, 2);
  assert.deepEqual(inspected.snapshots.map((item) => item.sequence), [1, 2]);
  assert.equal(inspected.snapshots[1].previousRevisionDigest, inspected.snapshots[0].revisionDigest);
});

test("SQLite transport administration stays absent from MCP and hooks", async () => {
  const [mcp, mcpRuntime, hook] = await Promise.all([
    readFile(new URL("../src/mcp.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/mcp-runtime.js", import.meta.url), "utf8"),
    readFile(new URL("../src/hook.js", import.meta.url), "utf8")
  ]);
  for (const content of [mcp, mcpRuntime, hook]) {
    assert.equal(/Sqlite|SQLite|share-sqlite|sqlite-transport/.test(content), false);
  }
});
