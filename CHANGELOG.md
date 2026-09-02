# Changelog

All notable changes to AgentSpine will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Maykbiletti/AgentSpine/compare/v0.29.0...HEAD
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
