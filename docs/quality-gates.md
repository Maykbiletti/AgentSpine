# Ten quality gates

`agentspine audit` is the executable Definition of Done for an installed project. It scans twice, resolves context, validates overlay state, verifies the saved catalog, and compares source hashes. It never repairs or rewrites source Markdown.

```bash
agentspine audit /path/to/project
agentspine audit /path/to/project --json
```

| Gate | Proof | Failure meaning |
|---:|---|---|
| 1 | Supported Node.js runtime | Runtime is below Node 20 |
| 2 | Catalog schema and discovery | Sources could not be represented deterministically |
| 3 | External generated state | Catalog, graph, attention, learning, delegation policy, coordination, sharing, trust, or signer state landed inside the scanned project |
| 4 | Native hierarchy mapping | A recognized host source lacks host mapping |
| 5 | Markdown link integrity | An indexed local `.md` link has no target |
| 6 | Conflict visibility | Precedence and competing candidates are surfaced for review |
| 7 | Authority boundary | Context or shared state claims authority, a delegation grant lacks explicit local provenance, or an assignment snapshot has no matching policy history |
| 8 | Context privacy | Graph, attention, learning, coordination, sharing, signer, trust, signature, group binding, local-review proof, or safety boundary is invalid |
| 9 | Context budget | Resolved source bytes or the complete compact session briefing exceed the requested ceiling |
| 10 | Byte preservation | A source hash changed during the audit or differs from the saved scan |

Gate 6 is informational when findings are represented correctly; AgentSpine exposes conflicts rather than pretending to solve them. Every other failed gate makes the command exit non-zero.

## CI and troubleshooting

The repository test matrix covers Linux, macOS, and Windows on supported Node.js release lines. Package integrity runs separately. For an integration project, run the JSON form and retain only the audit result—never upload source content, the private graph, attention state, learning state, delegation policy, coordination state, sharing inbox, or adapter events as CI evidence.

Broken links are reported with source and target in the catalog. Competing constitution candidates record either native host precedence or `agent-review-required`. Fix the project only through its normal owner workflow; AgentSpine deliberately has no auto-fix mode.

Gate 8 validates the local sharing quarantine, accepted imports, review proof, event integrity, group scope, trusted public keys, private/public key matches, private-key file safety, and retained event signatures. `agentspine audit` does not crawl remote URLs. Directory manifests and events are validated with strict file, size, schema, digest, signature, trust, and collision checks whenever used. HTTPS snapshots add endpoint, DNS, TLS, redirect, media-type, compression, response-size, bundle-integrity, and signed-document checks before they enter that same importer. CI uses synthetic responses and identities only; it never depends on an external service or secret.

Gate 9 also assembles a read-only generic `session_briefing`, verifies its reported compact UTF-8 JSON byte count, and confirms it remains inside the configured packet ceiling. Focus is active and private context is excluded during this audit read.
