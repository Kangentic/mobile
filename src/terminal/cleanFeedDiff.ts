/**
 * The clean-feed line differ: turns successive serialized terminal frames
 * into reader-view updates (append deltas, or a replace on repaint). The
 * technique is the desktop's proven ansi-filter approach: serialize the
 * parsed grid, split into trimmed lines, longest-common-prefix diff against
 * the previous frame, and drop decorative-only lines.
 *
 * The generated xterm.html glue carries a hand-mirrored copy of this
 * function (the page cannot import TypeScript); tests/unit/cleanFeedDiff
 * extracts the glue's copy from the generated file and asserts both
 * implementations agree, so the two cannot drift silently.
 */

/** Lines of only box-drawing characters, spaces, and rule punctuation - TUI borders, not content. */
export const CLEAN_FEED_DECORATIVE_RE = /^[─-╿\s\-=_·•]+$/;

export interface CleanFeedDiffResult {
  /** Lines for the reader: the appended tail (reset false) or the whole visible frame (reset true). */
  lines: string[];
  /** True when the frame rewrote content above the previous tail (a fullscreen repaint): REPLACE, do not append. */
  reset: boolean;
  /** Carry into the next diff as previousLines. */
  nextLines: string[];
}

export function diffCleanLines(previousLines: readonly string[], serialized: string): CleanFeedDiffResult {
  const newLines = serialized.split('\n').map((line) => line.replace(/\s+$/, ''));
  while (newLines.length > 0 && newLines[newLines.length - 1] === '') {
    newLines.pop();
  }

  let commonPrefixLength = 0;
  const comparableLength = Math.min(newLines.length, previousLines.length);
  for (let index = 0; index < comparableLength; index += 1) {
    if (newLines[index] === previousLines[index]) commonPrefixLength += 1;
    else break;
  }

  if (commonPrefixLength === newLines.length && newLines.length === previousLines.length) {
    return { lines: [], reset: false, nextLines: newLines };
  }

  // Content above the previous tail changed (or the frame shrank): a repaint
  // replaced what the reader already shows. Otherwise it is a pure append.
  const reset = commonPrefixLength < previousLines.length;
  const emitted = (reset ? newLines : newLines.slice(commonPrefixLength)).filter(
    (line) => line.length > 0 && !CLEAN_FEED_DECORATIVE_RE.test(line),
  );
  return { lines: emitted, reset, nextLines: newLines };
}
