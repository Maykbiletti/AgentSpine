# Host integration

AgentSpine uses native plugin surfaces instead of asking users to paste a large system prompt into every project.

## Claude Code

| Component | Path | Purpose |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | Package identity and version |
| Marketplace | `.claude-plugin/marketplace.json` | GitHub installation and updates |
| Skill | `skills/agent-spine/SKILL.md` | Context rules and preservation invariants |
| MCP | `.mcp.json` | Read-only discovery and context tools |
| Hooks | `hooks/hooks.json` | Lifecycle indexing and protected-source guard |

Install from GitHub:

```bash
claude plugin marketplace add Maykbiletti/AgentSpine
claude plugin install agent-spine@agent-spine
```

Use `claude plugin validate .` in a checkout to validate the manifest and marketplace. Claude Code asks the user to approve executable plugin components according to its trust model.

## Codex

| Component | Path | Purpose |
|---|---|---|
| Manifest | `.codex-plugin/plugin.json` | Package identity, skill, and MCP registration |
| Skill | `skills/agent-spine/SKILL.md` | Context rules and preservation invariants |
| MCP | Manifest `mcpServers` | Read-only discovery and context tools |
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

The server implements `initialize`, `ping`, `tools/list`, and `tools/call`. It has no network dependency and does not expose write tools.
