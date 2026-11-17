// Per-tool adapters: which instruction file each coding agent reads, plus the short wrapper protocol block.
// Only files whose behaviour is well established are generated; anything else uses the generic AGENTS.md path.
import fs from 'node:fs';
import path from 'node:path';

const BEGIN = '<!-- wrapper:board:begin -->';
const END = '<!-- wrapper:board:end -->';

// tool -> instruction files it reads. AGENTS.md is the cross-tool standard.
export const ADAPTERS = {
  claude:      { label: 'Claude Code',  files: ['CLAUDE.md'],  hooks: true,  note: 'Hooks: run `wrapper setup`. Fully automatic.' },
  codex:       { label: 'Codex',        files: ['AGENTS.md'],  hooks: false, note: 'Reads AGENTS.md. Launch with `wrapper run codex -- codex`.' },
  opencode:    { label: 'OpenCode',     files: ['AGENTS.md'],  hooks: false, note: 'Reads AGENTS.md. Launch with `wrapper run opencode -- opencode`.' },
  commandcode: { label: 'Command Code', files: ['AGENTS.md'],  hooks: false, note: 'Launch with `wrapper run commandcode -- cmd`. Instruction-file support not verified by the author.' },
  antigravity: { label: 'Antigravity',  files: ['AGENTS.md', 'GEMINI.md'], hooks: false, note: 'Reads GEMINI.md / AGENTS.md.' },
  generic:     { label: 'Any other tool', files: ['AGENTS.md'], hooks: false, note: 'Any tool that can run a shell command: paste the AGENTS.md block into its rules, or launch via `wrapper run`.' },
};

export function protocolBlock(cli) {
  return [
    BEGIN,
    '## Wrapper board (multi-agent coordination)',
    'Other AI agents work in this workspace at the same time. Use the shared board so you do not collide.',
    `- CLI: \`${cli}\`. Your session id is in \`$WRAPPER_AGENT\` when launched via \`wrapper run\`; otherwise run \`session --tool <yourtool> --task "<what you do>"\` first and use \`--as <id>\`.`,
    '- Every turn, before acting: `sync --as <id>` (messages + what others changed). Or read `.agents/coord/LIVE.md`.',
    '- Before editing a file or folder: `claim <path> --as <id>`. Exit code 2 means another live agent holds it: do not edit, `send` them a message or work elsewhere.',
    '- Tasks: `task add "..." --as <id>`, `task claim T-n --as <id>`, `task done T-n --as <id> --note "what changed, how verified"`.',
    '- Talk to others: `send --to <id|tool|all> "one actionable line" --as <id>`. Read replies with `sync`.',
    '- Finish: `end --as <id>`. Full protocol: `.agents/plugins/wrapper/rules/AGENTS.md`.',
    END,
  ].join('\n');
}

function upsert(file, header, block) {
  if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${header}\n\n${block}\n`); return 'created'; }
  const cur = fs.readFileSync(file, 'utf8');
  const a = cur.indexOf(BEGIN), b = cur.indexOf(END);
  if (a !== -1 && b > a) { const next = cur.slice(0, a) + block + cur.slice(b + END.length); if (next === cur) return 'unchanged'; fs.writeFileSync(file, next); return 'updated'; }
  fs.writeFileSync(file, cur.replace(/\s*$/, '\n\n') + block + '\n'); return 'appended';
}

export function adapt(tool, dir, cli) {
  const key = ADAPTERS[tool] ? tool : 'generic';
  const a = ADAPTERS[key];
  const block = protocolBlock(cli);
  const out = a.files.map((f) => ({ file: f, action: upsert(path.join(dir, f), `# ${a.label} instructions`, block) }));
  return { tool: key, label: a.label, note: a.note, out, known: key === tool };
}
