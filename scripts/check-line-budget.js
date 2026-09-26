#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_LINE_BYTES = 2000;
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const LEGACY_LIMITS = new Map(Object.entries({
  "src/lib/authentication.js": 515,
  "src/lib/channel-runtime.js": 665,
  "src/lib/coordination.js": 577,
  "src/lib/persona-runtime.js": 581,
  "src/lib/preflight.js": 702,
  "src/lib/sharing.js": 969,
  "src/lib/sqlite-transport.js": 501
}));
const LEGACY_LINE_BYTE_LIMITS = new Map(Object.entries({
  "src/lib/audit.js": 11000,
  "src/lib/hook-output.js": 12500,
  "src/lib/pre-answer-timeline-recall.js": 6000
}));

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && JAVASCRIPT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export function sourceMetrics(content) {
  if (!content.length) return { lines: 0, maxLineBytes: 0 };
  const split = content.split(/\r?\n/);
  const lines = content.endsWith("\n") ? split.length - 1 : split.length;
  return { lines, maxLineBytes: Math.max(...split.map((line) => Buffer.byteLength(line))) };
}

export async function checkLineBudget(root = ROOT) {
  const files = (await Promise.all(["bin", "src", "test", "scripts"]
    .map((name) => javascriptFiles(join(root, name))))).flat();
  const measurements = await Promise.all(files.map(async (path) => {
    const name = relative(root, path).replaceAll("\\", "/");
    const metrics = sourceMetrics(await readFile(path, "utf8"));
    return { name, ...metrics, limit: LEGACY_LIMITS.get(name) ?? DEFAULT_LIMIT,
      maxLineLimit: LEGACY_LINE_BYTE_LIMITS.get(name) ?? DEFAULT_MAX_LINE_BYTES };
  }));
  const failures = measurements.filter((item) => item.lines > item.limit);
  const lineLengthFailures = measurements.filter((item) => !item.name.startsWith("test/")
    && item.maxLineBytes > item.maxLineLimit);
  const missing = [...LEGACY_LIMITS].filter(([name]) => !measurements.some((item) => item.name === name));
  const missingLineByteLimits = [...LEGACY_LINE_BYTE_LIMITS]
    .filter(([name]) => !measurements.some((item) => item.name === name));
  return { ok: failures.length === 0 && lineLengthFailures.length === 0
    && missing.length === 0 && missingLineByteLimits.length === 0,
  defaultLimit: DEFAULT_LIMIT, defaultMaxLineBytes: DEFAULT_MAX_LINE_BYTES,
  legacyFiles: LEGACY_LIMITS.size, legacyLineByteFiles: LEGACY_LINE_BYTE_LIMITS.size,
  failures, lineLengthFailures, missing: missing.map(([name]) => name),
  missingLineByteLimits: missingLineByteLimits.map(([name]) => name), measurements };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkLineBudget();
  if (!result.ok) {
    for (const item of result.failures) process.stderr.write(`${item.name}: ${item.lines} lines exceeds ${item.limit}\n`);
    for (const item of result.lineLengthFailures) {
      process.stderr.write(`${item.name}: ${item.maxLineBytes}-byte line exceeds ${item.maxLineLimit}\n`);
    }
    for (const name of result.missing) process.stderr.write(`${name}: legacy budget entry no longer maps to a file\n`);
    for (const name of result.missingLineByteLimits) {
      process.stderr.write(`${name}: legacy line-byte entry no longer maps to a file\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`Line budget passed: ${result.measurements.length} JavaScript files; `
      + `new files <= ${result.defaultLimit} lines and ${result.defaultMaxLineBytes} bytes per line.\n`);
  }
}
