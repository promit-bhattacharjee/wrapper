# Adapters: using wrapper with each tool

Two paths work for every tool:

1. **Launch it through wrapper**: `wrapper run <tool> -- <command>`. Joins the board, starts the pulse, sets `$WRAPPER_AGENT`, prints a monitor report when the tool exits, then ends the session and saves a checkpoint. No hooks needed.
2. **Give it the rules**: `wrapper adapt <tool>` writes the short board protocol into the file that tool reads (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`).

| Tool | Launch | Instruction file | Hooks / hard blocking | Monitor |
|---|---|---|---|---|
| Claude Code | `wrapper setup` (hooks), or `wrapper run claude -- claude` | `CLAUDE.md` | Yes (messages, claims, edit denial) | hooks + pulse |
| Codex | `wrapper run codex -- codex` | `AGENTS.md` | No | pulse + run report |
| OpenCode | `wrapper run opencode -- opencode` | `AGENTS.md` | No | pulse + run report |
| Command Code | `wrapper run commandcode -- commandcode` | `AGENTS.md` (not verified by the author) | No | pulse + run report |
| Antigravity | `wrapper session --tool antigravity` | `GEMINI.md`, `AGENTS.md` | No | pulse |
| Any other tool | `wrapper run <name> -- <command>` | `AGENTS.md` (paste into the tool's rules if it reads another file) | No | pulse + run report |

## What has been verified
Launch through `wrapper run <tool> --isolate -- <tool> --version` on Windows (11, Node 25), using the real installed CLIs: **Claude Code 2.1.327, OpenCode 2.0.23, Gemini CLI 0.45.0, Command Code 1.75.0**. This proves the launch path (npm `.cmd` shims, argument quoting, worktree creation and cleanup). It does **not** prove a full interactive agent session. **Codex** was not installed on the test machine and is untested.

On Windows, `cmd` is the system shell, not Command Code. Use `commandcode`.

## Make it the default
```bash
wrapper config set isolate always     # every `wrapper run` uses its own worktree (opt out with --no-isolate)
wrapper config set copy .env          # copy local config into the worktree (never committed)
wrapper aliases                       # prints shell functions so `codex`, `opencode`... start through wrapper
```
`node_modules` is linked into the worktree automatically (override with `config set link a,b` or `--link a,b`).

## Default monitoring
Every session started through `session` or `run` gets the background **pulse**: it keeps the session alive, watches the workspace, and attributes each file change to the session holding the claim (ambiguous changes are logged as untracked, never guessed). `wrapper run` adds a **monitor report** on exit: files changed during the run, claims held, unread messages, and files edited without a claim.

## Limits
Only Claude Code can have an edit refused before it happens. For every other tool, `wrapper run <tool> --isolate -- <command>` gives real collision prevention: the tool works in its own git worktree and branch, so it physically cannot overwrite another agent's files. Conflicts appear at `wrapper integrate` time. Without `--isolate`, the monitor only tells you afterwards.
