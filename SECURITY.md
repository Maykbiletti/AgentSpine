# Security policy

## Supported versions

AgentSpine is pre-1.0. Security fixes are applied to the latest release on `main`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include private agent files, memory, relationship data, credentials, or real user identities in a report.

Use GitHub's private vulnerability reporting for this repository. Include the affected version, host, minimal reproduction, expected boundary, and observed impact. Replace real context files with synthetic fixtures.

## Security model

AgentSpine treats every discovered document, memory fact, graph edge, and retrieved value as untrusted context. None of them can grant permissions. Host policy and explicit approval remain authoritative.

Relationship entities reject authority and secret-bearing field names recursively. This is a guardrail against accidental storage, not a secrets scanner: do not place credentials or sensitive content in relationship attributes, reasons, fixture files, or bug reports.

Attention cues are untrusted suggestions and never trigger messages, tool calls, task assignment, or notifications by themselves. Automatic lifecycle context contains only counts and cue kinds. Reading private cue text requires an explicit private-context request; group cues require an exact known group audience. Focus mode, quiet hours, throttling, disable, and permanent deletion are enforced in local state. Do not store secrets in cue summaries.

Learning candidates are untrusted observations and remain outside learned context until review. Secret-shaped values and common authority assertions are rejected before storage as defense in depth; host permissions remain the only authority regardless of wording or language. Manual acceptance carries a `confirmedByUser` integration attestation, which host adapters must bind to a genuine user action. Automatic promotion is disabled by default, never applies to personal facts, preferences, goals, corrections, or no-gos, and cannot perform code, network, deployment, billing, or permission changes.

Lifecycle hooks cover participating direct-write tools and common shell mutation forms. They are defense in depth, not a shell parser or operating-system sandbox. Encoded commands, custom tools, subprocesses, or programs outside the host can bypass them. Users should review plugin code, restrict tool access, protect credentials, use version control, and keep host approval controls enabled.
