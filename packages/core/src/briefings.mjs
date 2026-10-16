// briefings and handoff
import fs from 'node:fs';
import { ROOT, CLI, HANDOFF } from './context.mjs';
import { isLive, ago, sweep } from './helpers.mjs';
import { pending } from './messages.mjs';

// ---------- briefings ----------
export function brief(b, me) {
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

export function writeHandoff(b) {
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
