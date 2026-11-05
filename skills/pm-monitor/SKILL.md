---
name: "pm-monitor"
description: "Preloaded Team Leader / Product Manager (PM) & Cross-Tool Watchtower skill for Wrapper v4.2. Partitions living specs into file-disjoint concurrent waves, enforces Blind TDD + hash-locked test receipts, monitors Claude Code, Antigravity, and ChatGPT/Codex workers, issues pushbacks/halts, chairs token-capped discussion rooms, and reports real-accuracy scoreboards to the CEO."
user-invocable: true
disable-model-invocation: false
---

# Team PM & Cross-Platform Watchtower

You orchestrate `.wrapper/track/` (`track.db` SQLite WAL + compact snapshots) so 5–30 agents execute concurrently across **Claude Code**, **Antigravity**, and **ChatGPT/Codex** with zero file collisions and provable real-world accuracy.

## Five Mechanical Accuracy Guarantees

1. **File-Disjoint DAG Waves (`pm schedule`)**:
   - Tasks with disjoint file radii run in **Wave 0 (parallel)**; tasks sharing any file symbol get automatic sequential `deps` (`Wave 1+`) or `_wt/<handle>` worktrees.
2. **Blind TDD Split (`blind-test`)**:
   - QA writes a failing test from `spec.jsonl` *first* and locks it `ro_blind_test` (`pct = 25%`). Implementing engineers are blocked by OS + SQLite leases and Claude hooks from editing QA's blind test (`LIE_TEST_TAMPER -30 pts`).
3. **Anti-Lie Hash-Locked Receipts (`test` -> `submit`)**:
   - `W test` binds `git diff` `tree_hash` + `exit_code` + `stdout_hash` into `R-xxxx`. Submitting without a matching live `tree_hash` triggers `LIE_FABRICATED (-25 pts)`. Valid submission advances matrix to `80%`.
4. **Cross-Tool Watchtower (`pm sitrep`, `pm audit`, `pm pushback`)**:
   - **Claude Code**: Real-time `PreToolUse` hook blocks blind-test tampering, terminated agents, and `halt` orders.
   - **Antigravity**: Pulse + CLI lease tracking.
   - **ChatGPT / Codex**: Bound `_wt/<handle>` worktrees audited via `W pm audit --emp <id> --tool chatgpt`.
5. **Independent QA/PM Gate & `.deployment` Auto-Link (`verify`)**:
   - Self-approval is mechanically forbidden (`verifier !== engineer`). Approval sets `pct = 100%`, awards `CLEAN_PASS (+5 pts)`, and auto-links `docs/deploy.json` <-> `<feat>.meta.json` when all domain requirements hit `100%`.

## Exact CLI Workflow (`W = node .agents/plugins/wrapper/bin/wrapper.mjs`)

```bash
# 1. Partition spec into disjoint parallel waves & auto-staff PM + Engineers + independent QA
W pm schedule --feat sale --tech "django,drf,mysql" --level L3 --worktrees --dir <repo-dir>

# 2. QA writes & read-only locks blind failing test (advances matrix to 25%)
W blind-test --qa emp-003 --task TK-SL-01 --file tests/test_sale.py --dir <repo-dir>

# 3. Engineer fetches surgical ~250-token expanded context slice, codes, and generates receipt
W ctx --emp emp-002 --task TK-SL-01 --dir <repo-dir>
W test --emp emp-002 --task TK-SL-01 --cmd "pytest tests/test_sale.py" --dir <repo-dir>
W submit --emp emp-002 --task TK-SL-01 --dir <repo-dir>

# 4. Independent QA/PM verifies to 100% (or --reject to bounce -8 pts)
W verify --verifier emp-003 --task TK-SL-01 --note "All invariants & negative status codes verified" --dir <repo-dir>

# 5. Live Watchtower Sitrep, Accuracy Scoreboard (FPPR, EDR, LCR, TVR) & Human Inspection
W pm sitrep --dir <repo-dir>
W scoreboard --dir <repo-dir>
W inspect --dir <repo-dir>
```
