/**
 * Pure PTY-tail cleaner powering the token-by-token live view. It is NOT a
 * terminal emulator: it interprets only the control sequences that change
 * LINE IDENTITY (newline, carriage-return overwrite, CHA, EL, backspace,
 * CUU/CUD) so spinner and status-line redraws collapse into a stable set of
 * virtual lines, strips everything cosmetic (SGR, OSC, unknown CSI), and
 * treats full-screen redraw sequences (CUP home, erase display, alternate
 * screen switches) as a buffer reset because a screen repaint is not
 * representable as a tail.
 */

const DEFAULT_MAX_LINES = 12;
const VIRTUAL_LINE_CAP_MULTIPLIER = 4;

const BOX_DRAWING_CHARACTERS = new Set('╭╮╰╯│─┌┐└┘├┤┬┴┼═║╔╗╚╝');
const BOX_DRAWING_LINE_RATIO = 0.6;

/** Leading glyphs that mark a spinner/status chrome line outright. */
const CHROME_LEADING_GLYPHS = new Set(['✳', '·']);

/**
 * Leading glyphs that mark chrome only when combined with a token-status
 * pattern like "1.2k tokens" / "523 tokens".
 */
const SPINNERISH_LEADING_GLYPHS = new Set(['✻', '✽', '✶', '✢', '*', '+', '∗']);

const TOKEN_STATUS_PATTERN = /\d+\s*tokens/i;

const BRAILLE_RANGE_START = 0x2800;
const BRAILLE_RANGE_END = 0x28ff;

export interface LiveTailBuffer {
  append(chunk: string): void;
  snapshotLines(): string[];
  reset(): void;
}

export interface CreateLiveTailBufferOptions {
  maxLines?: number;
}

type ParserMode = 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape';

function isChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const characters = Array.from(trimmed);
  let boxDrawingCount = 0;
  for (const character of characters) {
    if (BOX_DRAWING_CHARACTERS.has(character)) {
      boxDrawingCount++;
    }
  }
  if (boxDrawingCount / characters.length >= BOX_DRAWING_LINE_RATIO) {
    return true;
  }
  const leadingGlyph = characters[0];
  const leadingCodePoint = leadingGlyph.codePointAt(0) ?? 0;
  if (leadingCodePoint >= BRAILLE_RANGE_START && leadingCodePoint <= BRAILLE_RANGE_END) {
    return true;
  }
  if (CHROME_LEADING_GLYPHS.has(leadingGlyph)) {
    return true;
  }
  if (trimmed.toLowerCase().includes('esc to interrupt')) {
    return true;
  }
  if (SPINNERISH_LEADING_GLYPHS.has(leadingGlyph) && TOKEN_STATUS_PATTERN.test(trimmed)) {
    return true;
  }
  return false;
}

export function createLiveTailBuffer(options?: CreateLiveTailBufferOptions): LiveTailBuffer {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const virtualLineCap = maxLines * VIRTUAL_LINE_CAP_MULTIPLIER;

  let lines: string[] = [''];
  let cursorRow = 0;
  let cursorColumn = 0;
  // Parser state persists across append() calls, so an escape sequence split
  // between two chunks resumes exactly where it left off.
  let parserMode: ParserMode = 'text';
  let csiParameters = '';

  function resetBuffer(): void {
    lines = [''];
    cursorRow = 0;
    cursorColumn = 0;
  }

  function enforceVirtualLineCap(): void {
    if (lines.length > virtualLineCap) {
      const overflow = lines.length - virtualLineCap;
      lines.splice(0, overflow);
      cursorRow = Math.max(0, cursorRow - overflow);
    }
  }

  function moveToNewLine(): void {
    if (cursorRow === lines.length - 1) {
      lines.push('');
    }
    cursorRow++;
    cursorColumn = 0;
    enforceVirtualLineCap();
  }

  function writePrintable(character: string): void {
    const currentLine = lines[cursorRow];
    if (cursorColumn >= currentLine.length) {
      lines[cursorRow] = currentLine.padEnd(cursorColumn, ' ') + character;
    } else {
      lines[cursorRow] =
        currentLine.slice(0, cursorColumn) + character + currentLine.slice(cursorColumn + 1);
    }
    cursorColumn++;
  }

  function firstCsiCount(parameters: string): number {
    const parsedCount = Number.parseInt(parameters, 10);
    return Number.isNaN(parsedCount) || parsedCount < 1 ? 1 : parsedCount;
  }

  function privateModeNumbers(parameters: string): string[] {
    if (!parameters.startsWith('?')) {
      return [];
    }
    return parameters.slice(1).split(';');
  }

  function dispatchCsi(parameters: string, finalByte: string): void {
    switch (finalByte) {
      case 'm':
        // SGR - purely cosmetic, stripped.
        return;
      case 'G': {
        // CHA - cursor to an absolute column (1-based).
        cursorColumn = Math.max(0, firstCsiCount(parameters) - 1);
        return;
      }
      case 'K': {
        // EL - erase in line.
        const currentLine = lines[cursorRow];
        if (parameters === '' || parameters === '0') {
          lines[cursorRow] = currentLine.slice(0, cursorColumn);
        } else if (parameters === '1') {
          const eraseEnd = Math.min(cursorColumn + 1, currentLine.length);
          lines[cursorRow] = ' '.repeat(eraseEnd) + currentLine.slice(eraseEnd);
        } else if (parameters === '2') {
          lines[cursorRow] = '';
        }
        return;
      }
      case 'A': {
        // CUU - cursor up within the buffered window, keeping the column.
        cursorRow = Math.max(0, cursorRow - firstCsiCount(parameters));
        return;
      }
      case 'B': {
        // CUD - cursor down within the buffered window, keeping the column.
        cursorRow = Math.min(lines.length - 1, cursorRow + firstCsiCount(parameters));
        return;
      }
      case 'H':
      case 'f': {
        // CUP - absolute cursor positioning means a full-screen repaint; a
        // tail cannot represent that, so reset.
        resetBuffer();
        return;
      }
      case 'J': {
        // ED - erasing the display (2J/3J) is a full-screen redraw; other
        // variants are stripped.
        if (parameters === '2' || parameters === '3') {
          resetBuffer();
        }
        return;
      }
      case 'h':
      case 'l': {
        // Alternate-screen enter/exit is a full-screen context switch.
        const modeNumbers = privateModeNumbers(parameters);
        if (modeNumbers.includes('1049') || modeNumbers.includes('47')) {
          resetBuffer();
        }
        return;
      }
      default:
        // Unknown-but-parseable CSI - stripped.
        return;
    }
  }

  function consumeTextCharacter(character: string): void {
    if (character === '\x1b') {
      parserMode = 'escape';
      return;
    }
    if (character === '\n') {
      moveToNewLine();
      return;
    }
    if (character === '\r') {
      cursorColumn = 0;
      return;
    }
    if (character === '\x08') {
      cursorColumn = Math.max(0, cursorColumn - 1);
      return;
    }
    const characterCode = character.charCodeAt(0);
    if ((characterCode < 0x20 && character !== '\t') || characterCode === 0x7f) {
      // Other C0 controls (BEL and friends) and DEL are stripped.
      return;
    }
    writePrintable(character);
  }

  function consumeEscapeCharacter(character: string): void {
    if (character === '[') {
      parserMode = 'csi';
      csiParameters = '';
      return;
    }
    if (character === ']') {
      parserMode = 'osc';
      return;
    }
    const characterCode = character.charCodeAt(0);
    if (characterCode >= 0x20 && characterCode <= 0x2f) {
      // Intermediate byte (e.g. the '(' of a charset designation) - the
      // sequence continues with one more byte.
      return;
    }
    // Any other byte terminates a simple escape sequence; strip it.
    parserMode = 'text';
  }

  function consumeCsiCharacter(character: string): void {
    const characterCode = character.charCodeAt(0);
    if (characterCode >= 0x30 && characterCode <= 0x3f) {
      csiParameters += character;
      return;
    }
    if (characterCode >= 0x20 && characterCode <= 0x2f) {
      // Intermediate bytes - kept out of the parameter string; none of the
      // sequences this cleaner interprets use them.
      return;
    }
    if (characterCode >= 0x40 && characterCode <= 0x7e) {
      parserMode = 'text';
      dispatchCsi(csiParameters, character);
      return;
    }
    // Malformed CSI (a control byte mid-sequence) - abandon it.
    parserMode = 'text';
  }

  function consumeOscCharacter(character: string): void {
    if (character === '\x07') {
      parserMode = 'text';
      return;
    }
    if (character === '\x1b') {
      parserMode = 'osc-escape';
      return;
    }
    // OSC payload bytes are discarded.
  }

  function consumeOscEscapeCharacter(character: string): void {
    if (character === '\\') {
      parserMode = 'text';
      return;
    }
    // ESC followed by anything else inside an OSC: keep consuming payload.
    parserMode = 'osc';
  }

  function append(chunk: string): void {
    for (const character of chunk) {
      switch (parserMode) {
        case 'text':
          consumeTextCharacter(character);
          break;
        case 'escape':
          consumeEscapeCharacter(character);
          break;
        case 'csi':
          consumeCsiCharacter(character);
          break;
        case 'osc':
          consumeOscCharacter(character);
          break;
        case 'osc-escape':
          consumeOscEscapeCharacter(character);
          break;
      }
    }
  }

  function snapshotLines(): string[] {
    const keptLines: string[] = [];
    for (const line of lines) {
      if (!isChromeLine(line)) {
        keptLines.push(line);
      }
    }
    return keptLines.slice(-maxLines);
  }

  function reset(): void {
    resetBuffer();
    parserMode = 'text';
    csiParameters = '';
  }

  return { append, snapshotLines, reset };
}

/**
 * Standalone ANSI stripper with NO cursor emulation: removes OSC, CSI, and
 * other escape sequences plus stray control bytes, keeping newlines, tabs,
 * and printable text. Suitable for measuring scrollback layout, not for
 * replaying interactive redraws (use createLiveTailBuffer for that).
 */
export function stripAnsiPreservingLayout(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/[\0-\x08\x0b-\x1f\x7f]/g, '');
}

const MIN_PARSED_COLUMNS = 40;
const MAX_PARSED_COLUMNS = 300;
const DEFAULT_PARSED_COLUMNS = 80;

/**
 * Infer a column count from a scrollback capture: the maximum VISIBLE line
 * length (after stripping ANSI, counting UTF-16 code units, ignoring
 * trailing whitespace), clamped to [40, 300]. Returns 80 for empty or
 * degenerate input.
 */
export function parseColsFromScrollback(scrollback: string): number {
  const strippedScrollback = stripAnsiPreservingLayout(scrollback);
  let maxVisibleLength = 0;
  for (const line of strippedScrollback.split('\n')) {
    const visibleLength = line.trimEnd().length;
    if (visibleLength > maxVisibleLength) {
      maxVisibleLength = visibleLength;
    }
  }
  if (maxVisibleLength === 0) {
    return DEFAULT_PARSED_COLUMNS;
  }
  return Math.min(MAX_PARSED_COLUMNS, Math.max(MIN_PARSED_COLUMNS, maxVisibleLength));
}
