import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Windows and macOS install and update the packed artifact", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /packed-install:\n/);
  assert.match(workflow, /os: \[windows-latest, macos-latest\]/);
  assert.match(workflow, /node \.github\/scripts\/check-packed-install\.mjs --json/);
});
