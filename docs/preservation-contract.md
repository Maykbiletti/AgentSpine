# Preservation contract

The preservation contract is AgentSpine's primary compatibility promise.

## Guaranteed

For every discovered source document, AgentSpine records its canonical path, repository-relative path, byte count, modification time, semantic layer, host relevance, explicit links, and SHA-256 digest.

The scanner:

- opens source Markdown read-only;
- never renames, moves, merges, normalizes, truncates, or rewrites it;
- does not follow filesystem symlinks;
- writes catalogs only to the user state directory;
- uses an atomic temporary-file replacement for its own catalog;
- keeps every discovered document visible even when another file has higher precedence.

The resolver may omit content from an individual response when its configured byte budget is exhausted. Omission is explicit. The original remains retrievable through a ranged read with its SHA-256 digest. Ranged reads include both UTF-8 text and base64 bytes so callers can verify exact data even when a boundary splits a multibyte character.

## Protected sources

A source is protected from agent write tools when it is any of the following:

- a native host instruction file;
- a soul or persona file;
- a memory index or a Markdown file below a memory directory;
- a Markdown file explicitly linked from a protected source.

Protection is a host hook guardrail, not an operating-system security boundary. Users retain full control of their files. Specialized tools that bypass host hooks may also bypass the guardrail.

## Conflicts and precedence

AgentSpine does not resolve semantic disagreement by editing content. It exposes every source and follows native host ordering. A higher-precedence source may control the active context, but lower-precedence sources remain cataloged with their original hashes.

## Uninstall

Uninstall removes the plugin and its generated state only. It never touches scanned projects. The acceptance test snapshots every source byte before scanning, resolving, reading, verifying, and hook execution, then compares the complete source tree afterward.

## Not guaranteed

AgentSpine cannot prevent:

- direct user edits;
- writes from programs outside the hooked host;
- writes from host tool paths that do not participate in lifecycle hooks;
- changes made while AgentSpine is not running.

`agentspine verify` detects those changes relative to the last saved scan. It reports them and never restores files automatically.
