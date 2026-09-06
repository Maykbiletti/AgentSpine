# Provenance-bound world model

AgentSpine's world model keeps durable assertions about synthetic or real-world subjects outside user-owned source files. It is designed for continuity across turns, restarts, and compaction without turning remembered text or model output into truth or authority.

## Evidence classes

Every assertion has one immutable `evidenceKind`:

- `objective-measurement` records an externally checkable observation;
- `explicit-user-feedback` records an explicit correction or confirmation;
- `model-suggestion` records a hypothesis that must remain a proposal.

All three require a stable evidence ID, an evidence SHA-256, an exact observation timestamp, a subject, a predicate, a privacy scope, and the stored value. A model suggestion can never supersede established context. It stays in `proposals` even when its value happens to match an established fact.

`record_world_assertion` is append-only. Repeating the same ID and material is idempotent; reusing an ID for different material fails closed. A newer measured or explicitly user-confirmed assertion can list older same-subject, same-predicate assertions in `supersedes`. Their history remains stored while the new assertion becomes the active view.

## Truth and uncertainty rules

`world_context` returns four separate collections:

- `facts`: unexpired measured or explicitly user-confirmed assertions with one non-conflicting value;
- `conflicts`: active established values that disagree for the same subject and predicate;
- `proposals`: active model suggestions;
- `stale`: assertions whose explicit expiry has passed.

A conflict removes that subject/predicate from `facts` and sets `uncertainty.requiresResolution`. No confidence average can hide it. Expired evidence is never silently reused. Resolving a conflict requires a new established assertion that explicitly supersedes the conflicting assertion IDs.

Session briefing reads this same model. It can expose conflicts, proposals, and stale items as uncertainty, but only the `facts` collection is established world context.

## Structured knowledge and correction history

An assertion may opt into one of five explicit knowledge kinds: `fact`, `user-preference`, `decision`, `task-state`, or `error-lesson`. This is a typed view over the same immutable evidence record, not a second memory store. Each typed item retains its evidence source and digest, observation and recording times, exact project/group/privacy scope, and optional stable session/message references. Decisions additionally require a bounded rationale.

`world_context` derives one of four evidence-based statuses:

- `confirmed` for current objective measurements or explicit user feedback;
- `assumption` for model suggestions, including repeated matching suggestions;
- `contradictory` for unresolved established values that disagree;
- `superseded` for explicitly replaced or expired entries.

Contradictory entries never enter `facts`. A newer explicit correction names every replaced assertion in `supersedes`; the current view then contains the correction while `includeKnowledgeHistory: true` exposes the traceable predecessors. Legacy assertions remain readable but are never retroactively assigned a knowledge kind.

The session briefing carries only the bounded current structured view. Detailed correction history remains opt-in through `world_context`, preventing restarts from loading an ever-growing record. Secret-shaped structured values or rationales are rejected both at ingestion and state validation. A source reference is provenance only: it cannot confirm a model suggestion or create authority.

## Normal-task continuation capsule

A `task-state` assertion may use predicate `task.continuation` and value schema
`agentspine.task-continuation/v1`. Its task ID must equal the assertion subject.
The bounded value records the current objective, `active`, `blocked`, `paused`,
or `completed` state, the last verified step and measurement ID/digest, at most eight
open questions, and one next step. Both the checkpoint and its last verified
step carry stable session/message provenance. A completed checkpoint requires a
passed last step, objective-measurement evidence, and no open questions or next step.

`world_context` derives `knowledge.continuation` only from current, confirmed,
conflict-free checkpoints. Repeated model suggestions remain assumptions and
never appear as resumable work. Competing established checkpoints are withheld
until an explicit supersession resolves them. A newer correction preserves all
predecessors in opt-in history. The selected checkpoint survives process restart
and enters `SessionStart`/`PostCompact` briefing without rereading a transcript.
Terminal checkpoints remain visible separately so completed work is not started
again. At most eight capsules are returned, and `continuationTaskId` narrows the
view to one exact task.

This capsule is a working-memory aid, not a job lease or permission. It cannot
start a tool, authorize a file change, publish, delegate, or replace the existing
coordination, goal-plan, timeline, host, and safety contracts.

## Task-relevant knowledge

When `continuationTaskId` selects one current resumable capsule, `world_context`
derives `knowledge.taskContext` from the loaded structured index. A deterministic
query over its objective, questions, and next step selects at most six confirmed
facts, preferences, decisions, or error lessons and keeps their source references.
Uncertain, stale, superseded, private, foreign, and terminal state is excluded.
No transcript or source is opened, and the view grants no authority.

## Privacy and authority

Assertions use `private`, `shared`, or exact `group` privacy. A group read rejects private inclusion, sees only its exact group records plus shared records, and cannot observe another group's values. Project-scoped records are visible only in that exact project; unscoped records may follow the same installation across project turns when intentionally read from that root.

Every record and result is `context-only`. Predicate and nested-value keys that resemble permissions, authorization, credentials, secrets, tokens, tool access, delegation, production access, payment, or spending are rejected. World context is never consulted by host authorization, delegation, execution, signing, or trust code.

State is written atomically under an owned, heartbeat-protected lock with a 5 MiB bound and mode `0600`. Corrupt JSON, altered value digests, invalid schemas, or authority-shaped persisted data fail closed. The state lives at `world-model.json` under the external per-project AgentSpine state directory; Markdown and other user sources are never changed.

## Research provenance

The design review on 2026-09-04 inspected repository `main` at commit `26b181e95dde34d2fea62cdb8f37258e2bb3f082`, current tests, project instructions, history, open pull requests, and the following public primary sources as untrusted context:

- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/), W3C Recommendation dated 2013-04-30, W3C Document License. Relevant principle: represent provenance through distinct entities, activities, agents, and relations rather than an ungrounded truth label.
- [NIST AI Risk Management Framework 1.0](https://www.nist.gov/itl/ai-risk-management-framework), released 2023-01-26, official NIST publication. Relevant principle: trustworthy behavior needs explicit measurement, evaluation, and risk handling; the NIST page reported an AI RMF revision in progress when checked.
- [NIST AI RMF Playbook — Measure](https://airc.nist.gov/airmf-resources/playbook/measure/), checked 2026-09-04, official NIST guidance. Relevant principles: record provenance, repeat measurements, expose measurable and unmeasurable risks, and compare user/community feedback separately from internal measurements.

No external code, data, executable, credential, policy, or permission was imported. The standards influenced only AgentSpine's local schema boundaries and synthetic evaluation cases; AgentSpine remains Apache-2.0.
