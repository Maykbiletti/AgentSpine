# Changelog

All notable changes to AgentSpine will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Windows Node 24 state writes now treat transient lock access errors as contention across every lock-backed store, retry atomic replacements with a bounded backoff, and tolerate briefly retained handles during hermetic cleanup

## [0.8.0] - 2026-08-29

### Added

- Provider-neutral authenticated channel ingress with exact provider, tenant, account, chat, thread, sender, agent, project, group, and session bindings
- Durable per-agent event lanes with replay protection, atomic leases, expired-lease recovery, revocation cancellation, retained history, and integrity receipts
- Automatic `agentspine.voice-brief/v1` projection from exact visible persona, preference, correction, no-go, current-task, promise, and blocker context
- Installed-bundle proof that both Claude Code and Codex receive one exact authenticated channel event and voice profile with zero model-side MCP calls
- Pinned OpenClaw and Hermes harness reference study documenting adopted, adapted, and deliberately excluded behavior
- Authenticated external persona-roster synchronization with stable identities and append-only join, rename, leave, group-change, and rejoin events
- Bounded native Claude Code and Codex agent-manifest discovery under one approved roster scope, including distinct deactivation, exact profile/tenant identity, rename stability, and immediate membership removal
- Optional `agentspine-worker` with Telegram polling and delivery, one absolute shell-free host runner, per-agent lanes, focused goals, checkpoints, retries, health state, and a local kill switch
- Event-driven desired-state wake, deadline reconciliation, restartable prepared outbox delivery, bounded host-failure retry, independent stale-heartbeat audit, and explicit dead-letter versus delivery-unknown terminal states
- Transient German, English, Swedish, and Spanish response cues plus an advisory voice guard against fabricated attachment, emotion, or consciousness claims
- Empty- and populated-profile hermetic test execution so real user state cannot change test expectations

### Changed

- The shared hook document now uses only the documented `description` and `hooks` top-level fields; version/cache identity stays in the host manifests
- Host checks no longer report live Codex hook trust as proven merely because the shared hook entrypoint can execute directly
- Native Codex hook input is recognized from its Codex-specific `model` field or plugin environment even when no synthetic `host` field and no explicit `CODEX_HOME` override exist
- Session briefings reserve a bounded voice section and report voice omissions in the same compact-JSON budget
- Channel policy and runtime inspection are available through local CLI commands while every channel administration and execution operation remains absent from MCP
- A configured roster file is reread before every worker reconciliation, so authenticated team additions and removals become visible without a new chat prompt
- Promise and resolved-blocker lifecycle events now enter the same durable wake queue as direct messages and owner-assigned goals

### Security

- Channel policy changes require explicit local owner confirmation; wildcard routes and senders, unknown agents/projects/groups, and invalid group membership fail closed
- HMAC secrets remain environment-only, signatures are never stored, secret-bearing messages are rejected, and event ID collisions cannot overwrite earlier payloads
- Current and retained events, policy history, payload digests, route bindings, receipt digests, and authority markers are replayed by the ten-gate audit
- Channel state and voice context cannot grant host, tool, file, network, send, delegation, production, or execution rights
- Persona events, roster receipts, gateway history, queue and delivery IDs, lanes, checkpoints, and receipts fail closed under structural or digest manipulation
- Persona activity and exact group membership plus revoked reply grants are rechecked at claim, run completion, and immediately before network effect; known no-effect exhaustion cannot enter a supervisor restart loop
- Provider and ingress credentials remain environment-only and are removed from the environment passed to the host runner

## [0.7.0] - 2026-08-29

### Added

- External, integrity-checked indexed-memory metadata/content cache with atomic multi-process updates, immediate link-removal pruning, and cache purge on source-binding rollback or purge
- Explicit relevance markers for `always`, person, project, group, task, and prompt-keyword scopes; unproven fact files remain unopened and omitted
- Privacy-bounded indexed-memory diagnostics for indexed, relevant, loaded, cache-hit, cache-miss, missing, scope, path, symlink, size, and race outcomes
- Explicit `doctor --offline-memory-orphans` enumeration that reports counts only and remains outside every live lifecycle path
- Real temporary 50,000-file acceptance with deterministic open-count instrumentation and a source-level ban on directory enumeration in the live indexed-memory module

### Changed

- Claude project-memory resolution now treats `MEMORY.md` as the explicit index and opens only directly linked, relevant Markdown facts instead of walking the complete memory tree
- Package, lockfile, Claude Code, Codex, marketplace, and hook-bundle versions advance together to `0.7.0`; upgrade acceptance rejects the cached `0.6.0` bundle

### Security

- Indexed memory targets are opened with no-follow semantics and validated through one filehandle before and after reading; file replacement races retry and then reject visibly
- Missing targets, path escapes, symlinked paths, non-regular files, oversized sources, transitive links, stale cache records, and corrupt cache state cannot enter the briefing
- Cache and relevance remain context-only and cannot create identity, rights, delegation, trust, capabilities, network access, or self-starter policy

## [0.6.0] - 2026-08-28

### Added

- Provider-neutral host-native source-root registry with bounded Claude profile, project-chain, project-memory, Codex home, root-marker, fallback-name, and nested-override resolution
- Explicit portable user-state binding with provenance, conflict detection, rollback, purge, and low-risk learning-only projection across repositories and hosts
- Installed production-hook RED/GREEN reproduction of the real zero-source failure from an AgentSpine checkout and foreign working directory
- `source-status`, `source-bind`, `source-rollback`, and `source-purge` CLI workflows plus host-aware Doctor and Audit diagnostics

### Changed

- Package, lockfile, Claude Code, Codex, marketplace, and hook-bundle versions advance together to `0.6.0`
- The lifecycle bundle declares `agentspine.source-roots/v1`; upgrade tests reject the cached `0.5.0` bundle
- Automatic briefing uses separate user, project, and project-memory bindings instead of treating the launch directory as one recursive source root

### Security

- Home-wide scans, foreign-repository discovery, symlink following, guessed Claude memory paths, blind root-hash state copying, and project-state flattening are prohibited and tested
- Empty or damaged source resolution is visible and never reported as loaded personal continuity
- Source and migration bindings remain context-only and cannot create identities, roles, delegation, host trust, execution grants, capabilities, or self-starter rights

## [0.5.0] - 2026-08-28

### Added

- Visible 14-gate cross-host acceptance using new synthetic people, separated groups, Swedish and Spanish prompts, real lifecycle restart and compaction boundaries, and zero model-side MCP calls
- Deterministic SHA-256 receipts for identity, multilingual continuity, attention, isolation, correction, rollback, purge, authorized resume, denied foreign effects, durable checkpoints, source preservation, and the final audit
- Installed-bundle acceptance for both fresh installation and upgrade from `0.4.0`

### Changed

- Package, lockfile, Claude Code, Codex, marketplace, and hook-bundle versions advance together to `0.5.0`
- The lifecycle bundle declares `agentspine.acceptance/v1`
- Safe direct style, correction, no-go, project-fact, promise, and blocker recognition covers the Swedish and Spanish acceptance paths

### Security

- Person and exact-group negative visibility, a denied foreign lease effect, complete person purge, and byte-for-byte source preservation are visible acceptance gates
- Acceptance state is synthetic, external, temporary, and transcript-free; its receipts create no identity, trust, approval, or authority
- Fresh-install and upgrade proofs require exactly one MCP server, exactly one hook set, and complete automatic behavior with `mcpCalls: 0`

## [0.4.0] - 2026-08-28

### Added

- Rights-bound self-starter for one exact waiting job with durable checkpoints, expiring leases, retry budget, backoff, crash recovery, audit receipts, cancellation, and purge
- Native Claude Code and Codex lifecycle path from `SessionStart` through `PreToolUse`, `PostToolUse`, `Stop`, and a new-session resume without a model-side MCP call or repeated job envelope
- Separate local execution policy binding actor, action set, job, task, target, project, optional group, host, and finite tool capabilities
- Fresh-install and `0.3.0` upgrade proof for exactly one MCP server, one hook set, an authorized effect, a durable checkpoint, and automatic resume

### Changed

- Package, lockfile, Claude Code, Codex, marketplace, and hook-bundle versions advance together to `0.4.0`
- The lifecycle bundle declares `agentspine.selfstarter/v1` and resolves active jobs from the native host session
- Ten-gate audit includes external execution-policy and job-state integrity without reading either as context authority

### Security

- Every start, resume, and effect rechecks the current exact grant, task assignment, scope, host session, capability, lease, and content-bound workspace fingerprint
- Memory, Markdown, learning, relationships, attention, tasks, prior approvals, model claims, and MCP responses cannot create or widen execution rights
- Unknown effects, concurrent leases, revocation, expiry, workspace drift, uncheckpointed crash changes, retry exhaustion, malformed state, and protected-source writes fail closed
- MCP exposes no execution-policy grant, revoke, job registration, cancellation, or checkpoint administration

## [0.3.0] - 2026-08-28

### Added

- Provider-neutral heartbeat, promise, and blocker lifecycle events written by installed Claude Code and Codex hooks without a model-side MCP call
- Exact actor, group, project, and task binding with stable event identity, minimal SHA-256 provenance, idempotent receipts, occurrence counts, and retained prior versions
- Automatic current-task event injection at start, restart, prompt, and compaction boundaries, including stale-heartbeat, open-promise, and open-blocker handling
- CLI inspection and permanent event deletion plus entity purge across events, receipts, history, and presentation throttles
- Fresh-install and previous-version upgrade test that proves one MCP server, one hook set, automatic event capture, restart injection, and source-preserving uninstall

### Changed

- Package, lockfile, Claude Code, Codex, marketplace, and hook-bundle versions advance together to `0.3.0`
- Focus mode suppresses unrelated cues while permitting an active blocker, due promise, or stale heartbeat for the exact current task
- Parallel catalog replacement uses collision-free atomic temporary paths across concurrent lifecycle hooks

### Security

- Automatic prompt events require the local continuity opt-in and reject group conversation content, secrets, identity claims, rights, roles, delegation, access, production, payment, and approval claims
- Corrupt attention lifecycle state and unknown task scope fail closed; events remain context-only and can neither send messages nor create authority

## [0.2.0] - 2026-08-28

### Added

- Native Claude Code and Codex lifecycle integration that automatically injects the actual scoped, byte-budgeted session briefing at start, resume, prompt, and compaction boundaries without a model-side MCP call
- Separate local opt-in for minimal high-confidence style, preference, no-go, correction, project-fact, and reference learning with digest provenance, deduplication, rollback, purge, and no transcript retention
- Complete hook inventory for prompt, tool, compaction, stop, and subagent-stop boundaries plus reproducible fresh-install, stale-cache upgrade, and uninstall preservation checks

### Changed

- Claude Code explicitly registers the MCP file and loads exactly one hook bundle from its native `hooks/hooks.json` discovery path
- Package, lockfile, Claude Code, Codex, and marketplace cache versions advance together to `0.2.0`
- Session hooks now inject usable accepted context instead of counts and a suggestion to call `session_briefing`

### Security

- Automatic learning rejects secrets, sensitive personal facts, identity merging, private group content, rights, roles, delegation, approvals, tool or file access, network or database access, production, payments, and policy claims
- Hook JSON input is bounded, state remains external and atomically locked, malformed state is visible and fail-closed, and source Markdown remains byte-for-byte unchanged

### Added

- Executable Claude Code and Codex host-registration check with a real MCP `initialize` handshake
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

- Claude Code now receives an explicit manifest reference to the bundled `.mcp.json`, preventing the MCP server from disappearing in installations that do not apply implicit component discovery
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

[Unreleased]: https://github.com/Maykbiletti/AgentSpine/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Maykbiletti/AgentSpine/releases/tag/v0.1.0
