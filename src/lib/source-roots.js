import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lstat, mkdir, open, opendir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { ancestorsBetween, canonicalPath, isInside, stateRoot } from "./paths.js";
import { indexExplicitDocuments } from "./documents.js";
import { isFileLockContention, replaceFileWithRetry } from "./filesystem-retry.js";
import { purgeIndexedMemoryCache, resolveIndexedMemory } from "./indexed-memory.js";

export const SOURCE_REGISTRY_SCHEMA = "agentspine.source-roots/v1";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_SOURCES = 256;
const MAX_RULE_FILES = 128;
const MAX_TOTAL_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const SOURCE_RESOLUTION_MS = 2000;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const SKIP_EXTRA_DIRS = new Set([".git", ".hg", ".svn", ".claude", ".codex", "node_modules", "vendor", "dist", "build", "coverage"]);

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function registryPath(env = process.env) { return join(stateRoot(env), "source-roots.json"); }
function emptyRegistry() { return { schema: SOURCE_REGISTRY_SCHEMA, revision: 0, bindings: [], history: [] }; }

function normalizeRegistry(value) {
  if (!value || value.schema !== SOURCE_REGISTRY_SCHEMA || !Number.isInteger(value.revision)
    || !Array.isArray(value.bindings) || !Array.isArray(value.history)) {
    throw new Error("source-root registry is corrupt; host-native recall is disabled until repaired");
  }
  for (const binding of value.bindings) {
    if (!binding || typeof binding.id !== "string" || !["all", "claude", "codex"].includes(binding.host)
      || !["project-memory", "state-user"].includes(binding.scope) || typeof binding.profileKey !== "string"
      || typeof binding.projectRoot !== "string" || typeof binding.sourceRoot !== "string"
      || typeof binding.provenance !== "string" || typeof binding.active !== "boolean"
      || binding.authority !== "context-only") throw new Error("source-root registry contains an unsafe binding");
  }
  if (value.history.some((item) => !item || item.authority !== "context-only")) {
    throw new Error("source-root registry history contains an authority violation");
  }
  return value;
}

async function readRegistry(env = process.env) {
  const path = registryPath(env);
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_REGISTRY_BYTES) throw new Error("source-root registry exceeds 1 MiB");
    return { registry: normalizeRegistry(JSON.parse(await readFile(path, "utf8"))), path };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { registry: emptyRegistry(), path };
  }
}

async function mutateRegistry(task, env = process.env) {
  const path = registryPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { handle = await open(lock, "wx", 0o600); break; } catch (error) {
      if (!isFileLockContention(error)) throw error;
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  if (!handle) throw new Error("source-root registry is busy; retry shortly");
  try {
    const { registry } = await readRegistry(env);
    const result = await task(registry);
    registry.revision += 1;
    const content = `${JSON.stringify(registry, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_REGISTRY_BYTES) throw new Error("source-root registry exceeds 1 MiB");
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await replaceFileWithRetry(temporary, path);
    return { ...result, registryPath: path, revision: registry.revision };
  } finally {
    await handle.close();
    await unlink(lock).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function existingRegular(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    return realpath(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function existingDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
    return realpath(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

async function readJsonObject(path) {
  const file = await existingRegular(path);
  if (!file) return null;
  const metadata = await stat(file);
  if (metadata.size > 1024 * 1024) throw new Error(`host settings exceed 1 MiB: ${basename(path)}`);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`host settings are not an object: ${basename(path)}`);
  return value;
}

function parseTomlArray(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!match) return null;
  const values = [];
  for (const item of match[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    const value = item[1] === undefined ? item[2] : JSON.parse(`"${item[1]}"`);
    if (!SAFE_NAME.test(value) || value.includes("/") || value.includes("\\")) throw new Error(`unsafe ${key} entry`);
    values.push(value);
  }
  return values;
}

async function codexConfig(home) {
  const path = join(home, "config.toml");
  const file = await existingRegular(path);
  if (!file) return { fallbackNames: [], rootMarkers: [".git"], maxBytes: 32768 };
  const metadata = await stat(file);
  if (metadata.size > 1024 * 1024) throw new Error("Codex config exceeds 1 MiB");
  const text = await readFile(file, "utf8");
  const bytes = Number(text.match(/^\s*project_doc_max_bytes\s*=\s*(\d+)/m)?.[1] || 32768);
  return {
    fallbackNames: parseTomlArray(text, "project_doc_fallback_filenames") || [],
    rootMarkers: parseTomlArray(text, "project_root_markers") || [".git"],
    maxBytes: Number.isInteger(bytes) && bytes >= 1024 && bytes <= 4 * 1024 * 1024 ? bytes : 32768
  };
}

async function findRoot(cwd, markers) {
  let cursor = cwd;
  while (true) {
    for (const marker of markers) {
      try { await lstat(join(cursor, marker)); return cursor; } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return cwd;
    cursor = parent;
  }
}

async function containsProjectMarker(directory) {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function boundedMarkdownTree(directory, prefix, host, scope, precedenceStart, deadline, { projectBoundary = false } = {}) {
  const root = await existingDirectory(directory);
  if (!root) return [];
  const output = [];
  let visitedEntries = 0;
  async function walk(current) {
    if (Date.now() > deadline) throw new Error(`host-native source resolution exceeded ${SOURCE_RESOLUTION_MS} ms`);
    if (projectBoundary && current !== root && await containsProjectMarker(current)) return;
    const entries = [];
    for await (const entry of await opendir(current)) {
      visitedEntries += 1;
      if (visitedEntries > MAX_DIRECTORY_ENTRIES) throw new Error(`host-native source tree exceeds ${MAX_DIRECTORY_ENTRIES} entries`);
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= MAX_RULE_FILES) throw new Error(`host-native rule tree exceeds ${MAX_RULE_FILES} files`);
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_EXTRA_DIRS.has(entry.name)) await walk(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        output.push({ path, id: `${prefix}/${relative(root, path).replaceAll("\\", "/")}`, host, scope,
          binding: "host-native-rule-tree", precedence: precedenceStart + output.length });
      }
    }
  }
  await walk(root);
  return output;
}

async function addFile(output, path, metadata) {
  const file = await existingRegular(path);
  if (file) output.push({ path: file, ...metadata });
}

function profileKey(host, hostHome) { return `${host}:${digest(hostHome).slice(0, 24)}`; }

function activeBinding(registry, host, hostHome, projectRoot, scope) {
  const targetRoot = scope === "state-user" ? "*" : projectRoot;
  return registry.bindings.find((item) => item.active && (item.host === host || item.host === "all")
    && (item.host === "all" || item.profileKey === profileKey(host, hostHome))
    && item.projectRoot === targetRoot && item.scope === scope) || null;
}

async function rememberRuntimeBinding({ host, hostHome, projectRoot, sourceRoot, scope, provenance, env }) {
  const canonicalSource = await canonicalPath(sourceRoot);
  return mutateRegistry((registry) => {
    const key = host === "all" ? "all:local-user" : profileKey(host, hostHome);
    const targetRoot = scope === "state-user" ? "*" : projectRoot;
    const current = registry.bindings.find((item) => item.active && item.host === host
      && item.profileKey === key && item.projectRoot === targetRoot && item.scope === scope);
    if (current?.sourceRoot === canonicalSource) return { binding: current, unchanged: true };
    if (current && current.sourceRoot !== canonicalSource) throw new Error(`conflicting ${host} ${scope} source binding; inspect or roll back the registry`);
    const binding = {
      id: `binding:${randomUUID()}`, host, profileKey: key, projectRoot: targetRoot, sourceRoot: canonicalSource,
      scope, provenance, active: true, createdAt: new Date().toISOString(), authority: "context-only"
    };
    registry.bindings.push(binding);
    registry.history.push({ kind: "bound", bindingId: binding.id, at: binding.createdAt, provenance, authority: "context-only" });
    return { binding, unchanged: false };
  }, env);
}

export async function bindSourceRoot({ host, hostHome, projectRoot, sourceRoot, scope = "state-user", confirmation, env = process.env }) {
  if (confirmation !== "local-user-confirmed") throw new Error("source binding requires explicit local user confirmation");
  if (!["claude", "codex", "all"].includes(host) || !["project-memory", "state-user"].includes(scope)
    || (host === "all" && scope !== "state-user")) throw new Error("invalid source binding scope");
  return rememberRuntimeBinding({ host, hostHome: host === "all" ? "local-user" : await canonicalPath(hostHome), projectRoot: await canonicalPath(projectRoot),
    sourceRoot, scope, provenance: "local-user-confirmed", env });
}

export async function rollbackSourceBinding({ id, confirmation, env = process.env }) {
  if (confirmation !== "local-user-confirmed") throw new Error("source binding rollback requires explicit local user confirmation");
  const result = await mutateRegistry((registry) => {
    const binding = registry.bindings.find((item) => item.id === id && item.active);
    if (!binding) throw new Error(`active source binding not found: ${id}`);
    binding.active = false;
    binding.rolledBackAt = new Date().toISOString();
    registry.history.push({ kind: "rolled-back", bindingId: id, at: binding.rolledBackAt, authority: "context-only" });
    return { binding };
  }, env);
  if (result.binding.scope === "project-memory") await purgeIndexedMemoryCache(result.binding.sourceRoot, env);
  return result;
}

export async function purgeSourceBinding({ id, confirmation, env = process.env }) {
  if (confirmation !== "local-user-confirmed") throw new Error("source binding purge requires explicit local user confirmation");
  const result = await mutateRegistry((registry) => {
    const removed = registry.bindings.find((item) => item.id === id);
    const before = registry.bindings.length;
    registry.bindings = registry.bindings.filter((item) => item.id !== id);
    if (registry.bindings.length === before) throw new Error(`source binding not found: ${id}`);
    registry.history.push({ kind: "purged", bindingDigest: digest(id), at: new Date().toISOString(), authority: "context-only" });
    return { purged: true, removed };
  }, env);
  if (result.removed?.scope === "project-memory") await purgeIndexedMemoryCache(result.removed.sourceRoot, env);
  return { ...result, removed: undefined };
}

export async function inspectSourceRegistry(env = process.env) {
  const { registry, path } = await readRegistry(env);
  return { registry, registryPath: path };
}

async function claudeSources({ cwd, projectRoot, configDir, input, env, registry, deadline, memoryHooks }) {
  const sources = [];
  await addFile(sources, join(configDir, "CLAUDE.md"), { id: "claude:user/CLAUDE.md", host: "claude", scope: "user", binding: "CLAUDE_CONFIG_DIR", precedence: 100 });
  sources.push(...await boundedMarkdownTree(join(configDir, "rules"), "claude:user/rules", "claude", "user", 110, deadline));
  let precedence = 1000;
  for (const directory of ancestorsBetween(projectRoot, cwd)) {
    for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
      await addFile(sources, join(directory, name), { id: `claude:project/${relative(projectRoot, join(directory, name)).replaceAll("\\", "/")}`,
        host: "claude", scope: "project", binding: "native-project-chain", precedence: precedence++ });
    }
    await addFile(sources, join(directory, ".claude", "CLAUDE.md"), { id: `claude:project/${relative(projectRoot, join(directory, ".claude", "CLAUDE.md")).replaceAll("\\", "/")}`,
      host: "claude", scope: "project", binding: "native-project-chain", precedence: precedence++ });
  }
  sources.push(...await boundedMarkdownTree(join(projectRoot, ".claude", "rules"), "claude:project/.claude/rules", "claude", "project", precedence, deadline));

  let memoryRoot = null;
  let memoryProvenance = null;
  for (const path of [join(configDir, "settings.json"), join(projectRoot, ".claude", "settings.json"), join(projectRoot, ".claude", "settings.local.json")]) {
    const value = await readJsonObject(path);
    if (typeof value?.autoMemoryDirectory === "string") {
      const expanded = expandHome(value.autoMemoryDirectory, homedir());
      if (!isAbsolute(expanded)) throw new Error("Claude autoMemoryDirectory must be absolute or home-relative");
      memoryRoot = await existingDirectory(expanded);
      memoryProvenance = "autoMemoryDirectory";
    }
  }
  if (!memoryRoot && typeof env.CLAUDE_CODE_PROJECT_DIR_NAME === "string" && SAFE_NAME.test(env.CLAUDE_CODE_PROJECT_DIR_NAME)) {
    memoryRoot = await existingDirectory(join(configDir, "projects", env.CLAUDE_CODE_PROJECT_DIR_NAME, "memory"));
    memoryProvenance = "CLAUDE_CODE_PROJECT_DIR_NAME";
  }
  const transcript = input.transcript_path || input.transcriptPath;
  if (!memoryRoot && typeof transcript === "string" && isAbsolute(transcript)) {
    const transcriptFile = await existingRegular(transcript);
    const projectsRoot = await existingDirectory(join(configDir, "projects"));
    if (transcriptFile && projectsRoot && isInside(projectsRoot, transcriptFile)) {
      memoryRoot = await existingDirectory(join(dirname(transcriptFile), "memory"));
      memoryProvenance = "host-hook-transcript";
    }
  }
  if (memoryRoot) {
    await rememberRuntimeBinding({ host: "claude", hostHome: configDir, projectRoot, sourceRoot: memoryRoot,
      scope: "project-memory", provenance: memoryProvenance, env });
  } else {
    memoryRoot = activeBinding(registry, "claude", configDir, projectRoot, "project-memory")?.sourceRoot || null;
    memoryProvenance = memoryRoot ? "source-root-registry" : null;
  }
  let memoryDiagnostics = null;
  if (memoryRoot) {
    const supplied = input.agent_spine_scope && typeof input.agent_spine_scope === "object"
      ? input.agent_spine_scope : input;
    const resolved = await resolveIndexedMemory({
      root: memoryRoot, env, hooks: memoryHooks, deadline,
      scope: {
        entityId: supplied.entity_id ?? supplied.entityId ?? null,
        groupId: supplied.group_id ?? supplied.groupId ?? null,
        projectId: supplied.project_id ?? supplied.projectId ?? null,
        currentTaskId: supplied.task_id ?? supplied.currentTaskId ?? null,
        prompt: input.prompt ?? input.user_prompt ?? input.message ?? input.input ?? null
      }
    });
    memoryDiagnostics = resolved.diagnostics;
    for (const item of resolved.sources) {
      sources.push({
        path: item.path, id: `claude:memory/${item.relativePath}`, host: "claude", scope: "project-memory",
        binding: "host-native-memory-index", precedence: 2000 + sources.length,
        snapshot: item.snapshot, relevance: item.relevance
      });
    }
  }
  return { sources, memoryRoot, memoryProvenance, memoryDiagnostics };
}

async function codexSources({ cwd, projectRoot, codexHome, config }) {
  const sources = [];
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const file = await existingRegular(join(codexHome, name));
    if (file && (await stat(file)).size > 0) {
      sources.push({ path: file, id: `codex:user/${name}`, host: "codex", scope: "user", binding: "CODEX_HOME", precedence: 100, maxBytes: config.maxBytes });
      break;
    }
  }
  let precedence = 1000;
  for (const directory of ancestorsBetween(projectRoot, cwd)) {
    for (const name of ["AGENTS.override.md", "AGENTS.md", ...config.fallbackNames]) {
      const file = await existingRegular(join(directory, name));
      if (file && (await stat(file)).size > 0) {
        sources.push({ path: file, id: `codex:project/${relative(projectRoot, file).replaceAll("\\", "/")}`,
          host: "codex", scope: "project", binding: "native-project-chain", precedence: precedence++, maxBytes: config.maxBytes });
        break;
      }
    }
  }
  return sources;
}

export async function resolveHostSourceCatalog({ host, cwd = process.cwd(), input = {}, env = process.env, memoryHooks = {} } = {}) {
  if (!["claude", "codex"].includes(host)) throw new Error(`host-native source resolution requires claude or codex, received ${host}`);
  const canonicalCwd = await canonicalPath(cwd);
  const deadline = Date.now() + SOURCE_RESOLUTION_MS;
  const { registry } = await readRegistry(env);
  let hostHome;
  let projectRoot;
  let sources;
  let hostDetails = {};
  if (host === "codex") {
    hostHome = await existingDirectory(resolve(env.CODEX_HOME || join(homedir(), ".codex")))
      || resolve(env.CODEX_HOME || join(homedir(), ".codex"));
    const config = await codexConfig(hostHome);
    projectRoot = env.AGENTSPINE_ROOT ? await canonicalPath(env.AGENTSPINE_ROOT) : await findRoot(canonicalCwd, config.rootMarkers);
    sources = await codexSources({ cwd: canonicalCwd, projectRoot, codexHome: hostHome, config });
    hostDetails = { rootMarkers: config.rootMarkers, fallbackNames: config.fallbackNames };
  } else {
    hostHome = await existingDirectory(resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")))
      || resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    projectRoot = env.AGENTSPINE_ROOT ? await canonicalPath(env.AGENTSPINE_ROOT) : await findRoot(canonicalCwd, [".git"]);
    const result = await claudeSources({ cwd: canonicalCwd, projectRoot, configDir: hostHome, input, env, registry, deadline, memoryHooks });
    sources = result.sources;
    hostDetails = { memoryRoot: result.memoryRoot, memoryProvenance: result.memoryProvenance,
      memoryDiagnostics: result.memoryDiagnostics };
  }
  if (projectRoot !== homedir() && projectRoot !== dirname(hostHome)) {
    sources.push(...await boundedMarkdownTree(projectRoot, "agentspine:project", host, "project", 3000, deadline,
      { projectBoundary: true }));
  }
  const nativeNames = new Set(host === "codex"
    ? ["AGENTS.override.md", "AGENTS.md", ...(hostDetails.fallbackNames || [])]
    : ["CLAUDE.md", "CLAUDE.local.md"]);
  sources = sources.filter((item) => item.binding !== "host-native-rule-tree"
    || !item.id.startsWith("agentspine:project/") || !nativeNames.has(basename(item.path)));
  sources = [...new Map(sources.map((item) => [item.path, item])).values()];
  if (sources.length > MAX_SOURCES) throw new Error(`host-native source set exceeds ${MAX_SOURCES} files`);
  if (Date.now() > deadline) throw new Error(`host-native source resolution exceeded ${SOURCE_RESOLUTION_MS} ms`);
  const documents = await indexExplicitDocuments(sources);
  if (Date.now() > deadline) throw new Error(`host-native source resolution exceeded ${SOURCE_RESOLUTION_MS} ms`);
  const totalBytes = documents.reduce((sum, document) => sum + document.bytes, 0);
  if (totalBytes > MAX_TOTAL_SOURCE_BYTES) throw new Error("host-native source set exceeds 8 MiB");
  const activeUserState = activeBinding(registry, host, hostHome, projectRoot, "state-user");
  const diagnostics = {
    schema: SOURCE_REGISTRY_SCHEMA, host, status: documents.length ? "loaded" : "empty", projectRoot,
    hostHomeDigest: digest(hostHome).slice(0, 16), checked: ["host-profile", "project-chain", ...(host === "claude" ? ["project-memory"] : [])],
    scopes: Object.fromEntries(["user", "project", "project-memory"].map((scope) => [scope, documents.filter((item) => item.sourceScope === scope).length])),
    reason: documents.length ? null : "No regular, non-symlink host-native Markdown source exists in the checked scope.",
    personalContinuityLoaded: documents.some((item) => item.sourceScope === "user") || Boolean(activeUserState),
    broadHomeScan: false, registryRevision: registry.revision,
    ...(host === "claude" ? {
      memoryBound: Boolean(hostDetails.memoryRoot),
      memoryRootDigest: hostDetails.memoryRoot ? digest(hostDetails.memoryRoot).slice(0, 16) : null,
      memoryProvenance: hostDetails.memoryProvenance,
      memory: hostDetails.memoryDiagnostics || {
        indexed: 0, relevant: 0, loaded: 0, cacheHits: 0, cacheMisses: 0, missing: 0,
        rejected: { scope: 0, path: 0, symlink: 0, race: 0, size: 0 }, directoryEnumeration: 0
      }
    } : hostDetails)
  };
  const catalog = {
    schema: "agentspine.catalog/v1", generatedAt: new Date().toISOString(), root: projectRoot,
    preservation: "source-files-are-read-only", documents, conflicts: [], sourceRegistry: diagnostics,
    summary: { total: documents.length, protected: documents.filter((item) => item.protected).length, conflicts: 0,
      byLayer: Object.fromEntries([...new Set(documents.map((item) => item.layer))].sort().map((layer) => [layer, documents.filter((item) => item.layer === layer).length])) }
  };
  return { host, hostHome, projectRoot, cwd: canonicalCwd, catalog, diagnostics,
    userStateRoot: activeUserState?.sourceRoot || null, memoryRoot: hostDetails.memoryRoot || null };
}
