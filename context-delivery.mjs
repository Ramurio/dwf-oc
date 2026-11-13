import { admissionStage } from './workflow-admission.mjs';

// Delivery is part of the persisted input, not scheduler progress or model-call
// accounting. Only a native inbox acknowledgement may advance this cursor.
const object = value => value !== null && typeof value === 'object';
const pointer = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

// JSON Patch (add/remove/replace/move), including element-wise arrays. Replacing an
// entire catalog/events array would resend old reports and decisions every round.
function changes(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!object(before) || !object(after) || Array.isArray(before) !== Array.isArray(after)) {
    return [{ op: 'replace', path, value: after }];
  }
  if (Array.isArray(after)) {
    // Identity-aware alignment avoids retransmitting unchanged reports when the
    // latest-report order changes after a participant returns. Primitive arrays
    // (criteria, requirements) retain positional JSON Patch semantics.
    const identity = value => value && typeof value === 'object' ?
      value.inputId ?? value.id ?? value.sequence ?? value.source : undefined;
    const keys = list => list.map(identity);
    const keyed = list => keys(list).every(key => key !== undefined) && new Set(keys(list)).size === list.length;
    if (keyed(before) && keyed(after)) {
      const current = [...before];
      const updates = [];
      const wanted = new Set(keys(after));
      for (let i = current.length - 1; i >= 0; i--) if (!wanted.has(identity(current[i]))) {
        updates.push({ op: 'remove', path: `${path}/${i}` }); current.splice(i, 1);
      }
      for (const [i, value] of after.entries()) {
        const at = current.findIndex(item => identity(item) === identity(value));
        if (at < 0) {
          updates.push({ op: 'add', path: `${path}/${i}`, value }); current.splice(i, 0, value);
        } else {
          if (at !== i) {
            updates.push({ op: 'move', from: `${path}/${at}`, path: `${path}/${i}` });
            current.splice(i, 0, current.splice(at, 1)[0]);
          }
          updates.push(...changes(current[i], value, `${path}/${i}`)); current[i] = value;
        }
      }
      return updates;
    }
    const shared = Math.min(before.length, after.length);
    return [
      ...after.slice(0, shared).flatMap((value, i) => changes(before[i], value, `${path}/${i}`)),
      ...before.slice(after.length).map((_, i) => ({ op: 'remove', path: `${path}/${before.length - i - 1}` })),
      ...after.slice(shared).map((value, i) => ({ op: 'add', path: `${path}/${shared + i}`, value })),
    ];
  }
  return [
    ...Object.keys(before).filter(key => !Object.hasOwn(after, key)).map(key => ({ op: 'remove', path: `${path}/${pointer(key)}` })),
    ...Object.entries(after).flatMap(([key, value]) => Object.hasOwn(before, key) ?
      changes(before[key], value, `${path}/${pointer(key)}`) : [{ op: 'add', path: `${path}/${pointer(key)}`, value }]),
  ];
}

export function prepareContextDelivery(state, visit, snapshot, readable) {
  const participant = visit.participant ?? visit.node;
  const base = visit.sessionId && readable && state.participants?.[visit.node]?.memory !== false &&
    state.visits.flatMap(v => v.children ?? [v]).findLast(v => v.inputId !== visit.inputId &&
      v.sessionId === visit.sessionId && (v.participant ?? v.node) === participant &&
      v.implementId === visit.implementId && v.admitted && v.delivery?.acknowledged && v.taskContext);
  visit.delivery = { formatVersion: 1, mode: base ? 'delta' : 'snapshot', acknowledged: false,
    ...(base ? { baseInputId: base.inputId } : {}), snapshot };
  if (!base) return visit.taskContext;
  return { formatVersion: 1, runId: state.id, inputId: visit.inputId, role: visit.taskContext.role,
    node: visit.node, participant, candidate: visit.revision,
    ...(visit.taskContext.implement ? { implement: { id: visit.implementId, taskId: visit.taskId, cycle: visit.taskContext.implement.cycle } } : {}),
    delivery: { mode: 'delta', baseInputId: base.inputId, snapshot,
      ...(visit.taskContext.history ? { history: visit.taskContext.history } : {}),
      instructions: 'Apply these ordered JSON Patch updates to the task/context snapshot from baseInputId. Unchanged requirements, decisions and reports remain in force. If that context is missing (including session recovery or compaction), read the complete current snapshot at snapshot.path before acting. It contains the exact requirements, decisions and current state; history links retain the complete journal. Do not interpret omitted fields as withdrawn requirements.' },
    updates: changes(base.taskContext, visit.taskContext) };
}

// Called in the EXISTING fenced acknowledgement write, after native admission.
// A replay of a cached native result uses the same input and does not add a visit.
export function acknowledgeContext(visit) {
  if (visit.delivery && !visit.correction) visit.delivery.acknowledged = true;
}

// No migration: old records have no delivery marker and cannot be used as a
// proven base. Validation is shared by reads and every fenced store write.
export function validateContextDelivery(state, saved, reject) {
  const inputs = workflow => (workflow.visits ?? []).flatMap(v => v.children ?? [v]);
  const visits = inputs(state);
  const current = new Map(visits.map(visit => [visit.inputId, visit]));
  const seen = new Map();
  for (const visit of visits) {
    const delivery = visit.delivery;
    if (delivery) {
      if (delivery.formatVersion !== 1 || !['snapshot', 'delta'].includes(delivery.mode) ||
          typeof delivery.acknowledged !== 'boolean' || !delivery.snapshot?.path || !visit.taskContext ||
          (delivery.acknowledged && !visit.admitted)) reject('неверное подтверждение доставки контекста.');
      const base = seen.get(delivery.baseInputId);
      if (delivery.mode === 'delta' && (!base?.delivery?.acknowledged || !base.admitted ||
          base.sessionId !== visit.sessionId || (base.participant ?? base.node) !== (visit.participant ?? visit.node) ||
          base.implementId !== visit.implementId)) reject('неверная граница доставки контекста.');
      if (delivery.mode === 'snapshot' && delivery.baseInputId !== undefined) reject('снимок не имеет cursor.');
    }
    seen.set(visit.inputId, visit);
  }
  for (const { previous, group } of (saved?.visits ?? []).flatMap(group =>
    (group.children ?? [group]).map(previous => ({ previous, group })))) {
    if (!previous.delivery) continue;
    const next = current.get(previous.inputId);
    if (admissionStage(previous, group) === 'prepared') continue;
    const { acknowledged, ...frozen } = previous.delivery;
    const { acknowledged: nextAcknowledged, ...nextFrozen } = next?.delivery ?? {};
    if (!next || previous.sessionId !== next.sessionId || previous.node !== next.node ||
        previous.participant !== next.participant || previous.implementId !== next.implementId ||
        JSON.stringify(frozen) !== JSON.stringify(nextFrozen) || (acknowledged && !nextAcknowledged)) {
      reject('замороженная доставка контекста неизменяема.');
    }
  }
}
