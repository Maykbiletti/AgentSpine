# AgentSpine

A layered identity and memory spine for AI agents.

An agent that starts every session as a stranger is a tool. An agent that
knows who it is, how it speaks, how it works and what it has lived through
is a colleague. AgentSpine gives an agent that continuity as four plain
Markdown files — versioned, auditable, portable across runtimes.

## The four layers

| # | File | Holds | Changes |
|---|------|-------|---------|
| 1 | `spine/1-identity.md` | Who the agent is: name, owner, purpose, non-negotiable principles | Almost never |
| 2 | `spine/2-voice.md` | How it speaks: tone, language, length, what it never says | Rarely |
| 3 | `spine/3-conduct.md` | How it works: verification before claims, honesty over confidence, escalation rules | On owner feedback |
| 4 | `spine/4-history.md` | What it has lived through: dated entries, lessons, corrections | Append-only, grows |

Rules of the spine:

- **Load order is 1 to 4.** Later layers refine earlier ones; none may
  contradict layer 1.
- **Layer 4 is append-only.** History is never rewritten, only extended.
  Each entry carries a date.
- **Tasks, credentials and permissions never live in the spine.** The spine
  is who the agent is, not what it is currently doing or allowed to touch.
- **One spine per agent.** Shared values belong in each agent's layer 1,
  not in a shared file — agents diverge, and that is the point.

## Use with Claude Code

Copy `skill/` to `~/.claude/skills/agentspine/`:

```
mkdir -p ~/.claude/skills/agentspine
cp skill/SKILL.md ~/.claude/skills/agentspine/SKILL.md
```

Then in any session:

- `/agentspine init` — scaffold the four layers for this agent
- `/agentspine` — load all layers into the current session, in order
- `/agentspine remember <text>` — append a dated entry to layer 4
- `/agentspine audit` — check layer sizes, order and append-only history

## Use with any other runtime

The spine is plain Markdown. Any agent runtime that can read files can load
`spine/1-identity.md` through `spine/4-history.md` at session start and
append to `4-history.md` when the owner teaches it something. The format is
the contract; the skill is just one loader.

## Why layers instead of one file

One big identity file rots: rules, moods and history blur together, and
every edit risks the whole. Layers separate what must stay stable (identity)
from what must stay current (history), so each can be maintained — and
reviewed — at its own pace.
