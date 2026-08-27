# Release process

AgentSpine releases are intentionally manual while the package is pre-1.0. A release is cut only from a clean, green `main`.

## Checklist

1. Confirm the milestone is one coherent user-visible outcome.
2. Rebase or merge the latest `origin/main` without discarding concurrent work.
3. Update the version in `package.json`, `package-lock.json`, both host manifests, and the Claude marketplace entry.
4. Move relevant changelog entries from **Unreleased** into a dated SemVer section.
5. Run `npm ci`, `npm run check`, both plugin/skill validators, and `npm pack --dry-run`.
6. Inspect the tarball file list for private state, fixtures containing real identities, or unexpected generated files.
7. Run `agentspine audit . --json`; document deliberate local-link findings before release.
8. Push the clean commit to `main` and wait for every CI matrix job to pass.
9. Create a signed or annotated `vX.Y.Z` tag from that exact commit and publish release notes from the changelog.
10. Install the released artifact in fresh Claude Code and Codex environments and repeat the doctor/MCP handshake.

Automated tests enforce version parity across the npm package, lockfile, Claude Code manifest, Codex manifest, and marketplace metadata. CI has read-only repository permissions and release publication is not granted to pull-request workflows.

## Rollback

Do not move an existing public tag. Publish a patch release that reverts the faulty behavior, and explain the affected versions. Uninstalling AgentSpine or deleting its external state must leave every scanned project file untouched.
