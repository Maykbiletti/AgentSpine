# Objective artifact evaluation

The learning ledger already validates external measurement bindings. It does not
execute the benchmark or prove that caller-supplied scores describe a real task.
`learn-artifact-measure` adds a narrow local evaluator: it reads explicitly named
project files, checks their SHA-256 digests or absence, computes the pass rate and
blocking-defect count itself, and registers the result through the existing
measurement API. It never executes commands, discovers files or calls a provider.

## Precommit the experiment

Prepare an `agentspine.artifact-checks/v1` specification with one to sixteen checks:

```json
{
  "schema": "agentspine.artifact-checks/v1",
  "checks": [
    {"path": "artifacts/unwanted.txt", "sha256": null, "blocking": true}
  ]
}
```

`null` means the file must be absent. A SHA-256 means the regular file must have
exactly that content. `blocking` is explicit for every check; any failed blocking
check is counted separately and cannot be averaged away. File contents are never
included in the report. Only paths, digests, byte counts and result flags appear.

Run `agentspine learn-artifact-plan --checks '<JSON>' --json` before the experiment.
The result supplies `datasetDigest`, `protocolDigest`, `minCases`, the fixed metric
`artifact-check-pass-rate` / `higher`, and `principalDigest`. Use these with the
existing locally confirmed evaluator and evaluation registration commands. The
task digest still belongs to the externally declared task. The plan command does
not register anything or supply authority.

One implementation has one fixed principal digest across every name, project and
specification. Two aliases of this evaluator cannot satisfy the existing distinct
principal requirement. Another independently registered evaluator is still needed
for a complete learning experiment; assigning a second name is insufficient.
The principal is an implementation identifier, not a signature or proof of an
independent organization.

## Measure, then consume through the existing contract

Use `learn-artifact-measure <measurement-id>` with `--root`, `--checks`, `--learning`,
`--evaluation`, `--phase before|after`, `--evaluator`, the precommitted `--run`, exact
`--persona`, `--user`, `--tenant`, `--project`, optional `--task` / `--group`,
`--confirm-local-measurement` and `--json`. The root must be canonical. This is a
local runtime/CLI operation, not an MCP tool or new host permission.

The evaluator accepts neither a model score nor a model claim of having loaded or
verified data. It validates the frozen specification, protocol, case count, metric,
principal and exact scope before target reads. The ordinary measurement writer
rechecks lifecycle, registry, expiry, immutable cohort, delivery and replay bindings
at commit. After measurements require the existing prompt-bound application and
Stop-bound delivery. Missing binding remains unverified, without creating an
automatic retry or blocking normal host work.

Each explicit file is limited to 2 MiB and checked using the existing parent/path
and source-byte reader. The whole bounded cohort is read twice; observed drift,
symlinks, path escapes, oversized files and read errors abort without registering a
partial score. This is a bounded point-in-time observation, not a filesystem-wide
transaction or proof that no change ever happened between reads. No source is
written. The final measurement uses the existing atomic ledger and replay lineage;
crash before registration leaves no successful measurement, crash afterward cannot
permit a replacement run. Initial-trial deadlines remain unchanged.

Capture the returned `report` with external experiment records: its JSON digest is
the receipt's `measurement.sourceDigest`. The normal ledger stores the metric and
digest, not a new transcript or artifact database. Repeated/concurrent measurements
cannot replace the first committed trial. Revalidation and arbitrary evaluator
programs remain on the existing external measurement path, not this adapter.

The returned `completionVerified: false` and `automaticRetry: false` distinguish a
file-state measurement from a verified delivery. Use existing `learn-outcome` to
consume the receipt with its application/delivery bindings. Existing promotion,
canary validation, supersession, revocation and rollback rules are unchanged.

## Scope of the comparison

The isolated archive task really creates a migrated artifact. Without the selected
backup strategy, two of three predefined file checks pass. After bounded learned
context is selected and the synthetic worker creates the backup, three of three
pass. A separate byte-comparison fixture supplies the other synthetic evaluator;
both outcomes are computed from files rather than fixed score constants. Fresh
CLI-process measurement, real Claude/Codex prompt and Stop hooks, compaction,
scope/criteria/principal rejection, concurrency, replay and a blocking-defect
rollback are covered by `test/learning-artifact-evaluator.test.js`.

This proves the local artifact-to-learning connection for a deterministic synthetic
worker, not improved LLM reasoning, genuine provider execution, independent AGI
evaluation or Otto/Fredrik live acceptance. Runtime and inspected bytes are reported;
tokens and unnecessary questions are not measured by this evaluator. It creates no
live installation, host configuration, production action or new authority.
