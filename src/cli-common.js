import { readFile } from "node:fs/promises";

export function parseCli(argv) {
  const [command = "help", ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) flags[name] = inline;
    else if (rest[index + 1] && !rest[index + 1].startsWith("--")) flags[name] = rest[++index];
    else flags[name] = true;
  }
  return { command, flags, positional };
}

export function outputCli(value, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function booleanFlag(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error(`expected boolean flag, received: ${value}`);
}

export async function goalPlanFlag(path) {
  if (!path) return null;
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content) > 64 * 1024) throw new Error("goal plan exceeds 64 KiB");
  const parsed = JSON.parse(content);
  const steps = Array.isArray(parsed) ? parsed : parsed?.steps;
  if (!Array.isArray(steps)) throw new Error("goal plan must be a JSON array or an object with a steps array");
  return steps;
}

export function learningScope(flags) {
  return {
    personaId: flags.persona || null,
    userId: flags.user || null,
    tenantId: flags.tenant || null,
    projectId: flags.project || null,
    groupId: flags.group || null,
    taskId: flags.task || null
  };
}

export function hasLearningScope(flags) {
  return ["persona", "user", "tenant", "project", "group", "task"]
    .some((name) => flags[name] !== undefined);
}

export function evaluatorRootsFlag(value) {
  return String(value || "").split(",").filter(Boolean).map((entry) => {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0) throw new Error("evaluator roots must use evaluator-id=sha256 entries");
    return { evaluatorId: entry.slice(0, separator), principalDigest: entry.slice(separator + 1) };
  });
}

export { outputCli as output, parseCli as parse };
