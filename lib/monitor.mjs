// Cross-Platform Team PM Watchtower: monitors Claude Code (hooks), Antigravity (pulse/CLI),
// and ChatGPT/Codex (bound worktree + git pre-commit audit), enforces blind-test & radius guards,
// issues PM pushbacks/halts, and compiles CEO sitreps.
import path from 'node:path';
import { ensureWrapperDirs, appendJsonl, relToBase } from './io.mjs';
import { decodeList } from './sym.mjs';
import { withDb, plain, plainAll } from './db.mjs';
import { getEmployee, listRoster, listTeams, recordPointEvent } from './agents.mjs';
import { acquireFileLease, syncTrackSnapshots } from './scheduler.mjs';
import { inspectWorkingDiff, computeScoreboard } from './track.mjs';

export async function recordTelemetry(baseDir, {
  empId, tool = 'cli', event, target = '', detail = '', flagged = false, flagReason = '',
}) {
  const now = Date.now();
  await withDb(baseDir, (db, p) => {
    db.prepare(`
      INSERT INTO telemetry (emp_id, tool, event, target, detail, flagged, flag_reason, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(empId || 'unknown', tool, event, target, detail, flagged ? 1 : 0, flagReason, now);
    if (empId) {
      appendJsonl(path.join(p.runsDir, `${empId}.jsonl`), {
        ts: now, tool, ev: event, tgt: target, flg: flagged ? flagReason : undefined,
      });
    }
  });
}

export async function issuePushback(baseDir, {
  empId, fromPm = 'emp-pm', taskId = null, severity = 'warn', message,
}) {
  const now = Date.now();
  await withDb(baseDir, (db) => {
    db.prepare(`
      INSERT INTO pushbacks (emp_id, from_pm, task_id, severity, message, acked, ts)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(empId, fromPm, taskId, severity, message, now);
    if (severity === 'halt' && taskId) {
      db.prepare("UPDATE desks SET status = 'blocked', note = ?, updated_at = ? WHERE task_id = ?")
        .run(`HALTED by ${fromPm}: ${message}`, now, taskId);
    }
  });
  await syncTrackSnapshots(baseDir, null, [empId]);
  return { ok: true, emp_id: empId, severity, message };
}

export async function ackPushbacks(baseDir, empId) {
  await withDb(baseDir, (db) => {
    db.prepare('UPDATE pushbacks SET acked = 1 WHERE emp_id = ? AND acked = 0').run(empId);
  });
  await syncTrackSnapshots(baseDir, null, [empId]);
}

// wrapper: handwritten (pre-edit cross-tool guard blocking terminated agents, blind-test tampering, lease collisions, and out-of-radius drift)
export async function evaluateEditGuard(baseDir, { empId, tool = 'claude', filePath, taskId = null }) {
  const emp = getEmployee(baseDir, empId);
  const rel = relToBase(baseDir, filePath);
  if (!emp) {
    await recordTelemetry(baseDir, { empId: empId || 'unregistered', tool, event: 'edit_attempt', target: rel });
    return { allow: true, unregistered: true };
  }

  if (emp.st === 'terminated') {
    const reason = `Agent ${emp.id} (${emp.n}) is TERMINATED (${emp.pts} pts) and blocked from editing files.`;
    await recordTelemetry(baseDir, { empId: emp.id, tool, event: 'blocked_edit', target: rel, flagged: true, flagReason: reason });
    return { allow: false, decision: 'deny', code: 'TERMINATED', reason };
  }

  // Check active task radius & unacknowledged HALT pushbacks
  const activeCtx = await withDb(baseDir, (db) => {
    const halt = plain(db.prepare("SELECT * FROM pushbacks WHERE emp_id = ? AND severity = 'halt' AND acked = 0 LIMIT 1").get(emp.id));
    const desk = taskId
      ? plain(db.prepare('SELECT * FROM desks WHERE task_id = ?').get(taskId))
      : plain(db.prepare("SELECT * FROM desks WHERE emp_id = ? AND status != 'verified' ORDER BY wave, task_id LIMIT 1").get(emp.id));
    return { halt, desk };
  });

  if (activeCtx.halt) {
    const reason = `HALT order active from Team PM (${activeCtx.halt.from_pm}): ${activeCtx.halt.message}`;
    await recordTelemetry(baseDir, { empId: emp.id, tool, event: 'halted_edit', target: rel, flagged: true, flagReason: reason });
    return { allow: false, decision: 'deny', code: 'PM_HALT', reason };
  }

  // Check OS + SQLite file lease (includes Blind TDD read-only lock protection!)
  const lease = await acquireFileLease(baseDir, {
    empId: emp.id,
    filePath: rel,
    mode: 'rw',
    role: emp.r,
    taskId: activeCtx.desk?.task_id || taskId,
  });

  if (!lease.ok) {
    if (lease.blind_test_violation) {
      await recordPointEvent(baseDir, {
        empId: emp.id,
        code: 'LIE_TEST_TAMPER',
        taskId: activeCtx.desk?.task_id || taskId,
        evidence: `Attempted to modify locked blind QA test "${rel}" via ${tool}`,
      });
      await issuePushback(baseDir, {
        empId: emp.id,
        fromPm: activeCtx.desk?.pm_id || 'emp-hr',
        taskId: activeCtx.desk?.task_id || null,
        severity: 'halt',
        message: `Blocked blind-test tamper attempt on "${rel}" (-30 pts). Fix implementation, never QA tests.`,
      });
      await recordTelemetry(baseDir, { empId: emp.id, tool, event: 'blind_test_tamper', target: rel, flagged: true, flagReason: lease.reason });
      return { allow: false, decision: 'deny', code: 'LIE_TEST_TAMPER', reason: lease.reason };
    }
    await recordTelemetry(baseDir, { empId: emp.id, tool, event: 'lease_conflict', target: rel, flagged: true, flagReason: lease.reason });
    return { allow: false, decision: 'deny', code: 'LEASE_CONFLICT', reason: lease.reason };
  }

  // Check task radius if engineer has an assigned desk task with bounded radius
  if (activeCtx.desk && emp.r === 'eng') {
    const allowed = decodeList(baseDir, JSON.parse(activeCtx.desk.radius_json || '[]'));
    if (allowed.length && !allowed.includes('*')) {
      const inRadius = allowed.some((a) => rel === a || rel.startsWith(a.replace(/\*$/, '')));
      if (!inRadius) {
        const msg = `Out-of-radius edit "${rel}" (allowed: ${allowed.join(', ')})`;
        await recordPointEvent(baseDir, {
          empId: emp.id,
          code: 'SCOPE_DRIFT',
          taskId: activeCtx.desk.task_id,
          evidence: msg,
        });
        await issuePushback(baseDir, {
          empId: emp.id,
          fromPm: activeCtx.desk.pm_id || 'PM',
          taskId: activeCtx.desk.task_id,
          severity: 'warn',
          message: `${msg}. Revert or request radius expansion from RE/PM.`,
        });
        await recordTelemetry(baseDir, { empId: emp.id, tool, event: 'scope_drift', target: rel, flagged: true, flagReason: msg });
        return { allow: false, decision: 'ask', code: 'SCOPE_DRIFT', reason: msg };
      }
    }
  }

  await recordTelemetry(baseDir, { empId: emp.id, tool, event: 'edit', target: rel });
  return { allow: true, decision: 'allow', lease };
}

// Monitor adapter for ChatGPT / Codex / external editors that don't fire real-time PreToolUse hooks:
// audits their bound worktree or repo diff before commit/merge and applies identical HR & PM rules.
export async function auditExternalAgentWorktree(baseDir, { empId, tool = 'chatgpt', cwd = null, taskId = null }) {
  const emp = getEmployee(baseDir, empId);
  if (!emp) throw new Error(`Unknown employee "${empId}"`);
  const p = ensureWrapperDirs(baseDir);

  const ctx = await withDb(baseDir, (db) => {
    const desk = taskId
      ? plain(db.prepare('SELECT * FROM desks WHERE task_id = ?').get(taskId))
      : plain(db.prepare("SELECT * FROM desks WHERE emp_id = ? AND status != 'verified' ORDER BY wave, task_id LIMIT 1").get(emp.id));
    const mat = desk
      ? plain(db.prepare('SELECT * FROM spec_matrix WHERE feat = ? AND req_id = ?').get(desk.feat, desk.req_id))
      : null;
    return { desk, mat };
  });

  const workDir = path.resolve(cwd || ctx.desk?.worktree || p.base);
  const allowed = ctx.desk ? decodeList(baseDir, JSON.parse(ctx.desk.radius_json || '[]')) : [];
  const scan = inspectWorkingDiff(baseDir, {
    cwd: workDir,
    empRole: emp.r,
    allowedFiles: allowed,
    blindTestFile: ctx.mat?.blind_test_file || null,
    blindTestHash: ctx.mat?.blind_test_hash || null,
  });

  for (const mf of scan.modifiedFiles) {
    await recordTelemetry(baseDir, {
      empId: emp.id,
      tool,
      event: 'worktree_diff',
      target: mf,
      flagged: scan.violations.length > 0,
      flagReason: scan.violations.map((v) => `${v.code}:${v.detail}`).join('; '),
    });
  }

  if (scan.violations.length) {
    const top = scan.violations[0];
    await recordPointEvent(baseDir, {
      empId: emp.id,
      code: top.code,
      taskId: ctx.desk?.task_id || taskId,
      evidence: `[${tool} audit] ${top.detail}`,
      touchedFiles: scan.modifiedFiles,
    });
    await issuePushback(baseDir, {
      empId: emp.id,
      fromPm: ctx.desk?.pm_id || 'PM',
      taskId: ctx.desk?.task_id || taskId,
      severity: top.code === 'LIE_TEST_TAMPER' ? 'halt' : 'warn',
      message: `[${tool} monitor] ${top.detail}`,
    });
  }

  return {
    ok: scan.violations.length === 0,
    emp_id: emp.id,
    tool,
    modified_files: scan.modifiedFiles,
    violations: scan.violations,
  };
}

// Team PM Executive Sitrep for CEO: shows active workers across Claude/Antigravity/ChatGPT,
// leased files, flagged anomalies, probation/fired agents, and Spec-vs-Agent progress.
export async function generatePmSitrep(baseDir, { teamId = null } = {}) {
  const sb = await computeScoreboard(baseDir);
  const teams = listTeams(baseDir).filter((t) => !teamId || t.id === teamId);
  const roster = listRoster(baseDir, { includeTerminated: true });
  const teamMemberIds = teamId
    ? new Set(teams.flatMap((t) => t.members || []))
    : null;

  return withDb(baseDir, (db) => {
    const activeLeases = plainAll(db.prepare('SELECT * FROM file_leases WHERE expires_at > ? ORDER BY file_path').all(Date.now()))
      .filter((l) => !teamMemberIds || teamMemberIds.has(l.emp_id));
    const recentFlags = plainAll(db.prepare('SELECT * FROM telemetry WHERE flagged = 1 ORDER BY ts DESC LIMIT 15').all())
      .filter((f) => !teamMemberIds || teamMemberIds.has(f.emp_id));
    const openPushbacks = plainAll(db.prepare('SELECT * FROM pushbacks WHERE acked = 0 ORDER BY ts DESC').all())
      .filter((pb) => !teamMemberIds || teamMemberIds.has(pb.emp_id));
    const byTool = plainAll(db.prepare('SELECT tool, COUNT(*) AS events FROM telemetry GROUP BY tool').all());

    const watchlist = roster
      .filter((e) => (!teamMemberIds || teamMemberIds.has(e.id)) && (e.st !== 'active' || (e.wl?.[2] || 0) > 0 || (e.wl?.[1] || 0) > 0))
      .map((e) => ({ id: e.id, name: e.n, status: e.st, pts: e.pts, wl: e.wl }));

    return {
      generated_at: new Date().toISOString(),
      team_filter: teamId || 'all',
      accuracy_scoreboard: sb.metrics,
      tool_telemetry_counts: byTool,
      active_file_leases: activeLeases.map((l) => ({ file: l.file_path, emp: l.emp_id, mode: l.mode })),
      flagged_incidents: recentFlags.map((f) => ({ emp: f.emp_id, tool: f.tool, target: f.target, reason: f.flag_reason })),
      unacked_pm_pushbacks: openPushbacks,
      hr_watchlist: watchlist,
    };
  });
}
