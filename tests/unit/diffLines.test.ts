import { describe, expect, it } from 'vitest';
import { buildUnifiedDiffLines, maxLineLength, type DiffLine } from '@/diff/diffLines';

const NINE_LINES = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n';
const NINE_LINES_CHANGED = 'l1\nl2\nl3\nl4\nCHANGED\nl6\nl7\nl8\nl9\n';

describe('buildUnifiedDiffLines', () => {
  it('returns an empty result for identical inputs', () => {
    expect(buildUnifiedDiffLines('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(buildUnifiedDiffLines('', '')).toEqual([]);
  });

  it('numbers context, remove, and add lines correctly', () => {
    const lines = buildUnifiedDiffLines(NINE_LINES, NINE_LINES_CHANGED, { context: 1 });

    expect(lines).toEqual([
      { kind: 'hunk-header', text: '@@ -4,3 +4,3 @@', oldLineNumber: null, newLineNumber: null },
      { kind: 'context', text: 'l4', oldLineNumber: 4, newLineNumber: 4 },
      { kind: 'remove', text: 'l5', oldLineNumber: 5, newLineNumber: null },
      { kind: 'add', text: 'CHANGED', oldLineNumber: null, newLineNumber: 5 },
      { kind: 'context', text: 'l6', oldLineNumber: 6, newLineNumber: 6 },
    ]);
  });

  it('defaults to 3 context lines', () => {
    const lines = buildUnifiedDiffLines(NINE_LINES, NINE_LINES_CHANGED);

    expect(lines[0]).toEqual({
      kind: 'hunk-header',
      text: '@@ -2,7 +2,7 @@',
      oldLineNumber: null,
      newLineNumber: null,
    });
    const contextLines = lines.filter((line) => line.kind === 'context');
    expect(contextLines).toHaveLength(6);
    expect(contextLines[0]).toEqual({ kind: 'context', text: 'l2', oldLineNumber: 2, newLineNumber: 2 });
    expect(contextLines[5]).toEqual({ kind: 'context', text: 'l8', oldLineNumber: 8, newLineNumber: 8 });
  });

  it('renders an added file (empty original) as all adds', () => {
    const lines = buildUnifiedDiffLines('', 'line one\nline two\n');

    expect(lines).toEqual([
      { kind: 'hunk-header', text: '@@ -1,0 +1,2 @@', oldLineNumber: null, newLineNumber: null },
      { kind: 'add', text: 'line one', oldLineNumber: null, newLineNumber: 1 },
      { kind: 'add', text: 'line two', oldLineNumber: null, newLineNumber: 2 },
    ]);
  });

  it('renders a deleted file (empty modified) as all removes', () => {
    const lines = buildUnifiedDiffLines('line one\nline two\n', '');

    expect(lines).toEqual([
      { kind: 'hunk-header', text: '@@ -1,2 +1,0 @@', oldLineNumber: null, newLineNumber: null },
      { kind: 'remove', text: 'line one', oldLineNumber: 1, newLineNumber: null },
      { kind: 'remove', text: 'line two', oldLineNumber: 2, newLineNumber: null },
    ]);
  });

  it('drops the no-trailing-newline marker lines without disturbing numbering', () => {
    const lines = buildUnifiedDiffLines('a\nb', 'a\nc');

    expect(lines).toEqual([
      { kind: 'hunk-header', text: '@@ -1,2 +1,2 @@', oldLineNumber: null, newLineNumber: null },
      { kind: 'context', text: 'a', oldLineNumber: 1, newLineNumber: 1 },
      { kind: 'remove', text: 'b', oldLineNumber: 2, newLineNumber: null },
      { kind: 'add', text: 'c', oldLineNumber: null, newLineNumber: 2 },
    ]);
  });
});

describe('maxLineLength', () => {
  it('returns the longest text among the lines', () => {
    const lines: DiffLine[] = [
      { kind: 'context', text: 'short', oldLineNumber: 1, newLineNumber: 1 },
      { kind: 'add', text: 'a considerably longer line', oldLineNumber: null, newLineNumber: 2 },
      { kind: 'remove', text: 'mid-sized', oldLineNumber: 2, newLineNumber: null },
    ];
    expect(maxLineLength(lines)).toBe('a considerably longer line'.length);
  });

  it('returns 0 for an empty list', () => {
    expect(maxLineLength([])).toBe(0);
  });
});
