import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffCleanLines } from '../../src/terminal/cleanFeedDiff';

describe('diffCleanLines', () => {
  it('emits everything on the first frame', () => {
    const result = diffCleanLines([], 'hello\nworld\n\n');
    expect(result.lines).toEqual(['hello', 'world']);
    expect(result.reset).toBe(false);
    expect(result.nextLines).toEqual(['hello', 'world']);
  });

  it('emits only appended lines on growth', () => {
    const first = diffCleanLines([], 'one\ntwo');
    const second = diffCleanLines(first.nextLines, 'one\ntwo\nthree');
    expect(second.lines).toEqual(['three']);
    expect(second.reset).toBe(false);
  });

  it('emits nothing when the frame is unchanged', () => {
    const first = diffCleanLines([], 'one\ntwo');
    const second = diffCleanLines(first.nextLines, 'one\ntwo');
    expect(second.lines).toEqual([]);
    expect(second.reset).toBe(false);
  });

  it('resets with the full frame when content above the tail changed (repaint)', () => {
    const first = diffCleanLines([], 'title\nprogress 10%\nfooter');
    const second = diffCleanLines(first.nextLines, 'title\nprogress 90%\nfooter');
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual(['title', 'progress 90%', 'footer']);
  });

  it('resets when the frame shrank (screen clear)', () => {
    const first = diffCleanLines([], 'a\nb\nc');
    const second = diffCleanLines(first.nextLines, 'a');
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual(['a']);
  });

  it('drops decorative-only and empty lines from the emitted set', () => {
    const result = diffCleanLines([], 'real content\n────────────\n- - - - -\n·•·•·\nmore');
    expect(result.lines).toEqual(['real content', 'more']);
    // nextLines keeps the raw frame so the NEXT diff still aligns by row.
    expect(result.nextLines).toHaveLength(5);
  });

  it('trims trailing whitespace per line before comparing', () => {
    const first = diffCleanLines([], 'padded   \nline');
    expect(first.nextLines).toEqual(['padded', 'line']);
    const second = diffCleanLines(first.nextLines, 'padded\nline');
    expect(second.lines).toEqual([]);
  });

  it('handles a codex-style TUI redraw fixture', () => {
    const frameOne = 'codex session\n╭──────────╮\nThinking about the fix\n╰──────────╯\nstatus: working';
    const frameTwo = 'codex session\n╭──────────╮\nApplying the patch now\n╰──────────╯\nstatus: working';
    const first = diffCleanLines([], frameOne);
    expect(first.lines).toEqual(['codex session', 'Thinking about the fix', 'status: working']);
    const second = diffCleanLines(first.nextLines, frameTwo);
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual(['codex session', 'Applying the patch now', 'status: working']);
  });
});

describe('glue parity (generated xterm.html carries the same differ)', () => {
  function extractGlueDiffFunction(): (previousLines: string[], serialized: string) => { lines: string[]; reset: boolean; nextLines: string[] } {
    const generatedHtml = readFileSync(join(__dirname, '..', '..', 'src', 'terminal', 'xterm.html'), 'utf8');
    const startMarker = 'function diffCleanLines(previousLines, serialized) {';
    const startIndex = generatedHtml.indexOf(startMarker);
    expect(startIndex).toBeGreaterThan(-1);
    // The function body ends at the first `return { lines: emitted...` closer.
    const endMarker = 'return { lines: emitted, reset: reset, nextLines: newLines };';
    const endIndex = generatedHtml.indexOf(endMarker, startIndex);
    expect(endIndex).toBeGreaterThan(startIndex);
    const functionSource = generatedHtml.slice(startIndex, endIndex + endMarker.length) + '\n}';
    // Executing the generated page's own code is the point of the parity test.
    return new Function(`${functionSource}; return diffCleanLines;`)() as (
      previousLines: string[],
      serialized: string,
    ) => { lines: string[]; reset: boolean; nextLines: string[] };
  }

  it('produces identical results to the TypeScript implementation', () => {
    const glueDiff = extractGlueDiffFunction();
    const fixtures: { previous: string[]; serialized: string }[] = [
      { previous: [], serialized: 'hello\nworld\n\n' },
      { previous: ['one', 'two'], serialized: 'one\ntwo\nthree' },
      { previous: ['one', 'two'], serialized: 'one\ntwo' },
      { previous: ['title', 'progress 10%', 'footer'], serialized: 'title\nprogress 90%\nfooter' },
      { previous: ['a', 'b', 'c'], serialized: 'a' },
      { previous: [], serialized: 'real\n────────\n- - -\n·•·\nmore' },
      { previous: ['padded', 'line'], serialized: 'padded   \nline' },
      { previous: [], serialized: '' },
    ];
    for (const fixture of fixtures) {
      const expected = diffCleanLines(fixture.previous, fixture.serialized);
      const actual = glueDiff([...fixture.previous], fixture.serialized);
      expect(actual).toEqual(expected);
    }
  });
});
