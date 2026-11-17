# wrapper

**One shared board for every AI coding agent you run.**

You open Claude Code in one terminal, Antigravity in another, maybe Command Code or OpenCode in a third. They all edit the same workspace, and none of them knows the others exist. `wrapper` fixes that: they see each other, claim files, message each other, and hand work off, with no server and no dependencies.

- Zero npm dependencies, plain Node (`>= 22.5`, uses the built-in `node:sqlite`)
- State is local files. You can read it by just opening `LIVE.md`
- Works with Claude Code, Antigravity, Command Code, OpenCode, ChatGPT/Codex, or any tool that can run a shell command

> Built for my own daily workflow (4-5 agents in parallel across a multi-repo workspace). Open-sourced because the "agents stepping on each other" problem is not unique to me.

---

## What it does

### 1. Live session board (cross-IDE awareness)
Every agent joins the board. Each can see who else is active, what they are working on, and which files they hold.

```bash
node bin/wrapper.mjs session --tool antigravity --task "build login page"   # join
node bin/wrapper.mjs sync --as <id>      # heartbeat + new messages + what others changed
node bin/wrapper.mjs status              # full briefing
node bin/wrapper.mjs watch --as <id>     # live tail in its own terminal
```

`.agents/coord/LIVE.md` is an auto-refreshed, read-only view any tool can open.

### 2. Agent-to-agent messaging
Send a message to one session, to every session of one tool, to a domain specialist, or to everyone.

```bash
node bin/wrapper.mjs send --to antigravity "I changed the order API, rebase on it" --as <id> --ask
node bin/wrapper.mjs inbox --as <id>
```

In Claude Code, messages are injected automatically after each tool call, and a direct message blocks the agent from finishing until it has read it.

### 3. Tasks and file claims (no more collisions)
```bash
node bin/wrapper.mjs task add "fix refund cap" --service restaurant_backend --as <id>
node bin/wrapper.mjs task claim T-12 --as <id>
node bin/wrapper.mjs claim src/orders/ --as <id>      # exit 2 if another live agent holds it
node bin/wrapper.mjs task done T-12 --as <id> --note "what changed, how verified"
```
Sessions that go silent for 20 minutes are dropped, their file claims released and their in-progress tasks reopened.

### 4. Automatic for Claude Code (hooks)
One command installs hooks that handle session start, heartbeat, message delivery and file claims on their own. A `PreToolUse` hook claims files and asks you when there is a conflict or an out-of-scope edit.

```bash
node bin/wrapper.mjs install-hooks <repo-dir> --local
```

### 5. Background pulse for tools without hooks
A single detached process per workspace keeps hook-less sessions alive, watches the filesystem, and attributes each change to whoever holds the claim. Ambiguous changes are logged as "untracked" instead of guessed.

### 6. Domain agents: dispatch, don't duplicate
Define specialists in `.specify/agents.json`. Any lead agent can hand work to them.

```bash
node bin/wrapper.mjs agents                                   # list specialists
node bin/wrapper.mjs gen-agents                               # write Claude Code subagent files
node bin/wrapper.mjs dispatch backend_order_agent "add refund endpoint" --as <id>
```
`dispatch` creates a tagged task and prints a ready-to-paste brief (role, allowed paths, principles, drift guard) for any tool's subagent mechanism.

### 7. Never lose work (checkpoints)
When an agent ends, its changes are saved. In a git worktree it makes a commit of only that agent's files. In a shared checkout it writes a hidden snapshot ref (no branch, working tree or index change). Restore later with:

```bash
node bin/wrapper.mjs checkpoint restore <agent> --apply
```
Nothing is ever pushed.

### 8. Warn-only pre-commit check
`install-git-hook <repo-dir>` adds a hook that flags staged changes missing tests or manual notes. It prints warnings and never blocks a commit.

### 9. Handoff between sessions
`summary add "..."` and `handoff` produce `HANDOFF.md`, so the next session starts with what matters instead of from zero.

---

## v4: the "virtual software company" engine

Optional. `wrapper init --dir <repo>` creates a compact `.wrapper/{docs,agents,track}` state store.

| Part | What you get |
|---|---|
| **Living specs** | One permanent spec per feature (requirement lines with trigger, invariant, error codes, blast-radius files) instead of throwaway numbered spec folders |
| **Taste memory** | Your durable preferences are recorded once and the agents are told to flag requests that contradict them |
| **Requirement Engineer + HR skills** | Interviews you on ambiguity; HR scores existing agents (capability, domain, past file experience, level, reputation) and reuses one at >= 0.80, otherwise hires a specialist |
| **Wave scheduler** | Tasks that touch disjoint files run in parallel; tasks that share files are ordered automatically |
| **Blind TDD** | QA locks a failing test first; the implementer is blocked from editing it |
| **Hash-locked receipts** | `test` binds the git tree hash, exit code and output hash into a receipt; `submit` without a matching receipt counts as a fabricated claim |
| **Independent verify** | The author cannot approve their own work |
| **Reputation ledger** | Wins and "lies" are scored; repeat offenders go on probation, with blame traced through git |
| **PM sitrep + scoreboard** | A report of real accuracy across Claude Code, Antigravity and Codex workers |
| **Token-saving context** | Paths are interned on disk and expanded only when a prompt is built (`ctx`) |

---

## Quick start

```bash
git clone <this-repo> .agents/plugins/wrapper
node .agents/plugins/wrapper/bin/wrapper.mjs session --tool claude --task "my first task"
node .agents/plugins/wrapper/bin/wrapper.mjs status
```

For Claude Code, then run `install-hooks` once. For every other tool, tell the agent to follow `rules/AGENTS.md` (join with `session`, run `sync` every turn).

## Layout

```
bin/wrapper.mjs   CLI entry
lib/              board, pulse, checkpoint, check, v4 engine (specs, HR, scheduler, tracking)
rules/AGENTS.md   the protocol any agent follows
skills/           wrapper, requirement-engineer, hr, pm-monitor
presets/          roster archetypes and scoring weights
tests/            node test suites
```

## Status
Working and used daily by its author. Some v4 pieces (automatic test-per-function and doc-update hooks) are still manual. Issues and PRs welcome.

## License
Apache-2.0, see [LICENSE](LICENSE).
