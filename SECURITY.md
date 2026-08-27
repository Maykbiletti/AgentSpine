# Security policy

## Supported versions

AgentSpine is pre-1.0. Security fixes are applied to the latest release on `main`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include private agent files, memory, relationship data, credentials, or real user identities in a report.

Use GitHub's private vulnerability reporting for this repository. Include the affected version, host, minimal reproduction, expected boundary, and observed impact. Replace real context files with synthetic fixtures.

## Security model

AgentSpine treats every discovered document, memory fact, graph edge, and retrieved value as untrusted context. None of them can grant permissions. Host policy and explicit approval remain authoritative.

Lifecycle hooks are defense in depth, not an operating-system sandbox. Users should still review plugin code, restrict tool access, protect credentials, and use host approval controls.
