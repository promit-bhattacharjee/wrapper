// File map: a small durable memory of "which file is for what, and which task/agent last touched it".
// One entry per file = keywords (<= 15, extracted automatically, no AI call) + ONE line (written by the agent).
// Stored in <root>/.agents/coord/filemap.json. Agents query it (where / who / map) instead of searching the repo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_KW = 15;
const MAX_LINE = 160;
const MAX_TASKS = 5;
const READ_LIMIT = 100 * 1024;

const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|__pycache__|\.venv|venv|\.wrapper|\.claude)(\/|$)|^\.agents\/coord(\/|$)/;
const SKIP_FILE = /(^|\/)(\.env[^/]*|id_rsa[^/]*|[^/]*\.(pem|key|p12|pfx|crt)|[^/]*secret[^/]*|[^/]*credential[^/]*|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]*\.min\.(js|css)|[^/]*\.lock)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|tar|gz|woff2?|ttf|eot|mp4|mov|mp3|wav|sqlite|db|exe|dll|so|dylib|class|jar|pyc)$/i;
const STOP = new Set(('the and for with from that this have has not are was were will can use used using get set new return const let var function class def import export default async await true false null undefined '
  + 'string number object array type interface props state data value values item items list name id key index file path text html div span error err result res req src lib app pkg main tmp').split(/\s+/));

const lockDir = (root) => path.join(root, '.agents', 'coord', 'filemap.lock');
const storeFile = (root) => path.join(root, '.agents', 'coord', 'filemap.json');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function load(root) {
  try { const j = JSON.parse(fs.readFileSync(storeFile(root), 'utf8')); return j && j.files ? j : { v: 1, files: {} }; } catch { return { v: 1, files: {} }; }
}

function withStore(root, fn) {
  fs.mkdirSync(path.dirname(storeFile(root)), { recursive: true });
  const lock = lockDir(root);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    try { fs.mkdirSync(lock); got = true; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch { /* raced */ }
      sleep(25);
    }
  }
  if (!got) return null; // never block an agent on the memory
  try {
    const store = load(root);
    const res = fn(store);
    const tmp = `${storeFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, storeFile(root));
    return res;
  } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

export function shouldTrack(rel) {
  return !!rel && !path.isAbsolute(rel) && !rel.startsWith('..') && !SKIP_PATH.test(rel) && !SKIP_FILE.test(rel) && !BINARY.test(rel);
}

// Deterministic keyword extraction: declared names, headings, routes, constants and path words, weighted.
export function extractKeywords(text, rel) {
  const score = new Map();
  const add = (list, w) => { for (const x of list) score.set(x, (score.get(x) || 0) + w); };
  add(words(rel.replace(/\.[^./]+$/, '')), 2);
  const decl = /(?:function\*?|class|def|func|fn|interface|struct|enum|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(decl)) add(words(m[1]), 3);
  for (const m of text.matchAll(/^#{1,3}\s+(.+)$/gm)) add(words(m[1]), 3);
  for (const m of text.matchAll(/['"`](\/[\w\-/:{}.]{2,60})['"`]/g)) add(words(m[1]), 2);
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g)) add(words(m[0]), 1);
  return [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_KW).map(([w]) => w);
}

function describe(root, rel) {
  const abs = path.join(root, rel);
  let buf;
  try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(READ_LIMIT); const n = fs.readSync(fd, b, 0, READ_LIMIT, 0); fs.closeSync(fd); buf = b.subarray(0, n); } catch { return null; }
  if (buf.includes(0)) return null; // binary
  const text = buf.toString('utf8');
  return { h: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8), k: extractKeywords(text, rel) };
}

// edits: [{ rel, agent, taskId? }]. Safe to call from hooks: never throws.
export function recordEdits(root, edits) {
  try {
    const todo = edits.filter((e) => shouldTrack(e.rel));
    if (!todo.length) return 0;
    return withStore(root, (store) => {
      let n = 0;
      for (const e of todo) {
        const d = describe(root, e.rel);
        if (!d) continue;
        const cur = store.files[e.rel] || { k: [], s: '', tasks: [], t: 0, h: '', stale: false };
        if (cur.h !== d.h) { cur.k = d.k; if (cur.s) cur.stale = true; cur.h = d.h; }
        cur.t = Date.now();
        if (e.taskId) {
          const last = cur.tasks[0];
          if (last && last.id === e.taskId && last.agent === e.agent) last.t = cur.t;
          else cur.tasks = [{ id: e.taskId, agent: e.agent, t: cur.t }, ...cur.tasks].slice(0, MAX_TASKS);
        } else if (!cur.tasks.length) cur.tasks = [{ id: '', agent: e.agent, t: cur.t }];
        store.files[e.rel] = cur; n++;
      }
      return n;
    }) ?? 0;
  } catch { return 0; }
}

const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);

export function setLine(root, rel, line, kw) {
  return withStore(root, (store) => {
    const cur = store.files[rel] || (fs.existsSync(path.join(root, rel)) ? { k: describe(root, rel)?.k || [], s: '', tasks: [], t: Date.now(), h: describe(root, rel)?.h || '', stale: false } : null);
    if (!cur) return false;
    if (line) { cur.s = clip(line); cur.stale = false; }
    if (kw?.length) cur.k = [...new Set([...kw.map((x) => String(x).toLowerCase()), ...cur.k])].slice(0, MAX_KW);
    store.files[rel] = cur;
    return true;
  });
}

// task done --note "...": the note becomes the line for every file the task touched (unless it already has a fresher one).
export function setLineForTask(root, taskId, note) {
  if (!note) return 0;
  try {
    return withStore(root, (store) => {
      let n = 0;
      for (const f of Object.values(store.files)) {
        if (f.tasks.some((t) => t.id === taskId) && (!f.s || f.stale || f.tasks[0]?.id === taskId)) { f.s = clip(note); f.stale = false; n++; }
      }
      return n;
    }) ?? 0;
  } catch { return 0; }
}

const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 90 ? `${m}m` : m < 2160 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

export function where(root, query, n = 5) {
  const q = words(query);
  if (!q.length) return [];
  const store = load(root);
  const out = [];
  for (const [rel, f] of Object.entries(store.files)) {
    let s = 0;
    const pw = words(rel), lw = new Set(words(f.s));
    for (const w of q) {
      if (f.k.includes(w)) s += 3; else if (f.k.some((k) => k.startsWith(w) || w.startsWith(k))) s += 1.5;
      if (lw.has(w)) s += 2;
      if (pw.includes(w)) s += 1.5;
    }
    if (s > 0) out.push({ rel, s, f });
  }
  return out.sort((a, b) => b.s - a.s || b.f.t - a.f.t).slice(0, n);
}

export function who(root, rel) { return load(root).files[rel] || null; }

export function byTask(root, taskId) {
  return Object.entries(load(root).files).filter(([, f]) => f.tasks.some((t) => t.id === taskId)).sort((a, b) => b[1].t - a[1].t);
}

export function stats(root) {
  const all = Object.values(load(root).files);
  return { files: all.length, withLine: all.filter((f) => f.s).length, stale: all.filter((f) => f.stale).length };
}

export function formatEntry(rel, f) {
  return `${rel}${f.stale ? ' (stale)' : ''}  [${f.k.join(', ')}]\n  ${f.s || '(no line yet)'}  · ${f.tasks[0]?.id || 'no task'}${f.tasks[0]?.agent ? ' ' + f.tasks[0].agent : ''} ${ago(f.t)} ago`;
}
