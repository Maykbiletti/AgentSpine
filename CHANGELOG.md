# Changelog

All notable changes to AgentSpine will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Ten-gate `agentspine audit` command and MCP tool
- Privacy-scoped entities and relationships for people, agents, groups, channels, and projects
- Append-only history for superseded document annotations, document links, entities, and relationships
- Broken-link and competing-candidate findings in every catalog
- Large-tree, manifest-consistency, CLI-MCP, privacy, authority, and shell-guard tests
- Local sparse-attention state for unanswered questions, promises, check-ins, and meaningful changes
- Relationship-silence cues based on minimal interaction timestamps rather than conversation capture
- Attention CLI and MCP surfaces with quiet hours, focus suppression, throttling, disable, resolve, and permanent deletion controls
- Exact group-audience binding for group-scoped cues and activity timestamps
- Cross-process locking for concurrent local attention updates
- Evidence-backed learning candidates kept separate from accepted context
- Explicit review, low-risk opt-in promotion, supersession, rollback, and permanent learning deletion
- SHA-256 provenance capture for document evidence and serialized concurrent evidence appends
- Safe-learning CLI, MCP tools, hook metadata, audit checks, and full lifecycle tests

### Changed

- `agentspine mcp` now starts the stdio server instead of returning immediately
- Discovery fingerprints files with bounded parallel reads
- Context resolution reuses catalogs and only follows confident overlay links
- Protected-source hooks recognize common mutating shell commands and refresh after tool writes
- Agent annotations cannot promote arbitrary Markdown into a constitution layer
- CI runs the repository's own ten-gate audit and uses the current maintained GitHub action majors
- Syntax checks and protected-path comparisons are portable across Linux, macOS, and Windows
- External-state auditing handles Windows project and state directories on different drives
- Session hooks expose only due attention counts and kinds; cue text remains behind an explicit privacy-filtered read
- The ten-gate audit now validates attention authority, privacy, configuration, and external-state placement
- Accepted learning must carry auditable manual-confirmation proof or an evidence-threshold policy snapshot

### Security

- Relationship attributes recursively reject permissions, rights, authorization, credentials, secrets, tokens, and API keys
- Every relationship and history record is explicitly context-only
- Every attention cue and activity is context-only; corrupt attention policy fails closed
- Secret-shaped observations and authority assertions are rejected before learning storage

### Planned

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
