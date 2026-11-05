#!/usr/bin/env node
// Wrapper coordinator v3: shared board + messaging + heartbeat/pulse + domain-agent dispatch
// so parallel coding agents (Claude Code, Antigravity, Command Code, OpenCode...) see and talk to each other.
// Zero dependencies. State: .agents/coord/board.json (lock-protected, atomic writes).
// Universal read-only views (any tool can just open the file): .agents/coord/LIVE.md, HANDOFF.md, inbox/<id>.md
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
//  Safety        checkpoint [--as ID]   save the agent's work when it ends (worktree: wip commit; shared checkout: hidden snapshot ref)
//                checkpoint restore <agent> [--repo DIR] [--apply] [--all]    list / restore that agent's snapshot files
//                check                  warn-only staged-change check (tests / manual); install-git-hook <repo-dir> wires it into .git/hooks/pre-commit
//                beat on|off --as ID    let the pulse vouch for an existing (hook-registered) session during long idle waits
//  Internal      hook claude (stdin JSON)      pulse run

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..'); // bin -> wrapper -> plugins -> .agents -> root
const COORD = path.join(ROOT, '.agents', 'coord');
const BOARD = path.join(COORD, 'board.json');
const LOCK = path.join(COORD, 'board.lock');
const HANDOFF = path.join(COORD, 'HANDOFF.md');
const LIVE = path.join(COORD, 'LIVE.md');
const PULSE = path.join(COORD, 'pulse.json');
const INBOX = path.join(COORD, 'inbox');
const DISPATCH = path.join(COORD, 'dispatch');
const SELF = path.join(HERE, 'wrapper.mjs').replace(/\\/g, '/');
const CLI = `node "${SELF}"`;

const STALE_MS = 20 * 60 * 1000; // no heartbeat for 20 min => session treated as gone
const PURGE_MS = 24 * 3600 * 1000;
const FAST_MS = 8000; // hook heartbeat is skipped if the board was touched by this agent this recently and nothing is new
const PULSE_MS = 15000;
const BEAT_IDLE_MS = 45 * 60 * 1000; // pulse stops vouching for a session with no activity for 45 min
const LOG_MAX = 400;

// ---------- storage ----------
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const emptyBoard = () => ({ version: 3, seq: 0, nextTask: 1, agents: {}, tasks: [], claims: {}, messages: [], recent_edits: {}, summary: [], log: [] });

function readBoard() {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    let raw;
    try { raw = fs.readFileSync(BOARD, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return emptyBoard(); lastErr = e; sleep(40); continue; }
    try { return { ...emptyBoard(), ...JSON.parse(raw) }; } catch (e) { lastErr = e; sleep(40); }
  }
  // Never treat an unreadable/partial board as empty: the next write would destroy real state.
  throw new Error(`board.json unreadable (${lastErr?.message}); not overwriting`);
}

// Windows/OneDrive/antivirus can hold board.json open for a moment, making rename fail with EPERM/EBUSY.
function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 12; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; } sleep(30 * (i + 1)); }
  }
  fs.writeFileSync(file, data); // last resort: in-place write (still inside the board lock)
  try { fs.rmSync(tmp, { force: true }); } catch {}
}

function withBoard(fn) {
  fs.mkdirSync(COORD, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; }
    catch {
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.rmdirSync(LOCK); } catch {}
      if (Date.now() - start > 8000) throw new Error('board lock timeout');
      sleep(25);
    }
  }
  try {
    const b = readBoard();
    const out = fn(b);
    sweep(b);
    for (const [p, e] of Object.entries(b.recent_edits)) if (now() - e.t > 60000) delete b.recent_edits[p];
    b.messages = b.messages.filter((m) => now() - m.t < PURGE_MS).slice(-100);
    b.updated = now();
    try { fs.writeFileSync(LIVE, '<!-- AUTO-GENERATED live view of .agents/coord/board.json — read-only, do not edit -->\n' + brief(b, null) + '\n'); } catch {}
    writeAtomic(BOARD, JSON.stringify(b, null, 2));
    return out;
  } finally { try { fs.rmdirSync(LOCK); } catch {} }
}

// ---------- helpers ----------
const now = () => Date.now();
const isLive = (a) => a && a.status !== 'ended' && now() - a.last_seen < STALE_MS;
const ago = (t) => {
  const s = Math.max(0, Math.round((now() - t) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const relPath = (p, base) => {
  const abs = path.resolve(base || process.cwd(), p);
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs.replace(/\\/g, '/') : rel || '.';
};
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function log(b, agent, kind, text) {
  b.seq += 1;
  b.log.push({ seq: b.seq, t: now(), agent, kind, text });
  if (b.log.length > LOG_MAX) b.log.splice(0, b.log.length - LOG_MAX);
  return b.seq;
}

function releaseClaims(b, id) {
  for (const [p, c] of Object.entries(b.claims)) if (c.agent === id) delete b.claims[p];
}

function sweep(b) {
  for (const [id, a] of Object.entries(b.agents)) {
    if (a.status !== 'ended' && !isLive(a)) { a.status = 'stale'; releaseClaims(b, id); }
    if (now() - a.last_seen > PURGE_MS) delete b.agents[id];
  }
  for (const t of b.tasks) {
    if (t.status === 'claimed' && !isLive(b.agents[t.owner])) {
      t.status = 'open'; t.note = `${t.note || ''} [released: ${t.owner} went silent]`.trim(); t.owner = null;
    }
  }
}

// ---------- domain agents (from every .specify/agents.json) ----------
let _dom;
function domainAgents() {
  if (_dom) return _dom;
  const files = [path.join(ROOT, '.specify', 'agents.json')];
  try {
    for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') files.push(path.join(ROOT, d.name, '.specify', 'agents.json'));
    }
  } catch {}
  const map = new Map();
  for (const f of files) {
    try { for (const a of JSON.parse(fs.readFileSync(f, 'utf8')).agents || []) if (!map.has(a.id)) map.set(a.id, a); } catch {}
  }
  return (_dom = map);
}
const findDomain = (name) => (name ? domainAgents().get(name) || domainAgents().get(String(name).replace(/-/g, '_')) : undefined);
const prefixesOf = (a) => (a?.allowed_paths || []).map((g) => g.replace(/\\/g, '/').split('*')[0]).filter((p, _, all) => !all.includes(''));
function outsideScope(agent, rel) {
  const pre = agent?.allowed;
  if (!pre || !pre.length) return false;
  if (rel.startsWith('.specify/') || rel.includes('/.specify/') || rel.includes('/specs/') || rel.startsWith('specs/')) return false;
  // <repo>/.claude/worktrees/<name>/x is the same repo file as <repo>/x (long-run workflows edit in worktrees).
  const real = rel.replace(/\/\.claude\/worktrees\/[^/]+\//, '/');
  return !pre.some((p) => real.startsWith(p));
}

function domainPrompt(a, { task, parent, tool }) {
  const L = [];
  L.push(`You are **${a.name}** (\`${a.id}\`), a domain specialist. ${a.role}`);
  L.push('', `- Scope directory: \`${a.scope}\`   Task tag: \`${a.tasks_tag}\``);
  L.push(`- Allowed paths (stay inside; ask the supervisor before touching anything else): ${(a.allowed_paths || []).map((p) => '`' + p + '`').join(', ') || '(unrestricted)'}`);
  L.push('', '## Assigned task', task || '(see the invoking prompt)');
  if (a.constitution_sections?.length) { L.push('', '## Constitution principles to obey'); a.constitution_sections.forEach((c) => L.push(`- **${c.tag} — ${c.title}**: ${c.summary}`)); }
  if (a.responsibilities?.length) { L.push('', '## Responsibilities'); a.responsibilities.forEach((r) => L.push('- ' + r)); }
  if (a.specs?.length) { L.push('', '## Specs'); a.specs.forEach((s) => L.push(`- ${s.path}${s.key_requirements?.length ? ` (${s.key_requirements.join(', ')})` : ''}`)); }
  const dg = a.drift_guard?.check_existing_constraints;
  L.push('', '## Drift guard (do this BEFORE editing)');
  if (dg?.length) dg.forEach((d) => L.push('- Verify: ' + d));
  L.push('- If existing code contradicts the spec: STOP, do not edit, and report the drift to the supervisor (via your parent agent).');
  L.push('', '## Coordination (wrapper) — required');
  L.push(`Board CLI: \`${CLI} <cmd>\`. Under Claude Code with wrapper hooks you are already registered (your id is in the injected context); otherwise first run:`);
  L.push(`1. \`${CLI} session --tool ${tool || '<yourtool>'} --domain ${a.id}${parent ? ` --parent ${parent}` : ''} --task "<task>"\`  (note the SESSION_ID)`);
  L.push(`2. \`... task claim <T-n> --as <id>\`; before editing \`... claim <path> --as <id>\` (exit 2 = another agent holds it).`);
  L.push(`3. Run \`... sync --as <id>\` at each step: it shows messages and what other sessions changed. Use \`... note "<milestone>" --as <id>\`.`);
  L.push(`4. Talk to other agents ONLY via \`... send --to <id|domain-id|all> "<text>" --as <id>\`. API shapes/contracts go in \`.specify/memory/cross_agent_contract.json\`, never only in chat. Frontend agents do not read backend Python.`);
  L.push(`5. Finish: \`... task done <T-n> --as <id> --note "<what changed, how verified>"\`, \`... send --to ${parent || 'all'} "<result summary>"\`, then \`... end --as <id>\`.`);
  return L.join('\n');
}

// ---------- sessions ----------
function register(b, { tool, id, task, cwd, parent, domain, beat }) {
  tool = tool || 'agent';
  if (!id) {
    id = domain ? `${tool}/${domain}` : tool;
    for (let n = 2; b.agents[id] && isLive(b.agents[id]); n++) id = `${domain ? `${tool}/${domain}` : tool}-${n}`;
  }
  const prev = b.agents[id];
  const dom = findDomain(domain);
  b.agents[id] = {
    tool, status: 'active', task: task || prev?.task || '', cwd: cwd ? relPath(cwd) : prev?.cwd || '.',
    parent: parent || prev?.parent || null, domain: dom?.id || domain || null, allowed: dom ? prefixesOf(dom) : null,
    beat: !!beat, started: prev && prev.status !== 'ended' ? prev.started : now(), last_seen: now(), last_active: now(),
    seen_seq: b.seq, msg_cursor: b.seq,
  };
  log(b, id, 'join', `${tool}${dom ? ` ${dom.tasks_tag}` : ''} joined${parent ? ` under ${parent}` : ''}${task ? ': ' + task : ''}`);
  return id;
}

function touch(b, id, patch = {}) {
  const a = b.agents[id];
  if (!a) return false;
  Object.assign(a, patch, { last_seen: now(), last_active: now() });
  if (a.status === 'stale' || a.status === 'ended') a.status = 'active';
  return true;
}

function endAgent(b, id, text = 'session ended') {
  releaseClaims(b, id);
  if (b.agents[id]) { b.agents[id].status = 'ended'; b.agents[id].beat = false; b.agents[id].last_seen = now(); }
  log(b, id, 'end', text);
}

function tryClaim(b, id, paths) {
  const conflicts = [];
  for (const p of paths.map((x) => relPath(x))) {
    const hit = Object.entries(b.claims).find(([q, c]) => c.agent !== id && isLive(b.agents[c.agent]) && overlaps(p, q));
    if (hit) conflicts.push({ path: p, holder: hit[1].agent, held: hit[0], since: hit[1].since });
    else b.claims[p] = { agent: id, since: b.claims[p]?.since || now() };
  }
  return conflicts;
}

// ---------- messages & change feed ----------
const addressed = (m, id, a) => m.to === 'all' || m.to === id || m.to === a.tool || (a.domain && m.to === a.domain);
const NEWS_KINDS = new Set(['edit', 'fs', 'note', 'task', 'end', 'join', 'dispatch']);

function pending(b, id) {
  const a = b.agents[id];
  if (!a) return { msgs: [], news: [] };
  return {
    msgs: b.messages.filter((m) => m.seq > (a.msg_cursor || 0) && m.from !== id && addressed(m, id, a)),
    news: b.log.filter((e) => e.seq > (a.seen_seq || 0) && e.agent !== id && NEWS_KINDS.has(e.kind)),
  };
}
function collect(b, id) {
  const p = pending(b, id);
  const a = b.agents[id];
  if (a) { a.msg_cursor = b.seq; a.seen_seq = b.seq; try { fs.rmSync(path.join(INBOX, id.replace(/\//g, '__') + '.md'), { force: true }); } catch {} }
  return p;
}
function formatDelivery({ msgs, news }, cap = 10) {
  const L = [];
  if (msgs.length) { L.push('MESSAGES for you:'); msgs.forEach((m) => L.push(`- from ${m.from}${m.to !== 'all' ? '' : ' (broadcast)'}${m.ask ? ' [REPLY REQUESTED]' : ''}: ${m.text}`)); }
  if (news.length) {
    L.push('What other sessions did since your last update:');
    news.slice(-cap).forEach((e) => L.push(`- ${e.agent}: ${e.text}`));
    if (news.length > cap) L.push(`- (+${news.length - cap} earlier events; see .agents/coord/LIVE.md)`);
  }
  return L.join('\n');
}

// ---------- briefings ----------
function brief(b, me) {
  sweep(b);
  const L = [];
  const agents = Object.entries(b.agents).filter(([, a]) => a.status !== 'ended' && a.status !== 'stale');
  L.push(`WRAPPER BOARD${me ? ` — you are "${me}"` : ''} (workspace: ${ROOT.replace(/\\/g, '/')})`);
  L.push('', `Active sessions (${agents.length}):`);
  if (!agents.length) L.push('  (none)');
  for (const [id, a] of agents) {
    L.push(`  - ${id}${id === me ? ' (you)' : ''} [${a.tool}${a.domain ? ` · ${a.domain}` : ''}]${a.parent ? ` ⟵ ${a.parent}` : ''} ${a.status}, active ${ago(a.last_active || a.last_seen)} ago, in ${a.cwd}${a.task ? ' — ' + a.task : ''}`);
  }
  const by = (s) => b.tasks.filter((t) => t.status === s);
  const fmt = (t) => `${t.id}${t.service ? ` [${t.service}]` : ''} ${t.title}${t.owner ? ` (${t.owner})` : ''}${t.note ? ` — ${t.note}` : ''}`;
  for (const [label, s] of [['In progress', 'claimed'], ['Blocked', 'blocked'], ['Open (unclaimed)', 'open']]) {
    const ts = by(s);
    if (ts.length) { L.push('', `${label}:`); ts.forEach((t) => L.push('  - ' + fmt(t))); }
  }
  const done = by('done').slice(-5);
  if (done.length) { L.push('', 'Recently done:'); done.forEach((t) => L.push('  - ' + fmt(t))); }
  const claims = Object.entries(b.claims).filter(([, c]) => isLive(b.agents[c.agent]));
  if (claims.length) {
    L.push('', 'File claims (do not edit paths held by another session):');
    claims.slice(0, 25).forEach(([p, c]) => L.push(`  - ${p} -> ${c.agent}`));
    if (claims.length > 25) L.push(`  ... +${claims.length - 25} more`);
  }
  if (b.summary.length) { L.push('', 'Standing summary:'); b.summary.slice(-8).forEach((s) => L.push('  - ' + s)); }
  const recent = b.log.filter((e) => e.kind !== 'join').slice(-10);
  if (recent.length) { L.push('', 'Recent activity:'); recent.forEach((e) => L.push(`  ${ago(e.t)} ago  ${e.agent}: ${e.text}`)); }
  if (me && b.agents[me]) {
    const p = pending(b, me);
    if (p.msgs.length) { L.push('', `INBOX (${p.msgs.length} unread):`); p.msgs.forEach((m) => L.push(`  - from ${m.from}${m.ask ? ' [REPLY REQUESTED]' : ''}: ${m.text}`)); }
  }
  L.push('', `Protocol: claim a task before working, claim files before editing, "sync" each turn, "send" to talk, "task done" + "end" when finished. Delegate domain work to domain agents (dispatch). Rules: .agents/plugins/wrapper/rules/AGENTS.md`);
  return L.join('\n');
}

function writeHandoff(b) {
  sweep(b);
  const L = ['# Wrapper Handoff', '', `_Generated ${new Date().toISOString()} by \`wrapper handoff\`. Read this, then \`${CLI} status\` (or open .agents/coord/LIVE.md) for live state._`, ''];
  L.push('## Standing summary', ...(b.summary.length ? b.summary.map((s) => '- ' + s) : ['- (none recorded)']), '');
  const sec = (title, list) => { L.push(`## ${title}`); L.push(...(list.length ? list : ['- (none)']), ''); };
  const f = (t) => `- **${t.id}**${t.service ? ` [${t.service}]` : ''} ${t.title}${t.owner ? ` — owner: ${t.owner}` : ''}${t.note ? ` — ${t.note}` : ''}`;
  sec('In progress', b.tasks.filter((t) => t.status === 'claimed').map(f));
  sec('Blocked', b.tasks.filter((t) => t.status === 'blocked').map(f));
  sec('Open', b.tasks.filter((t) => t.status === 'open').map(f));
  sec('Done (latest 15)', b.tasks.filter((t) => t.status === 'done').slice(-15).map(f));
  sec('Sessions seen recently', Object.entries(b.agents).map(([id, a]) => `- ${id} [${a.tool}${a.domain ? ' · ' + a.domain : ''}] ${a.status}, last seen ${ago(a.last_seen)} ago${a.task ? ' — ' + a.task : ''}`));
  sec('Last 15 events', b.log.slice(-15).map((e) => `- ${new Date(e.t).toISOString()} ${e.agent}: ${e.text}`));
  fs.writeFileSync(HANDOFF, L.join('\n'));
}

// ---------- pulse: heartbeat for hook-less tools + filesystem change attribution ----------
const pulsePid = () => { try { const p = JSON.parse(fs.readFileSync(PULSE, 'utf8')); process.kill(p.pid, 0); return p.pid; } catch { return 0; } };

function ensurePulse() {
  if (pulsePid()) return false;
  const c = spawn(process.execPath, [SELF, 'pulse', 'run'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT });
  c.unref();
  return true;
}

const IGNORE = /(^|\/)(node_modules|\.git|__pycache__|\.venv|venv|dist|build|coverage|\.next|\.pytest_cache|_backups|worktrees|_wt|\.claude|\.wrapper)(\/|$)|^\.agents\/coord(\/|$)|\.(pyc|log|tmp|swp)$|~$/;

function attribute(b, rel) {
  const claim = Object.entries(b.claims).find(([q, c]) => isLive(b.agents[c.agent]) && overlaps(rel, q));
  if (claim) return { id: claim[1].agent, sure: true };
  const cands = Object.entries(b.agents).filter(([, a]) => isLive(a) && a.status !== 'ended' && (a.cwd === '.' || rel === a.cwd || rel.startsWith(a.cwd + '/')));
  if (!cands.length) return { id: null, cands: [] };
  const best = Math.max(...cands.map(([, a]) => (a.cwd === '.' ? 0 : a.cwd.length)));
  const top = cands.filter(([, a]) => (a.cwd === '.' ? 0 : a.cwd.length) === best);
  return top.length === 1 ? { id: top[0][0], sure: false } : { id: null, cands: top.map(([i]) => i) };
}

function pulseRun() {
  if (pulsePid() && pulsePid() !== process.pid) return;
  fs.mkdirSync(COORD, { recursive: true });
  fs.writeFileSync(PULSE, JSON.stringify({ pid: process.pid, started: now() }));
  const changed = new Set();
  try {
    fs.watch(ROOT, { recursive: true }, (_ev, f) => {
      if (!f) return;
      const rel = String(f).replace(/\\/g, '/');
      if (!IGNORE.test(rel)) changed.add(rel);
    });
  } catch { /* recursive watch unsupported: heartbeat only */ }
  let quiet = 0;
  const tick = () => {
    const paths = [...changed].filter((p) => { try { return fs.statSync(path.join(ROOT, p)).isFile(); } catch { return false; } });
    changed.clear();
    let alive = false;
    withBoard((b) => {
      for (const a of Object.values(b.agents)) {
        if (a.beat && a.status !== 'ended') {
          if (now() - (a.last_active || a.started) < BEAT_IDLE_MS) { a.last_seen = now(); if (a.status === 'stale') a.status = 'active'; alive = true; }
          else { a.beat = false; a.status = 'idle'; }
        } else if (isLive(a)) alive = true;
      }
      const groups = new Map();
      for (const rel of paths) {
        if (b.recent_edits[rel] && now() - b.recent_edits[rel].t < 10000) continue; // a hook already reported this one
        const who = attribute(b, rel);
        const key = who.id || (who.cands?.length ? `?${who.cands.join('|')}` : '?');
        if (!groups.has(key)) groups.set(key, { who, list: [] });
        groups.get(key).list.push(rel);
        b.recent_edits[rel] = { t: now(), agent: who.id || 'fs' };
      }
      for (const [, g] of groups) {
        const shown = g.list.slice(0, 8).join(', ') + (g.list.length > 8 ? ` (+${g.list.length - 8} more)` : '');
        if (g.who.id) {
          if (!g.who.sure) tryClaim(b, g.who.id, g.list.slice(0, 8));
          b.agents[g.who.id].last_active = now();
          log(b, g.who.id, 'edit', `changed ${shown}`);
        } else log(b, 'fs-watch', 'fs', `files changed by an untracked/ambiguous session${g.who.cands?.length ? ` (could be ${g.who.cands.join(', ')})` : ''}: ${shown}`);
      }
    });
    quiet = alive ? 0 : quiet + 1;
    if (quiet > 20) { try { fs.rmSync(PULSE, { force: true }); } catch {} process.exit(0); }
  };
  setInterval(() => { try { tick(); } catch {} }, PULSE_MS);
}

// ---------- checkpoint (never lose work) ----------
// Paths this agent is known to have touched: claims + hook/pulse edit log entries (absolute).
function attributedPaths(b, id) {
  const set = new Set(Object.entries(b.claims).filter(([, c]) => c.agent === id).map(([p]) => p));
  for (const [p, e] of Object.entries(b.recent_edits)) if (e.agent === id) set.add(p);
  for (const e of b.log) {
    if (e.agent !== id) continue;
    let m;
    if (e.kind === 'edit' && (m = e.text.match(/^edited (.+)$/))) set.add(m[1]);
    else if (e.kind === 'edit' && (m = e.text.match(/^changed (.+?)(?: \(\+\d+ more\))?$/))) m[1].split(', ').forEach((x) => set.add(x));
  }
  return [...set].map((p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p)));
}

// Runs `checkpoint` in a child process so a failure or hang can never break the calling hook.
function checkpointSync(id) {
  if (process.env.WRAPPER_NO_CHECKPOINT) return;
  try { spawnSync(process.execPath, [SELF, 'checkpoint', '--as', id, '--quiet'], { timeout: 20000, stdio: 'ignore', windowsHide: true, cwd: ROOT }); } catch {}
}

function checkpointCmd(pos, flags) {
  const quiet = !!flags.quiet;
  const fail = (e) => { if (!quiet) console.error(`checkpoint: ${e?.message || e}`); };
  import('../lib/checkpoint.mjs').then((m) => {
    if (pos[0] === 'restore') {
      const agent = pos[1] || str(flags.as) || die('Usage: checkpoint restore <agent-id> [--repo DIR] [--apply] [--all]');
      let repos = str(flags.repo) ? [path.resolve(str(flags.repo))] : [process.cwd()];
      if (!str(flags.repo)) { try { for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, '.git'))) repos.push(path.join(ROOT, d.name)); } catch {} }
      return console.log(m.restore({ agent, repos: [...new Set(repos)], apply: !!flags.apply, all: !!flags.all }).join('\n'));
    }
    const id = who(flags);
    const b = readBoard();
    const taskId = (b.agents[id]?.task || '').match(/^T-\d+/)?.[0] || b.tasks.find((t) => t.owner === id && t.status === 'claimed')?.id || '';
    const res = m.checkpoint({ agent: id, taskId, paths: attributedPaths(b, id) });
    if (res.length) { try { withBoard((bb) => log(bb, id, 'note', clip(`checkpoint: ${res.join(' | ')}`, 300))); } catch {} }
    if (!quiet) console.log(res.length ? res.join('\n') :'checkpoint: nothing to save');
  }).catch(fail);
}

// ---------- CLI ----------
const BOOL = new Set([
  'ask', 'json', 'peek', 'quiet', 'local', 'no-pulse', 'apply', 'all',
  'copilot', 'compact', 'raw', 'fast-lane', 'ceo-confirmed', 'force', 'expand', 'no-staff', 'worktrees', 'reject', 'reset',
]);
const V4_CMDS = new Set([
  'init', 're', 'spec', 'taste', 'deploy', 'hr', 'pm', 'monitor',
  'desk', 'blind-test', 'test', 'submit', 'verify', 'blame', 'room',
  'ctx', 'ide', 'scoreboard', 'inspect',
]);
function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (BOOL.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[k] = true; else flags[k] = argv[++i];
    } else pos.push(argv[i]);
  }
  return { pos, flags };
}

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const who = (flags) => flags.as || process.env.WRAPPER_AGENT || die('Missing --as <agent-id> (get one with: session --tool <name>)');
const str = (v) => (v && v !== true ? String(v) : '');

function cli(argv) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parse(rest);
  if (V4_CMDS.has(cmd)) {
    return void import('../lib/v4cli.mjs')
      .then((m) => m.runV4Command(cmd, pos, flags))
      .catch((e) => die(`wrapper ${cmd}: ${e?.message || e}`, 1));
  }
  switch (cmd) {
    case undefined: case 'status': case 'brief': {
      const me = flags.as || process.env.WRAPPER_AGENT;
      return console.log(withBoard((b) => { if (me) touch(b, me); return flags.json ? JSON.stringify(b, null, 2) : brief(b, me); }));
    }
    case 'session': case 'register': {
      const beat = cmd === 'session' && !flags['no-pulse'];
      const { id, text } = withBoard((b) => {
        const id = register(b, { tool: str(flags.tool) || 'agent', id: str(flags.id), task: str(flags.task), cwd: process.cwd(), parent: str(flags.parent), domain: str(flags.domain), beat });
        return { id, text: brief(b, id) };
      });
      if (beat) ensurePulse();
      if (cmd === 'register') { console.log(id); return; }
      console.log(`SESSION_ID=${id}`);
      console.log(text);
      console.log(`\nYou are "${id}". Pass "--as ${id}" (or set WRAPPER_AGENT=${id}). Run \`${CLI} sync --as ${id}\` every turn: it refreshes your heartbeat and shows messages + what other sessions changed. A background pulse keeps this session alive and tracks file changes.`);
      return;
    }
    case 'sync': {
      const id = who(flags);
      const p = withBoard((b) => { if (!b.agents[id]) return null; touch(b, id); return collect(b, id); });
      if (!p) die(`Unknown session "${id}". Run: session --tool <name>`, 2);
      const txt = formatDelivery(p, 15);
      return console.log(txt || (flags.quiet ? '' : 'sync: nothing new'));
    }
    case 'inbox': {
      const id = who(flags);
      const p = withBoard((b) => { touch(b, id); return flags.peek ? pending(b, id) : collect(b, id); });
      return console.log(p.msgs.length ? p.msgs.map((m) => `[${new Date(m.t).toISOString()}] from ${m.from}${m.ask ? ' [REPLY REQUESTED]' : ''}: ${m.text}`).join('\n') : '(inbox empty)');
    }
    case 'send': {
      const id = who(flags);
      const to = str(flags.to) || die('Usage: send --to <session-id|tool|domain-agent-id|all> "text" --as ID [--ask]');
      const text = pos.join(' ') || die('Missing message text');
      const n = withBoard((b) => {
        touch(b, id);
        const m = { seq: 0, t: now(), from: id, to, text, ask: !!flags.ask };
        m.seq = log(b, id, 'msg', `→ ${to}: ${clip(text, 100)}`);
        b.messages.push(m);
        const rec = Object.entries(b.agents).filter(([i, a]) => i !== id && isLive(a) && addressed(m, i, a));
        for (const [i] of rec) {
          const f = path.join(INBOX, i.replace(/\//g, '__') + '.md');
          fs.mkdirSync(INBOX, { recursive: true });
          fs.appendFileSync(f, `## from ${id} (${new Date(m.t).toISOString()})${m.ask ? ' — REPLY REQUESTED' : ''}\n${text}\n\n`);
        }
        return rec.length;
      });
      return console.log(n ? `sent to ${n} live session(s)` : `sent (no live session matches "${to}" right now; it will be delivered if one joins within 24h and is addressed by that name)`);
    }
    case 'task': return taskCmd(pos, flags);
    case 'claim': {
      const id = who(flags);
      if (!pos.length) die('Usage: claim <path...> --as ID');
      const conflicts = withBoard((b) => { touch(b, id); const c = tryClaim(b, id, pos); if (!c.length) log(b, id, 'claim', `claimed ${pos.map((p) => relPath(p)).join(', ')}`); return c; });
      if (conflicts.length) {
        conflicts.forEach((c) => console.error(`CONFLICT: ${c.path} is held by ${c.holder} (${c.held}, since ${ago(c.since)} ago). Pick another file/task, message them (send --to ${c.holder}), or ask the user.`));
        process.exit(2);
      }
      return console.log('claimed');
    }
    case 'release': {
      const id = who(flags);
      withBoard((b) => { if (pos.length) pos.map((p) => relPath(p)).forEach((p) => { if (b.claims[p]?.agent === id) delete b.claims[p]; }); else releaseClaims(b, id); });
      return console.log('released');
    }
    case 'note': {
      const id = who(flags);
      const text = pos.join(' ') || die('Usage: note "text" --as ID');
      withBoard((b) => { touch(b, id, flags.task ? { task: str(flags.task) } : {}); log(b, id, 'note', text); });
      return console.log('noted');
    }
    case 'end': {
      const id = who(flags);
      checkpointSync(id);
      withBoard((b) => { endAgent(b, id); writeHandoff(b); });
      return console.log('ended');
    }
    case 'summary': {
      const [sub, ...t] = pos;
      if (sub === 'add') { withBoard((b) => { b.summary.push(`${new Date().toISOString().slice(0, 10)} ${t.join(' ')}`); if (b.summary.length > 30) b.summary.shift(); }); return console.log('added'); }
      if (sub === 'clear') { withBoard((b) => { b.summary = []; }); return console.log('cleared'); }
      return die('Usage: summary add "text" | summary clear');
    }
    case 'handoff': { withBoard((b) => writeHandoff(b)); return console.log(HANDOFF); }
    case 'agents': return agentsCmd(flags);
    case 'dispatch': return dispatchCmd(pos, flags);
    case 'gen-agents': return genAgents(pos[0] || ROOT);
    case 'watch': return watchCmd(flags);
    case 'pulse': {
      const [sub] = pos;
      if (sub === 'run') return pulseRun();
      if (sub === 'start') return console.log(ensurePulse() ? 'pulse started' : `pulse already running (pid ${pulsePid()})`);
      if (sub === 'stop') { const p = pulsePid(); if (p) { try { process.kill(p); } catch {} fs.rmSync(PULSE, { force: true }); return console.log('pulse stopped'); } return console.log('pulse not running'); }
      return console.log(pulsePid() ? `pulse running (pid ${pulsePid()})` : 'pulse not running');
    }
    case 'beat': {
      // Hook-registered sessions (Claude Code) have no pulse cover, so a long background run with no tool calls
      // goes stale after STALE_MS. `beat on` opts an existing session in; the pulse still drops it after
      // BEAT_IDLE_MS without activity, so the owner must keep running `sync`/`note` at least that often.
      const id = who(flags);
      const sub = pos[0] || 'status';
      if (!['on', 'off', 'status'].includes(sub)) die('Usage: beat on|off|status --as ID');
      const on = withBoard((b) => {
        if (!b.agents[id]) return null;
        if (sub !== 'status') { touch(b, id, { beat: sub === 'on' }); log(b, id, 'note', `pulse cover ${sub}`); }
        return !!b.agents[id].beat;
      });
      if (on === null) die(`Unknown session "${id}". Run: session --tool <name>`, 2);
      if (on) ensurePulse();
      return console.log(`beat ${on ? 'on' : 'off'} for ${id}${on ? ` (pulse ${pulsePid() ? 'running' : 'starting'})` : ''}`);
    }
    case 'checkpoint': return checkpointCmd(pos, flags);
    case 'check': return void import('../lib/check.mjs').then((m) => m.runCheck(process.cwd())).catch(() => {}); // warn-only: always exit 0
    case 'install-git-hook': {
      const dir = pos[0] || die('Usage: install-git-hook <repo-dir>');
      return void import('../lib/check.mjs').then((m) => { const r = m.installGitHook(dir, SELF); console.log(r.msg); if (!r.ok) process.exitCode = 1; });
    }
    case 'install-hooks': return installHooks(pos[0] || ROOT, !!flags.local);
    case 'hook': return hook(pos[0]);
    default: die(`Unknown command "${cmd}". See the header of ${SELF}.`);
  }
}

function taskCmd(pos, flags) {
  const [sub, ...rest] = pos;
  if (sub === 'list' || sub === undefined) {
    return console.log(withBoard((b) => b.tasks.map((t) => `${t.id}\t${t.status}\t${t.owner || '-'}\t${t.service || '-'}\t${t.title}`).join('\n') || '(no tasks)'));
  }
  if (sub === 'add') {
    const title = rest.join(' ') || die('Usage: task add "title" [--service S] [--as ID]');
    const t = withBoard((b) => {
      const task = { id: `T-${b.nextTask++}`, title, service: str(flags.service), status: 'open', owner: null, note: '', created: now(), updated: now() };
      b.tasks.push(task); log(b, str(flags.as) || 'user', 'task', `added ${task.id}: ${title}`); return task;
    });
    return console.log(t.id);
  }
  const id = who(flags);
  const tid = rest[0] || die(`Usage: task ${sub} <T-n> --as ID [--note "..."]`);
  const note = str(flags.note);
  const err = withBoard((b) => {
    const t = b.tasks.find((x) => x.id === tid);
    if (!t) return `No such task ${tid}`;
    touch(b, id);
    if (sub === 'claim') {
      if (t.status === 'claimed' && t.owner !== id && isLive(b.agents[t.owner])) return `${tid} already claimed by ${t.owner}. Pick another task or ask the user.`;
      if (t.status === 'done') return `${tid} is already done.`;
      t.status = 'claimed'; t.owner = id; if (b.agents[id]) b.agents[id].task = `${t.id} ${t.title}`;
      log(b, id, 'task', `claimed ${t.id}: ${t.title}`);
    } else if (sub === 'done' || sub === 'block' || sub === 'release') {
      t.status = sub === 'done' ? 'done' : sub === 'block' ? 'blocked' : 'open';
      if (sub === 'release') t.owner = null; else t.owner = t.owner || id;
      if (note) t.note = note;
      if (b.agents[id]) b.agents[id].task = '';
      if (sub === 'done' || sub === 'release') releaseClaims(b, id);
      log(b, id, 'task', `${sub === 'done' ? 'completed' : sub === 'block' ? 'blocked' : 'released'} ${t.id}${note ? ': ' + note : ''}`);
    } else return `Unknown task subcommand "${sub}" (add|list|claim|done|block|release)`;
    t.updated = now();
    return null;
  });
  if (err) die(err, 2);
  console.log('ok');
}

function agentsCmd(flags) {
  const all = [...domainAgents().values()];
  if (flags.json) return console.log(JSON.stringify(all.map((a) => ({ id: a.id, tag: a.tasks_tag, scope: a.scope, app: a.app, role: a.role, allowed_paths: a.allowed_paths })), null, 2));
  const by = {};
  all.forEach((a) => (by[a.scope] = by[a.scope] || []).push(a));
  for (const [scope, list] of Object.entries(by)) {
    console.log(`\n${scope}`);
    list.forEach((a) => console.log(`  ${a.tasks_tag.padEnd(22)} ${a.id.padEnd(42)} ${clip(a.role, 70)}`));
  }
  console.log(`\n${all.length} domain agents. Launch one: ${CLI} dispatch <id> "task" --as <your-id>   |   Claude subagent files: ${CLI} gen-agents`);
}

function dispatchCmd(pos, flags) {
  const [domId, ...t] = pos;
  const a = findDomain(domId) || die(`Unknown domain agent "${domId}". List them: ${CLI} agents`);
  const parent = who(flags);
  const title = t.join(' ') || die('Usage: dispatch <domain-agent-id> "task description" --as <your-id> [--task T-n]');
  const tool = str(flags.tool) || withBoard((b) => b.agents[parent]?.tool) || '<yourtool>';
  const task = withBoard((b) => {
    touch(b, parent);
    let tk = str(flags.task) && b.tasks.find((x) => x.id === str(flags.task));
    if (!tk) {
      tk = { id: `T-${b.nextTask++}`, title: `${a.tasks_tag} ${title}`, service: a.scope, status: 'open', owner: null, note: '', domain: a.id, created: now(), updated: now() };
      b.tasks.push(tk);
    }
    tk.domain = a.id;
    log(b, parent, 'dispatch', `dispatched ${a.id} on ${tk.id}: ${clip(title, 100)}`);
    const m = { seq: 0, t: now(), from: parent, to: a.id, text: `New task ${tk.id} for you: ${title}`, ask: false };
    m.seq = log(b, parent, 'msg', `→ ${a.id}: ${tk.id}`);
    b.messages.push(m);
    return tk;
  });
  const prompt = domainPrompt(a, { task: `${task.id}: ${title}`, parent, tool });
  fs.mkdirSync(DISPATCH, { recursive: true });
  const file = path.join(DISPATCH, `${task.id}-${a.id}.md`);
  fs.writeFileSync(file, prompt + '\n');
  console.error(`Task ${task.id} created for ${a.id}. Prompt saved to ${file.replace(/\\/g, '/')}. Launch the subagent with the prompt below (Claude: Agent tool with subagent_type "${a.id.replace(/_/g, '-')}" after gen-agents; Antigravity: invoke_subagent; Command Code: its subagent/task tool).`);
  console.log(prompt);
}

function genAgents(dir) {
  const out = path.join(path.resolve(dir), '.claude', 'agents');
  fs.mkdirSync(out, { recursive: true });
  let n = 0;
  for (const a of domainAgents().values()) {
    const name = a.id.replace(/_/g, '-');
    const desc = `${a.role} Use for tasks tagged ${a.tasks_tag} in ${a.scope}.`.replace(/\n/g, ' ');
    const body = domainPrompt(a, { task: '(the task is in the invoking prompt; look it up with `task list` if it names a T-n)', tool: 'claude' });
    fs.writeFileSync(path.join(out, `${name}.md`), `---\nname: ${name}\ndescription: ${JSON.stringify(clip(desc, 400))}\n---\n\n${body}\n`);
    n++;
  }
  console.log(`Wrote ${n} Claude subagent files to ${out}. Restart Claude Code sessions to pick them up.`);
}

function watchCmd(flags) {
  const me = str(flags.as) || process.env.WRAPPER_AGENT;
  let last = readBoard().seq;
  console.log(withBoard((b) => { if (me) touch(b, me); return brief(b, me); }));
  console.log('\n--- live (Ctrl+C to stop) ---');
  setInterval(() => {
    let out = [];
    try {
      const b = withBoard((bb) => { if (me && bb.agents[me]) touch(bb, me); return JSON.parse(JSON.stringify(bb)); });
      out = b.log.filter((e) => e.seq > last);
      last = b.seq;
    } catch {}
    out.forEach((e) => console.log(`${new Date(e.t).toLocaleTimeString()}  ${e.agent} [${e.kind}]: ${e.text}`));
  }, 3000);
}

// ---------- Claude Code hooks ----------
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const emit = (o) => process.stdout.write(JSON.stringify(o));

function hasV4Dir(startDir) {
  let d = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, '.wrapper'))) return true;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return false;
}

async function hook(kind) {
  if (kind !== 'claude') return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const ev = input.hook_event_name;
  const cwd = input.cwd || process.cwd();
  const baseId = input.session_id ? `claude-${String(input.session_id).slice(0, 6)}` : 'claude';
  const subType = input.agent_type || null;
  const id = input.agent_id && subType ? `${baseId}/${subType}` : baseId;
  const ensure = (b, tool = 'claude') => { if (!b.agents[id]) register(b, { tool, id, cwd, parent: id === baseId ? null : baseId, domain: id === baseId ? null : subType }); };
  const ctx = (name, text) => emit({ hookSpecificOutput: { hookEventName: name, additionalContext: text } });
  try {
    if (ev === 'SessionStart') {
      const text = withBoard((b) => { register(b, { tool: 'claude', id, cwd }); return brief(b, id); });
      ctx('SessionStart', `${text}\n\nYour wrapper session id: ${id}. Use it: ${CLI} task claim T-1 --as ${id}; talk to others: ${CLI} send --to <id|tool|domain-id|all> "..." --as ${id}. Delegate domain implementation to domain subagents (see .claude/agents or \`${CLI} agents\`).`);
    } else if (ev === 'SubagentStart') {
      const text = withBoard((b) => {
        touch(b, baseId);
        const sid = `${baseId}/${subType || input.agent_id}`;
        register(b, { tool: 'claude', id: sid, cwd, parent: baseId, domain: subType });
        return { sid, dom: findDomain(subType), text: brief(b, sid) };
      });
      ctx('SubagentStart', `You are wrapper session "${text.sid}" (parent ${baseId}). ${text.dom ? `Domain: ${text.dom.name} ${text.dom.tasks_tag}; allowed paths: ${(text.dom.allowed_paths || []).join(', ')}.` : ''} Claim your task and files, and message the parent when done (${CLI} send --to ${baseId} "..." --as ${text.sid}).\n\n${text.text}`);
    } else if (ev === 'SubagentStop') {
      const sid = `${baseId}/${subType || input.agent_id}`;
      checkpointSync(sid); // before endAgent: it still needs this agent's claims
      withBoard((b) => endAgent(b, sid, 'subagent finished'));
    } else if (ev === 'UserPromptSubmit') {
      if (hasV4Dir(cwd) && input.prompt) {
        const m = await import('../lib/v4cli.mjs');
        await m.handleV4ClaudeHook(ev, input, cwd);
      }
      const text = withBoard((b) => { ensure(b); touch(b, id, { status: 'active' }); return formatDelivery(collect(b, id)); });
      if (text) ctx('UserPromptSubmit', `Wrapper update:\n${text}`);
    } else if (ev === 'PreToolUse' && FILE_TOOLS.has(input.tool_name)) {
      const fp = input.tool_input?.file_path || input.tool_input?.notebook_path;
      if (!fp) return;
      if (hasV4Dir(cwd) && (process.env.WRAPPER_EMP || input.emp_id)) {
        const m = await import('../lib/v4cli.mjs');
        const v4Guard = await m.handleV4ClaudeHook(ev, input, cwd);
        if (v4Guard && !v4Guard.allow) {
          emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v4Guard.decision || 'deny', permissionDecisionReason: `Wrapper v4 [${v4Guard.code}]: ${v4Guard.reason}` } });
          return;
        }
      }
      const rel = relPath(fp, cwd);
      const r = withBoard((b) => {
        ensure(b); touch(b, id, { status: 'active' });
        const c = tryClaim(b, id, [path.resolve(cwd, fp)]);
        if (c.length) log(b, id, 'conflict', `wanted ${c[0].path}, held by ${c[0].holder}`);
        return { c, scope: outsideScope(b.agents[id], rel) };
      });
      if (r.c.length) {
        const c = r.c[0];
        emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Wrapper: ${c.path} is claimed by ${c.holder} (${ago(c.since)} ago). Editing may collide with their work. You can message them: send --to ${c.holder}.` } });
      } else if (r.scope) {
        emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Wrapper: ${rel} is outside this domain agent's allowed paths. Confirm it is intended.` } });
      }
    } else if (ev === 'PostToolUse') {
      const isFile = FILE_TOOLS.has(input.tool_name);
      const fp = isFile ? input.tool_input?.file_path || input.tool_input?.notebook_path : null;
      if (!isFile) { // cheap path: skip the lock/write when this agent beat recently and nothing is new
        const b0 = readBoard(); const a0 = b0.agents[id];
        if (a0 && now() - a0.last_seen < FAST_MS) { const p = pending(b0, id); if (!p.msgs.length && !p.news.length) return; }
      }
      const text = withBoard((b) => {
        ensure(b); touch(b, id, { status: 'active' });
        if (fp) {
          const rel = relPath(fp, cwd);
          b.recent_edits[rel] = { t: now(), agent: id };
          const dup = [...b.log].reverse().slice(0, 12).some((e) => e.agent === id && e.kind === 'edit' && e.text === `edited ${rel}` && now() - e.t < 60000);
          if (!dup) log(b, id, 'edit', `edited ${rel}`);
        }
        return formatDelivery(collect(b, id));
      });
      if (text) ctx('PostToolUse', `Wrapper live update:\n${text}`);
    } else if (ev === 'Stop') {
      const p = withBoard((b) => { ensure(b); touch(b, id, { status: 'idle' }); const pe = pending(b, id); const direct = pe.msgs.filter((m) => m.to !== 'all'); if (direct.length && !input.stop_hook_active) { collect(b, id); return { msgs: direct, news: [] }; } return null; });
      if (p) emit({ decision: 'block', reason: `Wrapper: you have new direct message(s) from other agents — read and act on them (or reply with send) before finishing:\n${formatDelivery(p)}` });
    } else if (ev === 'SessionEnd') {
      checkpointSync(id); // before endAgent: it still needs this agent's claims
      withBoard((b) => endAgent(b, id));
    }
  } catch (e) {
    process.stderr.write(`wrapper hook error (ignored): ${e.message}\n`);
  }
}

function installHooks(dir, local) {
  const file = path.join(path.resolve(dir), '.claude', local ? 'settings.local.json' : 'settings.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  s.hooks = s.hooks || {};
  const command = `${CLI} hook claude`;
  const want = { SessionStart: '', SubagentStart: '', SubagentStop: '', UserPromptSubmit: '', PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit', PostToolUse: '', Stop: '', SessionEnd: '' };
  for (const [ev, matcher] of Object.entries(want)) {
    const arr = (s.hooks[ev] = s.hooks[ev] || []);
    if (arr.some((g) => g.hooks?.some((h) => h.command === command))) continue;
    const group = { hooks: [{ type: 'command', command, timeout: 15 }] };
    if (matcher) group.matcher = matcher;
    arr.push(group);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  console.log(`Wrapper hooks installed in ${file}`);
}

cli(process.argv.slice(2));
