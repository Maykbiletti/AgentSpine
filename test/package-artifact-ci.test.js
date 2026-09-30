import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("packed install failures expose bounded redacted child diagnostics", async () => {
  const { formatPackedInstallFailure } = await import(
    "../.github/scripts/packed-install-diagnostic.mjs"
  );
  const error = Object.assign(new Error("synthetic npm failure"), {
    code: 1,
    stdout: "npm notice preparing synthetic package\n",
    stderr: [
      "npm error code EACCES",
      "npm error marker PACKED_INSTALL_DIAGNOSTIC",
      "npm error registry https://synthetic-token@registry.invalid/package",
      "npm error authorization Digest username=synthetic-user, response=synthetic-digest",
      "npm error _authToken=synthetic-token-value-123456"
    ].join("\n")
  });

  const diagnostic = formatPackedInstallFailure(error);
  assert.match(diagnostic, /PACKED_INSTALL_DIAGNOSTIC/);
  assert.match(diagnostic, /npm error code EACCES/);
  assert.match(diagnostic, /stdout:/);
  assert.match(diagnostic, /stderr:/);
  assert.doesNotMatch(diagnostic, /synthetic-token@/);
  assert.doesNotMatch(diagnostic, /synthetic-digest/);
  assert.doesNotMatch(diagnostic, /synthetic-token-value-123456/);
  assert(Buffer.byteLength(diagnostic) <= 12 * 1024);
});

test("Windows and macOS install and update the packed artifact", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /packed-install:\n/);
  assert.match(workflow, /os: \[windows-latest, macos-latest\]/);
  assert.match(workflow, /node \.github\/scripts\/check-packed-install\.mjs --json/);
});
