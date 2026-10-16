// domain agents
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CLI } from './context.mjs';

// ---------- domain agents (from every .specify/agents.json) ----------
let _dom;
// Test hook: forget the cached agent map (the cache is per process, keyed by nothing).
export const resetDomainCache = () => { _dom = undefined; };
export function domainAgents() {
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
export const findDomain = (name) => (name ? domainAgents().get(name) || domainAgents().get(String(name).replace(/-/g, '_')) : undefined);
export const prefixesOf = (a) => (a?.allowed_paths || []).map((g) => g.replace(/\\/g, '/').split('*')[0]).filter((p, _, all) => !all.includes(''));
export function outsideScope(agent, rel) {
  const pre = agent?.allowed;
  if (!pre || !pre.length) return false;
  if (rel.startsWith('.specify/') || rel.includes('/.specify/') || rel.includes('/specs/') || rel.startsWith('specs/')) return false;
  // <repo>/.claude/worktrees/<name>/x is the same repo file as <repo>/x (long-run workflows edit in worktrees).
  const real = rel.replace(/\/\.claude\/worktrees\/[^/]+\//, '/');
  return !pre.some((p) => real.startsWith(p));
}

export function domainPrompt(a, { task, parent, tool }) {
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
