import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wrapper.mjs');
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
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
