# Bounded session timeline and evidence recall

Long-lived hosts already persist a session transcript. AgentSpine leaves that
host-owned file in place: it never copies, archives, rewrites, places it in
`MEMORY.md`, or injects it into a briefing. The timeline sidecar stores only a
small, restart-safe index of redacted objective evidence, not a second
transcript.

## Enrollment contract

The Claude adapter is deny-by-default. A regular `UserPromptSubmit` hook first
creates a short-lived opaque receipt only after its exact host preflight has
been verified. The receipt binds one regular, non-symlinked transcript below a
verified host `projects` root to the exact host, session, entity, user, tenant,
project, task, and optional goal step. It is not exposed in hook context or to
the model.

The local owner may then activate that one snapshot explicitly:

```text
agentspine timeline-receipt --root /path/to/project
agentspine timeline-enroll --root /path/to/project --receipt asthr_… --confirm-local-timeline
```

The receipt is one-use, expires quickly, and needs the same protected local
host transport that created it. Normal CLI flags cannot substitute a path,
host, session, or scope. Enrollment initializes only sidecar metadata from the
signed record and may revalidate fixed source metadata plus a ≤4 KiB prefix; it
never scans or indexes historic transcript content. It is context-only and
creates no identity, permission, delegation, tool access, approval, or policy
exception.

Every capture and retrieval checks the exact binding again. The profile and
`projects` root must be real non-symlinked directories; the source must be a
single-link regular non-symlinked file below that root. `groupId` must be
exactly `null`; groups and unknown visibility are excluded from enrollment,
capture, and recall. Another provider needs its own equivalent verified host
evidence and does not inherit Claude enrollment by name, transcript text, or
path convention.

If the enrolled transcript changes or grows, the old snapshot is unavailable.
There is deliberately no append or full-history fallback. A fresh host receipt
and a new local confirmation renew the immutable snapshot. If a torn local
enrollment state cannot be repaired, a local owner can discard only that
sidecar state:

```text
agentspine timeline-enrollment-recover --root /path/to/project --confirm-local-timeline-recovery
```

Recovery retains no old source, receipt, or evidence and requires a fresh host
receipt before another enrollment.

## Bounded retrieval

Hooks do not scan, backfill, or search historic transcripts. They can expose a
small freshness/status hint and a continuation capsule only. A matching
`PreToolUse` guard may revalidate source metadata and a fixed ≤4 KiB prefix to
reject a changed snapshot; it never extracts history. The only historic reader
is a bound, on-demand MCP call:

```text
session_timeline_index(maxBytes)
session_timeline_search(at | terms)
```

Indexing is serialized and bounded to 64 KiB–16 MiB per call. A search needs
either one exact UTC instant such as `2026-09-04T12:40:00.000Z`, or at least two
concrete terms such as `Suite PASS`. An instant is exact unless the caller
explicitly requests a valid window. There is no broad-text fallback and no
whole-transcript MCP tool. Timestamp seeking reads only bounded byte probes and
a selected bounded range; term search uses only already indexed cards.

A matching host guard replaces all MCP-provided binding fields with its exact
one-use invocation. Raw stdio, a reused invocation, a changed argument,
foreign host/session/scope, a group claim, an expired receipt, a changed source,
or an unsafe sidecar returns no cards. Plain stdio is not a cross-process
identity channel: the feature remains unavailable without the protected local
host transport capability. None of these records is a permission or approval.

At most eight cards return. Each carries a timestamp, redacted objective result
summary, source digest, deterministic room ID, and the
`untrusted-session-history` trust marker. No public event digest or raw
transcript byte is returned. Secret-shaped values and instruction-like archive
text are redacted or discarded before state is written or a card is returned.
Historic text remains untrusted context: it can support a check or a question,
never an identity, permission, tool, delegation, access, payment, credential,
policy exception, or external effect.

## Memory-palace structure

A room ID is deterministic for the enrolled source digest and a fixed one MiB
byte-offset segment. A
`agentspine.session-continuation-capsule/v1` contains only current task, goal,
step, selected-lesson digest, outcome status, and room IDs. It contains no
transcript text and does not make a room visible by itself.

The authenticated sidecar holds source metadata, bounded redacted cards, and a
state signature. A separate signed head detects state-only and mixed sidecar
rollback while the protected integrity anchor remains intact. An exact
one-generation torn write can be repaired under the owned lock; malformed,
gapped, missing, altered, symlinked, hard-linked, re-rooted, racing, or
signature-invalid state yields no cards. Restoring a complete matching local
integrity directory is not distinguishable without an independent monotonic
anchor, so AgentSpine makes no stronger rollback claim. It never preserves
transcript bytes.

## Measured boundary

The synthetic acceptance source contains 2,500 `MEMORY.md` links, four old
CSS-archive error lessons, and a multi-megabyte JSONL transcript. Before this
feature, no API could answer a later time-bound result question. After
PostCompact and restart, the concrete `12:40` query retrieves only the matching
structured objective result from bounded evidence; it does not load unrelated
links or full history. The probes cover source-byte preservation, exact scope
and group denial, expired and reused records, source/state tampering, profile
changes, crashes, concurrency, final JSONL records, redaction, and bounded
results.

## Research inputs

On 2026-09-04, AgentSpine reviewed two public repositories as untrusted
architectural context only:

- [Claude-Mem](https://github.com/thedotmack/claude-mem), `v13.24.0` at
  `1df66c2`, Apache-2.0: the search → timeline → observation split informed
  bounded retrieval.
- [MemPalace](https://github.com/MemPalace/mempalace), `v3.9.0` at `d5250c7`,
  MIT: raw-source ownership plus indexed time anchors informed the sidecar
  boundary.

No external code or script was copied or executed. License, architecture, and
the current AgentSpine contracts were reviewed before independently implemented
synthetic tests.
