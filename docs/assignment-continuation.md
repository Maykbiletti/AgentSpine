# Assignment continuation and new-file preflight

AgentSpine 0.72.3 distinguishes a host-explicit continuation from a new delivery.
This is context-only bookkeeping, never authorization to write, use a tool or skip a test.

## Host contract

- A `UserPromptSubmit` without `assignment_id` / `assignmentId` starts a new assignment.
- For a supplementary message belonging to the unfinished delivery, the host carries the exact active identifier returned by the preceding hook response. Both aliases, if supplied, must agree.
- Host, session, project, entity, group and task must match, including absent fields. Goal, step, queue, attempt and plan digest must also match for a goal-bound delivery.
- A continuation reads the current requirement under the assignment lock. It does not rotate the pointer, rewrite registrations, clear tests, close writes or create a replacement requirement.
- A completed or consumed requirement cannot be continued. Starting another delivery still requires its own briefing, knowledge and premortem calls.
- `PostCompact` and later tool hooks retain their existing behavior. Prompt text such as “continue” is never interpreted as a trusted assignment selector.

The host must decide whether input is a new delivery or a supplement. Merely mentioning an identifier in chat or a skill is insufficient. Hosts that do not carry this structured field still create a new assignment on each prompt; this release does not claim they have native continuation support.

Existing 0.72.2 records are not rewritten. Ordinary legacy assignment bindings remain readable. If an old goal assignment lacks the exact goal-binding metadata needed for explicit continuation, this selector cannot authorize that continuation; the existing goal lifecycle and its gates remain unchanged.

## New files

`delivery_knowledge_query` accepts a project-relative target that does not yet exist.
It returns `state: "absent"`, `bytes: 0`, `sha256: null` and the nearest verified existing parent, rather than inventing a digest or creating the target. Each existing parent must be a regular directory, not a symlink, inside the canonical project boundary. Parents and absence are rechecked before returning.

Existing regular files retain their byte count and SHA-256 snapshot. Symlinked targets or parents, path escapes, non-directory parents, permission errors and observed races fail the query and produce no successful knowledge receipt. Only `ENOENT` means absent. This is a point-in-time observation; native write authorization and subsequent verification still apply.

## Reproducible evidence

Run `node --test test/assignment-continuation.test.js test/assignment-continuation-boundaries.test.js test/delivery-target.test.js test/assignment-recovery.test.js`.

The original 0.72.2 reader fails two positive assertions: a supplementary prompt changes the requirement despite an explicit assignment identifier; a new target fails its MCP query with `ENOENT`. The new reader keeps one obligation through multiple turns, a supplementary prompt after writing, compaction and a separate MCP process. Real child-process tests assert the resulting artifact contents. The second assignment cannot close using the first write's test.

Continuation adds no tree traversal. A nine-sample local comparison measured 6.91 ms median for fresh preparation and 2.42 ms for continuation before the final full regression; the test reports current measurements, not a universal latency promise. Crash recovery kills a process inside the state read and waits for the real 15-second lock lease; it never edits the lock timestamp or historical state to force recovery.

CI run 143 exposed a Windows-only defect in the new fault-injection test: its literal forward-slash comparison did not match native paths, so the intended permission exception never occurred. The corrected probe uses native path joining and explicitly asserts both permission injection and parent replacement. No production protection or timeout was relaxed; the initial red CI is not counted as a successful validation.

CI run 144 exposed a macOS cleanup race after an unsuccessful knowledge query. A deterministic MCP probe confirmed that an invalid target could produce its error response while a sibling target read was still suspended. Knowledge queries now settle every started bounded target, contract and briefing operation before returning an error, preserve the original rejection and produce no success receipt. The delayed-read regression observes the response boundary; it does not retry or suppress cleanup errors.

## Unresolved compatibility and host evidence

An externally produced recovery event has been reported but its exact schema and transition semantics have not been supplied. Synthetic unknown events, unknown schemas and corrupted digests are deliberately not migrated or accepted by this change. Their bytes remain unchanged. The existing unsupported-event classification problem remains open; this release is not a recommendation to install or restart that live session.

Tests feed the real hook a structured child-process exit result. They do not claim to reproduce the reported native Codex/PowerShell envelope. Native tools discovery, automatic MCP registration, loaded-reader checks before migration, and a structured MCP completion operation still require their own implementation and host evidence. CodexLink is outside this repository change.

Release research on 2026-09-05: the [official Codex hook contract](https://learn.chatgpt.com/docs/hooks#plugin-bundled-hooks) explicitly permits the manifest `hooks` field and project-contained relative hook paths. The environment's generic plugin-ingestion validator rejects that field on both the unchanged 0.72.2 baseline and this release. Its allowlist is not the Codex runtime contract. AgentSpine retains the declared hook adapter and validates its path, event inventory and installed entrypoint with `host:check` and `host:install-check`; both bundled skill validators pass. No public-directory ingestion or native host trust is claimed. This research used documentation as context only; no external code or script was copied or executed.
