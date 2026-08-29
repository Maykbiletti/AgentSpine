# Harness reference study

This architecture input was reviewed on 2026-08-29 against primary sources only. No upstream code, brand material, or persona text is included in AgentSpine.

## Reviewed snapshots

- OpenClaw `2026.8.1`, commit [`fb7822e1`](https://github.com/openclaw/openclaw/commit/fb7822e1d3333c9417131fa3514000a6a17e6dbd): [multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent), [Gateway protocol](https://docs.openclaw.ai/gateway/protocol), and [cron jobs](https://docs.openclaw.ai/automation/cron-jobs).
- NousResearch Hermes Agent `0.20.6`, commit [`1c5ee581`](https://github.com/NousResearch/hermes-agent/commit/1c5ee5815fe5a3913530ba9d803b5b60bc633766): [cron guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), [messaging overview](https://hermes-agent.nousresearch.com/docs/user-guide/messaging), and [Telegram guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram).

## Architecture comparison

| Pattern | Übernehmen | An AgentSpine anpassen | Bewusst nicht übernehmen |
|---|---|---|---|
| Long-lived local gateway | Durable event ownership, health, wake-up, and recovery outside conversational turns | Optional provider-neutral worker; it does not replace the model host or tool registry | No silent network listener, hidden installation, or MCP administration |
| Agent isolation | Per-agent lane, state, session key, and exact channel-account binding | Separate tenant, profile, project, group, chat, and thread in every route | No fallback from one agent's private session, credentials, or memory into another |
| Scheduler | Persistent desired state, startup reconciliation, targeted event wake, and independent ticker health | Goals and obligations enter one bounded priority queue; timer is capped and has no busy loop | No prompt-created cron authority and no model-controlled scheduler policy |
| Isolated scheduled run | Fresh bounded host run with a terminal result and durable checkpoint | Return only the safe result/checkpoint to the responsible main context | No global transcript import and no private cross-session history mixing |
| Telegram | Stable numeric identities, explicit binding, origin-preserving replies, allowlist-style ingress | HMAC-normalized `agentspine.channel-event/v1`, exact tenant/account/chat/thread/sender/agent scope | No name-based identity, inferred recipient, broad bot token access, or send capability from text |
| Persona and voice | Per-agent persona source and stable named-bot separation | Authenticated roster metadata plus a bounded context-only `voiceBrief` | No persona file copying, invented feelings, dependency language, or authority from `SOUL.md` |
| Delivery | Idempotent outbox, receipts, retry, and terminal failure | Ambiguous sends become `delivery-unknown` and require reconciliation rather than replay | No claim of mathematical exactly-once transport; the guarantee is at-most-one automatic external effect |

## AgentSpine contracts derived from the study

1. `agentspine.channel-event/v1` is immutable and binds provider, tenant, account, chat, thread, sender, agent, project, group, privacy, reply target, and observed time.
2. The optional worker owns typed inbound, run, lifecycle, health, scheduler, and delivery transitions in external private state.
3. Per-agent lanes serialize work; another agent, tenant, profile, project, group, chat, or thread cannot claim the lease.
4. Reconciliation expires abandoned leases, detects ambiguous delivery, re-enqueues only demonstrably effect-free failures, and preserves terminal receipts.
5. Gateway, adapter, scheduler, queue, worker lease, and host runtime have separate health fields. A live process alone is not healthy.
6. Goals require an authenticated local owner assignment and contain one success criterion, next safe step, deadline, checkpoint, heartbeat, blocker, and history.
7. Memory, Markdown, persona, relationship, task text, prior output, and MCP never satisfy identity, execution, route, or send policy.

## Regression classes

The local tests cover the public failure classes as contracts rather than copying their implementations:

- A scheduled result that is delivered but never checkpointed cannot become terminal; run completion persists before delivery preparation.
- A stopped scheduler cannot hide behind a running gateway because health gates are independent and audited.
- Restart reconciliation converts an in-flight ambiguous send to `delivery-unknown`; it never floods Telegram by replaying it.
- Every run has a bounded host timeout and one of the terminal or retryable queue states; no final-tool-call ghost remains leased forever.
- Lease expiry and startup reconciliation close ghost lane rows and allow only safe work to resume.
- Duplicate provider updates, parallel workers, and repeated delivery calls converge on one event, one lane, one outbox key, and at most one automatic external send.

## Stronger boundaries retained

AgentSpine keeps no global full transcript, exposes no channel, goal, wake, worker, kill-switch, secret, or send administration through MCP, and does not broaden tools from persona or team membership. Host and local policy stores remain physically separate from context state. Explicit host trust and local owner confirmation remain unavoidable security decisions.
