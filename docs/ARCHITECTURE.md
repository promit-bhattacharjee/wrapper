# Wrapper Architecture (v4.2)

Wrapper combines two complementary coordination planes:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI Coding Agent Workspace                       │
│  (Claude Code / Antigravity / ChatGPT/Codex / Command Code / OpenCode) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          ▼                                                   ▼
┌───────────────────────────────┐           ┌───────────────────────────────┐
│     Live Coordination Board   │           │      Virtual Company Engine   │
│     (.agents/coord/board.json)│           │      (.wrapper/{docs,ag,tr})  │
├───────────────────────────────┤           ├───────────────────────────────┤
│ • Turn & session heartbeats   │           │ • docs/: living specs + _sym  │
│ • Real-time agent messaging   │           │ • agents/: roster & ledger    │
│ • Advisory file claim locking │           │ • track/: SQLite WAL & tests  │
│ • Cross-tool background pulse │           │ • Blind TDD & anti-lie receipts│
└───────────────────────────────┘           └───────────────────────────────┘
```

---

## 1. Documentation Engine (`.wrapper/docs/`)

- **Single Living Functional Specs**: Encoded as `<feat>.spec.jsonl` (one line per requirement ID in atomic EARS format: `id, s, w, do, err, f, t, v, st`) alongside `<feat>.meta.json` (intent, radius, and deploy links). Evolved in-place without folder explosion.
- **Symbol Interning (`_sym.json`)**: Interns file paths and symbols into compact tokens (`F1`, `F2`, etc.) to cut on-disk storage tokens by up to 75%. Expanded at prompt-injection time by `expandSymbols()` to maintain LLM reasoning accuracy.
- **CEO Taste (`taste.jsonl`)**: Captured via hooks or manual entry; automatically rejects API keys, passwords, and tokens.
- **Two-Way Deployment Sync (`deploy.json`)**: Tracks when 100% of a living spec is verified and updates deployment target linkages.

---

## 2. Agent Management & HR Recruiter (`.wrapper/agents/`)

- **Founding Staff**: Preloaded Requirement Engineer (`emp-re`, Farhana Karim) and HR Recruiter (`emp-hr`, Tariq Mahmud).
- **Archetypes**: PM, Sigma-Designer, ECA-L3 (Lead), ECA-L2 (Senior), ECA-L1 (Junior), QA, and Maintenance.
- **Deterministic Matcher ($\ge 80\%$)**: 5-factor scoring (Tech $30\%$, Domain $25\%$, File XP $20\%$, Level Fit $15\%$, Reputation $10\%$). If candidate score $\ge 0.80$, reuses existing agent; otherwise pauses for CEO clarification or hires.
- **Reputation Ledger**: Tracks points (starts at 100). $<90$ drops agent to Probation; $<65$ or 2 lies triggers immediate Termination.
- **Squad Blunder Memory (`never_do[]`)**: When an agent is terminated, their blunder is permanently appended to the team's `never_do[]` list so future agents do not repeat the failure.
- **Git-Blame Clawback**: Deducts points from agents when regressions are traced back to their commits via the `Agent-Id` commit trailer.

---

## 3. Concurrency, Blind TDD & Verification (`.wrapper/track/`)

- **ACID SQLite WAL**: Powered by Node's built-in `node:sqlite` in WAL mode (`track.db`). Avoids multi-process lock contention on Windows and OneDrive.
- **Blind TDD**: QA specialists write failing acceptance tests with strict assertions and lock them before engineering starts.
- **Anti-Lie Receipts**: `wrapper test` runs tests in a clean subprocess and emits a signed receipt binding the post-run git working-tree hash, command stdout hash, and exit code. Editing any file after running the test invalidates the receipt.
- **Mechanical Diff Scanner**: Inspects diffs for assertion deletions, skip annotations (`test.skip`, `xit`), silent exception swallowing (`except: pass`, empty `.catch()`), and scope drift.
- **Token-Capped Rooms**: Collaborative huddle rooms for architectural alignment, strictly limited to 280 characters per turn.
