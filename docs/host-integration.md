# Host integration

AgentSpine uses native plugin surfaces instead of asking users to paste a large system prompt into every project.

## Provider contracts and evidence

Provider evidence is not interchangeable. Each adapter separately binds its lifecycle, instruction root, transcript version, session/message IDs and invocation. Portal tasks also require the gateway-issued `AGENTSPINE_PORTAL_REF`/`AGENTSPINE_THREAD_REF` pair from `agentspine.gateway-start/v1`; hooks and MCP may match but never invent it. Direct sessions omit it. All recalled state is context-only, and repository checks do not prove a live launcher forwards it.

| Surface | Claude Code | Codex | BLUN King |
|---|---|---|---|
| Project instructions | `CLAUDE.md` hierarchy | `AGENTS.md` hierarchy | `AGENTS.md` through the isolated BLUN profile |
| Hook package | Native `hooks/hooks.json` | Explicit `hooks/codex.json` | Manifest lifecycle hooks |
| Verified hook briefing → delivery knowledge | Native `additionalContext` handoff receipt | Native `additionalContext` handoff receipt | Native bounded `message` handoff receipt; live acceptance open |
| Historical transcript enrollment | Bounded registered Claude source | Bounded Codex `sessions` source with verified headers | Protected King agent-wire mapping; live mapping open |
| Cross-provider evidence handoff | Explicit opt-in; Claude provenance retained | Explicit opt-in; Codex provenance retained | Same contract; live launcher unverified |
| Native permissions/trust | Host-owned | Host-owned | Host-owned; enforcement of returned block decisions remains externally unverified |

`UserPromptSubmit` consumes the exact signed snapshot once. Only after stdout accepts the native output does AgentSpine store `agentspine.host-context-handoff/v1`, bound to provider, field, byte count and digest. In-process returns, serialized claims and legacy `verified-host-preflight` receipts do not prove handoff. MCP knowledge may reuse a valid receipt; missing, stale or consumed evidence remains non-blocking and explicitly unverified. The receipt proves transport, not model use or delivery.

Adapter acceptance uses bounded synthetic A/B sessions and covers restart, source mutation, foreign scope, private exclusion and service failure. Cross-provider recall still needs local opt-in plus `includePriorProviders: true` with `includePriorSessions: true`. Report repository, installed-host and model observations separately.

## Claude Code

| Component | Path | Purpose |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | Package identity and version |
| Marketplace | `.claude-plugin/marketplace.json` | GitHub installation and updates |
| Skill | `skills/agent-spine/SKILL.md` | Context rules and preservation invariants |
| MCP | `.mcp.json` | Read-only source tools plus external overlay workflows |
| Hooks | `hooks/hooks.json` | Automatic briefing, attention, protected-source guard, and rights-bound checkpoints |

Install from GitHub:

```bash
claude plugin marketplace add Maykbiletti/AgentSpine
claude plugin install agent-spine@agent-spine
```

Use `claude plugin validate .` in a checkout to validate the manifest and marketplace. Claude Code asks the user to approve executable plugin components according to its trust model.

Version `0.73.0` preserves the managed skill/launcher, task continuation, structured completion, and bounded post-compaction evidence recall. Direct transcript recall stays excluded until the owner creates and enrolls a verified timeline receipt. Groups stay excluded. Writing deliveries may reuse the exact hook-issued briefing requirement for advisory knowledge and premortem calls; missing proof does not block ordinary authorized work.

The Claude manifest references `.mcp.json` and uses only its native `hooks/hooks.json`; Codex selects `hooks/codex.json` from its own manifest. Repository checks validate portable manifests, installed-root expansion, one command per event, a real MCP handshake, clean install/upgrade, source isolation, briefing, continuation, compaction, and uninstall preservation:

```bash
npm run host:check
npm run host:install-check
npm run acceptance
```

### Claude MCP troubleshooting

If the plugin is listed but `agent-spine` is missing from `/mcp`, update the marketplace cache and reinstall before starting a new session:

```bash
claude plugin marketplace update agent-spine
claude plugin uninstall agent-spine@agent-spine
claude plugin install agent-spine@agent-spine
claude plugin list
claude mcp list
```

Open `/mcp` in the new interactive session and approve or reconnect `agent-spine`. `Pending approval` means discovery succeeded but Claude Code still needs the user's trust decision. A missing entry after reinstall should be diagnosed from `claude plugin validate .`, `npm run host:check`, and Claude Code's plugin diagnostics; AgentSpine does not write to Claude's user configuration or silently approve itself.

## Codex

History uses the native Codex adapter described in [session timeline](session-timeline.md#integrity-and-provider-formats). It does not use Claude enrollment or a Claude-shaped transcript. Installed-host acceptance remains separate from the repository fixtures.

| Component | Path | Purpose |
|---|---|---|
| Manifest | `.codex-plugin/plugin.json` | Package identity plus explicit skill and MCP registration |
| Skill | `skills/agent-spine/SKILL.md` | Context rules and preservation invariants |
| MCP | Manifest `mcpServers` | Read-only source tools plus external overlay workflows |
| Hooks | `hooks/codex.json` | Manifest-selected lifecycle guardrails |

Open `/plugins` in Codex CLI, then start a new session and review `/hooks`. New or changed hook definitions are skipped until the user trusts their exact hash, following the official [Codex hook contract](https://developers.openai.com/codex/hooks).

For a direct npm/package installation, register or update the common user skill and MCP reader together. The command writes only its sealed skill directory and a marked AgentSpine configuration block, refuses unmanaged conflicts, and requires a local confirmation flag:

```bash
agentspine host-install codex --confirm-local-host-install --json
```

Non-default or synthetic roots may use `--codex-home` and `--skills-root`. The default skill path is `$HOME/.agents/skills/agent-spine/SKILL.md`, a documented [Codex skill location](https://developers.openai.com/codex/build-skills). AgentSpine refuses unowned conflicts and atomically updates sealed state. The launcher verifies package/runtime identity and tools during MCP initialization; failure returns no tools or migration. User trust remains separate. Configuration follows the official [Codex MCP contract](https://developers.openai.com/codex/mcp).

Codex loads `hooks/codex.json` through the explicit plugin-manifest entry. It contains only Codex-documented lifecycle events; Claude Code's additional `InstructionsLoaded` event remains confined to `hooks/hooks.json`. Both files deliberately contain only the documented top-level `description` and `hooks` fields. Cache identity remains in `.codex-plugin/plugin.json`, while Codex records hook trust against the current definition hash. The Codex hook and MCP registrations use the host-native `PLUGIN_ROOT` expansion.

Verify the live host in a newly started Codex CLI session:

```text
/plugins
/hooks
Trust all and continue
```

Native Codex acceptance separately observes `skills/list`, `mcpServerStatus/list`, MCP `tools/list`, the hook handoff and subsequent bound knowledge/premortem. These are distinct [app-server APIs](https://developers.openai.com/codex/app-server); a handshake or `SKILL.md` alone is insufficient. Repository host checks validate manifests, package bytes and an isolated MCP/install lifecycle, but cannot prove user trust, live discovery or model application.

## BLUN King

| Component | Path | Purpose |
|---|---|---|
| Manifest | `blun.plugin.json` | Native BLUN plugin identity plus skill, MCP, and lifecycle-hook registration |
| Skill | `skills/agent-spine/SKILL.md` | Context rules and preservation invariants |
| MCP | Manifest `mcpServers` | Read-only source tools plus external overlay workflows |
| Hooks | Manifest `hooks` | Automatic briefing, attention, protected-source guard, and checkpoints |

Install the local checkout from Fredrik's TUI:

```text
/plugins install C:\path\to\AgentSpine
```

BLUN asks the user to trust a third-party plugin before installation because its MCP server and hooks execute local code. Accept that visible install decision, then use `/reload` or `/new`; BLUN has no separate `/hooks` command. The BLUN adapter maps its isolated `BLUN_HOME` to AgentSpine's Codex-compatible `AGENTS.md` source hierarchy, so user state remains under the BLUN app home instead of leaking into `.codex` or a scanned project.

BLUN Code 1.0.109 constructs MCP tool names as `mcp__<server-name>__<tool-name>`. With AgentSpine's exact manifest server name, its timeline calls are therefore `mcp__agent-spine__session_timeline_index`, `mcp__agent-spine__session_timeline_search`, and `mcp__agent-spine__session_timeline_capture`; the BLUN hook matcher admits only those three exact names. This contract was checked on 2026-09-05 against public `Maykbiletti/blun-code` commit `fbb97459a3fa2157f8bfea3d24931be63288ab11` (`mcp-harness-tools.js`, package license `MIT`). The external source is naming evidence only and is treated as untrusted context; no implementation was copied. Repository checks do not prove that an installed King forwards the hook payload or enforces AgentSpine's returned block decision, and they do not replace a live host acceptance test.

History has an independent [King agent-wire adapter](session-timeline.md#integrity-and-provider-formats). The local launcher must bind the current source and measured wire version through `AGENTSPINE_KING_TIMELINE_SOURCE` and `AGENTSPINE_KING_WIRE_PROTOCOL_VERSION`; AgentSpine neither searches `BLUN_HOME` nor infers either value. Project instructions still resolve through the Codex-compatible hierarchy, while history is enrolled as provider `king` and reads only the explicitly mapped `agents/main/wire.jsonl`. Correct MCP names, a passing Codex adapter, or a model-supplied path do not satisfy this contract.

Repository fixtures verify the reviewed BLUN Code `1.0.109` / King SDK `0.12.1` record shape, objective `tool.result` recall across session restart and compaction, source-byte preservation, and denial for wrong protocol, foreign scope, replay, mutation, and unknown records. Fredrik's actual launcher mapping, installed wire version, live A/B recall, and King's enforcement of returned block decisions are still unverified and must be reported separately. No installation or trust configuration is changed by the repository tests.

## Direct MCP use

Any MCP client that supports stdio can launch:

```json
{
  "mcpServers": {
    "agent-spine": {
      "command": "agentspine-mcp"
    }
  }
}
```

The server implements `initialize`, `ping`, `tools/list`, and `tools/call`. It has no network dependency and exposes no source-file, delegation-policy, signer, trust, or shared-adapter administration tool. Overlay tools write only private AgentSpine context state outside the scanned project. Explicit delegation grants, key generation and rotation, trust changes, adapter connections, publication, HTTPS snapshot export, object upload or pulls, SQLite paths or operations, import review, and destructive sharing operations remain on the local CLI surface. MCP can only read already reviewed `shared_context`; its authentication summary contains no signature or public-key material. `session_briefing` is a read-only aggregator over these already constrained read paths and cannot widen them.

Verify either installation against a synthetic or real project without changing its Markdown:

```bash
agentspine doctor --json
npm run host:check
agentspine audit /path/to/project --json
```

The audit exits non-zero when a required gate fails, making it suitable for installation smoke tests and CI.

Use `agentspine doctor --host claude|codex --cwd /active/project --json` or `agentspine source-status --host claude|codex --cwd /active/project --json` to see the checked scope counts and a concrete empty/fail-closed reason. The lifecycle adapter never substitutes the installation directory for the active host hierarchy. Details and official host references are in [host-native source roots](source-roots.md).

The provider-neutral lifecycle adapter covers `SessionStart` (including resume and compact starts), `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`, and `SubagentStop`. Claude Code additionally registers its documented `InstructionsLoaded` observability event; Codex does not. `UserPromptSubmit` is the blocking boundary. Before a prompt can proceed, `agentspine.preflight/v2` loads complete mandatory host instructions, confirmed Must-Remember entries and every locally required retrieval provider, then consumes one exact-turn receipt. Start and compaction boundaries retain the scoped `session_briefing`; no model-side MCP selection is required. Full behavior and the documented command-hook timeout limitation are in [pre-answer recall gate](preflight-recall.md).

PostToolUse can contain an image or another tool result larger than the adapter's 64 KiB input boundary. Version 0.40 gives only that optional host registration an explicit silent-oversize lane: the adapter drains the payload, exits successfully, emits no stdout or stderr and writes no partial state. Session, prompt, compaction, stop and PreToolUse registrations do not receive that lane and remain fail-closed at the same bound.

When an exact locally registered job is waiting, `SessionStart` acquires its lease and injects its real checkpoint automatically. Subsequent tool and stop hooks resolve that job from the native host session; the model does not need to repeat a job envelope. `PreToolUse` first retains the protected-source guard, then rechecks the current execution grant, assignment, scope, capability, lease, and workspace. `PostToolUse` checkpoints exactly one matching result. A new session resumes only after the same checks. Grant and job administration remain local CLI operations and are absent from MCP. No hook creates permissions.

Identity and audience come from explicit hook scope fields or the locally configured default direct-person/project scope. Group content requires an exact group ID and never enters automatic learning. Missing scope produces no inferred identity; corrupt state returns a visible `failedClosed` packet and must never be reported as successful recall.

Hook stdin is JSON-only and limited to 64 KiB. State transitions use external atomic files and locks. Hook stdout contains only host protocol JSON; diagnostics are bounded to stderr by the host process. Hooks do not expose transport, key, trust, database, network, message, payment, production, delegation, or policy administration.

The first executable-component trust approval remains mandatory. AgentSpine cannot approve itself. After approval and the one-time continuity opt-in, read-only briefing and recall require no per-session enablement or voluntary tool call. A writing delivery must still make the hook-issued `record_delivery_premortem` registration before its first mutation.

## Optional gateway worker

The package also registers exactly one `agentspine-worker` entrypoint. It is separate from MCP and lifecycle hooks. When an owner runs it under a service manager, it synchronizes the configured authenticated persona roster, polls current Telegram bindings, prepares exact Claude/Codex start data, invokes only the absolute executable in `AGENTSPINE_HOST_RUNNER` without a shell, and returns one idempotent reply to the bound origin.

The host runner is responsible for starting the selected host with the supplied scope and `agent_spine_channel_event` fields. Codex skips an untrusted hook definition until the user accepts its current hash in the startup warning or `/hooks`; the worker cannot bypass or manufacture that trust. Setup and the stdin/stdout contract are documented in [durable gateway worker](gateway-runtime.md).

The visible acceptance runner invokes the same production lifecycle adapter with new synthetic people, separated groups, Swedish and Spanish prompts, restarts, compaction, correction, rollback, purge, current-rights checks, and durable checkpoints. It prints one reproducible receipt per gate and proves `mcpCalls: 0`. See [visible cross-host acceptance](acceptance.md).
# Group participation in the gateway worker

Group channel work now includes `groupResponseContract` in the existing
`agentspine.run-request/v1` work item. It is internal context, not text to forward
to the conversation. Without a direct request, choose silence unless there is a
relevant idea, concrete error or useful improvement. Never send an empty-status
announcement or echo another bot's status. Preserve the user's language and
identity. A suggestion is not an objectively verified fact.

The host can return one of these result shapes:

```json
{"groupResponse":{"schema":"agentspine.group-response/v1","kind":"silence"}}
```

```json
{"text":"Die vorhandene Datei könnte überschrieben werden.","groupResponse":{"schema":"agentspine.group-response/v1","kind":"error","subjectId":"finding:destination-collision"}}
```

`answer` requires text and no `subjectId`; it answers a direct request and is not
contribution-deduplicated. `idea`, `error` and `improvement` require text and a stable
`subjectId`. `silence` must not include text, including a visible skip marker.
Unknown versions and fields are rejected without rewriting the original event.
All existing identity, exact reply capability, privacy and output safety checks
remain in force. This contract grants no sending or other action rights.

Silent completion and duplicate contributions consume the exact gateway lease
without preparing an outbox. `deliveryConfirmed` and `completionVerified` remain
false. The existing gateway receipt log records the disposition, not an outcome
or learning acceptance. The worker settles the original channel event locally
using its existing claim/completion API, never a fabricated delivery receipt.
After a crash it recovers this acknowledgement before invoking another host;
an acknowledgement already claimed by another worker waits for that lease.

Contribution deduplication binds normalized text and subject to the complete
origin route, excluding only the event ID. Reservation occurs before delivery;
outbox recovery handles uncertainty. This is exact-content, not semantic,
deduplication.

Compatibility and limits: legacy host results containing only `text` keep their
existing behavior. The ingress v1 record does not authenticate whether a message
directly addresses the bot (`directAddressVerified: false`). The host must make
that distinction and adopt this explicit response contract. Installing AgentSpine
alone therefore does not prove that live Kings stop sending empty-status messages.
No blanket text filter suppresses normal user answers. Private channels cannot
use the group-silence contract. No Telegram configuration or live process changes
are part of this implementation.

Synthetic tests cover silence, direct answers, exact duplicate contributions,
leases, crash/restart, future versions, revocation, mutation, secrets, immutable
sources, byte budgets, and fixed deadlines. No model or Telegram call is made;
real relevance, unnecessary questions, and token use remain unverified.
