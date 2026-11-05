# Wrapper Hooks Integration

Wrapper hooks integrate directly into Claude Code lifecycle events (and similar AI agent runners) to protect files, capture preferences, and guarantee cross-agent communication.

Install with:
```bash
node bin/wrapper.mjs install-hooks <target-directory> --local
```

---

## Supported Lifecycle Events

| Event | Action in Wrapper |
|---|---|
| `SessionStart` | Registers agent session, provides workspace orientation brief, and assigns unique session ID. |
| `UserPromptSubmit` | Captures CEO guidelines into `.taste` store (`taste.jsonl`), stripping secret keys or credentials. |
| `PreToolUse` | Intercepts edit/write tools: blocks terminated agents (`TERMINATED`), blocks blind test tampering (`LIE_TEST_TAMPER`), checks file leases, and enforces radius boundaries. |
| `PostToolUse` | Records edited files, pulses agent heartbeat, and delivers unread messages from other agents into context. |
| `Stop` | Blocks an agent from stopping if direct messages from other sessions remain unread. |
| `SessionEnd` | Triggers a clean checkpoint of uncommitted agent changes and releases held file claims. |
