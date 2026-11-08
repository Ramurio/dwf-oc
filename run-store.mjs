import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const schemaVersion = 1;
export const publicError = message => Object.assign(new Error(message), { publicMessage: message });

function open(root, write) {
  const file = join(root, 'dwf.sqlite');
  if (!write && !existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (existing.some(table => table.name === 'dwf_schema')) {
      const versions = db.prepare('SELECT version FROM dwf_schema').all();
      if (versions.length !== 1 || versions[0].version !== schemaVersion) {
        throw publicError('Несовместимая версия состояния DWF.');
      }
    } else {
      if (!write || existing.length) throw publicError('Несовместимая версия состояния DWF.');
      db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS dwf_schema (version INTEGER PRIMARY KEY CHECK (version = 1));
      INSERT OR IGNORE INTO dwf_schema VALUES (1);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0 CHECK (admitted IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
        result TEXT, error TEXT, answer_id TEXT,
        CHECK ((status = 'running' AND result IS NULL AND error IS NULL) OR
          (status = 'succeeded' AND result IS NOT NULL AND error IS NULL AND answer_id IS NOT NULL) OR
          (status = 'failed' AND result IS NULL AND error IS NOT NULL))
      );
      COMMIT;`);
    }
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}

export function createRun(root, run) {
  const db = open(root, true);
  try {
    db.prepare('INSERT INTO runs (id, session_id, input_id, request) VALUES (?, ?, ?, ?)')
      .run(run.id, run.sessionId, run.inputId, JSON.stringify(run.request));
  } finally { db.close(); }
}

export async function withServiceLock(root, start) {
  const db = open(root, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    return await start();
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

export function getRun(root, runId) {
  const db = open(root, false);
  if (!db) return undefined;
  try {
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!row) return undefined;
    return { id: row.id, sessionId: row.session_id, inputId: row.input_id,
      request: JSON.parse(row.request), admitted: row.admitted === 1, status: row.status,
      result: row.result, error: row.error, answerId: row.answer_id };
  } finally { db.close(); }
}

export function markAdmitted(root, runId) {
  const db = open(root, true);
  try { db.prepare('UPDATE runs SET admitted = 1 WHERE id = ?').run(runId); }
  finally { db.close(); }
}

export function saveOutcome(root, runId, outcome) {
  const db = open(root, true);
  try {
    db.prepare(`UPDATE runs SET status = ?, result = ?, error = ?, answer_id = ?
      WHERE id = ? AND status = 'running'`)
      .run(outcome.status, outcome.result ?? null, outcome.error ?? null, outcome.answerId ?? null, runId);
  } finally { db.close(); }
}

export function publicOutcome(run) {
  if (run.status === 'succeeded') return { runId: run.id, status: run.status, result: run.result };
  if (run.status === 'failed') return { runId: run.id, status: run.status, error: run.error };
  return { runId: run.id, status: 'running' };
}

function workflowTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, state TEXT NOT NULL, owner TEXT, expires INTEGER NOT NULL DEFAULT 0)');
}

export function createWorkflow(root, state) {
  const db = open(root, true);
  try {
    workflowTable(db);
    db.prepare('INSERT INTO workflows (id, state) VALUES (?, ?)').run(state.id, JSON.stringify(state));
  } finally { db.close(); }
}

export function getWorkflow(root, id) {
  const db = open(root, false);
  if (!db) return undefined;
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'workflows'").get()) return undefined;
    const row = db.prepare('SELECT state FROM workflows WHERE id = ?').get(id);
    return row && JSON.parse(row.state);
  } finally { db.close(); }
}

export function claimWorkflow(root, id, owner) {
  const db = open(root, true);
  try {
    const now = Date.now();
    return db.prepare('UPDATE workflows SET owner = ?, expires = ? WHERE id = ? AND (owner IS NULL OR expires < ?)')
      .run(owner, now + 30000, id, now).changes === 1;
  } finally { db.close(); }
}

export function workflowHasOwner(root, id) {
  const db = open(root, false);
  if (!db) return false;
  try {
    const row = db.prepare('SELECT owner, expires FROM workflows WHERE id = ?').get(id);
    return Boolean(row?.owner && row.expires > Date.now());
  } finally { db.close(); }
}

export function savePreset(root, name, definition) {
  const db = open(root, true);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS presets (name TEXT PRIMARY KEY, definition TEXT NOT NULL)');
    db.prepare('INSERT INTO presets VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET definition = excluded.definition')
      .run(name, JSON.stringify(definition));
  } finally { db.close(); }
}

export function presets(root) {
  const db = open(root, false);
  if (!db) return [];
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'presets'").get()) return [];
    return db.prepare('SELECT name, definition FROM presets ORDER BY name').all()
      .map(row => ({ name: row.name, definition: JSON.parse(row.definition) }));
  } finally { db.close(); }
}

export function updateWorkflow(root, state, owner, complete = false) {
  const db = open(root, true);
  try {
    const result = db.prepare('UPDATE workflows SET state = ?, owner = ?, expires = ? WHERE id = ? AND owner = ?')
      .run(JSON.stringify(state), complete ? null : owner, complete ? 0 : Date.now() + 30000, state.id, owner);
    if (result.changes !== 1) throw publicError('Контроллер workflow потерял владение запуском.');
  } finally { db.close(); }
}
