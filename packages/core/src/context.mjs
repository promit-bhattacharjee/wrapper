// context: workspace root discovery and the paths derived from it.
// Root order: setRoot(arg) / --root, then env WRAPPER_ROOT, then the legacy layout
// (<root>/.agents/plugins/wrapper/...), then the current directory.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SELF = path.resolve(HERE, '..', '..', 'cli', 'bin', 'wrapper.mjs').replace(/\\/g, '/');

export const STALE_MS = 20 * 60 * 1000; // no heartbeat for 20 min => session treated as gone
export const PURGE_MS = 24 * 3600 * 1000;
export const FAST_MS = 8000; // hook heartbeat is skipped if the board was touched by this agent this recently and nothing is new
export const PULSE_MS = 15000;
export const BEAT_IDLE_MS = 45 * 60 * 1000; // pulse stops vouching for a session with no activity for 45 min
export const LOG_MAX = 400;

export let ROOT, COORD, BOARD, LOCK, HANDOFF, LIVE, PULSE, INBOX, DISPATCH, CLI;

// The old plugin lived at <root>/.agents/plugins/wrapper/bin; when this code is installed there, that root is the default.
export function legacyRoot(selfFile = SELF) {
  const m = /^(.*)\/\.agents\/plugins\/wrapper\//.exec(selfFile.replace(/\\/g, '/'));
  return m ? path.resolve(m[1]) : null;
}

export function discoverRoot(explicit, env = process.env, cwd = process.cwd(), selfFile = SELF) {
  if (explicit) return { root: path.resolve(explicit), explicit: true };
  if (env.WRAPPER_ROOT) return { root: path.resolve(env.WRAPPER_ROOT), explicit: true };
  const legacy = legacyRoot(selfFile);
  if (legacy) return { root: legacy, explicit: false };
  return { root: path.resolve(cwd), explicit: false };
}

export function setRoot(explicit) {
  const { root, explicit: isExplicit } = discoverRoot(explicit);
  ROOT = root;
  COORD = path.join(ROOT, '.agents', 'coord');
  BOARD = path.join(COORD, 'board.json');
  LOCK = path.join(COORD, 'board.lock');
  HANDOFF = path.join(COORD, 'HANDOFF.md');
  LIVE = path.join(COORD, 'LIVE.md');
  PULSE = path.join(COORD, 'pulse.json');
  INBOX = path.join(COORD, 'inbox');
  DISPATCH = path.join(COORD, 'dispatch');
  // An explicit root is repeated in every command line we print or install, so hooks started elsewhere find the same board.
  CLI = `node "${SELF}"${isExplicit ? ` --root "${ROOT.replace(/\\/g, '/')}"` : ''}`;
  return ROOT;
}

setRoot();
