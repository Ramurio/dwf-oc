import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const roleSkills = Object.fromEntries(Object.entries({
  worker: ['code-work'],
  reviewer: ['code-review'],
  verifier: ['code-verify'],
  orchestrator: ['workflow-summary'],
  planner: ['task-planning'],
}).map(([role, names]) => [role, names.map(name => {
  const file = fileURLToPath(new URL(`./skills/${role}/${name}/SKILL.md`, import.meta.url));
  const content = readFileSync(file, 'utf8');
  return { name, content, body: content.replace(/^---\n[\s\S]*?\n---\n/, '').trim(),
    id: `dwf-${name}-${createHash('sha256').update(content).digest('hex').slice(0, 16)}` };
})]));

export const bundledSkills = Object.values(roleSkills).flat();
