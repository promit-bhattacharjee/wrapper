// storage: board file, lock, atomic write
import fs from 'node:fs';
import { COORD, LOCK, BOARD, LIVE, PURGE_MS } from './context.mjs';
import { now, log, sweep } from './helpers.mjs';
import { brief } from './briefings.mjs';

// ---------- storage ----------
export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const emptyBoard = () => ({ version: 3, seq: 0, nextTask: 1, agents: {}, tasks: [], claims: {}, messages: [], recent_edits: {}, summary: [], log: [] });

export function readBoard() {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    let raw;
    try { raw = fs.readFileSync(BOARD, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return emptyBoard(); lastErr = e; sleep(40); continue; }
    try { return { ...emptyBoard(), ...JSON.parse(raw) }; } catch (e) { lastErr = e; sleep(40); }
  }
  // Never treat an unreadable/partial board as empty: the next write would destroy real state.
  throw new Error(`board.json unreadable (${lastErr?.message}); not overwriting`);
}

// Windows/OneDrive/antivirus can hold board.json open for a moment, making rename fail with EPERM/EBUSY.
export function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 12; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; } sleep(30 * (i + 1)); }
  }
  fs.writeFileSync(file, data); // last resort: in-place write (still inside the board lock)
  try { fs.rmSync(tmp, { force: true }); } catch {}
}

export function withBoard(fn) {
  fs.mkdirSync(COORD, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; }
    catch {
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.rmdirSync(LOCK); } catch {}
      if (Date.now() - start > 8000) throw new Error('board lock timeout');
      sleep(25);
    }
  }
  try {
    const b = readBoard();
    const out = fn(b);
    sweep(b);
    for (const [p, e] of Object.entries(b.recent_edits)) if (now() - e.t > 60000) delete b.recent_edits[p];
    b.messages = b.messages.filter((m) => now() - m.t < PURGE_MS).slice(-100);
    b.updated = now();
    try { fs.writeFileSync(LIVE, '<!-- AUTO-GENERATED live view of .agents/coord/board.json — read-only, do not edit -->\n' + brief(b, null) + '\n'); } catch {}
    writeAtomic(BOARD, JSON.stringify(b, null, 2));
    return out;
  } finally { try { fs.rmdirSync(LOCK); } catch {} }
}
