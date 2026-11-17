// wrapper doctor: read-only health check. Never creates or changes files.
// Each check returns { name, status: 'ok'|'warn'|'fail', detail, fix? }.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stats } from './filemap.mjs';
import { loadConfig } from './config.mjs';

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const MARK = '<!-- wrapper:board:begin -->';
const TOOLS = ['claude', 'codex', 'opencode', 'commandcode', 'gemini'];

const ok = (name, detail) => ({ name, status: 'ok', detail });
const warn = (name, detail, fix) => ({ name, status: 'warn', detail, fix });
const fail = (name, detail, fix) => ({ name, status: 'fail', detail, fix });

function nearestExisting(p) {
  let d = p;
  for (let i = 0; i < 64 && !fs.existsSync(d); i++) d = path.dirname(d);
  return d;
}

function onPath(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// Use the short `wrapper` in hints only when the `wrapper` on PATH is this very install (npm link / global install).
function commandName(self, longForm) {
  try {
    const shim = onPath('wrapper');
    if (!shim) return longForm;
    const real = (p) => fs.realpathSync.native(p).toLowerCase();
    const mine = real(self);
    const candidates = [shim, path.join(path.dirname(shim), 'node_modules', 'wrapper', 'bin', 'wrapper.mjs')];
    return candidates.some((c) => { try { return real(c) === mine; } catch { return false; } }) ? 'wrapper' : longForm;
  } catch { return longForm; }
}

export async function runDoctor(ctx) {
  const { ROOT, COORD, BOARD, LOCK, SELF, STALE_MS, readBoard, pulsePid } = ctx;
  const CLI = commandName(SELF, ctx.CLI);
  const out = [];

  // 1. runtime
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) out.push(ok('Node version', process.versions.node));
  else out.push(fail('Node version', `${process.versions.node}, need >= 22.13 for node:sqlite`, 'Install Node 22.13 or newer (nodejs.org).'));
  // Load it for real in a child (builtinModules omits prefix-only modules on some versions; the child keeps the warning quiet).
  const sq = spawnSync(process.execPath, ['--no-warnings', '-e', "require('node:sqlite')"], { encoding: 'utf8' });
  if (sq.status === 0) out.push(ok('node:sqlite', 'available (v4 engine, SQLite WAL)'));
  else out.push(fail('node:sqlite', 'not available in this Node build', 'Use Node >= 22.13. The v3 board still works without it, the v4 engine does not.'));
  out.push(spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
    ? ok('git', 'found')
    : warn('git', 'not on PATH', 'Install git: checkpoints and the pre-commit check need it.'));

  // 2. workspace root
  const viaEnv = !!process.env.WRAPPER_ROOT;
  out.push(ok('Workspace root', `${ROOT}${viaEnv ? ' (from WRAPPER_ROOT)' : ''}`));
  if (!viaEnv && !SELF.includes('/.agents/plugins/')) {
    out.push(warn('Install location', 'plugin is not under <workspace>/.agents/plugins/wrapper, so the root was guessed', 'Set WRAPPER_ROOT=/path/to/your/workspace so the board lands where you expect.'));
  }

  // 3. board state
  let writable = false;
  try { fs.accessSync(nearestExisting(COORD), fs.constants.W_OK); writable = true; } catch { /* reported below */ }
  out.push(writable
    ? ok('Board directory writable', COORD)
    : fail('Board directory writable', `cannot write to ${COORD}`, 'Fix permissions on the workspace folder.'));
  if (fs.existsSync(BOARD)) {
    try { JSON.parse(fs.readFileSync(BOARD, 'utf8')); out.push(ok('board.json', 'parses')); } catch {
      out.push(fail('board.json', 'is not valid JSON', `Inspect or delete ${BOARD}`));
    }
  } else {
    out.push(warn('board.json', 'not created yet', `Run: ${CLI} session --tool <yourtool> --task "..."`));
  }
  try {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age > 10000) out.push(warn('Board lock', `stale lock (${Math.round(age / 1000)}s old)`, `Delete the folder ${LOCK}`));
  } catch { /* no lock held: good */ }

  // 4. pulse and sessions
  const pid = pulsePid();
  let b = { agents: {}, tasks: [] };
  try { b = readBoard(); } catch { /* corrupt board.json is already reported above */ }
  const live = Object.values(b.agents || {}).filter((a) => a && a.status !== 'ended' && Date.now() - a.last_seen < STALE_MS);
  if (pid) out.push(ok('Pulse', `running (pid ${pid})`));
  else if (live.length) out.push(warn('Pulse', 'not running but sessions are active, hook-less tools will go stale', `Run: ${CLI} pulse start`));
  else out.push(ok('Pulse', 'not running (starts automatically with the next session)'));
  out.push(ok('Sessions', `${live.length} active, ${(b.tasks || []).filter((t) => t.status === 'open').length} open task(s)`));

  // 5. Claude Code hooks
  const files = ['settings.local.json', 'settings.json'].map((f) => path.join(ROOT, '.claude', f)).filter((f) => fs.existsSync(f));
  let hookState = null;
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      const cmds = (ev) => (s.hooks?.[ev] || []).flatMap((g) => g.hooks || []).map((h) => h.command || '').filter((c) => c.includes('hook claude'));
      const have = HOOK_EVENTS.filter((ev) => cmds(ev).length);
      if (have.length) {
        const m = cmds(have[0])[0].match(/"([^"]+wrapper\.mjs)"/);
        hookState = { f, have, stale: m && !fs.existsSync(m[1]) ? m[1] : null };
        break;
      }
    } catch {
      out.push(warn('Claude Code hooks', `${f} is not valid JSON`, `Fix the JSON, then run: ${CLI} setup`));
    }
  }
  if (!hookState) out.push(warn('Claude Code hooks', 'not installed in this workspace', `Run: ${CLI} setup   (only needed for Claude Code)`));
  else if (hookState.stale) out.push(fail('Claude Code hooks', `point to a missing file: ${hookState.stale}`, `The plugin moved. Run: ${CLI} setup`));
  else if (hookState.have.length < HOOK_EVENTS.length) out.push(warn('Claude Code hooks', `only ${hookState.have.length}/${HOOK_EVENTS.length} events wired`, `Run: ${CLI} setup`));
  else out.push(ok('Claude Code hooks', `installed (${path.basename(hookState.f)})`));

  // 6. git pre-commit check
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    const hp = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim();
    let has = false;
    try { has = !!hp && fs.readFileSync(path.resolve(ROOT, hp, 'pre-commit'), 'utf8').includes('wrapper check'); } catch { /* no hook file */ }
    out.push(has ? ok('Pre-commit check', 'installed (warn-only)') : warn('Pre-commit check', 'not installed (optional)', `Run: ${CLI} setup`));
  }

  // 6b. file map health (the "which file is for what" memory)
  const st = stats(ROOT);
  if (!st.files) out.push(ok('File map', 'empty (fills automatically as agents edit files)'));
  else if (st.stale > st.files / 2) out.push(warn('File map', `${st.stale}/${st.files} entries are stale`, 'Agents should end tasks with: task done T-n --note "what the file does now"'));
  else out.push(ok('File map', `${st.files} file(s), ${st.withLine} with a line, ${st.stale} stale`));

  // 6c. isolation default
  const cfg = loadConfig(ROOT);
  out.push(cfg.isolate === 'always'
    ? ok('Isolation default', 'on: every `wrapper run` uses its own git worktree (opt out with --no-isolate)')
    : warn('Isolation default', 'off: agents launched with `wrapper run` share your files unless you pass --isolate', `Run: ${CLI} config set isolate always`));

  // 7. instruction files for tools without hooks
  const withBlock = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].filter((f) => {
    try { return fs.readFileSync(path.join(ROOT, f), 'utf8').includes(MARK); } catch { return false; }
  });
  out.push(withBlock.length
    ? ok('Instruction files', `${withBlock.join(', ')} contain the board rules`)
    : warn('Instruction files', 'no AGENTS.md / GEMINI.md with the board rules', `Run: ${CLI} adapt codex   (or opencode, commandcode, antigravity, any name)`));

  // 8. which agent CLIs are installed (info only)
  const found = TOOLS.filter((t) => onPath(t));
  out.push(ok('Agent CLIs on PATH', found.length ? found.join(', ') : 'none of claude, codex, opencode, commandcode, gemini found (fine if you use an IDE agent)'));

  return out;
}

export function printDoctor(results, json) {
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }
  const icon = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  for (const r of results) {
    console.log(`[${icon[r.status]}] ${r.name}: ${r.detail}`);
    if (r.fix) console.log(`       fix: ${r.fix}`);
  }
  const f = results.filter((r) => r.status === 'fail').length;
  const w = results.filter((r) => r.status === 'warn').length;
  console.log(`\n${f ? `${f} problem(s)` : 'No problems'}${w ? `, ${w} warning(s)` : ''}.`);
}
