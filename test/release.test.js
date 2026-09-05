import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseCheck } from "../scripts/release-check.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeReleaseFixture(fixture, { claudeVersion = "1.2.3", runtimeVersion = "1.2.3" } = {}) {
  await mkdir(join(fixture, ".claude-plugin"), { recursive: true });
  await mkdir(join(fixture, ".codex-plugin"), { recursive: true });
  await mkdir(join(fixture, "hooks"), { recursive: true });
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "agent-spine", version: "1.2.3",
    repository: { url: "git+https://github.com/Maykbiletti/AgentSpine.git" }
  }));
  await writeFile(join(fixture, "package-lock.json"), JSON.stringify({
    name: "agent-spine", version: "1.2.3",
    packages: { "": { name: "agent-spine", version: "1.2.3" } }
  }));
  await writeFile(join(fixture, "blun.plugin.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(join(fixture, ".claude-plugin", "plugin.json"), JSON.stringify({ version: claudeVersion }));
  await writeFile(join(fixture, ".codex-plugin", "plugin.json"), JSON.stringify({
    version: "1.2.3", hooks: "./hooks/codex.json"
  }));
  await writeFile(join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({
    plugins: [{ version: "1.2.3" }]
  }));
  await writeFile(join(fixture, "hooks", "version.json"), JSON.stringify({
    schema: "agentspine.hook-bundle/v1", version: "1.2.3", contract: "agentspine.preflight/v2"
  }));
  await writeFile(join(fixture, "src", "version.js"),
    `export const VERSION = "${runtimeVersion}";\n`);
  await writeFile(join(fixture, "CHANGELOG.md"), "## [1.2.3] - 2030-01-01\n");
}

test("release check validates every host version and the exact safe package boundary", async () => {
  const source = await readFile(join(root, "AGENTS.md"));
  const before = sha(source);
  const result = await releaseCheck({
    root, tag: "v0.72.7", allowDirty: true, skipPack: false, json: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, "0.72.7");
  assert.equal(result.package.filename, "agent-spine-0.72.7.tgz");
  assert.match(result.package.integrity, /^sha512-/);
  assert.equal(result.package.files > 40, true);
  assert.equal(result.package.packedSize > 0 && result.package.packedSize <= 512 * 1024, true);
  assert.equal(result.package.unpackedSize > 0 && result.package.unpackedSize <= 2304 * 1024, true);
  assert.equal(sha(await readFile(join(root, "AGENTS.md"))), before);
});

test("release check fails closed when one host manifest has a different version", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "agentspine-release-"));
  t.after(() => rm(fixture, { recursive: true }));
  await writeReleaseFixture(fixture, { claudeVersion: "1.2.2" });
  await assert.rejects(releaseCheck({
    root: fixture, tag: "v1.2.3", allowDirty: true, skipPack: true, json: true
  }), /version differs across package and host manifests/);
});

test("release check fails closed when the runtime version is stale", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "agentspine-runtime-release-"));
  t.after(() => rm(fixture, { recursive: true }));
  await writeReleaseFixture(fixture, { runtimeVersion: "1.2.2" });
  await assert.rejects(releaseCheck({
    root: fixture, tag: "v1.2.3", allowDirty: true, skipPack: true, json: true
  }), /version differs from src\/version\.js/);
});

test("CI and release workflows pin every action and isolate write permission", async () => {
  const values = await Promise.all([
    readFile(join(root, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
    readFile(join(root, ".github", "CODEOWNERS"), "utf8"),
    readFile(join(root, ".gitattributes"), "utf8")
  ]);
  const [ci, release, owners, attributes] = values.map((value) => value.replace(/\r\n/g, "\n"));
  const workflows = `${ci}\n${release}`;
  const uses = [...workflows.matchAll(/^\s*-?\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map((match) => match[1]);
  assert.equal(uses.length >= 8, true);
  assert.equal(uses.every((reference) => /^[a-f0-9]{40}$/.test(reference)), true);
  assert.match(ci, /permissions:\n\s+contents: read/);
  assert.match(ci, /npm run release:check/);
  assert.match(attributes, /^\* text=auto eol=lf\n$/,
    "release inputs must stay LF-normalized so the byte limit is platform-independent");
  assert.match(release, /tags:\n\s+- "v\*\.\*\.\*"/);
  assert.doesNotMatch(release, /pull_request/);
  assert.match(release, /id-token: write/);
  assert.match(release, /attestations: write/);
  assert.match(release, /publish-github:[\s\S]*permissions:\n\s+contents: write/);
  assert.match(release, /npm sbom --sbom-format cyclonedx/);
  assert.match(release, /sha256sum/);
  assert.match(release, /actions\/attest@[a-f0-9]{40}/);
  assert.match(release, /--verify-tag/);
  assert.doesNotMatch(release, /NPM_TOKEN|npm publish/);
  assert.match(owners, /\/\.github\/ @Maykbiletti/);
});
