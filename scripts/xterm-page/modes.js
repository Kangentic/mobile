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

  function afterWriteFlushed() {
    reportModesIfFlipped();
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

