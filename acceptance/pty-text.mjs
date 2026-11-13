import { stripVTControlCharacters } from 'node:util';

// Observation helper for the ASCII session labels in the native TUI smoke test,
// not a terminal emulator. The renderer may split even a word across rows, with
// ANSI cursor positioning, padding and a vertical pane border between fragments.
// Ignore only that presentation; preserve all other characters and their order.
function labelText(value) {
  return stripVTControlCharacters(value).replace(/[\s│┃]/gu, '');
}

export function ptyTextIncludes(output, text) {
  return labelText(output).includes(labelText(text));
}
