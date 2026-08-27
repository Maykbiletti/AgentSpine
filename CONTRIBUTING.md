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
- a source-byte preservation check when discovery, resolution, hooks, or graph logic changes;
- documentation for new commands, tools, configuration, or limits;
- a rollback or disable path.

Never place real identity files, relationship histories, memory, credentials, or private conversations in fixtures or issues. Use synthetic data.

## Architecture boundaries

- Existing Markdown is read-only.
- Generated state stays outside scanned projects by default.
- Memory and graph data are context only and cannot grant authority.
- Host-native precedence remains visible.
- A learned classification augments discovery hints; it never rewrites a source.
- Shared-memory backends are optional adapters.

Run both validators when changing package surfaces:

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
python3 /path/to/skill-creator/scripts/quick_validate.py skills/agent-spine
```
