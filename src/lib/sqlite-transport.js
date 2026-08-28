import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { verifyEnvelope } from "./authentication.js";
import { buildCatalog } from "./catalog.js";
import { buildHttpsSnapshot, importHttpsSnapshot, validateHttpsSnapshot } from "./https-transport.js";
import { isInside } from "./paths.js";
import { readDirectoryExchange } from "./sharing.js";

const SCHEMA = "agentspine.sqlite/v1";
const REVISION_SCHEMA = "agentspine.sqlite-revision/v1";
const CONFIRMATION = "local-share-confirmed";
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 21 * 1024 * 1024;
const MAX_REVISIONS = 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TABLES = ["agentspine_head", "agentspine_meta", "agentspine_revisions"];
const COLUMNS = {
  agentspine_meta: [
    ["id", "INTEGER", 0, 1], ["schema", "TEXT", 1, 0], ["scope_id", "TEXT", 1, 0],
    ["adapter_id", "TEXT", 1, 0], ["manifest_json", "TEXT", 1, 0],
    ["manifest_digest", "TEXT", 1, 0], ["signer_id", "TEXT", 1, 0],
    ["key_id", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0], ["authority", "TEXT", 1, 0]
  ],
  agentspine_revisions: [
    ["sequence", "INTEGER", 0, 1], ["snapshot_id", "TEXT", 1, 0],
    ["snapshot_digest", "TEXT", 1, 0], ["previous_revision_digest", "TEXT", 0, 0],
    ["snapshot_json", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0],
    ["authority", "TEXT", 1, 0], ["revision_digest", "TEXT", 1, 0]
  ],
  agentspine_head: [
    ["id", "INTEGER", 0, 1], ["sequence", "INTEGER", 1, 0],
    ["revision_digest", "TEXT", 1, 0], ["snapshot_digest", "TEXT", 1, 0],
    ["authority", "TEXT", 1, 0]
  ]
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validDate(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(new Date(value).getTime());
}

async function sqliteModule() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error("SQLite transport requires Node.js 22.13 or newer with node:sqlite support");
  }
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error("SQLite transport requires Node.js 22.13 or newer with node:sqlite support", {
      cause: error
    });
  }
}

async function prospectiveCanonicalPath(path) {
  let ancestor = path;
  const missing = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function databasePath(root, database, { create = false } = {}) {
  if (!database || typeof database !== "string" || database === ":memory:") {
    throw new Error("a file-backed SQLite database path is required");
  }
  const catalog = await buildCatalog(root);
  const target = resolve(database);
  const canonicalTarget = await prospectiveCanonicalPath(target);
  if (isInside(catalog.root, canonicalTarget)) {
    throw new Error("SQLite transport database must remain outside the scanned project");
  }
  if (create) await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  let metadata = null;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
  }
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error("SQLite transport path must be a real regular file");
  }
  if (metadata && metadata.nlink !== 1) {
    throw new Error("SQLite transport database must not be a hard link");
  }
  if (metadata && metadata.size > MAX_DATABASE_BYTES) {
    throw new Error("SQLite transport database exceeds the 128 MiB limit");
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      const sidecar = await lstat(`${target}${suffix}`);
      if (!metadata) throw new Error("SQLite transport sidecar exists without its database");
      if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1) {
        throw new Error("SQLite transport sidecars must be real, single-link regular files");
      }
      if (sidecar.size > MAX_DATABASE_BYTES) throw new Error("SQLite transport sidecar exceeds the 128 MiB limit");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const parent = await realpath(dirname(target));
  if (isInside(catalog.root, parent)) {
    throw new Error("SQLite transport database must remain outside the scanned project");
  }
  return { catalog, target: resolve(parent, basename(target)), exists: Boolean(metadata) };
}

async function openDatabase(path, { readOnly = false } = {}) {
  const { DatabaseSync } = await sqliteModule();
  let database;
  try {
    database = new DatabaseSync(path, {
      readOnly, enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false, allowExtension: false
    });
  } catch (error) {
    throw new Error(`SQLite transport database could not be opened: ${error.message}`, { cause: error });
  }
  try {
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (typeof database.enableDefensive === "function") database.enableDefensive(true);
    if (readOnly) database.exec("PRAGMA query_only = ON;");
    else database.exec("PRAGMA synchronous = FULL;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agentspine_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema TEXT NOT NULL CHECK (schema = 'agentspine.sqlite/v1'),
      scope_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      signer_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      authority TEXT NOT NULL CHECK (authority = 'context-only')
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agentspine_revisions (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      snapshot_id TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL UNIQUE,
      previous_revision_digest TEXT,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      authority TEXT NOT NULL CHECK (authority = 'context-only'),
      revision_digest TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agentspine_head (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL,
      revision_digest TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      authority TEXT NOT NULL CHECK (authority = 'context-only')
    ) STRICT;
    PRAGMA user_version = 1;
  `);
}

function parseJson(value, label, maximum = MAX_SNAPSHOT_BYTES) {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} exceeds its validation limit`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateSchema(database) {
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("SQLite transport integrity check failed");
  const objects = database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  if (objects.length !== TABLES.length
    || objects.some((item) => item.type !== "table")
    || objects.map((item) => item.name).sort().some((name, index) => name !== TABLES[index])) {
    throw new Error("SQLite transport schema contains missing or unexpected objects");
  }
  for (const table of TABLES) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    const expected = COLUMNS[table];
    if (columns.length !== expected.length || columns.some((column, index) => {
      const wanted = expected[index];
      return column.name !== wanted[0] || String(column.type).toUpperCase() !== wanted[1]
        || Number(column.notnull) !== wanted[2] || Number(column.pk) !== wanted[3]
        || column.dflt_value !== null;
    })) throw new Error(`SQLite transport table layout is invalid: ${table}`);
  }
  for (const table of ["agentspine_meta", "agentspine_head"]) {
    if (database.prepare(`PRAGMA index_list(${table})`).all().length !== 0) {
      throw new Error(`SQLite transport table has an unexpected index: ${table}`);
    }
  }
  const revisionIndexes = database.prepare("PRAGMA index_list(agentspine_revisions)").all();
  if (revisionIndexes.length !== 2 || revisionIndexes.some((index) => (
    Number(index.unique) !== 1 || index.origin !== "u" || Number(index.partial) !== 0
  ))) throw new Error("SQLite transport revision indexes are invalid");
  const expectedIndexes = new Map([
    ["sqlite_autoindex_agentspine_revisions_1", "snapshot_digest"],
    ["sqlite_autoindex_agentspine_revisions_2", "revision_digest"]
  ]);
  for (const index of revisionIndexes) {
    const expectedColumn = expectedIndexes.get(index.name);
    if (!expectedColumn) throw new Error("SQLite transport revision indexes are invalid");
    const columns = database.prepare(`PRAGMA index_info(${index.name})`).all();
    if (columns.length !== 1 || columns[0].name !== expectedColumn) {
      throw new Error("SQLite transport revision indexes are invalid");
    }
  }
  const version = database.prepare("PRAGMA user_version").get();
  if (!version || Number(Object.values(version)[0]) !== 1) throw new Error("SQLite transport schema version is unsupported");
}

function validateManifestMetadata(row) {
  if (!row || row.schema !== SCHEMA || !ID_RE.test(row.scope_id || "")
    || !ID_RE.test(row.adapter_id || "") || !ID_RE.test(row.signer_id || "")
    || !ID_RE.test(row.key_id || "") || !DIGEST_RE.test(row.manifest_digest || "")
    || !validDate(row.created_at) || row.authority !== "context-only") {
    throw new Error("SQLite transport metadata is invalid");
  }
  const manifest = parseJson(row.manifest_json, "SQLite signed manifest", 64 * 1024);
  const verified = verifyEnvelope(manifest, "manifest");
  if (digest(manifest) !== row.manifest_digest
    || verified.payload?.scopeId !== row.scope_id || verified.payload?.adapterId !== row.adapter_id
    || verified.payload?.adapter !== "directory" || verified.publicIdentity.signerId !== row.signer_id
    || verified.publicIdentity.keyId !== row.key_id) {
    throw new Error("SQLite transport metadata does not match its signed manifest");
  }
  return { manifest, verified };
}

function revisionBody(row) {
  return {
    schema: REVISION_SCHEMA, sequence: row.sequence, snapshotId: row.snapshot_id,
    snapshotDigest: row.snapshot_digest, previousRevisionDigest: row.previous_revision_digest,
    createdAt: row.created_at, authority: row.authority
  };
}

function readValidatedState(database) {
  validateSchema(database);
  const metadata = database.prepare("SELECT * FROM agentspine_meta WHERE id = 1").get();
  const { manifest, verified } = validateManifestMetadata(metadata);
  const rows = database.prepare("SELECT * FROM agentspine_revisions ORDER BY sequence").all();
  if (rows.length > MAX_REVISIONS) throw new Error(`SQLite transport exceeds ${MAX_REVISIONS} retained revisions`);
  let previousDigest = null;
  let totalBytes = 0;
  const revisions = rows.map((row, index) => {
    totalBytes += Buffer.byteLength(row.snapshot_json || "");
    if (totalBytes > MAX_DATABASE_BYTES) throw new Error("SQLite transport retained snapshots exceed the 128 MiB limit");
    if (Number(row.sequence) !== index + 1 || !ID_RE.test(row.snapshot_id || "")
      || !DIGEST_RE.test(row.snapshot_digest || "")
      || row.previous_revision_digest !== previousDigest || !validDate(row.created_at)
      || row.authority !== "context-only" || !DIGEST_RE.test(row.revision_digest || "")
      || digest(revisionBody(row)) !== row.revision_digest) {
      throw new Error("SQLite transport revision chain is invalid");
    }
    const snapshot = validateHttpsSnapshot(parseJson(row.snapshot_json, "SQLite snapshot"));
    if (snapshot.digest !== row.snapshot_digest || snapshot.snapshotId !== row.snapshot_id
      || snapshot.scopeId !== metadata.scope_id || snapshot.adapterId !== metadata.adapter_id
      || digest(snapshot.manifest) !== metadata.manifest_digest) {
      throw new Error("SQLite transport revision does not match its authenticated metadata");
    }
    previousDigest = row.revision_digest;
    return { ...row, snapshot };
  });
  const head = database.prepare("SELECT * FROM agentspine_head WHERE id = 1").get();
  if (revisions.length === 0) {
    if (head) throw new Error("SQLite transport head exists without a revision");
  } else {
    const latest = revisions.at(-1);
    if (!head || !exactKeys(head, ["id", "sequence", "revision_digest", "snapshot_digest", "authority"])
      || Number(head.sequence) !== latest.sequence || head.revision_digest !== latest.revision_digest
      || head.snapshot_digest !== latest.snapshot_digest || head.authority !== "context-only") {
      throw new Error("SQLite transport head does not match the append-only revision chain");
    }
  }
  return { metadata, manifest, verified, revisions, head };
}

async function secureFile(path) {
  await chmod(path, 0o600);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_DATABASE_BYTES) {
    throw new Error("SQLite transport database is not a bounded regular file");
  }
}

export async function initSqliteAdapter({
  root = process.cwd(), directory, database, confirmation, now = new Date()
}) {
  if (confirmation !== CONFIRMATION) throw new Error("SQLite adapter initialization requires explicit local owner confirmation");
  const exchange = await readDirectoryExchange({ root, directory, requireAuthenticated: true });
  const manifestVerification = verifyEnvelope(exchange.manifest, "manifest");
  const location = await databasePath(root, database, { create: true });
  const connection = await openDatabase(location.target);
  let completed = false;
  let created = false;
  try {
    connection.exec("BEGIN IMMEDIATE");
    try {
      createSchema(connection);
      const existing = connection.prepare("SELECT * FROM agentspine_meta WHERE id = 1").get();
      if (existing) {
        const validated = validateManifestMetadata(existing);
        if (existing.scope_id !== exchange.scopeId || existing.adapter_id !== exchange.adapterId
          || existing.manifest_digest !== digest(exchange.manifest)
          || validated.verified.publicIdentity.keyId !== manifestVerification.publicIdentity.keyId) {
          throw new Error("SQLite transport already belongs to a different signed adapter");
        }
      } else {
        created = true;
        connection.prepare(`
          INSERT INTO agentspine_meta
          (id, schema, scope_id, adapter_id, manifest_json, manifest_digest, signer_id, key_id, created_at, authority)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'context-only')
        `).run(
          SCHEMA, exchange.scopeId, exchange.adapterId, JSON.stringify(exchange.manifest), digest(exchange.manifest),
          manifestVerification.publicIdentity.signerId, manifestVerification.publicIdentity.keyId,
          new Date(now).toISOString()
        );
      }
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
    const state = readValidatedState(connection);
    completed = true;
    return {
      created, database: location.target, schema: SCHEMA,
      scopeId: state.metadata.scope_id, adapterId: state.metadata.adapter_id,
      signer: { signerId: state.metadata.signer_id, keyId: state.metadata.key_id },
      revisions: state.revisions.length, authority: "context-only"
    };
  } finally {
    connection.close();
    if (completed) await secureFile(location.target);
  }
}

export async function publishSqliteSnapshot({
  root = process.cwd(), directory, database, snapshotId = `snapshot:${randomUUID()}`,
  confirmation, now = new Date()
}) {
  if (confirmation !== CONFIRMATION) throw new Error("SQLite snapshot publication requires explicit local owner confirmation");
  const snapshot = await buildHttpsSnapshot({ root, directory, snapshotId, now });
  const location = await databasePath(root, database);
  const connection = await openDatabase(location.target);
  let completed = false;
  try {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const state = readValidatedState(connection);
      if (snapshot.scopeId !== state.metadata.scope_id || snapshot.adapterId !== state.metadata.adapter_id
        || digest(snapshot.manifest) !== state.metadata.manifest_digest) {
        throw new Error("SQLite snapshot does not belong to this authenticated adapter");
      }
      const existing = connection.prepare("SELECT * FROM agentspine_revisions WHERE snapshot_digest = ?").get(snapshot.digest);
      if (existing) {
        connection.exec("COMMIT");
        completed = true;
        return {
          created: false, database: location.target, sequence: existing.sequence,
          snapshotId: existing.snapshot_id, snapshotDigest: existing.snapshot_digest,
          revisionDigest: existing.revision_digest, events: snapshot.events.length,
          authority: "context-only"
        };
      }
      const sequence = state.revisions.length + 1;
      const previousRevisionDigest = state.revisions.at(-1)?.revision_digest || null;
      const createdAt = new Date(now).toISOString();
      if (!validDate(createdAt)) throw new Error("now must be a valid date");
      const body = {
        schema: REVISION_SCHEMA, sequence, snapshotId: snapshot.snapshotId,
        snapshotDigest: snapshot.digest, previousRevisionDigest, createdAt,
        authority: "context-only"
      };
      const revisionDigest = digest(body);
      connection.prepare(`
        INSERT INTO agentspine_revisions
        (sequence, snapshot_id, snapshot_digest, previous_revision_digest, snapshot_json, created_at, authority, revision_digest)
        VALUES (?, ?, ?, ?, ?, ?, 'context-only', ?)
      `).run(sequence, snapshot.snapshotId, snapshot.digest, previousRevisionDigest, JSON.stringify(snapshot), createdAt, revisionDigest);
      if (state.head) {
        const changed = connection.prepare(`
          UPDATE agentspine_head SET sequence = ?, revision_digest = ?, snapshot_digest = ?
          WHERE id = 1 AND sequence = ? AND revision_digest = ? AND authority = 'context-only'
        `).run(sequence, revisionDigest, snapshot.digest, state.head.sequence, state.head.revision_digest);
        if (Number(changed.changes) !== 1) throw new Error("SQLite transport head changed concurrently");
      } else {
        connection.prepare(`
          INSERT INTO agentspine_head (id, sequence, revision_digest, snapshot_digest, authority)
          VALUES (1, ?, ?, ?, 'context-only')
        `).run(sequence, revisionDigest, snapshot.digest);
      }
      connection.exec("COMMIT");
      completed = true;
      return {
        created: true, database: location.target, sequence, snapshotId: snapshot.snapshotId,
        snapshotDigest: snapshot.digest, revisionDigest, previousRevisionDigest,
        events: snapshot.events.length, authority: "context-only"
      };
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    connection.close();
    if (completed) await secureFile(location.target);
  }
}

export async function inspectSqliteAdapter({ root = process.cwd(), database }) {
  const location = await databasePath(root, database);
  const connection = await openDatabase(location.target, { readOnly: true });
  try {
    const state = readValidatedState(connection);
    return {
      database: location.target, schema: SCHEMA, scopeId: state.metadata.scope_id,
      adapterId: state.metadata.adapter_id,
      signer: { signerId: state.metadata.signer_id, keyId: state.metadata.key_id },
      revisions: state.revisions.length,
      head: state.head ? {
        sequence: state.head.sequence, revisionDigest: state.head.revision_digest,
        snapshotDigest: state.head.snapshot_digest
      } : null,
      snapshots: state.revisions.map((item) => ({
        sequence: item.sequence, snapshotId: item.snapshot_id,
        snapshotDigest: item.snapshot_digest, revisionDigest: item.revision_digest,
        previousRevisionDigest: item.previous_revision_digest, createdAt: item.created_at,
        events: item.snapshot.events.length, authority: "context-only"
      })),
      authority: "context-only"
    };
  } finally {
    connection.close();
  }
}

export async function pullSqliteSnapshot({ root = process.cwd(), database, now = new Date() }) {
  const location = await databasePath(root, database);
  const connection = await openDatabase(location.target, { readOnly: true });
  let snapshot;
  let revision;
  try {
    const state = readValidatedState(connection);
    revision = state.revisions.at(-1);
    if (!revision) throw new Error("SQLite transport has no published snapshot");
    snapshot = structuredClone(revision.snapshot);
  } finally {
    connection.close();
  }
  const imported = await importHttpsSnapshot({ root, snapshot, now });
  return {
    ...imported, transport: "sqlite", database: location.target,
    sequence: revision.sequence, revisionDigest: revision.revision_digest,
    authority: "context-only"
  };
}
