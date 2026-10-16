// argument parsing helpers

// ---------- CLI ----------
export const BOOL = new Set(['ask', 'json', 'peek', 'quiet', 'local', 'no-pulse']);
export function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (BOOL.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[k] = true; else flags[k] = argv[++i];
    } else pos.push(argv[i]);
  }
  return { pos, flags };
}

export const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
export const who = (flags) => flags.as || process.env.WRAPPER_AGENT || die('Missing --as <agent-id> (get one with: session --tool <name>)');
export const str = (v) => (v && v !== true ? String(v) : '');
