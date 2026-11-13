import { prepareRoleInput } from './role-context.mjs';
import { taskBinding, validateTaskReference } from './task-packages.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { participantVisits, validateItems } from './workflow-definition.mjs';
import { git, snapshot, verificationWorkspace, writeReviewDiff } from './workflow-git.mjs';
import { publicError } from './run-store.mjs';

export function prepareGroup(root, state, id, previous) {
  const group = state.definition.groups[id];
  const items = group.members ? group.members.map(node => ({ node, participant: node,
    required: (group.required ?? group.members).includes(node) })) :
    validateItems(group.items ?? participantVisits(state.visits).findLast(visit => visit.node === group.itemsFrom)?.verdict?.items)
      .map(item => ({ node: group.member, participant: `${id}/${item.id}`, item, required: true }));
  // Validate all dynamic links before preparing any child workspace or session.
  if (state.definition.taskPackages) {
    for (const item of items) validateTaskReference(state.definition, item.item?.taskId);
  }
  const revision = snapshot(state.workspace);
  const children = items.map(item => {
    const node = state.definition.nodes[item.node];
    const sessionId = state.participants?.[item.node]?.memory === false ? 'ses_' + randomUUID()
      : state.sessions[item.participant] ?? 'ses_' + randomUUID();
    const inputId = 'msg_' + randomUUID();
    const workspace = verificationWorkspace(root, state.id, state.workspace, revision, inputId);
    const review = node.role === 'reviewer' && state.workspace.mode !== 'directory'
      ? writeReviewDiff(workspace, revision, join(root, 'workflows', state.id, 'reviews', `${inputId}.diff`)) : undefined;
    const input = previous && ['scout', 'researcher'].includes(node.role) ? { summary: previous.summary } : previous;
    const child = { ...item, ...taskBinding(state, item.node, item.item), sessionId, inputId, revision,
      startedAt: Date.now(), workspace, ...(review ? { review } : {}) };
    prepareRoleInput(root, state, child, input, workspace, id);
    return child;
  });
  return { node: id, inputId: 'group_' + randomUUID(), revision, startedAt: Date.now(), admissionStarted: false, children };
}

export function groupVerdict(visit) {
  const required = visit.children.filter(child => child.required);
  const failed = required.some(child => child.error || child.verdict?.outcome === 'blocked');
  const changes = required.some(child => child.verdict?.outcome === 'changes');
  return { outcome: failed ? 'failed' : changes ? 'changes' : 'done',
    summary: `Собраны результаты ${visit.children.length} участников группы ${visit.node}.`,
    results: visit.children.map(child => ({ participant: child.participant, node: child.node,
      required: child.required, ...(child.taskId ? { taskId: child.taskId, taskVersion: child.taskVersion } : {}), ...(child.item ? { item: child.item } : {}), revision: child.revision,
      status: child.error ? 'failed' : 'completed',
      ...(child.error ? { error: child.error } : { result: child.verdict }) })) };
}

export function integrateGroup(root, state, visit) {
  const writers = visit.children.filter(child => state.definition.nodes[child.node].role === 'worker' &&
    child.verdict?.outcome === 'done');
  if (!writers.length) return;
  const combined = verificationWorkspace(root, state.id, state.workspace, visit.revision, 'group_' + randomUUID());
  let revision;
  try {
    for (const child of writers) {
      const patch = writeReviewDiff({ ...child.workspace, base: visit.revision }, child.revision,
        join(root, 'workflows', state.id, 'groups', `${child.inputId}.diff`));
      if (patch.bytes) git(combined.path, ['apply', '--3way', '--index', patch.path]);
    }
    revision = snapshot(combined);
  } finally {
    git(state.workspace.path, ['worktree', 'remove', '--force', combined.path]);
  }
  const current = snapshot(state.workspace);
  if (current !== visit.revision && current !== revision) throw publicError('Рабочее дерево изменилось во время параллельной группы.');
  // Recompute from persisted child trees after a crash between read-tree and the state commit.
  if (current !== revision) {
    git(state.workspace.path, ['read-tree', visit.revision]);
    git(state.workspace.path, ['read-tree', '--reset', '-u', revision]);
  }
  if (snapshot(state.workspace) !== revision) throw publicError('Объединённый результат группы требует повторной проверки.');
  visit.integratedRevision = revision;
}
