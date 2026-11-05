// Disjoint-File DAG Scheduler, Atomic OS+SQLite File Leases, and Per-Agent Git Worktree Provisioner.
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWrapperDirs, readJsonl, writeJson, writeJsonl, relToBase, normSlash,
} from './io.mjs';
import { intern, decode, decodeList } from './sym.mjs';
import { withDb, plain, plainAll } from './db.mjs';
import { specFiles } from './docs.mjs';
import { getEmployee, matchOrHire } from './agents.mjs';
import { git, repoInfo } from './gitutil.mjs';

const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000;

export async function syncTrackSnapshots(baseDir, feat = null, empIds = []) {
  await withDb(baseDir, (db, p) => {
    const feats = feat
      ? [feat]
      : plainAll(db.prepare('SELECT DISTINCT feat FROM spec_matrix').all()).map((r) => r.feat);
    for (const f of feats) {
      const rows = plainAll(db.prepare('SELECT * FROM spec_matrix WHERE feat = ? ORDER BY req_id').all(f)).map((r) => ({
        req: r.req_id,
        task: r.task_id,
        emp: r.emp_id,
        qa: r.qa_id,
        pct: r.pct,
        stage: r.stage,
        bt: r.blind_test_file,
        f_mod: JSON.parse(r.files_mod_json || '[]'),
        rcpt: r.receipt_id,
        bounces: r.bounces,
      }));
      writeJsonl(path.join(p.matrixDir, `${f}.jsonl`), rows);
    }

    const emps = empIds.length
      ? [...new Set(empIds.filter(Boolean))]
      : plainAll(db.prepare('SELECT DISTINCT emp_id FROM desks WHERE emp_id IS NOT NULL').all()).map((r) => r.emp_id);
    for (const eid of emps) {
      const tasks = plainAll(db.prepare('SELECT * FROM desks WHERE emp_id = ? ORDER BY wave, task_id').all(eid)).map((t) => ({
        id: t.task_id,
        feat: t.feat,
        req: t.req_id,
        st: t.status,
        wave: t.wave,
        deps: JSON.parse(t.deps_json || '[]'),
        rad: JSON.parse(t.radius_json || '[]'),
        wt: t.worktree,
        att: t.attempts,
      }));
      const pushbacks = plainAll(db.prepare('SELECT id, from_pm, severity, message, ts FROM pushbacks WHERE emp_id = ? AND acked = 0').all(eid));
      writeJson(path.join(p.desksDir, `${eid}.json`), { emp: eid, updated_at: Date.now(), queue: tasks, pushbacks });
    }
  });
}

// wrapper: handwritten (greedy file-intersection DAG wave partitioner so concurrent agents never edit overlapping radius files in the same wave)
export function partitionDisjointWaves(reqs) {
  // Each req has { id, f: [fileCode, ...] }.
  // Assigns each requirement to the earliest wave >= 0 where NONE of its files overlap with another task in that wave,
  // and links sequential `deps` to the prior wave holder of any shared file.
  const waves = []; // Array<{ fileHolders: Map<fileCode, taskId>, items: [] }>
  const scheduled = [];

  for (const req of reqs) {
    const taskId = `TK-${req.id}`;
    const files = req.f?.length ? req.f : [`__virtual_${req.id}`];
    let targetWave = 0;
    for (let w = 0; w < waves.length; w++) {
      const hasConflict = files.some((fc) => waves[w].fileHolders.has(fc));
      if (hasConflict) targetWave = w + 1;
    }
    while (waves.length <= targetWave) {
      waves.push({ fileHolders: new Map(), items: [] });
    }
    const deps = new Set();
    for (let w = targetWave - 1; w >= 0; w--) {
      for (const fc of files) {
        if (waves[w].fileHolders.has(fc)) deps.add(waves[w].fileHolders.get(fc));
      }
    }
    for (const fc of files) waves[targetWave].fileHolders.set(fc, taskId);
    const entry = {
      taskId,
      req,
      wave: targetWave,
      deps: [...deps],
    };
    waves[targetWave].items.push(entry);
    scheduled.push(entry);
  }
  return scheduled;
}

export async function scheduleSpec(baseDir, feat, {
  pmId = null, autoStaff = true, tech = ['node'], level = 'L2', provisionWorktrees = false,
} = {}) {
  const { slug, specPath } = specFiles(baseDir, feat);
  const allReqs = readJsonl(specPath).filter((r) => r.st !== 'deprecated');
  if (!allReqs.length) throw new Error(`No active requirements found in ${slug}.spec.jsonl`);

  // Ensure a Team PM exists if autoStaff is enabled and none was supplied
  let resolvedPmId = pmId;
  if (!resolvedPmId && autoStaff) {
    const pmMatch = matchOrHire(baseDir, {
      archetype: 'PM', role: 'pm', level: 'Lead', domain: slug, team: slug, tech: ['dag-scheduling'], ceoConfirmed: true,
    });
    resolvedPmId = pmMatch.employee.id;
  }

  const dag = partitionDisjointWaves(allReqs);
  const touchedEmps = new Set();
  const createdTasks = [];

  await withDb(baseDir, (db) => {
    for (const node of dag) {
      const existing = plain(db.prepare('SELECT * FROM spec_matrix WHERE feat = ? AND req_id = ?').get(slug, node.req.id));
      if (existing && existing.pct === 100) continue;

      let engId = existing?.emp_id || null;
      let qaId = existing?.qa_id || null;

      if (autoStaff && !engId) {
        const engRes = matchOrHire(baseDir, {
          role: 'eng',
          level,
          domain: slug,
          team: slug,
          tech,
          files: decodeList(baseDir, node.req.f),
          ceoConfirmed: true,
        });
        engId = engRes.employee.id;
      }
      if (autoStaff && !qaId) {
        const qaRes = matchOrHire(baseDir, {
          archetype: 'QA',
          role: 'qa',
          level: 'L2',
          domain: slug,
          team: slug,
          tech,
          files: [],
          ceoConfirmed: true,
        }, { excludeIds: engId ? [engId] : [] });
        qaId = qaRes.employee.id;
      }

      let wtPath = null;
      if (provisionWorktrees && engId) {
        const wt = provisionWorktree(baseDir, engId);
        if (wt.ok) wtPath = wt.path;
      }

      const now = Date.now();
      db.prepare(`
        INSERT INTO desks (task_id, feat, req_id, title, emp_id, qa_id, pm_id, status, wave, deps_json, radius_json, worktree, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          emp_id = COALESCE(excluded.emp_id, desks.emp_id),
          qa_id = COALESCE(excluded.qa_id, desks.qa_id),
          pm_id = COALESCE(excluded.pm_id, desks.pm_id),
          wave = excluded.wave,
          deps_json = excluded.deps_json,
          radius_json = excluded.radius_json,
          worktree = COALESCE(excluded.worktree, desks.worktree),
          updated_at = excluded.updated_at
      `).run(
        node.taskId,
        slug,
        node.req.id,
        `[${slug}/${node.req.id}] ${node.req.s}: ${node.req.w}`,
        engId,
        qaId,
        resolvedPmId,
        node.wave,
        JSON.stringify(node.deps),
        JSON.stringify(node.req.f || []),
        wtPath,
        now,
        now,
      );

      const nextPct = existing?.pct > 0 ? existing.pct : (engId ? 25 : 0);
      const nextStage = existing?.pct > 0 ? existing.stage : (engId ? 'claimed' : 'open');
      db.prepare(`
        INSERT INTO spec_matrix (feat, req_id, task_id, emp_id, qa_id, pct, stage, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feat, req_id) DO UPDATE SET
          task_id = excluded.task_id,
          emp_id = COALESCE(spec_matrix.emp_id, excluded.emp_id),
          qa_id = COALESCE(spec_matrix.qa_id, excluded.qa_id),
          pct = CASE WHEN spec_matrix.pct > excluded.pct THEN spec_matrix.pct ELSE excluded.pct END,
          stage = CASE WHEN spec_matrix.pct > excluded.pct THEN spec_matrix.stage ELSE excluded.stage END,
          updated_at = excluded.updated_at
      `).run(slug, node.req.id, node.taskId, engId, qaId, nextPct, nextStage, now);

      if (engId) touchedEmps.add(engId);
      if (qaId) touchedEmps.add(qaId);
      createdTasks.push({
        task_id: node.taskId,
        req_id: node.req.id,
        wave: node.wave,
        deps: node.deps,
        emp_id: engId,
        qa_id: qaId,
        pm_id: resolvedPmId,
        files: decodeList(baseDir, node.req.f),
        worktree: wtPath,
      });
    }
  });

  await syncTrackSnapshots(baseDir, slug, [...touchedEmps]);
  return { feat: slug, pm_id: resolvedPmId, tasks: createdTasks };
}

// Kernel-atomic O_EXCL lock file + SQLite lease row with Blind-Test Read-Only Guard.
export async function acquireFileLease(baseDir, {
  empId, filePath, mode = 'rw', role = null, ttlMs = DEFAULT_LEASE_TTL_MS, taskId = null,
}) {
  const emp = getEmployee(baseDir, empId);
  const resolvedRole = role || emp?.r || 'eng';
  const rel = relToBase(baseDir, filePath);
  const fileCode = intern(baseDir, rel, 'F');
  const now = Date.now();

  return withDb(baseDir, (db, p) => {
    const cur = plain(db.prepare('SELECT * FROM file_leases WHERE file_code = ?').get(fileCode));
    if (cur) {
      // Blind-test locks NEVER expire automatically until task verification completes, protecting QA tests from Engineers!
      if (cur.mode === 'ro_blind_test' && resolvedRole !== 'qa' && resolvedRole !== 'pm') {
        return {
          ok: false,
          blind_test_violation: true,
          holder: cur.emp_id,
          file: rel,
          reason: `Blind QA test "${rel}" is read-only locked by ${cur.emp_id}; implementing engineers may not edit blind tests.`,
        };
      }
      if (cur.emp_id !== empId && cur.expires_at > now) {
        return {
          ok: false,
          blind_test_violation: false,
          holder: cur.emp_id,
          file: rel,
          reason: `File "${rel}" (${fileCode}) is leased by ${cur.emp_id} until ${new Date(cur.expires_at).toISOString()}`,
        };
      }
      // Expired lease: clean up stale OS lock file
      if (cur.emp_id !== empId && cur.expires_at <= now) {
        try { fs.rmSync(path.join(p.locksDir, `${fileCode}.lock`), { force: true }); } catch {}
      }
    }

    const lockFile = path.join(p.locksDir, `${fileCode}.lock`);
    if (!cur || cur.emp_id !== empId) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ emp: empId, file: rel, mode, pid: process.pid, exp: now + ttlMs }));
        fs.closeSync(fd);
      } catch (e) {
        if (e.code === 'EEXIST') {
          try {
            const diskLock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            if (diskLock.emp !== empId && diskLock.exp > now) {
              return { ok: false, blind_test_violation: diskLock.mode === 'ro_blind_test', holder: diskLock.emp, file: rel, reason: `OS lock held by ${diskLock.emp}` };
            }
          } catch {}
          fs.writeFileSync(lockFile, JSON.stringify({ emp: empId, file: rel, mode, pid: process.pid, exp: now + ttlMs }));
        }
      }
    }

    const exp = mode === 'ro_blind_test' ? now + 7 * 24 * 3600 * 1000 : now + ttlMs;
    db.prepare(`
      INSERT INTO file_leases (file_code, file_path, emp_id, mode, locked_by_role, pid, expires_at, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_code) DO UPDATE SET
        emp_id = excluded.emp_id,
        mode = excluded.mode,
        locked_by_role = excluded.locked_by_role,
        pid = excluded.pid,
        expires_at = excluded.expires_at,
        task_id = excluded.task_id
    `).run(fileCode, rel, empId, mode, resolvedRole, process.pid, exp, taskId);

    return { ok: true, file_code: fileCode, file: rel, mode, expires_at: exp };
  });
}

export async function releaseFileLeases(baseDir, empId, { releaseBlindTests = false } = {}) {
  return withDb(baseDir, (db, p) => {
    const rows = plainAll(db.prepare('SELECT * FROM file_leases WHERE emp_id = ?').all(empId));
    let count = 0;
    for (const r of rows) {
      if (r.mode === 'ro_blind_test' && !releaseBlindTests) continue;
      db.prepare('DELETE FROM file_leases WHERE file_code = ?').run(r.file_code);
      try { fs.rmSync(path.join(p.locksDir, `${r.file_code}.lock`), { force: true }); } catch {}
      count++;
    }
    return count;
  });
}

export function provisionWorktree(baseDir, empId, { branchPrefix = 'wt' } = {}) {
  const p = ensureWrapperDirs(baseDir);
  const info = repoInfo(p.base);
  if (!info) return { ok: false, reason: 'Not a git repository' };
  const emp = getEmployee(baseDir, empId);
  const slug = (emp?.h || empId).replace(/[^A-Za-z0-9_-]/g, '-');
  const wtDir = path.join(info.top, '_wt', slug);
  const branch = `${branchPrefix}/${slug}`;
  if (fs.existsSync(wtDir)) return { ok: true, path: normSlash(wtDir), branch, reused: true };

  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  const branchExists = git(info.top, ['rev-parse', '--verify', '-q', branch]).ok;
  const args = branchExists
    ? ['worktree', 'add', '-q', wtDir, branch]
    : ['worktree', 'add', '-q', '-b', branch, wtDir];
  const r = git(info.top, args);
  if (!r.ok) return { ok: false, reason: r.err.trim() };
  return { ok: true, path: normSlash(wtDir), branch, reused: false };
}
