#!/usr/bin/env node
// Wrapper coordinator v3 (ported): shared board + messaging + heartbeat/pulse + domain-agent dispatch
// so parallel coding agents (Claude Code, Command Code, OpenCode...) see and talk to each other.
// Zero dependencies. State: <root>/.agents/coord/board.json (lock-protected, atomic writes).
// Root: --root <dir>, else env WRAPPER_ROOT, else the legacy plugin location, else the current directory.
//
//  Sessions      session --tool T [--task ".."] [--domain ID] [--parent ID]   join + start pulse; prints SESSION_ID=<id>
//                sync --as ID           heartbeat + unread messages + what others changed (run every turn)
//                status [--as ID]       full board briefing         watch [--as ID]   live tail (own terminal)
//                end --as ID            leave, release claims       register (session without pulse; hooks use it)
//  Talking       send --to <id|tool|domain-id|all> "text" --as ID [--ask]     inbox --as ID [--peek]
//  Work          task add|list|claim|done|block|release    claim <path..> --as ID    release [<path..>]    note "text"
//  Domain agents agents [--json]        list domain specialists (from every .specify/agents.json)
//                dispatch <domain-id> "task" --as ID     create tagged task + print ready-to-paste subagent prompt
//                gen-agents [dir]       write Claude Code subagent files (.claude/agents/*.md) for all domain agents
//  Memory        summary add|clear "text"     handoff (regenerate HANDOFF.md)
//  Setup         install-hooks [dir] [--local]      pulse start|stop|status
//                beat on|off --as ID    let the pulse vouch for an existing (hook-registered) session during long idle waits
//  Internal      hook claude (stdin JSON)      pulse run
import { setRoot } from '#core/context.mjs';
import { cli } from '#cli/commands.mjs';

// --root may appear anywhere; strip it before the command is parsed.
const argv = process.argv.slice(2);
let rootArg;
const i = argv.indexOf('--root');
if (i >= 0 && argv[i + 1] !== undefined) { rootArg = argv[i + 1]; argv.splice(i, 2); }
setRoot(rootArg);
cli(argv);
