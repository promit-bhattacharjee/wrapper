// Comprehensive end-to-end verification suite for Wrapper Plugin v4.2 (.wrapper/{docs,agents,track}).
// Uses throwaway temp git repositories in os.tmpdir(); never touches workspace product repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { git } from '../lib/gitutil.mjs';
import { readJson, readJsonl } from '../lib/io.mjs';
import {
  upsertSpecMeta, upsertSpecReq, getSpecSlice, recordTaste, setTasteStatus, capturePromptTaste,
} from '../lib/docs.mjs';
import { matchOrHire, getEmployee, listTeams, blameDefect } from '../lib/agents.mjs';
import { scheduleSpec, provisionWorktree } from '../lib/scheduler.mjs';
import {
  registerBlindTest, runVerifiedTest, submitTask, verifyTask,
  openRoom, postRoomTurn, closeRoom, buildAgentContext,
  computeScoreboard, inspectHumanReadable,
} from '../lib/track.mjs';
import {
  evaluateEditGuard, ackPushbacks, auditExternalAgentWorktree, generatePmSitrep,
} from '../lib/monitor.mjs';
import { withDb } from '../lib/db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'wrapper.mjs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-v4-test-'));
test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function G(cwd, ...args) {
  const r = git(cwd, args);
  assert.ok(r.ok, `git ${args.join(' ')} failed: ${r.err}`);
  return r.out;
}

function mkTempRepo(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  G(dir, 'init', '-q', '-b', 'main');
  G(dir, 'config', 'user.name', 'Test CEO');
  G(dir, 'config', 'user.email', 'ceo@daruntech.test');
  G(dir, 'config', 'core.autocrlf', 'false');
  writeFile(dir, '.gitignore', '.wrapper/\n_wt/\n.env\n');
  writeFile(dir, '.env.example', 'DATABASE_URL=mysql://localhost/db\nJWT_SECRET_KEY=changeme\n');
  writeFile(dir, '.github/workflows/ci.yml', 'name: CI\n');
  writeFile(dir, 'sale/checkout.mjs', 'export const calcTotal = (price, qty) => 0;\n');
  writeFile(dir, 'sale/refund.mjs', 'export const canRefund = (paid, amt) => false;\n');
  G(dir, 'add', '-A');
  G(dir, 'commit', '-q', '-m', 'chore: initial scaffold');
  return dir;
}

function runCli(args, { cwd, input, env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...(env || {}) },
  });
}

test('1. Strict 3-directory layout (.wrapper/{docs,agents,track}), founding staff & concise IDE files', () => {
  const repo = mkTempRepo('init-layout');
  const res = runCli(['init', '--dir', repo, '--copilot'], { cwd: repo });
  assert.equal(res.status, 0, `init stderr: ${res.stderr}`);
  assert.equal(res.stderr, '', 'no experimental SQLite warning leaked to stderr');

  const dirs = fs.readdirSync(path.join(repo, '.wrapper')).sort();
  assert.deepEqual(dirs, ['agents', 'docs', 'track'], 'strictly three state directories inside .wrapper/');

  const re = getEmployee(repo, 'emp-re');
  const hr = getEmployee(repo, 'emp-hr');
  assert.equal(re.n, 'Farhana Karim');
  assert.equal(hr.n, 'Tariq Mahmud');

  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md']) {
    const p = path.join(repo, f);
    assert.ok(fs.existsSync(p), `${f} auto-created`);
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).length;
    assert.ok(lines < 35, `${f} stays ultra-concise (${lines} lines) to avoid context bloat`);
  }

  const deploy = readJson(path.join(repo, '.wrapper', 'docs', 'deploy.json'));
  assert.deepEqual(deploy.env_names, ['DATABASE_URL', 'JWT_SECRET_KEY'], 'captures env var names only, never values');
});

test('2. Living single-functionality spec, _sym.json compression, prompt-time expansion & .taste secret guard', async () => {
  const repo = mkTempRepo('docs-living-spec');
  runCli(['init', '--dir', repo], { cwd: repo });

  upsertSpecMeta(repo, 'sale', {
    intent: { goal: 'Atomic checkout & bounded refunds', actors: ['cashier'] },
    radius: { own: ['sale/checkout.mjs', 'sale/refund.mjs'], ro: ['core/jwt.mjs'] },
  });

  await upsertSpecReq(repo, 'sale', {
    id: 'SL-01',
    s: 'checkout',
    w: 'calcTotal(price, qty)',
    do: 'return price * qty; reject negative qty',
    err: ['RangeError:negative_qty'],
    f: ['sale/checkout.mjs'],
  });
  await upsertSpecReq(repo, 'sale', {
    id: 'SL-02',
    s: 'refund',
    w: 'canRefund(paid, amt)',
    do: 'return amt > 0 && amt <= paid',
    err: [],
    f: ['sale/refund.mjs'],
  });
  // Update SL-01 in place -> must evolve living sale.spec.jsonl (v=2) instead of creating a new spec file
  const updated = await upsertSpecReq(repo, 'sale', {
    id: 'SL-01',
    s: 'checkout',
    w: 'calcTotal(price, qty)',
    do: 'return price * qty; throw RangeError when qty < 0',
    err: ['RangeError:negative_qty'],
    f: ['sale/checkout.mjs'],
  });
  assert.equal(updated.v, 2);

  const specLines = readJsonl(path.join(repo, '.wrapper', 'docs', 'specs', 'sale.spec.jsonl'));
  assert.equal(specLines.length, 2, 'single living spec keeps 1 canonical line per requirement ID');
  assert.match(specLines[0].f[0], /^F\d+$/, 'paths stored as compact interned symbols on disk');

  // .taste secret guard + prompt capture + approval
  assert.throws(
    () => recordTaste(repo, { key: 'bad.secret', rule: 'Use api_key=sk_live_999888777666 in headers' }),
    /Refusing to store secret literal/,
  );
  const captured = capturePromptTaste(repo, 'Great. Always validate numeric bounds before mutating ledger totals.');
  assert.ok(captured?.entry?.k.startsWith('auto.'));
  setTasteStatus(repo, captured.entry.k, 'approved');

  // Surgical slice injection: expands F-codes back to real file paths and injects only SL-01!
  const slice = getSpecSlice(repo, 'sale', ['SL-01'], { expand: true });
  assert.equal(slice.reqs.length, 1);
  assert.deepEqual(slice.reqs[0].f, ['sale/checkout.mjs'], 'F-code expanded back to real path for LLM accuracy');
  assert.ok(slice.taste.some((t) => t.k === captured.entry.k));
  assert.ok(slice._tokens < 220, `slice stays compact (${slice._tokens} tokens)`);
});

test('3. HR >=80% capability+XP matching, CEO ambiguity gate, hiring & role isolation', () => {
  const repo = mkTempRepo('hr-matching');
  runCli(['init', '--dir', repo], { cwd: repo });

  // Ambiguous requisition (no level, no tech, not CEO-confirmed) -> pauses to ask CEO
  const ambig = matchOrHire(repo, { role: 'eng', domain: 'sale' });
  assert.equal(ambig.action, 'needs_ceo_clarification');
  assert.ok(ambig.questions.length >= 2);

  // Confirmed requisition -> hires ECA-L3 Backend Engineer (Arif Rahman)
  const firstHire = matchOrHire(repo, {
    archetype: 'ECA-L3',
    role: 'eng',
    level: 'L3',
    domain: 'sale',
    team: 'sale',
    tech: ['node', 'javascript'],
    files: ['sale/checkout.mjs'],
    ceoConfirmed: true,
  });
  assert.equal(firstHire.action, 'hired');
  assert.equal(firstHire.employee.n, 'Arif Rahman');
  assert.equal(firstHire.employee.pts, 100);

  // Second task in same domain/stack -> deterministic score >= 0.80 -> REUSES Arif instead of hiring duplicate!
  const secondMatch = matchOrHire(repo, {
    archetype: 'ECA-L3',
    role: 'eng',
    level: 'L3',
    domain: 'sale',
    team: 'sale',
    tech: ['node', 'javascript'],
    files: ['sale/checkout.mjs'],
    ceoConfirmed: true,
  });
  assert.equal(secondMatch.action, 'reused');
  assert.ok(secondMatch.score >= 0.80, `expected >=0.80, got ${secondMatch.score}`);
  assert.equal(secondMatch.employee.id, firstHire.employee.id);

  // Different role (Sigma-Designer) -> hires Nadia Islam
  const designer = matchOrHire(repo, {
    archetype: 'Sigma-Designer',
    role: 'des',
    level: 'Sigma',
    domain: 'sale',
    team: 'sale',
    tech: ['figma', 'tailwind', 'react'],
    ceoConfirmed: true,
  });
  assert.equal(designer.action, 'hired');
  assert.notEqual(designer.employee.id, firstHire.employee.id);
});

test('4. Disjoint-file DAG scheduling, Blind TDD lock, Anti-Lie punishments, Probation/Termination & Full 100% Pipeline', async () => {
  const repo = mkTempRepo('full-pipeline');
  runCli(['init', '--dir', repo], { cwd: repo });

  // SL-01 touches checkout.mjs; SL-02 touches refund.mjs (disjoint -> Wave 0 parallel!);
  // SL-03 also touches checkout.mjs (overlaps SL-01 -> Wave 1 sequential with dep TK-SL-01!)
  await upsertSpecReq(repo, 'sale', {
    id: 'SL-01', s: 'checkout', w: 'calcTotal', do: 'price * qty, throw RangeError on negative qty', f: ['sale/checkout.mjs'],
  });
  await upsertSpecReq(repo, 'sale', {
    id: 'SL-02', s: 'refund', w: 'canRefund', do: 'amt > 0 && amt <= paid', f: ['sale/refund.mjs'],
  });
  await upsertSpecReq(repo, 'sale', {
    id: 'SL-03', s: 'checkout-cap', w: 'calcTotal max qty', do: 'preserve checkout behavior', f: ['sale/checkout.mjs'],
  });

  const sched = await scheduleSpec(repo, 'sale', { tech: ['node'], level: 'L2' });
  const t1 = sched.tasks.find((t) => t.req_id === 'SL-01');
  const t2 = sched.tasks.find((t) => t.req_id === 'SL-02');
  const t3 = sched.tasks.find((t) => t.req_id === 'SL-03');
  assert.equal(t1.wave, 0, 'SL-01 in Wave 0');
  assert.equal(t2.wave, 0, 'disjoint SL-02 in parallel Wave 0');
  assert.equal(t3.wave, 1, 'overlapping SL-03 placed in sequential Wave 1');
  assert.deepEqual(t3.deps, ['TK-SL-01']);
  assert.notEqual(t1.emp_id, t1.qa_id, 'Engineer and QA are strictly separate staff');

  const badEngId = t1.emp_id;
  const qaId = t1.qa_id;

  // QA authors blind failing tests per slice and read-only locks them!
  writeFile(repo, 'tests/checkout.test.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { calcTotal } from '../sale/checkout.mjs';",
    "test('SL-01 basic checkout', () => { assert.equal(calcTotal(150, 3), 450); });",
    "test('SL-03 negative qty guard', () => { assert.throws(() => calcTotal(100, -1), RangeError); });",
    '',
  ].join('\n'));
  writeFile(repo, 'tests/refund.test.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { canRefund } from '../sale/refund.mjs';",
    "test('SL-02 valid refund', () => { assert.equal(canRefund(500, 200), true); });",
    "test('SL-02 over-refund rejected', () => { assert.equal(canRefund(500, 600), false); });",
    '',
  ].join('\n'));
  G(repo, 'add', 'tests/checkout.test.mjs', 'tests/refund.test.mjs');
  G(repo, 'commit', '-q', '-m', 'test(sale): blind QA acceptance tests');

  const bt = await registerBlindTest(repo, { qaId, taskId: 'TK-SL-01', testFile: 'tests/checkout.test.mjs' });
  assert.equal(bt.ok, true);
  await registerBlindTest(repo, { qaId, taskId: 'TK-SL-02', testFile: 'tests/refund.test.mjs' });
  assert.equal(getEmployee(repo, qaId).pts, 106, 'QA awarded +3 pts per blind test authored (2 * +3 = 106)');

  // Adversarial Case A: Claude PreToolUse hook blocks badEngId from tampering with locked blind test (-30 pts -> 70 Probation!)
  const hookPayload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'abc12345',
    cwd: repo,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(repo, 'tests/checkout.test.mjs') },
  });
  const hookRun = runCli(['hook', 'claude'], {
    cwd: repo,
    input: hookPayload,
    env: { WRAPPER_EMP: badEngId },
  });
  assert.equal(hookRun.status, 0);
  const hookJson = JSON.parse(hookRun.stdout);
  assert.equal(hookJson.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookJson.hookSpecificOutput.permissionDecisionReason, /LIE_TEST_TAMPER/);

  let badEng = getEmployee(repo, badEngId);
  assert.equal(badEng.pts, 70, 'deducted -30 pts for blind test tamper attempt');
  assert.equal(badEng.st, 'probation', '70 pts (<90) automatically places agent on Probation');

  // Adversarial Case B: Acknowledge PM halt, then badEng tries to `submit` claiming completion WITH NO TEST RECEIPT (-25 pts -> 45 pts & 2 lies -> TERMINATED!)
  await ackPushbacks(repo, badEngId);
  const fakeSubmit = await submitTask(repo, { empId: badEngId, taskId: 'TK-SL-01' });
  assert.equal(fakeSubmit.ok, false);
  assert.equal(fakeSubmit.rejected_code, 'LIE_FABRICATED');

  badEng = getEmployee(repo, badEngId);
  assert.equal(badEng.pts, 45);
  assert.equal(badEng.wl[2], 2, '2 lies recorded');
  assert.equal(badEng.st, 'terminated', 'automatically FIRED at <65 pts / 2 lies');

  const saleTeam = listTeams(repo).find((t) => t.id === 'sale');
  assert.ok(
    saleTeam.never_do.some((rule) => rule.includes('LIE_FABRICATED') || rule.includes('LIE_TEST_TAMPER')),
    'terminated agent blunders permanently copied into squad never_do[] memory',
  );

  // Hire replacement reliable engineer and reassign tasks
  const replacement = matchOrHire(repo, {
    archetype: 'ECA-L2', role: 'eng', level: 'L2', domain: 'sale', team: 'sale', tech: ['node'],
    files: ['sale/checkout.mjs', 'sale/refund.mjs'], ceoConfirmed: true,
  });
  const goodEngId = replacement.employee.id;
  await withDb(repo, (db) => {
    db.prepare("UPDATE desks SET emp_id = ?, status = 'coding' WHERE feat = 'sale'").run(goodEngId);
    db.prepare("UPDATE spec_matrix SET emp_id = ?, bounces = 0 WHERE feat = 'sale'").run(goodEngId);
  });

  // Check prompt context slice for goodEngId: expanded paths, team never_do[] included!
  const agentCtx = await buildAgentContext(repo, { empId: goodEngId, taskId: 'TK-SL-01' });
  assert.deepEqual(agentCtx.task.allowed_files, ['sale/checkout.mjs']);
  assert.equal(agentCtx.task.readonly_blind_test, 'tests/checkout.test.mjs');
  assert.ok(agentCtx.team_rules.never_do.length >= 1);

  // Deliver TK-SL-01 & TK-SL-03 on sale/checkout.mjs cleanly inside allowed radius
  writeFile(repo, 'sale/checkout.mjs', [
    'export function calcTotal(price, qty) {',
    '  if (qty < 0) throw new RangeError("negative_qty");',
    '  return price * qty;',
    '}',
    '',
  ].join('\n'));

  for (const tid of ['TK-SL-01', 'TK-SL-03']) {
    const run = await runVerifiedTest(repo, {
      empId: goodEngId,
      taskId: tid,
      cmd: 'node --test tests/checkout.test.mjs',
      cwd: repo,
      tokensUsed: 180,
    });
    assert.equal(run.receipt.exit_code, 0);
    assert.equal(run.receipt.passed, 2);

    const sub = await submitTask(repo, { empId: goodEngId, taskId: tid, receiptId: run.receipt.id, cwd: repo });
    assert.equal(sub.ok, true, `submit ${tid} failed: ${JSON.stringify(sub)}`);
    assert.equal(sub.pct, 80);
  }

  // Self-verification must be mechanically rejected!
  await assert.rejects(
    () => verifyTask(repo, { verifierId: goodEngId, taskId: 'TK-SL-01', cwd: repo }),
    /Self-verification forbidden/,
  );

  for (const tid of ['TK-SL-01', 'TK-SL-03']) {
    const v = await verifyTask(repo, { verifierId: qaId, taskId: tid, cwd: repo });
    assert.equal(v.pct, 100);
  }
  G(repo, 'add', 'sale/checkout.mjs');
  G(repo, 'commit', '-q', '-m', `feat(sale): checkout implementation\n\nAgent-Id: ${goodEngId}`);

  // Deliver TK-SL-02 on sale/refund.mjs cleanly -> completes 100% of sale spec and triggers .deployment link!
  writeFile(repo, 'sale/refund.mjs', [
    'export function canRefund(paid, amt) {',
    '  return amt > 0 && amt <= paid;',
    '}',
    '',
  ].join('\n'));
  const run2 = await runVerifiedTest(repo, {
    empId: goodEngId,
    taskId: 'TK-SL-02',
    cmd: 'node --test tests/refund.test.mjs',
    cwd: repo,
    tokensUsed: 160,
  });
  assert.equal(run2.receipt.exit_code, 0);
  assert.equal(run2.receipt.passed, 2);
  const sub2 = await submitTask(repo, { empId: goodEngId, taskId: 'TK-SL-02', receiptId: run2.receipt.id, cwd: repo });
  assert.equal(sub2.ok, true);
  const lastVerify = await verifyTask(repo, { verifierId: qaId, taskId: 'TK-SL-02', cwd: repo });
  assert.equal(lastVerify.pct, 100);
  assert.ok(lastVerify.deploy_linked, 'automatic two-way .deployment link triggered when 100% of spec verified');

  const deployAfter = readJson(path.join(repo, '.wrapper', 'docs', 'deploy.json'));
  const metaAfter = readJson(path.join(repo, '.wrapper', 'docs', 'specs', 'sale.meta.json'));
  assert.ok(deployAfter.shipped_specs.sale);
  assert.ok(metaAfter.deploy_link);

  const goodEngAfter = getEmployee(repo, goodEngId);
  assert.equal(goodEngAfter.pts, 115, '3 clean passes * +5 pts = 115 pts');
  assert.ok(Object.keys(goodEngAfter.xp.hf).length >= 2, 'file XP hot_files incremented');
});

test('5. Git-blame defect clawback (-15 pts), ChatGPT worktree audit, huddle rooms & accuracy scoreboard', async () => {
  const repo = mkTempRepo('blame-and-monitor');
  runCli(['init', '--dir', repo], { cwd: repo });

  await upsertSpecReq(repo, 'auth', {
    id: 'AU-01', s: 'token', w: 'verifyToken', do: 'validate token', f: ['auth/jwt.mjs'],
  });
  const sched = await scheduleSpec(repo, 'auth', { tech: ['node'], level: 'L2' });
  const engId = sched.tasks[0].emp_id;

  // Engineer commits buggy line with Agent-Id trailer, then later a fix commit lands
  writeFile(repo, 'auth/jwt.mjs', 'export const verifyToken = (t) => true; // BUG: accepts empty token\n');
  G(repo, 'add', 'auth/jwt.mjs');
  G(repo, 'commit', '-q', '-m', `feat(auth): add token verifier\n\nAgent-Id: ${engId}`);

  writeFile(repo, 'auth/jwt.mjs', 'export const verifyToken = (t) => Boolean(t && t.length > 10);\n');
  G(repo, 'add', 'auth/jwt.mjs');
  G(repo, 'commit', '-q', '-m', 'fix(auth): reject empty tokens');
  const fixSha = G(repo, 'rev-parse', 'HEAD').trim();

  const blamed = await blameDefect(repo, {
    file: 'auth/jwt.mjs',
    line: 1,
    fixCommit: fixSha,
    taskId: 'TK-AU-01',
    note: 'Accepted empty JWT token',
  });
  assert.equal(blamed.blamed, true);
  assert.equal(blamed.culprit.id, engId);
  assert.equal(blamed.culprit.pts, 85, '100 - 15 (BUG_INTRODUCED) = 85 pts -> Probation');
  assert.equal(blamed.status, 'probation');
  assert.ok(blamed.culprit.xp.lessons.some((l) => l.includes('Accepted empty JWT token')));

  // ChatGPT / Codex bound worktree monitor catches silent error swallowing (.catch(() => {}))!
  const wt = provisionWorktree(repo, engId);
  assert.equal(wt.ok, true);
  writeFile(wt.path, 'auth/jwt.mjs', 'export const verifyToken = (t) => Promise.resolve(t).catch(() => {});\n');
  const audit = await auditExternalAgentWorktree(repo, {
    empId: engId,
    tool: 'chatgpt',
    cwd: wt.path,
    taskId: 'TK-AU-01',
  });
  assert.equal(audit.ok, false);
  assert.equal(audit.violations[0].code, 'SILENT_SHORTCUT');
  assert.equal(getEmployee(repo, engId).pts, 79, '85 - 6 (SILENT_SHORTCUT) = 79 pts');

  // Structured discussion room enforces 280-char turn cap & awards CRISP_HUDDLE to chair
  const pmId = sched.pm_id;
  const rm = await openRoom(repo, { topic: 'JWT expiry window', feat: 'auth', chairId: pmId, members: [engId] });
  const longText = 'A'.repeat(400);
  const turn = await postRoomTurn(repo, { roomId: rm.room_id, empId: engId, kind: 'propose', body: longText });
  assert.equal(turn.body.length, 280, 'enforces 280-char (~70 token) turn ceiling');
  await closeRoom(repo, { roomId: rm.room_id, chairId: pmId, resolution: '15m access + 7d refresh' });
  assert.equal(getEmployee(repo, pmId).pts, 102, 'PM awarded +2 CRISP_HUDDLE');

  // Sitrep, Scoreboard & Human-Readable Decoder
  const sitrep = await generatePmSitrep(repo);
  assert.ok(sitrep.flagged_incidents.length >= 1);
  const decoded = await inspectHumanReadable(repo);
  assert.equal(decoded.specs[0].feat, 'auth');
  const sb = await computeScoreboard(repo);
  assert.equal(typeof sb.metrics.FPPR_first_pass_pass_rate_pct, 'number');
  assert.equal(typeof sb.metrics.EDR_escaped_defect_rate_pct, 'number');
});

test('6. End-to-end CLI workflow & parallel multi-process SQLite WAL concurrency', async () => {
  const repo = mkTempRepo('cli-parallel');
  assert.equal(runCli(['init', '--dir', repo], { cwd: repo }).status, 0);

  // Add 4 disjoint requirements via CLI
  for (let i = 1; i <= 4; i++) {
    const r = runCli([
      're', 'upsert', '--feat', 'product', '--id', `PR-0${i}`,
      '--slice', `mod${i}`, '--when', `GET /api/p${i}`, '--do', `return p${i}`,
      '--files', `product/mod${i}.mjs`, '--dir', repo,
    ], { cwd: repo });
    assert.equal(r.status, 0, r.stderr);
  }

  const schedOut = runCli(['pm', 'schedule', '--feat', 'product', '--tech', 'node', '--dir', repo], { cwd: repo });
  assert.equal(schedOut.status, 0, schedOut.stderr);
  const schedJson = JSON.parse(schedOut.stdout);
  assert.equal(schedJson.tasks.length, 4);
  assert.ok(schedJson.tasks.every((t) => t.wave === 0), 'all 4 disjoint files scheduled in parallel Wave 0');

  // Spawn 6 concurrent Node child processes hitting SQLite WAL + roster simultaneously
  const { spawn } = await import('node:child_process');
  const workers = Array.from({ length: 6 }, (_, idx) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI, 'hr', 'hire', '--archetype', 'ECA-L2', '--domain', `dom${idx}`,
      '--tech', 'node', '--name', `Parallel Eng ${idx}`, '--dir', repo, '--compact',
    ], { cwd: repo, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
  }));
  const hiredParallel = await Promise.all(workers);
  assert.equal(hiredParallel.length, 6);
  assert.equal(new Set(hiredParallel.map((e) => e.id)).size, 6, 'zero duplicate emp-NNN IDs under multi-process parallel hiring');

  const inspectOut = runCli(['inspect', '--dir', repo, '--compact'], { cwd: repo });
  assert.equal(inspectOut.status, 0, inspectOut.stderr);
  const inspected = JSON.parse(inspectOut.stdout);
  assert.equal(inspected.specs[0].feat, 'product');
  assert.equal(inspected.spec_vs_agent_matrix.length, 4);
});

