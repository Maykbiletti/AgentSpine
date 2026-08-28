# Host integration

AgentSpine uses native plugin surfaces instead of asking users to paste a large system prompt into every project.

## Claude Code

| Component | Path | Purpose |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | Package identity and version |
| Marketplace | `.claude-plugin/marketplace.json` | GitHub installation and updates |
| Skill | `skills/agent-spine/SKILL.md` | Context rules and preservation invariants |
| MCP | `.mcp.json` | Read-only source tools plus external overlay workflows |
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

The server implements `initialize`, `ping`, `tools/list`, and `tools/call`. It has no network dependency and exposes no source-file, delegation-policy, signer, trust, or shared-adapter administration tool. Overlay tools write only private AgentSpine context state outside the scanned project. Explicit delegation grants, key generation and rotation, trust changes, adapter connections, publication, HTTPS snapshot export or pulls, import review, and destructive sharing operations remain on the local CLI surface. MCP can only read already reviewed `shared_context`; its authentication summary contains no signature or public-key material. `session_briefing` is a read-only aggregator over these already constrained read paths and cannot widen them.

Verify either installation against a synthetic or real project without changing its Markdown:

```bash
agentspine doctor --json
agentspine audit /path/to/project --json
```

The audit exits non-zero when a required gate fails, making it suitable for installation smoke tests and CI.

At session and compaction boundaries, the hook may add counts and kinds for due shared attention cues, accepted local learning, open shared coordination, and locally reviewed shared memory. It never injects cue summaries, learned or imported claims, pending inbox items, adapter paths, task titles or notes, delegation policy, private relationship data, or group context without an audience. The agent should explicitly call `session_briefing` with the narrowest known person, group, project, current task, and byte budget. The component context tools remain available for targeted follow-up. Set `markPresented` only through `attention_context` when a cue is actually surfaced. Cross-entity task actions require an explicit `check_delegation` decision in addition to normal host authorization.
