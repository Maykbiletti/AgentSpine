# Durable gateway worker

AgentSpine `0.8.0` includes an optional long-running worker that closes the gap between a channel message and an actual Claude Code or Codex run. While the worker is running, it polls configured Telegram accounts, authenticates every accepted update against an exact local channel binding, starts one leased agent lane, and delivers one idempotent reply to the original chat, topic, and message.

The worker is not exposed through MCP and is never started by remembered text. Its policy defaults to disabled; the owner enables it once with `agentspine gateway-control /path/to/project --enabled true --confirm-local-gateway`. An operating-system service manager may then supervise it after the owner configures its environment and command line.

## Automatic persona roster

Set `AGENTSPINE_PERSONA_ROSTER_FILE` or pass `--persona-roster` to the worker. The path must be absolute, point to a regular non-symlink JSON file outside the agent project, and remain below 1 MiB. The file uses this envelope:

```json
{
  "schema": "agentspine.persona-roster/v1",
  "revision": 1,
  "observedAt": "2032-01-01T00:00:00.000Z",
  "bindings": [
    {
      "id": "persona-binding:franz",
      "authenticator": "host-manifest",
      "issuer": "host:local",
      "tenantId": "tenant:blun",
      "host": "codex",
      "profileId": "profile:franz",
      "subjectId": "subject:franz",
      "kind": "agent",
      "displayName": "Franz",
      "sourceBinding": ".codex/agents/franz.md",
      "groupId": "group:engineering"
    }
  ]
}
```

Every tick synchronizes authenticated identities before any work is reconciled. New bindings append `join` events; renames retain the stable persona ID; omitted members in the same explicit roster scope become `left`; `"deactivated": true` records a distinct deactivation; reappearance appends `rejoin`. A binding may describe a `person`, `agent`, or `bot`; equal display names never merge identities. Names, Markdown, memory, and chat text cannot create identity or rights. Existing source files are never changed.

Version `0.10.0` reconciles the authenticated roster into the relationship graph on every sync, including an otherwise unchanged replay. An exact `groupId` creates a missing group-scoped, context-only group entity; a conflicting non-group or private group fails visibly. Missing persona entities and membership edges are recreated, stale memberships are removed, and left or deactivated personas remain in append-only identity history but disappear from current relationship context. Reconciliation reports whether the roster changed separately from graph repair, so a previously partial installation can self-heal instead of remaining a permanent duplicate.

When a hook supplies the same exact `groupId`, `relationship_context` and `session_briefing` include current visible co-members reached through authenticated `member-of` edges. They do not infer friendships, merge names, cross tenants, expose another group, or turn membership into delegation. A direct session without an exact group scope does not receive group-private peers. Relationship reads have a five-second local state deadline and return a clear error instead of waiting indefinitely on a stalled read.

The same approved envelope may contain `nativeDiscovery` scopes. AgentSpine then checks only the officially documented direct agent-manifest directories: Claude Code `~/.claude/agents/` or `<project>/.claude/agents/`, and Codex `~/.codex/agents/` or `<project>/.codex/agents/`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` replace only their matching user scope. Each scope fixes issuer, tenant, profile, agent/bot kind, and optional group; those authenticated scope fields plus the exact source binding form the stable identity. The manifest contributes only its declared display name and an exact source descriptor; its instructions remain host-native context. Direct regular `.md` or `.toml` files are bounded to 128 entries and 256 KiB each; symlinks and files exchanged during a read fail closed. No other home or project directory is enumerated. See the official [Claude Code custom subagent locations](https://code.claude.com/docs/en/sub-agents) and [Codex custom agent locations](https://developers.openai.com/codex/agent-configuration/subagents).

```json
{
  "nativeDiscovery": [
    {
      "id": "native:claude:user",
      "host": "claude",
      "scope": "user",
      "issuer": "host:local",
      "tenantId": "tenant:blun",
      "profileId": "profile:franz",
      "kind": "agent",
      "groupId": "group:engineering"
    }
  ]
}
```

A one-shot manual validation is available through:

```bash
agentspine persona-sync /path/to/project \
  --roster /absolute/path/to/roster.json \
  --confirm-local-persona

agentspine personas /path/to/project --json
agentspine relationships group:engineering --group group:engineering --json
```

## Telegram and host runner

An active Telegram channel binding needs `receive` and `reply`, an ingress HMAC environment variable, and an outbound Bot API token environment variable. The worker polls only accounts present in current bindings. Unknown chats, topics, senders, and non-text updates do not enter the queue.

`AGENTSPINE_HOST_RUNNER` must be an absolute locally approved executable path. AgentSpine invokes it with no shell and a minimized environment. One bounded JSON request arrives on stdin. For channel work it contains the exact host, profile, project root, agent scope, session key, and `agent_spine_channel_event` reference needed to start the native lifecycle hook. The message text itself is loaded by that hook from the authenticated channel state.

When the runner starts the selected stock CLI, it maps that request to the child process environment: `AGENTSPINE_GATEWAY_CONTEXT=agentspine.gateway-start/v1`, `AGENTSPINE_ENTITY_ID`, `AGENTSPINE_PROJECT_ID`, optional `AGENTSPINE_GROUP_ID`, plus `AGENTSPINE_CHANNEL_EVENT_ID` and `AGENTSPINE_CHANNEL_PROVIDER`. The native `SessionStart` payload does not need proprietary fields; the trusted AgentSpine hook reads this exact environment bridge and then leases the referenced event. The runner must not pass provider tokens or the ingress HMAC secret to the host process.

The runner returns one bounded JSON result:

```json
{
  "text": "Die geprüfte Antwort.",
  "checkpoint": { "step": "verified" },
  "completed": true
}
```

Start one diagnostic tick:

```bash
agentspine gateway-control /path/to/project \
  --enabled true --confirm-local-gateway

AGENTSPINE_TELEGRAM_TOKEN='…' \
AGENTSPINE_TELEGRAM_INGRESS_SECRET='at-least-32-bytes…' \
AGENTSPINE_HOST_RUNNER='/absolute/path/to/approved-runner' \
agentspine-worker --root /path/to/project \
  --persona-roster /absolute/path/to/roster.json --once
```

Remove `--once` under a service manager for continuous operation. AgentSpine does not silently install a daemon, persist provider tokens, or approve Codex/Claude executable hooks. Codex still requires the current hook definition to be visible and trusted in `/hooks`.

## Goals, attention, and recovery

An agent without a queued message or an owner-assigned goal reports `idle/needs-goal`. `goal-assign` creates one exact focused goal for an active authenticated agent. Promise, resolved-blocker, deadline, assignment, follow-up, and direct-message wakes share bounded per-agent lanes. Each effect rechecks current policy, identity, group, route, and kill-switch state.

Queue leases expire safely, retries are bounded, and the worker wakes on relevant desired-state files or a capped timer without watching its own runtime writes. Prepared and demonstrably effect-free failed deliveries resume after restart. A revoked reply capability or exhausted no-effect retry budget becomes `dead-letter`; ambiguous sends become `delivery-unknown` and are never automatically replayed. Already delivered outbox entries are never sent twice. Checkpoints reject secrets and authority-shaped content. The ten-gate audit replays persona events, gateway history, receipts, lanes, queue IDs, delivery IDs, independent health heartbeats, and current authority markers.

The worker can be stopped locally at any time:

```bash
agentspine gateway-control /path/to/project \
  --kill-switch true --confirm-local-gateway
```

Memory, learning, relationships, persona files, goals, and model output cannot grant channel, tool, process, or execution permission.
