---
name: "wrapper"
description: "Multi-agent coordination & Virtual Software Company engine (v4.2) for Claude Code, Antigravity, Command Code, ChatGPT/Codex, and OpenCode. Preserves the v3 live session board (.agents/coord/board.json) AND adds the v4.2 three-directory machine-compact engine (.wrapper/{docs,agents,track}) with living functional specs, preloaded RE/HR/PM skills, >=80% capability matching, Blind TDD, hash-locked test receipts, reputation points/lies, and cross-tool PM monitoring."
argument-hint: "Command or SpecKit phase (init, re, hr, pm, desk, test, submit, verify, inspect, scoreboard, specify, plan, implement)"
compatibility: "Node >= 22.5 (uses built-in node:sqlite WAL, zero external npm dependencies)"
metadata:
  author: "Darun Tech Private Limited"
  source: "plugins/wrapper"
  version: "4.2.0"
user-invocable: true
disable-model-invocation: false
---

## Step 0 — Always: join the workspace coordination board (every session)

```bash
node .agents/plugins/wrapper/bin/wrapper.mjs session --tool <yourtool> --task "<assignment>"
node .agents/plugins/wrapper/bin/wrapper.mjs sync --as <id>   # run EVERY turn
```

Follow `rules/AGENTS.md` for live session etiquette (`task claim`, `claim <path>`, `send`, `note`, `task done`, `end`).

---

## Wrapper v4.2: Three-Directory Machine-Compact Architecture (`.wrapper/`)

Inside any target repository initialized with `wrapper init --dir <repo>`, all state lives in **strictly three machine-compact directories** (decoded for humans anytime via `wrapper inspect`):

1. **`.wrapper/docs/` (Documentation Keeping)**:
   - `_sym.json`: Path/symbol interning table on disk, automatically expanded back to real file paths at prompt injection (`ctx` / `re slice`) so LLMs never hallucinate opaque IDs.
   - `specs/<feature>.spec.jsonl` + `<feature>.meta.json`: **One permanent living spec per functionality** (`auth`, `product`, `sale`...) evolving atomic EARS lines in place instead of spawning new folders.
   - `taste.jsonl`: Fed by `.taste` hook & CEO Q&A (`inbox` / `approved` / `rejected`, zero secrets).
   - `deploy.json`: Machine `.deployment` contract with automatic **two-way links** to shipped specs.
2. **`.wrapper/agents/` (Agent Keeping — Virtual Corporate Office)**:
   - Preloaded Founding Staff: **Farhana Karim (`emp-re`, Requirement Engineer)** and **Tariq Mahmud (`emp-hr`, HR)**.
   - Specialist Archetypes (`archetypes.json`): `PM`, `Sigma-Designer`, `ECA-L3`, `ECA-L2`, `ECA-L1`, `Maintenance`, `QA`.
   - `roster/<emp-id>.json` & `teams.jsonl`: Full human identity (`name`, `handle`, `title`, `jd`), capabilities, personal instructions/patterns/taste, career `xp.hf` hot-files, and reputation score (`100` start; `<90` Probation; `<65` or `2 lies` Terminated -> blunder copied to squad `never_do[]`).
   - **Deterministic `>= 80%` HR Reuse**: Reuses existing staff when capability + file-XP score `>= 0.80`; otherwise reviews RE's requisition, asks CEO on ambiguity, hires, and persists JSON config.
3. **`.wrapper/track/` (Concurrent Execution, Spec-vs-Agent Matrix & Anti-Lie Engine)**:
   - Backed by Node built-in `node:sqlite` (`track.db` in `WAL` mode) + compact JSON/JSONL snapshots (`matrix/`, `desks/`, `runs/`, `locks/`, `rooms/`, `receipts.jsonl`).
   - **Spec-vs-Agent Mechanical %**: `0% open -> 25% claimed/blind_test_locked -> 50% coded -> 80% green tree_hash receipt -> 100% independent QA/PM verified`.
   - **Anti-Lie Guards**: Blind TDD read-only test locks (`LIE_TEST_TAMPER -30`), `tree_hash`-bound test receipts (`LIE_FABRICATED -25`), `git blame` regression clawback (`BUG_INTRODUCED -15`), and structured 280-char huddle rooms (`room open|say|close`).

## Preloaded Specialist Skills

- **Requirement Engineer (`RE`)**: `.agents/plugins/wrapper/skills/requirement-engineer/SKILL.md`
- **Human Resources (`HR`)**: `.agents/plugins/wrapper/skills/hr/SKILL.md`
- **Team PM & Cross-Tool Monitor (`PM`)**: `.agents/plugins/wrapper/skills/pm-monitor/SKILL.md`

## Quick v4.2 Command Reference (`W = node .agents/plugins/wrapper/bin/wrapper.mjs`)

| Area | Commands |
|---|---|
| Bootstrap & IDE | `W init [--dir D] [--copilot]` · `W ide sync [--dir D]` |
| Living Specs (`RE`) | `W re list` · `W re meta --feat F ...` · `W re upsert --feat F --id ID --when W --do DO --files ...` · `W re slice --feat F [--req ID]` |
| Taste & Deploy | `W taste record|approve|reject|list` · `W deploy sync` · `W deploy link --feat F` |
| Talent & Ledger (`HR`) | `W hr match ...` · `W hr hire ...` · `W hr roster [--expand]` · `W hr card <id>` · `W hr points ...` · `W blame --file F --line N` |
| DAG & Watchtower (`PM`) | `W pm schedule --feat F [--worktrees]` · `W pm sitrep` · `W pm pushback ...` · `W pm audit --emp E --tool chatgpt` |
| Execution & Gates | `W blind-test --qa Q --task T --file F` · `W ctx --emp E` · `W test --emp E --task T --cmd "..."` · `W submit --emp E --task T` · `W verify --verifier Q --task T` |
| Rooms & Reporting | `W room open|say|close` · `W scoreboard` · `W inspect [all\|docs\|agents\|track]` |
