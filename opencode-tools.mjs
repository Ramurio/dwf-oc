// DWF sessions expose the public role tools. OpenCode's own tools and user
// plugins can share their permission actions, such as worktree removal using
// "edit", so the permission rules alone do not define this tool catalogue.
const tools = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch', 'shell', 'edit', 'write', 'skill']);
const participant = /^dwf-(worker|reviewer|verifier|orchestrator|planner|scientist|scout|researcher|committee)-[a-f0-9]{16}$/;

export default {
  id: 'dwf.role-tools',
  async setup(context) {
    await context.session.hook('context', event => {
      if (!participant.test(event.agent)) return;
      for (const name of Object.keys(event.tools)) {
        if (!tools.has(name)) delete event.tools[name];
      }
    });
  },
};
