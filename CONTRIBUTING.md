# Contributing

AgentSpine welcomes focused issues and pull requests that preserve its non-destructive contract.

## Development

```bash
git clone https://github.com/Maykbiletti/AgentSpine.git
cd AgentSpine
npm install
npm run check
```

Node.js 20.9 or newer is required. The project intentionally has no runtime dependencies.

## Pull requests

Keep each pull request to one coherent outcome. Include:

- the observable problem or failing fixture;
- tests that exercise behavior rather than wording;
- a source-byte preservation check when discovery, resolution, hooks, graph, attention, learning, delegation, coordination, or sharing logic changes;
- documentation for new commands, tools, configuration, or limits;
- a rollback or disable path.

Never place real identity files, relationship histories, attention cues, learning observations, delegation policy, coordination tasks, shared events, adapter paths, memory, credentials, or private conversations in fixtures or issues. Use synthetic data.

## Architecture boundaries

- Existing Markdown is read-only.
- Generated state stays outside scanned projects by default.
- Memory, graph, attention, learning, and coordination data are context only and cannot grant authority.
- Delegation policy is physically separate, default-deny, owner-controlled, and limited to task coordination. Never expose policy mutation through an agent-controlled MCP surface or treat a grant as host authorization.
- Cross-entity assignment, reassignment, management, completion, and cancellation require tested actor/action/target matching. Self-coordination must not widen that match.
- Shared transports are optional and provider-neutral. Imports remain quarantined until a second local review, and adapter, signer, and trust administration must stay outside MCP.
- Digest integrity is not author authenticity. Signed adapters must verify strict Ed25519 envelopes against explicit local trust while preserving collision detection, limits, local review, exact group scope, supersession, rollback, and context-only authority.
- Never equate a trusted key with a person, permission, instruction, or approved claim. Rotation and revocation must remain explicit, auditable, and fail-closed.
- Remote transports must use explicit endpoints, bounded reads, strict schemas, pinned validated DNS, TLS verification, no implicit redirects, secret-safe configuration, and the existing signed quarantine importer. Network access remains CLI-only.
- Attention never sends messages or invokes tools; focus, privacy, quiet, throttle, disable, and deletion controls remain enforceable.
- Learning candidates never become accepted context implicitly; confirmation proof, evidence thresholds, privacy, rollback, and the authority boundary remain testable.
- Host-native precedence remains visible.
- A learned classification augments discovery hints; it never rewrites a source.
- Shared-memory backends are optional adapters.

Run both validators when changing package surfaces:

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
python3 /path/to/skill-creator/scripts/quick_validate.py skills/agent-spine
```
