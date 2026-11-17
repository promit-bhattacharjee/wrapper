// <workspace>/wrapper.config.json: small user settings. Missing or invalid file = defaults, never an error.
//   { "isolate": "off" | "always", "link": ["node_modules"], "copy": [".env"] }
import fs from 'node:fs';
import path from 'node:path';

const FILE = (root) => path.join(root, 'wrapper.config.json');
const DEFAULTS = { isolate: 'off', link: null, copy: [] };

export function loadConfig(root) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE(root), 'utf8')); } catch { /* defaults */ }
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : null);
  return {
    isolate: raw.isolate === 'always' ? 'always' : 'off',
    link: list(raw.link) ?? DEFAULTS.link, // null = "auto" (node_modules when it exists)
    copy: list(raw.copy) ?? DEFAULTS.copy,
  };
}

export function setConfig(root, key, value) {
  if (!['isolate', 'link', 'copy'].includes(key)) return { ok: false, err: `unknown setting "${key}" (isolate | link | copy)` };
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE(root), 'utf8')); } catch { /* new file */ }
  if (key === 'isolate') {
    if (!['always', 'off'].includes(value)) return { ok: false, err: 'isolate must be "always" or "off"' };
    raw.isolate = value;
  } else raw[key] = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  fs.writeFileSync(FILE(root), JSON.stringify(raw, null, 2) + '\n');
  return { ok: true, file: FILE(root) };
}

// Aliases so every agent CLI starts through wrapper without typing `wrapper run`.
export function aliasSnippet(shell, cli, tools = ['claude', 'codex', 'opencode', 'commandcode', 'gemini']) {
  if (shell === 'pwsh') return tools.map((t) => `function ${t} { & node ${JSON.stringify(cli)} run ${t} -- (Get-Command ${t} -CommandType Application | Select-Object -First 1).Source @args }`).join('\n');
  return tools.map((t) => `${t}() { node "${cli}" run ${t} -- command ${t} "$@"; }`).join('\n');
}
