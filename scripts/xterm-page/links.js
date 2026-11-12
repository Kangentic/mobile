  /**
   * TAPPABLE LINKS (task #144). Agents print links a person has to open: a
   * design review page, a pull request, a CI run. The desktop opens a URL it
   * finds in the SCREEN TEXT (kangentic 44ea91522,
   * src/renderer/utils/terminal-links/), including one a TUI wrapped across
   * indented rows itself, and it strips OSC 8 from this page's feed while
   * keeping the labels. So this page finds links the same way, in the cells,
   * never in an escape sequence. Ported from the desktop's parse-links.ts and
   * buffer-line-text.ts, with three forced deviations:
   *  - https only. src/lib/httpsUrl.ts is the app's one opener rule (the
   *    Chat lens's links use it too), and an http link an agent prints is
   *    nearly always a dev server on the desktop's own localhost, which on the
   *    phone is the phone. The host applies the same rule to whatever this
   *    page posts, and THAT check is the security boundary, not this one; the
   *    two agree so that nothing is underlined that a tap will not open.
   *  - no file paths: on the phone they name files on another machine.
   *  - no hover and no modifier: a TAP opens a link (bootstrap.js), because
   *    a tap on a link writes nothing to the PTY (postCleanTap cancels its
   *    touchend). A tap off a link is the plain tap it always was.
   *
   * One finder (findLinksInRows) feeds both consumers, so what is underlined
   * is exactly what a tap opens: the underline overlay, redrawn from
   * xterm's onRender (which fires at most once a frame, read from xterm's
   * RenderDebouncer: every refresh is batched into one requestAnimationFrame),
   * and the tap hit test, which reads the buffer afresh when a finger lands.
   *
   * Everything below runs on agent-printed text. Each pattern is linear (a
   * negated character class with no nested repetition), and trailing
   * punctuation is dropped by a loop from the end rather than an end-anchored
   * regex, which backtracks quadratically over a long run of it. The trim of a
   * run of closers is not linear, and a logical line's length bounds it.
   */
  // Whitespace, quotes and angle brackets, and the box-drawing, block and
  // geometric glyphs TUIs draw borders and bullets with (U+23A0-U+23FF,
  // U+2500-U+25FF).
  var LINK_TOKEN_EXCLUDED = '\\s"\'`<>|\\u23a0-\\u23ff\\u2500-\\u25ff';
  var LINK_URL_PATTERN = new RegExp('https://[^' + LINK_TOKEN_EXCLUDED + ']+', 'gi');
  var LINK_TRAILING_PUNCTUATION = '.,;:!?';
  var LINK_OPENERS = '([{';
  var LINK_CLOSERS = ')]}';
  // How far a logical line reaches each way from the row it is read from. An
  // agent TUI pads every row to the full width and reaches the next by
  // autowrap, so a whole screen can read as one wrapped line.
  var LINK_MAX_WRAPPED_ROWS_EACH_WAY = 4;
  // A TUI's text column can stop short of the grid or its own border: Claude
  // Code's prompt echo wraps one cell before the edge, Copilot's seven cells
  // before its panel border. So the margin is wide, and
  // linkContinuesOnNextRow pairs it with the test a wrap has to pass: the word
  // below must not have fit in the gap.
  var LINK_WRAP_MARGIN_CELLS = 12;
  // The indent a TUI puts on a wrapped row. A deeper one is a different block.
  var LINK_MAX_CONTINUATION_INDENT = 8;
  var LINK_CHARACTER = /[A-Za-z0-9\-._~:/\\?#[\]@!$&'()*+,;=%]/;
  // How far past a link a tap still opens it, above and below. A row is about
  // 13 px at the reference cell, far under a 44 pt touch target, so the reach
  // is a row's worth either side (approved on the design review, task #144).
  // Sideways it is one cell, which scales with a pinch.
  var LINK_TAP_REACH_PX = 12;
  // The underline is a hairline in the link's own text colour at this
  // opacity, and the press tint the theme's accent at this one.
  var LINK_UNDERLINE_OPACITY = 0.7;
  var LINK_PRESS_TINT_OPACITY = 0.32;
  // xterm's 16 ANSI palette entries, by the ITheme keys the host sends.
  var LINK_ANSI_THEME_KEYS = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ];
  var LINK_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

  // Off only under the retention probe's control arm (the host's init says
  // terminalLinks: false): no underline, and a tap is a plain tap again.
  var terminalLinksEnabled = true;
  // True only under the probe's other control arm (the init's linkOverlay is
  // 'rebuild'): the overlay rebuilds every element whenever a link changes,
  // as it first shipped, instead of moving reused ones.
  var linkOverlayRebuild = false;
  var linkOverlayElement = null;
  // What the overlay currently draws, so a frame whose links did not change
  // touches no DOM at all.
  var linkOverlaySignature = '';
  // The reused underline and tint elements, in drawing order, each with the
  // style it last wrote (see writeLinkOverlaySlots).
  var linkOverlaySlots = [];
  var LINK_HIDDEN_SLOT_CSS = 'display:none;';
  // The link a finger is on right now (tinted), or null. Set at touchstart,
  // dropped by anything that makes the gesture not a tap.
  var pressedLink = null;
  // Probe counters: what the scan costs and how often a tap opened a link.
  var linkStats = { scans: 0, lastScanMs: null, maxScanMs: 0, totalScanMs: 0, visible: 0, opened: 0 };
  // The same cost per WINDOW, for a release build (task #147): linkStats
  // above lives for the whole page and only the dev probe can read it. When
  // an init asks (linkStatsWindowMs, which the host sets only in a
  // connection-trace build), the page posts these counts every window and
  // starts the next from zero, so each arm of an A/B reads its own numbers.
  // `renders` counts every xterm render with links on or off, so both arms
  // show they streamed at the same rate; `overlayWrites` counts the renders
  // that rebuilt the underlines' DOM. Counts and milliseconds only: never a
  // URL or any text from the screen.
  var linkWindowStats = freshLinkWindowStats();
  var linkStatsWindowTimer = null;

  /** The text without its run of trailing punctuation, scanned back from the end so it stays linear. */
  function dropLinkTrailingPunctuation(text) {
    var end = text.length;
    while (end > 0 && LINK_TRAILING_PUNCTUATION.indexOf(text.charAt(end - 1)) !== -1) end -= 1;
    return end === text.length ? text : text.slice(0, end);
  }

  function trimLinkTrailing(text) {
    var trimmed = dropLinkTrailingPunctuation(text);
    // A closer with no opener in the text belongs to the prose around it.
    while (trimmed.length > 0) {
      var closerIndex = LINK_CLOSERS.indexOf(trimmed.charAt(trimmed.length - 1));
      if (closerIndex === -1) break;
      var openerCount = trimmed.split(LINK_OPENERS.charAt(closerIndex)).length;
      var closerCount = trimmed.split(LINK_CLOSERS.charAt(closerIndex)).length;
      if (openerCount >= closerCount) break;
      trimmed = dropLinkTrailingPunctuation(trimmed.slice(0, -1));
    }
    return trimmed;
  }

  /** Every https URL in one logical line, as half-open string ranges. */
  function parseHttpsUrls(text) {
    var urls = [];
    LINK_URL_PATTERN.lastIndex = 0;
    var match = LINK_URL_PATTERN.exec(text);
    while (match !== null) {
      var url = trimLinkTrailing(match[0]);
      // A bare scheme, or one whose host was all punctuation.
      if (/^https:\/\/[^/?#]/i.test(url)) urls.push({ url: url, start: match.index, end: match.index + url.length });
      match = LINK_URL_PATTERN.exec(text);
    }
    return urls;
  }

  /**
   * A row's cells with the width the terminal assigned each. The second cell
   * of a wide glyph has width 0 and contributes no text; an empty cell reads
   * as a space. One cell object is reused across the row.
   */
  function readLinkRow(line) {
    var cells = [];
    var cell;
    for (var column = 0; column < line.length; column += 1) {
      cell = line.getCell(column, cell) || undefined;
      if (!cell) continue;
      var width = cell.getWidth();
      if (width === 0) continue;
      cells.push({ chars: cell.getChars() || ' ', column: column, width: width });
    }
    return cells;
  }

  /** Blank, or a line a TUI draws around its text, which is never part of a link. */
  function isLinkFrameCell(cell) {
    return cell.chars === ' ' || /^[\u2500-\u257f]$/.test(cell.chars);
  }

  function firstLinkInkIndex(cells) {
    for (var index = 0; index < cells.length; index += 1) {
      if (!isLinkFrameCell(cells[index])) return index;
    }
    return -1;
  }

  function lastLinkInkIndex(cells) {
    for (var index = cells.length - 1; index >= 0; index -= 1) {
      if (!isLinkFrameCell(cells[index])) return index;
    }
    return -1;
  }

  /** Where a row's text area ends: the grid's edge, or a border drawn at the right of it. */
  function linkTextAreaEnd(cells, columns) {
    for (var index = cells.length - 1; index >= 0; index -= 1) {
      if (cells[index].chars === ' ') continue;
      return isLinkFrameCell(cells[index]) ? cells[index].column : columns;
    }
    return columns;
  }

  /**
   * Whether a TUI wrapped a link from this row onto the next. The row's text
   * runs close to its edge, its last word carries a path separator, and the
   * next row opens, at a small indent, with a word that could not have fit in
   * the gap left on this row. That last test tells a break in the middle of a
   * long word from a line that simply ends in a URL; the separator keeps
   * ordinary wrapped prose apart, since two wrapped words must not read as one.
   */
  function linkContinuesOnNextRow(buffer, row, columns, rowsBack) {
    var line = buffer.getLine(row);
    var nextLine = buffer.getLine(row + 1);
    if (!line || !nextLine || nextLine.isWrapped) return false;

    var cells = readLinkRow(line);
    var last = lastLinkInkIndex(cells);
    if (last === -1) return false;
    var gap = linkTextAreaEnd(cells, columns) - (cells[last].column + cells[last].width);
    if (gap > LINK_WRAP_MARGIN_CELLS) return false;
    var wordStart = last;
    while (wordStart > 0 && !isLinkFrameCell(cells[wordStart - 1])) wordStart -= 1;
    var holdsSeparator = false;
    for (var index = wordStart; index <= last; index += 1) {
      if (cells[index].chars === '/' || cells[index].chars === '\\') {
        holdsSeparator = true;
        break;
      }
    }
    // A middle row of a long URL may hold no separator of its own. It counts
    // when the whole row is that one word, carried on from the row above.
    var depth = rowsBack || 0;
    var isWholeRowOfALink =
      !holdsSeparator &&
      wordStart === firstLinkInkIndex(cells) &&
      row > 0 &&
      depth < LINK_MAX_WRAPPED_ROWS_EACH_WAY &&
      linkContinuesOnNextRow(buffer, row - 1, columns, depth + 1);
    if (!holdsSeparator && !isWholeRowOfALink) return false;

    var nextCells = readLinkRow(nextLine);
    var first = firstLinkInkIndex(nextCells);
    if (first === -1 || nextCells[first].column > LINK_MAX_CONTINUATION_INDENT) return false;
    if (!LINK_CHARACTER.test(nextCells[first].chars)) return false;
    var nextWordLength = 0;
    for (var nextIndex = first; nextIndex < nextCells.length && !isLinkFrameCell(nextCells[nextIndex]); nextIndex += 1) {
      nextWordLength += 1;
    }
    return nextWordLength > gap;
  }

  /**
   * A row and the rows that continue it, as one string, with the cell each
   * UTF-16 code unit came from. Two things continue a row: a soft wrap
   * (isWrapped), and a TUI's own wrap, which keeps neither the padding at the
   * end of a row nor the indent at the start of the next.
   */
  function readLinkLogicalLine(buffer, row, columns) {
    var joinsNext = function (fromRow) {
      var following = buffer.getLine(fromRow + 1);
      return (following && following.isWrapped === true) || linkContinuesOnNextRow(buffer, fromRow, columns, 0);
    };

    var firstRow = row;
    while (row - firstRow < LINK_MAX_WRAPPED_ROWS_EACH_WAY && firstRow > 0 && joinsNext(firstRow - 1)) firstRow -= 1;
    var lastRow = row;
    while (lastRow - row < LINK_MAX_WRAPPED_ROWS_EACH_WAY && joinsNext(lastRow)) lastRow += 1;

    var parts = [];
    var cellOf = [];
    for (var currentRow = firstRow; currentRow <= lastRow; currentRow += 1) {
      var line = buffer.getLine(currentRow);
      if (!line) continue;
      var cells = readLinkRow(line);
      var nextLine = buffer.getLine(currentRow + 1);
      var fromTuiWrap = currentRow > firstRow && !line.isWrapped;
      var intoTuiWrap = currentRow < lastRow && !(nextLine && nextLine.isWrapped === true);
      var start = fromTuiWrap ? Math.max(firstLinkInkIndex(cells), 0) : 0;
      var end = intoTuiWrap ? lastLinkInkIndex(cells) + 1 : cells.length;
      for (var cellIndex = start; cellIndex < end; cellIndex += 1) {
        var cell = cells[cellIndex];
        parts.push(cell.chars);
        for (var unit = 0; unit < cell.chars.length; unit += 1) {
          cellOf.push({ row: currentRow, column: cell.column, width: cell.width });
        }
      }
    }
    return { text: parts.join(''), cellOf: cellOf, firstRow: firstRow, lastRow: lastRow };
  }

  /**
   * The cells a half-open string range covers, one segment per buffer row:
   * startColumn inclusive, endColumn exclusive (a wide last glyph ends past
   * its second cell).
   */
  function linkSegmentsOf(logicalLine, start, end) {
    var segments = [];
    var current = null;
    for (var index = start; index < end; index += 1) {
      var origin = logicalLine.cellOf[index];
      if (!origin) continue;
      if (current === null || current.bufferRow !== origin.row) {
        current = { bufferRow: origin.row, startColumn: origin.column, endColumn: origin.column + origin.width };
        segments.push(current);
      } else if (origin.column + origin.width > current.endColumn) {
        current.endColumn = origin.column + origin.width;
      }
    }
    return segments;
  }

  /** Whether a row could hold the start of an https link, read as plain text first because most rows hold none. */
  function rowMayHoldLink(buffer, row) {
    var line = buffer.getLine(row);
    if (!line) return false;
    var text = line.translateToString(true);
    // A soft wrap can split the scheme itself across the row break.
    var following = buffer.getLine(row + 1);
    if (following && following.isWrapped) text += following.translateToString(true).slice(0, 8);
    return text.toLowerCase().indexOf('https://') !== -1;
  }

  /**
   * The https links whose cells show in rows [firstVisibleRow, firstVisibleRow
   * + rowCount) of a buffer, each with its on-screen segments: `row` is the
   * VIEWPORT row (0 = the top of the screen). A link that starts in the rows
   * just above the screen and wraps onto it is found too.
   */
  function findLinksInRows(buffer, firstVisibleRow, rowCount, columns) {
    var links = [];
    var seen = {};
    var lastVisibleRow = firstVisibleRow + rowCount - 1;
    var readThroughRow = -1;
    for (var row = Math.max(0, firstVisibleRow - LINK_MAX_WRAPPED_ROWS_EACH_WAY); row <= lastVisibleRow; row += 1) {
      if (row <= readThroughRow) continue;
      if (!rowMayHoldLink(buffer, row)) continue;
      var logicalLine = readLinkLogicalLine(buffer, row, columns);
      readThroughRow = logicalLine.lastRow;
      var urls = parseHttpsUrls(logicalLine.text);
      for (var urlIndex = 0; urlIndex < urls.length; urlIndex += 1) {
        var parsed = urls[urlIndex];
        var allSegments = linkSegmentsOf(logicalLine, parsed.start, parsed.end);
        if (allSegments.length === 0) continue;
        var key = parsed.url + '@' + allSegments[0].bufferRow + ':' + allSegments[0].startColumn;
        if (seen[key]) continue;
        seen[key] = true;
        var visibleSegments = [];
        for (var segmentIndex = 0; segmentIndex < allSegments.length; segmentIndex += 1) {
          var segment = allSegments[segmentIndex];
          if (segment.bufferRow < firstVisibleRow || segment.bufferRow > lastVisibleRow) continue;
          visibleSegments.push({
            row: segment.bufferRow - firstVisibleRow,
            bufferRow: segment.bufferRow,
            startColumn: segment.startColumn,
            endColumn: segment.endColumn,
          });
        }
        if (visibleSegments.length > 0) links.push({ url: parsed.url, key: key, segments: visibleSegments });
      }
    }
    return links;
  }

  /**
   * The link a tap at (pointX, pointY), in px from the grid's top-left,
   * opens: the nearest one whose cells lie within LINK_TAP_REACH_PX above or
   * below and one cell either side, or null. Nearest wins, so two links on
   * adjacent rows split the space between them.
   */
  function linkAtPoint(links, pointX, pointY, cellWidthPx, cellHeightPx) {
    var nearest = null;
    var nearestDistance = Infinity;
    for (var linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
      var segments = links[linkIndex].segments;
      for (var segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        var segment = segments[segmentIndex];
        var left = segment.startColumn * cellWidthPx;
        var right = segment.endColumn * cellWidthPx;
        var top = segment.row * cellHeightPx;
        var bottom = top + cellHeightPx;
        var horizontalGap = Math.max(left - pointX, 0, pointX - right);
        var verticalGap = Math.max(top - pointY, 0, pointY - bottom);
        if (horizontalGap > cellWidthPx || verticalGap > LINK_TAP_REACH_PX) continue;
        var distance = horizontalGap * horizontalGap + verticalGap * verticalGap;
        if (distance < nearestDistance) {
          nearest = links[linkIndex];
          nearestDistance = distance;
        }
      }
    }
    return nearest;
  }

  /** The links on screen right now. */
  function visibleTerminalLinks() {
    if (!terminal || !terminalLinksEnabled || terminal.cols < 1 || terminal.rows < 1) return [];
    var buffer = terminal.buffer.active;
    return findLinksInRows(buffer, buffer.viewportY, terminal.rows, terminal.cols);
  }

  /**
   * The link under a touch, in client coordinates, among `links` (the caller's
   * one scan, so the hit test and the tint it draws read the same screen). One
   * rect answers for the horizontal pan, the vertical follow translate and a
   * pinch alike: the grid's own box is where xterm drew every cell.
   */
  function linkAtClientPoint(links, clientX, clientY) {
    // No link on screen, and so no layout read. visibleTerminalLinks returns
    // none without a terminal, with links off or with an empty grid, so a
    // non-empty list also means the grid below has columns and rows.
    if (links.length === 0) return null;
    var screen = document.querySelector('.xterm-screen');
    if (!screen) return null;
    var rect = screen.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return linkAtPoint(
      links,
      clientX - rect.left,
      clientY - rect.top,
      rect.width / terminal.cols,
      rect.height / terminal.rows
    );
  }

  /** A cell's foreground as CSS, resolved against the theme the host sent. */
  function linkCellColor(cell) {
    var theme = (terminal && terminal.options.theme) || {};
    var fallback = theme.foreground || '#ffffff';
    if (!cell || cell.isFgDefault()) return fallback;
    var color = cell.getFgColor();
    if (cell.isFgRGB()) return '#' + ('000000' + color.toString(16)).slice(-6);
    if (!cell.isFgPalette()) return fallback;
    if (color < 16) return theme[LINK_ANSI_THEME_KEYS[color]] || fallback;
    if (color < 232) {
      var cubeIndex = color - 16;
      return (
        'rgb(' +
        LINK_CUBE_LEVELS[Math.floor(cubeIndex / 36)] + ',' +
        LINK_CUBE_LEVELS[Math.floor(cubeIndex / 6) % 6] + ',' +
        LINK_CUBE_LEVELS[cubeIndex % 6] + ')'
      );
    }
    var gray = 8 + (color - 232) * 10;
    return 'rgb(' + gray + ',' + gray + ',' + gray + ')';
  }

  /**
   * The overlay the underlines draw in: a layer inside xterm's own screen
   * element, sized in percent of the grid, so a pinch or a pan moves it with
   * the text and needs no redraw. z-index 2 puts it over the renderer's canvas
   * and under the frame hold (lifecycle.js, z-index 3), which covers the grid
   * during a swap. A hard re-init empties the grid host, so a detached overlay
   * is simply made again.
   */
  function ensureLinkOverlay() {
    if (linkOverlayElement && linkOverlayElement.isConnected) return linkOverlayElement;
    var screen = document.querySelector('.xterm-screen');
    if (!screen) return null;
    var overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:2;';
    screen.appendChild(overlay);
    linkOverlayElement = overlay;
    linkOverlaySignature = '';
    linkOverlaySlots = [];
    return overlay;
  }

  function linkPercent(count, total) {
    return (count / total) * 100 + '%';
  }

  function linkSegmentBox(segment, rows, cols) {
    return (
      'position:absolute;box-sizing:border-box;' +
      'left:' + linkPercent(segment.startColumn, cols) + ';' +
      'width:' + linkPercent(segment.endColumn - segment.startColumn, cols) + ';' +
      'top:' + linkPercent(segment.row, rows) + ';' +
      'height:' + linkPercent(1, rows) + ';'
    );
  }

  /** The press tint's colour: the theme's accent, as the cursor draws it. */
  function linkTintColor(theme) {
    return theme.cursor || '#e8a33d';
  }

  /**
   * What a box draws, shared by the slots and the rebuild arm so the A/B
   * compares how boxes are placed and never how they look: the press tint
   * fills its box, an underline is its bottom border.
   */
  function linkPaintCss(tint, color) {
    return tint
      ? 'background:' + color + ';opacity:' + LINK_PRESS_TINT_OPACITY + ';'
      : 'border-bottom:1px solid ' + color + ';opacity:' + LINK_UNDERLINE_OPACITY + ';';
  }

  /**
   * One box's style for a REUSED slot (see writeLinkOverlaySlots). The box is
   * one cell wide and one row tall, moved by a translate in units of its own
   * size, so in cells and rows, and stretched across its segment by a scaleX
   * from its left edge. A horizontal stretch leaves a 1px border 1px tall, so
   * it draws what linkSegmentBox draws. will-change gives each box its own
   * compositor layer. A moved box gets its whole style string again, but the
   * only declaration that differs is the transform, which (inferred from how
   * compositing works, not measured on its own) the GPU applies as a move
   * with nothing repainted.
   */
  function linkSlotCss(box, rows, cols) {
    return (
      'position:absolute;left:0;top:0;box-sizing:border-box;transform-origin:0 0;will-change:transform;' +
      'width:' + linkPercent(1, cols) + ';' +
      'height:' + linkPercent(1, rows) + ';' +
      'transform:translate(' + box.startColumn * 100 + '%,' + box.row * 100 + '%) scaleX(' + (box.endColumn - box.startColumn) + ');' +
      linkPaintCss(box.tint, box.color)
    );
  }

  /**
   * The boxes in drawing order: per segment, the press tint (pressed link
   * only), then the underline over it. Elements later in the DOM draw on top,
   * so this order is what keeps the underline visible over the tint.
   */
  function linkOverlayBoxes(drawn, theme) {
    var boxes = [];
    for (var drawnIndex = 0; drawnIndex < drawn.length; drawnIndex += 1) {
      var item = drawn[drawnIndex];
      var segment = item.segment;
      if (item.pressed) {
        boxes.push({ tint: true, color: linkTintColor(theme), row: segment.row, startColumn: segment.startColumn, endColumn: segment.endColumn });
      }
      boxes.push({ tint: false, color: item.color, row: segment.row, startColumn: segment.startColumn, endColumn: segment.endColumn });
    }
    return boxes;
  }

  /**
   * Draw the boxes into the reused slots: a slot whose style did not change is
   * not touched, a slot is created only when more boxes show than ever have,
   * and a slot left over is hidden rather than removed. A scrolling stream
   * moves every link on every write, and rebuilding the underlines for each
   * one read the WebView's GPU thread in the APP process at 15-19% of a core
   * against 2-4% without links (measured, task #147, docs/architecture.md: a
   * release build on an emulator whose GPU work is translated to the host's,
   * one diagnostic thread sample of 6 readings per arm).
   */
  function writeLinkOverlaySlots(overlay, boxes, rows, cols) {
    for (var boxIndex = 0; boxIndex < boxes.length; boxIndex += 1) {
      var slot = linkOverlaySlots[boxIndex];
      if (!slot) {
        slot = { element: document.createElement('div'), css: '' };
        overlay.appendChild(slot.element);
        linkOverlaySlots.push(slot);
      }
      var css = linkSlotCss(boxes[boxIndex], rows, cols);
      if (css !== slot.css) {
        slot.element.style.cssText = css;
        slot.css = css;
      }
    }
    for (var spareIndex = boxes.length; spareIndex < linkOverlaySlots.length; spareIndex += 1) {
      var spare = linkOverlaySlots[spareIndex];
      if (spare.css !== LINK_HIDDEN_SLOT_CSS) {
        spare.element.style.cssText = LINK_HIDDEN_SLOT_CSS;
        spare.css = LINK_HIDDEN_SLOT_CSS;
      }
    }
  }

  /**
   * The retention probe's control arm for the slots (`rebuilt-link-overlay`):
   * the overlay as it first shipped, every element thrown away and made again
   * whenever any link changed.
   */
  function rebuildLinkOverlay(overlay, drawn, rows, cols, theme) {
    linkOverlaySlots = [];
    overlay.textContent = '';
    for (var drawnIndex = 0; drawnIndex < drawn.length; drawnIndex += 1) {
      var item = drawn[drawnIndex];
      var boxCss = linkSegmentBox(item.segment, rows, cols);
      if (item.pressed) {
        var tint = document.createElement('div');
        tint.style.cssText = boxCss + linkPaintCss(true, linkTintColor(theme));
        overlay.appendChild(tint);
      }
      var underline = document.createElement('div');
      underline.style.cssText = boxCss + linkPaintCss(false, item.color);
      overlay.appendChild(underline);
    }
  }

  /** Draw an underline under every segment, and the press tint under the pressed link's. */
  function renderLinkOverlay(links) {
    if (!terminal) return;
    var rows = terminal.rows;
    var cols = terminal.cols;
    var buffer = terminal.buffer.active;
    var theme = terminal.options.theme || {};
    var pressedKey = pressedLink !== null ? pressedLink.key : null;
    var drawn = [];
    var signature = rows + 'x' + cols + '|' + (pressedKey || '');
    for (var linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
      var link = links[linkIndex];
      for (var segmentIndex = 0; segmentIndex < link.segments.length; segmentIndex += 1) {
        var segment = link.segments[segmentIndex];
        var line = buffer.getLine(segment.bufferRow);
        var color = linkCellColor(line ? line.getCell(segment.startColumn) : null);
        var pressed = link.key === pressedKey;
        drawn.push({ segment: segment, color: color, pressed: pressed });
        signature += '|' + segment.row + ':' + segment.startColumn + '-' + segment.endColumn + ':' + color + (pressed ? '*' : '');
      }
    }
    if (drawn.length === 0 && linkOverlayElement === null) return;
    if (signature === linkOverlaySignature && linkOverlayElement && linkOverlayElement.isConnected) return;
    var overlay = ensureLinkOverlay();
    if (!overlay) return;
    linkOverlaySignature = signature;
    linkWindowStats.overlayWrites += 1;
    if (linkOverlayRebuild) rebuildLinkOverlay(overlay, drawn, rows, cols, theme);
    else writeLinkOverlaySlots(overlay, linkOverlayBoxes(drawn, theme), rows, cols);
  }

  /** Rescan the screen and redraw the overlay. Runs from xterm's onRender, so at most once a frame. */
  function refreshTerminalLinks() {
    if (!terminal) return;
    // Counted before the switch below, so the control arm reports its renders too.
    linkWindowStats.renders += 1;
    // Off (the probe's control arm): the init that turned links off already
    // cleared the overlay, and nothing is scanned.
    if (!terminalLinksEnabled) return;
    var startedAt = performance.now();
    var links = visibleTerminalLinks();
    renderLinkOverlay(links);
    var elapsedMs = performance.now() - startedAt;
    linkStats.scans += 1;
    linkStats.lastScanMs = Math.round(elapsedMs * 100) / 100;
    linkStats.totalScanMs += elapsedMs;
    if (elapsedMs > linkStats.maxScanMs) linkStats.maxScanMs = elapsedMs;
    linkStats.visible = links.length;
    linkWindowStats.scans += 1;
    linkWindowStats.scanMsTotal += elapsedMs;
    if (elapsedMs > linkWindowStats.scanMsMax) linkWindowStats.scanMsMax = elapsedMs;
    linkWindowStats.visible = links.length;
  }

  function freshLinkWindowStats() {
    return { startedAt: performance.now(), renders: 0, scans: 0, scanMsTotal: 0, scanMsMax: 0, overlayWrites: 0, visible: 0 };
  }

  function roundLinkMs(milliseconds) {
    return Math.round(milliseconds * 100) / 100;
  }

  /** Post this window's counts and start the next one from zero. */
  function reportLinkWindowStats() {
    var finished = linkWindowStats;
    linkWindowStats = freshLinkWindowStats();
    postToHost({
      type: 'link-stats',
      windowMs: Math.round(linkWindowStats.startedAt - finished.startedAt),
      renders: finished.renders,
      scans: finished.scans,
      scanMsTotal: roundLinkMs(finished.scanMsTotal),
      scanMsMax: roundLinkMs(finished.scanMsMax),
      overlayWrites: finished.overlayWrites,
      visible: finished.visible,
    });
  }

  /**
   * Every init: stop the last init's report timer, start a fresh window, and
   * report every `windowMs` when the host asked for it (0 or absent: never,
   * which is every build without the connection trace).
   */
  function armLinkStatsWindow(windowMs) {
    if (linkStatsWindowTimer !== null) clearInterval(linkStatsWindowTimer);
    linkStatsWindowTimer = null;
    linkWindowStats = freshLinkWindowStats();
    if (typeof windowMs === 'number' && windowMs > 0) linkStatsWindowTimer = setInterval(reportLinkWindowStats, windowMs);
  }

  /** Drop every underline and any press (every init, before the new grid's first render). */
  function clearTerminalLinks() {
    pressedLink = null;
    linkOverlaySignature = '';
    linkOverlaySlots = [];
    if (linkOverlayElement && linkOverlayElement.firstChild) linkOverlayElement.textContent = '';
  }

  /** A finger landed: tint the link under it, if any, so the user sees what a tap would open. */
  function pressLinkAt(clientX, clientY) {
    var links = visibleTerminalLinks();
    pressedLink = linkAtClientPoint(links, clientX, clientY);
    if (pressedLink !== null) renderLinkOverlay(links);
  }

  /** The gesture stopped being a tap (moved, a second finger, a pinch, a cancel) or ended. */
  function releaseLinkPress() {
    if (pressedLink === null) return;
    pressedLink = null;
    renderLinkOverlay(visibleTerminalLinks());
  }

  /**
   * A clean tap ended. On a link it opens the link and is nothing else: the
   * touchend is cancelled, so no compatibility mouse event follows it into
   * xterm (whose mouse reporting would write a click to the PTY) or into the
   * container's focus click (which would raise the keyboard). Anywhere else it
   * is the plain tap that toggles the keyboard, as before.
   */
  function postCleanTap(touchEvent) {
    if (pressedLink !== null) {
      if (touchEvent && typeof touchEvent.preventDefault === 'function') touchEvent.preventDefault();
      linkStats.opened += 1;
      postToHost({ type: 'open-link', url: pressedLink.url });
      return;
    }
    postToHost({ type: 'tapped' });
  }
