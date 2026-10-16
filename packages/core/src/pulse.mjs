// pulse: heartbeat and filesystem attribution
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { COORD, PULSE, ROOT, SELF, PULSE_MS, BEAT_IDLE_MS } from './context.mjs';
import { withBoard } from './storage.mjs';
import { now, isLive, overlaps, log } from './helpers.mjs';
import { tryClaim } from './sessions.mjs';

// ---------- pulse: heartbeat for hook-less tools + filesystem change attribution ----------
export const pulsePid = () => { try { const p = JSON.parse(fs.readFileSync(PULSE, 'utf8')); process.kill(p.pid, 0); return p.pid; } catch { return 0; } };

export function ensurePulse() {
  if (pulsePid()) return false;
  const c = spawn(process.execPath, [SELF, 'pulse', 'run'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT, env: { ...process.env, WRAPPER_ROOT: ROOT } });
  c.unref();
  return true;
}

export const IGNORE = /(^|\/)(node_modules|\.git|__pycache__|\.venv|venv|dist|build|coverage|\.next|\.pytest_cache|_backups|worktrees|\.claude)(\/|$)|^\.agents\/coord(\/|$)|\.(pyc|log|tmp|swp)$|~$/;

export function attribute(b, rel) {
  const claim = Object.entries(b.claims).find(([q, c]) => isLive(b.agents[c.agent]) && overlaps(rel, q));
  if (claim) return { id: claim[1].agent, sure: true };
  const cands = Object.entries(b.agents).filter(([, a]) => isLive(a) && a.status !== 'ended' && (a.cwd === '.' || rel === a.cwd || rel.startsWith(a.cwd + '/')));
  if (!cands.length) return { id: null, cands: [] };
  const best = Math.max(...cands.map(([, a]) => (a.cwd === '.' ? 0 : a.cwd.length)));
  const top = cands.filter(([, a]) => (a.cwd === '.' ? 0 : a.cwd.length) === best);
  return top.length === 1 ? { id: top[0][0], sure: false } : { id: null, cands: top.map(([i]) => i) };
}

export function pulseRun() {
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
