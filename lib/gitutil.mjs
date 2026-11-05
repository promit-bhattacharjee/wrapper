// Small git helpers shared by checkpoint.mjs and check.mjs. Never throws: failures return { ok:false }.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(cwd, args, { env, input, timeout = 20000 } = {}) {
  try {
    const r = spawnSync('git', args, {
      cwd, input, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) },
    });
    if (r.error) return { ok: false, out: '', err: String(r.error.message), code: -1 };
    return { ok: r.status === 0, out: (r.stdout || '').replace(/\r?\n$/, ''), err: r.stderr || '', code: r.status };
  } catch (e) { return { ok: false, out: '', err: String(e.message), code: -1 }; }
}

// Nearest existing directory for a (possibly deleted) path.
export function existingDir(p) {
  let d = p;
  for (let i = 0; i < 64; i++) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch {}
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

// { top, linked, gitDir } for the repo containing dir, or null when dir is in no repo.
export function repoInfo(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (!r.ok) return null;
  const [top, gitDir, common] = r.out.split(/\r?\n/);
  if (!top || !gitDir) return null;
  const norm = (x) => path.resolve(x).replace(/\\/g, '/').toLowerCase();
  return { top: path.resolve(top), gitDir: path.resolve(gitDir), linked: !!common && norm(gitDir) !== norm(common) };
}
