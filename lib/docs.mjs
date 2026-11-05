// Directory 1 (.wrapper/docs/): Living Functional Specs, .taste Hook Store, and .deployment Two-Way Contract.
// Machine-compact JSON / JSONL with symbol interning (_sym.json) and prompt-time path expansion.
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWrapperDirs, readJson, writeJson, readJsonl, writeJsonl, appendJsonl,
  WORKSPACE_ROOT, relToBase, normSlash, estimateTokens,
} from './io.mjs';
import { internList, expandSymbols, loadSymMap } from './sym.mjs';
import { withDb } from './db.mjs';
import { git, repoInfo } from './gitutil.mjs';

const SECRET_VALUE_RE = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{6,}/i;

const cleanFeat = (feat) => String(feat || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');

export function specFiles(baseDir, feat) {
  const p = ensureWrapperDirs(baseDir);
  const slug = cleanFeat(feat);
  if (!slug) throw new Error('Feature name is required (e.g. auth, product, sale)');
  return {
    slug,
    specPath: path.join(p.specsDir, `${slug}.spec.jsonl`),
    metaPath: path.join(p.specsDir, `${slug}.meta.json`),
  };
}

export function upsertSpecMeta(baseDir, feat, { intent, plan, radius, deploy_link } = {}) {
  const { slug, metaPath } = specFiles(baseDir, feat);
  const prev = readJson(metaPath, {
    feat: slug,
    v: 0,
    intent: { goal: '', actors: [], fast_lane: false },
    plan: { summary: '', contracts: [], order: [] },
    radius: { own: [], ro: [], shared: [] },
    deploy_link: null,
    updated_at: 0,
  });
  const nextRadius = {
    own: radius?.own ? internList(baseDir, radius.own, 'F') : prev.radius.own,
    ro: radius?.ro ? internList(baseDir, radius.ro, 'F') : prev.radius.ro,
    shared: radius?.shared ? internList(baseDir, radius.shared, 'F') : prev.radius.shared,
  };
  const next = {
    feat: slug,
    v: (prev.v || 0) + 1,
    intent: intent ? { ...prev.intent, ...intent } : prev.intent,
    plan: plan ? { ...prev.plan, ...plan } : prev.plan,
    radius: nextRadius,
    deploy_link: deploy_link !== undefined ? deploy_link : prev.deploy_link,
    updated_at: Date.now(),
  };
  writeJson(metaPath, next);
  return next;
}

// wrapper: handwritten (living functional spec upsert — evolves atomic EARS requirement in-place instead of spawning new spec folders)
export async function upsertSpecReq(baseDir, feat, req) {
  if (!req?.id || !req?.w || !req?.do) {
    throw new Error('Requirement must include id, w (when/route trigger), and do (behavior/invariant)');
  }
  const { slug, specPath, metaPath } = specFiles(baseDir, feat);
  const filesInterned = internList(baseDir, req.f || req.files || [], 'F');
  const rows = readJsonl(specPath);
  const idx = rows.findIndex((r) => r.id === req.id);
  const prevVer = idx >= 0 ? (rows[idx].v || 1) : 0;
  const record = {
    id: String(req.id).trim(),
    s: String(req.s || req.slice || 'core').trim(),
    w: String(req.w).trim(),
    do: String(req.do).trim(),
    err: Array.isArray(req.err) ? req.err : [],
    f: filesInterned,
    t: String(req.t || `T_${String(req.id).replace(/[^A-Za-z0-9]/g, '')}`).trim(),
    v: prevVer + 1,
    st: req.st || 'active',
  };
  if (idx >= 0) rows[idx] = record;
  else rows.push(record);
  writeJsonl(specPath, rows);

  // Ensure meta.json exists and merges requirement files into radius.own automatically.
  const meta = readJson(metaPath, null);
  const mergedOwn = [...new Set([...(meta?.radius?.own || []), ...filesInterned])];
  upsertSpecMeta(baseDir, slug, { radius: { own: mergedOwn, ro: meta?.radius?.ro, shared: meta?.radius?.shared } });

  // Ensure Spec-vs-Agent matrix tracks this requirement immediately (0% open if new; preserve progress unless behavior changed).
  await withDb(baseDir, (db) => {
    const existing = db.prepare('SELECT pct, stage FROM spec_matrix WHERE feat = ? AND req_id = ?').get(slug, record.id);
    if (!existing) {
      db.prepare(`
        INSERT INTO spec_matrix (feat, req_id, pct, stage, updated_at)
        VALUES (?, ?, 0, 'open', ?)
      `).run(slug, record.id, Date.now());
    } else if (idx >= 0 && rows[idx] && prevVer > 0 && req.reset_on_change) {
      db.prepare(`UPDATE spec_matrix SET pct = 0, stage = 'open', receipt_id = NULL, updated_at = ? WHERE feat = ? AND req_id = ?`)
        .run(Date.now(), slug, record.id);
    }
  });

  return record;
}

export function listSpecs(baseDir) {
  const p = ensureWrapperDirs(baseDir);
  const out = [];
  for (const e of fs.readdirSync(p.specsDir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.spec.jsonl')) continue;
    const feat = e.name.slice(0, -'.spec.jsonl'.length);
    const reqs = readJsonl(path.join(p.specsDir, e.name));
    const meta = readJson(path.join(p.specsDir, `${feat}.meta.json`), {});
    out.push({
      feat,
      reqs_count: reqs.filter((r) => r.st !== 'deprecated').length,
      version: meta.v || 1,
      deploy_link: meta.deploy_link || null,
      tokens_compact: estimateTokens(reqs) + estimateTokens(meta),
    });
  }
  return out.sort((a, b) => a.feat.localeCompare(b.feat));
}

// Surgical prompt context slice: injects ONLY target requirement(s) + meta radius + matching approved taste,
// expanding _sym.json symbols back to real paths so LLMs never hallucinate opaque F-codes.
export function getSpecSlice(baseDir, feat, reqIds = null, { expand = true } = {}) {
  const { slug, specPath, metaPath } = specFiles(baseDir, feat);
  const sym = loadSymMap(baseDir);
  const allReqs = readJsonl(specPath).filter((r) => r.st !== 'deprecated');
  const want = reqIds?.length ? new Set(Array.isArray(reqIds) ? reqIds : [reqIds]) : null;
  const selected = want ? allReqs.filter((r) => want.has(r.id)) : allReqs;
  const meta = readJson(metaPath, { feat: slug, intent: {}, plan: {}, radius: { own: [], ro: [], shared: [] } });
  const taste = loadActiveTaste(baseDir, slug);
  const payload = {
    feat: slug,
    intent: meta.intent,
    radius: meta.radius,
    deploy_link: meta.deploy_link || null,
    reqs: selected,
    taste: taste.map((t) => ({ k: t.k, rule: t.rule })),
  };
  const finalPayload = expand ? expandSymbols(baseDir, payload, sym) : payload;
  return {
    ...finalPayload,
    _tokens: estimateTokens(finalPayload),
  };
}

// ---------- .taste manager (.wrapper/docs/taste.jsonl + root TASTE.md awareness) ----------

function parseRootApprovedTaste() {
  const rootTaste = path.join(WORKSPACE_ROOT, 'TASTE.md');
  const rules = [];
  try {
    const raw = fs.readFileSync(rootTaste, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (/^##\s+Inbox\b/i.test(line)) break; // Only approved sections sit above Inbox (AGENTS.md §10)
      const m = line.match(/^-\s+`([^`]+)`\s+(.+?)\s+·\s+\[([^\]]+)\]/);
      if (m) rules.push({ k: m[1], rule: m[2], sc: m[3], st: 'approved', conf: 1.0, src: 'TASTE.md' });
    }
  } catch {}
  return rules;
}

export function recordTaste(baseDir, { key, rule, scope = 'all', status = 'inbox', confidence = 0.8, source = 'ceo' }) {
  if (!rule || !String(rule).trim()) throw new Error('Taste rule text is required');
  if (SECRET_VALUE_RE.test(rule)) {
    throw new Error('Refusing to store secret literal in taste.jsonl (store environment variable names only, never values)');
  }
  const p = ensureWrapperDirs(baseDir);
  const k = String(key || `taste.${Date.now().toString(36)}`).trim();
  const rows = readJsonl(p.taste);
  const rootRules = parseRootApprovedTaste();

  // Detect potential conflict against existing approved rules sharing the same key.
  const conflicts = [];
  for (const r of [...rootRules, ...rows.filter((x) => x.st === 'approved')]) {
    if (r.k === k && r.rule.trim().toLowerCase() !== String(rule).trim().toLowerCase()) {
      conflicts.push({ key: r.k, existing_rule: r.rule, source: r.src });
    }
  }

  const entry = {
    k,
    rule: String(rule).trim(),
    sc: String(scope).trim(),
    st: ['approved', 'rejected', 'inbox'].includes(status) ? status : 'inbox',
    conf: Number(confidence),
    src: String(source),
    ts: Date.now(),
  };
  const idx = rows.findIndex((x) => x.k === k);
  if (idx >= 0) rows[idx] = entry;
  else rows.push(entry);
  writeJsonl(p.taste, rows);
  return { entry, conflicts };
}

export function setTasteStatus(baseDir, key, status) {
  if (!['approved', 'rejected', 'inbox'].includes(status)) {
    throw new Error('Status must be approved, rejected, or inbox');
  }
  const p = ensureWrapperDirs(baseDir);
  const rows = readJsonl(p.taste);
  const hit = rows.find((r) => r.k === key);
  if (!hit) throw new Error(`No taste entry with key "${key}"`);
  hit.st = status;
  hit.ts = Date.now();
  writeJsonl(p.taste, rows);
  return hit;
}

export function loadActiveTaste(baseDir, scopeFilter = null) {
  const p = ensureWrapperDirs(baseDir);
  const local = readJsonl(p.taste).filter((r) => r.st === 'approved');
  const merged = new Map();
  for (const r of parseRootApprovedTaste()) merged.set(r.k, r);
  for (const r of local) merged.set(r.k, r);
  const all = [...merged.values()];
  if (!scopeFilter) return all;
  return all.filter((r) => r.sc === 'all' || r.sc.includes(scopeFilter));
}

export function listTaste(baseDir, { status = null } = {}) {
  const p = ensureWrapperDirs(baseDir);
  const rows = readJsonl(p.taste);
  return status ? rows.filter((r) => r.st === status) : rows;
}

// 0-token hook helper: extracts explicit CEO durable preference directives from user prompts into taste inbox.
export function capturePromptTaste(baseDir, promptText, source = 'claude_hook') {
  if (!promptText || typeof promptText !== 'string' || promptText.length > 2000) return null;
  if (SECRET_VALUE_RE.test(promptText)) return null;
  const m = promptText.match(/(?:^|[.!?]\s+)((?:always|never|from now on|make sure we always|rule:)\s+[^.!?\n]{10,180})/i);
  if (!m) return null;
  const statement = m[1].trim();
  const slug = statement.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28).replace(/^-|-$/g, '');
  return recordTaste(baseDir, {
    key: `auto.${slug}`,
    rule: statement,
    scope: 'all',
    status: 'inbox',
    confidence: 0.65,
    source,
  });
}

// ---------- .deployment manager (.wrapper/docs/deploy.json + two-way spec link) ----------

export function syncDeployment(baseDir, overrides = {}) {
  const p = ensureWrapperDirs(baseDir);
  const prev = readJson(p.deploy, {});
  const info = repoInfo(p.base);
  const top = info ? info.top : p.base;

  const branches = info ? git(top, ['branch', '-a', '--format=%(refname:short)']).out.split(/\r?\n/).filter(Boolean) : [];
  const deployBranch = overrides.deploy_branch
    || branches.find((b) => b.includes('deploy/backend'))
    || branches.find((b) => b.includes('deploy/frontend'))
    || prev.deploy_branch
    || 'deploy/backend';

  const hasCi = fs.existsSync(path.join(top, '.github', 'workflows', 'ci.yml'));
  const hasArtifactBuilder = fs.existsSync(path.join(top, 'scripts', 'build_deploy_artifact.py'));
  const hasVercel = fs.existsSync(path.join(top, 'vercel.json'));

  // Extract ONLY environment variable NAMES from .env.example (never values!).
  const envNames = new Set(prev.env_names || []);
  const envExample = path.join(top, '.env.example');
  if (fs.existsSync(envExample)) {
    try {
      for (const line of fs.readFileSync(envExample, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z][A-Z0-9_]{1,})\s*=/);
        if (m) envNames.add(m[1]);
      }
    } catch {}
  }

  const doc = {
    service: overrides.service || prev.service || path.basename(top),
    main_branch: overrides.main_branch || prev.main_branch || 'main',
    deploy_branch: deployBranch,
    ci_workflow: hasCi ? '.github/workflows/ci.yml' : (overrides.ci_workflow || prev.ci_workflow || null),
    artifact_builder: hasArtifactBuilder ? 'scripts/build_deploy_artifact.py' : (prev.artifact_builder || null),
    platform: overrides.platform || prev.platform || (hasVercel ? 'vercel' : 'dokploy'),
    gate: overrides.gate || prev.gate || 'unit+smoke_green_on_main_before_deploy_branch',
    pause_var: 'DEPLOY_DISABLED',
    manual_push_forbidden: true,
    hosts: overrides.hosts || prev.hosts || {},
    env_names: [...envNames].sort(),
    shipped_specs: prev.shipped_specs || {},
    updated_at: Date.now(),
  };
  writeJson(p.deploy, doc);
  return doc;
}

// Two-way link: updates docs/deploy.json shipped_specs[feat] AND docs/specs/<feat>.meta.json deploy_link.
export function linkSpecToDeployment(baseDir, feat, { sha = null, reqIds = null } = {}) {
  const p = ensureWrapperDirs(baseDir);
  const { slug, specPath } = specFiles(baseDir, feat);
  const deploy = fs.existsSync(p.deploy) ? readJson(p.deploy, {}) : syncDeployment(baseDir);
  const info = repoInfo(p.base);
  const headSha = sha || (info ? git(info.top, ['rev-parse', '--short', 'HEAD']).out.trim() : 'uncommitted');
  const reqs = reqIds || readJsonl(specPath).filter((r) => r.st !== 'deprecated').map((r) => r.id);

  deploy.shipped_specs = deploy.shipped_specs || {};
  deploy.shipped_specs[slug] = {
    sha: headSha,
    reqs,
    target: `${deploy.main_branch}->${deploy.deploy_branch}`,
    linked_at: Date.now(),
  };
  deploy.updated_at = Date.now();
  writeJson(p.deploy, deploy);

  const meta = upsertSpecMeta(baseDir, slug, {
    deploy_link: {
      service: deploy.service,
      target: `${deploy.main_branch}->${deploy.deploy_branch}`,
      gate: deploy.gate,
      last_sha: headSha,
    },
  });
  return { deploy_entry: deploy.shipped_specs[slug], meta_link: meta.deploy_link };
}
