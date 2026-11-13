import { implementNodeIds } from './implement-definition.mjs';
import { publicImplements } from './workflow-implements.mjs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode, isSessionNotFoundError } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { savedRuns, saveOutcome } from './run-store.mjs';
import { readExecution, OPENCODE_VERSION } from './opencode-runtime.mjs';
import { bundledSkills } from './role-skills.mjs';

const executable = fileURLToPath(new URL('./node_modules/.bin/opencode', import.meta.url));
const quote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const unknown = 'Not recorded';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'OPENCODE_CONFIG_DIR', 'OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_TEST_HOME'];

function resultProjection(source) {
  let value = source;
  if (typeof source === 'string') {
    // Old planner results can contain serialized DWF envelopes. Ordinary prose
    // and arbitrary old JSON strings remain verbatim, not guessed summaries.
    try {
      const parsed = JSON.parse(source);
      if (object(parsed) && typeof parsed.summary === 'string') value = parsed;
    } catch { /* Plain text is a valid legacy result. */ }
  }
  let result = '';
  let resultDetails = [];
  if (object(value) && typeof value.summary === 'string') {
    result = value.summary;
    resultDetails = Object.entries(value)
      .filter(([key]) => !['summary', 'outcome'].includes(key))
      .map(([key, item]) => ({
        label: key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()),
        value: item,
      }));
  } else if (value !== null && typeof value === 'object') {
    result = 'Saved result details';
    resultDetails = [{ label: 'Details', value }];
  } else if (value != null) {
    result = String(value);
  }
  // Keep the exact saved value, including legacy strings, for explicit inspection.
  return { result, resultDetails, resultRaw: source ?? null };
}

export function sessionCommand(root, profile, session) {
  if (!session) return null;
  // OpenCode 2.2.5 resumes an existing session in its native current directory.
  // Do not pass a historical call directory as though it were an override.
  // Entry never moves or forks the session and never submits a prompt.
  // Runs without a saved profile belong to the original isolated DWF service.
  const env = profile && profile !== 'legacy' ? profile.env : {
    OPENCODE_DB: join(root, 'opencode', 'opencode.sqlite'),
    XDG_STATE_HOME: join(root, 'opencode', 'state'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode', 'config'),
    XDG_DATA_HOME: join(root, 'opencode', 'data'),
    XDG_CACHE_HOME: join(root, 'opencode', 'cache'),
    XDG_CONFIG_HOME: join(root, 'opencode', 'xdg-config'),
  };
  if (!env) return null;
  const unset = ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_SERVER', ...envKeys].map(key => '-u ' + key).join(' ');
  const assignments = Object.entries(env).filter(([key]) => envKeys.includes(key))
    .map(([key, value]) => `${key}=${quote(value)}`).join(' ');
  return `env ${unset} ${assignments} ${quote(executable)} --session ${quote(session)}`;
}

function callView(state, visit, location, { root, owned }) {
  // Count acknowledged or observed calls, not merely prepared inputs or the
  // send-intent boundary (which can precede a stop or lost acknowledgement).
  if (!(visit.admitted || visit.verdict || visit.progress || visit.correction)) return null;
  const settings = state.participants?.[visit.node];
  const model = settings?.model ?? state.model;
  const permissions = settings?.agent?.permissions ?? state.rolePermissions?.[state.definition.nodes[visit.node]?.role];
  const skillIds = permissions?.filter(rule => rule.action === 'skill' && rule.effect === 'allow').map(rule => rule.resource);
  const directory = visit.workspace?.path ?? state.workspace?.path;
  let status = 'unknown';
  if (visit.error) status = 'failed';
  else if (visit.verdict) status = 'done';
  else if (state.status === 'cancelled' || state.executionStopped) status = 'cancelled';
  else if (state.status === 'running' && owned && !state.service) status = 'active';
  return {
    id: visit.inputId ?? `${visit.sessionId}/${visit.startedAt ?? ''}`,
    time: visit.startedAt ? new Date(visit.startedAt).toISOString() : 'Time not recorded',
    session: visit.sessionId ?? null,
    callDirectory: directory ?? null,
    sessionDirectory: null,
    lastObservedDirectory: null,
    location,
    task: visit.taskContext ? (visit.taskContext.task?.requirements ||
      visit.taskContext.assignment?.instructions || '') : visit.prompt ?? unknown,
    taskSource: visit.taskContext ? 'structured' : 'raw-only',
    // taskData is the exact logical snapshot; promptRaw may carry only its delta.
    taskData: visit.taskContext ?? null,
    ...(visit.delivery ? { contextDelivery: visit.delivery } : {}),
    assignment: visit.taskContext?.assignment ?? null,
    handoff: visit.taskContext?.otherReports?.handoff ?? null,
    problem: visit.error ? (typeof visit.error === 'string' ? visit.error : visit.error.message ?? resultProjection(visit.error).result) :
      ['blocked', 'changes', 'failed'].includes(visit.verdict?.outcome) ? visit.verdict.summary : null,
    outcome: visit.verdict?.outcome ?? null,
    cycle: visit.cycle ?? visit.taskContext?.implement?.cycle ?? null,
    taskId: visit.taskId ?? null, taskVersion: visit.taskVersion ?? null,
    promptRaw: visit.prompt ?? null,
    ...resultProjection(visit.verdict ?? visit.error),
    state: status,
    model: model ? `${model.providerID}/${model.id}` : unknown,
    reasoning: model?.variant ?? 'Not recorded / unset',
    speed: unknown,
    skills: skillIds ?? [],
    skillsKnown: Boolean(permissions),
    command: sessionCommand(root, state.opencode, visit.sessionId),
    skillDescriptions: Object.fromEntries((skillIds ?? []).map(id => [id,
      bundledSkills.find(skill => skill.id === id)?.content ?? 'Saved skill version is not bundled here.'])),
    progress: visit.progress?.message ?? null,
  };
}

export function workflowView(state, { root, owned = false, order = 0 } = {}) {
  const def = state.definition;
  const visits = state.visits ?? [];
  const groups = def.groups ?? {};
  const flat = visits.flatMap(visit => (visit.children ?? [visit])
    .map(child => ({ visit: child, location: child.implementId ? 'implements' : visit.node })));

  const lastDirectories = new Map();
  for (const { visit } of flat) {
    if (visit.sessionId && (visit.admitted || visit.verdict || visit.progress || visit.correction)) {
      const directory = visit.workspace?.path ?? state.workspace?.path;
      if (directory) lastDirectories.set(visit.sessionId, directory);
    }
  }

  function person(id, node, name = id, platform = node) {
    const invocations = flat.filter(({ visit }) => (visit.participant ?? visit.node) === id && visit.node === node)
      .flatMap(({ visit, location }) => {
        const first = callView(state, visit, location, { root, owned });
        if (!first) return [];
        first.lastObservedDirectory = lastDirectories.get(first.session) ?? null;
        if (!visit.correction) return [first];
        const correction = callView(state, {
          ...visit, correction: undefined, inputId: visit.correction.inputId,
          prompt: visit.correction.prompt, taskContext: undefined, delivery: undefined, startedAt: undefined,
        }, location, { root, owned });
        if (correction) correction.lastObservedDirectory = first.lastObservedDirectory;
        return [{
          ...first, state: 'done', result: 'Original reply required correction; its text was not saved.',
          resultDetails: [], resultRaw: null, outcome: null, problem: null, progress: null,
        }, ...(correction ? [correction] : [])];
      });
    const latest = invocations.at(-1);
    const local = invocations.findLast(call => call.location === platform);
    const active = latest?.state === 'active' && latest.location === platform;
    // History is shared across standalone/group visits. A platform's status is
    // not: an unvisited group must not inherit a standalone call's activity.
    const currentState = local?.state === 'active' && !active ? 'unknown' : local?.state ?? null;
    return {
      id, name, role: def.nodes[node]?.role ?? unknown,
      memory: state.participants?.[node]?.memory ?? null,
      invocations, active, currentState,
    };
  }

  // Child templates live inside their group. Only independently addressable
  // nodes also get a platform; the child's own transition is not executed by a group.
  const reachable = new Set();
  function walk(id) {
    if (reachable.has(id) || id == null) return;
    reachable.add(id);
    for (const to of Object.values(def.transitions[id] ?? {})) walk(to);
  }
  walk(def.entry);
  for (const visit of visits) {
    if (!visit.children && !visit.implementId) walk(visit.node);
  }
  const templates = implementNodeIds(def);
  const ids = [...Object.keys(def.nodes).filter(id => !templates.has(id)), ...Object.keys(groups),
    ...(def.implements ? ['implements'] : [])].filter(id => reachable.has(id));
  const nodes = ids.map(id => {
    if (id === 'implements' && def.implements) return { id, label: 'Implement tasks', role: 'implement cycles', group: 'implements',
      instances: publicImplements(state).instances, concurrency: def.implements.concurrency, participants: Object.entries(def.implements.instances).flatMap(([instanceId, config]) =>
        ['worker', 'reviewer', 'verifier'].map(role => ({ ...person(`${instanceId}/${role}`, config[role], `${instanceId}/${role}`, 'implements'), showRole: true }))) };
    if (!Object.hasOwn(groups, id)) {
      // A steered data-driven member can execute outside its group while
      // retaining its mapped identity. Put the latest standalone identity first
      // for the primitive card, and keep every observed identity in its history.
      const standalone = visits.filter(visit => !visit.children && visit.node === id)
        .map(visit => visit.participant ?? id).reverse();
      const participants = [...new Set(standalone.length ? standalone : [id])]
        .map(participant => person(participant, id));
      return { id, label: id, role: def.nodes[id]?.role ?? unknown, participants };
    }
    const group = groups[id];
    const members = new Map((group.members ?? []).map(node => [node, { node, name: node }]));
    for (const item of group.items ?? []) {
      members.set(`${id}/${item.id}`, { node: group.member, name: item.id });
    }
    for (const visit of visits.filter(visit => visit.node === id)) {
      for (const child of visit.children ?? []) {
        members.set(child.participant ?? child.node, {
          node: child.node, name: child.item?.id ?? child.participant ?? child.node,
        });
      }
    }
    const people = [...members].map(([participant, item]) => ({
      ...person(participant, item.node, item.name, id), showRole: true,
    }));
    const roles = [...new Set((group.members ?? [group.member]).map(node => def.nodes[node]?.role))];
    return {
      id, label: id, role: roles.length > 1 ? 'mixed roles' : roles[0],
      group: group.members ? 'fixed' : 'data-driven', participants: people,
    };
  });

  let terminal = '@terminal';
  while (ids.includes(terminal)) terminal += '@';
  const edgePairs = new Map();
  for (const from of ids) {
    for (const [outcome, target] of Object.entries(def.transitions[from] ?? {})) {
      const to = target ?? terminal;
      const key = JSON.stringify([from, to]);
      if (!edgePairs.has(key)) {
        edgePairs.set(key, { id: key, from, to, label: outcome, kind: 'control' });
      } else {
        edgePairs.get(key).label += `, ${outcome}`;
      }
    }
  }
  const edges = [...edgePairs.values()];
  if (edges.some(edge => edge.to === terminal)) {
    nodes.push({ id: terminal, label: 'End', role: 'terminal', participants: [] });
  }
  // Deterministic DFS marks feedback edges for any cycle, irrespective of names
  // or role. Removing back edges leaves a DAG for the Lines layered renderer.
  const color = new Map();
  function classify(id) {
    color.set(id, 1);
    for (const edge of edges.filter(edge => edge.from === id)) {
      if (color.get(edge.to) === 1) {
        edge.reentry = true;
        if (Object.hasOwn(groups, edge.from) && edge.to !== edge.from) edge.kind = 'result';
      } else if (!color.has(edge.to)) {
        classify(edge.to);
      }
    }
    color.set(id, 2);
  }
  classify(def.entry);
  for (const node of nodes) {
    if (!color.has(node.id)) classify(node.id);
  }
  let description = '';
  if (state.status === 'running') {
    if (!owned) description = 'Saved running · controller not confirmed (resume with dwf inspect)';
    else if (state.pendingFailure) description = 'Stopping after controller failure · execution stop not yet confirmed';
    else description = state.service ? 'Running · OpenCode connection unavailable' : 'Running';
  }
  return {
    id: state.id,
    project: state.workspace?.source ?? state.workspace?.path ?? 'Directory not recorded',
    projectName: basename(state.workspace?.source ?? state.workspace?.path ?? '') || 'Unknown project',
    title: def.task.trim().split('\n')[0].slice(0, 140),
    task: def.task,
    ...resultProjection(state.result ?? state.error),
    status: state.status,
    createdAt: state.createdAt ?? visits.find(visit => visit.startedAt)?.startedAt ?? null,
    order, description, graph: { nodes, edges },
    ...(def.implements ? { implements: publicImplements(state) } : {}),
  };
}

export function plannerView(run, root, observation = {}) {
  const directory = run.request.session?.location?.directory;
  const state = {
    id: run.id,
    definition: { task: run.request.text ?? unknown, nodes: { planner: { role: 'planner' } },
      entry: 'planner', transitions: { planner: { done: null } } },
    workspace: { source: directory, path: directory },
    status: run.status, opencode: run.request.opencode, createdAt: run.request.createdAt,
    model: run.request.session?.model,
    participants: { planner: { agent: { permissions: run.request.session?.permissions } } },
    visits: [{
      node: 'planner', participant: 'planner', sessionId: run.sessionId, inputId: run.inputId, admitted: run.admitted,
      prompt: run.request.text,
      ...(run.status === 'succeeded' ? { verdict: run.result } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...observation,
    }],
    result: run.result, error: run.error,
  };
  const view = workflowView(state, { root, order: run.order, owned: observation.available });
  if (run.status === 'running') {
    view.description = observation.available ? 'Running' : 'Saved running · OpenCode connection unavailable';
  }
  return view;
}

export async function readUiRuns(root) {
  let saved = savedRuns(root);
  const observations = new Map();
  const clients = new Map();
  function existingClient(profile) {
    const file = profile?.registration ?? join(root, 'opencode', 'state', 'opencode', 'service.json');
    if (!clients.has(file)) {
      clients.set(file, (async () => {
        const endpoint = await Service.discover({ file, version: OPENCODE_VERSION });
        if (!endpoint) return null;
        return OpenCode.make({
          baseUrl: endpoint.url, headers: Service.headers(endpoint),
          fetch: (input, init = {}) => fetch(input, {
            ...init, signal: AbortSignal.any([AbortSignal.timeout(2500), ...(init.signal ? [init.signal] : [])]),
          }),
        });
      })().catch(() => null));
    }
    return clients.get(file);
  }
  // Old planner runs have no controller. Read their existing service, never
  // ensure/start it, admit inputs, or restart workflow controllers from the UI.
  await Promise.all(saved.runs.filter(run => run.status === 'running').map(async run => {
    try {
      const client = await existingClient(run.request.opencode);
      if (!client) return;
      const session = await client.session.get({ sessionID: run.sessionId });
      if (session.metadata?.dwfRunId !== run.id) return;
      const execution = await readExecution(client, run);
      observations.set(run.id, { available: true, progress: execution.progress });
      if (execution.outcome) saveOutcome(root, run.id, execution.outcome);
    } catch { /* A connection loss is not a failed run. Keep the saved facts. */ }
  }));
  saved = savedRuns(root);
  const runs = [
    ...saved.workflows.map(row => workflowView(row.state, { root, ...row })),
    ...saved.runs.map(run => plannerView(run, root, observations.get(run.id))),
  ];
  const profiles = new Map([
    ...saved.workflows.map(row => [row.state.id, row.state.opencode]),
    ...saved.runs.map(run => [run.id, run.request.opencode]),
  ]);
  // Read the existing native session location, never ensure a service, move a
  // session or infer its actual current directory from historical worktrees.
  await Promise.all(runs.map(async run => {
    const client = await existingClient(profiles.get(run.id));
    if (!client) return;
    const calls = run.graph.nodes.flatMap(node => node.participants.flatMap(person => person.invocations));
    const sessions = new Map();
    for (const call of calls) {
      if (!call.session) continue;
      if (!sessions.has(call.session)) sessions.set(call.session, []);
      sessions.get(call.session).push(call);
    }
    await Promise.all([...sessions].map(async ([sessionID, history]) => {
      try {
        const session = await client.session.get({ sessionID });
        if (session.metadata?.dwfRunId !== run.id) return;
        for (const call of history) call.sessionDirectory = session.location?.directory ?? null;
      } catch (error) {
        if (isSessionNotFoundError(error)) {
          for (const call of history) {
            call.command = null;
            call.sessionUnavailable = true;
          }
        }
        // A service/network failure leaves current location explicitly unknown.
      }
    }));
  }));
  runs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.order - a.order || a.id.localeCompare(b.id));
  return { runs };
}
