# Wrapper Plugin: Multi-Agent Coordination & Virtual Software Company Rules (v4.2)

Applies to **every** coding agent in this workspace: Claude Code, Antigravity, Command Code, OpenCode, OpenRouter-based clients, anything else. The user runs 4-5 of them in parallel terminals. They share one board so nobody duplicates or collides, and they can talk to each other.

- **CLI** (all tools): `node .agents/plugins/wrapper/bin/wrapper.mjs <command>` (workspace root, or use the absolute path). Below, `W` means that command.
- **State**: `.agents/coord/board.json` (live, lock-protected). Read-only views any tool can just open: `.agents/coord/LIVE.md` (auto-refreshed), `HANDOFF.md` (last-session summary), `inbox/<your-id>.md` (your unread messages).
- **Claude Code** does sessions, heartbeat, messages and file tracking automatically through hooks. **Every other tool** follows the manual protocol in §2; a background *pulse* process covers their heartbeat and file-change tracking.

## 1. Roles

- **Supervisor = the user.** Final authority on requirements, trade-offs and drift. On ambiguity, schema mismatch or code drift: stop and ask the user. Never assume.
- **The coding tool you were launched in (Claude / Command Code / Antigravity / ...) is a peer lead.** No tool is master. A lead plans, coordinates and **delegates domain implementation to domain agents** (§4). Tiny cross-cutting fixes may be done directly.
- **Domain agents** are the specialists in `.specify/agents.json` (+ each product's own). They are launched *from* a lead tool as subagents and are children of that session.
- Agents coordinate through the board (tasks, claims, messages) and, for API shapes, through the SpecKit contract files. They never assume they can reach another agent any other way.

## 2. Session protocol (Antigravity, Command Code, OpenCode, others)

1. **First command of every session**: `W session --tool <yourtool> --task "<assignment>"`. Prints `SESSION_ID=<id>` and the board briefing (active sessions, tasks, claims, your inbox). This starts a session and the pulse (heartbeat + file watcher). Remember the id; use `--as <id>` (or `export WRAPPER_AGENT=<id>`).
2. **Every turn (before you start acting)**: `W sync --as <id>`. It refreshes your heartbeat and prints (a) messages sent to you, (b) what other sessions edited/noted/finished since your last sync. Cheap; when nothing is new it says so. You can also just open `.agents/coord/LIVE.md`.
3. **Before working**: `W task add "..." --service <dir> --as <id>` then `W task claim T-n --as <id>` (or claim an existing open task). If a live session already holds it, pick another or message them.
4. **Before editing files**: `W claim <path-or-dir> --as <id>`. Exit 2 = a live session holds it: do not edit; `W send` them or work elsewhere.
5. **Milestones**: `W note "<one line>" --as <id>`.
6. **Finish**: `W task done T-n --as <id> --note "<what changed, how verified>"`, then `W end --as <id>`. If unfinished: `task release`/`task block --note "why"` first, and `W summary add "<durable fact next session needs>"` for anything not derivable from code.

If you can run a second terminal, `W watch --as <id>` shows a live feed and doubles as your heartbeat.

## 3. Talking to other sessions

- `W send --to <target> "text" --as <id> [--ask]`. Targets: a session id (`claude-ab12cd`), a **tool** (`antigravity` = every Antigravity session), a **domain agent id** (`backend_restaurant_order_agent`), or `all`. `--ask` marks that you want a reply.
- Read replies with `W sync` / `W inbox --as <id>`. **Claude Code** gets messages injected after each tool call, and a direct message blocks it from finishing until read. Others see them on `sync`.
- Use messages for coordination ("I changed X, rebase on it", "which shape do you need?"). **API/data contracts still go into `.specify/memory/cross_agent_contract.json`** so they persist; message only to point at them.
- Don't spam broadcasts; one line, actionable.

## 4. Domain agents: launch them, don't do their work

- `W agents` lists the specialists (tag, scope, role). Pick by task tag (`[BE-REST-ORDER]`, `[FE-REST-POS]`, ...).
- **Claude Code**: subagent files are generated in `.claude/agents/` (`W gen-agents`); invoke with the Agent tool, `subagent_type: "backend-restaurant-order-agent"`. Hooks auto-register the subagent as `claude-<sess>/<agent>` under your session, warn if it edits outside its `allowed_paths`, and end it when it stops.
- **Antigravity / Command Code / others**: `W dispatch <domain-agent-id> "task" --as <id>` creates a tagged task, notifies that agent id, saves `.agents/coord/dispatch/T-n-<agent>.md`, and prints a complete brief (role, allowed paths, constitution principles, responsibilities, specs, drift guard, coordination steps). Pass that brief to your tool's subagent mechanism (`invoke_subagent`, task tool, or a fresh terminal session). The subagent registers with `W session --tool <tool> --domain <agent-id> --parent <your-id>`.
- After dispatching, don't edit that domain's files yourself; wait for its `send`/`task done`, then verify.
- Drift guard: a domain agent that finds existing code contradicting the spec stops, does not edit, and reports to its parent, who asks the user.

## 5. Heartbeat, pulse and change tracking (how it works)

| Layer | Who | What |
|---|---|---|
| Hook heartbeat | Claude Code | `SessionStart`/`UserPromptSubmit`/`PostToolUse`/`Stop` refresh the session, deliver messages + others' changes; `PreToolUse` claims files and asks the user on conflicts or out-of-scope edits |
| Pulse | Any tool that ran `session` | One detached background process per workspace (`W pulse status|stop`): beats every 15 s for hook-less sessions, watches the filesystem, and attributes each change to the claim holder (or the only session working in that directory), else logs it as "untracked/ambiguous". Exits after ~5 min with no live sessions |
| `sync` / `LIVE.md` | All tools | On-demand delivery of messages and change feed |

Sessions with no activity for 45 min stop being vouched for; with no heartbeat for 20 min they are dropped, their file claims released and their in-progress tasks reopened. Claims are advisory.

## 6. Hooks setup (Claude Code)

Installed in `.claude/settings.json` (workspace root) and each sub-repo's gitignored `.claude/settings.local.json` (Claude only reads project settings from the directory it starts in; the local file keeps this machine's absolute paths out of git). New/moved repo: `W install-hooks <repo-dir> --local` (merge-safe, idempotent). Re-run after upgrading the plugin so new hook events are added. Hooks never fail a session on internal errors.

## 7. Isolation and contracts

- Frontend agents do not read backend Python; they consume the contract file. Backend agents don't edit each other's apps.
- The repo's code is the source of truth. Each product's `.specify/memory/constitution.md` is authoritative for that product.
- Each product is its own git repo (no root `.git`); work inside the product directory.

## 8. SpecKit lifecycle

Constitution -> `speckit-specify` -> `speckit-clarify` -> `speckit-plan` -> `speckit-tasks` -> `speckit-implement` -> verify -> PR (`[GIT-PR-CREATE]`) -> review/deploy (`[GIT-PR-REVIEW-DEPLOY]`; merge only with explicit user approval). Tasks carry domain tags from the agents files. Active feature: `.specify/feature.json`.

## 9. Etiquette

- Small tasks, named by service (`--service restaurant_backend`); one session per service directory when possible.
- Never touch another session's claimed path, never force-push, never delete `.agents/coord/board.json` (use `summary`/`task` commands).
- Never push to `deploy/backend` by hand; see the root `CLAUDE.md` deploy policy.

## 10. Taste and built-ins first (trial, from 2026-10-16)

Plan: `.agents/coord/PLAN-2026-10-16-wrapper-launch.md` (§5, §7a). Applies to every agent in this workspace.

**Taste.** If `TASTE.md` exists at the workspace root, read its approved sections (not the Inbox) before you start work.
- If a request, or a change you are about to make, differs from an approved entry, **say so before acting**: name the entry and ask "new preference, or a one-time exception?". Never follow either side silently. In an autonomous run with nobody to ask, keep the existing preference, write the difference down as a question (`note`), and continue with the rest.
- Entries marked as learned guesses (Command Code, below 0.7 confidence) are not the owner's word: cite them with their confidence and ask. Entries under `## Rejected` are never applied.

**Built-ins first.** Before writing new code, stop at the first rung that fully does the job:
1. Is it needed at all? Do what the task asks; name anything you skipped in one line.
2. Is it already in this project (shared helpers, base classes, `@darun/core`, the design system)? Utilities, services, hooks and the design system only; do not go looking for screen components to reuse.
3. Is it built into the language, framework or platform (Python stdlib, Django/DRF, the web platform)? Only if it works in Chrome, Safari and Edge and on the repo's Python/Node versions.
4. Is it in an already-installed dependency? Adding a dependency needs a one-line reason in the task note.
5. Can it be one readable line?
6. Otherwise write the minimum, and mark it `# wrapper: handwritten (why nothing above fits)` (`//` in JS).

Be lazy about the solution, never about the change: callers, tests and docs are still done. Never cut: tenant isolation, ids from the JWT (never `business_id`/`user_id` from the request), pagination caps, soft-delete filters, Asia/Dhaka day boundaries, validation at trust boundaries, data-loss handling, security, accessibility.

**Not yet automatic.** The hooks, tests-per-function, doc updates and checkpoints described in the plan are being built; until they ship, follow this section by hand.

## 11. Virtual Software Company & Living Functional Specs (v4.2 `.wrapper/` Engine)

When a repository is initialized with `W init --dir <repo>`, Wrapper manages a compact, machine-optimized three-directory state engine inside `<repo>/.wrapper/` (decode anytime via `W inspect --dir <repo>`):

1. **`.wrapper/docs/` (Documentation Keeping)**:
   - One permanent living spec per functionality (`docs/specs/<feat>.spec.jsonl` + `<feat>.meta.json`), updated via `W re upsert` / `W re meta`. Symbol interning (`docs/_sym.json`) compresses paths on disk and expands them automatically at prompt time (`W ctx` / `W re slice`).
   - CEO preferences captured via `.taste` (`docs/taste.jsonl`; never store secret values).
   - `.deployment` (`docs/deploy.json`) keeps automatic two-way links with shipped specs.
2. **`.wrapper/agents/` (Agent Keeping — RE, HR, Squads & Reputation)**:
   - Founding staff: `emp-re` (Requirement Engineer) and `emp-hr` (HR).
   - HR (`W hr match`) scores active roster capabilities + prior `xp.hf` file touches; reuses at `>= 0.80`, asks CEO on ambiguity, or hires human-named specialists (`PM`, `Sigma-Designer`, `ECA-L3/L2/L1`, `Maintenance`, `QA`).
   - Reputation ledger (`100` start; `<90` Probation; `<65` or `2 lies` Terminated, copying blunders into team `never_do[]`). Include `Agent-Id: <emp-id>` in commits for `W blame` attribution.
3. **`.wrapper/track/` (Concurrent SQLite WAL, Blind TDD, Receipts & PM Monitor)**:
   - `W pm schedule` partitions requirements into file-disjoint parallel waves (`_wt/<handle>` worktrees optional).
   - **Blind TDD**: QA locks blind failing tests first (`W blind-test`); implementing engineers NEVER edit locked blind tests (`LIE_TEST_TAMPER -30 pts`).
   - **Anti-Lie Receipts**: Run `W test --emp <id> --task <TK-id> --cmd "..."` before `W submit`; fabricated or stale `tree_hash` claims incur `LIE_FABRICATED (-25 pts)`. Independent QA/PM runs `W verify` for `100%` completion.
