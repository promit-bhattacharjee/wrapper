// node --test .agents/plugins/wrapper/tests   (throwaway temp repos only; never touches real repos)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkpoint, restore, refName } from '../lib/checkpoint.mjs';
import { git } from '../lib/gitutil.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-ckpt-test-'));
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const w = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const G = (cwd, ...a) => { const r = git(cwd, a); assert.ok(r.ok, `git ${a.join(' ')}: ${r.err}`); return r.out; };

function mkRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  G(dir, 'init', '-q', '-b', 'main');
  G(dir, 'config', 'user.name', 'T'); G(dir, 'config', 'user.email', 't@t');
  G(dir, 'config', 'core.autocrlf', 'false');
  w(dir, '.gitignore', 'ignored.log\n.env\n');
  w(dir, 'a.txt', 'one\n'); w(dir, 'sub/b.txt', 'bee\n');
  G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('shared checkout: hidden snapshot leaves branch, index and working files untouched', () => {
  const dir = mkRepo('shared');
  w(dir, 'a.txt', 'one\nedited\n');             // tracked modification (unstaged)
  w(dir, 'sub/b.txt', 'bee staged\n'); G(dir, 'add', 'sub/b.txt'); // staged change
  w(dir, 'new.txt', 'brand new\n');             // untracked
  w(dir, 'ignored.log', 'junk\n');              // ignored
  const before = {
    head: G(dir, 'rev-parse', 'HEAD'), branch: G(dir, 'branch', '--show-current'), status: G(dir, 'status', '--porcelain'),
    index: sha(path.join(dir, '.git', 'index')), refs: G(dir, 'for-each-ref'),
    files: ['a.txt', 'sub/b.txt', 'new.txt', 'ignored.log'].map((f) => sha(path.join(dir, f))),
  };
  const res = checkpoint({ agent: 'claude-aaaaaa/sub', taskId: 'T-9', paths: [path.join(dir, 'a.txt'), path.join(dir, 'new.txt')] });
  assert.equal(res.length, 1, res.join('\n'));
  const ref = refName('claude-aaaaaa/sub');
  assert.equal(ref, 'refs/wrapper/checkpoints/claude-aaaaaa__sub');
  const c = G(dir, 'rev-parse', ref);
  assert.equal(G(dir, 'rev-parse', `${c}^`), before.head, 'parent is HEAD');
  assert.match(G(dir, 'log', '-1', '--format=%s', c), /^wip\(T-9\): checkpoint - claude-aaaaaa\/sub ended$/);
  assert.equal(G(dir, 'show', `${c}:a.txt`), 'one\nedited');
  assert.equal(G(dir, 'show', `${c}:sub/b.txt`), 'bee staged');
  assert.equal(G(dir, 'show', `${c}:new.txt`), 'brand new');
  assert.equal(git(dir, ['cat-file', '-e', `${c}:ignored.log`]).ok, false, 'ignored file not captured');
  assert.match(G(dir, 'log', '-1', '--format=%B', c), /- a\.txt\n- new\.txt/);
  // nothing visible changed
  assert.equal(G(dir, 'rev-parse', 'HEAD'), before.head);
  assert.equal(G(dir, 'branch', '--show-current'), before.branch);
  assert.equal(G(dir, 'status', '--porcelain'), before.status);
  assert.equal(sha(path.join(dir, '.git', 'index')), before.index, 'real index byte-identical');
  assert.deepEqual(['a.txt', 'sub/b.txt', 'new.txt', 'ignored.log'].map((f) => sha(path.join(dir, f))), before.files);
  assert.equal(G(dir, 'for-each-ref').split('\n').length, before.refs.split('\n').length + 1, 'only the checkpoint ref was added');
  // second run with no new changes is a no-op
  assert.deepEqual(checkpoint({ agent: 'claude-aaaaaa/sub', taskId: 'T-9', paths: [path.join(dir, 'a.txt')] }), []);
});

test('no-op when there is nothing uncommitted, and outside any repo', () => {
  const dir = mkRepo('clean');
  assert.deepEqual(checkpoint({ agent: 'x', paths: [path.join(dir, 'a.txt')] }), []);
  assert.equal(git(dir, ['rev-parse', '--verify', '-q', refName('x')]).ok, false);
  const plain = path.join(tmp, 'plain'); w(plain, 'f.txt', 'x');
  assert.deepEqual(checkpoint({ agent: 'x', paths: [path.join(plain, 'f.txt')] }), []);
});

test('restore lists the agent files and --apply brings them back', () => {
  const dir = mkRepo('restore');
  w(dir, 'a.txt', 'agent work\n'); w(dir, 'new.txt', 'agent new\n'); w(dir, 'sub/b.txt', 'someone else\n');
  checkpoint({ agent: 'ag', paths: [path.join(dir, 'a.txt'), path.join(dir, 'new.txt')] });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'lost\n'); fs.rmSync(path.join(dir, 'new.txt')); fs.writeFileSync(path.join(dir, 'sub/b.txt'), 'later edit\n');
  const listed = restore({ agent: 'ag', repos: [dir] }).join('\n');
  assert.match(listed, /2 restorable/); assert.match(listed, /a\.txt/); assert.match(listed, /new\.txt/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'lost\n', 'listing changes nothing');
  const idxBefore = sha(path.join(dir, '.git', 'index'));
  restore({ agent: 'ag', repos: [dir], apply: true });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'agent work\n');
  assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'agent new\n');
  assert.equal(fs.readFileSync(path.join(dir, 'sub/b.txt'), 'utf8'), 'later edit\n', 'other files untouched without --all');
  assert.equal(sha(path.join(dir, '.git', 'index')), idxBefore);
  assert.match(restore({ agent: 'nobody', repos: [dir] }).join('\n'), /No checkpoint/);
});

test('linked worktree: commits only attributed files, skips .env and ignored, never pushes', () => {
  const main = mkRepo('wt-main');
  const wt = path.join(tmp, 'wt-linked');
  G(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  w(wt, 'a.txt', 'mine\n'); w(wt, 'mine-new.txt', 'n\n'); w(wt, 'sub/b.txt', 'not mine\n');
  w(wt, '.env', 'SECRET=1\n'); w(wt, 'ignored.log', 'x\n'); w(wt, 'pkg/.env.local', 'S=2\n');
  const mainHead = G(main, 'rev-parse', 'HEAD'); const mainStatus = G(main, 'status', '--porcelain');
  const res = checkpoint({ agent: 'wk', taskId: 'T-5', paths: [path.join(wt, 'a.txt'), path.join(wt, 'mine-new.txt'), path.join(wt, '.env'), path.join(wt, 'ignored.log'), path.join(wt, 'pkg')] });
  assert.equal(res.length, 1, res.join('\n'));
  assert.equal(G(wt, 'log', '-1', '--format=%s'), 'wip(T-5): checkpoint - wk ended');
  const files = G(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  assert.deepEqual(files, ['a.txt', 'mine-new.txt']);
  assert.match(G(wt, 'status', '--porcelain'), /sub\/b\.txt/, 'unattributed change stays uncommitted');
  assert.equal(git(wt, ['for-each-ref', 'refs/wrapper']).out, '', 'no snapshot ref in worktrees');
  assert.equal(G(main, 'rev-parse', 'HEAD'), mainHead); assert.equal(G(main, 'status', '--porcelain'), mainStatus);
  assert.deepEqual(checkpoint({ agent: 'wk', taskId: 'T-5', paths: [path.join(wt, 'a.txt')] }), [], 'second run is a no-op');
});

test('worktree: a blocking pre-commit hook does not prevent the checkpoint', () => {
  const main = mkRepo('wt-hook-main');
  const wt = path.join(tmp, 'wt-hook');
  G(main, 'worktree', 'add', '-q', '-b', 'f2', wt);
  const hook = path.join(main, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  w(wt, 'a.txt', 'changed\n');
  const res = checkpoint({ agent: 'wk2', paths: [path.join(wt, 'a.txt')] });
  assert.equal(res.length, 1, res.join('\n'));
  assert.equal(G(wt, 'log', '-1', '--format=%s'), 'wip: checkpoint - wk2 ended');
});
