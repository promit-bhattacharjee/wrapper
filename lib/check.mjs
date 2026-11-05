// Warn-only pre-commit check (trial, Phase 0b). Reads the staged diff and prints warnings.
// It never blocks: `check()` never throws and the CLI always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { git, repoInfo } from './gitutil.mjs';

const CODE = /\.(py|js|jsx|mjs|cjs|ts|tsx)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_tests?\.py$/i;
const SKIP_PATH = /(^|\/)(node_modules|migrations|dist|build|\.venv|venv|static|public|smoke|config|scripts|docs|specs)\/|(^|\/)(manage|settings[^/]*|conftest|vite\.config|tailwind\.config|eslint\.config)\.[a-z]+$|\.d\.ts$|(^|\/)__init__\.py$/i;
// Routes, i18n and templates count as user-visible.
const VISIBLE = /(^|\/)(urls?|routes?|router|routing)\.(py|[jt]sx?)$|(^|\/)(routes?|router)\/|(^|\/)(i18n|locales?|translations?|lang)\/|(^|\/)templates?\/.*\.(html?|txt|jinja2?)$|\.(po)$|(^|\/)App\.[jt]sx?$/i;
const MANUAL = /(^|\/)docs\/USER_MANUAL\.md$/i;
const MAX_NAMES = 40;

function definedNames(file, addedLines) {
  const names = new Set();
  const py = /\.py$/i.test(file);
  for (const l of addedLines) {
    let m;
    if (py) {
      if ((m = l.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/))) names.add(m[1]);
    } else {
      if ((m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/))) names.add(m[1]);
      else if ((m = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/))) names.add(m[1]);
      else if ((m = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/))) names.add(m[1]);
    }
  }
  return [...names].filter((n) => !/^__\w+__$/.test(n) && n.length > 1);
}

export function check(cwd = process.cwd()) {
  const warnings = [];
  try {
    const info = repoInfo(cwd);
    if (!info) return warnings;
    const top = info.top;
    const staged = git(top, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    if (!staged.ok || !staged.out) return warnings;
    const files = staged.out.split(/\r?\n/).filter(Boolean);

    // 1. changed/new functions without any test that mentions them
    let budget = MAX_NAMES;
    for (const f of files) {
      if (!CODE.test(f) || TEST_PATH.test(f) || SKIP_PATH.test(f) || budget <= 0) continue;
      const d = git(top, ['diff', '--cached', '-U0', '--no-color', '--', f]);
      const added = d.out.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
      for (const name of definedNames(f, added)) {
        if (budget-- <= 0) break;
        const g = git(top, ['grep', '-l', '-w', '-F', '-e', name]);
        const hits = g.ok ? g.out.split(/\r?\n/).filter((x) => x && TEST_PATH.test(x)) : [];
        if (!hits.length) warnings.push(`no test mentions "${name}" (${f}). Add or extend a test for it.`);
      }
    }

    // 2. user-visible change without a manual update
    const visible = files.filter((f) => VISIBLE.test(f) && !TEST_PATH.test(f));
    if (visible.length && !files.some((f) => MANUAL.test(f))) {
      const has = fs.existsSync(path.join(top, 'docs', 'USER_MANUAL.md'));
      warnings.push(`user-visible change (${visible.slice(0, 3).join(', ')}${visible.length > 3 ? ', ...' : ''}) but docs/USER_MANUAL.md is not part of this commit${has ? '' : ' (the file does not exist yet)'}.`);
    }
  } catch { /* warn-only: never fail */ }
  return warnings;
}

export function runCheck(cwd) {
  const w = check(cwd);
  if (w.length) {
    console.log(`wrapper check: ${w.length} warning(s) (warn-only, commit not blocked)`);
    w.forEach((x) => console.log(`  - ${x}`));
  }
}

// ---- git hook installer (local .git/hooks only) ----
const BEGIN = '# >>> wrapper check (warn-only) >>>';
const END = '# <<< wrapper check <<<';

export function installGitHook(dir, selfPath) {
  const info = repoInfo(path.resolve(dir));
  if (!info) return { ok: false, msg: `${dir} is not inside a git repository` };
  const cp = git(info.top, ['config', 'core.hooksPath']);
  if (cp.ok && cp.out.trim()) return { ok: false, msg: `${info.top}: core.hooksPath is set (${cp.out.trim()}); not touching a shared hooks directory` };
  const hooksDir = path.resolve(info.top, git(info.top, ['rev-parse', '--git-path', 'hooks']).out.trim() || '.git/hooks');
  const file = path.join(hooksDir, 'pre-commit');
  const block = `${BEGIN}\nnode "${selfPath.replace(/\\/g, '/')}" check || true\n${END}\n`;
  fs.mkdirSync(hooksDir, { recursive: true });
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch {}
  if (existing === null) {
    fs.writeFileSync(file, `#!/bin/sh\n${block}`, { mode: 0o755 });
    return { ok: true, msg: `${file}: created` };
  }
  if (existing.includes(BEGIN)) return { ok: true, msg: `${file}: already installed (unchanged)` };
  const first = existing.split(/\r?\n/, 1)[0];
  if (first.startsWith('#!') && !/\b(sh|bash|dash|zsh)\b/.test(first)) return { ok: false, msg: `${file}: existing hook is not a shell script (${first}); left untouched` };
  // Insert right after the shebang so an early `exit` in the existing hook cannot skip it; `|| true` keeps the hook's result unchanged.
  const nl = existing.includes('\r\n') ? '\r\n' : '\n';
  const out = first.startsWith('#!') ? first + nl + block.replace(/\n/g, nl) + existing.slice(first.length + nl.length) : '#!/bin/sh\n' + block + existing;
  fs.writeFileSync(file, out);
  return { ok: true, msg: `${file}: wrapper block added to existing hook` };
}
