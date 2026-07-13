/**
 * Unified-diff computation for the phone's diff viewer, built on the 'diff'
 * npm package (jsdiff). Produces a flat DiffLine[] the FlashList renders:
 * hunk headers plus content lines carrying correct old/new line numbers.
 */
import { structuredPatch } from 'diff';

export type DiffLineKind = 'hunk-header' | 'add' | 'remove' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface BuildUnifiedDiffLinesOptions {
  context?: number;
}

const DEFAULT_CONTEXT_LINES = 3;

export function buildUnifiedDiffLines(
  original: string,
  modified: string,
  options?: BuildUnifiedDiffLinesOptions,
): DiffLine[] {
  const contextLineCount = options?.context ?? DEFAULT_CONTEXT_LINES;
  const patch = structuredPatch('original', 'modified', original, modified, undefined, undefined, {
    context: contextLineCount,
  });

  const diffLines: DiffLine[] = [];
  for (const hunk of patch.hunks) {
    diffLines.push({
      kind: 'hunk-header',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldLineNumber: null,
      newLineNumber: null,
    });
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;
    for (const hunkLine of hunk.lines) {
      const marker = hunkLine.charAt(0);
      const text = hunkLine.slice(1);
      if (marker === '+') {
        diffLines.push({ kind: 'add', text, oldLineNumber: null, newLineNumber });
        newLineNumber++;
      } else if (marker === '-') {
        diffLines.push({ kind: 'remove', text, oldLineNumber, newLineNumber: null });
        oldLineNumber++;
      } else if (marker === ' ') {
        diffLines.push({ kind: 'context', text, oldLineNumber, newLineNumber });
        oldLineNumber++;
        newLineNumber++;
      }
      // Lines starting with '\' ("\ No newline at end of file") carry no
      // file content and no line number; they are dropped from the render.
    }
  }
  return diffLines;
}

/** Longest text among the given lines, for horizontal-scroll sizing. */
export function maxLineLength(lines: DiffLine[]): number {
  let maximumLength = 0;
  for (const line of lines) {
    if (line.text.length > maximumLength) {
      maximumLength = line.text.length;
    }
  }
  return maximumLength;
}
