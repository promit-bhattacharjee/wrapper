// Directory 2 (.wrapper/agents/): Virtual Corporate Office, HR >=80% Matcher/Recruiter,
// Employee Cards, Squads, Point/Lie Reputation Ledger, and Git-Blame Defect Clawback.
import fs from 'node:fs';
import path from 'node:path';
import {
  PLUGIN_ROOT, ensureWrapperDirs, readJson, writeJson, readJsonl, writeJsonl, appendJsonl, normSlash, withDirLock,
} from './io.mjs';
import { internList, loadSymMap, expandSymbols } from './sym.mjs';
import { withDb, plainAll } from './db.mjs';
import { git, repoInfo } from './gitutil.mjs';

const LEVEL_RANK = { L1: 1, L2: 2, L3: 3, Sigma: 3, Lead: 4 };

export const loadPresets = () => ({
  archetypes: readJson(path.join(PLUGIN_ROOT, 'presets', 'archetypes.json'), {}),
  scoring: readJson(path.join(PLUGIN_ROOT, 'presets', 'scoring.json'), {}),
});

export function listRoster(baseDir, { includeTerminated = false, expand = false } = {}) {
  const p = ensureWrapperDirs(baseDir);
  const sym = expand ? loadSymMap(baseDir) : null;
  const out = [];
  for (const e of fs.readdirSync(p.rosterDir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const card = readJson(path.join(p.rosterDir, e.name));
    if (!card) continue;
    if (!includeTerminated && card.st === 'terminated') continue;
    out.push(expand ? expandSymbols(baseDir, card, sym) : card);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getEmployee(baseDir, idOrHandle) {
  if (!idOrHandle) return null;
  const p = ensureWrapperDirs(baseDir);
  const direct = path.join(p.rosterDir, `${idOrHandle}.json`);
  if (fs.existsSync(direct)) return readJson(direct);
  const key = String(idOrHandle).trim().toLowerCase();
  for (const emp of listRoster(baseDir, { includeTerminated: true })) {
    if (emp.id.toLowerCase() === key || emp.h?.toLowerCase() === key || emp.n?.toLowerCase() === key) {
      return emp;
    }
  }
  return null;
}

export function saveEmployee(baseDir, card) {
  const p = ensureWrapperDirs(baseDir);
  writeJson(path.join(p.rosterDir, `${card.id}.json`), card);
  return card;
}

export function listTeams(baseDir) {
  const p = ensureWrapperDirs(baseDir);
  return readJsonl(p.teams);
}

export function upsertTeam(baseDir, team) {
  const p = ensureWrapperDirs(baseDir);
  return withDirLock(path.join(p.agents, '.lock'), () => {
    const teams = readJsonl(p.teams);
    const id = String(team.id || 'core').trim();
    const idx = teams.findIndex((t) => t.id === id);
    const prev = idx >= 0 ? teams[idx] : { id, name: team.name || `${id} Squad`, lead: 'CEO', members: [], specs: [], pat: [], never_do: [] };
    const merged = {
      ...prev,
      ...team,
      id,
      members: [...new Set([...(prev.members || []), ...(team.members || [])])],
      specs: [...new Set([...(prev.specs || []), ...(team.specs || [])])],
      pat: [...new Set([...(prev.pat || []), ...(team.pat || [])])],
      never_do: [...new Set([...(prev.never_do || []), ...(team.never_do || [])])],
    };
    if (idx >= 0) teams[idx] = merged;
    else teams.push(merged);
    writeJsonl(p.teams, teams);
    return merged;
  });
}

// Requirement Engineer helper: builds a project-relatable Job Requisition and flags any ambiguity for CEO.
export function draftJobRequisition(baseDir, {
  archetype, role, level, domain, tech = [], files = [], tools = [], jd = '', team = '', ceoConfirmed = false,
} = {}) {
  const { archetypes: preset } = loadPresets();
  const archMap = preset.archetypes || {};
  const ambiguous = [];

  if (!archetype && !level) {
    ambiguous.push('Target engineering/design level is unspecified (choose: ECA-L3, ECA-L2, ECA-L1, Sigma-Designer, Maintenance, QA, or PM).');
  }
  if (!tech.length && role !== 'pm') {
    ambiguous.push('Technology stack is unspecified for this specialist requisition.');
  }

  const resolvedArchKey = archetype && archMap[archetype]
    ? archetype
    : level === 'L3' ? 'ECA-L3'
    : level === 'L1' ? 'ECA-L1'
    : level === 'Sigma' ? 'Sigma-Designer'
    : role === 'qa' ? 'QA'
    : role === 'pm' ? 'PM'
    : role === 'maint' ? 'Maintenance'
    : 'ECA-L2';

  const tpl = archMap[resolvedArchKey] || archMap['ECA-L2'];
  const fileCodes = internList(baseDir, files, 'F');

  return {
    archetype: resolvedArchKey,
    role: role || tpl.role,
    level: level || tpl.level,
    dept: tpl.dept,
    domain: String(domain || team || 'general').toLowerCase(),
    team: String(team || domain || 'core').toLowerCase(),
    tech: tech.map((t) => String(t).toLowerCase().trim()).filter(Boolean),
    files: fileCodes,
    tools: tools.length ? tools : tpl.tools,
    jd: jd || `${tpl.title} owning ${domain || 'project'} (${tech.join(', ') || 'core stack'})`,
    ambiguous,
    ceo_confirmed: !!ceoConfirmed,
  };
}

// wrapper: handwritten (deterministic 5-factor HR capability + file-XP matcher with >=80% reuse threshold)
export function scoreCandidate(emp, req, scoringCfg) {
  if (!emp || emp.st === 'terminated') return { eligible: false, score: 0, reason: 'terminated' };
  // Strict role isolation: QA never implements engineering tasks and Engineers never verify their own work as QA.
  const roleOk = emp.r === req.role || (req.role === 'maint' && emp.r === 'eng');
  if (!roleOk) return { eligible: false, score: 0, reason: `role_mismatch(${emp.r}!=${req.role})` };

  const empRank = LEVEL_RANK[emp.lv] || 1;
  const reqRank = LEVEL_RANK[req.level] || 1;
  if (empRank < reqRank) return { eligible: false, score: 0, reason: `level_below_required(${emp.lv}<${req.level})` };

  const empTools = new Set(emp.cap?.tools || []);
  for (const t of req.tools || []) {
    if (!empTools.has(t) && !(t === 'rw_tests' && empTools.has('rw'))) {
      return { eligible: false, score: 0, reason: `missing_tool(${t})` };
    }
  }

  const w = scoringCfg.weights || { tech: 0.30, domain: 0.25, file_xp: 0.20, level_role: 0.15, reputation: 0.10 };

  // 1. Tech coverage (0..1)
  const empTech = new Set((emp.cap?.tech || []).map((x) => x.toLowerCase()));
  const reqTech = (req.tech || []).map((x) => x.toLowerCase());
  const techScore = reqTech.length
    ? reqTech.filter((t) => empTech.has(t)).length / reqTech.length
    : 1.0;

  // 2. Domain affinity (0..1)
  const empDom = new Set((emp.cap?.dom || []).map((x) => x.toLowerCase()));
  const domScore = empDom.has('all') || empDom.has(req.domain) ? 1.0 : 0.0;

  // 3. Prior file XP & radius familiarity (0..1)
  let fileScore = 0.5;
  if (req.files?.length) {
    const hf = emp.xp?.hf || {};
    const rad = new Set(emp.cap?.rad || []);
    let hits = 0;
    for (const f of req.files) {
      if ((hf[f] || 0) > 0) hits += 1.0;
      else if (rad.has('*') || rad.has(f)) hits += 0.75;
    }
    fileScore = Math.min(1.0, hits / req.files.length);
  }

  // 4. Level fit (exact level = 1.0, overqualified by 1 rank = 0.85 so L3 isn't wasted on L1 chores unless needed)
  const rankDiff = empRank - reqRank;
  const levelScore = rankDiff === 0 ? 1.0 : Math.max(0.7, 1.0 - rankDiff * 0.12);

  // 5. Track reputation score (65 -> 0.0, 100 -> 0.80, >=120 -> 1.0), with probation penalty
  const rawRep = Math.max(0, Math.min(1, ((emp.pts ?? 100) - 65) / 55));
  const repScore = emp.st === 'probation' ? rawRep * 0.5 : rawRep;

  const total = Number((
    w.tech * techScore +
    w.domain * domScore +
    w.file_xp * fileScore +
    w.level_role * levelScore +
    w.reputation * repScore
  ).toFixed(4));

  return {
    eligible: true,
    score: total,
    breakdown: { techScore, domScore, fileScore, levelScore, repScore },
  };
}

function nextEmpIdentity(baseDir, customName = null, customHandle = null) {
  const all = listRoster(baseDir, { includeTerminated: true });
  let maxNum = 0;
  const usedHandles = new Set(all.map((e) => e.h?.toLowerCase()));
  for (const e of all) {
    const m = e.id.match(/^emp-(\d+)$/);
    if (m) maxNum = Math.max(maxNum, Number.parseInt(m[1], 10));
  }
  const id = `emp-${String(maxNum + 1).padStart(3, '0')}`;
  if (customName) {
    const baseH = (customHandle || customName.split(/\s+/)[0]).toLowerCase().replace(/[^a-z0-9]/g, '');
    let h = baseH || `agent${maxNum + 1}`;
    let sfx = 2;
    while (usedHandles.has(h)) h = `${baseH}${sfx++}`;
    return { id, h, n: customName };
  }
  const pool = loadPresets().archetypes.name_pool || [];
  for (const cand of pool) {
    if (!usedHandles.has(cand.h)) return { id, h: cand.h, n: cand.n };
  }
  return { id, h: `staff${maxNum + 1}`, n: `Staff Engineer ${maxNum + 1}` };
}

export function hireEmployee(baseDir, req, { name = null, handle = null, manager = null, inst = null, taste = [] } = {}) {
  const p = ensureWrapperDirs(baseDir);
  return withDirLock(path.join(p.agents, '.lock'), () => {
    const { archetypes: preset, scoring } = loadPresets();
    const tpl = preset.archetypes?.[req.archetype] || preset.archetypes?.['ECA-L2'] || {};
    const ident = nextEmpIdentity(baseDir, name, handle);

    // Resolve team manager if team already has a PM
    const existingTeam = listTeams(baseDir).find((t) => t.id === req.team);
    const mgr = manager || (req.role === 'pm' ? 'CEO' : existingTeam?.lead || 'CEO');

    const card = {
      id: ident.id,
      h: ident.h,
      n: ident.n,
      ti: `${req.archetype} — ${tpl.title || 'Specialist'}`,
      jd: req.jd,
      dept: req.dept || tpl.dept || 'engineering',
      tm: req.team || 'core',
      r: req.role || tpl.role || 'eng',
      lv: req.level || tpl.level || 'L2',
      mgr,
      hired_at: new Date().toISOString().slice(0, 10),
      st: 'active',
      pts: scoring.starting_points ?? 100,
      wl: [0, 0, 0, 0], // [wins, bugs, lies, bounces]
      cap: {
        tech: req.tech || [],
        dom: [req.domain || 'general'],
        rad: req.files?.length ? req.files : ['*'],
        tools: req.tools || tpl.tools || ['rw', 'test'],
      },
      inst: inst || tpl.default_inst || 'Execute spec predicates inside assigned radius and produce test receipt.',
      pat: [...(tpl.default_pat || [])],
      taste: [...taste],
      xp: { hf: {}, good: [], bad: [], lessons: [] },
    };

    saveEmployee(baseDir, card);
    upsertTeam(baseDir, {
      id: card.tm,
      lead: card.r === 'pm' ? card.id : (existingTeam?.lead || 'CEO'),
      members: [card.id],
      specs: req.domain && req.domain !== 'general' ? [req.domain] : [],
    });
    return card;
  });
}

// HR Core Entry Point: match >= 0.80 -> reuse; < 0.80 -> ask CEO if ambiguous, else hire & persist JSON card.
export function matchOrHire(baseDir, rawReq, hireOpts = {}) {
  const { scoring } = loadPresets();
  const threshold = scoring.match_threshold ?? 0.80;
  const req = rawReq.archetype && Array.isArray(rawReq.ambiguous)
    ? rawReq
    : draftJobRequisition(baseDir, rawReq);

  const candidates = listRoster(baseDir, { includeTerminated: false })
    .filter((e) => !hireOpts.excludeIds?.includes(e.id))
    .map((emp) => ({ emp, ...scoreCandidate(emp, req, scoring) }))
    .filter((c) => c.eligible)
    .sort((a, b) => b.score - a.score || b.emp.pts - a.emp.pts);

  const best = candidates[0] || null;
  if (best && best.score >= threshold) {
    // Expand agent's radius if new files in same domain were added to the living spec
    if (req.files?.length) {
      const mergedRad = [...new Set([...(best.emp.cap.rad || []), ...req.files])];
      if (mergedRad.length !== (best.emp.cap.rad || []).length) {
        best.emp.cap.rad = mergedRad;
        saveEmployee(baseDir, best.emp);
      }
    }
    return {
      action: 'reused',
      threshold,
      score: best.score,
      breakdown: best.breakdown,
      employee: best.emp,
    };
  }

  if (req.ambiguous?.length && !req.ceo_confirmed && !hireOpts.forceHire) {
    return {
      action: 'needs_ceo_clarification',
      threshold,
      best_score: best?.score ?? 0,
      best_candidate: best?.emp?.id || null,
      questions: req.ambiguous,
      requisition: req,
    };
  }

  const hired = hireEmployee(baseDir, req, hireOpts);
  return {
    action: 'hired',
    threshold,
    best_existing_score: best?.score ?? 0,
    employee: hired,
  };
}

// ---------- HR Point, Win/Loss, Lie & Blame Engine ----------

export async function recordPointEvent(baseDir, {
  empId, code, taskId = null, evidence = '', customDelta = null, lesson = null, touchedFiles = [],
}) {
  const p = ensureWrapperDirs(baseDir);
  const { scoring } = loadPresets();
  const evDef = scoring.events?.[code] || { delta: customDelta ?? 0, kind: 'note', desc: code };
  const delta = customDelta !== null ? Number(customDelta) : evDef.delta;
  const emp = getEmployee(baseDir, empId);
  if (!emp) throw new Error(`Unknown employee "${empId}"`);

  emp.pts = (emp.pts ?? 100) + delta;
  emp.wl = emp.wl || [0, 0, 0, 0];
  if (evDef.kind === 'win') emp.wl[0] += 1;
  else if (evDef.kind === 'bug') emp.wl[1] += 1;
  else if (evDef.kind === 'lie') emp.wl[2] += 1;
  else if (evDef.kind === 'bounce') emp.wl[3] += 1;

  emp.xp = emp.xp || { hf: {}, good: [], bad: [], lessons: [] };
  const fileCodes = internList(baseDir, touchedFiles, 'F');
  if (delta > 0) {
    for (const fc of fileCodes) emp.xp.hf[fc] = (emp.xp.hf[fc] || 0) + 1;
    emp.xp.good = [...emp.xp.good.slice(-9), `${code}${taskId ? `@${taskId}` : ''}`];
  } else if (delta < 0) {
    emp.xp.bad = [...emp.xp.bad.slice(-9), `${code}${taskId ? `@${taskId}` : ''}: ${evidence.slice(0, 120)}`];
  }
  if (lesson) {
    emp.xp.lessons = [...new Set([...(emp.xp.lessons || []), String(lesson).trim()])].slice(-12);
  }

  // Enforce Probation & Termination thresholds automatically
  const th = scoring.thresholds || { active: 90, probation: 65, max_lies_before_termination: 2 };
  const prevStatus = emp.st;
  if (emp.pts < th.probation || emp.wl[2] >= th.max_lies_before_termination) {
    emp.st = 'terminated';
    // Copy blunder into squad's permanent never_do[] institutional memory!
    if (emp.tm && evidence) {
      upsertTeam(baseDir, {
        id: emp.tm,
        never_do: [`[${code} by ${emp.h}/${emp.id}]: ${evidence.slice(0, 140)}`],
      });
    }
  } else if (emp.pts < th.active) {
    emp.st = 'probation';
  } else if (emp.st === 'probation' && emp.pts >= th.active) {
    emp.st = 'active';
  }

  saveEmployee(baseDir, emp);

  const ledgerEntry = {
    ts: Date.now(),
    emp: emp.id,
    code,
    kind: evDef.kind,
    delta,
    pts: emp.pts,
    st: emp.st,
    task: taskId,
    ev: evidence,
  };
  appendJsonl(path.join(p.ledgerDir, `${emp.id}.jsonl`), ledgerEntry);

  await withDb(baseDir, (db) => {
    db.prepare(`
      INSERT INTO point_ledger (emp_id, code, kind, delta, pts_after, task_id, evidence, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(emp.id, code, evDef.kind, delta, emp.pts, taskId, evidence, ledgerEntry.ts);
  });

  return { employee: emp, prev_status: prevStatus, ledger: ledgerEntry };
}

// wrapper: handwritten (git-blame defect clawback tracing broken lines via Agent-Id commit trailer or author handle)
export async function blameDefect(baseDir, {
  repoDir = null, file, line = 1, fixCommit = null, taskId = null, note = '',
}) {
  const p = ensureWrapperDirs(baseDir);
  const info = repoInfo(repoDir || p.base);
  if (!info) throw new Error('blameDefect requires a git repository');
  const top = info.top;
  const relFile = normSlash(path.isAbsolute(file) ? path.relative(top, file) : file);
  const rev = fixCommit ? `${fixCommit}^` : 'HEAD';

  const bl = git(top, ['blame', '--porcelain', `-L${line},${line}`, rev, '--', relFile]);
  if (!bl.ok || !bl.out) {
    throw new Error(`git blame failed on ${relFile}:${line} (${bl.err.trim()})`);
  }
  const sha = bl.out.split(/\s+/)[0];
  const commitBody = git(top, ['log', '-1', '--format=%B%nAuthor:%an <%ae>', sha]).out;

  let culprit = null;
  const trailerMatch = commitBody.match(/Agent-Id:\s*(emp-[A-Za-z0-9_-]+)/i);
  if (trailerMatch) culprit = getEmployee(baseDir, trailerMatch[1]);
  if (!culprit) {
    const authorMatch = commitBody.match(/Author:([^\n<]+)/i);
    if (authorMatch) culprit = getEmployee(baseDir, authorMatch[1].trim());
  }
  if (!culprit) {
    return { blamed: false, sha, reason: 'No matching employee found in Agent-Id trailer or commit author' };
  }

  const evidence = `Blamed ${sha.slice(0, 8)} on ${relFile}:${line}${note ? ` — ${note}` : ''}`;
  const res = await recordPointEvent(baseDir, {
    empId: culprit.id,
    code: 'BUG_INTRODUCED',
    taskId,
    evidence,
    lesson: `Avoid regression in ${relFile}:${line}${note ? ` (${note})` : ''}`,
    touchedFiles: [relFile],
  });
  return { blamed: true, sha, culprit: res.employee, delta: res.ledger.delta, status: res.employee.st };
}
