# Wrapper (v4.2)

> **Multi-Agent Coordination & Virtual Software Company Engine**  
> *Built for Claude Code, Antigravity, ChatGPT/Codex, Command Code, and OpenCode.*

Wrapper is a dependency-free, high-accuracy, low-token coordination engine and virtual software company runtime. It allows multiple AI coding agents from different vendors and CLIs to collaborate concurrently in the same workspace without collisions, duplicate work, hallucinated context, or fabricated test claims.

---

## Key Highlights

- **Zero External Dependencies**: Built entirely with Node.js built-ins (`node:sqlite` in WAL mode, `node:fs`, `node:crypto`, `node:child_process`, `node:util`).
- **Living Functional Specifications**: Replaces sprawling folder hierarchies with single-file, living atomic EARS specifications (`<feature>.spec.jsonl` + `<feature>.meta.json`) evolved in-place.
- **Symbol Interning (`_sym.json`)**: Compresses file paths and symbols on disk to save 68–75% tokens, while **automatically expanding** them back to real paths at prompt-injection time to eliminate hallucinated IDs.
- **Virtual Software Company & HR Matcher**: Preloaded founding staff (`emp-re` Requirement Engineer & `emp-hr` Human Resources) match requirements against employee profiles using a deterministic $\ge 80\%$ capability + XP score or hire human-named specialist archetypes (PM, Sigma-Designer, ECA-L3/L2/L1, QA, Maintenance).
- **Reputation Ledger & Anti-Lie Enforcement**: Agents start with $100$ points. Wins add $+5$, blind tests $+3$, bugs $-15$, and lies $-25$ to $-30$. Falling below $90$ triggers Probation; falling below $65$ or accumulating $2$ lies triggers Termination. Blunders are automatically copied into the squad's permanent `never_do[]` memory.
- **Blind TDD**: QA specialists author and lock failing tests first. Implementing engineers are mechanically blocked from tampering with locked test files.
- **Hash-Locked Execution Receipts**: `wrapper test` cryptographically binds the git working-tree hash, command stdout hash, and exit code into a tamper-evident receipt. Editing files after running a test invalidates the receipt (`LIE_FABRICATED`).
- **Cross-Tool PM Watchtower**: Monitors Claude Code (via native hooks), Antigravity (via CLI pulse), and external tools like ChatGPT/Codex (via worktree isolation and git audits).

---

## Architecture: The 3-Directory State Engine (`.wrapper/`)

When initialized in a project repository (`wrapper init --dir <repo>`), Wrapper creates three machine-compact directories:

```text
<repo>/.wrapper/
├── docs/                      # Directory 1: Living Documentation
│   ├── specs/                 # Living atomic EARS specs (<feat>.spec.jsonl + <feat>.meta.json)
│   ├── _sym.json              # Interned symbols & paths dictionary (saves 70% tokens)
│   ├── taste.jsonl            # CEO preferences & guidelines (.taste hook store)
│   └── deploy.json            # Two-way deployment links & verified spec status
├── agents/                    # Directory 2: Virtual Corporate Office & HR
│   ├── roster/                # Individual employee cards (<emp-id>.json)
│   ├── teams.jsonl            # Squad definitions, active leads, and team never_do[] rules
│   └── ledger/                # Append-only reputation point ledger (<emp-id>.jsonl)
└── track/                     # Directory 3: Task Execution & ACID SQLite Concurrency
    ├── track.db               # SQLite WAL store (spec_matrix, desks, file_leases, receipts, telemetry)
    ├── receipts.jsonl         # Append-only hash-locked execution receipts
    └── runs/                  # Per-agent WAL execution history
```

---

## Human-Readable Decoder

Everything inside `.wrapper/` is machine-compact JSON/JSONL and SQLite to minimize token overhead. Humans and LLMs can inspect any aspect in clear, decorated markdown at zero prompt penalty:

```bash
# Decode entire repository status
node bin/wrapper.mjs inspect all --dir .

# Inspect specific submodules
node bin/wrapper.mjs inspect spec --dir .
node bin/wrapper.mjs inspect roster --dir .
node bin/wrapper.mjs inspect teams --dir .
node bin/wrapper.mjs inspect matrix --dir .
node bin/wrapper.mjs scoreboard --dir .
```

---

## Core Workflows

### 1. Living Specifications & CEO Preferences
```bash
# Initialize living feature metadata (intent, scope radius)
node bin/wrapper.mjs re meta --feat checkout --goal "Atomic checkout flow" --own "sale/checkout.mjs"

# Upsert an atomic EARS requirement into the living spec
node bin/wrapper.mjs re upsert --feat checkout --id CK-01 --slice core \
  --when "calcTotal(price, qty)" --do "return price * qty; throw RangeError on negative qty" \
  --files "sale/checkout.mjs"

# Inspect surgical prompt slice with interned symbols expanded
node bin/wrapper.mjs re slice --feat checkout --req CK-01
```

### 2. HR Matching & Specialist Recruitment
```bash
# Evaluate requisition against roster (reuses employee at >= 80% match, or pauses for CEO clarification)
node bin/wrapper.mjs hr match --role eng --level L3 --domain checkout --tech node,javascript --files sale/checkout.mjs --ceo-confirmed

# List active staff and reputation standings
node bin/wrapper.mjs hr roster
```

### 3. Disjoint-File Scheduling & Blind TDD
```bash
# Partition requirements into file-disjoint parallel waves
node bin/wrapper.mjs pm schedule --feat checkout --tech node --level L2

# QA authors and read-only locks the blind acceptance test
node bin/wrapper.mjs blind-test --qa emp-003 --task TK-CK-01 --test tests/checkout.test.mjs

# Engineer runs tests and produces tamper-evident execution receipt
node bin/wrapper.mjs test --emp emp-002 --task TK-CK-01 --cmd "node --test tests/checkout.test.mjs"

# Submit completed task with receipt (validates tree hash, zero assertion deletions, no skip tags)
node bin/wrapper.mjs submit --emp emp-002 --task TK-CK-01

# Independent QA / PM verification (self-verification is mechanically rejected)
node bin/wrapper.mjs verify --by emp-003 --task TK-CK-01
```

### 4. Token-Capped Discussion Rooms
```bash
# Open a huddle room for architectural coordination
node bin/wrapper.mjs room open --topic "Checkout schema migration" --feat checkout --chair emp-pm

# Post turns (strictly capped at 280 characters to prevent prose bloat)
node bin/wrapper.mjs room say --room RM-001 --emp emp-002 --kind propose --body "Add currency_code VARCHAR(3) NOT NULL default 'BDT'."
node bin/wrapper.mjs room say --room RM-001 --emp emp-003 --kind agree --body "Approved. Blind tests updated."

# Close room with resolution
node bin/wrapper.mjs room close --room RM-001 --resolution "currency_code column approved"
```

---

## Cross-Tool Integration

### Claude Code
Install hooks with a single command:
```bash
node bin/wrapper.mjs install-hooks <repo-dir> --local
```
- **`PreToolUse`**: Enforces file leases, blocks edits by terminated agents, prevents tampering with locked blind tests (`LIE_TEST_TAMPER`), and flags out-of-radius drift.
- **`UserPromptSubmit`**: Captures CEO taste preferences into `taste.jsonl` (with automatic secret value filtering).
- **`Stop` / `SessionEnd`**: Blocks completion until pending cross-agent messages are addressed.

### Antigravity & Other Agents
```bash
# Start coordination session & background pulse
node bin/wrapper.mjs session --tool antigravity --task "Implement checkout logic"

# Sync turn updates and unread messages from other agents
node bin/wrapper.mjs sync --as <session-id>

# Claim task and advisory file leases
node bin/wrapper.mjs task claim T-1 --as <session-id>
node bin/wrapper.mjs claim sale/checkout.mjs --as <session-id>
```

---

## Testing

Wrapper includes an end-to-end integration test suite exercising the 3-directory layout, symbol compression, HR candidate scoring, blind TDD locking, anti-lie gates, probation/termination, SQLite WAL concurrency, git blame defect clawback, and external agent worktree audits:

```bash
npm test
```

All tests execute in temporary throwaway repositories under `os.tmpdir()` and never mutate existing project files.

---

## License

[Apache-2.0](LICENSE) © Darun Tech Private Limited
