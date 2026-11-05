// ACID concurrent tracking store backed by Node v25 built-in `node:sqlite` (DatabaseSync, WAL mode).
// Eliminates shared JSON lock contention across 5-30 concurrent agents on Windows + OneDrive.
import { ensureWrapperDirs } from './io.mjs';

let _SqliteCtor = null;

async function getDatabaseSync() {
  if (_SqliteCtor) return _SqliteCtor;
  // Suppress Node's ExperimentalWarning for built-in SQLite so CLI/hook stderr stays clean.
  const origEmitWarning = process.emitWarning;
  process.emitWarning = function filteredWarning(warning, ...args) {
    const msg = typeof warning === 'string' ? warning : warning?.message || '';
    if (msg.includes('SQLite is an experimental feature')) return;
    return origEmitWarning.call(this, warning, ...args);
  };
  try {
    const mod = await import('node:sqlite');
    _SqliteCtor = mod.DatabaseSync;
    return _SqliteCtor;
  } finally {
    process.emitWarning = origEmitWarning;
  }
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS spec_matrix (
  feat TEXT NOT NULL,
  req_id TEXT NOT NULL,
  task_id TEXT,
  emp_id TEXT,
  qa_id TEXT,
  pct INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'open',
  blind_test_file TEXT,
  blind_test_hash TEXT,
  files_mod_json TEXT NOT NULL DEFAULT '[]',
  receipt_id TEXT,
  bounces INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (feat, req_id)
);

CREATE TABLE IF NOT EXISTS desks (
  task_id TEXT PRIMARY KEY,
  feat TEXT NOT NULL,
  req_id TEXT NOT NULL,
  title TEXT NOT NULL,
  emp_id TEXT,
  qa_id TEXT,
  pm_id TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  wave INTEGER NOT NULL DEFAULT 0,
  deps_json TEXT NOT NULL DEFAULT '[]',
  radius_json TEXT NOT NULL DEFAULT '[]',
  worktree TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_leases (
  file_code TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rw',
  locked_by_role TEXT NOT NULL DEFAULT 'eng',
  pid INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  task_id TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  feat TEXT,
  chair_id TEXT NOT NULL,
  members_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS room_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  emp_id TEXT NOT NULL,
  task_id TEXT,
  cmd TEXT NOT NULL,
  cwd TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  stdout_hash TEXT NOT NULL,
  passed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  tokens_used INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  delta INTEGER NOT NULL,
  pts_after INTEGER NOT NULL,
  task_id TEXT,
  evidence TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  event TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pushbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id TEXT NOT NULL,
  from_pm TEXT NOT NULL,
  task_id TEXT,
  severity TEXT NOT NULL DEFAULT 'warn',
  message TEXT NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
`;

export const plain = (row) => (row ? { ...row } : null);
export const plainAll = (rows) => (rows || []).map((r) => ({ ...r }));

// Opens, runs callback inside WAL-configured SQLite DB, and closes handle immediately
// so Windows/OneDrive never holds lingering .db-wal/.db-shm locks across processes.
export async function withDb(baseDir, fn) {
  const p = ensureWrapperDirs(baseDir);
  const DatabaseSync = await getDatabaseSync();
  const db = new DatabaseSync(p.db);
  try {
    db.exec(SCHEMA_SQL);
    return await fn(db, p);
  } finally {
    try { db.close(); } catch {}
  }
}

export async function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = await fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}
