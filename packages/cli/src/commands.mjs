// CLI commands
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CLI, SELF, INBOX, DISPATCH, HANDOFF } from '#core/context.mjs';
import { readBoard, withBoard } from '#core/storage.mjs';
import { now, isLive, ago, relPath, clip, log, releaseClaims } from '#core/helpers.mjs';
import { domainAgents, findDomain, domainPrompt } from '#core/domain.mjs';
import { register, touch, endAgent, tryClaim } from '#core/sessions.mjs';
import { addressed, pending, collect, formatDelivery } from '#core/messages.mjs';
import { brief, writeHandoff } from '#core/briefings.mjs';
import { pulsePid, ensurePulse, pulseRun } from '#core/pulse.mjs';
import { hook } from '#core/hooks.mjs';
import { installHooks } from '#core/install-hooks.mjs';
import { parse, die, who, str } from './args.mjs';

export function cli(argv) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parse(rest);
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
    case 'install-hooks': return installHooks(pos[0] || ROOT, !!flags.local);
    case 'hook': return hook(pos[0]);
    default: die(`Unknown command "${cmd}". See the header of ${SELF}.`);
  }
}

export function taskCmd(pos, flags) {
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

export function agentsCmd(flags) {
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

export function dispatchCmd(pos, flags) {
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

export function genAgents(dir) {
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

export function watchCmd(flags) {
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
