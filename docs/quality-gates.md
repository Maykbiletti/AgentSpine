# Ten quality gates

`agentspine audit` is the executable Definition of Done for an installed project. It scans twice, resolves context, validates overlay state, verifies the saved catalog, and compares source hashes. It never repairs or rewrites source Markdown.

```bash
agentspine audit /path/to/project
agentspine audit /path/to/project --json
```

| Gate | Proof | Failure meaning |
|---:|---|---|
| 1 | Supported Node.js runtime and installed host inventory | Runtime is below Node 20, or the MCP/hook set is missing, duplicated, disabled, or stale |
| 2 | Catalog schema and discovery | Sources could not be represented deterministically |
| 3 | External generated state | Catalog, graph, attention, learning, delegation policy, coordination, execution policy, job checkpoint, sharing, trust, or signer state landed inside the scanned project |
| 4 | Native hierarchy mapping | A recognized host source lacks host mapping |
| 5 | Markdown link integrity | An indexed local `.md` link has no target |
| 6 | Conflict visibility | Precedence and competing candidates are surfaced for review |
| 7 | Authority boundary | Context or shared state claims authority; a delegation or execution grant lacks explicit local provenance; or a task/job snapshot has no matching policy history |
| 8 | Context privacy | Graph, attention, learning, coordination, self-starter, sharing, signer, trust, signature, group binding, local-review proof, or safety boundary is invalid |
| 9 | Context budget | Resolved source bytes or the complete compact session briefing exceed the requested ceiling |
| 10 | Byte preservation | A source hash changed during the audit or differs from the saved scan |

Gate 6 is informational when findings are represented correctly; AgentSpine exposes conflicts rather than pretending to solve them. Every other failed gate makes the command exit non-zero.

With `--host claude` or `--host codex`, Gate 2 uses the production source-root resolver instead of recursively scanning the supplied path. It fails when the host profile and active project scopes are empty, conflicting, damaged, or stale, and reports scope counts plus the concrete fail-closed reason. This mode never falls back to scanning the home directory.

For Claude project memory, Gate 2 also reports indexed, relevant, loaded, cache-hit, cache-miss, missing, scope-rejected, path-rejected, symlink-rejected, size-rejected, and race-rejected counts. The live hook never enumerates the memory directory. Orphan counting is available only through the explicit offline diagnostic `agentspine doctor --host claude --offline-memory-orphans`; it reads no orphan content and cannot affect recall or authority.

## CI and troubleshooting

The repository test matrix covers Linux, macOS, and Windows on supported Node.js release lines. Package integrity runs separately. For an integration project, run the JSON form and retain only the audit result—never upload source content, the private graph, attention state, learning state, delegation policy, coordination state, sharing inbox, or adapter events as CI evidence.

Broken links are reported with source and target in the catalog. Competing constitution candidates record either native host precedence or `agent-review-required`. Fix the project only through its normal owner workflow; AgentSpine deliberately has no auto-fix mode.

Gate 8 validates attention lifecycle schema, provenance, event and receipt identity, exact group binding, execution-policy/job binding, leases, pending effects, checkpoints, retry state, the local sharing quarantine, accepted imports, review proof, transport event integrity, trusted public keys, private/public key matches, private-key file safety, and retained signatures. `agentspine audit` does not start or resume jobs and does not crawl remote URLs. Directory manifests and events are validated with strict file, size, schema, digest, signature, trust, and collision checks whenever used. HTTPS snapshots add endpoint, DNS, TLS, redirect, media-type, compression, response-size, bundle-integrity, and signed-document checks before they enter that same importer. The object-transport suite additionally proves create-only headers, exact body length, status handling, idempotent collision verification, mandatory read-back, secret exclusion, private-network confirmation, and source preservation. CI uses synthetic responses and identities only; it never depends on an external service or secret.

The optional SQLite suite runs where `node:sqlite` is available and proves external-path enforcement, signed-manifest binding, strict schema and integrity validation, append-only revision continuity, atomic-head validation, idempotency, tamper rejection, quarantined pull, CLI integration, agent-surface exclusion, and source preservation. Older supported Node.js jobs load the package without activating this optional transport.

Gate 9 also assembles a read-only generic `session_briefing`, verifies its reported compact UTF-8 JSON byte count, and confirms it remains inside the configured packet ceiling. Focus is active and private context is excluded during this audit read.

## Visible lifecycle acceptance

The ten-gate audit validates one installed project's invariants. The complementary `agentspine acceptance` command proves the entire automatic cross-host behavior in an isolated synthetic environment:

```bash
agentspine acceptance
agentspine acceptance --json
```

Its 14 visible gates cover canonical identities, Swedish and Spanish continuity, heartbeat/promise/blocker persistence, Claude restart, Codex compaction, person and group isolation, correction history, rollback, authorized resume, denied foreign effect, durable checkpointing, person purge, source-byte preservation, and the final audit. Every gate prints a deterministic SHA-256 receipt, and the machine report explicitly records zero MCP calls. Fresh-install and upgrade validation run this same acceptance entry point from the staged installed bundle. See [visible cross-host acceptance](acceptance.md).
