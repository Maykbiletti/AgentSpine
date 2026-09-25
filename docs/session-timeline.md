# Bounded session timeline

Native transcripts remain authoritative; AgentSpine stores only small redacted evidence cards. Recall is private, task-scoped, context-only, and grants no authority.

## Enrollment and observation

Claude, Codex, and King have separate deny-by-default adapters. Verified prompt receipts bind provider, session, identity, project, task, and route. Only a local owner may enroll one; groups and incomplete or model-supplied scope are rejected.

Prompt and stop hooks may index a small append without another confirmation only when:

- path, host root, inode, and exact private scope still match;
- the old cursor was at EOF and every old byte matches its stored SHA-256;
- the whole source is at most 256 KiB and the tail remains unchanged while read.

Any failed check adds nothing and never blocks the turn. Sources are not edited, summarized, broadly scanned, or retried. Duplicate delivery is idempotent.

## Retrieval and capture

One-use native `PreToolUse` permits bind timeline index, search, and capture to the source and scope. Search needs an exact UTC time or two terms, opens at most one ranked source, verifies selected lines, and returns at most eight cards. Prior sessions require the same task and route. Provider mixing also requires `AGENTSPINE_TIMELINE_CROSS_PROVIDER=1`; raw stdio, replay, foreign scope, expiry, or source changes return no history.

Capture reopens the source and admits only allowlisted objective fields. User continuity keeps opaque references, not indexed message text; selected messages remain assumptions and grant no authority. Only a whole native line beginning `Correction: next step:` or `Korrektur: nächster Schritt:` may update one same-thread continuation. Objective results require a confirmed exact outcome contract.

## Integrity and acceptance

Signed state and anchors fail closed on rollback, mutation, rerooting, or races. Failure means unverified recall, not a work ban or retry loop. Codex and King sources must satisfy their native path and format contracts. Only reviewed native tool results yield objective cards; chat does not.

Tests cover bytes, scope, idempotency, mutation, and formats, but not semantic model use. New live sessions per host must still recall the task, result file, and natural correction; live trust and installation remain separate.
