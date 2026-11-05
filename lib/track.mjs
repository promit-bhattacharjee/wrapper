// Directory 3 (.wrapper/track/): Blind TDD Gate, Hash-Locked Execution Receipts,
// 0-Token Diff/Tamper/Shortcut Guards, Multi-Agent Discussion Rooms, Context Slice Builder,
// Human-Readable Decoder (inspect), and Real-World Accuracy Scoreboard.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import {
  ensureWrapperDirs, readJson, readJsonl, writeJsonl, appendJsonl,
  hashText, treeHash, relToBase, normSlash, estimateTokens,
} from './io.mjs';
import { decode, decodeList, expandSymbols, loadSymMap } from './sym.mjs';
import { withDb, plain, plainAll } from './db.mjs';
import { getSpecSlice, listSpecs, linkSpecToDeployment } from './docs.mjs';
import { getEmployee, listRoster, listTeams, recordPointEvent } from './agents.mjs';
import { acquireFileLease, releaseFileLeases, syncTrackSnapshots } from './scheduler.mjs';
import { git, repoInfo } from './gitutil.mjs';

const ROOM_TURN_KINDS = new Set(['propose', 'critique', 'amend', 'agree', 'ask_ceo']);
const MAX_TURN_CHARS = 280; // Hard ~70-token cap per huddle turn to prevent prose bloat

const TEST_SKIP_RE = /\b(?:test\.skip|it\.skip|describe\.skip|xit|xdescribe|pytest\.mark\.skip|unittest\.skip)\b|^\s*@skip\b/m;
const ASSERT_RE = /\b(?:assert(?:\.\w+)?|expect\s*\(|self\.assert\w+)\b/;
const SILENT_SWALLOW_RE = /\bexcept(?:\s+Exception|\s+BaseException)?\s*:\s*pass\b|\.catch\s*\(\s*\([^)]*\)\s*=>\s*(?:\{\s*\}|\[\s*\]|null|undefined)\s*\)/;

function logAgentWal(baseDir, empId, kind, payload) {
  if (!empId) return;
  const p = ensureWrapperDirs(baseDir);
  appendJsonl(path.join(p.runsDir, `${empId}.jsonl`), { ts: Date.now(), k: kind, ...payload });
}

// ---------- 1. Blind TDD: QA Authors & Read-Only Locks Test Before Engineer Codes ----------

export async function registerBlindTest(baseDir, { qaId, taskId, testFile }) {
  const qa = getEmployee(baseDir, qaId);
  if (!qa || qa.r !== 'qa') {
    throw new Error(`Blind tests must be authored by a QA specialist ("${qaId}" has role "${qa?.r || 'unknown'}")`);
  }
  const p = ensureWrapperDirs(baseDir);
  const absTest = path.resolve(p.base, testFile);
  if (!fs.existsSync(absTest)) {
    throw new Error(`Blind test file does not exist on disk: ${testFile}`);
  }
  const relTest = relToBase(baseDir, absTest);
  const fileContent = fs.readFileSync(absTest, 'utf8');
  if (!ASSERT_RE.test(fileContent)) {
    throw new Error(`Blind test "${relTest}" contains zero assertions (assert/expect); refusing toothless test.`);
  }
  const btHash = hashText(fileContent, 24);

  const task = await withDb(baseDir, (db) => plain(db.prepare('SELECT * FROM desks WHERE task_id = ?').get(taskId)));
  if (!task) throw new Error(`Unknown task "${taskId}"`);
  if (task.emp_id === qa.id) {
    throw new Error(`Blind TDD violation: QA (${qa.id}) cannot also be the implementing engineer on ${taskId}`);
  }

  const lease = await acquireFileLease(baseDir, {
    empId: qa.id,
    filePath: relTest,
    mode: 'ro_blind_test',
    role: 'qa',
    taskId,
  });
  if (!lease.ok) throw new Error(`Could not lock blind test: ${lease.reason}`);

  await withDb(baseDir, (db) => {
    const now = Date.now();
    db.prepare(`
      UPDATE spec_matrix
      SET qa_id = ?, blind_test_file = ?, blind_test_hash = ?,
          pct = CASE WHEN pct < 25 THEN 25 ELSE pct END,
          stage = CASE WHEN pct < 25 THEN 'blind_test_locked' ELSE stage END,
          updated_at = ?
      WHERE feat = ? AND req_id = ?
    `).run(qa.id, relTest, btHash, now, task.feat, task.req_id);

    db.prepare(`UPDATE desks SET qa_id = ?, status = CASE WHEN status = 'todo' THEN 'coding' ELSE status END, updated_at = ? WHERE task_id = ?`)
      .run(qa.id, now, taskId);
  });

  await recordPointEvent(baseDir, {
    empId: qa.id,
    code: 'BLIND_TEST_AUTHORED',
    taskId,
    evidence: `Locked blind test ${relTest} (${btHash.slice(0, 8)})`,
    touchedFiles: [relTest],
  });
  logAgentWal(baseDir, qa.id, 'blind_test', { task: taskId, file: relTest, hash: btHash });
  await syncTrackSnapshots(baseDir, task.feat, [task.emp_id, qa.id]);

  return { ok: true, task_id: taskId, blind_test_file: relTest, blind_test_hash: btHash, locked_by: qa.id };
}

// ---------- 2. Anti-Lie Hash-Locked Test Runner (`wrapper test`) ----------

function parseTestCounts(rawOutput, exitCode) {
  const output = stripVTControlCharacters(String(rawOutput || ''));
  let passed = 0, failed = 0;
  // Node --test: "# pass 5" / "# fail 0" or "ℹ pass 5"
  const nodePass = output.match(/(?:#|ℹ)\s*pass\s+(\d+)/i);
  const nodeFail = output.match(/(?:#|ℹ)\s*fail\s+(\d+)/i);
  if (nodePass || nodeFail) {
    passed = Number(nodePass?.[1] || 0);
    failed = Number(nodeFail?.[1] || 0);
    return { passed, failed };
  }
  // TAP fallback ("ok 1 - ...", "not ok 2 - ...")
  const tapOk = output.match(/^ok\s+\d+\b/gm);
  const tapNotOk = output.match(/^not ok\s+\d+\b/gm);
  if (tapOk || tapNotOk) {
    return { passed: tapOk ? tapOk.length : 0, failed: tapNotOk ? tapNotOk.length : 0 };
  }
  // pytest / vitest: "12 passed, 1 failed"
  const pyPass = output.match(/(\d+)\s+passed/i);
  const pyFail = output.match(/(\d+)\s+failed/i);
  if (pyPass || pyFail) {
    return { passed: Number(pyPass?.[1] || 0), failed: Number(pyFail?.[1] || 0) };
  }
  // Django unittest: "Ran 8 tests" + "OK" / "FAILED"
  const djRan = output.match(/Ran\s+(\d+)\s+tests?/i);
  if (djRan) {
    const total = Number(djRan[1]);
    return exitCode === 0 ? { passed: total, failed: 0 } : { passed: 0, failed: Math.max(1, total) };
  }
  return exitCode === 0 ? { passed: 1, failed: 0 } : { passed: 0, failed: 1 };
}

// wrapper: handwritten (hash-locked execution harness binding git working-tree hash + command stdout hash + exit code into tamper-evident receipt)
export async function runVerifiedTest(baseDir, {
  empId, taskId = null, cmd, cwd = null, tokensUsed = 0, timeoutMs = 120000,
}) {
  if (!cmd || !String(cmd).trim()) throw new Error('Test command is required');
  const p = ensureWrapperDirs(baseDir);
  const workDir = path.resolve(cwd || p.base);
  const preTree = treeHash(workDir);

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT; // Prevent parent node --test IPC mode from suppressing child test runner output

  const res = spawnSync(cmd, {
    cwd: workDir,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
  });

  const exitCode = res.status ?? -1;
  const combinedOut = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const postTree = treeHash(workDir);
  // Bind receipt to post-execution treeHash so any edit AFTER the test run invalidates the receipt!
  const outHash = hashText(combinedOut, 16);
  const receiptId = `R-${hashText(`${empId}:${taskId || ''}:${postTree}:${exitCode}:${outHash}:${Date.now()}`, 10)}`;
  const counts = parseTestCounts(combinedOut, exitCode);
  const summary = combinedOut.split(/\r?\n/).slice(-6).join(' | ').slice(0, 240);

  const receipt = {
    id: receiptId,
    emp: empId,
    task: taskId,
    cmd,
    cwd: normSlash(workDir),
    pre_tree: preTree,
    tree_hash: postTree,
    exit_code: exitCode,
    stdout_hash: outHash,
    passed: counts.passed,
    failed: counts.failed,
    tokens: Number(tokensUsed || 0),
    ts: Date.now(),
  };

  appendJsonl(p.receipts, receipt);
  logAgentWal(baseDir, empId, 'test_run', { rcpt: receiptId, exit: exitCode, tree: postTree, task: taskId });

  await withDb(baseDir, (db) => {
    db.prepare(`
      INSERT INTO receipts (receipt_id, emp_id, task_id, cmd, cwd, tree_hash, exit_code, stdout_hash, passed_count, failed_count, summary, tokens_used, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id, empId, taskId, cmd, receipt.cwd, postTree, exitCode, outHash,
      counts.passed, counts.failed, summary, receipt.tokens, receipt.ts,
    );

    if (taskId) {
      db.prepare('UPDATE desks SET tokens_used = tokens_used + ?, updated_at = ? WHERE task_id = ?')
        .run(receipt.tokens, receipt.ts, taskId);
    }
  });

  return { receipt, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ---------- 3. 0-Token Mechanical Diff, Blind-Test Tamper & Shortcut Scanner ----------

export function inspectWorkingDiff(baseDir, {
  cwd = null, empRole = 'eng', allowedFiles = [], blindTestFile = null, blindTestHash = null,
}) {
  const p = ensureWrapperDirs(baseDir);
  const workDir = path.resolve(cwd || p.base);
  const violations = [];
  let modifiedFiles = [];

  // 1. Check blind test byte-for-byte integrity first (works even without git diff!)
  if (blindTestFile && blindTestHash && empRole !== 'qa') {
    const absBt = path.resolve(workDir, blindTestFile);
    if (!fs.existsSync(absBt)) {
      violations.push({ code: 'LIE_TEST_TAMPER', detail: `Blind test file "${blindTestFile}" was deleted by ${empRole}` });
    } else {
      const curHash = hashText(fs.readFileSync(absBt, 'utf8'), 24);
      if (curHash !== blindTestHash) {
        violations.push({ code: 'LIE_TEST_TAMPER', detail: `Blind test "${blindTestFile}" was modified (${curHash.slice(0, 8)} != locked ${blindTestHash.slice(0, 8)})` });
      }
    }
  }

  const isWrapperManagedIde = (relFile) => {
    if (!['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'].includes(normSlash(relFile))) return false;
    try { return fs.readFileSync(path.join(info.top, relFile), 'utf8').includes('<!-- wrapper:v4:begin -->'); } catch { return false; }
  };

  const info = repoInfo(workDir);
  if (info) {
    const changed = git(info.top, ['diff', 'HEAD', '--name-only']);
    const untracked = git(info.top, ['ls-files', '--others', '--exclude-standard']);
    modifiedFiles = [...new Set([
      ...(changed.out ? changed.out.split(/\r?\n/) : []),
      ...(untracked.out ? untracked.out.split(/\r?\n/) : []),
    ])].filter((f) => f && !f.startsWith('.wrapper/') && !f.startsWith('_wt/') && !isWrapperManagedIde(f));

    // 2. Radius drift check
    if (allowedFiles.length && !allowedFiles.includes('*')) {
      const allowedSet = new Set(allowedFiles.map(normSlash));
      if (blindTestFile) allowedSet.add(normSlash(blindTestFile));
      for (const mf of modifiedFiles) {
        const normMf = normSlash(mf);
        const ok = [...allowedSet].some((a) => normMf === a || normMf.startsWith(a.replace(/\*$/, '')));
        if (!ok) {
          violations.push({ code: 'SCOPE_DRIFT', detail: `Modified "${normMf}" outside task radius [${[...allowedSet].join(', ')}]` });
        }
      }
    }

    // 3. Diff content scan for assertion deletion / skip injection / silent exception swallowing
    for (const mf of modifiedFiles) {
      const d = git(info.top, ['diff', 'HEAD', '-U0', '--no-color', '--', mf]);
      if (!d.ok || !d.out) continue;
      const lines = d.out.split(/\r?\n/);
      const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
      const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));
      const isTest = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|test_.*\.py$/i.test(mf);

      if (isTest && empRole !== 'qa') {
        if (added.some((l) => TEST_SKIP_RE.test(l))) {
          violations.push({ code: 'LIE_TEST_TAMPER', detail: `Added test skip annotation in "${mf}"` });
        }
        const removedAsserts = removed.filter((l) => ASSERT_RE.test(l)).length;
        const addedAsserts = added.filter((l) => ASSERT_RE.test(l)).length;
        if (removedAsserts > addedAsserts) {
          violations.push({ code: 'LIE_TEST_TAMPER', detail: `Weakened test "${mf}" (${removedAsserts} assertion(s) removed vs ${addedAsserts} added)` });
        }
      } else if (!isTest) {
        const badLine = added.find((l) => SILENT_SWALLOW_RE.test(l));
        if (badLine) {
          violations.push({ code: 'SILENT_SHORTCUT', detail: `Silent error swallowing in "${mf}": ${badLine.trim().slice(0, 90)}` });
        }
      }
    }
  }

  return { modifiedFiles, violations };
}

// ---------- 4. Engineer Task Submission Gate (`wrapper submit`) ----------

export async function submitTask(baseDir, {
  empId, taskId, receiptId = null, cwd = null, tokensUsed = 0,
}) {
  const p = ensureWrapperDirs(baseDir);
  const emp = getEmployee(baseDir, empId);
  if (!emp) throw new Error(`Unknown employee "${empId}"`);
  if (emp.st === 'terminated') throw new Error(`Employee "${empId}" is terminated and cannot submit work`);

  const bundle = await withDb(baseDir, (db) => {
    const desk = plain(db.prepare('SELECT * FROM desks WHERE task_id = ?').get(taskId));
    if (!desk) return null;
    const mat = plain(db.prepare('SELECT * FROM spec_matrix WHERE feat = ? AND req_id = ?').get(desk.feat, desk.req_id));
    const rcpt = receiptId
      ? plain(db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId))
      : plain(db.prepare('SELECT * FROM receipts WHERE task_id = ? AND emp_id = ? ORDER BY ts DESC LIMIT 1').get(taskId, emp.id));
    return { desk, mat, rcpt };
  });
  if (!bundle) throw new Error(`Unknown task "${taskId}"`);
  const { desk, mat, rcpt } = bundle;

  const workDir = path.resolve(cwd || desk.worktree || p.base);
  const curTree = treeHash(workDir);

  // Anti-Lie Gate 1: Must have a real green test receipt matching the EXACT current working-tree hash!
  if (!rcpt || rcpt.exit_code !== 0 || rcpt.tree_hash !== curTree) {
    const reason = !rcpt
      ? `Submitted ${taskId} claiming completion with NO execution receipt`
      : rcpt.exit_code !== 0
      ? `Submitted ${taskId} with failing receipt ${rcpt.receipt_id} (exit ${rcpt.exit_code})`
      : `Submitted ${taskId} with stale receipt ${rcpt.receipt_id} (receipt tree ${rcpt.tree_hash} != live tree ${curTree}; files edited after test run)`;

    const penalty = await recordPointEvent(baseDir, {
      empId: emp.id,
      code: 'LIE_FABRICATED',
      taskId,
      evidence: reason,
    });
    await withDb(baseDir, (db) => {
      db.prepare('UPDATE spec_matrix SET bounces = bounces + 1, updated_at = ? WHERE feat = ? AND req_id = ?')
        .run(Date.now(), desk.feat, desk.req_id);
      db.prepare('UPDATE desks SET attempts = attempts + 1, status = ?, note = ?, updated_at = ? WHERE task_id = ?')
        .run('blocked', reason, Date.now(), taskId);
    });
    await syncTrackSnapshots(baseDir, desk.feat, [emp.id]);
    return { ok: false, rejected_code: 'LIE_FABRICATED', reason, employee: penalty.employee };
  }

  // Anti-Lie Gate 2: 0-token diff & blind-test tamper scan
  const allowedPaths = decodeList(baseDir, JSON.parse(desk.radius_json || '[]'));
  const scan = inspectWorkingDiff(baseDir, {
    cwd: workDir,
    empRole: emp.r,
    allowedFiles: allowedPaths,
    blindTestFile: mat?.blind_test_file || null,
    blindTestHash: mat?.blind_test_hash || null,
  });

  if (scan.violations.length) {
    // Apply worst violation first (LIE_TEST_TAMPER outranks SCOPE_DRIFT / SILENT_SHORTCUT)
    const prio = { LIE_TEST_TAMPER: 3, SILENT_SHORTCUT: 2, SCOPE_DRIFT: 1 };
    scan.violations.sort((a, b) => (prio[b.code] || 0) - (prio[a.code] || 0));
    const topViolation = scan.violations[0];
    const penalty = await recordPointEvent(baseDir, {
      empId: emp.id,
      code: topViolation.code,
      taskId,
      evidence: topViolation.detail,
      touchedFiles: scan.modifiedFiles,
    });
    await withDb(baseDir, (db) => {
      db.prepare('UPDATE spec_matrix SET bounces = bounces + 1, pct = 50, stage = ?, updated_at = ? WHERE feat = ? AND req_id = ?')
        .run('bounced', Date.now(), desk.feat, desk.req_id);
      db.prepare('UPDATE desks SET attempts = attempts + 1, status = ?, note = ?, updated_at = ? WHERE task_id = ?')
        .run('coding', topViolation.detail, Date.now(), taskId);
    });
    await syncTrackSnapshots(baseDir, desk.feat, [emp.id]);
    return { ok: false, rejected_code: topViolation.code, violations: scan.violations, employee: penalty.employee };
  }

  // Passed mechanical receipt + diff guards -> advance Spec-vs-Agent Matrix to 80% (test_receipt_green) awaiting QA/PM gate!
  await withDb(baseDir, (db) => {
    const now = Date.now();
    db.prepare(`
      UPDATE spec_matrix
      SET emp_id = ?, pct = 80, stage = 'test_receipt_green', files_mod_json = ?, receipt_id = ?, updated_at = ?
      WHERE feat = ? AND req_id = ?
    `).run(emp.id, JSON.stringify(scan.modifiedFiles), rcpt.receipt_id, now, desk.feat, desk.req_id);

    db.prepare(`
      UPDATE desks
      SET status = 'submitted', attempts = attempts + 1, tokens_used = tokens_used + ?, updated_at = ?
      WHERE task_id = ?
    `).run(Number(tokensUsed || 0), now, taskId);
  });

  logAgentWal(baseDir, emp.id, 'submit', { task: taskId, rcpt: rcpt.receipt_id, pct: 80 });
  await syncTrackSnapshots(baseDir, desk.feat, [emp.id]);
  return { ok: true, task_id: taskId, pct: 80, stage: 'test_receipt_green', receipt_id: rcpt.receipt_id, modified_files: scan.modifiedFiles };
}

// ---------- 5. Independent Adversarial QA / PM Verification Gate (`wrapper verify`) ----------

export async function verifyTask(baseDir, {
  verifierId, taskId, approve = true, note = '', cwd = null, linkDeploy = true,
}) {
  const p = ensureWrapperDirs(baseDir);
  const verifier = getEmployee(baseDir, verifierId);
  if (!verifier) throw new Error(`Unknown verifier "${verifierId}"`);

  const bundle = await withDb(baseDir, (db) => {
    const desk = plain(db.prepare('SELECT * FROM desks WHERE task_id = ?').get(taskId));
    if (!desk) return null;
    const mat = plain(db.prepare('SELECT * FROM spec_matrix WHERE feat = ? AND req_id = ?').get(desk.feat, desk.req_id));
    const rcpt = mat?.receipt_id ? plain(db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(mat.receipt_id)) : null;
    return { desk, mat, rcpt };
  });
  if (!bundle) throw new Error(`Unknown task "${taskId}"`);
  const { desk, mat, rcpt } = bundle;

  if (desk.emp_id === verifier.id) {
    throw new Error(`Self-verification forbidden: "${verifier.id}" implemented ${taskId} and cannot approve their own work.`);
  }
  if (!['qa', 'pm'].includes(verifier.r)) {
    throw new Error(`Verifier must have role "qa" or "pm" ("${verifier.id}" has role "${verifier.r}")`);
  }

  if (!approve) {
    // QA/PM caught a defect -> bounce back to 50%, deduct QA_BOUNCE (-8) on engineer, credit DEFECT_CAUGHT (+4) to verifier!
    if (desk.emp_id) {
      await recordPointEvent(baseDir, {
        empId: desk.emp_id,
        code: 'QA_BOUNCE',
        taskId,
        evidence: note || `Bounced by ${verifier.h} (${verifier.id})`,
        lesson: note || undefined,
      });
    }
    await recordPointEvent(baseDir, {
      empId: verifier.id,
      code: 'DEFECT_CAUGHT',
      taskId,
      evidence: `Caught spec gap on ${taskId}: ${note}`,
    });
    await withDb(baseDir, (db) => {
      const now = Date.now();
      db.prepare('UPDATE spec_matrix SET pct = 50, stage = ?, bounces = bounces + 1, updated_at = ? WHERE feat = ? AND req_id = ?')
        .run('qa_bounced', now, desk.feat, desk.req_id);
      db.prepare('UPDATE desks SET status = ?, note = ?, updated_at = ? WHERE task_id = ?')
        .run('coding', note || 'QA bounced', now, taskId);
    });
    await syncTrackSnapshots(baseDir, desk.feat, [desk.emp_id, verifier.id]);
    return { ok: true, approved: false, pct: 50, stage: 'qa_bounced' };
  }

  // Re-verify receipt exists and still matches live working tree before granting 100%
  const workDir = path.resolve(cwd || desk.worktree || p.base);
  if (!rcpt || rcpt.exit_code !== 0 || rcpt.tree_hash !== treeHash(workDir)) {
    throw new Error(`Cannot verify ${taskId} to 100%: missing or stale green execution receipt.`);
  }

  const modFiles = JSON.parse(mat.files_mod_json || '[]');
  await withDb(baseDir, (db) => {
    const now = Date.now();
    db.prepare('UPDATE spec_matrix SET pct = 100, stage = ?, qa_id = ?, updated_at = ? WHERE feat = ? AND req_id = ?')
      .run('verified', verifier.id, now, desk.feat, desk.req_id);
    db.prepare('UPDATE desks SET status = ?, note = ?, updated_at = ? WHERE task_id = ?')
      .run('verified', note || 'QA+PM verified', now, taskId);
  });

  if (desk.emp_id) {
    await recordPointEvent(baseDir, {
      empId: desk.emp_id,
      code: 'CLEAN_PASS',
      customDelta: (mat.bounces || 0) === 0 ? null : 2, // +5 on true 1st-pass clean pass, +2 if after bounce
      taskId,
      evidence: `Verified 100% on ${desk.feat}/${desk.req_id} (${rcpt.receipt_id})`,
      touchedFiles: modFiles.length ? modFiles : decodeList(baseDir, JSON.parse(desk.radius_json || '[]')),
    });
    await releaseFileLeases(baseDir, desk.emp_id, { releaseBlindTests: false });
  }
  await releaseFileLeases(baseDir, verifier.id, { releaseBlindTests: true });

  // Automatic two-way .deployment link when all requirements in feature reach 100% (or when requested)
  let deploySynced = null;
  if (linkDeploy) {
    const remaining = await withDb(baseDir, (db) =>
      db.prepare('SELECT COUNT(*) AS c FROM spec_matrix WHERE feat = ? AND pct < 100').get(desk.feat).c,
    );
    if (remaining === 0) {
      deploySynced = linkSpecToDeployment(baseDir, desk.feat);
    }
  }

  logAgentWal(baseDir, verifier.id, 'verify', { task: taskId, pct: 100 });
  await syncTrackSnapshots(baseDir, desk.feat, [desk.emp_id, verifier.id]);
  return { ok: true, approved: true, pct: 100, stage: 'verified', deploy_linked: deploySynced };
}

// ---------- 6. Structured Token-Capped Discussion Rooms ----------

export async function openRoom(baseDir, { topic, feat = null, chairId, members = [] }) {
  const roomId = `RM-${Date.now().toString(36)}-${hashText(topic, 4)}`;
  const now = Date.now();
  const allMembers = [...new Set([chairId, ...members].filter(Boolean))];
  await withDb(baseDir, (db, p) => {
    db.prepare(`
      INSERT INTO rooms (room_id, topic, feat, chair_id, members_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(roomId, topic, feat, chairId, JSON.stringify(allMembers), now);
    appendJsonl(path.join(p.roomsDir, `${roomId}.jsonl`), { ev: 'open', id: roomId, topic, chair: chairId, members: allMembers, ts: now });
  });
  return { room_id: roomId, topic, chair_id: chairId, members: allMembers };
}

export async function postRoomTurn(baseDir, { roomId, empId, kind, body }) {
  if (!ROOM_TURN_KINDS.has(kind)) {
    throw new Error(`Invalid room turn kind "${kind}" (must be: ${[...ROOM_TURN_KINDS].join('|')})`);
  }
  const cleanBody = String(body || '').trim();
  if (!cleanBody) throw new Error('Room turn body cannot be empty');
  const clipped = cleanBody.length > MAX_TURN_CHARS ? cleanBody.slice(0, MAX_TURN_CHARS - 1) + '…' : cleanBody;
  const now = Date.now();

  await withDb(baseDir, (db, p) => {
    const room = plain(db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId));
    if (!room) throw new Error(`Unknown room "${roomId}"`);
    if (room.status !== 'open') throw new Error(`Room "${roomId}" is already closed`);
    db.prepare('INSERT INTO room_turns (room_id, emp_id, kind, body, ts) VALUES (?, ?, ?, ?, ?)')
      .run(roomId, empId, kind, clipped, now);
    appendJsonl(path.join(p.roomsDir, `${roomId}.jsonl`), { emp: empId, k: kind, b: clipped, ts: now });
  });
  return { room_id: roomId, emp_id: empId, kind, body: clipped };
}

export async function closeRoom(baseDir, { roomId, chairId, resolution }) {
  const now = Date.now();
  await withDb(baseDir, (db, p) => {
    const room = plain(db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId));
    if (!room) throw new Error(`Unknown room "${roomId}"`);
    db.prepare('UPDATE rooms SET status = ?, resolution = ?, closed_at = ? WHERE room_id = ?')
      .run('closed', String(resolution || '').trim(), now, roomId);
    appendJsonl(path.join(p.roomsDir, `${roomId}.jsonl`), { ev: 'close', by: chairId, res: resolution, ts: now });
  });
  if (chairId && chairId !== 'CEO') {
    await recordPointEvent(baseDir, { empId: chairId, code: 'CRISP_HUDDLE', evidence: `Closed ${roomId}: ${resolution}` });
  }
  return { room_id: roomId, status: 'closed', resolution };
}

// ---------- 7. Ultra-Low-Token Agent Context Slice Builder (`wrapper ctx`) ----------

export async function buildAgentContext(baseDir, { empId, taskId = null }) {
  const sym = loadSymMap(baseDir);
  const rawEmp = getEmployee(baseDir, empId);
  if (!rawEmp) throw new Error(`Unknown employee "${empId}"`);
  const emp = expandSymbols(baseDir, rawEmp, sym);
  const team = listTeams(baseDir).find((t) => t.id === emp.tm) || null;

  const taskData = await withDb(baseDir, (db) => {
    const desk = taskId
      ? plain(db.prepare('SELECT * FROM desks WHERE task_id = ?').get(taskId))
      : plain(db.prepare("SELECT * FROM desks WHERE emp_id = ? AND status != 'verified' ORDER BY wave, task_id LIMIT 1").get(emp.id));
    const pushbacks = plainAll(db.prepare('SELECT severity, message FROM pushbacks WHERE emp_id = ? AND acked = 0').all(emp.id));
    const mat = desk
      ? plain(db.prepare('SELECT pct, stage, blind_test_file FROM spec_matrix WHERE feat = ? AND req_id = ?').get(desk.feat, desk.req_id))
      : null;
    return { desk, mat, pushbacks };
  });

  // Blind TDD Enforcement at Prompt Time: Engineers see ONLY the spec predicate, never QA's blind test assertions!
  const specSlice = taskData.desk
    ? getSpecSlice(baseDir, taskData.desk.feat, [taskData.desk.req_id], { expand: true })
    : null;

  const ctx = {
    you: {
      id: emp.id,
      name: `${emp.n} (@${emp.h})`,
      title: emp.ti,
      status: emp.st,
      pts: emp.pts,
      inst: emp.inst,
      patterns: emp.pat,
      lessons: emp.xp?.lessons || [],
    },
    team_rules: team ? { lead: team.lead, patterns: team.pat, never_do: team.never_do } : null,
    task: taskData.desk ? {
      id: taskData.desk.task_id,
      req: taskData.desk.req_id,
      stage: taskData.mat?.stage,
      pct: taskData.mat?.pct,
      worktree: taskData.desk.worktree,
      allowed_files: decodeList(baseDir, JSON.parse(taskData.desk.radius_json || '[]'), sym),
      readonly_blind_test: emp.r !== 'qa' ? taskData.mat?.blind_test_file || null : undefined,
    } : null,
    spec_slice: specSlice,
    pm_pushbacks: taskData.pushbacks,
  };
  ctx._tokens_estimate = estimateTokens(ctx);
  return ctx;
}

// ---------- 8. Real-World Accuracy Scoreboard & Human-Readable Decoder (`inspect`) ----------

export async function computeScoreboard(baseDir) {
  const roster = listRoster(baseDir, { includeTerminated: true, expand: true });
  return withDb(baseDir, (db) => {
    const mat = plainAll(db.prepare('SELECT * FROM spec_matrix').all());
    const desks = plainAll(db.prepare('SELECT * FROM desks').all());
    const ledger = plainAll(db.prepare('SELECT * FROM point_ledger').all());

    const totalReqs = mat.length;
    const verifiedReqs = mat.filter((m) => m.pct === 100);
    const firstPassVerified = verifiedReqs.filter((m) => (m.bounces || 0) === 0);
    const blamedBugs = ledger.filter((l) => l.code === 'BUG_INTRODUCED').length;
    const liesCaught = ledger.filter((l) => l.code.startsWith('LIE_')).length;
    const bouncesCaught = ledger.filter((l) => ['QA_BOUNCE', 'SCOPE_DRIFT', 'SILENT_SHORTCUT'].includes(l.code)).length;
    const totalTokens = desks.reduce((acc, d) => acc + (d.tokens_used || 0), 0);

    // Core Principal-Level Accuracy Metrics:
    // FPPR = First-Pass Pass Rate (verified 100% with 0 bounces / verified Reqs)
    // EDR  = Escaped Defect Rate (post-merge git-blamed bugs / verified Reqs)
    // LCR  = Lie & Shortcut Pre-Merge Catch Count
    // TVR  = Tokens per Verified Requirement
    const fppr = verifiedReqs.length ? Number(((firstPassVerified.length / verifiedReqs.length) * 100).toFixed(1)) : 0;
    const edr = verifiedReqs.length ? Number(((blamedBugs / verifiedReqs.length) * 100).toFixed(1)) : 0;
    const avgSpecPct = totalReqs ? Number((mat.reduce((a, m) => a + m.pct, 0) / totalReqs).toFixed(1)) : 0;
    const tvr = verifiedReqs.length ? Math.round(totalTokens / verifiedReqs.length) : totalTokens;

    return {
      metrics: {
        overall_spec_completion_pct: avgSpecPct,
        total_requirements: totalReqs,
        verified_requirements: verifiedReqs.length,
        FPPR_first_pass_pass_rate_pct: fppr,
        EDR_escaped_defect_rate_pct: edr,
        LCR_lies_caught_pre_merge: liesCaught,
        bounces_caught_pre_merge: bouncesCaught,
        TVR_tokens_per_verified_req: tvr,
      },
      roster_summary: roster.map((e) => ({
        id: e.id,
        name: `${e.n} (@${e.h})`,
        role: `${e.r}/${e.lv}`,
        team: e.tm,
        status: e.st,
        pts: e.pts,
        wins: e.wl?.[0] || 0,
        bugs: e.wl?.[1] || 0,
        lies: e.wl?.[2] || 0,
        bounces: e.wl?.[3] || 0,
      })),
    };
  });
}

export async function inspectHumanReadable(baseDir, target = 'all') {
  const p = ensureWrapperDirs(baseDir);
  const sym = loadSymMap(baseDir);
  const sb = await computeScoreboard(baseDir);
  const specs = listSpecs(baseDir);
  const teams = listTeams(baseDir);
  const deploy = readJson(p.deploy, null);

  const matrixByFeat = await withDb(baseDir, (db) =>
    plainAll(db.prepare('SELECT * FROM spec_matrix ORDER BY feat, req_id').all()).map((m) => ({
      feat: m.feat,
      req: m.req_id,
      task: m.task_id,
      engineer: m.emp_id,
      qa: m.qa_id,
      pct: `${m.pct}%`,
      stage: m.stage,
      blind_test: m.blind_test_file,
      files_modified: expandSymbols(baseDir, JSON.parse(m.files_mod_json || '[]'), sym),
      receipt: m.receipt_id,
      bounces: m.bounces,
    })),
  );

  if (target === 'docs') return { specs, deploy, symbols_count: Object.keys(sym).length };
  if (target === 'agents') return { roster: sb.roster_summary, teams };
  if (target === 'track') return { scoreboard: sb.metrics, spec_vs_agent_matrix: matrixByFeat };
  return {
    scoreboard: sb.metrics,
    specs,
    deploy,
    teams,
    roster: sb.roster_summary,
    spec_vs_agent_matrix: matrixByFeat,
  };
}
