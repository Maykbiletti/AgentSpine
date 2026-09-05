# Structured delivery completion

AgentSpine 0.72.4 adds `complete_delivery` for ordinary assignment-bound writing deliveries. Version 0.72.5 requires the actual test process result: structured exit code zero or the existing command-bound final marker. Transport success, a still-running process and prose output are not test evidence. An agent can store its three completed premortem checks through MCP and then give the user a normal summary. The operation does not execute a test, create host identity, authorize a write, consume the assignment or bypass Stop.

## Call sequence

1. Obtain the hook-issued assignment and requirement. Call `session_briefing`, `delivery_knowledge_query` and `record_delivery_premortem` before the first write.
2. Make the changes through the host. Run a recognized test after the latest write. AgentSpine must have observed successful execution through the tool hook; a model-provided success flag is not evidence.
3. Call `complete_delivery` with the exact root, requirement ID, complete binding, registered artifact digest, latest write digest and three checks. Use the returned identifiers, never identifiers copied from another delivery.
4. Report the result normally. Stop independently rechecks observed tests, pending writes, scope, mandatory calls, closure integrity and the existing safety gates.

The arguments have this shape; replace placeholders with actual bound values:

```json
{
  "root": "/synthetic/project",
  "requirementId": "<hook-issued requirement ID>",
  "binding": {
    "host": "codex",
    "sessionId": "session:synthetic",
    "projectId": "project:synthetic",
    "assignmentId": "<hook-issued assignment ID>"
  },
  "artifactDigest": "<registered SHA-256>",
  "lastWriteDigest": "<latest write SHA-256>",
  "checks": [
    { "category": "baseline-environment", "checkId": "<registered check ID>", "status": "PASS", "result": "Source comparison passed." },
    { "category": "contract-tests", "checkId": "<registered check ID>", "status": "PASS", "result": "Observed artifact test passed." },
    { "category": "delivery-path", "checkId": "<registered check ID>", "status": "PASS", "result": "Delivered tree matches the tested tree." }
  ]
}
```

Include established entity, group and task fields exactly. Results must be nonempty single-line text, at most 1,024 characters, without secret-shaped content. There must be one check per registered category. These descriptions are the agent's auditable account, not an independent measurement; the server separately requires observed successful post-write tests. Extra arguments such as `success` or a caller-supplied `testStateDigest` are rejected.

## Preservation and concurrency

The existing closure and event journal gain sealed `completionSource: "mcp"` and `testStateDigest` metadata capturing the observed verification state. Existing registrations, rejection receipts and previous-version records are not migrated or rewritten. Stop checks current evidence rather than trusting an old success forever.

Identical retries return the stored closure. Changes to test evidence during the call cannot return successful completion. A later write invalidates the closure and requires fresh tests and its new write digest. A later failed or unverified test invalidates earlier successful verification. Changed check results conflict with an existing closure instead of overwriting history. Foreign bindings and consumed receipts cannot complete another assignment.

The existing atomic replacement and owned lock protect storage. A regression terminates the real MCP process immediately before replacement, verifies unchanged state bytes, waits for the actual lock lease and retries through MCP. It never edits state or lock timestamps to recover.

## Boundaries and measured evidence

Goal- or queue-bound deliveries must use their existing checkpoint and outcome route. `complete_delivery` explicitly rejects them; goal protections are unchanged. The legacy five-line closure remains supported. Skill text does not register tools, and an isolated server test does not establish native Codex, Claude or Kimi compatibility.

Run `node --test test/delivery-completion.test.js test/assignment-continuation.test.js test/delivery-verification.test.js test/mcp.test.js`.

Before the MCP call, a normal Stop summary is blocked for missing check references. Afterwards the same summary succeeds, including after a separate MCP process restart. Negative probes cover absent tests, later failed tests, new writes, foreign bindings, replay, malformed checks, secret-shaped values, concurrent calls and manipulated closure metadata. Synthetic source bytes remain unchanged.

Child tests clear inherited `NODE_TEST_CONTEXT` and require TAP evidence of one executed test and zero failures. An actual wrong artifact expectation must produce one failed test and exit 1. This corrects a 0.72.3 test-harness weakness: a recursive child test runner could skip its test while returning exit 0. Earlier positive exit status alone is not counted as proof that the artifact assertion ran.

Version 0.72.5 exercises the official Codex `PostToolUse` fields (`Bash`, `tool_input.command`, `tool_response`), the measured Work `exec_command` result and PowerShell `exitCode`. This establishes the parser contract but not a live Otto restart or installed-reader migration. Native installation/update registration, loaded-reader compatibility, external recovery-event semantics and the live F79 task remain unverified. CodexLink and live session configuration are outside this change.

CI 147's Windows aggregate audit failure was not reproduced by the diagnostic branch's ten passing matrix jobs. The assertion now reports failed gates without relaxing it or changing deadlines. Passing a later run does not establish that intermittent failure's cause.

The first completion candidate exceeded the unchanged mandatory hook-context budget on long macOS and Windows paths. CI 150's diagnostic traced the apparent style rejection to that earlier preflight block. A synthetic 138-byte temporary-root probe reproduces the failure locally. Compact guidance retains every mandatory call, binding, check and legacy closure field, while the long-path Acceptance probe now passes without raising the injection limit or shortening user sources.
