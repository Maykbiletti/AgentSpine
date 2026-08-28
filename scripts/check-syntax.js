import { opendir } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

async function javascriptFiles(directory, files = []) {
  const entries = [];
  for await (const entry of await opendir(directory)) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await javascriptFiles(path, files);
    else if (entry.isFile() && extname(entry.name) === ".js") files.push(path);
  }
  return files;
}

const files = [
  ...await javascriptFiles("src"),
  ...await javascriptFiles("bin"),
  ...await javascriptFiles("scripts")
];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}
process.stdout.write(`Checked ${files.length} JavaScript files.\n`);
