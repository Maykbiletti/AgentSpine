import { createHash } from "node:crypto";
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

export function projectId(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 20);
}

export async function projectStateDir(root) {
  const target = join(stateRoot(), "projects", projectId(root));
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}
