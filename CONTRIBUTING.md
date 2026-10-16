# Contributing

- Node 20+, no runtime dependencies. Run `node --test` before sending a change.
- One test file per function: `tests/unit/<source path>/<function>.test.mjs`, with the case table at the top and an assertion in every test.
- Tests must use a temporary workspace (see `tests/fixtures/ws.mjs`), never a real board.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Do not add environment-specific names, URLs or private data to code or docs; use generic examples.
