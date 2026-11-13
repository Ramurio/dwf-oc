import { validateTaskState, recordTaskSteering } from './task-packages.mjs';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  validateTaskState(state);
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
    if (!row) return undefined;
    const state = JSON.parse(row.state);
    validateTaskState(state);
    return state;
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

export function queueWorkflowCommand(root, id, kind, node, text, revisionKind = 'clarification') {
  if (!['clarification', 'decision'].includes(revisionKind)) throw publicError('Неверный вид уточнения.');
  if (!['stop', 'steer'].includes(kind)) throw publicError('Неизвестная команда workflow.');
  const db = open(root, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    workflowTable(db);
    const row = db.prepare('SELECT state FROM workflows WHERE id = ?').get(id);
    if (!row) throw publicError('Workflow не найден.');
    const state = JSON.parse(row.state);
    validateTaskState(state);
    const stopped = state.controls?.find(command => command.kind === 'stop');
    if (kind === 'stop' && stopped) return stopped;
    if (state.status !== 'running' || state.finalizing || stopped) throw publicError('Workflow уже завершает работу и не принимает команды.');
    if (kind === 'steer' && state.definition.nodes[state.definition.entry]?.role === 'scientist') {
      throw publicError('Research-mid выполняет исходное поручение целиком. Используйте stop и новый запуск для изменения задачи.');
    }
    const knownParticipant = Object.hasOwn(state.definition.nodes, node) ||
      state.visits.flatMap(visit => visit.children ?? [visit]).some(visit => visit.participant === node);
    if (kind === 'steer' && (!knownParticipant ||
      typeof text !== 'string' || !text.trim())) throw publicError('Нужны известный участник и непустое уточнение.');
    const command = { id: randomUUID(), kind, status: 'pending', createdAt: Date.now(),
      ...(kind === 'steer' ? { node, text } : {}) };
    if (kind === 'steer') recordTaskSteering(state, command, revisionKind);
    validateTaskState(state);
    state.controls ??= [];
    state.controls.push(command);
    db.prepare('UPDATE workflows SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
    db.exec('COMMIT');
    return command;
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

export function updateWorkflow(root, state, owner, complete = false, finalize = false) {
  const db = open(root, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    refreshControls(db, state, owner);
    if (finalize) {
      if (state.controls?.some(command => command.status === 'pending')) return false;
      state.finalizing = true;
    }
    const result = db.prepare('UPDATE workflows SET state = ?, owner = ?, expires = ? WHERE id = ? AND owner = ?')
      .run(JSON.stringify(state), complete ? null : owner, complete ? 0 : Date.now() + 30000, state.id, owner);
    if (result.changes !== 1) throw publicError('Контроллер workflow потерял владение запуском.');
    db.exec('COMMIT');
    return true;
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

function refreshControls(db, state, owner) {
  const row = db.prepare('SELECT state FROM workflows WHERE id = ? AND owner = ?').get(state.id, owner);
  if (!row) throw Object.assign(publicError('Контроллер workflow потерял владение запуском.'), { code: 'DWF_OWNER_LOST' });
  const saved = JSON.parse(row.state);
  // Revisions are appended by commands under the same transaction as controls.
  // Check the caller's prefix before merging commands accepted by another process.
  validateTaskState(state, { ...saved, taskRevisions: (saved.taskRevisions ?? []).slice(0, (state.taskRevisions ?? []).length) });
  if (saved.taskRevisions) state.taskRevisions = structuredClone(saved.taskRevisions);
  validateTaskState(state, saved);
  if (saved.controls?.length) {
    const known = new Map((state.controls ?? []).map(command => [command.id, command]));
    state.controls = saved.controls.map(command => known.get(command.id) ?? command);
  }
  return saved;
}

// Keep the owner check and external side effect indivisible with respect to commands and takeover.
export async function withWorkflowAction(root, state, owner, action) {
  const db = open(root, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    const saved = refreshControls(db, state, owner);
    const result = await action();
    validateTaskState(state, saved);
    const complete = state.status !== 'running';
    db.prepare('UPDATE workflows SET state = ?, owner = ?, expires = ? WHERE id = ? AND owner = ?')
      .run(JSON.stringify(state), complete ? null : owner, complete ? 0 : Date.now() + 30000, state.id, owner);
    db.exec('COMMIT');
    return result;
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

// A consistent, read-only snapshot for observers. Never claims or resumes runs.
export function savedRuns(root) {
  const db = open(root, false);
  if (!db) return { workflows: [], runs: [] };
  try {
    db.exec('BEGIN');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    const workflows = tables.includes('workflows') ? db.prepare('SELECT rowid, state, owner, expires FROM workflows ORDER BY rowid DESC').all()
      .map(row => { const state = JSON.parse(row.state); validateTaskState(state);
        return { state, order: row.rowid, owned: Boolean(row.owner && row.expires > Date.now()) }; }) : [];
    const runs = db.prepare('SELECT rowid, * FROM runs ORDER BY rowid DESC').all().map(row => ({ id: row.id,
      sessionId: row.session_id, inputId: row.input_id, request: JSON.parse(row.request), admitted: row.admitted === 1,
      status: row.status, result: row.result, error: row.error, order: row.rowid }));
    return { workflows, runs };
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}
