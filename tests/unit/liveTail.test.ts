import { describe, expect, it } from 'vitest';
import {
  createLiveTailBuffer,
  lastContentLineFromScrollback,
  parseColsFromScrollback,
  stripAnsiPreservingLayout,
} from '@/terminal/liveTail';

describe('lastContentLineFromScrollback', () => {
  it('returns the boxed content line, skipping borders, spinner status, and context bars', () => {
    const frame =
      '\x1b[H\x1b[2J' +
      '/ Working (12s · esc to interrupt)\n' +
      '╭────────╮\n' +
      '│ Refactoring src/billing/invoice.ts │\n' +
      '╰────────╯\n' +
      'Codex CLI · GPT-5 Codex · high · ↑8.2k ↓420\n';
    expect(lastContentLineFromScrollback(frame)).toBe('Refactoring src/billing/invoice.ts');
  });

  it('returns plain shell output untouched', () => {
    expect(lastContentLineFromScrollback('$ npm run typecheck\n> tsc --noEmit\n')).toBe('> tsc --noEmit');
  });

  it('returns null for chrome-only frames', () => {
    expect(lastContentLineFromScrollback('───\n| Working (3s · esc to interrupt)\n')).toBeNull();
  });

  it('skips separator rules from the wider dash family (recorded feed-card artifact)', () => {
    // Seen live 2026-07-20: the Agents-feed snippet rendered as literal
    // horizontal lines because a TUI separator line survived the chrome
    // filter. Em-dash, horizontal-bar, double-line, and underscore runs
    // are all chrome.
    const frame = 'The real last message.\n——————————————\n⎯⎯⎯⎯⎯⎯⎯⎯ ⎯⎯⎯⎯⎯⎯ …\n═══════════\n____________\n';
    expect(lastContentLineFromScrollback(frame)).toBe('The real last message.');
  });
});

describe('createLiveTailBuffer - line-identity emulation', () => {
  it('accumulates plain text lines split by newlines', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('first line\nsecond line\nthird line');
    expect(buffer.snapshotLines()).toEqual(['first line', 'second line', 'third line']);
  });

  it('overwrites the current line after a carriage return (spinner redraw)', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('Working 1s');
    buffer.append('\rWorking 2s');
    buffer.append('\rWorking 3s');
    expect(buffer.snapshotLines()).toEqual(['Working 3s']);
  });

  it('handles the \\r + EL redraw idiom where the new text is shorter', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('Working on it 22s');
    buffer.append('\r\x1b[KDone');
    expect(buffer.snapshotLines()).toEqual(['Done']);
  });

  it('overwrites from an absolute column after CHA', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('Progress: 10%');
    buffer.append('\x1b[11G95%');
    expect(buffer.snapshotLines()).toEqual(['Progress: 95%']);
  });

  it('truncates the current line at the cursor on EL', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('hello world');
    buffer.append('\x1b[6G\x1b[K');
    expect(buffer.snapshotLines()).toEqual(['hello']);
  });

  it('moves the cursor left on backspace so following text overwrites', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('count: 1');
    buffer.append('\x082!');
    expect(buffer.snapshotLines()).toEqual(['count: 2!']);
  });

  it('strips SGR color sequences entirely', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('\x1b[1;32mgreen\x1b[0m and plain');
    expect(buffer.snapshotLines()).toEqual(['green and plain']);
  });

  it('strips BEL-terminated and ST-terminated OSC sequences', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('\x1b]0;window title\x07visible');
    buffer.append('\nnext \x1b]8;;https://example.com\x1b\\line');
    expect(buffer.snapshotLines()).toEqual(['visible', 'next line']);
  });

  it('strips unknown-but-parseable CSI sequences', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('kept\x1b[?25l\x1b[3d text');
    expect(buffer.snapshotLines()).toEqual(['kept text']);
  });

  it('survives an SGR sequence split across two append calls', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('abc\x1b[3');
    buffer.append('1mdef\x1b[0m');
    expect(buffer.snapshotLines()).toEqual(['abcdef']);
  });

  it('survives an OSC sequence split across two append calls', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('\x1b]0;win');
    buffer.append('dow title\x07shown');
    expect(buffer.snapshotLines()).toEqual(['shown']);
  });

  it('survives a bare ESC at the end of a chunk', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('stale line\r\x1b');
    buffer.append('[Kredrawn');
    expect(buffer.snapshotLines()).toEqual(['redrawn']);
  });

  it('revisits a buffered line with CUU, keeping the column', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('aaaa\nbbbb\ncccc');
    buffer.append('\x1b[2A\rAAAA');
    expect(buffer.snapshotLines()).toEqual(['AAAA', 'bbbb', 'cccc']);
  });

  it('moves back down with CUD and clamps CUU at the top edge', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('aaaa\nbbbb\ncccc');
    buffer.append('\x1b[99A\rTOP ');
    buffer.append('\x1b[1B\rMID ');
    expect(buffer.snapshotLines()).toEqual(['TOP ', 'MID ', 'cccc']);
  });

  it('resets the buffer on alternate-screen enter and exit', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('main screen text\x1b[?1049h');
    expect(buffer.snapshotLines()).toEqual([]);
    buffer.append('alt screen ui');
    buffer.append('\x1b[?1049l');
    expect(buffer.snapshotLines()).toEqual([]);
    buffer.append('back on main');
    expect(buffer.snapshotLines()).toEqual(['back on main']);
  });

  it('resets the buffer on the legacy 47 alternate-screen switch', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('before\x1b[?47hafter');
    expect(buffer.snapshotLines()).toEqual(['after']);
  });

  it('resets the buffer on erase-display 2J and 3J', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('old content\x1b[2Jfresh');
    expect(buffer.snapshotLines()).toEqual(['fresh']);
    buffer.append('\x1b[3J');
    expect(buffer.snapshotLines()).toEqual([]);
  });

  it('resets the buffer on CUP home (full-screen repaint)', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('scrolled output\x1b[H');
    expect(buffer.snapshotLines()).toEqual([]);
    buffer.append('repainted');
    expect(buffer.snapshotLines()).toEqual(['repainted']);

    const rowColumnBuffer = createLiveTailBuffer();
    rowColumnBuffer.append('text\x1b[12;40Hmore');
    expect(rowColumnBuffer.snapshotLines()).toEqual(['more']);
  });

  it('reset() clears buffered lines and any partial escape state', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('something\x1b[3');
    buffer.reset();
    buffer.append('1mplain');
    // The dangling CSI prefix was discarded, so '1mplain' is literal text.
    expect(buffer.snapshotLines()).toEqual(['1mplain']);
  });
});

describe('createLiveTailBuffer - chrome filtering and capping', () => {
  it('drops box-drawing frame lines but keeps content-heavy lines', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('╭──────────────╮\n');
    buffer.append('│ actual reply text here │\n');
    buffer.append('╰──────────────╯\n');
    buffer.append('plain output');
    expect(buffer.snapshotLines()).toEqual(['│ actual reply text here │', 'plain output']);
  });

  it('drops blank lines, braille spinner lines, and star/dot status lines', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('real line one\n');
    buffer.append('   \n');
    buffer.append('⠧ Pondering (3s)\n');
    buffer.append('✳ Compacting conversation\n');
    buffer.append('· waiting\n');
    buffer.append('real line two');
    expect(buffer.snapshotLines()).toEqual(['real line one', 'real line two']);
  });

  it('drops lines containing "esc to interrupt" case-insensitively', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('output\n');
    buffer.append('Press Esc To Interrupt the run\n');
    buffer.append('more output');
    expect(buffer.snapshotLines()).toEqual(['output', 'more output']);
  });

  it('drops spinner-ish token-status lines but keeps token counts in prose', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('✻ Churning (523 tokens)\n');
    buffer.append('Used 523 tokens so far');
    expect(buffer.snapshotLines()).toEqual(['Used 523 tokens so far']);
  });

  it('preserves interior whitespace of kept lines', () => {
    const buffer = createLiveTailBuffer();
    buffer.append('  indented   and   spaced  ');
    expect(buffer.snapshotLines()).toEqual(['  indented   and   spaced  ']);
  });

  it('caps the snapshot at maxLines, returning the LAST lines', () => {
    const buffer = createLiveTailBuffer({ maxLines: 3 });
    for (let lineNumber = 1; lineNumber <= 10; lineNumber++) {
      buffer.append(`line ${lineNumber}\n`);
    }
    expect(buffer.snapshotLines()).toEqual(['line 8', 'line 9', 'line 10']);
  });

  it('keeps working past the internal virtual-line ring cap', () => {
    const buffer = createLiveTailBuffer({ maxLines: 2 });
    for (let lineNumber = 1; lineNumber <= 50; lineNumber++) {
      buffer.append(`line ${lineNumber}\n`);
    }
    expect(buffer.snapshotLines()).toEqual(['line 49', 'line 50']);
  });
});

describe('stripAnsiPreservingLayout', () => {
  it('strips SGR, OSC, and CSI while keeping newlines and text', () => {
    const stripped = stripAnsiPreservingLayout(
      '\x1b]0;title\x07\x1b[1;31mred\x1b[0m line\n\x1b[2Ksecond\r\n',
    );
    expect(stripped).toBe('red line\nsecond\n');
  });

  it('passes plain text through untouched', () => {
    expect(stripAnsiPreservingLayout('plain\ntext')).toBe('plain\ntext');
  });
});

describe('parseColsFromScrollback', () => {
  it('returns 80 for empty input', () => {
    expect(parseColsFromScrollback('')).toBe(80);
  });

  it('returns 80 for degenerate ANSI-only input', () => {
    expect(parseColsFromScrollback('\x1b[31m\x1b[0m\n\x1b]0;t\x07\n   \n')).toBe(80);
  });

  it('measures the longest visible line, ignoring ANSI bytes', () => {
    const scrollback = `short\n\x1b[32m${'z'.repeat(100)}\x1b[0m\nmedium line`;
    expect(parseColsFromScrollback(scrollback)).toBe(100);
  });

  it('clamps narrow captures up to 40', () => {
    expect(parseColsFromScrollback('ab\ncd\n')).toBe(40);
  });

  it('clamps very wide captures down to 300', () => {
    expect(parseColsFromScrollback('y'.repeat(500))).toBe(300);
  });
});
