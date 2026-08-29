# Host integration

AgentSpine uses native plugin surfaces instead of asking users to paste a large system prompt into every project.

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

The Claude manifest explicitly references `./.mcp.json`. The hook bundle remains at Claude Code's native auto-discovery path `hooks/hooks.json`; it is deliberately not registered a second time through the manifest. Version `0.7.0` replaces the `0.6.0` cache identity; both host manifests and the hook bundle carry that version, while the bundle declares the `agentspine.source-roots/v1` runtime contract. The repository checks resolve installed-root variables, perform a real MCP `initialize` handshake, validate exactly one native hook command per event, and exercise clean install, previous-version cache rejection, upgrade, host-native source resolution, indexed and lazy Claude memory, automatic multilingual briefing, attention, exact job start, tool checkpoint, new-session resume, purge, and uninstall preservation:

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

| Component | Path | Purpose |
|---|---|---|
| Manifest | `.codex-plugin/plugin.json` | Package identity, skill, and MCP registration |
| Skill | `skills/agent-spine/SKILL.md` | Context rules and preservation invariants |
| MCP | Manifest `mcpServers` | Read-only source tools plus external overlay workflows |
| Hooks | `hooks/hooks.json` | Auto-discovered lifecycle guardrails |

Open `/plugins` in Codex CLI after configuring a marketplace that contains AgentSpine. Review and trust the hook definition, then start a new session.

Codex sets `CLAUDE_PLUGIN_ROOT` for hook compatibility, so the same hook bundle can execute in both hosts. The MCP registration uses Codex's `PLUGIN_ROOT` expansion.

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

The provider-neutral lifecycle adapter covers `SessionStart` (including resume and compact starts), `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`, and `SubagentStop`. Start, prompt, and compaction boundaries scan and inject the actual byte-budgeted `session_briefing`; no model-side MCP selection is required. Prompt submission can additionally capture minimal safe learning and direct promise/blocker signals after the separate local continuity opt-in. `PostToolUse` writes an idempotent task heartbeat; `Stop` and `SubagentStop` close that heartbeat without emitting repeated chat text.

When an exact locally registered job is waiting, `SessionStart` acquires its lease and injects its real checkpoint automatically. Subsequent tool and stop hooks resolve that job from the native host session; the model does not need to repeat a job envelope. `PreToolUse` first retains the protected-source guard, then rechecks the current execution grant, assignment, scope, capability, lease, and workspace. `PostToolUse` checkpoints exactly one matching result. A new session resumes only after the same checks. Grant and job administration remain local CLI operations and are absent from MCP. No hook creates permissions.

Identity and audience come from explicit hook scope fields or the locally configured default direct-person/project scope. Group content requires an exact group ID and never enters automatic learning. Missing scope produces no inferred identity; corrupt state returns a visible `failedClosed` packet and must never be reported as successful recall.

Hook stdin is JSON-only and limited to 64 KiB. State transitions use external atomic files and locks. Hook stdout contains only host protocol JSON; diagnostics are bounded to stderr by the host process. Hooks do not expose transport, key, trust, database, network, message, payment, production, delegation, or policy administration.

The first executable-component trust approval remains mandatory. AgentSpine cannot approve itself. After approval and the one-time continuity opt-in, no per-session enablement or voluntary tool call is required.

The visible acceptance runner invokes the same production lifecycle adapter with new synthetic people, separated groups, Swedish and Spanish prompts, restarts, compaction, correction, rollback, purge, current-rights checks, and durable checkpoints. It prints one reproducible receipt per gate and proves `mcpCalls: 0`. See [visible cross-host acceptance](acceptance.md).
