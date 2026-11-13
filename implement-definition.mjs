// Public shape validation kept independent from execution/context assembly.
export const implementRoles = ['worker', 'reviewer', 'verifier'];
export const implementNodeIds = definition => new Set(Object.values(definition.implements?.instances ?? {})
  .flatMap(instance => implementRoles.map(role => instance[role])));

export function validateImplements(definition, reject) {
  const config = definition.implements;
  if (config === undefined) return;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
  if (!object(config) || Object.keys(config).some(key => !['concurrency', 'instances'].includes(key)) ||
    !Number.isSafeInteger(config.concurrency) || config.concurrency < 1 ||
    !object(config.instances) || !Object.keys(config.instances).length) reject('implements требует явные concurrency и instances.');
  if (definition.workspace === 'directory' || definition.nodes.implements || definition.groups?.implements) reject('implements требует отдельный worktree и свободное имя implements.');
  const tasks = new Set();
  for (const [id, instance] of Object.entries(config.instances)) {
    if (!identifier(id) || Object.hasOwn(definition.nodes, id) || Object.hasOwn(definition.groups ?? {}, id) || !object(instance) ||
      Object.keys(instance).some(key => !['taskId', ...implementRoles].includes(key)) ||
      !definition.taskPackages?.some(task => task.id === instance.taskId) || tasks.has(instance.taskId)) reject('неверный implement ' + id);
    tasks.add(instance.taskId);
    const routes = definition.transitions;
    if (routes[instance.worker]?.done !== instance.reviewer || routes[instance.reviewer]?.approve !== instance.verifier ||
      routes[instance.reviewer]?.changes !== instance.worker || routes[instance.verifier]?.changes !== instance.worker) reject('переходы implement должны сохранять цикл worker ↔ reviewer → verifier.');
    for (const role of implementRoles) {
      const node = definition.nodes[instance[role]];
      if (node?.role !== role || node.required === false || (node.memory ?? definition.roles?.[role]?.memory) === false ||
        (node.taskId !== undefined && node.taskId !== instance.taskId)) reject('неверная роль implement ' + id + '.' + role);
    }
  }
  for (const task of definition.taskPackages.filter(task => tasks.has(task.id))) {
    if (task.dependencies.some(id => !tasks.has(id))) reject('зависимость implement требует экземпляр с этим taskId.');
  }
  const templates = implementNodeIds(definition);
  if (!['reviewer', 'verifier'].every(role => Object.entries(definition.nodes).some(([id, node]) =>
    !templates.has(id) && node.role === role && node.required !== false))) reject('implements требует отдельные reviewer и verifier общего результата.');
  if (definition.nodes[definition.transitions.implements?.done]?.role !== 'orchestrator') reject('implements.done должен возвращаться к orchestrator.');
  if (definition.entry === 'implements' || templates.has(definition.entry)) reject('implements допускается поручением orchestrator.');
  for (const [id, routes] of Object.entries(definition.transitions)) {
    if (!templates.has(id) && Object.values(routes).some(target => templates.has(target))) reject('роли implement не являются отдельными этапами общего графа.');
    if (Object.values(routes).includes('implements') && definition.nodes[id]?.role !== 'orchestrator') reject('implements допускается только orchestrator.');
  }
  for (const group of Object.values(definition.groups ?? {})) {
    if ((group.members ?? [group.member]).some(id => templates.has(id))) reject('роли implement не входят в groups.');
  }
}

export function implementApprovalProblems(state) {
  return Object.keys(state.definition.implements?.instances ?? {}).flatMap(id => {
    const instance = state.implements?.instances[id];
    return instance?.status === 'integrated' ? [] : [`Для завершения implement ${id} должен быть проверен и объединён.`];
  });
}
