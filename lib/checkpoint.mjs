// Never lose work (plan 6.6): checkpoint an agent's changes when it ends.
//  - linked git worktree  -> commit ONLY the agent's files (explicit paths), never push
//  - shared/main checkout -> hidden snapshot commit under refs/wrapper/checkpoints/<agent>;
//                            no branch, working-tree or real-index change
//  - no git repo (workspace root) -> nothing
// Everything here is best-effort: it returns messages and never throws.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, existingDir, repoInfo } from './gitutil.mjs';

export const REF_PREFIX = 'refs/wrapper/checkpoints/';
export const refName = (agent) => REF_PREFIX + String(agent).replace(/[^A-Za-z0-9._-]/g, '__').replace(/\.\.|\.lock$/g, '_');

const isEnvFile = (p) => /(^|[\\/])\.env(\.[^\\/]*)?$/i.test(p) && !/\.(example|sample|template)$/i.test(p);

// Group attributed paths (absolute) by git repo. Paths outside any repo are dropped.
export function groupByRepo(paths) {
  const repos = new Map(); const cache = new Map();
  for (const p of paths) {
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch {}
    const dir = existingDir(isDir ? p : path.dirname(p));
    if (!dir) continue;
    let info = cache.get(dir);
    if (info === undefined) { info = repoInfo(dir); cache.set(dir, info); }
    if (!info) continue;
    if (!repos.has(info.top)) repos.set(info.top, { ...info, paths: [] });
    repos.get(info.top).paths.push(p);
  }
  return [...repos.values()];
}

function identityEnv(top) {
  const env = {};
  const has = (k) => git(top, ['config', k]).out.trim();
  if (!has('user.name')) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'wrapper checkpoint';
  if (!has('user.email')) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'wrapper@localhost';
  return env;
}

// ---- snapshot (shared checkout) ----
export function snapshot(repo, agent, taskId, attributed) {
  const top = repo.top;
  const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD']);
  const headSha = head.ok ? head.out.trim() : null;
  const headTree = headSha ? git(top, ['rev-parse', `${headSha}^{tree}`]).out.trim() : null;
  const real = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).out.trim();
  const tmp = path.join(os.tmpdir(), `wrapper-ckpt-${process.pid}-${Date.now()}.idx`);
  const env = { GIT_INDEX_FILE: tmp };
  try {
    // Start from a copy of the real index so stat info is valid and `add -A` stays fast.
    let copied = false;
    try { fs.copyFileSync(real, tmp); copied = true; } catch {}
    if (!copied && headSha) git(top, ['read-tree', headSha], { env });
    const add = git(top, ['add', '-A', '--', '.'], { env });
    if (!add.ok) return `snapshot skipped in ${top}: git add failed (${add.err.trim().split('\n')[0]})`;
    const tree = git(top, ['write-tree'], { env });
    if (!tree.ok) return `snapshot skipped in ${top}: write-tree failed`;
    const treeSha = tree.out.trim();
    if (treeSha === headTree) return null; // nothing uncommitted: no-op
    const ref = refName(agent);
    const prev = git(top, ['rev-parse', '--verify', '-q', `${ref}^{tree}`]);
    if (prev.ok && prev.out.trim() === treeSha) return null; // identical to the last snapshot
    const files = attributed.map((p) => path.relative(top, p).replace(/\\/g, '/')).filter((f) => f && !f.startsWith('..'));
    const msg = `wip${taskId ? `(${taskId})` : ''}: checkpoint - ${agent} ended\n\n` +
      'Hidden snapshot of every uncommitted change in this checkout (no branch, no working-tree change).\n' +
      `Restore: wrapper checkpoint restore ${agent}\n` +
      (files.length ? `\nAttributed to ${agent}:\n${files.map((f) => `- ${f}`).join('\n')}\n` : '');
    const c = git(top, ['commit-tree', treeSha, ...(headSha ? ['-p', headSha] : [])], { input: msg, env: identityEnv(top) });
    if (!c.ok) return `snapshot skipped in ${top}: commit-tree failed (${c.err.trim()})`;
    const u = git(top, ['update-ref', '-m', 'wrapper checkpoint', ref, c.out.trim()]);
    if (!u.ok) return `snapshot skipped in ${top}: update-ref failed (${u.err.trim()})`;
    return `snapshot ${ref} -> ${c.out.trim().slice(0, 10)} in ${top}`;
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

// ---- worktree commit ----
export function commitWorktree(repo, agent, taskId, attributed) {
  const top = repo.top;
  // Expand to changed files under the attributed paths (handles directory claims).
  const st = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...attributed.map((p) => path.relative(top, p) || '.')]);
  if (!st.ok) return `checkpoint skipped in ${top}: git status failed`;
  const files = [];
  const recs = st.out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    if (rec[0] === 'R' || rec[0] === 'C') i++; // rename/copy: next record is the old name
    const f = rec.slice(3);
    if (!isEnvFile(f)) files.push(f);
  }
  const uniq = [...new Set(files)].filter((f) => !git(top, ['check-ignore', '-q', '--', f]).ok);
  if (!uniq.length) return null;
  const add = git(top, ['add', '--', ...uniq]);
  if (!add.ok) return `checkpoint skipped in ${top}: git add failed (${add.err.trim().split('\n')[0]})`;
  const msg = `wip${taskId ? `(${taskId})` : ''}: checkpoint - ${agent} ended`;
  const env = identityEnv(top);
  let c = git(top, ['commit', '-q', '-m', msg, '--only', '--', ...uniq], { env });
  if (!c.ok) c = git(top, ['commit', '-q', '--no-verify', '-m', msg, '--only', '--', ...uniq], { env }); // a checkpoint must always be saved
  if (!c.ok) return `checkpoint FAILED in ${top}: ${c.err.trim().split('\n')[0]}`;
  return `committed ${uniq.length} file(s) in worktree ${top}: ${msg}`;
}

/**
 * @param {{agent:string, taskId?:string, paths:string[]}} o  paths = absolute files/dirs attributed to the agent
 * @returns {string[]} human-readable results (empty = nothing to do)
 */
export function checkpoint({ agent, taskId, paths }) {
  const out = [];
  try {
    const clean = [...new Set(paths)].filter((p) => !/[\\/]\.agents[\\/]coord([\\/]|$)/.test(p));
    for (const repo of groupByRepo(clean)) {
      try {
        const r = repo.linked ? commitWorktree(repo, agent, taskId, repo.paths) : snapshot(repo, agent, taskId, repo.paths);
        if (r) out.push(r);
      } catch (e) { out.push(`checkpoint error in ${repo.top} (ignored): ${e.message}`); }
    }
  } catch (e) { out.push(`checkpoint error (ignored): ${e.message}`); }
  return out;
}

// ---- restore ----
// Lists the agent's snapshot files in the given repo dirs, or writes them back with apply.
export function restore({ agent, repos, apply = false, all = false }) {
  const lines = [];
  const ref = refName(agent);
  for (const dir of repos) {
    const info = repoInfo(dir);
    if (!info) continue;
    const top = info.top;
    const sha = git(top, ['rev-parse', '--verify', '-q', ref]);
    if (!sha.ok) continue;
    const s = sha.out.trim();
    const body = git(top, ['log', '-1', '--format=%B', s]).out;
    let files = [...body.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    if (all || !files.length) {
      const d = git(top, ['diff-tree', '-r', '--no-commit-id', '--name-only', `${s}^`, s]);
      if (d.ok) files = d.out.split(/\r?\n/).filter(Boolean);
    }
    const inTree = new Set(git(top, ['ls-tree', '-r', '--name-only', s]).out.split(/\r?\n/));
    const restorable = files.filter((f) => inTree.has(f)); const gone = files.filter((f) => !inTree.has(f));
    lines.push(`${top}: snapshot ${ref} (${s.slice(0, 10)}), ${restorable.length} restorable file(s)${gone.length ? `, ${gone.length} deleted by the agent` : ''}`);
    restorable.forEach((f) => lines.push(`  ${f}`));
    if (apply && restorable.length) {
      const r = git(top, ['restore', `--source=${s}`, '--worktree', '--', ...restorable]);
      lines.push(r.ok ? `  restored ${restorable.length} file(s) into the working tree (index untouched)` : `  restore FAILED: ${r.err.trim()}`);
    } else if (restorable.length) lines.push('  (list only: add --apply to write these files back; --all for every file in the snapshot)');
  }
  if (!lines.length) lines.push(`No checkpoint for "${agent}" found (ref ${ref}) in: ${repos.join(', ') || '(no repos)'}`);
  return lines;
}
