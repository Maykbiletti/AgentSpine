# Pre-answer recall gate

AgentSpine 0.9 adds `agentspine.preflight/v2`, a provider-neutral pre-answer contract. On `UserPromptSubmit`, the lifecycle adapter resolves and race-safely rereads the active host instruction hierarchy, loads confirmed Must-Remember context, runs every locally required retrieval provider, creates a short-lived HMAC receipt bound to the exact turn, consumes it once, and only then injects the resulting context. The model does not call MCP for any part of this path.

The receipt binds agent and optional persona, user, tenant, host, instruction host, profile, session, project, task, group, working-directory digest, hook delivery, prompt digest, every mandatory instruction file and file identity, the current local policy revision and profile digest, active Must-Remember checksums, provider query status, loaded item IDs and revisions, rejection count, briefing digest, creation time, and expiry. A different prompt, session, scope, working directory, source set, policy, critical-memory revision, hook delivery, or second consumption is rejected. Receipts contain no prompt text, source content, retrieval claims, credentials, or full transcripts.

## Host instructions

Claude Code uses its resolved user and project `CLAUDE.md` hierarchy. Codex uses the corresponding `AGENTS.override.md`/`AGENTS.md` hierarchy. A generic host must explicitly bind `instruction_host` to `claude` or `codex`; AgentSpine does not guess. The mandatory preflight section contains the complete bytes of every active instruction document and has an independent hard budget. An unreadable, replaced, deleted, oversized, out-of-scope, or symlinked mandatory file blocks the turn instead of degrading to a descriptor.

Claude Code's `InstructionsLoaded` lifecycle event is registered as an additional observability signal, while `UserPromptSubmit` remains the blocking and injection boundary. Codex uses its own manifest-selected hook set without that unsupported Claude-only event. The preflight does not rely on the model remembering to read a file or call a tool.

## Required retrieval providers

Retrieval policy is a separate local policy file outside every project. Configure it only through the local CLI:

```bash
agentspine preflight-policy ./dieter-preflight.json --confirm-local-policy
agentspine preflight-status --json
```

The initial reference adapter is `mnemo-command/v1`: an absolute, regular executable receives one `agentspine.retrieval-query/v1` JSON object on stdin and must return one `agentspine.retrieval-result/v1` object on stdout. It may talk to a local or remote Mnemo deployment. Credentials are passed only through environment-variable names explicitly listed in local policy; values never enter repository files, state, context, receipts, logs, or MCP. Required providers must be fail-closed. A successful query with no matches produces status `empty`; a missing invocation, timeout, invalid scope, malformed response, or adapter failure blocks the turn.

Example local policy profile:

```json
{
  "id": "preflight-policy:dieter:claude",
  "agentId": "agent:dieter",
  "host": "claude",
  "profileId": "profile:dieter",
  "tenantId": "tenant:company",
  "enabled": true,
  "providers": [
    {
      "schema": "agentspine.retrieval-provider/v1",
      "id": "mnemo:primary",
      "adapter": "mnemo-command/v1",
      "required": true,
      "failClosed": true,
      "timeoutMs": 5000,
      "command": "/absolute/path/to/mnemo-adapter",
      "args": [],
      "credentialEnv": ["MNEMO_TOKEN"]
    }
  ]
}
```

Policy, identity and authorization remain independent. Prompt, Markdown, memory, persona, team metadata and provider output cannot configure a provider, relax fail-closed behavior, grant a capability, or authorize an action.

## Must-Remember

Conversation wording such as “Merk dir das” may create only a pending candidate. Activation requires a separate explicit local user confirmation:

```bash
agentspine remember-propose --claim "Keine halbfertigen Commits veröffentlichen." --user person:papa --tenant tenant:company --project project:agent-spine
agentspine remember-confirm remember-candidate:… --confirm-local-user
```

Confirmed entries are scoped, checksummed, append-only and versioned. A new version supersedes rather than overwrites; rollback is explicit. Permanent deletion requires `remember-purge … --confirm-local-purge`. Secret-shaped and authority-shaped claims are rejected. Must-Remember remains context-only.

## Enforcement modes and host limits

`preflight-status` and Doctor distinguish `instructions-only-no-required-provider`, `wrapper-hard-required`, the last provider result (`loaded`, verified `empty`, or failure), a consumed receipt, and a blocked turn with a privacy-safe failure code. Host inventory reports hook trust as unverified until the real host confirms it. The bundled command hook returns the documented blocking status and exit code 2 for controlled failures. Host trust remains a one-time user decision. A prepared turn that aborts before model injection is invalidated and may retry; a consumed delivery remains replay-blocked.

Claude Code documents that a command hook killed by the host timeout is fail-open, even though an explicit exit code 2 blocks. Therefore an absolute guarantee against process termination requires the host or TUI to invoke the same preflight contract as a wrapper-hard gate immediately before its model API call. AgentSpine does not mislabel a merely installed command hook as proof against host-enforced timeout. A release is only live-proven after the target host shows fresh consumed receipts across consecutive turns, restart, and compaction.

Host hierarchy and lifecycle behavior were checked on 2026-08-30 against the official [Claude Code hook reference](https://code.claude.com/docs/en/hooks) and [Codex AGENTS.md reference](https://developers.openai.com/codex/agent-configuration/agents-md).
