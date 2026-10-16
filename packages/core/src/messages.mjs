// messages and change feed
import fs from 'node:fs';
import path from 'node:path';
import { INBOX } from './context.mjs';

// ---------- messages & change feed ----------
export const addressed = (m, id, a) => m.to === 'all' || m.to === id || m.to === a.tool || (a.domain && m.to === a.domain);
export const NEWS_KINDS = new Set(['edit', 'fs', 'note', 'task', 'end', 'join', 'dispatch']);

export function pending(b, id) {
  const a = b.agents[id];
  if (!a) return { msgs: [], news: [] };
  return {
    msgs: b.messages.filter((m) => m.seq > (a.msg_cursor || 0) && m.from !== id && addressed(m, id, a)),
    news: b.log.filter((e) => e.seq > (a.seen_seq || 0) && e.agent !== id && NEWS_KINDS.has(e.kind)),
  };
}
export function collect(b, id) {
  const p = pending(b, id);
  const a = b.agents[id];
  if (a) { a.msg_cursor = b.seq; a.seen_seq = b.seq; try { fs.rmSync(path.join(INBOX, id.replace(/\//g, '__') + '.md'), { force: true }); } catch {} }
  return p;
}
export function formatDelivery({ msgs, news }, cap = 10) {
  const L = [];
  if (msgs.length) { L.push('MESSAGES for you:'); msgs.forEach((m) => L.push(`- from ${m.from}${m.to !== 'all' ? '' : ' (broadcast)'}${m.ask ? ' [REPLY REQUESTED]' : ''}: ${m.text}`)); }
  if (news.length) {
    L.push('What other sessions did since your last update:');
    news.slice(-cap).forEach((e) => L.push(`- ${e.agent}: ${e.text}`));
    if (news.length > cap) L.push(`- (+${news.length - cap} earlier events; see .agents/coord/LIVE.md)`);
  }
  return L.join('\n');
}
