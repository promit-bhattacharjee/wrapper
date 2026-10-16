// helpers: time, paths, log, claims release, sweep
import path from 'node:path';
import { ROOT, STALE_MS, PURGE_MS, LOG_MAX } from './context.mjs';

// ---------- helpers ----------
export const now = () => Date.now();
export const isLive = (a) => a && a.status !== 'ended' && now() - a.last_seen < STALE_MS;
export const ago = (t) => {
  const s = Math.max(0, Math.round((now() - t) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
export const relPath = (p, base) => {
  const abs = path.resolve(base || process.cwd(), p);
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs.replace(/\\/g, '/') : rel || '.';
};
export const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
export const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function log(b, agent, kind, text) {
  b.seq += 1;
  b.log.push({ seq: b.seq, t: now(), agent, kind, text });
  if (b.log.length > LOG_MAX) b.log.splice(0, b.log.length - LOG_MAX);
  return b.seq;
}

export function releaseClaims(b, id) {
  for (const [p, c] of Object.entries(b.claims)) if (c.agent === id) delete b.claims[p];
}

export function sweep(b) {
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
