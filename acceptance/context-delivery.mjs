import { readFileSync } from 'node:fs';

export const wireContext = prompt => JSON.parse(prompt.match(/^Task\/context data:\n(.*)$/m)[1]);
// Existing controlled-model scenarios reason about current state, not transport
// encoding. Resolve the exact pinned snapshot for those fixtures. Delivery tests
// inspect wireContext separately and exercise native reads of the fallback.
export function currentContext(prompt) {
  const data = wireContext(prompt);
  return data.delivery?.mode === 'delta' ? JSON.parse(readFileSync(data.delivery.snapshot.path, 'utf8')) : data;
}
