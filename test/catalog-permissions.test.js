import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog } from "../src/lib/catalog.js";
import { hookScanAuditPath } from "../src/lib/hook-audit.js";
import { skippableTraversalError } from "../src/lib/source-tree-scan.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function windowsSid() {
  const result = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const sid = result.stdout.match(/S-\d(?:-\d+)+/)?.[0];
  assert.ok(sid, `could not resolve the current Windows SID: ${result.stdout}`);
  return sid;
}

function icacls(path, args) {
  return spawnSync("icacls", [path, ...args], { encoding: "utf8" });
}

test("catalog discovery skips unreadable directories with an allow audit", async (t) => {
  assert.equal(skippableTraversalError({ code: "ENOTDIR" }), true);
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("POSIX permission denial requires an unprivileged test process; the Windows icacls lane remains mandatory");
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-catalog-permission-"));
  const root = join(workspace, "project");
  const restricted = join(root, "restricted-catalog-entry");
  const state = join(workspace, "state");
  await Promise.all([mkdir(restricted, { recursive: true }), mkdir(state)]);
  const sourcePath = join(root, "AGENTS.md");
  const source = "# Synthetic rules\n\nKeep this source byte-exact.\n";
  await writeFile(sourcePath, source, "utf8");
  await writeFile(join(restricted, "PRIVATE.md"), "# Unreadable synthetic fixture\n", "utf8");
  const canonicalRestricted = await realpath(restricted);
  const before = hash(await readFile(sourcePath));

  let sid = null;
  if (process.platform === "win32") {
    sid = windowsSid();
    const denied = icacls(restricted, ["/inheritance:r", "/deny", `*${sid}:(OI)(CI)(F)`]);
    assert.equal(denied.status, 0, denied.stderr || denied.stdout);
  } else {
    await Promise.all([chmod(workspace, 0o755), chmod(root, 0o755), chmod(state, 0o777)]);
    await chmod(restricted, 0o000);
  }

  t.after(async () => {
    if (process.platform === "win32" && sid) {
      icacls(restricted, ["/remove:d", `*${sid}`]);
      icacls(restricted, ["/inheritance:e"]);
    } else {
      await chmod(restricted, 0o700).catch(() => {});
    }
    await rm(workspace, { recursive: true, force: true });
  });

  const env = { ...process.env, AGENTSPINE_STATE_DIR: state };
  const catalog = await buildCatalog(root, { env });
  assert.deepEqual(catalog.documents.map((item) => item.relativePath), ["AGENTS.md"]);
  const audits = (await readFile(hookScanAuditPath(env), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(audits.some((item) => item.path === canonicalRestricted && item.event === "CatalogScan"
    && item.phase === "document-discovery" && item.decision === "allow"
    && ["EPERM", "EACCES"].includes(item.code)));
  assert.equal(hash(await readFile(sourcePath)), before);
});
