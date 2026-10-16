// hook installer
import fs from 'node:fs';
import path from 'node:path';
import { CLI } from './context.mjs';

export function installHooks(dir, local) {
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
