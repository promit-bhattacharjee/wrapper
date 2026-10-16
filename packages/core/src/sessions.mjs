// sessions and file claims
import { now, isLive, relPath, overlaps, log, releaseClaims } from './helpers.mjs';
import { findDomain, prefixesOf } from './domain.mjs';

// ---------- sessions ----------
export function register(b, { tool, id, task, cwd, parent, domain, beat }) {
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

export function touch(b, id, patch = {}) {
  const a = b.agents[id];
  if (!a) return false;
  Object.assign(a, patch, { last_seen: now(), last_active: now() });
  if (a.status === 'stale' || a.status === 'ended') a.status = 'active';
  return true;
}

export function endAgent(b, id, text = 'session ended') {
  releaseClaims(b, id);
  if (b.agents[id]) { b.agents[id].status = 'ended'; b.agents[id].beat = false; b.agents[id].last_seen = now(); }
  log(b, id, 'end', text);
}

export function tryClaim(b, id, paths) {
  const conflicts = [];
  for (const p of paths.map((x) => relPath(x))) {
    const hit = Object.entries(b.claims).find(([q, c]) => c.agent !== id && isLive(b.agents[c.agent]) && overlaps(p, q));
    if (hit) conflicts.push({ path: p, holder: hit[1].agent, held: hit[0], since: hit[1].since });
    else b.claims[p] = { agent: id, since: b.claims[p]?.since || now() };
  }
  return conflicts;
}
