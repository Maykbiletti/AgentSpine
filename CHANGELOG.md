# Changelog

All notable changes to AgentSpine will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Ten-gate `agentspine audit` command and MCP tool
- Privacy-scoped entities and relationships for people, agents, groups, channels, and projects
- Append-only history for superseded document annotations, document links, entities, and relationships
- Broken-link and competing-candidate findings in every catalog
- Large-tree, manifest-consistency, CLI-MCP, privacy, authority, and shell-guard tests

### Changed

- `agentspine mcp` now starts the stdio server instead of returning immediately
- Discovery fingerprints files with bounded parallel reads
- Context resolution reuses catalogs and only follows confident overlay links
- Protected-source hooks recognize common mutating shell commands and refresh after tool writes
- Agent annotations cannot promote arbitrary Markdown into a constitution layer
- CI runs the repository's own ten-gate audit and uses the current maintained GitHub action majors

### Security

- Relationship attributes recursively reject permissions, rights, authorization, credentials, secrets, tokens, and API keys
- Every relationship and history record is explicitly context-only

### Planned

- Attention and open-thread signals
- Optional shared-memory adapters

## [0.1.0] - 2026-08-27

### Added

- Non-destructive Markdown discovery and SHA-256 provenance catalog
- Native Codex and Claude Code context resolution
- Exact ranged reads for sources outside the context budget
- Agent-authored overlay annotations and document graph links
- CLI, stdio MCP server, and lifecycle hooks
- Protected-source write guard for participating host tools
- Dual Claude Code and Codex plugin manifests
- Cross-platform preservation, hook, graph, and MCP tests

[Unreleased]: https://github.com/Maykbiletti/AgentSpine/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Maykbiletti/AgentSpine/releases/tag/v0.1.0
