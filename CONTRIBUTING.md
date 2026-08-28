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
- a source-byte preservation check when discovery, resolution, hooks, graph, attention, or learning logic changes;
- documentation for new commands, tools, configuration, or limits;
- a rollback or disable path.

Never place real identity files, relationship histories, attention cues, learning observations, memory, credentials, or private conversations in fixtures or issues. Use synthetic data.

## Architecture boundaries

- Existing Markdown is read-only.
- Generated state stays outside scanned projects by default.
- Memory, graph, attention, and learning data are context only and cannot grant authority.
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
