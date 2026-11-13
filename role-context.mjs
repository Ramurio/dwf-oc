import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { taskPackageAt } from './task-packages.mjs';
import { participantSettings, rolePrompt, roleTools, workflowControlContext } from './workflow-definition.mjs';
import { publicError } from './run-store.mjs';

// These are immutable, per-input documents, not links to a mutable controller record.
function document(directory, name, value) {
  const path = join(directory, name);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readFileSync(path, 'utf8') !== bytes) throw publicError('Context artifact is immutable: ' + name);
  }
  return { path };
}

function within(root, path) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
}
function canonical(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const parent = resolve(path, '..');
    return parent === path ? path : join(canonical(parent), relative(parent, path));
  }
}

// Package URIs are opaque in storage. Never grant access outside the project just
// because user-supplied metadata contains an absolute path, traversal or symlink.
export function artifactLink(artifact, workspace, tools) {
  const { uri } = artifact;
  if (/^https?:\/\//i.test(uri)) return { ...artifact, access: tools.includes('webfetch') ? 'webfetch' : 'unavailable',
    ...(tools.includes('webfetch') ? {} : { reason: 'webfetch is not permitted for this participant' }) };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || isAbsolute(uri)) {
    return { ...artifact, access: 'unavailable', reason: 'Only project-relative paths and HTTP(S) references are supported' };
  }
  const path = resolve(workspace.path, uri);
  try {
    if (!within(resolve(workspace.path), path) || !within(canonical(workspace.path), canonical(path))) {
      return { ...artifact, access: 'unavailable', reason: 'Reference escapes the project workspace' };
    }
  } catch (error) {
    return { ...artifact, access: 'unavailable', reason: `Reference cannot be resolved: ${error.code ?? 'invalid path'}` };
  }
  return { ...artifact, path, access: tools.includes('read') ? 'read' : 'unavailable',
    ...(tools.includes('read') ? {} : { reason: 'read is not permitted for this participant' }) };
}

function report(visit, index, definition) {
  return { visit: index + 1, node: visit.node, participant: visit.participant ?? visit.node,
    role: visit.children ? 'group' : definition.nodes[visit.node]?.role, sessionId: visit.sessionId, taskId: visit.taskId, taskVersion: visit.taskVersion,
    revision: visit.revision, ...(visit.verdict ? { result: visit.verdict } : {}),
    ...(visit.error ? { error: visit.error } : {}),
    ...(visit.integratedRevision ? { integratedRevision: visit.integratedRevision } : {}) };
}
function latestReports(reports) {
  const latest = new Map();
  for (const value of reports) latest.set(value.participant, value);
  return [...latest.values()].sort((a, b) => a.visit - b.visit);
}
function scopedPrevious(previous, taskId) {
  if (!previous) return undefined;
  // A group envelope is not a single task's report. Never forward its other items.
  if (Array.isArray(previous.results)) {
    const { results, ...envelope } = previous;
    return { ...envelope, results: results.filter(result => result.taskId === taskId) };
  }
  return previous;
}

export function prepareRoleInput(root, state, visit, previous, workspace = state.workspace, transitionSource = visit.node, steering) {
  const definition = state.definition;
  const node = definition.nodes[visit.node];
  if (!['worker', 'reviewer', 'verifier', 'orchestrator'].includes(node.role)) return;
  const savedPermissions = state.participants?.[visit.node]?.agent.permissions ?? state.rolePermissions?.[node.role];
  const tools = savedPermissions ? savedPermissions.filter(rule => rule.effect === 'allow').map(rule => rule.action) :
    participantSettings(definition, visit.node).tools ?? roleTools[node.role];
  const directory = join(realpathSync(root), 'workflows', state.id, 'contexts', visit.inputId);
  const saveDocument = (name, data) => ({ ...document(directory, name, data),
    access: tools.includes('read') ? 'read' : 'unavailable',
    ...(tools.includes('read') ? {} : { reason: 'read is not permitted for this participant' }) });
  const source = saveDocument('source.json', { definition,
    inputSnapshot: state.inputSnapshot ?? null });
  const packages = new Map((definition.taskPackages ?? []).map(task => {
    const version = task.id === visit.taskId ? visit.taskVersion : undefined;
    const data = taskPackageAt(state, task.id, version);
    return [task.id, { data, details: saveDocument(`${task.id}-v${data.version}.json`, data) }];
  }));
  // Keep group outcomes as well as child reports: successful branches do not
  // establish that their integration succeeded. Store the full, chronological
  // evidence once; role inputs use addressed reports or navigation cards.
  const executions = state.visits.flatMap(v => v.children ? [...v.children, v] : [v]);
  const historyReports = executions.filter(v => v.inputId !== visit.inputId)
    .filter(v => v.verdict || v.error || v.admitted).map((v, i) => report(v, i, definition));
  const allReports = historyReports.filter(r => r.role !== 'group');
  const history = saveDocument('history.json', historyReports);
  const details = r => ({ ...history, pointer: `/${r.visit - 1}` });
  const own = packages.get(visit.taskId);
  const task = own?.data ?? { requirements: definition.task };
  const reports = latestReports(allReports.filter(r => r.result || r.error));
  const handoffReport = previous && historyReports.findLast(r => r.result === previous);
  // Immediate assignments and checking feedback are addressed by the graph,
  // not by equality of the sender's task binding. A manager contributes only
  // its concrete summary; checking reports retain their findings/questions.
  const checkingHandoff = ['reviewer', 'verifier'].includes(handoffReport?.role);
  const crossTaskHandoff = handoffReport?.role === 'orchestrator' || checkingHandoff;
  const handoff = handoffReport?.taskId && handoffReport.taskId !== visit.taskId && !crossTaskHandoff ? undefined :
    crossTaskHandoff ? (checkingHandoff ? previous : { outcome: previous.outcome, summary: previous.summary }) :
      handoffReport?.role === 'group' ? scopedPrevious(previous, visit.taskId) :
        handoffReport ? { reportVisit: handoffReport.visit, details: details(handoffReport) } : scopedPrevious(previous, visit.taskId);
  const handoffSource = handoffReport && { node: handoffReport.node, participant: handoffReport.participant,
    role: handoffReport.role, revision: handoffReport.revision, taskId: handoffReport.taskId,
    taskVersion: handoffReport.taskVersion, details: details(handoffReport) };
  const related = reports.filter(r => visit.taskId ? r.taskId === visit.taskId : !r.taskId)
    .map(r => r.role === 'orchestrator' ? { ...r, result: { outcome: r.result?.outcome, summary: r.result?.summary }, details: details(r) } : r);
  const context = { formatVersion: 1, runId: state.id, inputId: visit.inputId, role: node.role, node: visit.node, participant: visit.participant ?? visit.node,
    candidate: visit.revision,
    ...(visit.review ? { review: { ...visit.review, purpose: 'Complete candidate diff relative to the workflow base' } } : {}),
    assignment: { ...(node.instructions ? { instructions: node.instructions } : {}),
      ...(visit.item ? { item: visit.item } : {}), ...(steering ? { steering: { id: steering.id, text: steering.text } } : {}) },
    sources: { originalInput: source, assignment: { ...source, pointer: `/definition/nodes/${visit.node}` }, ...(state.inputSnapshot?.source ? { importedFrom: state.inputSnapshot.source } : {}),
      ...(own ? { task: own.details, requirementsPointer: '/requirements' } :
        { task: source, requirementsPointer: '/definition/task' }) },
    task,
    ...(!own && node.role !== 'orchestrator' ? { taskScope: { kind: 'workflow',
      reason: 'No taskId is bound. The original workflow requirements and this assignment apply; no package is inferred.' } } : {}),
  };
  if (node.role === 'orchestrator') {
    context.control = workflowControlContext(definition, visit.node, state.visits, visit.revision);
    context.catalog = [...packages.values()].map(({ data, details }) => {
      const results = reports.filter(r => r.taskId === data.id);
      return { id: data.id, ...(data.beadsId ? { beadsId: data.beadsId } : {}), version: data.version,
        dependencies: data.dependencies, status: results.at(-1)?.result?.outcome ?? (results.at(-1)?.error ? 'failed' :
          allReports.some(r => r.taskId === data.id) ? 'running' : 'not_started'),
        decisions: data.decisions, revisions: data.revisions, results, details };
    });
    context.groupResults = latestReports(historyReports.filter(r => r.role === 'group')).map(r => {
      const { results, ...envelope } = r.result ?? {};
      return { ...r, ...(r.result ? { result: envelope } : {}), details: details(r) };
    });
    context.questions = [...context.groupResults.filter(r => r.error || r.result?.outcome === 'failed'), ...reports.filter(r => r.error || r.result?.outcome === 'blocked')];
    context.results = reports.filter(r => !r.taskId);
    context.history = history;
    // A bound manager still needs the catalog, not a second full package copy.
    if (definition.taskPackages) delete context.task;
  } else {
    context.otherReports = { evidence: 'Reported by other participants; not independent verification by this participant',
      results: related.filter(r => !(['reviewer', 'verifier'].includes(node.role) &&
        ['reviewer', 'verifier'].includes(r.role) && r.result?.outcome === 'changes')), ...(handoff ? { handoff,
        ...(handoffSource ? { handoffSource } : {}) } : {}) };
    if (node.role === 'reviewer' || node.role === 'verifier') {
      context.priorFindings = allReports.filter(r => r.taskId === visit.taskId && ['reviewer', 'verifier'].includes(r.role) && r.result?.outcome === 'changes');
    }
    if (node.role === 'verifier') context.scenarios = { ...(own ? { criteria: '/task/acceptanceCriteria' } : {}),
      requirements: '/task/requirements', assignment: '/assignment',
      note: own ? 'Check these exact criteria and any scenarios in the assignment; otherReports are not your checks' :
        'No separately structured criteria were supplied. Check the exact workflow requirements and assignment; otherReports are not your checks' };
    context.dependencies = (task?.dependencies ?? []).map(id => ({ id, details: packages.get(id).details }));
    context.artifacts = (task?.artifacts ?? []).map(artifact => artifactLink(artifact, workspace, tools));
  }
  visit.taskContext = context;
  visit.contextDirectory = directory;
  visit.prompt = rolePrompt(definition, visit.node, previous, visit.revision, state.visits,
    Boolean(state.roleAgents || state.participants), visit.review, workspace, transitionSource, context);
}
