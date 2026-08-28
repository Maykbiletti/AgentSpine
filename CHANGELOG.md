# Changelog

All notable changes to AgentSpine will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Optional local SQLite snapshot transport with immutable signed-adapter binding, append-only hash-linked revisions, atomic head advancement, full integrity replay, quarantined pull, CLI integration, and no MCP database authority
- One-shot challenge-response peer transport over an owner-selected stdin/stdout carrier, with a fresh nonce, live Ed25519 proof, shell-free process execution, environment minimization, quarantine import, CLI integration, and no MCP process authority
- Provider-neutral signed HTTPS feed with strong ETag compare-and-swap publication, bounded hash-chain continuity, external rollback receipts, quarantined pull, CLI integration, audit coverage, and no MCP transport authority
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
- Separate default-deny delegation policy with explicit actor, action, target, provenance, revision, and revocation history
- Context-only tasks, open threads, and handoffs with assignment snapshots and retained prior versions
- Coordination CLI, read/check MCP surfaces, privacy-filtered hook metadata, audit integration, and concurrency tests
- Provider-neutral shared-event contract and optional directory adapter with immutable event files
- Quarantined, idempotent shared-memory import with a second local review before context
- Shared supersession, rollback, exact group filtering, CLI administration, read-only MCP context, hooks, and audit coverage
- Optional Ed25519 manifest and event envelopes with strict public identities and retained verification proof
- Installation-local signer generation and rotation plus project-local trust, revocation, and audit replay
- Immutable signed HTTPS snapshot export and dependency-free provider-neutral pull transport
- DNS pinning, default SSRF blocking, redirect and compression rejection, bounded responses, optional environment-only bearer authentication, and explicit private-network opt-in
- Provider-neutral `session_briefing` across native sources, relationships, accepted learning, reviewed shared memory, coordination, and attention
- Current-task priority, local/shared deduplication, exact compact-JSON byte accounting, atomic omission, and group-safe metadata-only source handling
- Provider-neutral content-addressed HTTPS object publication with create-only preconditions
- Mandatory signed read-back verification and safe idempotent retry handling for immutable remote objects
- Tag-authorized GitHub release pipeline with CycloneDX SBOM, SHA-256 checksums, build provenance, and SBOM attestations
- Deterministic release metadata and package-boundary validator covering both host manifests and forbidden state/source material
- Pinned-action policy, release-sensitive CODEOWNERS, and isolated least-privilege publication jobs

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
- Cross-entity coordination now requires a matching explicit local policy grant; relationship responsibility remains descriptive only
- Session hooks expose only counts and kinds of locally reviewed shared memory; pending claims remain hidden
- Session hooks point to one explicit scoped briefing without automatically injecting its content

### Security

- Relationship attributes recursively reject permissions, rights, authorization, credentials, secrets, tokens, and API keys
- Every relationship and history record is explicitly context-only
- Every attention cue and activity is context-only; corrupt attention policy fails closed
- Secret-shaped observations and authority assertions are rejected before learning storage
- Delegation policy mutation is excluded from MCP, and malformed policy or coordination state fails closed without overwrite
- Task coordination grants no host, tool, file, network, deployment, production, billing, or spending authority
- Private learning, source content, evidence text, tasks, policy, and credentials are excluded from shared events
- Adapter administration is excluded from MCP; malformed, oversized, symlinked, collided, or tampered exchange state fails closed
- Private signing keys remain outside projects and agent surfaces; unknown, revoked, swapped, or mismatched signers fail closed
- HTTPS snapshot transport validates TLS endpoints, every DNS answer, bundle integrity, strict schema, and all nested signatures before quarantine mutation
- Group briefings reject private reads, foreign membership, and unscoped source content; briefing output remains context-only and read-only
- HTTPS publishing is CLI-only, owner-confirmed, DNS-pinned, SSRF-restricted, overwrite-free, size-bounded, and credential-safe
- Release workflows accept tags only, verify containment in `main`, use short-lived OIDC for attestations, and expose no npm or AgentSpine secrets

### Planned

- Optional hosted database transports implementing the signed-envelope and shared-event contracts

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
