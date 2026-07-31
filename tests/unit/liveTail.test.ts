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

  it('skips middot-joined status bars like "auto mode on · PR #4 · 1 shell" (recorded feed-card artifact)', () => {
    const frame = 'Committed the UI refinements.\n▶▶ auto mode on · PR #4 · 1 shell\n';
    expect(lastContentLineFromScrollback(frame)).toBe('Committed the UI refinements.');
  });

  it('skips status-area tip lines in favor of the real action above them (recorded feed-card artifact)', () => {
    // Seen live 2026-07-20: the snippet read "Tip: Use /btw to ask a quick
    // side question..." while the current tool action sat right above it.
    const frame =
      'Update(src/components/theme/tokens.ts)\n' +
      '* Galloping... (1m 27s · ↓ 2.1k tokens · thinking with xhigh effort)\n' +
      "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work\n";
    expect(lastContentLineFromScrollback(frame)).toBe('Update(src/components/theme/tokens.ts)');
  });

  it('skips single-token label lines like the worktree tag (recorded feed-card artifact)', () => {
    // Seen live 2026-07-20: the snippet showed "kangentic-mobile-v1-overnight"
    // with a trailing arrow - the TUI's worktree tag, not a message.
    const frame = 'The real last message.\nkangentic-mobile-v1-overnight ──➤\n';
    expect(lastContentLineFromScrollback(frame)).toBe('The real last message.');
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

  // The four tests below pin isChromeLine's box-drawing boundary from BOTH
  // sides. Whitespace was pulled out of the box-drawing ratio's denominator,
  // the box-drawing character set widened from a hand-listed subset to the
  // whole U+2500-U+259F range (Box Drawing plus Block Elements), and an
  // absolute "8 box-drawing glyphs in a row drops the whole line" rule was
  // added on top - all three changes only ever make MORE lines count as
  // chrome. Every existing test that exercises them asserts chrome IS
  // stripped; nothing pinned the opposite direction, so a future tightening
  // of any of the three could start eating real agent content and every test
  // would stay green. These close that hole.

  it('keeps a content line with a few inline block glyphs despite heavy interior padding', () => {
    // A git-diff-stat-style summary line: two shaded meter ticks among real
    // stats, padded with runs of spaces for column alignment (the exact shape
    // that used to dilute the ratio when whitespace counted toward the
    // denominator). Excluding whitespace still leaves the ratio at roughly
    // 0.05 (2 box glyphs out of 42 significant characters) - nowhere near the
    // 0.6 cutoff, so heavy padding alone must not tip a real content line into
    // chrome.
    const buffer = createLiveTailBuffer();
    buffer.append('coverage ▓▓ 82%      1204 lines checked      3 files flagged');
    expect(buffer.snapshotLines()).toEqual([
      'coverage ▓▓ 82%      1204 lines checked      3 files flagged',
    ]);
  });

  it('keeps a line whose box-glyph ratio sits just under the 0.6 cutoff once whitespace is excluded', () => {
    // "12/40" contributes 5 significant characters against a 7-glyph meter,
    // for a ratio of 7/12 = 0.5833 - just under BOX_DRAWING_LINE_RATIO. Block
    // Elements are exempt from the run rule (a long run of them is a progress
    // bar, not a rule), so the ratio test is the only instrument that can
    // classify this line either way, which is exactly what this pins.
    const buffer = createLiveTailBuffer();
    buffer.append('12/40 ▓▓▓▓▓▓▓');
    expect(buffer.snapshotLines()).toEqual(['12/40 ▓▓▓▓▓▓▓']);
  });

  it('keeps a 7-glyph box-drawing run beside real words, one short of the run-rule threshold', () => {
    // Mirrors the merged-line shape the containsBoxDrawingRule comment
    // describes (a filename, a rule, and more text folded into one virtual
    // line), but with a run of 7, not 8. The ratio (7 box glyphs out of 39
    // significant characters, 0.18) is nowhere near 0.6 either, so this line
    // must survive on both counts.
    const buffer = createLiveTailBuffer();
    buffer.append('checkout.tsx ─────── validate the input path');
    expect(buffer.snapshotLines()).toEqual(['checkout.tsx ─────── validate the input path']);
  });

  it('drops a line the instant a box-drawing run reaches 8, even carrying real words', () => {
    // Same line as the one above with a single extra rule glyph: the ratio is
    // still only 0.2 (comfortably under 0.6), but containsBoxDrawingRule
    // fires at exactly 8 and discards the whole line, filename and all - the
    // trade-off BOX_DRAWING_RULE_RUN's comment documents (a real capture
    // merged a filename, a 44-glyph rule, and two rows of code into one line
    // this way).
    const buffer = createLiveTailBuffer();
    buffer.append('real output\n');
    buffer.append('checkout.tsx ──────── validate the input path\n');
    buffer.append('more output');
    expect(buffer.snapshotLines()).toEqual(['real output', 'more output']);
  });

  it('keeps a progress bar that has real text around it, however long the bar', () => {
    // THE REGRESSION CASE. The run rule was originally written against the
    // whole U+2500-U+259F range, so a 20-glyph progress bar tripped it and the
    // entire line was discarded - "Downloading model" and "62%" with it - even
    // though the ratio test correctly scored it 0.51 and kept it. Nothing had
    // ever dropped this line before, because the hand-listed set it replaced
    // contained no Block Elements at all.
    //
    // The fix is that the RUN rule reads Box Drawing only: a long run of `─`
    // is a rule, a long run of `█` is a bar, and a bar with words around it is
    // content. A progress line is also the single most useful thing the live
    // tail can show during a long Bash call, which is when a reader is most
    // likely to be watching it.
    const buffer = createLiveTailBuffer();
    buffer.append('Downloading model ████████████░░░░░░░░ 62%');
    expect(buffer.snapshotLines()).toEqual(['Downloading model ████████████░░░░░░░░ 62%']);
  });

  it('still drops a long RULE that has real text around it', () => {
    // The other side of that split, and the case the run rule exists for: the
    // same shape built from Box Drawing rather than Block Elements is a merged
    // dialog border and must still go, text and all.
    const buffer = createLiveTailBuffer();
    buffer.append('kept line\n');
    buffer.append('Downloading model ──────────── 62%\n');
    buffer.append('another kept line');
    expect(buffer.snapshotLines()).toEqual(['kept line', 'another kept line']);
  });

  it('drops a standalone block-element bar, now that Block Elements count as box-drawing', () => {
    // Solid block glyphs (█, U+2588) sat outside the old hand-listed
    // box-drawing subset, so a fully-filled progress bar used to score as
    // ordinary text. The widened U+2500-U+259F range now recognizes them,
    // so a bar of eight scores a ratio of 1.0 and is dropped.
    const buffer = createLiveTailBuffer();
    buffer.append('progress\n');
    buffer.append('████████\n');
    buffer.append('done');
    expect(buffer.snapshotLines()).toEqual(['progress', 'done']);
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
