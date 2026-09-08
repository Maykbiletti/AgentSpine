# Bounded session timeline and evidence recall

AgentSpine indexes an immutable host-owned transcript without copying or
rewriting it. The signed sidecar contains bounded redacted evidence and opaque
references, never transcript text. Recall is private, task-scoped,
context-only, and grants no authority.

## Enrollment and retrieval

Claude, Codex, and King have separate deny-by-default adapters. A verified
`UserPromptSubmit` creates a short-lived one-use receipt for one safe source and
its exact provider, session, user, tenant, project, task, and optional goal.
Gateway sessions also bind opaque route-derived portal/thread references.
Prompt/model values, partial routes, groups, and unknown visibility cannot
enroll.

```text
agentspine timeline-receipt --root /path/to/project
agentspine timeline-enroll --root /path/to/project --receipt asthr_… --confirm-local-timeline
```

Enrollment reads fixed metadata and at most a 4 KiB prefix. Every operation
revalidates source, root, provider, and scope; changed sources invalidate the
snapshot. There is no append, broad scan, refresh, retry, or fallback.

Protected one-use `PreToolUse` invocations expose:

```text
session_timeline_index(maxBytes)
session_timeline_search(at | terms, includePriorSessions, includePriorProviders)
session_timeline_capture(eventId, at | terms, includePriorSessions, interpretation)
```

Indexing is serialized and limited to 64 KiB–16 MiB. Search uses an exact UTC
instant/window or two terms, ranks signed cards, opens at most one source, and
verifies bounded original lines. At most eight cards return. Prior-session
selection requires exact private scope and portal/thread continuity. Misses do
not widen the scan. Cross-provider selection additionally requires
`AGENTSPINE_TIMELINE_CROSS_PROVIDER=1` and both prior-selection flags; each
source retains its own provider enrollment.

Capture consumes a new permit, reopens the immutable source, and derives scope,
time, IDs, digests, and references from host/source data. Objective results add
only allowlisted descriptive fields to the existing world model. Direct stdio,
replay mutation, foreign/group scope, expiry, unsafe state, or changed bytes
writes nothing. Conflicts remain unresolved and duplicates are restart-safe.

## Natural user-message continuity (development)

New authenticated portal/thread index ranges may retain up to 256 native user
message references without evicting objective or strict-correction evidence;
the combined index remains capped at 4096. Text and content-derived terms are
not indexed. The technical `user message` query selects this lane.

Capture rechecks a selected single-line message (maximum 2048 UTF-8 bytes), its
user role, route, and checkpoint. The exact quote becomes an
`uninterpreted-user-message` assumption with original provenance and target.
It is not a fact, correction, completion, supersession, permission, or action.

For exactly one active candidate, a second source-bound capture may retain a
strict `agentspine.timeline-user-feedback-interpretation-request/v1` proposal.
For two or three active candidates from the same reverified source, only an
`agentspine.timeline-user-feedback-clarification-request/v1` proposal bound to
the complete sorted assertion set is accepted. A partial, reordered, changed,
cross-source, or larger set is rejected. Its one bounded question is carried
after restart as a model proposal, not as a mandatory user query.

Both proposal forms are private `model-suggestion` assumptions with
`completionVerified:false`. They preserve the model provider, source binding,
target checkpoint, and replaced next-step ID but never mutate continuation,
prove completion, or grant authority. Exact replay deduplicates; a competing
proposal conflicts. Every cited raw line is reopened and digest-checked in the
same bounded capture before a multi-candidate clarification is recorded.

The older deterministic lane accepts only a complete native user line starting
`Correction: next step:` or `Korrektur: nächster Schritt:`. It may replace only
`nextStep` on one same-thread active conflict-free continuation. Ordinary,
assistant, multiline, stale, unsafe, foreign, and group inputs fail.

Claude, Codex, and King repository tests are independent. Quotes,
hypotheticals, negations, old/foreign text, and completion claims remain
context. Product acceptance still needs a genuinely new model session to
recognize the job, name its existing result file, apply a natural correction,
and ask only on real ambiguity. Parser, MCP, hook, and package checks do not
prove semantic use, avoided repetition, token savings, or live-host behavior.

## Integrity and provider formats

The signed sidecar, head, and protected anchor detect state-only and mixed
rollback. One torn generation is repairable under lock; malformed, missing,
altered, linked, rerooted, racing, or signature-invalid state yields no cards.
A complete matching anchor restoration needs an external monotonic anchor to
detect. Failure means unverified recall, not a work ban or retry loop.

`codex-rollout-jsonl/v1` accepts one enrolled uncompressed file below the
verified Codex `sessions` root and validates its bounded `session_meta`.
`king-agent-wire-jsonl/v1` separately requires the protected source and protocol
mapping. Unknown, inherited, compressed, or changed formats fail closed. Only
reviewed native tool-result records yield objective cards; chat never does.

Format provenance was inspected on 2026-09-06 in official
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks),
[openai/codex commit 6af3454](https://github.com/openai/codex/tree/6af345407d9c2a568da9d01b6c4b81a9e61495c0),
and [BLUN Code fbb97459](https://github.com/Maykbiletti/blun-code/tree/fbb97459a3fa2157f8bfea3d24931be63288ab11).
No source code was copied or executed. Live launcher mappings, trust, block
enforcement, model use, and installation remain separate acceptance boundaries.
