import assert from 'node:assert/strict';
import test from 'node:test';
import { ptyTextIncludes } from './pty-text.mjs';

const title = 'Controlled verification worktree session';

test('PTY labels match plain text and ANSI styling within words', () => {
  assert(ptyTextIncludes(title, title));
  assert(ptyTextIncludes('DWF \x1b[32mreviewer\x1b[0m mapped_\x1b[1mchecker\x1b[0m', 'DWF reviewer mapped_checker'));
});

test('PTY labels tolerate CRLF wrapping, indentation and vertical pane borders', () => {
  assert(ptyTextIncludes('Controlled veri\x1b[0m\r\n  ┃  \x1b[32mfication worktree\x1b[0m\n │ session', title));
  assert(ptyTextIncludes('verification_with_\r\n   private_snapshot', 'verification_with_private_snapshot'));
});

test('PTY labels tolerate cursor-positioned native TUI wrapping without a newline', () => {
  // The native renderer writes the content, padding, next-row border and content
  // using absolute cursor positions rather than emitting a literal newline.
  const output = '\x1b[7;6H\x1b[38;2;238;238;238mControlled verification '
    + '\x1b[0m\x1b[7;99H                                          '
    + '\x1b[8;3H\x1b[38;2;92;156;245m┃\x1b[0m\x1b[8;6Hworktree session';
  assert(ptyTextIncludes(output, title));
});

test('PTY label matching still rejects absent, incomplete, altered and reordered labels', () => {
  for (const output of [
    '', 'Controlled verification worktree', 'Controlled validation worktree session',
    'Controlled verification session worktree', 'Controlled verification worktree OTHER session',
  ]) assert.equal(ptyTextIncludes(output, title), false, output);
  assert.equal(ptyTextIncludes('DWF reviewer another_checker', 'DWF reviewer mapped_checker'), false);
  assert.equal(ptyTextIncludes('verification_with_public_snapshot', 'verification_with_private_snapshot'), false);
});
