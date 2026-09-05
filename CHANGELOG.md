# Changelog

All notable changes to AgentSpine will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.72.6] - 2026-09-05

### Added

- `agentspine host-install codex --confirm-local-host-install` installs one stable, managed MCP launcher under the selected Codex home. The `config.toml` entry no longer points at a versioned package cache; updates atomically replace a sealed registration behind the same launcher path while preserving every byte outside AgentSpine's marked block.
- The launcher verifies the canonical package root, regular non-symlink entrypoint, package and runtime digests, exact AgentSpine version, MCP server identity and the four required delivery/read tools before it completes `initialize`. No state-bearing tool call is forwarded before that check.

### Security and evidence limits

- Synthetic install/update/restart exercises a 0.72.5 cache followed by 0.72.6, removes the old cache, lists tools, reads an existing session source and performs the bound briefing, knowledge and premortem calls. A wrong `PLUGIN_ROOT` is ignored; foreign Codex configuration, unknown external state and source bytes remain unchanged.
- Unmanaged duplicate registrations, malformed managed blocks, symlinked homes/configuration/package roots, tampered registrations, staged crashes and parallel updates are rejected or recovered without deleting state. This is repository evidence only: no live Codex profile, Otto session, trust decision or CodexLink configuration was changed.

## [0.72.5] - 2026-09-05

### Fixed

- Delivery verification now distinguishes a successful hook/tool transport from a successful test process. The current write is verified only by a structured `exit_code: 0` / `exitCode: 0` result or the existing command-bound final success marker. `success: true`, `isError: false`, a still-running session, prose claiming tests passed and an old unbound marker remain unverified.
- Native-shaped Codex `PostToolUse` probes cover canonical `Bash` with `tool_input.command`, the Work `exec_command` result, and PowerShell-style `exitCode`. Exit 1, interrupted execution, transport-only results and text-embedded exit claims stay blocked; synthetic source bytes remain unchanged.

### Evidence limits

- The probes reproduce the documented Codex hook wire contract and measured Work tool result shape. They do not claim a live Otto restart, installation or state migration. CodexLink remains outside AgentSpine.

## [0.72.4] - 2026-09-05

### Added

- Ordinary assignments can store structured completion checks with `complete_delivery` and finish with a normal user-facing summary. Exact assignment and latest-write binding, the three mandatory preflight calls and observed successful post-write tests remain required. Stop rechecks current evidence; goal deliveries keep their existing checkpoint/outcome route.
- Hook/MCP regressions cover normal-summary red/green, separate-process restart, concurrent retries, actual crash before atomic replacement, stale writes, foreign bindings, replay and manipulated closure metadata without changing source bytes.

### Fixed and evidence limits

- A later failed or unverified test invalidates earlier successful delivery verification. A real child-process test with an incorrect artifact expectation reproduces the previous false acceptance.
- Child artifact tests now clear inherited `NODE_TEST_CONTEXT` and assert executed TAP test/failure counts. This corrects the 0.72.3 harness, where a skipped recursive child runner could exit successfully; the earlier positive exit status alone was insufficient evidence.
- Selfstarter audit assertions expose the failed gates. The CI 147 intermittent Windows failure remains unexplained despite a subsequent passing diagnostic matrix; assertions and deadlines are unchanged.
- The initial completion guidance exceeded the existing preflight injection limit on long host paths. Shorter equivalent guidance and a long-path Acceptance regression keep all mandatory stages within the unchanged budget; user source bytes are not truncated.
- Native Codex/PowerShell envelopes, host registration/update acceptance and unknown external recovery events remain open. No live installation, restart, state repair or CodexLink change is included.

## [0.72.3] - 2026-09-05

### Fixed

- Host-explicit continuation now retains one unfinished assignment and its exact premortem across supplementary prompts, restart and compaction. Closed assignments and foreign session, entity, group, task or goal-step bindings cannot be continued; normal new-delivery prompts still require fresh preflight receipts.
- Delivery knowledge queries record not-yet-created target files as an explicit absent baseline. Existing ancestors remain project-bound and non-symlinked, permission errors still abort the query, and target inspection never enumerates a directory tree.

### Evidence and limits

- Red/green probes reproduce the lost continuation requirement and ENOENT new-file failure. The combined Hook/MCP regression completes two assignments with real child-process artifact tests, preserves open write obligations through supplementary input, and rejects the first assignment's test as proof for the second write.
- Negative probes cover scope drift, completed receipts, concurrent prompts, source bytes, parent replacement, permission failure and actual process exit during continuation followed by lock-lease recovery. Synthetic unknown events/schemas remain unchanged and unaccepted; no external event semantics or live compatibility are inferred.
- Native Codex/PowerShell result-envelope diagnosis, installation registration, loaded-reader compatibility and structured MCP closure remain separate pending work. No live configuration, session or CodexLink state is changed.

## [0.72.2] - 2026-09-04

### Fixed

- Every new host prompt now starts a durable assignment identifier and its own requirement, briefing receipt, knowledge receipt and premortem. Later tool events, restart and compaction resolve the same active assignment; another prompt cannot reuse a completed delivery's receipts.
- A contradictory premortem registration is rejected into a separate integrity-sealed receipt before the valid lane is changed. The first registration, closure and goal outcome remain usable instead of becoming permanently conflicted.
- The new MCP and CLI recovery path creates a fresh assignment-bound requirement for a preserved legacy 0.72 conflict. It links predecessor and replacement while retaining the original conflict, registration, audit history and source bytes.

### Security and tests

- Assignment lookup is bound to host, session, project and any established entity, group or task. Foreign or inactive assignment IDs, replayed old prompts and scope drift are denied without granting permissions.
- Real Hook/MCP/CLI tests cover assignment A completion, assignment B isolation, conflicting registration, correction, successful B completion, parallel prompts, replay, foreign scope, restart, compaction and idempotent legacy recovery.

## [0.72.1] - 2026-09-04

### Fixed

- MCP session briefing and delivery knowledge queries now resolve the same bounded native sources as hooks. Each knowledge query shares one catalog across every contract read and its nested briefing, instead of scanning the directory tree once per contract plus once for the briefing.
- Home-root and host-profile exclusions remain effective through the MCP path. Generic hosts use bounded project sources without borrowing another provider's profile. MCP resolve/read calls use the same bounded source selection.
- Caller-supplied internal catalogs, source registries, environments and alternate state roots are rejected. Requirement-bound briefing scope is checked before source discovery. Incomplete required discovery issues no successful preflight receipt and can be retried without resetting state.
- Contract reads verify the selected source's digest and file identity using bounded handle reads; changed, replaced, deleted and symlinked sources yield no content.

### Evidence and limits

- Synthetic real-protocol Before/After: six contracts caused seven directory enumerations before this change and one afterward. Home-cwd probes for Codex, Claude and generic mode perform zero reads or enumeration in the unrelated home subtree and preserve source bytes.
- This is a repository-level MCP repair, not proof of native tool discovery in any installed host. The reported manifest mismatch, registration-conflict recovery and real F79 outcome remain separate open work.

## [0.72.0] - 2026-09-04

### Changed

- Split the 6,923-line outcome-bound learning runtime into 24 cohesive schema, state, evidence, evaluation, validation, measurement, delivery, outcome, reconciliation, context, and diagnostic modules behind the unchanged 34-export compatibility surface.
- Split the 4,250-line learning regression suite into a shared synthetic fixture and 12 independently bounded behavioral suites. Every resulting production and test file is below 500 physical lines, and both legacy line-budget exceptions are removed.

### Security

- Stored schemas, immutable evidence and revocation lineages, evaluator-root independence, trial deadlines, Canary admission, blocking-defect precedence, group isolation, atomic locks, and context-only authority retain byte-equivalent implementations.
- The refactor introduces no new permissions, delegation, external effects, or model-derived evidence and does not modify user-owned sources.

### Tests

- Exact declaration-body, public-export, and test-name parity checks prove the mechanical Before/After boundary before the full learning, hook, audit, install, upgrade, package, and hermetic suites execute.
- All 50 existing learning scenarios remain intact, including concurrency, restart, corrupt-state, legacy v10-v29 upgrade, revocation, rollback, source-byte preservation, and CLI workflows.

## [0.71.0] - 2026-09-04

### Added

- A durable provider-neutral world model stores immutable provenance-bound assertions about world, user, relationship, team, and project subjects outside user-owned files.
- Session briefing now carries unexpired, non-conflicting measured or explicitly user-confirmed facts and separately exposes model proposals, stale evidence, and contradictions as uncertainty.

### Security

- Model output can never become an established fact or supersede one. A contradictory measured value removes the predicate from facts until a new established assertion explicitly supersedes the conflict.
- Exact project, group, and private scopes are enforced. Authority-shaped predicates and nested values, future observations, reused IDs, altered value digests, invalid state, and oversized values fail closed.
- Owned locks, atomic replacement, bounded state, and idempotent receipts preserve concurrent updates, crash recovery, and byte-exact user sources.

### Tests

- Synthetic scenarios cover persistence across restart-style reads, briefing integration, measured/user/model evidence separation, expiry, conflict and resolution, group isolation, private context, concurrency, idempotency, tamper rejection, MCP portability, and source-byte preservation.
- The documented Before/After boundary is observable: `0.70.0` had no world-model tools or briefing section; `0.71.0` resolves the complete synthetic context set while withholding every unsafe or uncertain assertion.

## [0.70.0] - 2026-09-04

### Changed

- Split the 911-line rights-bound self-starter into core-state, workspace, owner-policy, job-lifecycle and leased-effect domains behind the unchanged 18-export public interface.
- Every self-starter production and test file is below 500 physical lines; the legacy budget exception is gone.
- The package gate now bounds both the packed archive at 512 KiB and the unpacked tree at 2.25 MiB, retaining a finite release boundary after the module split.

### Security

- Execution grants, task and group binding, finite capabilities, workspace fingerprints, leases, effect checkpoints, crash recovery and context-only authority keep their existing fail-closed behavior.

### Tests

- Added exact public-surface ownership coverage alongside all existing self-starter lifecycle, concurrency, tamper, retry, restart and byte-preservation scenarios.

## [0.69.0] - 2026-09-04

### Changed

- Split the 1,488-line CLI into seven domains while preserving all 114 commands and behavior.
- Every CLI file is below 500 lines; its legacy budget exception is gone.

### Tests

- Added exact command-ownership coverage alongside 98 existing CLI invocations.

## [0.68.0] - 2026-09-04

### Changed

- The 1,485-line gateway runtime is decomposed into bounded contract, execution, state, control, run-lifecycle, delivery and inspection modules. The original import path remains a compatibility surface with the same 25 public exports.
- The 1,325-line gateway regression suite is split by channel delivery, plans, exploration, strategy transfer, continuity, host lifecycle, adapters and security. Every resulting production and test file stays below 500 physical lines.
- Gateway runtime and test files no longer use legacy line-budget exceptions; future growth is enforced by the ordinary 500-line gate.

### Tests

- Before/After checks compare the exact public export manifest and preserve all 56 executed gateway behaviors, including team handoff, resource serialization, objective outcomes, bounded exploration, upgrade, lock ownership, atomic pair commits and crash recovery.
- Both hermetic profiles, visible Acceptance, Audit, Fresh Install, Upgrade, host, package and release checks cover the decomposed modules.

## [0.67.0] - 2026-09-04

### Added

- Writing deliveries now require three real, ordered AgentSpine MCP calls before their first mutation: the current session briefing, a bounded knowledge query over affected target fingerprints, contracts and recent errors, and the existing three-item premortem registration.
- Each call writes a context-only, integrity-sealed receipt bound to the exact hook requirement, host session and active goal step. The hook verifies the same receipt chain before writing and completion.

### Fixed

- Catalog discovery now skips and audits unreadable or vanished directory entries with the same traversal-error policy as host source discovery, so catalog-backed MCP tools continue past protected Windows folders without changing their permissions.

### Security

- A verified missing briefing or knowledge call blocks with the exact missing stage. Text claims, receipts from another session or goal step, conflicting calls and consumed receipts cannot satisfy the gate or grant permissions.
- Read-only work remains unrestricted. Parser, scanner and filesystem uncertainty remains audited and fail-open; exact missing, conflicting, late, finalized or reused evidence remains fail-closed.
- A completed non-goal delivery can begin a fresh three-call cycle in the same host session, but cannot reuse the prior receipts. Goal-step finalization remains terminal.

### Tests

- A synthetic permission-denied catalog fixture verifies fail-open discovery, the allow audit, source byte preservation and the corresponding failing mutant.
- Before/After regressions exercise real MCP calls and prove missing-stage denial, successful three-stage admission, foreign-session and foreign-step isolation, text-claim rejection, single-use receipts, concurrent deduplication, crash-safe state integrity, bounded verification latency and source-byte preservation.
- Full hook, goal-race, restart, compact-context, Acceptance, Fresh Install, Upgrade, package and cross-platform release paths use the new contract.

## [0.66.1] - 2026-09-04

### Fixed

- Hermetic test workers now have a bounded per-file deadline and terminate the complete descendant process tree on Windows, macOS and Linux. A leaked child can no longer hold every matrix job silently until GitHub's six-hour limit.
- MCP subprocess tests now close stdin and await the server's confirmed exit, removing the unjoined pipe lifecycle that held the Windows matrix open after assertions had passed.
- MCP subprocesses are explicitly closed before Windows removes their fixtures, preventing `EBUSY` cleanup failures and ensuring test teardown cannot retain a runner.
- Every test file reports `START` immediately and a terminal `PASS`, `FAIL` or `TIMEOUT` line. CI therefore identifies the exact blocked file while retaining the prior isolated empty/populated profiles and four-worker concurrency.
- The CI matrix has an independent 20-minute outer deadline. The per-file limit can be adjusted from 1 to 900 seconds with `AGENTSPINE_TEST_FILE_TIMEOUT_MS`; its default is three minutes.
- The intentional 50,000-file offline stress probe has its own five-minute ceiling, while ordinary test files keep the three-minute deadline and explicit environment overrides remain authoritative.
- Repository text is checked out with LF on every host, so npm's 2 MiB unpacked-size safety boundary has the same byte meaning on Windows, macOS and Linux instead of growing through CRLF conversion.

### Tests

- A synthetic never-ending parent and descendant prove the runner returns code 124 within the bound and leaves neither process alive; a successful child proves normal output and completion semantics remain intact.
- The premortem conflict race now uses the hook's deterministic post-intent fence rather than filesystem scheduling, and the release contract asserts the cross-platform LF policy.

## [0.66.0] - 2026-09-03

### Added

- Before the first write-class mutation in a session, including `Write`, `Edit`, `apply_patch` and recognized common shell-mediated mutations, and separately for each active goal-plan step, the hook now requires exactly three context-only premortem statements: baseline/environment, contract/tests and delivery path, each paired with one concrete check.
- The MCP registration receipt derives immutable check IDs, binds the premortem to the exact session and step, and stores it in isolated AgentSpine state. Closed goal work carries the premortem text, digest and three check results in a separate checkpoint and outcome receipt without changing the caller-owned checkpoint.

### Security

- A verified missing, late or conflicting premortem blocks direct mutations and recognized common shell-mediated mutations at the first attempted write. After the existing post-write test gate, `Stop` and `SubagentStop` block a written delivery until all three original checks are reported as passed against the exact artifact digest and latest observed mutation digest; any later mutation invalidates the earlier closure.
- Durable `PreToolUse` mutation intents keep oversized `PostToolUse` payloads from being mistaken for read-only work. Ambiguous Codex test output is not accepted as success: the hook requires structured success evidence or a parser-bound terminal success marker and returns the portable proof command when evidence is missing.
- Delivery verification follows an exact authenticated queue attempt across host-session restarts and is otherwise session-bound. Host `Stop` events that omit `turn_id` still resolve the preceding session writes instead of opening a false read-only lane.
- Read-only sessions remain unrestricted. Parser, filesystem and local-state uncertainty is audited and fails open; premortem records are context only and cannot grant identity, permissions, tools or policy exceptions. Durable goal receipts retain only session and binding digests, not raw session identifiers.
- Project-scan truncation changes context completeness only. Protected-source, policy, identity, permission, execution-grant, aggregate-byte and mandatory-source violations keep their existing fail-closed behavior.
- Waiting-job pauses are scoped to the current stop event and cannot become reusable completion bypasses. Shell mutation detection unwraps bounded `sudo`, `env`, `command`, `builtin` and `exec` prefixes, and goal completion recovers verified state files whose index write was interrupted.
- Once an external host runner has been invoked, any thrown or invalid outcome is recorded as ambiguous and blocks its queue item and bound goal for owner review rather than replaying a possibly completed effect.
- A host-effect (including legacy unknown-effect) lease cannot complete until the exact durable `markGatewayHostStarted` marker exists. Leased lanes must also match the queue lease's worker, claim time and expiry exactly; an orphaned or stale generation is a failed-closed runtime finding.
- Recovering a stale premortem scope lock now writes a durable fenced finalization before any read-only conclusion. A delayed writer cannot turn that recovered scope into a clean completion.

### Changed

- MCP dispatch moved into bounded runtime modules, reducing `src/mcp.js` below 500 physical lines and removing its legacy line-budget exception. Existing tools and wire semantics remain unchanged while the new `record_delivery_premortem` tool registers the context-only artifact.
- The Codex plugin manifest now selects `hooks/codex.json` explicitly, preventing Codex's default plugin discovery from loading the Claude-specific bundle. Installed-package checks exercise Codex with both documented compatibility root variables and retain its strict top-level blocking protocol.
- Optional project Markdown discovery now retains at most 240 files and stops at its directory-entry or time budget. Required host instructions keep priority; excess files are deterministically skipped with a visible, audited incomplete-context warning instead of disabling every tool in a large workspace.
- Goal-runtime policy changes now use an ownership-fenced, digest-bound paired transaction, and host execution records an exact lease before invoking an external runner. Restart recovery rolls a prepared pair forward once and treats a crash after the external effect as ambiguous instead of replaying it.

### Tests

- Before/After tests cover a write without a premortem, a correctly registered and closed delivery, late registration, a read-only session, session and gateway-attempt isolation, closure invalidation after later writes, goal-step receipt binding, concurrency, conflicting registration, tamper visibility and source byte preservation.
- Availability and crash tests cover 241 project Markdown files, more than 8,192 flat directory entries, deadline truncation, native-source priority, visible hook warnings, stale lock ownership, torn policy/runtime commits and a hard process exit after one external effect.
- Adversarial regressions cover a stale pause marker, option-bearing shell wrappers, a state/index crash gap and a caught host error after one observable effect.
- Gateway and premortem race regressions prove that an unmarked host-effect completion is rejected, a mismatched lane generation is visible to audit, and stale scope-lock recovery remains blocked before and after a delayed writer resumes.

## [0.65.0] - 2026-09-03

### Changed

- The PostToolUse undeclared-call guard now compares canonical identifier-name sets before and after a JavaScript write. Existing undeclared calls remain visible as exact `file:line: name` warnings but do not block unrelated work; only names introduced by the current write block.
- PreToolUse records a bounded, tool-delivery-bound snapshot outside the project. PostToolUse prefers explicit original edit content, then the exact snapshot, then the last audited state. New files have an empty previous set, and removing findings is accepted.

### Security

- Parser, file and local state uncertainty remains fail-open and auditable. A denial requires a verified new undeclared name; stored comparison state is diagnostic only and grants no permissions, identity, tools or policy exceptions.

### Tests

- Before/After tests prove that an unchanged pre-existing finding passes with a warning, adding one new undeclared name blocks and names only that addition, removing a finding passes, and an undeclared call in a brand-new file blocks.

## [0.64.0] - 2026-09-03

### Changed

- The host hook lifecycle is split into bounded context/lifecycle and source-protection modules. The installed entrypoint, public runtime exports, payload schemas, event ordering and persisted state formats remain unchanged.
- `src/hook.js` is reduced from 865 to fewer than 500 physical lines, and its legacy line-budget exception is removed. Each new module is independently subject to the ordinary 500-line ceiling.
- `PreToolUse` verifies an explicitly stated assignment baseline against `.blun-snapshot-stand.json` before direct writes. `PostToolUse` reports undeclared JavaScript calls with exact file and line locations, including support for a bounded project allowlist. `Stop` and `SubagentStop` verify explicitly claimed exchange artifacts and digest prefixes after the existing test-evidence gate.

### Security

- Filesystem and parser uncertainty in the new guards is audited and fails open. Only a verified baseline mismatch, undeclared call, missing claimed artifact or mismatching claimed digest blocks; protected-source mutations, delivery verification, self-starter authorization, pre-answer recall and learning gates remain fail closed.

### Tests

- Before/After tests prove that a baseline mismatch blocks while a prefix match passes, an undeclared call is reported while a multi-line variable declaration is accepted, and a missing claimed artifact blocks while a matching digest prefix passes. The complete hook suite verifies installed Claude and Codex entrypoints, bounded overflow, protected writes and shell mutations, ordinary writes and reads, and generic-host preflight after the split.

## [0.63.0] - 2026-09-03

### Added

- `Stop` and `SubagentStop` now require a successful `node --test`, `npm test`, `npm run check`, or `pytest` command after the latest observed write before accepting a completed delivery. The verification lane survives restart and remains bound to the exact task when available.

### Changed

- Reaching the bounded limit of 16 self-help requirements, research resolutions, or knowledge gaps now blocks the exact plan step for local review instead of throwing and terminating the worker tick.
- Hook output formatting moved to a focused module, reducing the oversized hook lifecycle file without changing its public exports or host payloads.

### Security

- Test evidence is outcome-bound and rejects failed commands, test-before-write ordering, conflicting tool delivery IDs, tampered state, shell pipelines, failure-masking operators, and commands that merely print a test name. Read-only tools do not invalidate a valid post-write test.
- Active jobs paused as waiting remain resumable and do not masquerade as completed deliveries. Corrupt verification state blocks completion cleanly without modifying user sources.

### Tests

- Synthetic Before/After coverage proves an untested write changes from accepted to blocked, six concurrent duplicate reports converge, restart preserves task verification, and a seventeenth full self-help cycle becomes a durable blocker without killing the worker.

## [0.62.0] - 2026-09-03

### Added

- Bounded repository-first self-help can now escalate an unresolved conflict between two independent public primary sources into exactly one durable owner decision. The report binds both conflicting SHA-256 digests, one question, a reason and 2-8 distinct options.
- The owner-input gap survives restart and resumes the exact plan step once through the existing locally confirmed clarification path.

### Security

- Escalation is rejected unless repository evidence was exhausted first and two fresh conflicting sources come from different public HTTPS origins. Missing digests, duplicate options, altered bindings and forged persisted reports fail closed.
- External material, options and answers remain context only; they cannot grant identity, tools, permissions, delegation or policy exceptions. Foreign project groups receive no goal context.

### Tests

- A synthetic Before/After scenario proves that the prior forced-answer dead end becomes one evidence-bound decision, six concurrent identical answers converge on one continuation, torn-write recovery restores one wake, and source Markdown remains byte-exact.

## [0.61.0] - 2026-09-03

### Added

- Objective goal-plan knowledge gaps now create one digest-bound repository-first self-help requirement instead of immediately asking the user. The exact pending question and reason are injected into the next provider-neutral work item and survive restart reconciliation.
- Successful bounded research resolves the matching requirement and continues the same plan. Genuine owner decisions retain the existing one-question, locally confirmed clarification path.

### Security

- A host cannot bypass required self-help by repeating the objective question, changing it, or relabeling it as owner input. These regressions block the exact step and are recorded without exposing another project group.
- Requirement identity, plan binding, request queue, timestamp and content are integrity-bound. External material remains untrusted context and cannot grant rights, tools, identity or policy exceptions.

### Changed

- Goal knowledge transitions moved behind a focused 101-line module. The oversized gateway runtime shrank from 1,569 to 1,520 physical lines, and its reduced line budget is now enforced.

## [0.60.0] - 2026-09-03

### Added

- Goal-plan workers now receive a provider-neutral self-help contract. They inspect repository evidence first and, when that evidence is insufficient, triangulate at least two independent public HTTPS primary sources before returning an objective answer instead of immediately asking the user.
- Successful self-help stores only bounded provenance metadata, SHA-256 digests and a conclusion. The resolved knowledge gap and its continuation survive restart and compaction without retaining external source content.
- A line-budget check caps every new JavaScript production or test file at 500 physical lines and prevents every known legacy oversized file from growing beyond its recorded reduced baseline.

### Security

- External evidence is permanently marked untrusted and cannot grant identity, permissions, tools, delegation, production access or policy exceptions. Private/local URLs, credentials, stale or future observations, reordered research, missing commit/license/version provenance and forged digests fail closed.
- Repository-only resolution is permitted only when the repository evidence is explicitly sufficient. Otherwise two different public origins are mandatory; one-source confirmation cannot resolve the gap.

### Changed

- Knowledge-evidence validation moved out of the oversized gateway runtime into a 261-line focused module. The gateway runtime shrank from 1,623 to 1,569 physical lines while retaining its public schemas and compatibility with older stored plans.

## [0.59.1] - 2026-09-03

### Fixed

- Raw `EPERM` and `EACCES` directory-enumeration failures, plus scanner-tagged incomplete traversals, now fail open for every native hook event. In particular, `PostToolUse`, `Stop`, and `SubagentStop` return successfully instead of terminating the host lifecycle with exit code 2.
- Every fail-open hook scan records the actual event, phase, error code, and affected path in the local audit log. Policy, identity, grant, scope, and protected-source violations remain fail closed.
- When the console starts at the exact configured Claude, Codex, or BLUN profile root, project-source discovery and self-starter fingerprinting no longer recurse through the profile tree. Nested project roots remain bounded and fully enforced.

### Tests

- The unprivileged Windows lane creates a real ACL-denied directory with `icacls` and verifies direct and installed-entrypoint `PostToolUse` and `Stop` success, audit evidence, skipped traversal, and unchanged source bytes. The macOS lane repeats the denial with mode `000`.

## [0.59.0] - 2026-09-03

### Added

- Owner-confirmed execution decisions can precommit two to four bounded attempts. After an objectively measured, non-blocking failure, the worker continues with exactly one remaining sufficient strategy from the same minimum-risk class.
- Every host request receives a content-free execution-attempt contract containing the frozen strategy, attempt number, budget, decision digest and previous outcome digest. Scoped gateway context exposes only the current agent's pending attempt.

### Security

- Exploration never enters a higher-risk strategy class, never grants a tool or permission, and never starts from missing, malformed, future-dated or reused evidence. A blocking defect stops immediately regardless of its numeric score.
- Attempt order, budget and outcome lineage are covered by immutable digests. Cross-group context, altered orders and duplicate source evidence fail closed.

### Changed

- A valid non-blocking objective failure can advance one frozen alternative atomically instead of always pausing for owner retry. Budget exhaustion still blocks the exact step and requires a new goal ID; restart reconciliation recreates one lost continuation without duplicating an attempt.

## [0.58.0] - 2026-09-03

### Added

- Owner-confirmed execution decisions can declare a bounded transfer key and evidence lifetime. Two independent successful goals with distinct objective source digests make the exact strategy reusable by a new matching task in the same project and group.
- Every applied transfer freezes a content-free proof lineage containing only source goal, step and outcome IDs, completion times and SHA-256 digests.

### Security

- Transfer never leaves the lowest-risk sufficient strategy class, never crosses project or group scope, and never grants a tool or permission. Stale evidence, mismatched evaluator contracts and fabricated proof lineages are rejected.
- One matching failed outcome or blocking defect overrides all prior successes and withdraws the strategy from future tasks; no average score can keep it active.

### Changed

- Strategy selection prefers an eligible proven strategy over a cheaper unproven alternative only when their declared risk is equal. The ordinary deterministic risk/cost/ID order remains the fallback after expiry or regression.

## [0.57.0] - 2026-09-03

### Added

- Owner-confirmed plan steps can precommit required capability classes, two to eight candidate strategies, bounded risk and cost, and an objective metric gate. The lowest-risk sufficient strategy is selected deterministically before host execution.
- Completed execution reports retain content-free, SHA-256-bound objective outcomes with the exact selected strategy, used capability classes, evaluator, metric, case count and blocking-defect result.

### Security

- Capability classes and strategy selection are context only and never grant a host tool or permission. Strategy, evaluator, metric and threshold drift fail closed, and scoped gateway context does not expose another agent's plan.
- A model or runner completion claim without the exact objective evidence blocks the step. No favorable aggregate can overrule a blocking defect.

### Changed

- Failed objective gates pause the exact step for owner-confirmed retry. Restart reconciliation recreates one lost wake, while a passing gate advances the dependency plan exactly once.

## [0.56.0] - 2026-09-03

### Added

- Goal-plan steps can bind up to 16 immutable shared-resource IDs. Conflicting work is serialized within the exact project and group, while independent resources and foreign groups continue concurrently.
- Scoped gateway context exposes content-free resource waits only to the affected agent, including the blocking queue IDs needed to explain why a ready step has not started.

### Security

- Resource definitions are covered by the plan digest and remain context-only: they cannot grant tools, identity, delegation or policy exceptions. Definition tampering fails closed, and equal resource names never cross a group boundary.

### Changed

- Competing ready steps are ordered by the current owner-confirmed goal priority rather than mutable queue priority. Normal completion and existing crash-recovery lease expiry release the resource deterministically.

## [0.55.0] - 2026-09-03

### Added

- Goal-plan steps can be immutably assigned to different authenticated agent personas, enabling provider-neutral Codex-to-Claude-to-Codex handoffs across one dependency graph.
- Each assignee receives the exact current step, checkpoint and context through its own authenticated host/profile binding; scoped gateway context includes a shared plan for every assigned teammate.

### Security

- Every step assignee must already be active in the lead agent's authenticated tenant and exact project group. The assignment digest, queue, claim and completion all bind the same persona; cross-group and manipulated handoffs fail closed.
- If a step assignee leaves, reconciliation cancels runnable work and pauses the exact step before host execution. Rejoining still requires the existing local owner-confirmed resume path and never grants tools or authority.

### Changed

- Torn-write recovery recreates exactly one wake for the current step's assignee, per-agent lanes serialize concurrent workers, and historical single-agent plans retain lead-agent routing without migration.

## [0.54.0] - 2026-09-03

### Added

- Goal-plan workers can stop the exact current step on a bounded knowledge gap, expose one durable clarification, and resume with the resolved context after restart.
- `goal-clarify` binds the answer to the exact goal, step, immutable plan definition and original request; owner input remains distinct from an objective observation with a required SHA-256 source digest.

### Security

- Knowledge-gap questions and answers are context-only and reject secrets plus authority-shaped content. Conflicting resolutions, weak provenance, duplicate questions, cross-agent context reads and state manipulation fail closed.

### Changed

- Six concurrent identical resolutions converge on one answer and one runnable continuation; reconciliation leaves an open question paused instead of generating repeated wakes.

## [0.53.0] - 2026-09-02

### Added

- Owner-confirmed focused goals can carry a bounded, immutable dependency graph with 1-32 objective steps, per-step success criteria, checkpoints and explicit current-step binding.
- The durable worker advances only the exact leased step, opens the next dependency-ready step deterministically, reconstructs one missing runnable step after a torn policy/runtime write, and requires renewed owner confirmation to resume a blocked step.

### Security

- Cycles, unknown dependencies, definition-digest drift and stale-step completion fail closed. Six concurrent workers still lease exactly one step, while goal plans remain context-only and cannot create tools, rights, delegation or policy exceptions.

### Changed

- `goal-assign` accepts `--plan plan.json`; existing flat goals and historical queue records remain compatible.

## [0.52.1] - 2026-09-02

### Fixed

- Bounded source and workspace-fingerprint walkers skip inaccessible or disappearing directories and entries and report deterministic diagnostics.
- Edit, Write, apply_patch, Bash, and exec_command remain allowed when source or self-starter filesystem scanning fails; a best-effort local audit record retains the error and path.
- Real Windows `icacls` and unprivileged POSIX permission probes verify the two walkers, hook decision, audit record, and source-byte preservation.

## [0.52.0] - 2026-09-02

### Added

- New initial evaluation v28 and bounded retry v29 contracts atomically register content-free, exact-scope candidate-evidence lineage receipts and bind their digest into candidate admission v4.

### Changed

- A locally attested user-feedback or objective-test anchor is single-use for experiment admission within its exact scope. Its lineage tombstone survives ordinary candidate deletion and subject purge; historical v1-v27 evaluations remain readable.

### Security

- Six candidates racing with the same evidence produce one contract, while the other five fail closed. Evidence-digest or independence-digest replay, exact-ID recreation after deletion, and re-signed lineage manipulation fail closed after restart; foreign scopes remain independent and receive zero matching diagnostics, and user-owned sources remain byte-for-byte unchanged.

## [0.51.0] - 2026-09-02

### Added

- `learn-evidence-source-attestation-revoke` records one immutable, content-free local revocation for an exact evidence-source attestation and its evaluation, candidate-admission, target and scope digests.

### Changed

- Revoking a mistaken local source confirmation immediately withholds its active or validated lesson, blocks measurements, projections, deliveries, outcomes and revalidation, and causes the next locked evaluation pass to roll back the complete dependent lineage while restoring a safe predecessor.

### Security

- Explicit local confirmation is mandatory. Six concurrent identical withdrawals converge on one receipt; conflicting replay and re-signed binding manipulation fail closed after restart, foreign scopes receive zero counts or diagnostics, reasons remain digest-only, and user-owned sources remain byte-for-byte unchanged.

## [0.50.0] - 2026-09-02

### Added

- New initial evaluation v26 and bounded retry v27 contracts embed content-free, locally confirmed source attestations for the exact qualifying evidence cohort.

### Changed

- `user-statement` and `test` labels no longer qualify by themselves. Evaluation registration now requires `--confirm-local-evidence-sources`, and the admission binds each qualifying digest to either explicit user feedback or an objective test without storing source content or evidence IDs.

### Security

- Missing confirmation leaves zero contracts. Re-signed source-class manipulation fails closed after restart, six parallel confirmed registrations converge on one contract, foreign scopes receive zero diagnostics, and historical v1-v25 evaluations remain readable.

## [0.49.0] - 2026-09-02

### Added

- New initial evaluation v24 and bounded retry v25 contracts embed a content-free, digested `agentspine.learning-evidence-source-policy/v1`. It freezes an admission quorum requiring at least one fresh independent explicit-user or objective-test anchor before measurement.

### Changed

- Interaction-only and document-only evidence cohorts can no longer open a behavior evaluation contract, even when their confidence and independent-evidence counts pass. Historical v1-v23 contracts remain readable, and retry comparison v4 binds the same source policy across corrective trials.

### Security

- Re-signed source-class or quorum weakening fails closed after restart. Six concurrent eligible registrations still converge on one contract, exact-scope diagnostics expose only matching counts and a policy digest, foreign groups receive zero, and user-owned sources remain byte-for-byte unchanged.

## [0.48.0] - 2026-09-02

### Added

- New initial evaluation v22 and bounded retry v23 contracts embed a content-free, digested `agentspine.learning-blocking-defect-policy/v1`. It freezes the covered phases, any-defect aggregation rule, pre-Canary rejection and post-Canary rollback before a measurement exists.

### Changed

- One eligible baseline receipt with a blocking defect now prevents Canary admission even when every numeric score and the cohort average would otherwise pass. Existing after-Canary and revalidation rollback behavior remains unchanged, and historical v1-v21 contracts remain readable.

### Security

- Re-signed phase, aggregation or action manipulation fails closed after restart. A favorable replay cannot replace the precommitted defective evaluator slot, exact-scope diagnostics expose only matching counts and the policy digest, foreign groups receive zero, and user-owned sources remain byte-for-byte unchanged.

## [0.47.0] - 2026-09-02

### Added

- New initial evaluation v20 and bounded retry v21 contracts embed `agentspine.learning-candidate-admission/v2`. Its content-free evidence cohort freezes one digest, independence digest, evidence class and observation time per fresh candidate proof together with a digested maximum-age policy.

### Changed

- Candidate admission now evaluates confidence and independence only across evidence observed within the contract's frozen age window. Stale evidence is excluded, future-dated evidence rejects registration, and later configuration changes cannot shorten or widen an existing cohort. Historical v1-v19 contracts remain readable.

### Security

- Re-signed cohort, timestamp, independence and policy manipulation fails closed after restart. Six concurrent registrations still converge on one contract, scoped CLI and Context MCP diagnostics expose only matching counts and digests, foreign groups receive zero, and user-owned sources remain byte-for-byte unchanged.

## [0.46.0] - 2026-09-02

### Added

- New initial evaluation v18 and bounded retry v19 contracts embed a content-free, digested `agentspine.learning-candidate-admission/v1` receipt. It binds the exact candidate target and scope, frozen confidence and evidence gates, observed confidence, distinct evidence count and admission time before measurement.

### Changed

- Behavior evaluation registration now rejects candidates that have not already met both frozen gates. At least two distinct evidence items are required even if mutable configuration is lower; failed admission creates no evaluation contract or measurement lineage. Historical v1-v17 contracts remain readable.

### Security

- Re-signed admission-count, target, scope or gate manipulation fails closed after restart. Parallel admission is idempotent, exact-scope diagnostics expose only a content-free matching count and digest, foreign groups receive zero, and user-owned sources remain byte-for-byte unchanged.

## [0.45.0] - 2026-09-02

### Added

- New initial evaluation v16 and bounded retry v17 contracts freeze the candidate `minConfidence` and `minEvidence` gates before any benchmark outcome is admitted. Scoped status, Doctor, audit and read-only Context MCP diagnostics expose only content-free matching counts and digests.

### Changed

- Automatic behavior promotion and retry-state validation use the contract's frozen candidate gates. Later `learn-config` changes apply only to future contracts; historical v1-v15 contracts remain readable with their original behavior.

### Security

- Lowering mutable confidence or evidence requirements cannot admit a previously ineligible candidate, while raising them cannot invalidate or prolong an already registered experiment. Threshold tampering fails closed, foreign scopes receive zero diagnostics, and user-owned sources remain byte-for-byte unchanged.

## [0.44.0] - 2026-09-02

### Changed

- Scoped `learn-status` and read-only `learning_outcome_status` now derive every top-level evaluator, binding, lease, retry, exhaustion, staleness and revocation aggregate from the candidate records visible to that exact scope. Unscoped Doctor and audit remain project-wide.

### Security

- A foreign group or project can no longer infer whether another scope has registered or revoked evaluator roots, evaluation bindings, validation leases, retry contracts, terminal exhaustion, or any proof-revocation class. Exact-scope records, claims, identifiers and user-source bytes remain unchanged.

## [0.43.0] - 2026-09-02

### Added

- New initial experiments use `agentspine.learning-evaluation/v14`; bounded retries use v15. Both embed a content-free, digested `agentspine.learning-staleness-policy/v1` that fixes outcome age and Canary lifetime before any result is admitted.
- Scoped status, Doctor and audit report staleness-bound contract counts and policy digests without exposing claims, evidence, benchmark content or identities.

### Changed

- Outcome freshness, initial Canary expiry, validation renewal and revalidation now use the immutable contract policy. Later `learn-config` changes apply only to future contracts.
- A v15 retry comparison includes the frozen staleness-policy digest, so a corrective attempt cannot widen its evidence window or Canary lifetime. Historical v1-v13 contracts remain readable.

### Security

- Widening mutable configuration can no longer resurrect stale Before/After evidence or extend an already registered experiment. Policy tampering fails closed on reload, foreign groups receive neither counts nor digests, and user-owned sources remain byte-for-byte unchanged.

## [0.42.0] - 2026-09-02

### Added

- Learning mutations use an owner-bound `agentspine.owned-file-lock/v1` lease with a renewable heartbeat and a final ownership assertion before state replacement.
- A real six-process race test holds the leading mutation beyond a shortened stale threshold, recovers a synthetic crash remnant and preserves a deliberately substituted foreign lease.

### Changed

- Stale learning-lock takeover now rechecks file identity before removal. Successful cleanup deletes only the exact token still owned by the completing process.

### Security

- A long evaluation can no longer be mistaken for a crashed writer and overwritten. Lost or manipulated ownership aborts before state commit; the former owner cannot delete its successor's lock, and user sources remain byte-for-byte unchanged.

## [0.41.0] - 2026-09-02

### Added

- A content-free `agentspine.learning-trial-retry-exhaustion/v1` receipt binds the failed corrective Canary to its root evaluation, exact corrective contract, terminal failure, target, scope and fixed attempt 2-of-2 budget.
- Scoped status, Doctor and audit expose terminal exhaustion counts and state without disclosing claims, evidence, benchmark content or revocation reasons.

### Changed

- The second failed Canary now records retry exhaustion atomically with rollback. Revoking that timeout leaves the terminal receipt intact and still requires a genuinely new learning lineage.

### Security

- Parallel reconciliation creates exactly one terminal receipt. Root, contract, failure, target, scope and attempt substitution fail closed after restart; foreign groups receive neither the receipt nor its count; subject purge removes the complete lineage atomically.

## [0.40.0] - 2026-09-02

### Added

- Claude Code, Codex and BLUN mark only their optional PostToolUse registration as a silent-oversize lane.
- The installed-entrypoint test sends a synthetic 70 KiB image result and proves exit 0, empty stdout, empty stderr, byte-preserved sources and zero partial runtime state.

### Changed

- Oversized PostToolUse results are drained and skipped before JSON parsing, so image reads no longer produce a red lifecycle-hook error.

### Security

- The 64 KiB fail-closed limit remains unchanged for UserPromptSubmit, PreToolUse, session, compaction and completion hooks. Calling the adapter without the PostToolUse-only marker still exits 2 on the same oversized payload.

## [0.39.0] - 2026-09-02

### Added

- `agentspine.learning-evaluation/v13` embeds `agentspine.learning-trial-retry/v3`, freezing the corrective Canary as attempt 2 of 2 and binding it to the exact root evaluation and comparison contract.
- Scoped status, Doctor and audit distinguish bounded retry contracts without exposing lesson, evidence, benchmark or revocation content.

### Changed

- A locally revoked false timeout can admit one fresh comparable corrective trial. A failed corrective trial remains terminal even if its timeout is later revoked; continuing requires a genuinely new learning lineage instead of repeated selection.

### Security

- Third-attempt admission, concurrent budget races, rewritten attempt counters and root redirection fail closed. Historical v11 and v12 retry contracts remain readable.

## [0.38.0] - 2026-09-02

### Added

- `agentspine.learning-evaluation/v12` embeds `agentspine.learning-trial-retry/v2`, binding each retry to the exact objective comparison contract of its failed predecessor.
- Scoped status and Doctor distinguish comparison-bound retry contracts without exposing claims, benchmark content, evidence or revocation reasons; audit validates the complete comparison lineage.

### Changed

- A retry must preserve the predecessor metric, benchmark digests and case floor, evaluator identities and roots, pairing rules, and promotion thresholds. A corrected completion timeout remains possible without moving the measurement goalposts.

### Security

- Dataset, protocol, metric, threshold and evaluator drift after a revoked timeout fail closed. Digest redirection, concurrent duplicate admission, cross-group diagnostics and delete/replay windows remain blocked.

## [0.37.0] - 2026-09-02

### Added

- `agentspine.learning-evaluation/v11` embeds a content-free retry admission that binds a new candidate and contract to one exact locally revoked initial-trial failure.
- CLI, Doctor and scoped status expose retry-bound evaluation counts without exposing claims, evidence or revocation reasons; audit validates the complete retry lineage.

### Changed

- Repeating the same failed behavior and scope now requires the latest matching revocation, explicit local retry confirmation, a distinct candidate, evidence observed after revocation and a new evaluation contract.
- Retry admission retains the original failed Canary as terminal and keeps the safe predecessor active until the new independent experiment succeeds.

### Security

- Reused or stale evidence, an older revocation, redirected target or scope, concurrent duplicate admission, cross-group diagnostics and predecessor deletion with a live dependent retry fail closed.

## [0.36.0] - 2026-09-02

### Added

- A locally confirmed `agentspine.learning-trial-failure-revocation/v1` receipt withdraws one exact false initial-trial timeout while binding its contract, evaluator registry, application, target and scope.
- `learn-trial-failure-revoke` plus Doctor, audit, scoped status and read-only Context MCP diagnostics expose the content-free withdrawal state.

### Changed

- Invalid timeout proof no longer remains indistinguishable from a genuine blocking defect. Its explanation is retained only as a digest, while the original failure receipt and all underlying evidence remain immutable.
- Revocation never resurrects the rolled-back Canary or reuses its expired cohort. A retry requires a fresh candidate and evaluation contract, and the restored safe predecessor remains active.

### Security

- Missing local confirmation, redirected failure, contract, application, target, scope or evaluator bindings, conflicting replay and cross-group diagnostics fail closed. Six concurrent identical requests create one receipt.

## [0.35.0] - 2026-09-02

### Added

- A locally confirmed `agentspine.learning-validation-revocation/v1` receipt binds one exact validation lease to its candidate target, scope, evaluation and immutable evaluator-registry binding while retaining the explanation only as a digest.
- `learn-validation-revoke` plus scoped status, Doctor, audit and read-only Context MCP diagnostics expose content-free validation-withdrawal state.

### Changed

- Revoking an invalid validation decision immediately withholds its dependent lesson and atomically restores a safe superseded predecessor without changing the underlying evaluation, measurements or outcomes.
- Renewal cannot hide an invalid predecessor: revocation traverses the active lease's immutable predecessor chain, and revoked validation cannot accept later projections, deliveries, renewal measurements or another renewal.

### Security

- Validation withdrawal is fail-closed: candidate, target, scope, lease, contract and evaluator-binding substitution fail on load; six concurrent retries create one receipt; conflicting retries are rejected; and foreign scopes receive no diagnostics.

## [0.34.0] - 2026-09-02

### Added

- A locally confirmed `agentspine.learning-evaluation-revocation/v1` receipt binds one exact evaluation contract to its candidate target and immutable evaluator-registry binding while retaining the explanation only as a digest.
- `learn-evaluation-revoke` plus scoped status, Doctor, audit and read-only Context MCP diagnostics expose content-free contract-withdrawal state.

### Changed

- Revoking an invalid benchmark, protocol, scope or threshold contract immediately withholds every dependent active or validated lesson and atomically restores a safe superseded predecessor.
- Revoked contracts cannot accept measurements, projections, deliveries, outcomes, promotion or validation renewal. Their existing immutable evidence is not rewritten or over-revoked.

### Security

- Contract withdrawal is fail-closed: candidate, target, contract and evaluator-binding substitution fail on load; six concurrent retries create one receipt; conflicting retries are rejected; and foreign scopes receive no diagnostics.

## [0.33.0] - 2026-09-02

### Added

- A locally confirmed `agentspine.learning-application-revocation/v1` receipt binds one exact projected turn to its evaluation, candidate target, application and optional delivery and outcome digests without retaining the explanation in plaintext.
- `learn-application-revoke` plus scoped status, Doctor, audit and read-only Context MCP diagnostics expose only content-free revocation state.

### Changed

- Revoking an invalid preflight, scope or projection binding immediately withholds every dependent active or validated lesson. Evaluation then rolls it back atomically and restores a safe superseded predecessor.
- A revoked projection cannot produce a delivery, measurement, outcome, promotion or validation renewal. Existing delivery, measurement and outcome receipts remain immutable and unrevoked. Legacy state upgrades with an empty application-revocation ledger; candidate deletion and subject purge remove matching receipts.

### Security

- Projection withdrawal is fail-closed: candidate, contract, target, application, delivery and outcome substitution fail on load; six concurrent retries create one receipt; conflicting retries and replacement of revoked cohort admissions are rejected; and foreign scopes receive no diagnostics.

## [0.32.0] - 2026-09-02

### Added

- A locally confirmed `agentspine.learning-outcome-revocation/v1` receipt binds one exact measured result to its evaluation, target, measurement, application and delivery digests without retaining the explanation in plaintext.
- `learn-outcome-revoke` plus scoped status, Doctor, audit and read-only Context MCP diagnostics expose only content-free revocation state.

### Changed

- Revoking an invalid outcome immediately withholds every dependent active or validated lesson and traverses renewed validation leases back through their immutable predecessor chain. Evaluation then rolls the lesson back atomically and restores a safe superseded predecessor.
- The underlying immutable measurement remains retained and unrevoked. Legacy state upgrades with an empty outcome-revocation ledger; candidate deletion and subject purge remove matching receipts.

### Security

- Outcome withdrawal is fail-closed: candidate, contract, outcome, measurement, application and delivery substitution fail on load; six concurrent retries create one receipt; revoked outcomes cannot be replayed; and foreign scopes receive no diagnostics.

## [0.31.0] - 2026-09-01

### Added

- A locally confirmed `agentspine.learning-delivery-revocation/v1` receipt binds one exact model-turn delivery to its evaluation contract, candidate target, application and any consumed outcome without retaining the explanation in plaintext.
- `learn-delivery-revoke` plus scoped status, Doctor, audit and read-only Context MCP diagnostics expose only content-free revocation state.

### Changed

- Revoking an invalid `Stop` or delivery proof immediately withholds any dependent active or validated lesson from the next exact-scope context pass. Evaluation then rolls it back atomically and restores a safe superseded predecessor.
- Revoked deliveries cannot support a new measurement, outcome, promotion or validation renewal. Legacy state upgrades with an empty delivery-revocation ledger; candidate deletion and subject purge remove matching receipts.

### Security

- Delivery withdrawal is fail-closed: candidate, contract, application, delivery and outcome substitution fail on load; six concurrent retries create one immutable receipt; foreign groups receive no diagnostics; and a later favorable turn cannot replace the revoked proof.

## [0.30.0] - 2026-09-01

### Added

- A locally confirmed `agentspine.learning-measurement-revocation/v1` receipt binds the exact measurement, evaluation contract, candidate target and consumed outcome digests without retaining the revocation explanation in plaintext.
- `learn-measurement-revoke` plus scoped status, Doctor, audit and read-only Context MCP diagnostics expose only content-free revocation state.

### Changed

- Revoking measurement evidence immediately withholds an affected active or validated Canary from the next exact-scope context pass. Evaluation then rolls it back atomically and restores a safe superseded predecessor.
- Revoked measurements cannot be consumed, reused for promotion or validation renewal, or removed by stale-measurement cleanup. Legacy state upgrades with an empty measurement-revocation ledger; candidate deletion and subject purge remove matching receipts.

### Security

- Measurement withdrawal is fail-closed: candidate, contract, measurement and outcome substitution fail on load; concurrent retries create one immutable receipt; foreign groups receive no diagnostics; and no later result or favorable average can replace the revoked evidence.

## [0.29.0] - 2026-09-01

### Added

- A locally confirmed `agentspine.learning-evidence-revocation/v1` receipt binds an exact evidence item, its SHA-256 digest and the frozen candidate target without retaining the revocation explanation in plaintext.
- `learn-evidence-revoke` provides a local-only CLI path; scoped status, Doctor and read-only Context MCP diagnostics report revocation counts and withheld lessons.

### Changed

- Revoked evidence immediately removes an accepted lesson from the next matching context pass. Evaluation then rolls it back atomically, restores a safe superseded predecessor and prevents the frozen candidate from being reviewed or promoted again.
- Legacy learning state upgrades with an empty revocation ledger. Candidate deletion and subject purge remove matching receipts, while diagnostics remain isolated from foreign groups.

### Security

- Evidence withdrawal is fail-closed: IDs cannot be redirected to another evidence item or candidate revision, concurrent retries create one receipt, state tampering fails on load, and no later average or replacement observation can rehabilitate the revoked target.

## [0.28.0] - 2026-09-01

### Added

- `agentspine.learning-evaluation/v10` freezes a content-free completion policy for each initial Before/After experiment, including the delivery and outcome deadlines and the blocking classification of either omission.
- `agentspine.learning-application/v7` carries the exact policy digest and outcome deadline into every admitted Canary turn; a missed deadline produces one immutable `agentspine.learning-trial-failure/v1` receipt.

### Changed

- A missing model-stop delivery or measured outcome now suppresses the Canary from context immediately and causes one atomic rollback. Late or backdated measurements cannot repair the failed trial, while evaluation v1-v9 and application v1-v6 state remains readable.
- Status, Doctor and audit distinguish deadline-bound contracts, pending and stale initial outcomes, and delivery- versus outcome-timeout receipts without exposing lesson, prompt, response or evaluator content.

### Security

- Crashes, withheld `Stop` events and deliberately unmeasured first turns can no longer remain pending indefinitely or be replaced by a later favorable result. No aggregate score can override the resulting blocking defect.

## [0.27.0] - 2026-09-01

### Added

- `agentspine.learning-evaluation/v9` freezes a content-free digest of the exact candidate claim, evidence set, confidence, scope, privacy and review boundary that the trial is intended to prove.
- `agentspine.learning-application/v6` carries that same target digest into each admitted initial Canary turn; status, Doctor and audit expose target-bound contract and application counts without exposing lesson text.

### Changed

- Evidence cannot be appended after an active v9 evaluation exists; changed guidance requires a separately deduplicated superseding candidate and a new contract.
- Evaluation v1-v8 and application v1-v5 state remains readable, including the precommitted initial cohorts introduced by 0.26.

### Security

- Candidate, contract, Canary and admitted-turn substitution now fail closed on every state load. A result measured for one evidence-backed lesson revision cannot promote or validate altered guidance under the same learning ID.

## [0.26.0] - 2026-09-01

### Added

- `agentspine.learning-evaluation/v8` precommits the complete initial Before/After trial cohort: phase, evaluator ID, principal root, provider run ID, frozen benchmark digest and exact case count are fixed before results exist.
- `agentspine.learning-application/v5` atomically admits the first exact-scope Canary projections into those frozen After slots before delivery or scoring.

### Changed

- Measurement, outcome, validation-lease, status, Doctor and audit checks bind the first experiment to its trial and admission cohort; evaluation v1-v7 and application v1-v4 state remains readable.
- Stale cleanup retains incomplete initial admissions as evidence while continuing to purge ordinary expired projection residue.

### Security

- A favorable baseline or Canary rerun cannot replace its precommitted provider run, and a later successful turn cannot hide a failed, crashed or withheld first admitted turn. Run, root, case-count, admission, delivery and digest substitution fail closed.

## [0.25.0] - 2026-09-01

### Added

- `agentspine.learning-revalidation-window/v4` precommits a content-free measurement trial for every renewal slot: evaluator ID, principal root, provider run ID, frozen benchmark digest and exact case count are fixed before projection.
- `agentspine.learning-application/v4` admissions and `agentspine.learning-validation/v5` leases retain the exact trial, application, delivery and measurement lineage that extended the evidence lease.

### Changed

- New renewal windows select `first-admitted-trials`; status and Doctor distinguish precommitted trials, admitted applications and completed deliveries.
- Revalidation-window v1-v3, application v1-v3 and validation-lease v1-v4 history remains readable.

### Security

- A failed evaluator run cannot be discarded and repeated under a later high-scoring run ID. Run substitution, evaluator aliasing, case-count drift, trial tampering, omission and replay fail closed while blocking defects still override every aggregate score.

## [0.24.0] - 2026-09-01

### Added

- Immutable `agentspine.learning-application/v3` receipts atomically admit the first exact-scope revalidation projections into frozen evaluator-root slots before model completion is known.
- Content-free `agentspine.learning-validation/v4` leases bind every admitted application and its matching completed-turn delivery to the renewed evidence proof.

### Changed

- New `agentspine.learning-revalidation-window/v3` windows select `first-admitted-turns`; later projections remain normal context evidence but cannot replace an admitted cohort slot.
- Doctor and learning status distinguish admitted applications from completed deliveries. Revalidation-window v1/v2, application v1/v2 and validation-lease v1-v3 history remains readable.

### Security

- Withholding `Stop`, crashing, delaying or purging a bad admitted turn cannot remove it from renewal. An incomplete admitted slot remains visible and blocks evidence extension; admission-order, slot, root, application and delivery tampering fails closed.

## [0.23.0] - 2026-09-01

### Added

- Immutable `agentspine.learning-revalidation-window/v2` receipts precommit every renewal to the first completed exact-scope turns and assign the frozen evaluator roots to deterministic turn slots before results exist.
- Content-free `agentspine.learning-validation/v3` leases retain the window digest, ordered delivery digests and evaluator-root assignments that proved the renewed lesson.

### Changed

- Learning status and Doctor report fixed-cohort selection, required and completed renewal deliveries, and selection-bound validation leases.
- Existing revalidation-window v1 and validation-lease v1/v2 history remains readable; new renewal windows use the stricter fixed-cohort contract.

### Security

- A later high-scoring turn can no longer replace an earlier completed renewal turn, and evaluator roots cannot be reassigned between turns after their results are visible. Missing, reordered, tampered or selectively omitted cohort evidence fails closed.

## [0.22.0] - 2026-09-01

### Added

- Explicit local revalidation windows let a current validated behavior lesson collect fresh, root-paired measurements from distinct completed model turns before its evidence expires.
- Immutable, content-free `agentspine.learning-validation/v2` leases bind the prior lease, frozen baseline cohort, fresh measurement, application and delivery digests, measured improvement and extended expiry.

### Changed

- The native hook records turn applications for explicitly revalidating lessons without exposing measurement administration through MCP or widening the lesson's exact scope.
- Status and Doctor diagnostics expose renewed leases and active revalidation windows; consumed renewal measurements cannot be purged or replayed.

### Security

- Revalidation cannot extend a timestamp by assertion. It requires the original contract and evaluator registry binding, fresh independent roots, distinct delivered turns, unchanged measurement kind and case coverage, and frozen improvement thresholds. Any blocking defect or paired regression rolls back atomically.

## [0.21.0] - 2026-09-01

### Added

- Immutable, content-free `agentspine.learning-validation/v1` leases bind each validated behavior lesson to the exact evaluation, evaluator-registry binding, scope, metric, before/after outcome digests, measured improvement and evidence expiry.
- Status, Doctor and audit diagnostics distinguish current, stale, revoked and unproven validated lessons.

### Changed

- Evaluation expiry and evaluator-root revocation now remove affected validated lessons from preflight context before the next model turn, not only active Canaries. Reconciliation rolls them back atomically and restores any superseded lesson.
- Evaluation v1-v6 history remains readable; new v7 validations require a current evidence lease.
- Windows lock metadata access races are retried with the same bounded policy as lock creation, preventing transient `EPERM`, `EACCES` or `EBUSY` failures during parallel learning turns.

### Security

- A forged `validated` status, missing or altered lease, stale evidence, changed registry binding or revoked evaluator root fails closed. Validation leases contain only stable IDs, digests, scope, metric and timestamps; no prompt, answer, dataset, evaluator or user content.

## [0.20.0] - 2026-09-01

### Added

- A separate content-free evaluator registry requires explicit local confirmation before a principal root can enter a new learning experiment. Immutable `agentspine.learning-evaluator-binding/v1` receipts bind evaluation v7 to the exact active registry records.
- CLI registration and revocation plus status, Doctor and audit diagnostics expose active and revoked roots, binding counts and inactive contracts without storing evaluator content.

### Changed

- New evaluations resolve their roots from the local registry instead of trusting IDs or digests supplied only with the evaluation command. Evaluation v1-v6 history remains readable.
- Revoking a bound root removes an affected active Canary from preflight context immediately and causes the next evaluation pass to roll it back.

### Security

- Unconfirmed roots, duplicate principal aliases, replaced records, missing bindings and post-revocation measurements or outcomes fail closed. Registry records remain context-only and cannot create identity, rights, credentials, tools, delegation or policy exceptions.

## [0.19.0] - 2026-09-01

### Added

- Immutable `agentspine.learning-evaluation/v6` contracts bind every evaluator ID to one distinct, locally attested SHA-256 principal root. New `agentspine.learning-measurement/v2`, measurement-lineage v2 and outcome v9 receipts carry that root without storing evaluator identity content.
- CLI evaluation registration requires `--evaluator-roots id=sha256,...`; status, Doctor and audit expose root-bound receipts and independent root counts.

### Changed

- Evaluator independence and before/after pairing now use frozen principal roots. Evaluation v1-v5, measurement and lineage v1, and outcome v1-v8 history remains readable.

### Security

- Two evaluator aliases for the same attested principal can no longer satisfy independence, replay one external run, or create a second paired vote. Duplicate roots, root/run replay, root drift and digest-valid contract/measurement mismatches fail closed.

## [0.18.0] - 2026-09-01

### Added

- Immutable `agentspine.learning-evaluation/v5` contracts freeze same-evaluator pairing and one counted outcome per evaluator and phase; `agentspine.learning-outcome/v8` receipts prove the paired cohort.
- Doctor, status and audit report paired-evaluator receipts and completed before/after pairs.

### Changed

- Canary improvement is now the mean of per-evaluator before/after deltas. Different evaluator cohorts cannot validate a lesson, repeated evaluator runs cannot overweight the score, and every counted after-result requires a distinct completed model turn.
- Concurrent identical measurement retries accept the already committed timestamp instead of misclassifying lock-order inversion as future-dated evidence; genuinely new future measurements still fail closed.
- Evaluation v1-v4 and outcome v1-v7 history remains readable; only new v5/v8 experiments require paired cohorts.

### Security

- Evaluator drift, duplicate weighting, same-turn double counting and digest-valid injected duplicate pairs fail closed. Pairing remains content-free and context-only and cannot grant identity, rights, credentials, tools or policy exceptions.

## [0.17.0] - 2026-09-01

### Added

- Immutable `agentspine.learning-measurement/v1` receipts register an external evaluator run before it can become an outcome; `agentspine.learning-evaluation/v4` and `agentspine.learning-outcome/v7` bind the exact contract, scope, phase, metric, coverage, evaluator, run, source identity, application and delivery lineage.
- CLI, Doctor, audit and read-only outcome status expose registered, consumed, stale-unconsumed and lineage-bound measurements. Explicit local purge removes only stale unconsumed receipts while a digest-only replay tombstone remains.

### Changed

- New outcome recording consumes one exact measurement receipt instead of accepting mutable measurement facts inline. Source digests and evaluator/run pairs are single-use across all evaluation contracts in one project.
- Evaluation v1-v3 and outcome v1-v6 history remains readable; only new v4 contracts require the measurement-registration boundary.

### Security

- Cross-contract replay, evaluator/run replay, metric or scope substitution, duplicate consumption and digest-valid state injection fail closed. Measurement receipts remain content-free, context-only and cannot grant identity, rights, credentials, tools or policy exceptions.

## [0.16.0] - 2026-09-01

### Added

- New `agentspine.learning-evaluation/v3` contracts require every measurement to identify its external evaluator result by SHA-256; `agentspine.learning-outcome/v6` binds that provenance to the existing dataset, case, scope, application and delivery receipts.
- CLI, Doctor, audit and read-only outcome status distinguish provenance-bound measurements from readable legacy history.

### Changed

- A measurement source can appear only once within an evaluation contract, across before and after phases. Distinct evaluator and receipt IDs no longer make replayed evidence independent.
- Legacy v1/v2 evaluation contracts and v1-v5 outcomes remain readable; only new experiments require unique provenance.

### Security

- Missing, malformed, replayed or state-injected measurement provenance fails closed. Provenance receipts retain only digests and never evaluator output, benchmark cases, prompts, answers, transcripts, credentials or authority.

## [0.15.0] - 2026-09-01

### Added

- Immutable `agentspine.learning-evaluation/v2` contracts and content-free `agentspine.learning-outcome/v5` receipts bind every new measurement to the exact registered dataset digest and its measured case count.
- CLI, Doctor, audit and read-only outcome status expose coverage-bound and legacy measurements separately.

### Changed

- The registered `minCases` floor is now enforced for every before and after measurement. Legacy v1 evaluation contracts and v1-v4 outcomes remain readable, while new experiments require explicit coverage proof.

### Security

- Missing case counts, cherry-picked subsets, dataset drift, tampered coverage bindings and conflicting retry IDs fail closed before they can promote or validate a Canary. Coverage receipts retain no benchmark cases, prompts, answers, transcripts, credentials or authority.

## [0.14.0] - 2026-09-01

### Added

- Content-free `agentspine.learning-delivery/v1` receipts prove that a preflight-bound Canary projection reached a matching native `Stop` or `SubagentStop` in the exact host session and scope.
- `agentspine.learning-outcome/v4` binds every new after-measurement to both the projection and completed-turn delivery receipts; CLI, Doctor, audit and read-only status expose pending, stale, completed and delivered evidence separately.
- Locally confirmed `learn-delivery-purge` removes expired, unconfirmed projections after crash recovery without touching user sources, completed receipts or lessons.

### Changed

- New `agentspine.learning-application/v2` projections bind the host session and a five-minute completion deadline. A concurrent second projection in the same session degrades safely until the first completes or expires.
- Canary validation counts only completed model turns for new v4 outcomes. Projection alone can no longer manufacture a successful learning application.

### Security

- Delivery receipts store no prompt, answer, transcript, credential or authority. Cross-session, cross-scope, stale, duplicate-conflicting and forged completion attempts are rejected or ignored without blocking the normal answer path.

## [0.13.0] - 2026-09-01

### Added

- Immutable `agentspine.learning-evaluation/v1` contracts bind each automatic behavior experiment to a predeclared task, dataset, evaluator protocol, exact scope, evaluator allowlist, case floor, expiry and promotion thresholds.
- `agentspine.learning-outcome/v3` receipts bind both baseline and post-application measurements to one evaluation contract; CLI, Doctor, audit and read-only status expose planned versus legacy-unplanned evidence.

### Changed

- Automatic Canary promotion and validation use the thresholds frozen in the evaluation contract, so later configuration changes cannot manufacture improvement or suppress a regression.
- Benchmark registration is an explicit local operation; outcome recording rejects missing, stale, cross-scope, metric-drifted and evaluator-drifted contracts.

### Security

- Evaluation state stores only stable IDs, SHA-256 digests, numeric thresholds, scope and timestamps. Task content, datasets, protocols, prompts, transcripts, credentials and authority remain outside learning state.
- Model suggestions still cannot promote learning, protected lessons cannot receive automatic evaluation contracts, and a single blocking defect still forces immediate rollback.

## [0.12.0] - 2026-09-01

### Added

- Content-free `agentspine.learning-application/v1` receipts prove that an active behavior Canary was actually projected after one exact hard preflight was consumed.
- `agentspine.learning-outcome/v2` binds every new after-measurement to one exact application while retaining v1 baseline and historical compatibility.
- CLI, Doctor, audit and read-only MCP status expose application counts, bound after-receipts, awaiting applications and ignored legacy-unbound evidence.

### Changed

- Canary validation now requires both independent evaluators and distinct applied turns; multiple evaluators of one turn cannot satisfy the application threshold.
- Hook application recording is idempotent across retries, exact-scope bound, and omitted entirely for turns without an active Canary.

### Security

- Unbound, stale, cross-persona, cross-user, cross-tenant, cross-project, cross-group and cross-task after-results are rejected before they can affect validation or rollback.
- Application receipts store only IDs, digests, scope and timestamps; prompts, briefings, answers, transcripts, credentials and authority remain absent.

## [0.11.4] - 2026-09-01

### Fixed

- Nonexistent descendants inherit the canonical identity of their nearest existing ancestor, preventing macOS aliases and Windows namespace normalization from misclassifying an internal state directory as external before its first write.

## [0.11.3] - 2026-09-01

### Fixed

- Scanner exclusion roots are canonicalized before comparison, so macOS `/var` → `/private/var` aliases and Windows path normalization cannot reintroduce private AgentSpine state into a home-root catalog.

## [0.11.2] - 2026-09-01

### Fixed

- Exact user-home working directories may keep authenticated AgentSpine state below the home only when that state root is explicitly excluded from source discovery; the installed hook no longer deadlocks on its own signing identity.
- Generic catalog discovery now prunes the configured AgentSpine state subtree before opening Markdown, so signing keys, persona rosters, receipts, and generated state cannot become project context.

### Security

- The exception is limited to an exact OS/`HOME`/`USERPROFILE` home root. State inside an ordinary nested project remains fail-closed, symlinks remain untraversed, and user Markdown remains byte-preserved.

## [0.11.1] - 2026-09-01

### Fixed

- Installed hooks reuse the already bounded host-source catalog throughout scope, continuity, learning, attention, persona, relationship, and briefing reads instead of recursively rebuilding it from the active working directory.
- Windows profile homes are recognized through canonical OS, `USERPROFILE`, `HOME`, and `HOMEDRIVE`/`HOMEPATH` identities, including case-insensitive paths and homes that contain a project marker; their recursive project tree is never enumerated.

### Security

- Direct host-native `CLAUDE.md` and `AGENTS.md` chain files remain fully injected and byte-preserved while unrelated home descendants are excluded from context and indexing.

## [0.11.0] - 2026-08-31

### Added

- Provider-neutral `agentspine.learning-outcome/v1` receipts for content-free, normalized fixed-task before/after measurements bound to exact persona, user, tenant, project, group, task, metric, and evaluator scopes
- Default-off outcome-gated `behavior` candidates with independent-evaluator thresholds, objective-evidence requirements, bounded canary application, measured validation, contradiction detection, staleness gates, and read-only MCP diagnostics
- Local CLI commands for recording outcome receipts and inspecting promotion, canary, regression, and expiry state

### Changed

- Session briefings project outcome-gated behavior only into the exact matching scope and exclude expired canaries with a visible degraded diagnostic
- Learning-state upgrades add outcome configuration and receipts without rewriting existing candidates or user-authored Markdown

### Security

- Model suggestions are retained separately but never count toward automatic promotion or canary validation
- Any blocking defect overrides aggregate scores and immediately rolls back the canary; regressions, insufficient improvement, and expiry also fail closed through rollback
- Outcome receipts contain no prompts, answers, transcripts, credentials, rights, delegation, tool access, production, payment, or policy authority
- Codex plugin metadata omits the validator-rejected `hooks` field; the separate versioned Codex host adapter remains packaged and independently validated

## [0.10.1] - 2026-08-31

### Changed

- Claude mandatory instructions retain the 8 KiB standard budget but may use one explicit, receipt-bound overflow up to 16 KiB; Codex and generic instruction hosts remain capped at 8 KiB
- Relationship deadlines return a visible `degraded` context and abort the active graph read instead of aborting the turn

### Fixed

- Relationship CLI and MCP reads no longer rebuild the complete project catalog before reading the bounded graph state
- An unmarked home-directory working directory no longer becomes a recursive project scan; known user rules are still loaded through their exact host-native paths
- Dropbox, OneDrive, dependency, build and embedded repository directories are excluded from bounded project source traversal
- Oversized mandatory instructions now block immediately with the measured and allowed byte counts instead of an opaque budget message

### Security

- Automatic group neighborhoods continue to exclude explicit cross-group edges, inactive personas, private records and every entity outside the exact authenticated group audience
- The Claude overflow mode, byte usage and hard limit are HMAC-receipt-bound and revalidated immediately before one-time consumption

## [0.10.0] - 2026-08-30

### Added

- Self-healing authenticated persona-to-graph reconciliation on every roster sync, including unchanged replays after partial graph failure
- Automatic context-only group materialization for exact locally approved roster group IDs
- Exact group-scoped team neighborhoods so a persona briefing can include current visible co-members without explicit pairwise edges
- Separate roster-change and graph-repair diagnostics with deterministic counts for created groups, updated entities, and added or removed memberships

### Changed

- Active `person`, `agent`, and `bot` bindings now retain user-authored non-authority graph attributes while authenticated display name, status, source binding, privacy, and membership are reconciled
- Package, lockfile, Claude Code, Codex, marketplace, BLUN and hook-bundle versions advance together to `0.10.0`

### Fixed

- An unchanged roster now repairs missing persona entities, groups, and membership edges instead of remaining permanently classified as a duplicate
- Left and deactivated personas retain append-only identity history but no longer appear in current relationship neighborhoods
- Missing roster groups no longer cause membership edges to be silently skipped
- Relationship reads now fail visibly after a five-second local state deadline instead of waiting indefinitely

### Security

- Group peer expansion requires one exact group audience and filters inactive, private, and other-group entities before returning context
- Conflicting non-group IDs and private groups fail visibly instead of weakening group-scope isolation
- Persona, group, and relationship context remains incapable of granting rights, delegation, tools, execution, access, or policy changes

## [0.9.0] - 2026-08-30

### Added

- Mandatory `agentspine.preflight/v2` before-answer receipts bound to the exact prompt, hook delivery, host, agent, user, tenant, profile, session, project, working directory, task, group, instruction identities, retrieval queries, and briefing
- Provider-neutral `agentspine.retrieval-query/v1` and `agentspine.retrieval-result/v1` contracts with a bounded shell-free `mnemo-command/v1` reference adapter and environment-only credential names
- Explicitly confirmed, scoped Must-Remember candidates with append-only activation, supersession, rollback, permanent local-user purge, checksums, retention, and reserved briefing priority
- Local preflight policy, status, Must-Remember CLI and Doctor/Audit diagnostics; none of these administration surfaces are exposed through MCP
- Claude Code `InstructionsLoaded` observability alongside the blocking `UserPromptSubmit` gate
- BLUN King can now install AgentSpine as a native plugin with the same lifecycle hooks, MCP server, isolated app-home source resolution, and explicit plugin-install trust step as the existing Claude Code and Codex hosts

### Changed

- Prompt turns now carry a compact ordinary briefing plus a separately budgeted mandatory instruction and recall section, avoiding silent source truncation
- Package, lockfile, Claude Code, Codex, marketplace, BLUN, hook-bundle, worker and preflight versions advance together to `0.9.0`

### Fixed

- Routine BLUN hook results now render as one short human-readable status line instead of exposing compact internal JSON in the TUI, while actionable attention, self-starter, channel, and failure details remain available immediately
- BLUN hooks now inject a compact runtime status instead of the complete session briefing on every prompt; detailed continuity remains available on demand while active attention, self-starter, and authenticated channel signals remain immediate
- BLUN lifecycle hooks now index large real workspaces without absorbing embedded test profiles or failing at the smaller host-rule limit
- Windows Node 24 state writes now treat transient lock access errors as contention across every lock-backed store, retry atomic replacements with a bounded backoff, and tolerate briefly retained handles during hermetic cleanup
- The gateway worker now canonicalizes its state directory before opening the native file watcher, avoiding the Windows libuv path assertion on differently cased or short paths
- CI now identifies the failing check phase and annotates the exact hermetic test file or runner error, so public Windows failures can be diagnosed without access to private job logs

### Security

- Controlled preflight failures return the host's blocking decision and exit code 2 instead of the previous fail-open informational packet
- Mandatory instructions are reopened without following symlinks, checked through one filehandle before and after reading, SHA-256 bound, fully injected, and rejected on replacement, deletion, scope escape, size overflow, stale identity or second receipt consumption
- Required recall distinguishes a verified empty result from no invocation or failure; provider output is scope-bound, content-filtered and incapable of changing policy or authority
- Receipts are short-lived, HMAC-authenticated in private external state, one-time consumable, and contain no prompt text, rule content, memory claims, credentials or transcripts
- Receipt consumption revalidates the current instruction set, local policy revision, active critical-memory checksums and exact turn scope; aborted prepared turns are invalidated for safe retry while consumed deliveries remain replay-blocked
- Claude-only `InstructionsLoaded` registration is physically separated from Codex's documented lifecycle event set

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

[Unreleased]: https://github.com/Maykbiletti/AgentSpine/compare/v0.66.0...HEAD
[0.66.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.65.0...v0.66.0
[0.29.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.11.4...v0.12.0
[0.11.4]: https://github.com/Maykbiletti/AgentSpine/compare/v0.11.3...v0.11.4
[0.11.3]: https://github.com/Maykbiletti/AgentSpine/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/Maykbiletti/AgentSpine/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/Maykbiletti/AgentSpine/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/Maykbiletti/AgentSpine/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Maykbiletti/AgentSpine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Maykbiletti/AgentSpine/releases/tag/v0.1.0
