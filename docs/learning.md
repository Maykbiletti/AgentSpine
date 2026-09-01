# Safe learning

AgentSpine separates an observation from a fact that may enter future context. An agent can propose a candidate and append evidence, but the candidate remains invisible to `learning_context` until it passes an explicit review or the narrowly scoped, default-off automatic policy. Version 0.11 adds an outcome-bound path for low-risk behavior: a lesson is useful only when fixed, externally measured tasks improve after a limited canary application.

```mermaid
flowchart LR
    O["Observation"] --> C["Candidate"]
    C --> E["Append-only evidence"]
    E --> R{"Review gate"}
    R -->|"explicit user confirmation"| A["Accepted context"]
    R -->|"reject"| X["Rejected history"]
    R -->|"opt-in fact policy"| A
    E --> M["Independent before receipts"]
    M --> K["Scoped canary"]
    K --> P["Consumed-turn application receipts"]
    P --> N["Independent bound after receipts"]
    N -->|"measured improvement"| A
    N -->|"regression or blocking defect"| B["Automatic rollback"]
    A --> S["Supersede without erasing"]
    S --> B["Rollback restores prior fact"]
```

## Candidate kinds

| Kind | Normal review path | Automatic eligibility |
|---|---|---|
| `preference` | Explicit confirmation | Never |
| `no-go` | Explicit confirmation | Never |
| `goal` | Explicit confirmation | Never |
| `correction` | Explicit confirmation | Never |
| `personal-fact` | Explicit confirmation | Never |
| `project-fact` | Explicit confirmation | Opt-in, evidence-gated |
| `reference` | Explicit confirmation | Opt-in, evidence-gated |
| `behavior` | Explicit confirmation | Opt-in, outcome-gated canary |

Every candidate and evidence record carries `authority: context-only`. Accepted learning can improve relevance and consistency, but it cannot grant permissions, delegation, production access, spending rights, policy exceptions, or instructions to act.

## Evidence and provenance

Evidence is append-only while a candidate is awaiting review. Supported evidence types are `user-statement`, `document`, `interaction`, and `test`. Document evidence must reference a discovered Markdown source; AgentSpine records that source's SHA-256 at observation time without editing it.

Adding evidence stores the previous candidate version in history before recalculating confidence. Distinct evidence IDs or source fingerprints are counted for automatic evaluation. Secret-shaped content is rejected before it reaches learning state.

## Explicit review

Acceptance requires the `confirmedByUser` marker and a review reason. The marker is an integration attestation, not identity proof: a host adapter should set it only after an actual user gesture or unambiguous user instruction. AgentSpine never infers confirmation from another memory, Markdown sentence, candidate, agent message, or relationship edge.

```bash
agentspine learn-propose learning:concise \
  --kind preference \
  --claim "The preferred output is concise." \
  --evidence "The user explicitly requested concise output." \
  --privacy private

agentspine learn-review learning:concise \
  --decision accept \
  --reason "Explicitly confirmed by the user." \
  --confirmed-by-user

agentspine learn-context . --include-private --json
```

Candidates never appear in learned context before acceptance. Native lifecycle hooks inject only accepted, exactly scoped learning inside the byte-budgeted session briefing. They never inject unreviewed candidates.

## Optional automatic promotion

Automatic promotion is disabled by default. When deliberately enabled, it applies only to `project-fact` and `reference`, and only when both confidence and distinct-evidence thresholds pass.

```bash
agentspine learn-config . \
  --auto-promote true \
  --min-confidence 0.9 \
  --min-evidence 2

agentspine learn-evaluate . --json
```

The accepted record stores the policy thresholds, evidence count, and evaluation time used for that decision. The audit rejects an accepted record with no valid manual-review proof or automatic-promotion snapshot. Personal facts, preferences, goals, corrections, and no-gos are never automatically promoted by this general evaluator.

This evaluator is separate from [automatic continuity](automatic-continuity.md). After its own local privacy opt-in, the lifecycle adapter may accept only direct, high-confidence style preferences, no-gos, corrections, project facts, and references with a recorded threshold proof. Personal facts, group conversation content, identity claims, secrets, authority, access, and operational permissions are never eligible. The continuity path is not exposed through MCP.

## Measured behavior loop

`behavior` candidates use content-free `agentspine.learning-outcome/v2` receipts while existing v1 history remains readable. A receipt stores no prompt, answer, transcript, credential, or source content. It binds a normalized metric to one exact persona, user, tenant, project, group, task, evaluator, phase, and time. Metric values are normalized to `0..1`; the direction states whether higher or lower is better. Objective measurements, explicit user feedback, and model suggestions remain separate. Model suggestions are retained for diagnosis but never count toward automatic promotion or validation.

Before promotion, the candidate needs the configured number of independent, fresh, non-model receipts for the same metric and exact scope, including at least one objective evaluator. It also needs the normal distinct-evidence and confidence thresholds. A conflicting active candidate blocks automatic promotion. Security, safety, identity, authentication, authorization, credential, policy, production, deployment, payment, and access lessons are marked for local review and can never enter this automatic path. Successful evaluation creates a time-limited canary rather than a final unmeasured claim. Only that exact scope receives the canary in its next briefing. After the hard preflight receipt has been consumed, the installed hook records one `agentspine.learning-application/v1` receipt for each Canary it actually projected. The application binds the learning ID and exact scope to the signed preflight receipt, prompt digest and briefing digests. It contains no prompt or briefing content. A failed application write removes that Canary from the delivered learning packet and reports a degraded application status.

```bash
agentspine learn-propose learning:check-invariant \
  --kind behavior \
  --claim "Check the fixed invariant before answering." \
  --evidence "Two fixture runs missed the invariant." \
  --privacy shared \
  --persona agent:synthetic --user user:synthetic --tenant tenant:synthetic \
  --project project:synthetic --task task:synthetic

agentspine learn-outcome learning:check-invariant \
  --phase before --metric fixed-task-success --direction higher --value 0.40 \
  --measurement objective --evaluator evaluator:test-a \
  --persona agent:synthetic --user user:synthetic --tenant tenant:synthetic \
  --project project:synthetic --task task:synthetic

agentspine learn-evaluate . --json
agentspine learn-status . --json
```

After canary use, `agentspine learn-status` reports `latestApplicationId`. The local outcome evaluator must bind its `after` receipt to that actual application:

```bash
agentspine learn-outcome learning:check-invariant \
  --phase after --application application:synthetic-turn-receipt \
  --metric fixed-task-success --direction higher --value 0.75 \
  --measurement objective --evaluator evaluator:test-b \
  --persona agent:synthetic --user user:synthetic --tenant tenant:synthetic \
  --project project:synthetic --task task:synthetic
```

An unbound, stale, cross-scope or forged application ID is rejected. Independent receipts meeting `minImprovement` validate the lesson only when they also reference distinct applied turns; two evaluators of one turn cannot simulate two applications. Any blocking defect rolls it back immediately; a regression beyond `regressionTolerance`, insufficient measured improvement, or expiry before validation also rolls it back. A superseded lesson is restored atomically. No average score can override a blocking defect.

Outcome recording and policy changes are local CLI/runtime operations. MCP exposes only the read-only `learning_outcome_status` view for this loop; model-side MCP cannot manufacture application or outcome evidence. Doctor distinguishes awaiting applications, bound measurements, legacy unbound measurements and stale canaries. The audit replays application digests, exact scopes, authority boundaries and v2 outcome bindings. `learning_context` returns only active, unexpired or validated, exact-scope behavior lessons and reports stale canaries as degraded instead of silently projecting them.

## Supersession and rollback

New information does not overwrite an accepted fact. Propose a new candidate with `--supersedes` and the same kind, subject, and privacy scope. Acceptance marks the prior record `superseded` and retains both versions. Rollback deactivates the replacement and restores the prior accepted record atomically.

```bash
agentspine learn-propose learning:new-goal \
  --kind goal \
  --claim "The current goal is the new synthetic milestone." \
  --evidence "The user changed the goal." \
  --supersedes learning:old-goal

agentspine learn-rollback learning:new-goal \
  --reason "The change was recorded incorrectly."
```

Permanent deletion removes one candidate and its learning history. An accepted superseding record must be rolled back before deletion so its predecessor is not stranded.

## Privacy and groups

Private learning requires an explicit `includePrivate` read. Group learning requires a known group entity, an exact `groupId`, and—when a subject is present—a visible `member-of` edge. `includePrivate` does not bypass a different or missing group audience. Session hooks have no group audience and therefore expose no group learning.

## Storage and concurrency

`learning.json` lives in the same external per-project state directory as the catalog, graph, and attention state. Mutations use a per-project lock and atomic replacement, so concurrent agents cannot silently discard evidence. Application IDs are deterministic per learning/preflight/briefing binding, making crash retries idempotent; conflicting reuse fails closed. State is capped at 5 MiB and original Markdown remains byte-for-byte unchanged.
