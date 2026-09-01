import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";

export async function canonicalPath(input = process.cwd()) {
  return realpath(resolve(input));
}

export async function findProjectRoot(input = process.cwd()) {
  if (process.env.AGENTSPINE_ROOT) return canonicalPath(process.env.AGENTSPINE_ROOT);
  let cursor = await canonicalPath(input);
  while (true) {
    try {
      await lstat(join(cursor, ".git"));
      return cursor;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return canonicalPath(input);
    cursor = parent;
  }
}

export function isInside(parent, child, pathApi = { relative, isAbsolute, sep }) {
  const value = pathApi.relative(parent, child);
  return value === "" || (!pathApi.isAbsolute(value) && !value.startsWith(`..${pathApi.sep}`) && value !== "..");
}

export function ancestorsBetween(root, cwd) {
  const result = [];
  let cursor = resolve(cwd);
  while (isInside(root, cursor)) {
    result.push(cursor);
    if (cursor === root) break;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return result.reverse();
}

export function stateRoot(env = process.env) {
  if (env.AGENTSPINE_STATE_DIR) return resolve(env.AGENTSPINE_STATE_DIR);
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA || env.APPDATA || homedir(), "AgentSpine");
  }
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentspine");
}

export function comparablePath(value) {
  let canonical;
  try { canonical = realpathSync.native(resolve(value)); } catch {
    canonical = resolve(value);
  }
  return canonical.replace(/[\\/]+$/, "");
}

function samePath(left, right) {
  const normalize = comparablePath;
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isUserHomeRoot(root, env = process.env) {
  const candidates = [homedir(), env.HOME, env.USERPROFILE,
    env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null]
    .filter((value) => typeof value === "string" && value && isAbsolute(value));
  return candidates.some((candidate) => samePath(root, candidate));
}

export function statePathIsScanExcluded(catalog, path, env = process.env) {
  if (!catalog || catalog.schema !== "agentspine.catalog/v1" || typeof path !== "string") return false;
  const localStateRoot = stateRoot(env);
  const pathBelongsToState = isInside(localStateRoot, path);
  const canonicalRoot = comparablePath(catalog.root);
  const canonicalStateRoot = comparablePath(localStateRoot);
  if (!pathBelongsToState && !isInside(canonicalRoot, comparablePath(path))) return true;
  if (pathBelongsToState && !isInside(canonicalRoot, canonicalStateRoot)) return true;
  return catalog.scanPolicy?.stateRoot === "excluded"
    && isUserHomeRoot(canonicalRoot, env)
    && isInside(canonicalRoot, canonicalStateRoot)
    && pathBelongsToState;
}

export function projectId(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 20);
}

export async function projectStateDir(root) {
  const target = join(stateRoot(), "projects", projectId(root));
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}
