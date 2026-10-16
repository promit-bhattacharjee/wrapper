# wrapper

A small, dependency-free coordination layer for several coding agents working in one workspace at the same time. Agents share a live board (sessions, tasks, file claims, messages), so nobody duplicates or collides.

Status: early. This repository currently holds the v3 coordinator ported unchanged, split into modules, with a unit test for every function. See `CHANGELOG.md`.

## What it does today

- Sessions with heartbeat, and a background pulse that tracks which agent changed which files.
- Tasks, file claims (advisory), and messages between sessions.
- Domain-agent dispatch: print a ready brief for a specialist agent, or generate Claude Code subagent files.
- Claude Code hooks installed with one command (`install-hooks`).

## Quick start

```
node packages/cli/bin/wrapper.mjs --root /path/to/workspace session --tool claude --task "my task"
node packages/cli/bin/wrapper.mjs --root /path/to/workspace sync --as <id>
```

The workspace root is chosen in this order: `--root <dir>`, the `WRAPPER_ROOT` environment variable, the legacy plugin location (`<root>/.agents/plugins/wrapper/...`), then the current directory. State lives in `<root>/.agents/coord/`.

## Tests

```
node --test
```

Zero dependencies; Node 20 or newer. Tests use a temporary workspace and never touch real board data.

## Credits

The "built-ins first" idea (prefer what the language, framework and already-installed packages give you before writing new code) is inspired by [Ponytail](https://github.com/) (MIT).

## License

Apache-2.0, copyright Darun Tech Private Limited. See `LICENSE`.
