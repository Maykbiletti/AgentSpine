# Configurable autonomy and project portfolio

AgentSpine distinguishes four cumulative levels for each explicitly registered project and exact tenant/group scope:

- `observe`: keep a bounded, restart-safe inventory; do not propose or act.
- `advise`: record evidence-classified findings and expose at most one deduplicated, rate-limited notice in scoped context.
- `execute`: additionally permit reversible local effects only when the requested exact `tool:<name>` capability is configured **and** a current AgentSpine execution grant independently matches actor, job, task, target, project, group and host.
- `publish`: additionally permit a publication decision only after a separate local publish confirmation and the same exact execution-grant check.

The autonomy decision is an additional gate, never a grant. It cannot create tools, delegation, identity, credentials, payment, production access or policy exceptions. Native host policy and every existing AgentSpine safety boundary still apply.

## Registration

Local roots must already exist as direct, non-symlinked directories. Public repositories are stored as credential-free HTTPS references; portfolio scanning does not fetch them. AgentSpine never discovers or silently enrolls sibling projects.

```text
agentspine autonomy-project-set autonomy:alpha \
  --project project:alpha --tenant tenant:synthetic \
  --local-root /projects/alpha --mode advise \
  --confirm-local-autonomy
```

Execute and publish modes require exact capabilities. Publish also requires `--confirm-local-publish`. Registration identity, project, tenant, group and source are immutable; changing scope requires a new registration.

## Evidence and proactive notices

`autonomy-scan` reads only a sorted, capped top-level directory inventory plus bounded regular `package.json`, `AGENTS.md` and `.git/HEAD` files. It rejects linked roots, verifies file identity around reads, stores only small digests/metadata and leaves all source bytes untouched. Public URL evidence must be supplied by a separately authorized host/tool path.

Observations separate `objective`, `user-feedback` and `model-suggestion` evidence. CI and error findings require objective evidence. Exact duplicate findings create no new observation or notice. Expired evidence is omitted; observe-only projects never create notices. Presentation is explicit, one item at a time and rate-limited.

The MCP surface exposes only context operations: `project_portfolio`, `record_project_observation` and `evaluate_autonomy_action`. Owner configuration and revocation remain local CLI operations.
