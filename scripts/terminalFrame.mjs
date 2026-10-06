/**
 * DEVELOPER UTILITY - imported by scripts/buildTerminalFixture.mjs and its
 * tests, not run on its own and not imported by the app.
 *
 * Turns a recorded terminal screen into a frame that FILLS a wider grid,
 * the way the desktop's web demo does it. Two halves:
 *
 * 1. PHYSICAL ROWS. A headless xterm screen is written one buffer row per
 *    row, joined with \r\n, each row self-contained (its style diff starts
 *    from the default attributes and ends in a reset), and the cursor is one
 *    absolute CUP at the end. @xterm/addon-serialize instead JOINS a wrapped
 *    row onto the one above with no line break, relying on the terminal
 *    wrapping at exactly the recorded width when the bytes are replayed; at any
 *    other width every continuation spills into the wrong row.
 *
 * 2. WIDENING. Each row is fitted to a grid wider than the recording: what the
 *    CLI draws TO its edge (a horizontal rule, a diff line's background band, a
 *    right-hand border or scrollbar, a right-aligned label) is drawn to the new
 *    edge, and everything else (prose, code) keeps the line breaks it was
 *    recorded with. Rows are written with autowrap OFF, so a width the two
 *    sides disagree on overwrites the last column instead of wrapping.
 *
 * This re-serializes a RECORDED buffer: no displayed text is authored or
 * rewritten, which is why it does not break the recorded-fixture rule in
 * buildTerminalFixture.mjs's header. That script proves it per build: the
 * recorded-grid seed reproduces the capture's screen, and the widened frame
 * matches that seed cell for cell inside the recorded width except where a
 * border moved out or a band or rule crossed the CLI's right padding, with
 * only fill past it. Two deliberate departures from the desktop's serializer
 * are documented where they are made: looksBlank(), and the bold/dim fix in
 * diffStyle().
 *
 * PROVENANCE. Ported from the desktop repo (kangentic, AGPL-3.0, same owner as
 * this one): the serializer from scripts/lib/demo-frame-serializer.js, and the
 * widening rules from the frame applier in tests/captures/helpers/demo-dataset.ts
 * (written up in demo/README.md, "Fill, never letterbox"). The serializer's
 * cell walk and SGR diff mirror @xterm/addon-serialize's (MIT, the xterm.js
 * authors) over the public IBufferCell getters, so a cell paints the same
 * colour whichever serializer wrote it; serializeModes() is that addon's
 * _serializeModes. Only the WIDEN path is ported: this repo never fits a
 * frame to a narrower grid or a taller one, and refuses both rather than
 * guessing.
 *
 * Cell widths are a code-point count. The phone's xterm runs Unicode 6 widths
 * and so does the headless one, and buildTerminalFixture.mjs fails on any cell
 * that is not exactly one code point one cell wide, so the count is exact for
 * every frame that gets this far.
 */

/** Enters the alternate screen and homes the cursor: the prefix of an alt-screen frame. */
export const ALT_PREFIX = '\x1b[?1049h\x1b[H';
/** The absolute cursor position every physical-row frame ends with (1-based row and column). */
const CURSOR_SUFFIX = /\x1b\[(\d+);(\d+)H$/;

const AUTOWRAP_OFF = '\x1b[?7l';
const AUTOWRAP_ON = '\x1b[?7h';

const FRAME_SEQUENCE = /^\x1b\[[0-9;?]*[A-Za-z]/;
const CURSOR_FORWARD = /^\x1b\[(\d*)C$/;
const ERASE_CHARACTERS = /^\x1b\[(\d*)X$/;

export const HORIZONTAL_RULE_GLYPHS = '─━┄┅┈┉╌╍═╴╶╸╺╼╾▀▁▂▃▄▅▆▇█▔';
/**
 * What a CLI draws down its right edge: vertical box sides, the right-hand
 * corners and tees of a box, and a scrollbar track.
 */
export const VERTICAL_EDGE_GLYPHS = '│┃┆┇┊┋╎╏║▐▕┐┓┘┛┤┫╗╝╢╣╮╯';

/**
 * How far short of the recorded edge a row may stop and still be one the CLI
 * drew TO its edge: Claude pads a diff line's background band up to seven
 * columns short of its width.
 */
const EDGE_SLACK = 8;
/**
 * A gap at least this wide right before a row's last text is the CLI
 * right-aligning that text. Prose is one space, or one cursor-forward, between
 * words.
 */
const TAIL_GAP_MIN = 4;
/**
 * How far short of the recorded edge a CLI ends right-aligned text: Claude
 * keeps two cells of padding. A row that runs to the edge itself is content the
 * CLI cut or wrapped there, never a label it placed.
 */
const TAIL_PADDING_MAX = 2;

// ---------------------------------------------------------------------------
// Physical-row serializer
// ---------------------------------------------------------------------------

function equalForeground(cell, other) {
  return cell.getFgColorMode() === other.getFgColorMode() && cell.getFgColor() === other.getFgColor();
}

function equalBackground(cell, other) {
  return cell.getBgColorMode() === other.getBgColorMode() && cell.getBgColor() === other.getBgColor();
}

function equalFlags(cell, other) {
  return (
    cell.isInverse() === other.isInverse() &&
    cell.isBold() === other.isBold() &&
    cell.isUnderline() === other.isUnderline() &&
    cell.isOverline() === other.isOverline() &&
    cell.isBlink() === other.isBlink() &&
    cell.isInvisible() === other.isInvisible() &&
    cell.isItalic() === other.isItalic() &&
    cell.isDim() === other.isDim() &&
    cell.isStrikethrough() === other.isStrikethrough()
  );
}

/**
 * The SGR parameters that take the terminal from `previous` to `cell`, as the
 * addon computes them, with one fix the addon lacks: SGR 22 turns off bold AND
 * dim together, so a step that turns one of them off writes a single 22 and
 * then sets again whichever of the two the cell keeps. The addon writes the
 * 22 alone (bold+dim to dim) or before the survivor's own code (dim to bold),
 * and the survivor is lost on replay.
 */
export function diffStyle(cell, previous) {
  const parameters = [];
  const foregroundChanged = !equalForeground(cell, previous);
  const backgroundChanged = !equalBackground(cell, previous);
  const flagsChanged = !equalFlags(cell, previous);
  if (!foregroundChanged && !backgroundChanged && !flagsChanged) return parameters;
  if (cell.isAttributeDefault()) {
    if (!previous.isAttributeDefault()) parameters.push(0);
    return parameters;
  }
  if (foregroundChanged) {
    const color = cell.getFgColor();
    if (cell.isFgRGB()) parameters.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    else if (cell.isFgPalette()) {
      if (color >= 16) parameters.push(38, 5, color);
      else parameters.push(color & 8 ? 90 + (color & 7) : 30 + (color & 7));
    } else parameters.push(39);
  }
  if (backgroundChanged) {
    const color = cell.getBgColor();
    if (cell.isBgRGB()) parameters.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    else if (cell.isBgPalette()) {
      if (color >= 16) parameters.push(48, 5, color);
      else parameters.push(color & 8 ? 100 + (color & 7) : 40 + (color & 7));
    } else parameters.push(49);
  }
  if (flagsChanged) {
    const boldChanged = cell.isBold() !== previous.isBold();
    const dimChanged = cell.isDim() !== previous.isDim();
    const clearsIntensity = (boldChanged && !cell.isBold()) || (dimChanged && !cell.isDim());
    if (cell.isInverse() !== previous.isInverse()) parameters.push(cell.isInverse() ? 7 : 27);
    if (clearsIntensity) {
      parameters.push(22);
      if (cell.isBold()) parameters.push(1);
      if (cell.isDim()) parameters.push(2);
    } else if (boldChanged) parameters.push(1);
    if (cell.isUnderline() !== previous.isUnderline()) parameters.push(cell.isUnderline() ? 4 : 24);
    if (cell.isOverline() !== previous.isOverline()) parameters.push(cell.isOverline() ? 53 : 55);
    if (cell.isBlink() !== previous.isBlink()) parameters.push(cell.isBlink() ? 5 : 25);
    if (cell.isInvisible() !== previous.isInvisible()) parameters.push(cell.isInvisible() ? 8 : 28);
    if (cell.isItalic() !== previous.isItalic()) parameters.push(cell.isItalic() ? 3 : 23);
    if (dimChanged && !clearsIntensity) parameters.push(2);
    if (cell.isStrikethrough() !== previous.isStrikethrough()) parameters.push(cell.isStrikethrough() ? 9 : 29);
  }
  return parameters;
}

/**
 * Whether a SPACE draws nothing: no background, and nothing that marks the
 * cell itself (inverse, a line through or under it). Its foreground colour is
 * invisible on a space.
 *
 * A deliberate departure from the desktop's serializer, which keeps any styled
 * space. Claude Code's full-screen renderer leaves stray foreground-only
 * spaces at the right edge of some diff rows, after the band's erase; kept, the
 * row's last painted thing is a "styled space", the panel-padding rule fires
 * instead of the band rule, and the band stops at the recorded width while
 * default-background spaces run on past it. Writing them as plain spaces drops
 * them with the rest of the row's trailing padding, so the band is the row's
 * end and widens like every other band row.
 */
function looksBlank(cell) {
  return (
    cell.isAttributeDefault() ||
    (cell.isBgDefault() &&
      !cell.isInverse() &&
      !cell.isUnderline() &&
      !cell.isStrikethrough() &&
      !cell.isOverline())
  );
}

/**
 * One buffer row as a self-contained string: styles from the default
 * attributes, null cells as cursor-forward gaps (or an erase plus a forward
 * when the current background paints), a trailing styled pad as an erase,
 * trailing default spaces and nulls dropped, a reset at the end when any style
 * was set. Returns '' for a row that paints nothing.
 */
function serializeRow(line, buffer) {
  // Two scratch cells, alternated so the style reference never aliases the cell being read.
  const scratchCells = [buffer.getNullCell(), buffer.getNullCell()];
  const nullCell = buffer.getNullCell();
  let style = buffer.getNullCell();
  let styleIsDefault = true;
  let row = '';
  // Runs of cells that paint nothing under the current style, in order: default-styled
  // spaces and null cells. Written out only when content follows; a run left at the row's
  // end is dropped, unless it is a null run under a painting background.
  const pending = [];
  const hold = (kind, count) => {
    const lastRun = pending[pending.length - 1];
    if (lastRun && lastRun.kind === kind) lastRun.count += count;
    else pending.push({ kind, count });
  };
  const flushPending = () => {
    for (const run of pending) {
      if (run.kind === 'spaces') row += ' '.repeat(run.count);
      // A gap under a painting background is erased to that background first, as the
      // addon does: a cursor-forward alone leaves the cells untouched.
      else row += equalBackground(style, nullCell) ? `\x1b[${run.count}C` : `\x1b[${run.count}X\x1b[${run.count}C`;
    }
    pending.length = 0;
  };
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column, scratchCells[column % 2]);
    if (!cell || cell.getWidth() === 0) continue; // the placeholder after a wide glyph
    const characters = cell.getChars();
    const isEmpty = characters === '';
    if (characters === ' ' && looksBlank(cell)) {
      if (!styleIsDefault) {
        // Whatever was held under the old style is written under it, then the style ends.
        flushPending();
        row += '\x1b[0m';
        style = buffer.getNullCell();
        styleIsDefault = true;
      }
      hold('spaces', 1);
      continue;
    }
    const parameters = diffStyle(cell, style);
    const styleChanged = isEmpty ? !equalBackground(style, cell) : parameters.length > 0;
    if (styleChanged) {
      flushPending();
      row += `\x1b[${parameters.length > 0 ? parameters.join(';') : '0'}m`;
      style = line.getCell(column, buffer.getNullCell());
      styleIsDefault = style.isAttributeDefault();
    }
    if (isEmpty) {
      hold('nulls', cell.getWidth());
      continue;
    }
    flushPending();
    row += characters;
  }
  // A trailing null run under a painting background is content (a diff row's colour band).
  const lastRun = pending[pending.length - 1];
  if (lastRun && lastRun.kind === 'nulls' && !equalBackground(style, nullCell)) {
    pending.pop();
    flushPending();
    row += `\x1b[${lastRun.count}X`;
  }
  if (!styleIsDefault) row += '\x1b[0m';
  return row;
}

/**
 * The active SCREEN as physical rows, with an absolute cursor. An alt-screen
 * session serializes its screen behind ALT_PREFIX; a normal-buffer one keeps
 * only the visible rows too, because nothing above the screen belongs in a
 * fixture (on the recording machine it is the shell banner, with the
 * operator's identity in it). Trailing rows below both the last content and
 * the cursor are dropped.
 */
export function serializePhysicalRows(terminal) {
  const buffer = terminal.buffer.active;
  const isAlternate = buffer.type === 'alternate';
  const firstRow = buffer.length - terminal.rows;
  const rows = [];
  let lastContentRow = -1;
  for (let lineIndex = firstRow; lineIndex < buffer.length; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    const row = line ? serializeRow(line, buffer) : '';
    rows.push(row);
    if (row.length > 0) lastContentRow = lineIndex - firstRow;
  }
  const cursorRow = buffer.baseY + buffer.cursorY - firstRow;
  rows.length = Math.max(0, Math.max(lastContentRow, cursorRow) + 1);
  const cursorColumn = Math.max(0, Math.min(terminal.cols - 1, buffer.cursorX));
  return `${isAlternate ? ALT_PREFIX : ''}${rows.join('\r\n')}\x1b[${Math.max(0, cursorRow) + 1};${cursorColumn + 1}H`;
}

/** The inverse: the alt flag, the rows, and the cursor as the suffix names it (0-based). */
export function parsePhysicalFrame(text) {
  const isAlternate = text.startsWith(ALT_PREFIX);
  const body = isAlternate ? text.slice(ALT_PREFIX.length) : text;
  const match = CURSOR_SUFFIX.exec(body);
  const rows = (match ? body.slice(0, match.index) : body).split('\r\n');
  return {
    isAlternate,
    rows,
    cursor: match ? { row: Number(match[1]) - 1, column: Number(match[2]) - 1 } : null,
  };
}

/**
 * The frame with its trailing absolute cursor position replaced by RELATIVE
 * moves from the end of its last row: a carriage return, cursor-up, then
 * cursor-forward. The cursor lands on the same cell.
 *
 * The CUP is what the desktop's applier needs and what widenFrame() parses,
 * but it must not ship. The phone's live-tail cleaner (src/terminal/liveTail.ts)
 * reads an absolute cursor position as a full-screen repaint and resets, so a
 * seed ending in one leaves the chat lens with an empty live tail. A real
 * desktop seeds through @xterm/addon-serialize, which ends in relative moves for
 * the same reason this does, so this keeps the fixture's seed the same kind of
 * artifact a real phone receives.
 */
export function withRelativeCursor(frame) {
  const match = CURSOR_SUFFIX.exec(frame);
  if (!match) throw new Error('not a physical-row frame: it has no trailing cursor position');
  const body = frame.slice(0, match.index);
  const lastRowIndex = body.split('\r\n').length - 1;
  const cursorRow = Number(match[1]) - 1;
  const cursorColumn = Number(match[2]) - 1;
  const rowsUp = lastRowIndex - cursorRow;
  if (rowsUp < 0) throw new Error(`the cursor (row ${cursorRow}) sits below the frame's last row (${lastRowIndex})`);
  return `${body}\r${rowsUp > 0 ? `\x1b[${rowsUp}A` : ''}${cursorColumn > 0 ? `\x1b[${cursorColumn}C` : ''}`;
}

/**
 * The terminal modes the recording left on, as DECSET/SM sequences: the
 * addon's _serializeModes. A real desktop seeds a phone through the addon, so
 * a real seed carries these, and the phone acts on them: its history scroll
 * takes mouse reporting as the authority on how to scroll
 * (scripts/xterm-page/historyScroll.js), so a fixture that dropped `?1003h`
 * would scroll a Claude session differently from a real one.
 */
export function serializeModes(terminal) {
  const modes = terminal.modes;
  let sequences = '';
  if (modes.applicationCursorKeysMode) sequences += '\x1b[?1h';
  if (modes.applicationKeypadMode) sequences += '\x1b[?66h';
  if (modes.bracketedPasteMode) sequences += '\x1b[?2004h';
  if (modes.insertMode) sequences += '\x1b[4h';
  if (modes.originMode) sequences += '\x1b[?6h';
  if (modes.reverseWraparoundMode) sequences += '\x1b[?45h';
  if (modes.sendFocusMode) sequences += '\x1b[?1004h';
  if (modes.wraparoundMode === false) sequences += '\x1b[?7l';
  switch (modes.mouseTrackingMode) {
    case 'x10':
      sequences += '\x1b[?9h';
      break;
    case 'vt200':
      sequences += '\x1b[?1000h';
      break;
    case 'drag':
      sequences += '\x1b[?1002h';
      break;
    case 'any':
      sequences += '\x1b[?1003h';
      break;
    default:
      break;
  }
  return sequences;
}

// ---------------------------------------------------------------------------
// Widening
// ---------------------------------------------------------------------------

function tokenizeRow(row) {
  const tokens = [];
  let index = 0;
  while (index < row.length) {
    if (row.charAt(index) === '\x1b') {
      const match = FRAME_SEQUENCE.exec(row.slice(index));
      const sequence = match ? match[0] : row.charAt(index);
      const forward = CURSOR_FORWARD.exec(sequence);
      const erase = ERASE_CHARACTERS.exec(sequence);
      if (forward) tokens.push({ forward: Math.max(1, Number.parseInt(forward[1] || '1', 10)) });
      else if (erase) tokens.push({ erase: Math.max(1, Number.parseInt(erase[1] || '1', 10)) });
      else tokens.push({ sequence });
      index += sequence.length;
    } else {
      let end = row.indexOf('\x1b', index);
      if (end === -1) end = row.length;
      tokens.push({ text: row.slice(index, end) });
      index = end;
    }
  }
  return tokens;
}

function renderTokens(tokens) {
  return tokens
    .map((token) => {
      if (token.text !== undefined) return token.text;
      if (token.forward !== undefined) return token.forward > 0 ? `\x1b[${token.forward}C` : '';
      if (token.erase !== undefined) return token.erase > 0 ? `\x1b[${token.erase}X` : '';
      return token.sequence;
    })
    .join('');
}

/** Cells a text run occupies: one per code point (see the header on why that is exact here). */
function textWidth(text) {
  return [...text].length;
}

function rowWidth(tokens) {
  return tokens.reduce((sum, token) => {
    if (token.text !== undefined) return sum + textWidth(token.text);
    if (token.forward !== undefined) return sum + token.forward;
    return sum;
  }, 0);
}

/**
 * The index of the last token that paints or moves (text, a gap, an erase) at
 * or before the given one, skipping style sequences; -1 when there is none.
 */
function paintingBefore(tokens, index) {
  for (let candidate = index; candidate >= 0; candidate -= 1) {
    if (tokens[candidate].sequence === undefined) return candidate;
  }
  return -1;
}

/** The cell a row's paint reaches: its width, or further when an erase paints ahead of the cursor. */
function paintedEnd(tokens) {
  let position = 0;
  let end = 0;
  for (const token of tokens) {
    if (token.text !== undefined) {
      position += textWidth(token.text);
      end = Math.max(end, position);
    } else if (token.forward !== undefined) position += token.forward;
    else if (token.erase !== undefined) end = Math.max(end, position + token.erase);
  }
  return end;
}

/** Whether a style other than the default is in force at a token. */
function styledAt(tokens, index) {
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const sequence = tokens[candidate].sequence;
    if (sequence === undefined || !/m$/.test(sequence)) continue;
    return sequence !== '\x1b[0m' && sequence !== '\x1b[m';
  }
  return false;
}

/**
 * A row as one item per character, gap, erase or style sequence, so a walk can
 * cross token boundaries. Characters are split by CODE POINT, so a glyph
 * outside the BMP is one item, never two halves of a surrogate pair.
 */
function rowItems(tokens) {
  const items = [];
  tokens.forEach((token, tokenIndex) => {
    if (token.text === undefined) {
      const kind = token.sequence !== undefined ? 'sequence' : token.forward !== undefined ? 'forward' : 'erase';
      items.push({ token: tokenIndex, kind });
      return;
    }
    let offset = 0;
    for (const character of token.text) {
      items.push({ token: tokenIndex, kind: 'character', offset, character });
      offset += character.length;
    }
  });
  return items;
}

function paintingItemBefore(items, position) {
  for (let index = position - 1; index >= 0; index -= 1) if (items[index].kind !== 'sequence') return index;
  return -1;
}

/**
 * Right-aligned text: walking left from the end of the row (or from before the
 * item at `end`), the tail's words and the one-cell steps between them, up to
 * the first gap TAIL_GAP_MIN or wider. A tail is a label, so it is at most half
 * the row. A gap with nothing on its left is indentation unless the tail is one
 * word. A tail ending in an ellipsis is text the CLI cut to fit. Returns the gap
 * to widen (a cursor-forward in it, or a space in it), or null, and null at a
 * vertical border, so a table's cells never trade width with each other.
 */
function tailGap(tokens, end, recordedColumns) {
  const items = rowItems(tokens);
  let run = 0;
  let seenTail = false;
  let tailWidth = 0;
  let tailWords = 1;
  let forwardToken = -1;
  let spaceItem = null;
  const found = () => {
    if (run < TAIL_GAP_MIN || tailWidth > recordedColumns / 2) return null;
    return forwardToken !== -1 ? { forward: forwardToken } : { space: spaceItem };
  };
  for (let index = (end === undefined ? items.length : end) - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'sequence') continue;
    if (item.kind === 'erase') return null;
    if (item.kind === 'forward' || item.character === ' ') {
      if (!seenTail) continue;
      if (item.kind === 'forward') {
        run += tokens[item.token].forward;
        if (forwardToken === -1) forwardToken = item.token;
      } else {
        run += 1;
        if (!spaceItem) spaceItem = item;
      }
      continue;
    }
    if (VERTICAL_EDGE_GLYPHS.includes(item.character)) return null;
    if (!seenTail && item.character === '…') return null;
    if (seenTail && run >= TAIL_GAP_MIN) return found();
    if (run > 0) tailWords += 1;
    tailWidth += run + 1;
    seenTail = true;
    run = 0;
    forwardToken = -1;
    spaceItem = null;
  }
  return tailWords === 1 ? found() : null;
}

/** Widen a gap tailGap found by `extra` cells, in place. */
function widenTailGap(tokens, gap, extra) {
  if (gap.forward !== undefined) {
    tokens[gap.forward].forward += extra;
    return;
  }
  const text = tokens[gap.space.token].text;
  tokens[gap.space.token].text = text.slice(0, gap.space.offset) + ' '.repeat(extra) + text.slice(gap.space.offset);
}

/**
 * A row that ends at the recorded edge in a right-hand border or scrollbar,
 * widened: the trailing CLUSTER (edge glyphs, and single spaces between them)
 * moves to the new edge, and the gap before it takes the extra cells. A gap
 * that is a background band grows its band, a cursor-forward grows, a rule
 * glyph right before the gap runs on (a box's top edge to its corner), and
 * otherwise blank cells go in at the gap's start, in the style in force there.
 * The walk stops at a gap, so a box's LEFT border is never part of the cluster.
 */
function widenAtEdge(tokens, extra, recordedColumns) {
  const items = rowItems(tokens);
  let clusterStart = items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'sequence') continue;
    if (item.kind !== 'character') break;
    if (VERTICAL_EDGE_GLYPHS.includes(item.character)) {
      clusterStart = index;
      continue;
    }
    const left = paintingItemBefore(items, index);
    if (
      item.character === ' ' &&
      clusterStart < items.length &&
      left !== -1 &&
      items[left].kind === 'character' &&
      VERTICAL_EDGE_GLYPHS.includes(items[left].character)
    ) {
      clusterStart = index;
      continue;
    }
    break;
  }
  let gapStart = clusterStart;
  let gapWidth = 0;
  let bandErase = -1;
  let lastForward = -1;
  for (let gapIndex = clusterStart - 1; gapIndex >= 0; gapIndex -= 1) {
    const gapItem = items[gapIndex];
    if (gapItem.kind === 'sequence') continue;
    if (gapItem.kind === 'character' && gapItem.character !== ' ') break;
    if (gapItem.kind === 'character') gapWidth += 1;
    if (gapItem.kind === 'forward') {
      gapWidth += tokens[gapItem.token].forward;
      if (lastForward === -1) lastForward = gapItem.token;
    }
    if (gapItem.kind === 'erase' && bandErase === -1) {
      const next = tokens[gapItem.token + 1];
      if (next && next.forward !== undefined) bandErase = gapItem.token;
    }
    gapStart = gapIndex;
  }
  const beforeGap = paintingItemBefore(items, gapStart);
  const ruleGlyph =
    beforeGap !== -1 &&
    items[beforeGap].kind === 'character' &&
    HORIZONTAL_RULE_GLYPHS.includes(items[beforeGap].character)
      ? items[beforeGap].character
      : '';
  // Text right-aligned against the border: the tail's own gap takes the extra
  // cells and the text stays against the edge. Two cells or more before a border
  // is a box's padding around content that stops there, which widens as any box does.
  if (!ruleGlyph && bandErase === -1 && gapWidth <= 1) {
    const tail = tailGap(tokens, gapStart, recordedColumns);
    if (tail) {
      widenTailGap(tokens, tail, extra);
      return renderTokens(tokens);
    }
  }
  if (!ruleGlyph && bandErase !== -1) {
    tokens[bandErase].erase += extra;
    tokens[bandErase + 1].forward += extra;
    return renderTokens(tokens);
  }
  if (!ruleGlyph && lastForward !== -1) {
    tokens[lastForward].forward += extra;
    return renderTokens(tokens);
  }
  const fill = ruleGlyph ? [{ text: ruleGlyph.repeat(extra) }] : [{ erase: extra }, { forward: extra }];
  // Split the row at the gap's start and put the fill there.
  const at = items[gapStart];
  const before = tokens.slice(0, at ? at.token : tokens.length);
  const after = at ? tokens.slice(at.token + 1) : [];
  if (at && at.kind === 'character') {
    const text = tokens[at.token].text;
    if (at.offset > 0) before.push({ text: text.slice(0, at.offset) });
    after.unshift({ text: text.slice(at.offset) });
  } else if (at) {
    after.unshift(tokens[at.token]);
  }
  return renderTokens(before.concat(fill, after));
}

/**
 * A row on a grid wider than the recording by `extra` columns, with what the
 * CLI draws to its edge drawn to the new one, or null when the row stays as it
 * was drawn.
 */
function widenRowTokens(tokens, extra, recordedColumns) {
  const lastIndex = paintingBefore(tokens, tokens.length - 1);
  if (lastIndex === -1) return null;
  const last = tokens[lastIndex];
  const width = rowWidth(tokens);
  const lastGlyph = last.text !== undefined && last.text.length > 0 ? [...last.text].pop() : '';
  // A right-hand border or scrollbar at the recorded edge, or inside the CLI's right padding.
  if (lastGlyph && width >= recordedColumns - TAIL_PADDING_MAX && VERTICAL_EDGE_GLYPHS.includes(lastGlyph)) {
    return widenAtEdge(tokens, extra, recordedColumns);
  }
  // A background band reaching the edge: an erase, or an erase and the gap that steps over it.
  let bandIndex = lastIndex;
  if (last.forward !== undefined) {
    const beforeGap = paintingBefore(tokens, lastIndex - 1);
    if (beforeGap !== -1 && tokens[beforeGap].erase !== undefined) bandIndex = beforeGap;
  }
  if (tokens[bandIndex].erase !== undefined && paintedEnd(tokens) >= recordedColumns - EDGE_SLACK) {
    tokens[bandIndex].erase += extra;
    if (bandIndex !== lastIndex) last.forward += extra;
    return renderTokens(tokens);
  }
  if (!lastGlyph) return null;
  // A horizontal rule the CLI drew to its edge runs on to the new one.
  if (width >= recordedColumns - EDGE_SLACK && HORIZONTAL_RULE_GLYPHS.includes(lastGlyph)) {
    last.text += lastGlyph.repeat(extra);
    return renderTokens(tokens);
  }
  // A styled panel's padding (spaces under a background) runs on.
  if (width >= recordedColumns - EDGE_SLACK && lastGlyph === ' ' && styledAt(tokens, lastIndex)) {
    last.text += ' '.repeat(extra);
    return renderTokens(tokens);
  }
  // A right-aligned label moves out to the new edge.
  if (width >= recordedColumns - TAIL_PADDING_MAX && width < recordedColumns) {
    const gap = tailGap(tokens, undefined, recordedColumns);
    if (gap) {
      widenTailGap(tokens, gap, extra);
      return renderTokens(tokens);
    }
  }
  return null;
}

/** One physical row fitted to a grid `extra` columns wider than the one it was recorded at. */
export function widenRow(row, extra, recordedColumns) {
  const tokens = tokenizeRow(row);
  const width = rowWidth(tokens);
  if (width > recordedColumns) {
    throw new Error(`a ${width}-cell row cannot have been recorded at ${recordedColumns} columns`);
  }
  if (extra === 0) return row;
  return widenRowTokens(tokens, extra, recordedColumns) ?? row;
}

/**
 * A physical-row frame fitted to a WIDER grid with the same rows. Rows are
 * written with autowrap off, then the cursor is put back where the CLI left it.
 * A narrower or differently tall grid is refused: this repo has no use for
 * either, and cutting or inserting rows is a different, unported algorithm.
 */
export function widenFrame(frame, grid, recorded) {
  if (grid.rows !== recorded.rows) {
    throw new Error(`widenFrame keeps the row count: grid ${grid.rows} rows, recorded ${recorded.rows}`);
  }
  if (grid.cols < recorded.cols) {
    throw new Error(`widenFrame only widens: grid ${grid.cols} columns, recorded ${recorded.cols}`);
  }
  const parsed = parsePhysicalFrame(frame);
  if (parsed.cursor === null) throw new Error('not a physical-row frame: it has no trailing cursor position');
  const extra = grid.cols - recorded.cols;
  const rows = parsed.rows.map((row) => widenRow(row, extra, recorded.cols));
  return (
    (parsed.isAlternate ? ALT_PREFIX : '') +
    AUTOWRAP_OFF +
    rows.join('\r\n') +
    AUTOWRAP_ON +
    `\x1b[${parsed.cursor.row + 1};${parsed.cursor.column + 1}H`
  );
}
