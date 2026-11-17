// Isolation for tools without hooks: run an agent in its own git worktree on its own branch, so it physically
// cannot overwrite another agent's files. Collisions surface at merge time (reported, never silent).
// Nothing here pushes, and nothing touches the main checkout except the explicit `integrate`.
import fs from 'node:fs';
import path from 'node:path';
import { git, repoInfo } from './gitutil.mjs';

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');
const EXCLUDES = [':(exclude).env*', ':(exclude)**/.env*', ':(exclude)*.pem', ':(exclude)*.key', ':(exclude)**/*.pem', ':(exclude)**/*.key'];

function identityEnv(cwd) {
  const env = {};
  if (!git(cwd, ['config', 'user.name']).out.trim()) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'wrapper isolate';
  if (!git(cwd, ['config', 'user.email']).out.trim()) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'wrapper@localhost';
  return env;
}

// Keep .wrapper/ (worktrees live there) out of `git status` without editing a tracked .gitignore.
function excludeLocally(top) {
  const p = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).out.trim();
  if (!p) return;
  try {
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (!/^\/?\.wrapper\/?$/m.test(cur)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.wrapper/\n`); }
  } catch { /* best effort */ }
}

export function startIsolation(cwd, agentId) {
  const info = repoInfo(cwd);
  if (!info) return { ok: false, err: `${cwd} is not inside a git repository, so --isolate cannot create a worktree` };
  if (info.linked) return { ok: false, err: 'already inside a linked git worktree (that is already isolated)', skip: true };
  const head = git(info.top, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return { ok: false, err: 'the repository has no commits yet, make an initial commit first' };
  const base = head.out.trim();
  const name = safe(agentId);
  let branch = `wrapper/${name}`;
  if (git(info.top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok) branch += `-${Date.now().toString(36)}`;
  const wt = path.join(info.top, '.wrapper', 'worktrees', safe(branch.slice(8)));
  excludeLocally(info.top);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const add = git(info.top, ['worktree', 'add', '-q', '-b', branch, wt, base]);
  if (!add.ok) return { ok: false, err: `git worktree add failed: ${add.err.trim().split('\n')[0]}` };
  const rel = path.relative(info.top, path.resolve(cwd));
  const runCwd = rel && !rel.startsWith('..') ? path.join(wt, rel) : wt;
  return { ok: true, top: info.top, wt, branch, base, cwd: fs.existsSync(runCwd) ? runCwd : wt };
}

// Commit whatever the agent left, report overlap with changes made on the main checkout, remove the worktree.
export function finishIsolation(iso, agentId) {
  const res = { branch: iso.branch, files: [], overlap: [], committed: false, kept: true };
  const st = git(iso.wt, ['status', '--porcelain']);
  if (st.out.trim()) {
    git(iso.wt, ['add', '-A', '--', '.', ...EXCLUDES]);
    const c = git(iso.wt, ['commit', '-q', '-m', `wip: ${agentId} isolated run`], { env: identityEnv(iso.wt) });
    res.committed = c.ok;
  }
  res.files = git(iso.top, ['diff', '--name-only', `${iso.base}..${iso.branch}`]).out.split('\n').filter(Boolean);
  const main = git(iso.top, ['rev-parse', 'HEAD']).out.trim();
  const moved = new Set(git(iso.top, ['diff', '--name-only', `${iso.base}..${main}`]).out.split('\n').filter(Boolean));
  res.overlap = res.files.filter((f) => moved.has(f));
  git(iso.top, ['worktree', 'remove', '--force', iso.wt]);
  if (!res.files.length) { git(iso.top, ['branch', '-D', iso.branch]); res.kept = false; }
  return res;
}

// Merge an isolated branch into the current branch of the repo at cwd. Aborts cleanly on conflict.
export function integrate(cwd, branchOrId) {
  const info = repoInfo(cwd);
  if (!info) return { ok: false, err: `${cwd} is not inside a git repository` };
  const want = branchOrId.startsWith('wrapper/') ? branchOrId : `wrapper/${safe(branchOrId)}`;
  if (!git(info.top, ['rev-parse', '--verify', '-q', `refs/heads/${want}`]).ok) return { ok: false, err: `no branch ${want} in ${info.top}` };
  const m = git(info.top, ['merge', '--no-ff', '--no-edit', want], { env: identityEnv(info.top) });
  if (m.ok) return { ok: true, branch: want, top: info.top };
  const conflicts = git(info.top, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  git(info.top, ['merge', '--abort']);
  return { ok: false, branch: want, conflicts, err: conflicts.length ? `merge conflicts in ${conflicts.length} file(s), merge aborted, nothing changed` : `merge refused: ${m.err.trim().split('\n')[0]}` };
}
