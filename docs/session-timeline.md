# Bounded session timeline and evidence recall

AgentSpine indexes an immutable host-owned transcript without copying,
rewriting, or putting it in `MEMORY.md`. Its signed sidecar holds bounded
redacted evidence and opaque references. Recall is private, task-scoped,
context-only, and grants no authority.

## Enrollment and source trust

Claude, Codex, and King use separate deny-by-default adapters. A verified
`UserPromptSubmit` creates a short-lived, one-use receipt bound to one safe
transcript and its exact host/provider/session/private task scope. Gateway use
also binds route-derived opaque portal/thread references. Prompt/model values,
partial routes, groups, and unknown visibility cannot enroll.

```text
agentspine timeline-receipt --root /path/to/project
agentspine timeline-enroll --root /path/to/project --receipt asthr_… --confirm-local-timeline
```

The protected transport that created the receipt must deliver it. Enrollment
checks fixed metadata and at most a 4 KiB prefix, not historic content. Every
operation revalidates root, source, provider, and scope. Changed/grown sources
invalidate the snapshot; there is no append, scan, refresh, retry, or fallback.
Owner recovery discards only the sidecar and requires a fresh receipt.

## Bounded retrieval and capture

Hooks expose a small freshness hint and current continuation capsule, never
historic text. A protected one-use `PreToolUse` invocation is required for:

```text
session_timeline_index(maxBytes)
session_timeline_search(at | terms)
session_timeline_search(at | terms, includePriorSessions: true)
session_timeline_search(at | terms, includePriorSessions: true, includePriorProviders: true)
session_timeline_capture(eventId, at | terms, includePriorSessions: true)
```

Index calls are serialized and bounded to 64 KiB–16 MiB. Search requires an
exact UTC instant/window or two concrete terms, ranks signed cards before
opening one source, and verifies bounded original lines. At most eight redacted
cards return with time, references, source digest, room ID, and
`untrusted-session-history`; secrets/instructions are discarded or redacted.

Prior-session selection requires exact private host/entity/user/tenant/project/
task/goal/portal/thread continuity. Hints contain no text and misses never widen
the scan. Cross-provider selection is off by default and needs both
`AGENTSPINE_TIMELINE_CROSS_PROVIDER=1` and
`includePriorSessions: true, includePriorProviders: true`. Current and selected
sources retain independent provider enrollments and validation. Passing one
provider therefore proves nothing about another.

Capture consumes another one-use invocation, reopens the immutable source, and
derives route, scope, time, IDs, digest, and references from host/source data.
Objective results contribute only allowlisted fields to the existing private
task-state world model. Direct stdio, replay, mutation, wrong event, foreign/
group scope, expiry, unsafe state, or changed bytes writes nothing. Conflicts
remain visible; exact duplicates are restart-safe.

## Natural user-message continuity (development)

New authenticated portal/thread ranges may retain up to 256 native user-message
references without evicting objective/strict-correction evidence; the combined
index remains capped at 4096. Neither message text nor content-derived search
terms enter the index, and old ranges are not silently migrated. The technical
query `user message` selects this lane; it is not a user phrase or classifier.

For one single-line message of at most 2048 UTF-8 bytes, capture rechecks source,
role, scope, and checkpoint. The exact quote becomes an
`uninterpreted-user-message` assumption with original provenance and target. It
is not a fact, correction, completion, supersession, permission, or action; a
newer checkpoint removes only its current priority.

A model may make a second source-bound capture with a strict
`agentspine.timeline-user-feedback-interpretation-request/v1`. Only when exactly
one active verified raw candidate targets the current nonterminal checkpoint,
the proposal is preserved as
`agentspine.timeline-user-feedback-interpretation/v1`. The host re-derives the
source digest/provider, target, model provider, and replaced next-step assertion;
model-supplied provenance, authority, measurement, confirmation, or completion
evidence is impossible.

Allowed kinds are `next-step-correction`, `completion-claim`,
`not-current-instruction`, and `ambiguous`. Every record remains
`model-suggestion` with `completionVerified:false` and cannot mutate the
continuation. Multiple raw candidates reject interpretation. A deterministic
source/target assertion ID makes replay idempotent and a competing proposal a
conflict rather than a parallel selection. The compact pre-answer packet
carries semantic fields plus proposal digest; full world state retains source
and model time/session/message provenance. New checkpoints, foreign routes,
changed sources, malformed schemas, replay, and post-permit mutation reject it.

The older deterministic lane accepts only an entire native user line beginning
`Correction: next step:` or `Korrektur: nächster Schritt:`. It may update only
`nextStep` on one same-thread active, conflict-free continuation, preserving all
other fields and supersession history. Stale/concurrent, ordinary/assistant,
unsafe, foreign, or group inputs fail.

Claude, Codex, and King adapter tests are independent. Quotes, hypotheticals,
negations, stale/foreign text, and completion claims remain context; even a
proposal is not user confirmation. Product
acceptance still requires a genuinely new model session to recognize the job,
name its existing result file, apply a natural correction, and ask only on real
ambiguity. Parser/MCP/hook tests do not prove semantic use, avoided repetition,
token savings, live host behavior, or another provider's lifecycle.

## Integrity and bounded failure

Sidecar, signed head, and protected anchor detect state-only and mixed rollback.
One torn generation is repairable under lock; malformed, missing, altered,
linked, rerooted, racing, or signature-invalid state yields no cards. A fully
restored matching anchor needs an external monotonic anchor to detect. Failure
means unverified recall, not a work ban, retry, permission, or completion.

## Codex native rollout contract

`codex-rollout-jsonl/v1` accepts one enrolled uncompressed file below the
verified Codex `sessions` root. Its bounded `session_meta` validates identity,
project, version, and history mode. Only native tool-output `response_item`
records yield objective candidates with time, digest, references, `call_id`, and
bounded excerpt. Unknown, changed, compressed, or inherited formats fail closed;
Codex retains permissions and King cannot reuse this adapter.

Provenance inspected 2026-09-06: official [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
and [openai/codex commit 6af3454](https://github.com/openai/codex/tree/6af345407d9c2a568da9d01b6c4b81a9e61495c0)
(Apache-2.0). The unstable format warning remains authoritative; no code was
copied or executed.

## King native agent-wire contract

`king-agent-wire-jsonl/v1` is independent. The trusted launcher must provide
`AGENTSPINE_KING_TIMELINE_SOURCE` for the current agent wire and matching
`AGENTSPINE_KING_WIRE_PROTOCOL_VERSION`; AgentSpine never scans `BLUN_HOME`.
Bounded metadata validates source/protocol/session. Only reviewed
`context.append_loop_event` / `tool.result` records yield objective cards with
native `toolCallId`. Chat, claims, unknown schemas, and non-text outputs do not.

Primary provenance inspected 2026-09-06: [BLUN Code fbb97459](https://github.com/Maykbiletti/blun-code/tree/fbb97459a3fa2157f8bfea3d24931be63288ab11),
application `1.0.109`, and vendored `@blun/king-sdk` `0.12.1` (MIT). Repository
tests do not prove protected live launcher mappings, King block enforcement, or
a real session's context use.

## Measured boundary

Synthetic fixtures cover bounded large sources, byte preservation, isolation,
expiry/replay, tampering, crash/race, redaction, restart, and compaction. They
are repository contracts, not model, token, or live-host tests.
