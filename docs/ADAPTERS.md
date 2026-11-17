# Adapters: using wrapper with each tool

Two paths work for every tool:

1. **Launch it through wrapper**: `wrapper run <tool> -- <command>`. Joins the board, starts the pulse, sets `$WRAPPER_AGENT`, prints a monitor report when the tool exits, then ends the session and saves a checkpoint. No hooks needed.
2. **Give it the rules**: `wrapper adapt <tool>` writes the short board protocol into the file that tool reads (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`).

| Tool | Launch | Instruction file | Hooks / hard blocking | Monitor |
|---|---|---|---|---|
| Claude Code | `wrapper setup` (hooks), or `wrapper run claude -- claude` | `CLAUDE.md` | Yes (messages, claims, edit denial) | hooks + pulse |
| Codex | `wrapper run codex -- codex` | `AGENTS.md` | No | pulse + run report |
| OpenCode | `wrapper run opencode -- opencode` | `AGENTS.md` | No | pulse + run report |
| Command Code | `wrapper run commandcode -- cmd` | `AGENTS.md` (not verified by the author) | No | pulse + run report |
| Antigravity | `wrapper session --tool antigravity` | `GEMINI.md`, `AGENTS.md` | No | pulse |
| Any other tool | `wrapper run <name> -- <command>` | `AGENTS.md` (paste into the tool's rules if it reads another file) | No | pulse + run report |

## Default monitoring
Every session started through `session` or `run` gets the background **pulse**: it keeps the session alive, watches the workspace, and attributes each file change to the session holding the claim (ambiguous changes are logged as untracked, never guessed). `wrapper run` adds a **monitor report** on exit: files changed during the run, claims held, unread messages, and files edited without a claim.

## Limits
Only Claude Code can have an edit refused before it happens. For other tools the monitor tells you afterwards.
