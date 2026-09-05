import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { renderAcceptanceReport, runVisibleAcceptance } from "../src/lib/acceptance.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("visible multilingual acceptance proves the complete automatic team-partner path", async () => {
  const report = await runVisibleAcceptance();
  assert.equal(report.ok, true);
  assert.equal(report.passed, report.total);
  assert.equal(report.total, 15);
  assert.deepEqual(report.hosts, ["claude", "codex"]);
  assert.deepEqual(report.languages, ["sv-SE", "es-ES"]);
  assert.equal(report.mcpCalls, 0);
  assert.match(report.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(new Set(report.checks.map((item) => item.id)).size, report.total);
  assert.ok(report.checks.every((item) => item.status === "PASS" && /^[a-f0-9]{64}$/.test(item.receipt)));
  assert.match(report.checks.find((item) => item.id === "authorized-resume").detail,
    /Premortem lag vor dem ersten Write/);
  assert.match(report.checks.find((item) => item.id === "denied-resume").detail,
    /Premortem verlieh Lucía keine Berechtigung/);
  const visible = renderAcceptanceReport(report);
  assert.match(visible, /\[PASS\] Mehrsprachige Stilkontinuität/);
  assert.match(visible, /\[PASS\] Verweigerte Fremdwirkung/);
  assert.match(visible, /\[PASS\] Verpflichtender Pre-Answer-Recall/);
  assert.match(visible, /\[PASS\] Gesamt — 15\/15 Gates/);
});

test("acceptance CLI emits a reproducible machine-readable receipt", () => {
  const result = spawnSync(process.execPath, [join(root, "bin/agentspine.js"), "acceptance", "--json"], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, "agentspine.acceptance/v1");
  assert.equal(report.version, "0.72.5");
  assert.equal(report.total, 15);
  assert.equal(report.mcpCalls, 0);
});

test("long host paths keep all mandatory preflight stages inside the unchanged injection budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentspine-long-host-"));
  try {
    const padding = "x".repeat(Math.max(1, 138 - Buffer.byteLength(directory) - 1));
    const nested = join(directory, padding);
    await mkdir(nested);
    const result = spawnSync(process.execPath, [join(root, "bin/agentspine.js"), "acceptance", "--json"], {
      cwd: root, encoding: "utf8", env: { ...process.env, TMPDIR: nested, TMP: nested, TEMP: nested }
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, 15);
    assert.equal(report.total, 15);
    assert.equal(report.checks.find(check => check.id === "source-bytes").status, "PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
