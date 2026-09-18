  /**
   * Report the STICKY modes whenever any of them flips.
   *
   * DECCKM drives the quick keys' arrow encoding. The other three exist so the
   * host can REPLAY them: a TUI asserts its modes once at startup and never
   * again, the phone's feed ring evicts those bytes within a few hundred KB,
   * and every later re-init would otherwise render into a different state than
   * the desktop PTY (see src/terminal/modeRestore.ts). This reports PARSED
   * truth, which is why it lives here and not in a scan of the byte stream -
   * a DECSET can arrive split across two chunks.
   */
  function reportModesIfFlipped() {
    if (!terminal || !terminal.modes) return;
    var appCursor = terminal.modes.applicationCursorKeysMode === true;
    var next = {
      type: 'modes',
      applicationCursorKeys: appCursor,
      mouseTrackingMode: terminal.modes.mouseTrackingMode || 'none',
      mouseEncoding: coreMouseEncoding().encoding,
      alternateBuffer: terminal.buffer.active.type === 'alternate',
      // The FIRST report after a (re-)init is a baseline, not a transition: it
      // describes whatever the replayed seed happened to establish. Only a
      // later report reflects the desktop actually changing a mode. The host
      // needs the difference - a baseline that says "no mouse reporting"
      // because the seed lacked the DECSETs must not be allowed to overwrite
      // the modes it is holding in order to restore them, which would latch the
      // degraded state in permanently.
      initial: lastReportedModes === null,
    };
    if (
      lastReportedModes !== null &&
      lastReportedModes.applicationCursorKeys === next.applicationCursorKeys &&
      lastReportedModes.mouseTrackingMode === next.mouseTrackingMode &&
      lastReportedModes.mouseEncoding === next.mouseEncoding &&
      lastReportedModes.alternateBuffer === next.alternateBuffer
    ) {
      return;
    }
    lastReportedModes = next;
    lastAppCursorMode = appCursor;
    postToHost(next);
  }

  /**
   * Whether the VIEWPORT rows hold no visible glyph at all: the cell text of
   * every row, right-trimmed, is empty. Reads the parsed buffer, never the
   * bytes. An escape-only seed (a fresh PTY's alternate-screen switch, a
   * clear) parses to a blank grid, and nothing about its byte length says so.
   */
  function visibleGridIsBlank() {
    var buffer = terminal.buffer.active;
    for (var row = 0; row < terminal.rows; row += 1) {
      var line = buffer.getLine(buffer.viewportY + row);
      if (line && line.translateToString(true).trim().length > 0) return false;
    }
    return true;
  }

  /**
   * Report the first PAINT after a (re-)init: once right after the init's seed
   * has flushed (blank or not), then once more on the first write that leaves
   * visible glyphs, after which the page stays quiet until the next init. The
   * host holds its session-swap veil on this: the successor's frame is "on
   * screen" once a non-blank report arrives, never merely once its init was
   * posted.
   *
   * One frame later rather than inline: the write callback fires once the
   * bytes are PARSED, and the renderer draws them on the next animation frame.
   * "Painted" is inferred from that ordering, not measured.
   */
  function reportPaintedIfAwaiting(afterInit) {
    if (!terminal || !awaitingNonBlankPaint) return;
    var blank = visibleGridIsBlank();
    if (blank && !afterInit) return;
    if (!blank) awaitingNonBlankPaint = false;
    var seq = activeInitSeq;
    requestAnimationFrame(function () {
      paintReportCounts[blank ? 'blank' : 'painted'] += 1;
      postToHost({ type: 'painted', seq: seq, blank: blank });
    });
  }

  /** `afterInit` is true only from the init seed's own flush; a plain write's callback passes nothing. */
  function afterWriteFlushed(afterInit) {
    reportModesIfFlipped();
    reportPaintedIfAwaiting(afterInit === true);
    panToCursor();
    followCursorVertically(false);
    if (pendingJumpRepaint) {
      pendingJumpRepaint = false;
      jumpRepaintCount += 1;
      // The jump's redraw has flushed into the buffer; repaint the WHOLE
      // canvas on the next frame. xterm's refresh is the blessed way to force
      // it, and it is what turns "parsed but painted black" into pixels.
      requestAnimationFrame(function () {
        if (terminal) terminal.refresh(0, terminal.rows - 1);
      });
    }
  }

