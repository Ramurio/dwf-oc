import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { publicError } from './run-store.mjs';

function publish(path, bytes) {
  const temporary = path + '.' + randomUUID();
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o400 });
    try { linkSync(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (readFileSync(path, 'utf8') !== bytes) throw publicError('Сохранённый материал отчёта изменился.');
    }
  } finally { rmSync(temporary, { force: true }); }
}

// Share only explicitly reported text, frozen at the reporting attempt. Never
// grant another participant access to a live worktree or follow an escape link.
export function captureReportArtifacts(root, state, visit, paths) {
  if (!paths?.length) return [];
  const workspace = realpathSync((visit.workspace ?? state.workspace).path);
  const directory = join(realpathSync(root), 'workflows', state.id, 'contexts', visit.inputId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return paths.map((uri, index) => {
    const target = join(directory, `report-artifact-${index}.json`);
    const textPath = join(directory, `report-artifact-${index}.txt`);
    try {
      const saved = JSON.parse(readFileSync(target, 'utf8')).reference;
      if (saved.uri !== uri || saved.inputId !== visit.inputId || saved.revision !== visit.revision) {
        throw publicError('Материал отчёта уже сохранён для другого пути или снимка этой попытки.');
      }
      return saved;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let content, reference = { uri, inputId: visit.inputId, revision: visit.revision };
    try {
      if (isAbsolute(uri) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) throw new Error('Use a project-relative file');
      const part = relative(workspace, resolve(workspace, uri));
      if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) throw new Error('File escapes the project workspace');
      let bytes;
      if ((visit.workspace ?? state.workspace).mode !== 'directory') {
        const git = args => execFileSync('git', args, { cwd: workspace, maxBuffer: 1024 * 1024 + 1024,
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_LITERAL_PATHSPECS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const entry = git(['ls-tree', visit.revision, '--', part]).toString();
        const match = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
        if (!match) throw new Error('File is absent from the reported revision or is not regular');
        if (Number(git(['cat-file', '-s', match[2]])) > 1024 * 1024) throw new Error('File exceeds 1 MiB');
        bytes = git(['cat-file', 'blob', match[2]]);
      } else {
        const path = realpathSync(resolve(workspace, uri));
        const resolved = relative(workspace, path);
        if (isAbsolute(resolved) || resolved === '..' || resolved.startsWith('..' + sep)) throw new Error('File escapes the project workspace');
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Expected a regular UTF-8 file up to 1 MiB');
          bytes = readFileSync(fd);
        } finally { closeSync(fd); }
      }
      if (bytes.length > 1024 * 1024) throw new Error('File exceeds 1 MiB');
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      reference = { ...reference, access: 'read', path: textPath, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      reference = { ...reference, access: 'unavailable', reason: error.code ?? error.message };
    }
    // Keep real lines: embedding a document as one JSON string causes native
    // read tools to truncate its content at their per-line display limit.
    if (content !== undefined) publish(textPath, content);
    publish(target, JSON.stringify({ reference }, null, 2) + '\n');
    return reference;
  });
}
