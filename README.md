# wrapper

[![test](https://github.com/promit-bhattacharjee/wrapper/actions/workflows/test.yml/badge.svg)](https://github.com/promit-bhattacharjee/wrapper/actions/workflows/test.yml) ![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22.13-green)

**One shared board for every AI coding agent you run.**

You open Claude Code in one terminal, Antigravity in another, maybe Command Code or OpenCode in a third. They all edit the same workspace, and none of them knows the others exist. `wrapper` fixes that: they see each other, claim files, message each other, and hand work off, with no server and no dependencies.

- Zero npm dependencies, plain Node (`>= 22.13`, uses the built-in `node:sqlite`)
- State is local files. You can read it by just opening `LIVE.md`
- Works with Claude Code, Antigravity, Command Code, OpenCode, ChatGPT/Codex, or any tool that can run a shell command

> Built for my own daily workflow (4-5 agents in parallel across a multi-repo workspace). Open-sourced because the "agents stepping on each other" problem is not unique to me.

---

## Quick start

Requires Node >= 22.13 (`node --version`).

```bash
cd your-project
git clone https://github.com/promit-bhattacharjee/wrapper .agents/plugins/wrapper
node .agents/plugins/wrapper/bin/wrapper.mjs setup          # Claude Code hooks + git pre-commit check
node .agents/plugins/wrapper/bin/wrapper.mjs session --tool claude --task "my first task"
node .agents/plugins/wrapper/bin/wrapper.mjs status         # or just open .agents/coord/LIVE.md
```

For Claude Code, `setup` is all you need. For every other tool, tell the agent to follow `rules/AGENTS.md` (join with `session`, run `sync` every turn).
Installed somewhere else? Set `WRAPPER_ROOT=/path/to/your/workspace` so the board is created there.
`node bin/wrapper.mjs help` lists every command.

---

## The basics

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
`setup` (or `install-hooks`) installs hooks that handle session start, heartbeat, message delivery and file claims on their own. A `PreToolUse` hook claims files and asks you when there is a conflict or an out-of-scope edit.

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

### File memory: which file is for what
Every file an agent edits gets one entry: up to 15 keywords (extracted automatically from function names, headings, routes and error codes, no AI call) plus one line, and the tasks and agents that touched it. Agents look things up instead of searching the repo.

```bash
node bin/wrapper.mjs where "refund cap"        # top 5 files, about 100 tokens
node bin/wrapper.mjs who src/orders/refund.js  # which tasks and agents changed it
node bin/wrapper.mjs map --task T-12           # files linked to a task
node bin/wrapper.mjs map set <path> "one line" # write or fix a line by hand
node bin/wrapper.mjs map scan [dir]            # index existing files in one pass (run once on day one)
node bin/wrapper.mjs map prune                 # drop entries for deleted files
```
Edits are recorded by the Claude Code hook and by the pulse for other tools. `task done --note "..."` becomes the line for every file the task touched. When a file changes after its line was written, the entry is flagged `(stale)` instead of showing a wrong description. `.env`, keys, lock files and build output are never indexed. `task claim` prints the files most likely involved.

### Something not working? Run the doctor
```bash
node bin/wrapper.mjs doctor
```
Read-only check of Node and `node:sqlite`, the board, the pulse, Claude Code hooks, the pre-commit check and instruction files. Every problem comes with the command that fixes it (`--json` for scripts, exit code 1 on failure).

### Collision-proof mode for any tool: `--isolate`
```bash
cd my-repo
node bin/wrapper.mjs run codex --isolate -- codex     # Codex works in its own worktree + branch
node bin/wrapper.mjs integrate wrapper/codex          # when ready: merge it (aborts cleanly on conflict)
```
The tool cannot overwrite other agents' files because it is not editing the same files: it works in a private worktree under `.wrapper/worktrees/`. When it exits, wrapper commits its work to `wrapper/<id>` (secrets like `.env` are never committed), warns about files that also changed on your main checkout, and removes the worktree. Nothing is pushed and your main checkout is not touched until you run `integrate`. If isolation cannot be set up (not a git repo, no commits), `run` stops instead of running the tool unprotected.

Make it the default so you never forget the flag, and give the worktree what it needs to run:
```bash
node bin/wrapper.mjs config set isolate always   # opt out per launch with --no-isolate
node bin/wrapper.mjs config set copy .env        # copied into the worktree, never committed
node bin/wrapper.mjs aliases                     # shell functions so plain `codex` / `opencode` go through wrapper
```
`node_modules` is linked into the worktree automatically (your real folder is never deleted or modified). Settings live in `wrapper.config.json`.

### Works with every tool
```bash
node bin/wrapper.mjs run codex -- codex          # Codex, OpenCode, Command Code, or any CLI agent
node bin/wrapper.mjs adapt opencode              # write the board rules into AGENTS.md / CLAUDE.md / GEMINI.md
```
`run` joins the board, starts the monitor, passes the session id to the tool as `$WRAPPER_AGENT`, and on exit prints what changed, then ends the session. See [docs/ADAPTERS.md](docs/ADAPTERS.md) for the per-tool table.

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

## Advanced (optional): enforcement, reputation and the v4 engine

Everything above works on its own. The rest builds a stricter "virtual software company" on top of it.

### Hard enforcement (Claude Code)
The pre-edit hook does not just advise, it can deny the edit:

| Code | Blocked because |
|---|---|
| `TERMINATED` | the agent's reputation fell below the limit |
| `PM_HALT` | the team PM issued a halt order |
| `LIE_TEST_TAMPER` | the agent tried to edit a locked blind test |
| `LEASE_CONFLICT` | another agent holds a lease on that file |
| `SCOPE_DRIFT` | the file is outside the task's allowed files (asks you first) |

```bash
node bin/wrapper.mjs pm pushback --emp <id> --severity halt --msg "stop, wrong branch"
node bin/wrapper.mjs pm ack --emp <id>
node bin/wrapper.mjs pm audit --emp <id> --tool chatgpt   # audit a worker that has no hooks
node bin/wrapper.mjs pm sitrep                            # team status report
```

### Parallel waves, leases and worktrees
`pm schedule` splits a feature's requirements into waves: tasks touching different files run in parallel, tasks sharing a file are ordered. `desk lease` locks a file (on disk and in the database), and `desk worktree` gives an agent its own git worktree.

### Reputation, no self-approval
Every agent starts at 100 points. A clean verified pass is +5, a caught defect +4. A scope drift is -5, a QA bounce -8, a bug traced to the agent's commit -15, a fabricated test claim -25, tampering with a test -30. Below 90 is probation; below 65 or two lies is termination, and the agent's mistakes are added to the team's "never do" list. The author of a change can never verify it. `blame` traces a bug to the commit's `Agent-Id:` trailer, and `scoreboard` shows real accuracy per agent.

### Discussion rooms and targeted context
`room open | say | close` holds a short agent discussion (each turn capped at 280 characters) that ends in a recorded decision. `ctx --emp <id>` gives an agent only the slice of the spec it needs. `ide` writes short instruction files for several tools (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, optionally Copilot's).

### The v4 engine

`wrapper init --dir <repo>` creates a compact `.wrapper/{docs,agents,track}` state store.

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

## Layout

```
bin/wrapper.mjs   CLI entry
lib/              board, pulse, checkpoint, check, v4 engine (specs, HR, scheduler, tracking)
rules/AGENTS.md   the protocol any agent follows
skills/           wrapper, requirement-engineer, hr, pm-monitor
presets/          roster archetypes and scoring weights
tests/            node test suites
```

## Limits (read before you rely on it)
- **Edit refusal before it happens works in Claude Code only.** For other tools, use `run --isolate` (each agent gets its own git worktree, so it cannot overwrite another agent's files; collisions show up at merge time). Without `--isolate` they follow `rules/AGENTS.md` voluntarily and wrapper reports afterwards.
- `--isolate` needs a git repo with at least one commit, and two agents that change the same file still produce a merge conflict you resolve.
- Reputation weights and thresholds are untuned defaults from a single workspace. Treat scores as a signal, not a verdict.
- Some v4 pieces (automatic test-per-function and doc-update hooks) are still manual.
- Developed and used on Windows; CI runs Linux and Windows on Node 22.13 and 24.

## Status
Working and used daily by its author. Issues and PRs welcome, especially from people running it on other setups.

## License
Apache-2.0, see [LICENSE](LICENSE).
