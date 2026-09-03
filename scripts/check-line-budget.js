#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LIMIT = 500;
const LEGACY_LIMITS = new Map(Object.entries({
  "scripts/check-install.js": 569,
  "src/cli.js": 1488,
  "src/lib/attention.js": 755,
  "src/lib/authentication.js": 515,
  "src/lib/channel-runtime.js": 665,
  "src/lib/coordination.js": 577,
  "src/lib/gateway-runtime.js": 1520,
  "src/lib/learning.js": 6923,
  "src/lib/persona-runtime.js": 581,
  "src/lib/preflight.js": 702,
  "src/lib/selfstarter.js": 911,
  "src/lib/sharing.js": 969,
  "src/lib/source-roots.js": 530,
  "src/lib/sqlite-transport.js": 501,
  "src/mcp.js": 572,
  "test/gateway-runtime.test.js": 1326,
  "test/learning.test.js": 4250
}));

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && extname(entry.name) === ".js") files.push(path);
  }
  return files;
}

function physicalLines(content) {
  if (!content.length) return 0;
  const lines = content.split(/\r?\n/).length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

export async function checkLineBudget(root = ROOT) {
  const files = (await Promise.all(["src", "test", "scripts"].map((name) => javascriptFiles(join(root, name))))).flat();
  const measurements = await Promise.all(files.map(async (path) => {
    const name = relative(root, path).replaceAll("\\", "/");
    const lines = physicalLines(await readFile(path, "utf8"));
    return { name, lines, limit: LEGACY_LIMITS.get(name) ?? DEFAULT_LIMIT };
  }));
  const failures = measurements.filter((item) => item.lines > item.limit);
  const missing = [...LEGACY_LIMITS].filter(([name]) => !measurements.some((item) => item.name === name));
  return { ok: failures.length === 0 && missing.length === 0, defaultLimit: DEFAULT_LIMIT,
    legacyFiles: LEGACY_LIMITS.size, failures, missing: missing.map(([name]) => name), measurements };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkLineBudget();
  if (!result.ok) {
    for (const item of result.failures) process.stderr.write(`${item.name}: ${item.lines} lines exceeds ${item.limit}\n`);
    for (const name of result.missing) process.stderr.write(`${name}: legacy budget entry no longer maps to a file\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Line budget passed: ${result.measurements.length} JavaScript files; new files <= ${result.defaultLimit}.\n`);
  }
}
