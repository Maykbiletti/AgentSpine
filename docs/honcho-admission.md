# Honcho self-hosting admission

AgentSpine may act as the scope and policy gateway for a self-hosted Honcho deployment, but it does not treat an inference endpoint as a Honcho server and it does not run two writable memory systems at once.

`evaluateHonchoAdmission(plan)` is a side-effect-free, fail-closed pre-deployment gate. It does not contact a server, install Honcho, write memory, or prove that a declaration is true. A production cutover still needs receipts from the actual BLUN host.

## Required boundaries

- `honcho.serverUrl` is the root URL of a separately deployed Honcho API, never the managed Honcho service and never an LLM or embedding URL.
- Server, embedding, and derivation origins are distinct and explicitly owner-approved.
- Every endpoint host must also be a numeric private-network address, loopback, or `localhost`. RFC 1918, Tailscale CGNAT (`100.64.0.0/10`), and IPv6 ULA addresses are eligible. An allowlist entry alone cannot turn a public address or DNS name into a BLUN-internal endpoint.
- Evaluation keeps AgentSpine as the only writer and Honcho read/write disabled. Cutover reverses that ownership and leaves AgentSpine as `scope-gateway`.
- Every request binds tenant, workspace, user, project, and thread identifiers. Only confirmed private sources are eligible.
- Telemetry is disabled and raw credentials are forbidden in the admission plan. A later transport may refer to a separately managed credential environment variable, but must not persist its value.
- Background derivation is asynchronous, tool-less, parent-history-free, fail-open, and has no automatic retries.
- A production cutover requires a distinct SHA-256-bound receipt for each of live server health, embedding compatibility, derivation isolation, cross-session recall, deletion, and AGPL source availability. Every receipt also carries a field-domain-separated binding over its digest and the exact tenant, workspace, user, project, and thread scope. Boolean claims, cross-gate replay, and unchanged cross-scope replay are insufficient.

## BLUN endpoint status

The supplied King endpoint at `http://100.74.238.1:8000/v1` is an OpenAI-compatible inference endpoint, not a Honcho API endpoint. Reusing its origin as `honcho.serverUrl` is rejected even though the upstream Honcho development server also commonly listens on port 8000.

The supplied Ollama endpoint at `http://100.74.238.1:11434/api/embed` is a native Ollama embedding endpoint. Current upstream Honcho documentation configures Ollama embeddings through the OpenAI-compatible transport and a `/v1` base URL. AgentSpine therefore records the native endpoint as not yet directly compatible; it must not silently rewrite the URL or claim production readiness. A separately verified compatible endpoint or explicit adapter is required.

The gate contains no endpoint probe. Reachability, model identity, vector dimensions, quota/accounting behavior, and data isolation must be verified from the authorized 65er host without logging private source bytes.

DNS names are rejected by the static gate because their resolved addresses can change after admission. Supporting an internal DNS name requires a later, separately reviewed host-attestation design that binds the name and resolved private addresses without weakening this fail-closed boundary.

## Upstream basis

- [Honcho self-hosting and SDK configuration](https://github.com/plastic-labs/honcho#self-hosting)
- [Official Docker Compose topology](https://github.com/plastic-labs/honcho/blob/main/docker-compose.yml.example)
- [Official embedding migration and Ollama transport notes](https://github.com/plastic-labs/honcho/blob/main/docs/v3/contributing/changing-embeddings.mdx)
- [Honcho AGPL-3.0 license](https://github.com/plastic-labs/honcho/blob/main/LICENSE)
