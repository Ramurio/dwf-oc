import { mkdirSync } from 'node:fs';

mkdirSync('acceptance-results/opencode', { recursive: true });

export default {
  paths: ['acceptance/features/*.feature'],
  import: ['acceptance/steps.mjs'],
  format: ['progress'],
  parallel: 0,
  strict: true,
};
