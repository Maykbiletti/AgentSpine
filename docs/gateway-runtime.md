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

Version `0.10.1` reconciles the authenticated roster into the relationship graph on every sync, including an otherwise unchanged replay. An exact `groupId` creates a missing group-scoped, context-only group entity; a conflicting non-group or private group fails visibly. Missing persona entities and membership edges are recreated, stale memberships are removed, and left or deactivated personas remain in append-only identity history but disappear from current relationship context. Reconciliation reports whether the roster changed separately from graph repair, so a previously partial installation can self-heal instead of remaining a permanent duplicate.

When a hook supplies the same exact `groupId`, `relationship_context` and `session_briefing` include current visible co-members reached through authenticated `member-of` edges. They do not infer friendships, merge names, cross tenants, expose another group, or turn membership into delegation. A direct session without an exact group scope does not receive group-private peers. Relationship reads bypass project discovery, abort the graph read after a five-second local deadline, and return a visible `degraded` status instead of aborting the turn or waiting indefinitely.

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

For a dependency-bound goal step, the runner may instead report one concrete missing input before acting:

```json
{
  "checkpoint": { "inspected": true },
  "knowledgeGap": {
    "question": "Which synthetic region should the bounded check use?",
    "reason": "The objective criterion requires a region, but no region is present.",
    "requiredEvidence": "owner-input"
  }
}
```

The question pauses only that exact step and survives restart without creating another wake. It cannot be combined with `completed` or a generic `blocked` result. Channel replies and flat goals cannot create knowledge gaps because they lack the plan-step resolution boundary.

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

An agent without a queued message or an owner-assigned goal reports `idle/needs-goal`. `goal-assign` creates one exact focused goal for an active authenticated agent. It can also precommit a bounded dependency plan from a JSON file:

```json
{
  "steps": [
    { "stepId": "step:observe", "agentId": "agent:synthetic-codex", "resources": ["resource:synthetic-worktree"], "title": "Observe the state.", "successCriterion": "The input digest is recorded.", "dependsOn": [] },
    {
      "stepId": "step:act",
      "agentId": "agent:synthetic-claude",
      "resources": ["resource:synthetic-worktree"],
      "title": "Apply the bounded action.",
      "successCriterion": "The objective gate passes.",
      "dependsOn": ["step:observe"],
      "execution": {
        "requiredCapabilities": ["capability:inspect"],
        "strategies": [
          { "strategyId": "strategy:write-and-inspect", "capabilities": ["capability:inspect", "capability:write"], "risk": 40, "cost": 10 },
          { "strategyId": "strategy:read-only", "capabilities": ["capability:inspect"], "risk": 5, "cost": 20 }
        ],
        "verification": { "evaluatorId": "evaluator:synthetic", "metric": "metric:quality", "operator": "gte", "threshold": 0.9, "minCases": 12 },
        "transfer": { "transferKey": "transfer:synthetic-inspection", "maxAgeDays": 30 },
        "exploration": { "maxAttempts": 2 }
      }
    },
    { "stepId": "step:verify", "agentId": "agent:synthetic-codex", "resources": [], "title": "Verify the outcome.", "successCriterion": "The independent check passes.", "dependsOn": ["step:act"] }
  ]
}
```

```bash
agentspine goal-assign goal:release \
  --agent persona:synthetic --owner subject:synthetic --project project:synthetic \
  --success "All three acceptance gates pass." --plan plan.json \
  --confirm-local-goal
```

When the worker returns `needs-clarification`, inspect the open gap with `gateway-status` and resolve its exact stable ID:

```bash
agentspine goal-clarify goal:release \
  --gap knowledge-gap:0123456789abcdef0123456789abcdef \
  --answer "Use synthetic-region-west." --source owner-input \
  --confirm-local-goal
```

For `--source objective-observation`, `--source-digest` must carry the exact 64-character SHA-256 digest of the local observation. The answer, source class and optional digest are immutable once accepted. Six concurrent identical resolutions converge on one continuation; a conflicting second answer is rejected.

The immutable definition digest binds 1-32 exact step IDs, agent assignees, up to 16 resource IDs per step, titles, success criteria and dependencies. If `agentId` is omitted, the step retains the lead agent for compatibility with earlier plans; if `resources` is omitted, it is treated as empty. Every explicit assignee must already be an active authenticated agent in the lead's tenant and exact project group. Only the current dependency-ready step enters that assignee's durable lane, and the host request receives the exact step through the assignee's authenticated host/profile binding. A successful host result completes that step rather than the whole goal; the next ready step and provider are selected deterministically.

While a step is leased, another ready step with an intersecting resource set waits only when both steps belong to the exact same project and group. Competing steps are ordered by the current owner-confirmed goal priority; queue priority is not trusted. Independent resources and equal names in a foreign group continue concurrently. The affected agent's scoped gateway context reports the content-free resource IDs and blocking queue IDs. Completion releases the resources immediately, and ordinary lease-expiry reconciliation releases them after a worker crash.

An optional execution decision precommits one or more required capability classes, two to eight candidate strategies, and an objective verification gate. AgentSpine filters out strategies that do not cover every requirement, then selects the lowest risk, lowest cost and lexicographically first strategy in that order. These are planning labels, not tool grants: the separately approved host and its native policy remain the only source of actual tool access.

An optional transfer key lets a later scope-matching task reuse an objectively successful strategy. Eligibility requires at least two completed source goals in the exact project and group, distinct objective source digests, the same strategy definition and verification contract, and completion within the precommitted 1-90 day evidence window. Transfer can prefer a proven strategy over a cheaper unproven candidate only inside the same lowest-risk sufficient class. The selected task freezes up to eight content-free source references into its immutable plan digest, so restart or compaction cannot change the decision.

A single matching failed outcome or blocking defect disables that strategy for every subsequently assigned task in the scope. Expired evidence and foreign-group evidence are ignored. The normal risk, cost and stable-ID order resumes automatically; prior plans retain their frozen decision. Recomputing local digests cannot fabricate a source because policy validation resolves every proof back to its exact completed goal, step and objective outcome.

Optional bounded exploration can freeze two to four attempts. Its first attempt uses the ordinary deterministic or transferred selection. Remaining attempts are restricted to sufficient alternatives in that exact minimum-risk class and follow the frozen risk, cost and stable-ID order. A valid objective failure without a blocking defect schedules exactly one next attempt atomically; missing or malformed evidence does not explore. A blocking defect stops immediately, and exhausting the budget blocks the step until a new owner-confirmed goal ID is assigned.

The host request includes `goalStep.executionAttempt` with schema `agentspine.execution-attempt/v1`, the one-based attempt, maximum attempts, exact strategy ID, decision digest and previous outcome digest. Every objective outcome binds that sequence and must use a fresh SHA-256 source digest. Future-dated observations, reused sources, altered lineage and a host-selected strategy fail closed. The current attempt is visible through scope-filtered gateway context only to an assigned agent. Restart reconciliation recreates one missing continuation and cannot spend the same attempt twice.

For an execution-bound step, `completed: true` is insufficient. The runner must return the selected strategy, capability classes actually used and one content-free objective outcome:

```json
{
  "checkpoint": { "inspected": true },
  "completed": true,
  "execution": {
    "strategyId": "strategy:read-only",
    "capabilitiesUsed": ["capability:inspect"],
    "outcome": {
      "evaluatorId": "evaluator:synthetic",
      "metric": "metric:quality",
      "value": 0.93,
      "cases": 12,
      "blockingDefect": false,
      "sourceDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "observedAt": "2032-01-01T00:00:06.900Z"
    }
  }
}
```

The selected strategy, optional transfer proof and exploration order, evaluator, metric, threshold and case floor are covered by the immutable plan definition. Missing or mismatched evidence blocks the exact step. A blocking defect always fails even when the numeric metric passes; an owner-confirmed retry preserves earlier outcomes for a non-exploring step and withdraws a regressed transfer from future tasks. A passing outcome advances the dependency graph once, and restart reconciliation reconstructs one lost wake without duplicating completion or exploration.

A generically blocked step retains its checkpoint and requires the owner to repeat the same confirmed assignment before it becomes runnable again. If an assignee leaves, reconciliation cancels runnable work and pauses the exact step before host execution. A step with an open knowledge gap cannot use the generic resume shortcut: it resumes only through `goal-clarify`, and the resolved context is included in the next exact host request. Restart reconciliation recreates exactly one missing runnable step after a torn policy/runtime write but never duplicates an open question. Cycles, unknown dependencies, assignment, resource, execution-decision, transfer-proof or definition drift, stale leases, out-of-order completion, weak answer provenance and altered gap bindings fail closed. Plans, resources, capability labels, transfer proofs, gaps, answers and checkpoints remain context-only: they cannot choose or grant an actual tool, route, identity, delegation, payment, production right or policy exception.

Promise, resolved-blocker, deadline, assignment, follow-up, and direct-message wakes share bounded per-agent lanes. Each effect rechecks current policy, identity, group, route, current plan step, and kill-switch state.

Queue leases expire safely, retries are bounded, and the worker wakes on relevant desired-state files or a capped timer without watching its own runtime writes. Prepared and demonstrably effect-free failed deliveries resume after restart. A revoked reply capability or exhausted no-effect retry budget becomes `dead-letter`; ambiguous sends become `delivery-unknown` and are never automatically replayed. Already delivered outbox entries are never sent twice. Checkpoints reject secrets and authority-shaped content. The ten-gate audit replays persona events, gateway history, receipts, lanes, queue IDs, delivery IDs, independent health heartbeats, and current authority markers.

The worker can be stopped locally at any time:

```bash
agentspine gateway-control /path/to/project \
  --kill-switch true --confirm-local-gateway
```

Memory, learning, relationships, persona files, goals, and model output cannot grant channel, tool, process, or execution permission.
