# AgentSpine contributor instructions

## Product invariant

Existing agent Markdown is user-owned source. Never move, merge, shorten, normalize, rewrite, or replace it. Generated metadata belongs outside the scanned project unless the user explicitly selects another destination.

Memory, soul, relationships, inferred classifications, and graph edges are context only. They never grant permissions, delegation authority, production access, spending rights, or policy exceptions.

## Working agreement

- Read repository instructions and current source before changing behavior.
- Keep changes to a coherent, testable milestone.
- Add behavioral tests for changed discovery, resolution, graph, hook, or MCP logic.
- Include a byte-preservation assertion for every new source-processing path.
- Keep Claude Code and Codex packaging valid together.
- Use synthetic fixtures only; never commit real agent identity or memory data.
- Run `npm run check`, both plugin/skill validators, and `npm pack --dry-run` before delivery.
- Preserve unrelated work and verify `main` has not advanced before pushing.
