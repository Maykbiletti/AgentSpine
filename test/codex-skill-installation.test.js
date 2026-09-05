import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodexSkill } from "../src/lib/codex-skill-installation.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentspine-codex-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function syntheticPackage(root, name, version, body) {
  const packageRoot = join(root, name);
  await mkdir(join(packageRoot, "skills", "agent-spine"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "agent-spine", version })}\n`);
  const content = `---\nname: agent-spine\ndescription: Synthetic ${version} skill.\n---\n\n${body}\n`;
  await writeFile(join(packageRoot, "skills", "agent-spine", "SKILL.md"), content);
  return { packageRoot, content };
}

test("Codex skill install is idempotent and updates one managed native skill", async (t) => {
  const root = await fixture(t);
  const skillsRoot = join(root, "home", ".agents", "skills");
  const firstPackage = await syntheticPackage(root, "package-a", "1.0.0", "First instructions.");
  const secondPackage = await syntheticPackage(root, "package-b", "1.1.0", "Second instructions.");
  await mkdir(skillsRoot, { recursive: true });
  const foreign = join(skillsRoot, "foreign-skill.txt");
  await writeFile(foreign, "foreign bytes\r\nremain exact\n");
  const foreignBefore = await readFile(foreign);

  const installed = await installCodexSkill({ skillsRoot, packageRoot: firstPackage.packageRoot });
  assert.equal(installed.status, "installed");
  assert.equal(installed.version, "1.0.0");
  assert.equal(await readFile(installed.skillPath, "utf8"), firstPackage.content);
  const unchanged = await installCodexSkill({ skillsRoot, packageRoot: firstPackage.packageRoot });
  assert.equal(unchanged.status, "unchanged");

  const updated = await installCodexSkill({ skillsRoot, packageRoot: secondPackage.packageRoot });
  assert.equal(updated.status, "updated");
  assert.equal(updated.version, "1.1.0");
  assert.equal(await readFile(updated.skillPath, "utf8"), secondPackage.content);
  assert.deepEqual(await readFile(foreign), foreignBefore);
});

test("Codex skill install recovers crashes before and after skill publication", async (t) => {
  const root = await fixture(t);
  const skillsRoot = join(root, "skills");
  const firstPackage = await syntheticPackage(root, "package-a", "2.0.0", "First recovery instructions.");
  const secondPackage = await syntheticPackage(root, "package-b", "2.1.0", "Second recovery instructions.");

  await assert.rejects(installCodexSkill({
    skillsRoot, packageRoot: firstPackage.packageRoot, faultAfter: "marker"
  }), /crash after Codex skill update marker/);
  const installed = await installCodexSkill({ skillsRoot, packageRoot: firstPackage.packageRoot });
  assert.equal(installed.status, "installed");
  assert.equal(await readFile(installed.skillPath, "utf8"), firstPackage.content);

  await assert.rejects(installCodexSkill({
    skillsRoot, packageRoot: secondPackage.packageRoot, faultAfter: "skill"
  }), /crash after Codex skill publication/);
  const recovered = await installCodexSkill({ skillsRoot, packageRoot: secondPackage.packageRoot });
  assert.equal(recovered.status, "unchanged");
  assert.equal(recovered.version, "2.1.0");
  assert.equal(await readFile(recovered.skillPath, "utf8"), secondPackage.content);
});

test("Codex skill install rejects unmanaged, symlinked, and tampered destinations", async (t) => {
  const root = await fixture(t);
  const pkg = await syntheticPackage(root, "package", "3.0.0", "Protected instructions.");

  const unmanagedRoot = join(root, "unmanaged");
  await mkdir(join(unmanagedRoot, "agent-spine"), { recursive: true });
  const unmanagedPath = join(unmanagedRoot, "agent-spine", "SKILL.md");
  await writeFile(unmanagedPath, "foreign skill bytes\n");
  await assert.rejects(installCodexSkill({
    skillsRoot: unmanagedRoot, packageRoot: pkg.packageRoot
  }), /unmanaged agent-spine skill/);
  assert.equal(await readFile(unmanagedPath, "utf8"), "foreign skill bytes\n");

  const linkedRoot = join(root, "linked");
  const linkedTarget = join(root, "linked-target");
  await mkdir(linkedRoot);
  await mkdir(linkedTarget);
  await symlink(linkedTarget, join(linkedRoot, "agent-spine"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installCodexSkill({
    skillsRoot: linkedRoot, packageRoot: pkg.packageRoot
  }), /non-symlink directory/);

  const managedRoot = join(root, "managed");
  const installed = await installCodexSkill({ skillsRoot: managedRoot, packageRoot: pkg.packageRoot });
  await writeFile(installed.skillPath, "tampered\n");
  await assert.rejects(installCodexSkill({
    skillsRoot: managedRoot, packageRoot: pkg.packageRoot
  }), /changed outside its managed update/);
});

test("parallel Codex skill installs serialize without duplicate ownership", async (t) => {
  const root = await fixture(t);
  const skillsRoot = join(root, "skills");
  const pkg = await syntheticPackage(root, "package", "4.0.0", "Parallel instructions.");
  const results = await Promise.all(Array.from({ length: 4 }, () => installCodexSkill({
    skillsRoot, packageRoot: pkg.packageRoot
  })));
  assert.equal(results.filter((result) => result.status === "installed").length, 1);
  assert.equal(results.filter((result) => result.status === "unchanged").length, 3);
  assert.equal(await readFile(results[0].skillPath, "utf8"), pkg.content);
});
