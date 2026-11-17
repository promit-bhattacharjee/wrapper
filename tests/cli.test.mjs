import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wrapper.mjs');
// The detached pulse watches the workspace; stop it so Windows can delete the temp dir.
const cleanup = (root) => { run(['pulse', 'stop'], root); try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, best effort */ } };
const run = (args, root) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, WRAPPER_ROOT: root } });

test('--help prints the command list', () => {
  const r = run(['--help'], os.tmpdir());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /session --tool/);
});

test('WRAPPER_ROOT keeps board state in the chosen workspace, setup installs hooks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-cli-'));
  try {
    const s = run(['setup', root], root);
    assert.equal(s.status, 0, s.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(settings.hooks.PreToolUse?.length, 'PreToolUse hook installed');
    const j = run(['session', '--tool', 'test', '--task', 'x', '--no-pulse'], root);
    assert.equal(j.status, 0, j.stderr);
    assert.ok(fs.existsSync(path.join(root, '.agents', 'coord', 'board.json')), 'board lives under WRAPPER_ROOT');
  } finally { cleanup(root); }
});

test('run launches any tool on the board, passes WRAPPER_AGENT, and reports what changed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-run-'));
  try {
    const code = "require('fs').writeFileSync(process.env.WRAPPER_ROOT+'/a.txt','x');console.log('ID='+process.env.WRAPPER_AGENT)";
    const r = run(['run', 'codex', '--task', 'demo', '--', process.execPath, '-e', code], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ID=codex/);
    assert.match(r.stdout, /wrapper monitor/);
    assert.match(r.stdout, /changed: a\.txt/);
  } finally { cleanup(root); }
});

test('adapt writes the instruction file for known and unknown tools, idempotently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-adapt-'));
  try {
    for (const tool of ['codex', 'opencode', 'commandcode', 'someothertool']) assert.equal(run(['adapt', tool, root], root).status, 0);
    const md = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.equal(md.split('wrapper:board:begin').length - 1, 1, 'block is not duplicated');
    assert.match(run(['adapt', 'antigravity', root], root).stdout, /GEMINI\.md/);
  } finally { cleanup(root); }
});
