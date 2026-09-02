import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/permission-scan-probe.js", import.meta.url));

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

test("unreadable directories are skipped by both walkers and never deny PreToolUse", async (t) => {
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("POSIX permission denial requires an unprivileged test process; the Windows icacls lane remains mandatory");
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "agentspine-permission-scan-"));
  const root = join(workspace, "project");
  const restricted = join(root, "ElevatedDiagnostics");
  const state = join(workspace, "state");
  const host = join(workspace, "host");
  await Promise.all([
    mkdir(join(root, ".git"), { recursive: true }),
    mkdir(restricted, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(host, { recursive: true })
  ]);
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
    await Promise.all([chmod(workspace, 0o755), chmod(root, 0o755), chmod(state, 0o777), chmod(host, 0o755)]);
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

  const result = spawnSync(process.execPath, [probe, root], {
    cwd: pluginRoot,
    encoding: "utf8",
    env: { ...process.env, AGENTSPINE_STATE_DIR: state, CODEX_HOME: host }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.sourceSkipped.some((item) => item.path === canonicalRestricted && ["EPERM", "EACCES"].includes(item.code)),
    JSON.stringify(output.sourceSkipped));
  assert.ok(output.fingerprintSkipped.some((item) => item.path === canonicalRestricted && ["EPERM", "EACCES"].includes(item.code)),
    JSON.stringify(output.fingerprintSkipped));
  assert.equal(output.sourceDocuments.some((path) => path.includes("PRIVATE.md")), false);
  assert.deepEqual(output.hooks.map((item) => item.toolName),
    ["Edit", "Write", "apply_patch", "Bash", "exec_command"]);
  for (const { toolName, result: hook } of output.hooks) {
    assert.equal(hook.blocked, false, toolName);
    assert.equal(hook.scanFailedOpen, true, toolName);
  }
  const permissionAudits = output.audit.filter((item) => item.path === canonicalRestricted && item.decision === "allow");
  assert.deepEqual(permissionAudits.map((item) => item.toolName),
    ["Edit", "Write", "apply_patch", "Bash", "exec_command"]);
  assert.equal(hash(await readFile(sourcePath)), before);
});
