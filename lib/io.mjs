// Core I/O, hashing, token estimation & strict 3-directory (.wrapper/{docs,agents,track}) layout.
// Zero external dependencies (Node v25 built-ins only).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { git, repoInfo } from './gitutil.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');
export const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..', '..');

export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const normSlash = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

// Windows + OneDrive atomic write with retry backoff on transient EPERM/EBUSY/EACCES.
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  for (let i = 0; i < 12; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw e;
      }
      sleep(25 * (i + 1));
    }
  }
  fs.writeFileSync(file, data, 'utf8');
  try { fs.rmSync(tmp, { force: true }); } catch {}
}

export function readJson(file, fallback = null) {
  for (let i = 0; i < 5; i++) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      sleep(20);
    }
  }
  return fallback;
}

// Machine-compact JSON by default (minify=true) to minimize token & disk footprint.
export function writeJson(file, obj, minify = true) {
  const txt = minify ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
  writeAtomic(file, txt + '\n');
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(obj) + '\n';
  for (let i = 0; i < 8; i++) {
    try {
      fs.appendFileSync(file, line, 'utf8');
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(20 * (i + 1));
    }
  }
}

export function readJsonl(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch {}
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export function writeJsonl(file, items) {
  const body = items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : '');
  writeAtomic(file, body);
}

export const hashText = (text, len = 16) =>
  crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, len);

// wrapper: handwritten (deterministic working-tree fingerprint binding git HEAD + staged/unstaged diff + untracked files for anti-lie test receipts)
export function treeHash(cwd, scopeFiles = null) {
  const dir = path.resolve(cwd || process.cwd());
  const info = repoInfo(dir);
  const h = crypto.createHash('sha256');
  if (info) {
    const top = info.top;
    const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD']).out.trim() || 'NO_HEAD';
    h.update(`HEAD:${head}\n`);
    const args = scopeFiles?.length ? ['--', ...scopeFiles] : [];
    const diff = git(top, ['diff', 'HEAD', '--no-ext-diff', '--no-color', ...args]);
    const cached = head === 'NO_HEAD' ? git(top, ['diff', '--cached', '--no-ext-diff', '--no-color', ...args]) : { out: '' };
    h.update(`DIFF:${diff.out}\nCACHED:${cached.out}\n`);
    const untracked = git(top, ['ls-files', '--others', '--exclude-standard', ...args]);
    if (untracked.ok && untracked.out) {
      for (const rel of untracked.out.split(/\r?\n/).filter(Boolean).sort()) {
        if (rel.startsWith('.wrapper/')) continue;
        try {
          const buf = fs.readFileSync(path.join(top, rel));
          h.update(`U:${rel}:${crypto.createHash('sha256').update(buf).digest('hex')}\n`);
        } catch {}
      }
    }
    return h.digest('hex').slice(0, 16);
  }
  // Fallback for non-git directories: hash top-level + recursive non-.wrapper files.
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.wrapper', '.git', 'node_modules', '_wt'].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          const rel = normSlash(path.relative(dir, full));
          h.update(`F:${rel}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}\n`);
        } catch {}
      }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

export const estimateTokens = (val) => {
  const s = typeof val === 'string' ? val : JSON.stringify(val ?? '');
  return Math.max(1, Math.ceil(Buffer.byteLength(s, 'utf8') / 3.8));
};

export function resolveBaseDir(explicitDir) {
  if (explicitDir && explicitDir !== true) return path.resolve(String(explicitDir));
  if (process.env.WRAPPER_DIR) return path.resolve(process.env.WRAPPER_DIR);
  let cur = path.resolve(process.cwd());
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(cur, '.wrapper'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.resolve(process.cwd());
}

// Strict 3-directory state architecture inside .wrapper/:
//   1. docs/   (Documentation keeping: _sym.json, specs/*.spec.jsonl, *.meta.json, taste.jsonl, deploy.json)
//   2. agents/ (Agent keeping: archetypes.json, teams.jsonl, roster/*.json, ledger/*.jsonl)
//   3. track/  (Concurrent execution & spec-vs-agent tracking: track.db, matrix/, desks/, runs/, locks/, rooms/, receipts.jsonl)
export function wrapperPaths(baseDir) {
  const base = resolveBaseDir(baseDir);
  const root = path.join(base, '.wrapper');
  const docs = path.join(root, 'docs');
  const agents = path.join(root, 'agents');
  const track = path.join(root, 'track');
  return {
    base,
    root,
    docs,
    sym: path.join(docs, '_sym.json'),
    specsDir: path.join(docs, 'specs'),
    taste: path.join(docs, 'taste.jsonl'),
    deploy: path.join(docs, 'deploy.json'),
    agents,
    archetypes: path.join(agents, 'archetypes.json'),
    teams: path.join(agents, 'teams.jsonl'),
    rosterDir: path.join(agents, 'roster'),
    ledgerDir: path.join(agents, 'ledger'),
    track,
    db: path.join(track, 'track.db'),
    matrixDir: path.join(track, 'matrix'),
    desksDir: path.join(track, 'desks'),
    runsDir: path.join(track, 'runs'),
    locksDir: path.join(track, 'locks'),
    roomsDir: path.join(track, 'rooms'),
    receipts: path.join(track, 'receipts.jsonl'),
  };
}

export function ensureWrapperDirs(baseDir) {
  const p = wrapperPaths(baseDir);
  for (const d of [
    p.docs, p.specsDir,
    p.agents, p.rosterDir, p.ledgerDir,
    p.track, p.matrixDir, p.desksDir, p.runsDir, p.locksDir, p.roomsDir,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(p.sym)) writeJson(p.sym, {});
  const presetArch = readJson(path.join(PLUGIN_ROOT, 'presets', 'archetypes.json'), {});
  if (!fs.existsSync(p.archetypes) && presetArch.archetypes) {
    writeJson(p.archetypes, presetArch.archetypes);
  }
  if (Array.isArray(presetArch.founding_staff)) {
    for (const f of presetArch.founding_staff) {
      const cardPath = path.join(p.rosterDir, `${f.id}.json`);
      if (!fs.existsSync(cardPath)) {
        writeJson(cardPath, {
          ...f,
          hired_at: new Date().toISOString().slice(0, 10),
          st: 'active',
          pts: 100,
          wl: [0, 0, 0, 0],
          xp: { hf: {}, good: [], bad: [], lessons: [] },
        });
      }
    }
  }
  if (!fs.existsSync(p.teams)) {
    writeJsonl(p.teams, [
      { id: 'exec', name: 'Executive & Governance', lead: 'CEO', members: ['emp-re', 'emp-hr'], specs: ['*'], pat: ['Ask CEO on ambiguity', '80% capability match'], never_do: ['Fabricate test receipts', 'Store secret values in docs'] },
    ]);
  }
  return p;
}

export function relToBase(baseDir, targetPath) {
  const base = resolveBaseDir(baseDir);
  const abs = path.resolve(base, String(targetPath));
  const rel = normSlash(path.relative(base, abs));
  return rel.startsWith('..') || path.isAbsolute(rel) ? normSlash(abs) : rel || '.';
}

const _heldLocks = new Set();

// Reentrant kernel-atomic directory mutex for multi-process ID allocation (_sym.json, roster emp-NNN, teams.jsonl).
export function withDirLock(lockDirPath, fn, timeoutMs = 8000) {
  const key = path.resolve(lockDirPath).toLowerCase();
  if (_heldLocks.has(key)) return fn();
  fs.mkdirSync(path.dirname(lockDirPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDirPath);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockDirPath).mtimeMs > 10000) fs.rmdirSync(lockDirPath);
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`Lock timeout on ${lockDirPath}`);
      sleep(20);
    }
  }
  _heldLocks.add(key);
  try {
    return fn();
  } finally {
    _heldLocks.delete(key);
    try { fs.rmdirSync(lockDirPath); } catch {}
  }
}
