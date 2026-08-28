# Preservation contract

The preservation contract is AgentSpine's primary compatibility promise.

## Guaranteed

For every discovered source document, AgentSpine records its canonical path, repository-relative path, byte count, modification time, semantic layer, host relevance, explicit links, and SHA-256 digest.

The scanner:

- opens source Markdown read-only;
- never renames, moves, merges, normalizes, truncates, or rewrites it;
- does not follow filesystem symlinks;
- writes catalogs, graph overlays, attention, learning, delegation policy, coordination, imported sharing state, trust, and private signing keys only to the user state directory;
- writes an explicitly requested HTTPS snapshot only to a new path outside the scanned project and never uploads or overwrites one;
- uses an atomic temporary-file replacement for its own catalog;
- keeps every discovered document visible even when another file has higher precedence.

The resolver may omit content from an individual response when its configured byte budget is exhausted. Omission is explicit. The session briefing also measures its complete compact JSON result and includes only whole records; it never shortens source or state values to make them fit. The original remains retrievable through a ranged read with its SHA-256 digest. Ranged reads include both UTF-8 text and base64 bytes so callers can verify exact data even when a boundary splits a multibyte character.

Filename and path classification is a hint. An agent may add a context-only overlay annotation, but cannot promote an arbitrary source into the constitution layer. Only filenames understood by the native host adapter are instruction candidates.

## Protected sources

A source is protected from agent write tools when it is any of the following:

- a native host instruction file;
- a soul or persona file;
- a memory index or a Markdown file below a memory directory;
- a Markdown file explicitly linked from a protected source.

Protection is a host hook guardrail, not an operating-system security boundary. Users retain full control of their files. Specialized tools that bypass host hooks may also bypass the guardrail.

The bundled guard recognizes direct Edit/Write/apply-patch targets and common mutating shell forms that name a protected source. Shell syntax is too broad to prove safe by pattern matching; operating-system permissions, host approvals, and version control remain the hard controls.

## Conflicts and precedence

AgentSpine does not resolve semantic disagreement by editing content. It exposes every source and follows native host ordering. A higher-precedence source may control the active context, but lower-precedence sources remain cataloged with their original hashes.

## Uninstall

Uninstall removes the plugin and its generated state only. It never touches scanned projects. Acceptance tests snapshot source bytes before scanning, resolving, session briefing, reading, attention mutation, learning proposal/review/rollback, delegation and task workflows, signing, trust, shared adapter publication/import/review, HTTPS snapshot export/import, verifying, and hook execution, then compare the source tree afterward.

## Not guaranteed

AgentSpine cannot prevent:

- direct user edits;
- writes from programs outside the hooked host;
- writes from host tool paths that do not participate in lifecycle hooks;
- changes made while AgentSpine is not running.

`agentspine verify` detects those changes relative to the last saved scan. It reports them and never restores files automatically.
