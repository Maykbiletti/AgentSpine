# Bounded session timeline and evidence recall

Long-lived hosts already persist a session transcript. AgentSpine leaves that
host-owned file in place: it never copies, archives, rewrites, places it in
`MEMORY.md`, or injects it into a briefing. The timeline sidecar stores only a
small, restart-safe index of redacted objective evidence, not a second
transcript.

## Enrollment contract

The Claude, Codex, and King adapters are deny-by-default. A regular `UserPromptSubmit` hook first
creates a short-lived opaque receipt only after its exact host preflight has
been verified. The receipt binds one regular, non-symlinked transcript below a
verified host `projects` (Claude) or `sessions` (Codex and King) root to the exact host, session, entity, user, tenant,
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
provider-specific transcript root must be real non-symlinked directories; the source must be a
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
session_timeline_search(at | terms, includePriorSessions: true)
session_timeline_search(at | terms, includePriorSessions: true, includePriorProviders: true)
```

Indexing is serialized and bounded to 64 KiB–16 MiB per call. A search needs
either one exact UTC instant such as `2026-09-04T12:40:00.000Z`, or at least two
concrete terms such as `Suite PASS`. An instant is exact unless the caller
explicitly requests a valid window. There is no broad-text fallback and no
whole-transcript MCP tool. Timestamp seeking reads only bounded byte probes and
a selected bounded range; term search uses only already indexed cards.

After a restart, the lifecycle hint may report only the number of already
indexed prior sessions and objective events for the exact same private task.
It does not contain transcript text. When a concrete question is relevant,
`includePriorSessions: true` restricts candidate sources to the same host,
entity, user, tenant, project, task and compatible goal. It ranks their signed
sidecar cards before opening a source, selects at most one prior immutable
snapshot, and verifies only matching original lines. A missing match does not
fall back to scanning old transcripts.

Provider handoff is an additional, disabled-by-default continuity mode. The
local host must set `AGENTSPINE_TIMELINE_CROSS_PROVIDER=1`, and the one bounded
search must explicitly combine `includePriorSessions: true` with
`includePriorProviders: true`. Neither choice alone works. Candidate sources
must still match the exact entity, user, tenant, project, task and compatible
goal with no group. The current session is revalidated against its own host
transport and enrollment; the selected prior snapshot is separately
revalidated against its original provider, signed enrollment and profile root.
The result names that `sourceProvider` on both the response and each card.

This is evidence continuity, not shared provider identity. It does not convert
Claude JSONL into Codex rollouts, Codex rollouts into King wires, or any memory
into a current test, permission, delegation, publication approval or learning
authorization. With the local capability absent, same-provider behavior is
unchanged and another provider is not even eligible for ranking. Expired
enrollment, changed bytes, unknown formats, a foreign scope or a group returns
no historical content and triggers no retry or enrollment reset.

A matching host guard replaces all MCP-provided binding fields with its exact
one-use invocation. Raw stdio, a reused invocation, a changed argument,
foreign host/session/scope, a group claim, an expired receipt, a changed source,
or an unsafe sidecar returns no cards. Plain stdio is not a cross-process
identity channel: the feature remains unavailable without the protected local
host transport capability. None of these records is a permission or approval.

At most eight cards return. Each carries a timestamp, bounded redacted excerpt,
stable opaque session and message references, source digest, deterministic room ID, and the
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

The synthetic acceptance sources contain 2,500 memory links, four old
CSS-archive error lessons, and a multi-megabyte prior-session JSONL transcript.
Before explicit prior-session selection, the restarted session finds no matching
current result. After selection, the concrete `12:40` query retrieves only the
matching verified objective result and stable source references; it does not
load unrelated links or full history. The probes cover source-byte preservation, exact scope
and group denial, expired and reused records, source/state tampering, profile
changes, crashes, concurrency, final JSONL records, redaction, and bounded
results.

The provider-handoff Before/After yields no Claude result in Codex before both
opt-ins, then verifies one Claude `FAIL 0/15` after restart. Replay, foreign
scope, groups and mutation return none; source bytes stay identical.

## Research inputs

Reviewed as untrusted architecture on 2026-09-06: Claude-Mem
[`3939fbb2`](https://github.com/thedotmack/claude-mem/tree/3939fbb2debe73e74a295553636e776e110df90a)
(Apache-2.0) and MemPalace `v3.9.0`
[`d9f05907`](https://github.com/MemPalace/mempalace/tree/d9f059076c866fa6f29195679d75712436986024)
(MIT). Staged retrieval, source ownership and separate adapters informed the
design. AgentSpine keeps stricter host-bound enrollment and one-source
verification; no external code or script ran or was copied.


## Codex native rollout contract

The `codex-rollout-jsonl/v1` adapter accepts only an explicitly enrolled,
uncompressed native rollout below the verified Codex profile's `sessions`
directory. It never lists that directory or discovers neighboring sessions.
Before enrollment, a bounded first-line read (at most 64 KiB) validates the
`session_meta` record: native session identity, canonical project `cwd`, CLI
version syntax, and absent/legacy history mode. The per-session transport,
owner-confirmed enrollment and one-use PreToolUse invocation remain required.
A Codex lookup leaves native permission decisions to Codex; the lookup adds no
prompt or permission grant. King/BLUN cannot reuse this adapter through its
Codex-compatible instruction hierarchy.

Only native `response_item` tool outputs (`function_call_output`,
`custom_tool_call_output`, `mcp_tool_call_output`) become historical result
candidates. User and assistant messages do not. Results include timestamp,
content digest, stable session/message references, native `call_id`, and a
bounded original excerpt. They remain **untrusted historical context**, never
current test verification, completion evidence or a learning authorization.
Structured facts and corrections remain in the separate structured knowledge
view; raw transcripts are not copied there. Conflicting historical outcomes
are retained rather than combined into a new claim.

The search ranks the existing bounded index before opening one selected source.
Sources must match the same host, project, tenant, user and task; groups,
unregistered private files, symlink escapes and modified snapshots are excluded.
A source change makes the snapshot unavailable, including after restart. No
automatic enrollment refresh, receipt reset or retry follows. Missing history
must be stated honestly while ordinary authorized work remains possible.

Unsupported: compressed, paginated or inherited/forked history; unknown record
or explicit schema versions; automatic import of a real user's sessions.
`cli_version` is header provenance, not proof that every version of a
Codex installation is compatible. The supported structural contract is pinned
below. A changed host format requires a reviewed adapter and fresh synthetic
acceptance, not unchecked migration. No Otto/Fredrik live acceptance is implied.

### Primary source provenance

Inspected 2026-09-06: official [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
provides `session_id` and optional `transcript_path`, and explicitly states that
the transcript format is not a stable interface. The adapter was independently
implemented against [openai/codex commit 6af345407d9c2a568da9d01b6c4b81a9e61495c0](https://github.com/openai/codex/tree/6af345407d9c2a568da9d01b6c4b81a9e61495c0),
Apache-2.0: `codex-rs/rollout/src/lib.rs`,
`codex-rs/history/src/rollout_payload.rs`, and the protocol definitions
`protocol.rs` / `models.rs`. That source workspace reports `0.0.0`; it is not an
installed release-version claim. External sources supplied format evidence
only; no implementation was copied or executed.

Synthetic acceptance exercises native hooks and restarted MCP processes:
session A stores a measured failure, session B retrieves its exact source after
compaction, replay/races admit only one invocation, and foreign scope, changed
sources, model claims, secret-bearing outputs and unknown formats yield no
verified historical result. Fixtures create their own profiles and sessions.

## King native agent-wire contract

The `king-agent-wire-jsonl/v1` adapter is separate from both Claude and Codex.
King may use the Codex-compatible `AGENTS.md` hierarchy for project rules, but
that does not turn its history into a Codex rollout. The verified King lifecycle
keeps the runtime host identity as `codex` while binding timeline records to the
distinct `king` provider.

King history is never discovered automatically. The trusted local launcher must
provide both `AGENTSPINE_KING_TIMELINE_SOURCE`, pointing to the current
`sessions/.../session_<id>/agents/main/wire.jsonl`, and
`AGENTSPINE_KING_WIRE_PROTOCOL_VERSION`, matching that file's metadata header.
The source must remain below the canonical non-symlinked `BLUN_HOME/sessions`
root. A prompt, model response, MCP argument, remembered fact, or filename alone
cannot create this mapping. Missing mappings leave history unavailable without
blocking ordinary host-authorized work.

Enrollment reads only the bounded first record. It requires the exact metadata
shape and configured `protocol_version`, a positive integer creation time, and
the current session directory. Indexing accepts only the reviewed King record
types and extracts objective evidence solely from
`context.append_loop_event` records whose event is `tool.result`. User and
assistant messages, model claims, unknown records, unknown schema versions, and
non-text tool outputs create no evidence card. The native `toolCallId` becomes
the stable message reference; the record time remains the source timestamp.

King keeps its own permission decisions. AgentSpine only binds a one-use,
context-only lookup to the current verified gateway, transport, source, and
scope. Restart and compaction reuse signed sidecar metadata, then revalidate the
unchanged original source before any selected line is opened. A protocol change,
source mutation, replay, foreign project or tenant, group context, or unknown
record makes recall unavailable and never triggers a retry or enrollment reset.

### Primary source provenance

Inspected 2026-09-06: [BLUN Code commit fbb97459a3fa2157f8bfea3d24931be63288ab11](https://github.com/Maykbiletti/blun-code/tree/fbb97459a3fa2157f8bfea3d24931be63288ab11),
application version `1.0.109`, MIT. Its public verification fixture locates the
main agent wire at `sessions/.../session_<id>/agents/main/wire.jsonl` and reads
`context.append_loop_event` / `tool.result`; the vendored King runtime type
surface identifies the reviewed record union and metadata fields. The vendored
`@blun/king-sdk` contract is version `0.12.1`, MIT. External files were treated
as untrusted format evidence; no implementation was copied or executed.

Synthetic repository acceptance proves A-to-B recall of one measured `FAIL
0/15` result after restart and compaction, with immutable source bytes and
stable session/message references. It also covers exact gateway binding,
wrong protocol, wrong path/scope/provider, replay/race, mutation, and unknown
records. This does not prove Fredrik's installed launcher supplies these two
protected mappings, that King enforces a returned block decision, or that a
live session passed. Those remain separate live-host checks.
