import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync, fsyncSync, renameSync, chmodSync, statSync, readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { publicError } from './run-store.mjs';

function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

export function git(cwd, args, extraEnv = {}) {
  try {
    return execFileSync('git', args, { cwd, env: { ...environment(), ...extraEnv },
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw publicError('Не удалось выполнить Git ' + args[0] + '. Проверьте состояние рабочего дерева.');
  }
}

export function prepareWorkspace(root, cwd, id, mode = 'worktree') {
  const source = mode === 'directory' ? cwd : git(cwd, ['rev-parse', '--show-toplevel']);
  const instructions = [];
  let parent = dirname(source);
  while (parent !== source) {
    const file = join(parent, 'AGENTS.md');
    try { instructions.unshift({ path: file, content: readFileSync(file, 'utf8') }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  mkdirSync(join(root, 'workflows', id), { recursive: true, mode: 0o700 });
  if (mode === 'directory') return { mode, source, path: source, instructions };
  const branch = git(source, ['symbolic-ref', '--short', 'HEAD']);
  if (git(source, ['status', '--porcelain'])) throw publicError('Для запуска workflow нужна чистая исходная Git-ветка.');
  const base = git(source, ['rev-parse', 'HEAD']);
  const path = join(root, 'workflows', id, 'worktree');
  const candidate = 'dwf/' + id;
  git(source, ['worktree', 'add', '-b', candidate, path, base]);
  return { source, branch, base, path, candidate, instructions };
}

export function snapshot(workspace) {
  if (workspace.mode !== 'directory') return tree(workspace.path);
  const hash = createHash('sha256');
  function visit(directory) {
    for (const name of readdirSync(join(workspace.path, directory)).sort()) {
      const path = join(directory, name);
      const absolute = join(workspace.path, path);
      const info = lstatSync(absolute);
      hash.update(JSON.stringify([path, info.mode]));
      if (info.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(absolute)));
      else if (info.isDirectory()) visit(path);
      else if (info.isFile()) hash.update(createHash('sha256').update(readFileSync(absolute)).digest());
      else throw publicError('Read-only каталог содержит неподдерживаемый тип файла.');
    }
  }
  visit('');
  return hash.digest('hex');
}

export function tree(workspace) {
  const directory = mkdtempSync(join(tmpdir(), 'dwf-index-'));
  const env = { GIT_INDEX_FILE: join(directory, 'index') };
  try {
    git(workspace, ['read-tree', 'HEAD'], env);
    git(workspace, ['add', '--all', '--', '.'], env);
    return git(workspace, ['write-tree'], env);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function writeReviewDiff(workspace, revision, file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      // Stream the complete patch to disk, including binary data and uncommitted files in the tree.
      execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
        '--no-renames', '--no-color', '--no-relative', '--ignore-submodules=none', '--unified=3',
        '--src-prefix=a/', '--dst-prefix=b/', workspace.base, revision, '--'],
      { cwd: workspace.path, env: environment(), stdio: ['ignore', descriptor, 'pipe'] });
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    chmodSync(temporary, 0o400);
    renameSync(temporary, file);
    return { base: workspace.base, revision, path: file, bytes: statSync(file).size };
  } catch {
    throw publicError('Не удалось сохранить полный diff для reviewer.');
  } finally { rmSync(temporary, { force: true }); }
}

export function mergeWorkspace(workspace, expectedTree) {
  if (git(workspace.path, ['symbolic-ref', '--short', 'HEAD']) !== workspace.candidate ||
    tree(workspace.path) !== expectedTree) throw publicError('Проверенное рабочее дерево изменилось до интеграции.');
  if (git(workspace.source, ['symbolic-ref', '--short', 'HEAD']) !== workspace.branch ||
    git(workspace.source, ['status', '--porcelain'])) throw publicError('Исходная ветка переключена или содержит незавершённые изменения.');
  const candidateHead = git(workspace.path, ['rev-parse', 'HEAD']);
  // A completed fast-forward is recoverable after a controller crash.
  const sourceHead = git(workspace.source, ['rev-parse', 'HEAD']);
  if (sourceHead === candidateHead && git(workspace.source, ['rev-parse', 'HEAD^{tree}']) === expectedTree) return sourceHead;
  if (sourceHead !== workspace.base) throw publicError('Исходная ветка продвинулась после запуска workflow. Нужна повторная проверка интеграции.');
  if (git(workspace.path, ['status', '--porcelain'])) {
    git(workspace.path, ['add', '--all', '--', '.']);
    git(workspace.path, ['commit', '-m', 'DWF verified workflow']);
  }
  if (git(workspace.path, ['rev-parse', 'HEAD^{tree}']) !== expectedTree || tree(workspace.path) !== expectedTree) {
    throw publicError('Коммит отличается от проверенной версии. Интеграция остановлена.');
  }
  git(workspace.source, ['merge', '--ff-only', workspace.candidate]);
  if (git(workspace.source, ['rev-parse', 'HEAD^{tree}']) !== expectedTree || git(workspace.source, ['status', '--porcelain'])) {
    throw publicError('Состояние исходной ветки после merge требует проверки.');
  }
  return git(workspace.source, ['rev-parse', 'HEAD']);
}
