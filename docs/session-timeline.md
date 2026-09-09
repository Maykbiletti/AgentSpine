# Bounded session timeline and evidence recall

AgentSpine indexes immutable host transcripts without copying them. Signed
sidecars contain bounded redacted evidence and opaque references, never text.
Recall is private, task-scoped, context-only, and grants no authority.

## Enrollment and retrieval

Claude, Codex, and King use separate deny-by-default adapters. Verified
`UserPromptSubmit` issues a short-lived one-use receipt bound to source,
provider, session, user, tenant, project, task, optional goal, and derived
portal/thread route. Model values, partial routes, groups, and unknown visibility
cannot enroll.

```text
agentspine timeline-receipt --root /path/to/project
agentspine timeline-enroll --root /path/to/project --receipt asthr_… --confirm-local-timeline
```

Enrollment reads fixed metadata and at most 4 KiB. Each operation revalidates
source, root, provider, and scope; changed bytes invalidate the snapshot. No
append, broad scan, refresh, retry, or fallback exists. One-use `PreToolUse`
permits expose:

```text
session_timeline_index(maxBytes)
session_timeline_search(at | terms, includePriorSessions, includePriorProviders)
session_timeline_capture(eventId, at | terms, includePriorSessions, interpretation)
```

Indexing is serialized and limited to 64 KiB–16 MiB. Search uses an exact UTC
window or two terms, opens ≤1 ranked source, verifies bounded lines,
returns at most eight cards, and never widens misses. Prior sessions require the
exact private route. Cross-provider recall additionally requires
`AGENTSPINE_TIMELINE_CROSS_PROVIDER=1` and both prior flags while retaining the
original provider enrollment.

Capture consumes a new permit and derives provenance from the reopened source.
Only allowlisted objective fields enter the existing world model. Direct stdio,
replay mutation, foreign/group scope, expiry, unsafe state, or changed bytes
writes nothing. Conflicts remain unresolved; duplicates survive restart.

## Natural user-message continuity (development)

Authenticated routes may retain 256 native user references without evicting
objective/strict-correction evidence; the combined cap is 4096. Text and derived
terms are not indexed. The technical `user message` query selects this lane.

Capture rechecks one single-line user message (maximum 2048 UTF-8 bytes), its
route, and checkpoint. The exact quote becomes an `uninterpreted-user-message`
assumption with provenance and target—not a fact, correction, completion,
supersession, permission, or action.

One active candidate may receive a source-bound
`agentspine.timeline-user-feedback-interpretation-request/v1` proposal. Two or
three same-task candidates accept only an
`agentspine.timeline-user-feedback-clarification-request/v2` bound to the full
sorted assertion set. Each candidate keeps its own provider, session, message,
source digest, message digest and timestamp. Each registered source is reopened
and rechecked within the capture gate; partial, reordered, changed,
foreign-scope, unregistered, or larger sets fail. Replay deduplicates and
competing proposals conflict.

Both private `model-suggestion` forms keep model/source provenance, target,
replaced next step, and `completionVerified:false`; neither mutates continuation
nor grants authority. Pre-answer recall carries them across restart/compaction.
Three candidates use lossless field/row encoding. King's
bounded form shares repeated values and prefixes, so all IDs, messages, times,
provider, session, and source digest reconstruct within the unchanged 1200-byte
host field.

An objective result may advance continuation only when the same private task
and route already contain one confirmed
`agentspine.timeline-continuation-outcome-contract/v1`. The contract fixes the
exact current step, test label, total, success count, and success state before
the event. Capture reopens the source, retains the raw measurement, and then
updates `lastVerifiedStep`; failure keeps the agreed step without retrying,
while success applies only the contract's explicit next step or terminal state.
Postdated, stale, conflicting, foreign, superseded, or model-suggested contracts
cannot advance work. A newer user correction wins because its step no longer
matches the old contract. Raw contradictory outcomes remain visible uncertainty.

The deterministic lane still requires a whole native line beginning
`Correction: next step:` or `Korrektur: nächster Schritt:` and changes only
`nextStep` on one same-thread active conflict-free continuation. Ordinary,
assistant, multiline, stale, unsafe, foreign, and group inputs fail.

Repository tests for Claude, Codex, and King are independent. Quotes,
hypotheticals, negations, old/foreign text, and completion claims remain context.
Acceptance still needs a genuinely new model session to recognize the job, name
its result file, apply a natural correction, and ask only on real ambiguity.
Technical checks do not prove semantics, repetition, tokens, or live behavior.

## Integrity and provider formats

Signed sidecar, head, and protected anchor detect state-only/mixed rollback. One
torn generation is lock-repairable; malformed, missing, altered, linked,
rerooted, racing, or signature-invalid state yields no cards. Detecting a fully
matching anchor restoration needs an external monotonic anchor. Failure means
unverified recall, not a work ban or retry loop.

`codex-rollout-jsonl/v1` accepts one enrolled uncompressed file below verified
Codex `sessions` and validates bounded `session_meta`; `king-agent-wire-jsonl/v1`
requires a protected source/protocol mapping. Unknown, inherited, compressed,
or changed formats fail closed. Only reviewed native tool results yield
objective cards; chat never does.

Format provenance was inspected on 2026-09-06 in [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex 6af3454](https://github.com/openai/codex/tree/6af345407d9c2a568da9d01b6c4b81a9e61495c0),
and [BLUN fbb97459](https://github.com/Maykbiletti/blun-code/tree/fbb97459a3fa2157f8bfea3d24931be63288ab11).
No source was copied/executed; live mapping, trust, blocking, model use, and
installation remain separate acceptance boundaries.
