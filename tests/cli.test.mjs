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

test('doctor: empty workspace has no failures, and it is read-only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-doc-'));
  try {
    const r = run(['doctor', '--json'], root);
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.ok(res.length >= 8 && res.every((x) => x.status !== 'fail'));
    assert.deepEqual(fs.readdirSync(root), [], 'doctor must not create files');
  } finally { cleanup(root); }
});

test('doctor: reports corrupt board and stale hooks as failures with a fix, exit 1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-doc-'));
  try {
    fs.mkdirSync(path.join(root, '.agents', 'coord'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.agents', 'coord', 'board.json'), '{not json');
    const hook = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/gone/wrapper.mjs" hook claude' }] }] } };
    fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(hook));
    const r = run(['doctor', '--json'], root);
    assert.equal(r.status, 1);
    const failed = JSON.parse(r.stdout).filter((x) => x.status === 'fail').map((x) => x.name);
    assert.deepEqual(failed.sort(), ['Claude Code hooks', 'board.json']);
    assert.ok(JSON.parse(r.stdout).filter((x) => x.status === 'fail').every((x) => x.fix));
  } finally { cleanup(root); }
});

test('file map: hook edits are recorded per task, found by keyword, secrets skipped, stale after change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-map-'));
  try {
    const norm = (p) => p.split(path.sep).join('/');
    const R = norm(root);
    fs.mkdirSync(path.join(root, 'src', 'orders'), { recursive: true });
    const file = path.join(root, 'src', 'orders', 'refund.js');
    fs.writeFileSync(file, "export function capRefund(o, a) { return Math.min(a, o.paid); }\nexport const REFUND_CAP_EXCEEDED = 'x';\n");
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    const hook = (input, cwd) => spawnSync(process.execPath, [BIN, 'hook', 'claude'], { input: JSON.stringify(input), encoding: 'utf8', cwd, env: { ...process.env, WRAPPER_ROOT: root } });
    const ev = (name, extra = {}) => hook({ hook_event_name: name, session_id: 'abc123def', cwd: R, ...extra }, root);
    ev('SessionStart');
    assert.equal(run(['task', 'add', 'refund cap for orders', '--service', 'orders', '--as', 'claude-abc123'], root).status, 0);
    assert.equal(run(['task', 'claim', 'T-1', '--as', 'claude-abc123'], root).status, 0);
    for (const f of [file, path.join(root, '.env')]) ev('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: norm(f) } });

    const w = run(['where', 'refund cap'], root).stdout;
    assert.match(w, /src\/orders\/refund\.js/);
    assert.match(w, /T-1 claude-abc123/);
    assert.match(run(['who', '.env'], root).stdout, /not in the file map/, 'secrets are never indexed');

    assert.equal(run(['task', 'done', 'T-1', '--as', 'claude-abc123', '--note', 'caps a refund at the paid amount'], root).status, 0);
    assert.match(run(['where', 'paid amount'], root).stdout, /caps a refund at the paid amount/);

    fs.appendFileSync(file, 'export const more = 1;\n');
    ev('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: norm(file) } });
    assert.match(run(['map', '--task', 'T-1'], root).stdout, /\(stale\)/, 'changed content flags the old line as stale');
  } finally { cleanup(root); }
});

test('map scan indexes existing files, skips junk, keeps hand-written lines, flags changes stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    const f = path.join(root, 'src', 'invoice.js');
    fs.writeFileSync(f, 'export function createInvoice() {}\nexport const INVOICE_TAX_RATE = 1;\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'export const junk = 1;\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    assert.match(run(['map', 'scan'], root).stdout, /scanned 1 file\(s\): 1 added/);
    assert.match(run(['where', 'invoice tax'], root).stdout, /src\/invoice\.js/);
    run(['map', 'set', f, 'builds invoices and applies tax'], root);
    assert.match(run(['map', 'scan'], root).stdout, /0 added, 0 refreshed/, 'rescan is idempotent');
    fs.appendFileSync(f, 'export const more = 1;\n');
    assert.match(run(['map', 'scan'], root).stdout, /0 added, 1 refreshed/);
    const out = run(['where', 'invoice'], root).stdout;
    assert.match(out, /\(stale\)/);
    assert.match(out, /builds invoices and applies tax/, 'the hand-written line is preserved');
  } finally { cleanup(root); }
});

test('map prune drops deleted files; worktree copies (_work) are never indexed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-prune-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '_work', 'copy', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'keep.js'), 'export function keepMe() {}\n');
    fs.writeFileSync(path.join(root, 'src', 'gone.js'), 'export function goneSoon() {}\n');
    fs.writeFileSync(path.join(root, '_work', 'copy', 'src', 'keep.js'), 'export function keepMe() {}\n');
    assert.match(run(['map', 'scan'], root).stdout, /scanned 2 file\(s\)/, '_work copy is skipped');
    fs.rmSync(path.join(root, 'src', 'gone.js'));
    assert.match(run(['map', 'prune'], root).stdout, /pruned 1 entry.*1 left/);
  } finally { cleanup(root); }
});
