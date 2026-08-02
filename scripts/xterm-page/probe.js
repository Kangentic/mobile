  /**
   * DEV HARNESS. Everything the terminal knows about its own geometry, modes,
   * and last gesture, plus the three levers that reproduce a user's actions
   * without a user: zoom (what pinch does), refit (what the reset button does),
   * and a raw scroll burst.
   *
   * Installed unconditionally rather than behind an init flag. The code ships in
   * the generated asset either way - Metro cannot tree-shake an .html - so a
   * flag would only decide whether the handle is reachable from inside a page
   * that is already a local file under default-src 'none', with no remote
   * origin and setSupportMultipleWindows off. There is no attacker in this page.
   * The CALLER is what is gated: only TerminalPane's __DEV__ plus
   * EXPO_PUBLIC_KANGENTIC_INSPECT path ever injects against it.
   *
   * Every field is read LAZILY. An 'init' disposes and recreates the terminal,
   * so a captured reference would go stale on the first session swap and report
   * the dead grid's numbers as if they were live.
   */
  /**
   * Which mouse protocol and encoding xterm currently has active.
   *
   * Read through _core because the public API does not expose it, so it is
   * wrapped: a private field that disappears in an xterm upgrade must degrade to
   * "unknown" here rather than throw and take the whole probe with it.
   */
  function coreMouseEncoding() {
    try {
      var service = terminal._core._coreMouseService || terminal._core.coreMouseService;
      return { protocol: service._activeProtocol, encoding: service._activeEncoding };
    } catch (encodingError) {
      return { protocol: 'unknown', encoding: 'unknown' };
    }
  }

  function terminalProbeState() {
    var screen = document.querySelector('.xterm-screen');
    var screenRect = screen ? screen.getBoundingClientRect() : null;
    var gridHost = document.getElementById('terminal');
    var container = scrollContainer();
    var buffer = terminal ? terminal.buffer.active : null;
    var modes = terminal && terminal.modes ? terminal.modes : null;
    var effectiveRows = knownRows !== null ? knownRows : terminal ? terminal.rows : null;
    return {
      buildId: '__XTERM_BUILD_ID__',
      hasTerminal: terminal !== null,
      cols: terminal ? terminal.cols : null,
      rows: terminal ? terminal.rows : null,
      knownCols: knownCols,
      knownRows: knownRows,
      fontSizePx: currentFontSizePx,
      // The stale-stretch suspect: applyFontSize cancels the height fit but
      // leaves lineHeight wherever the previous fit stretched it, and
      // autoFitFontToScreen sizes as if it were 1. If a zoom looks like it did
      // nothing, compare fontSizePx against fontCeilingPx before anything else.
      lineHeight: terminal ? terminal.options.lineHeight : null,
      maxGlTextureSize: maxGlTextureSize,
      fontCeilingPx: terminal ? textureCappedFontPx(1000, knownCols, effectiveRows) : null,
      gridWidthPx: screenRect ? screenRect.width : null,
      gridHeightPx: screenRect ? screenRect.height : null,
      paddingTopPx: gridHost ? gridHost.style.paddingTop : null,
      viewportWidthPx: window.innerWidth,
      viewportHeightPx: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollLeft: container ? container.scrollLeft : null,
      scrollWidth: container ? container.scrollWidth : null,
      clientWidth: container ? container.clientWidth : null,
      bufferType: buffer ? buffer.type : null,
      bufferLength: buffer ? buffer.length : null,
      bufferBaseY: buffer ? buffer.baseY : null,
      bufferViewportY: buffer ? buffer.viewportY : null,
      // mouseTrackingMode only says reporting is ON. The ENCODING says whether
      // SGR (1006) was negotiated, and without it the ESC[<..M form we emit is
      // the wrong format no matter what else is right. xterm's public IModes
      // does not carry the encoding at all, so it comes from the core service;
      // dumped whole because guessing at its shape cost a round trip once.
      mouseTrackingMode: modes ? modes.mouseTrackingMode : null,
      mouseEncoding: coreMouseEncoding(),
      modes: modes ? JSON.parse(JSON.stringify(modes)) : null,
      applicationCursorKeys: modes ? modes.applicationCursorKeysMode : lastAppCursorMode,
      scrollMechanism: scrollMechanism(),
      pinnedToStart: pinnedToStart,
      manualPanActive: Date.now() < manualPanUntil,
      historyDragAxis: historyDragAxis,
      historyDragAnchorY: historyDragAnchorY,
      pinchActive: pinchActive,
      pinchMessageCounts: JSON.parse(JSON.stringify(pinchMessageCounts)),
      heightFitGeneration: heightFitGeneration,
      lastScrollDecision: lastScrollDecision,
      scrollPostCount: scrollPostCount,
      lastScrollRoundTripMs: lastScrollRoundTripMs,
      verticalOffsetPx: verticalOffsetPx,
      flingStats: JSON.parse(JSON.stringify(flingStats)),
      initCounts: JSON.parse(JSON.stringify(initCounts)),
      netHistoryUnits: netHistoryUnits,
      jumpRepaintCount: jumpRepaintCount,
      lastJumpAt: lastJumpAt,
      lastJumpFirstWriteMs: lastJumpFirstWriteMs,
      jumpNudgeCount: jumpNudgeCount,
      viewportSettleRefits: viewportSettleRefits,
      touchCounts: JSON.parse(JSON.stringify(touchCounts)),
    };
  }

  window.__kangenticTerminal = {
    probe: terminalProbeState,
    // Exactly what a pinch does (TerminalPane posts 'set-font-size'), so a
    // scripted zoom and a real one cannot diverge.
    setFontSize: function (fontSizePx) {
      applyFontSize(fontSizePx);
      return terminalProbeState();
    },
    refit: function () {
      // Through the MESSAGE branch, not refit() directly: the reset button
      // posts {type:'refit'}, and that branch now also drops gesture state, so
      // calling the inner function would test a path the button does not take.
      onHostMessage(JSON.stringify({ type: 'refit' }));
      return terminalProbeState();
    },
    scroll: function (units) {
      scrollHistoryByUnits(units, scrollMechanism());
      return terminalProbeState();
    },
    /**
     * What consumeHistoryDrag WOULD compute for a vertical delta, with no side
     * effects. Isolates the geometry half of the gesture from touch delivery:
     * if a real drag does nothing, this says whether the arithmetic or the
     * events are at fault. Deliberately mirrors the real code path rather than
     * re-deriving it, so the two cannot drift.
     */
    dragUnits: function (deltaPx) {
      var screen = document.querySelector('.xterm-screen');
      if (!screen || !terminal || terminal.rows < 1) return null;
      var gridHeight = screen.getBoundingClientRect().height;
      var mechanism = scrollMechanism();
      var unitHeight = mechanism === 'page' ? gridHeight : gridHeight / terminal.rows;
      return {
        mechanism: mechanism,
        gridHeight: gridHeight,
        unitHeight: unitHeight,
        units: dragToScrollUnits(-deltaPx, unitHeight),
      };
    },
  };

