// Claude Code hook handler
import fs from 'node:fs';
import path from 'node:path';
import { CLI, FAST_MS } from './context.mjs';
import { readBoard, withBoard } from './storage.mjs';
import { now, ago, relPath, log } from './helpers.mjs';
import { findDomain, outsideScope } from './domain.mjs';
import { register, touch, endAgent, tryClaim } from './sessions.mjs';
import { pending, collect, formatDelivery } from './messages.mjs';
import { brief } from './briefings.mjs';

// ---------- Claude Code hooks ----------
export const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const emit = (o) => process.stdout.write(JSON.stringify(o));

export function hook(kind) {
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
      withBoard((b) => endAgent(b, `${baseId}/${subType || input.agent_id}`, 'subagent finished'));
    } else if (ev === 'UserPromptSubmit') {
      const text = withBoard((b) => { ensure(b); touch(b, id, { status: 'active' }); return formatDelivery(collect(b, id)); });
      if (text) ctx('UserPromptSubmit', `Wrapper update:\n${text}`);
    } else if (ev === 'PreToolUse' && FILE_TOOLS.has(input.tool_name)) {
      const fp = input.tool_input?.file_path || input.tool_input?.notebook_path;
      if (!fp) return;
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
      withBoard((b) => endAgent(b, id));
    }
  } catch (e) {
    process.stderr.write(`wrapper hook error (ignored): ${e.message}\n`);
  }
}
