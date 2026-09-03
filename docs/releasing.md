# Release process

AgentSpine releases are intentionally tag-authorized while the package is pre-1.0. A maintainer decides when to tag; the repository then builds, verifies, attests, and publishes one traceable release bundle from that exact commit. Pull requests and ordinary branch pushes can never enter the release workflow.

## Local release gate

Update every release version surface: `package.json`, both version fields in `package-lock.json`, the BLUN, Claude and Codex host manifests, the Claude marketplace entry, `hooks/version.json`, and `src/version.js`. Move the relevant changelog entries from **Unreleased** into a dated SemVer section, then run:

```bash
npm ci
npm run check
npm run release:check -- --tag vX.Y.Z
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
python3 /path/to/skill-creator/scripts/quick_validate.py skills/agent-spine
npm pack --dry-run
```

The plugin validator must implement the current [Codex plugin-bundled hooks contract](https://developers.openai.com/codex/hooks#plugin-bundled-hooks), including the documented `hooks` override. A validator snapshot that rejects this field is stale and cannot certify this release; do not remove the override, because Codex would otherwise load the Claude-specific default hook bundle.

`release:check` fails unless:

- all release version surfaces agree and the tag is exactly `v{package.version}`;
- the changelog has a dated section for that version;
- the Git worktree is clean;
- npm reports SHA-512 integrity and a correctly versioned tarball;
- every required Claude Code, Codex, MCP, CLI, source, skill, documentation, license, and changelog file is packaged;
- no `.env`, key material, Git metadata, tests, workflow files, generated AgentSpine state, or user-owned `AGENTS.md`, `CLAUDE.md`, `SOUL.md`, or `MEMORY.md` enters the tarball;
- the package remains within explicit file-count and unpacked-size ceilings.

## Tag and automated release

Only after the release commit is on a fully green `main`, create a signed or annotated tag and push it:

```bash
git tag -s vX.Y.Z -m "AgentSpine vX.Y.Z"
git push origin vX.Y.Z
```

The tag workflow then:

1. checks out the immutable tag with full history;
2. proves the tagged commit is contained in `main`;
3. installs only the lockfile dependency graph;
4. repeats the complete test, audit, host, metadata, changelog, and package-boundary gates;
5. creates the `.tgz`, a CycloneDX SBOM, and SHA-256 checksums;
6. creates GitHub build-provenance and SBOM attestations through short-lived OIDC credentials;
7. transfers the bundle through a named workflow artifact;
8. gives only the final isolated job `contents: write` and creates the GitHub Release from the existing tag.

Every external action is pinned to a full commit SHA. Dependabot watches those pins. The normal CI workflow has only `contents: read`; the build/attestation release job has `contents: read`, `id-token: write`, and `attestations: write`; only the asset-publication job has `contents: write`. No release job receives AgentSpine memory, signing keys, bearer values, npm tokens, or user source files.

Protect the GitHub `release` environment with required reviewers if the repository plan supports it. Enable immutable releases and tag protection in repository settings where available. Workflow checks are defense in depth and do not replace repository rulesets.

## Verify a downloaded release

After downloading the tarball, SBOM, and `SHA256SUMS` from GitHub Releases:

```bash
sha256sum --check SHA256SUMS
gh attestation verify agent-spine-X.Y.Z.tgz \
  --repo Maykbiletti/AgentSpine
```

Inspect the package without installation:

```bash
npm pack --dry-run ./agent-spine-X.Y.Z.tgz
```

Then install the exact tarball in fresh Claude Code and Codex environments and repeat `agentspine doctor`, the MCP handshake, source scan, verification, and audit.

## Optional npm publication

The GitHub workflow deliberately does not publish to npm until ownership of the package name and the registry-side trust relationship are configured. When enabled, use npm Trusted Publishing bound to this repository, the exact release workflow filename, a GitHub-hosted runner, and a protected release environment. Keep OIDC provenance enabled and do not introduce a long-lived `NPM_TOKEN`.

Authoritative references:

- [GitHub artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
- [GitHub secure use reference](https://docs.github.com/actions/reference/security/secure-use)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements/)

## Rollback

Never move, reuse, or delete an existing public version tag to hide a bad release. Publish a patch release that reverts the faulty behavior, retain the original checksums and attestations, and explain the affected versions. Uninstalling AgentSpine or deleting its external state must still leave every scanned project file untouched.
