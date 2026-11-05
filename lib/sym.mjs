// Symbol & path interning dictionary (.wrapper/docs/_sym.json).
// Stores compact codes ("F1", "F2", "C1") on disk to save ~68-75% tokens in specs/rosters/matrices,
// and ALWAYS expands them back to real paths/names at prompt-injection (ctx) & inspect time
// so LLMs never hallucinate opaque IDs.
import path from 'node:path';
import { ensureWrapperDirs, readJson, writeJson, normSlash, withDirLock } from './io.mjs';

const CODE_RE = /^(?:F|C|S)\d+$/;

export function loadSymMap(baseDir) {
  const p = ensureWrapperDirs(baseDir);
  return readJson(p.sym, {}) || {};
}

// wrapper: handwritten (bidirectional compact symbol interner with prompt-time expansion guard)
export function intern(baseDir, rawVal, prefix = 'F') {
  if (!rawVal) return rawVal;
  const val = prefix === 'F' ? normSlash(rawVal) : String(rawVal).trim();
  if (!val || val === '*') return val;
  const p = ensureWrapperDirs(baseDir);
  return withDirLock(path.join(p.docs, '.lock'), () => {
    const map = readJson(p.sym, {}) || {};
    if (CODE_RE.test(val) && map[val]) return val; // already an interned symbol code
    for (const [code, existing] of Object.entries(map)) {
      if (existing === val) return code;
    }
    let maxN = 0;
    for (const code of Object.keys(map)) {
      if (code.startsWith(prefix)) {
        const n = Number.parseInt(code.slice(prefix.length), 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
    const nextCode = `${prefix}${maxN + 1}`;
    map[nextCode] = val;
    writeJson(p.sym, map);
    return nextCode;
  });
}

export function internList(baseDir, list, prefix = 'F') {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(Boolean).map((v) => intern(baseDir, v, prefix)))];
}

export function decode(baseDir, codeOrVal, symCache = null) {
  if (!codeOrVal || typeof codeOrVal !== 'string') return codeOrVal;
  const map = symCache || loadSymMap(baseDir);
  return map[codeOrVal] || codeOrVal;
}

export function decodeList(baseDir, list, symCache = null) {
  const map = symCache || loadSymMap(baseDir);
  if (!Array.isArray(list)) return [];
  return list.map((x) => decode(baseDir, x, map));
}

// Recursively expands interned codes (F1 -> sale/services.py) in any object/array before LLM prompt injection.
export function expandSymbols(baseDir, value, symCache = null) {
  const map = symCache || loadSymMap(baseDir);
  const walk = (v) => {
    if (typeof v === 'string') return CODE_RE.test(v) && map[v] ? map[v] : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, child] of Object.entries(v)) {
        const expKey = CODE_RE.test(k) && map[k] ? map[k] : k;
        out[expKey] = walk(child);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
