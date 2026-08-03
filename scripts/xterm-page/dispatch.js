  function onHostMessage(rawData) {
    var message;
    try {
      message = JSON.parse(rawData);
    } catch (parseError) {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'init') {
      // Prefer the in-place reset: it repaints without the dispose-blank. The
      // hard rebuild is only for the flag reset() cannot change.
      if (terminal && cleanFeedEnabled === (message.cleanFeed === true)) {
        softReinit(message);
        return;
      }
      if (terminal) {
        terminal.dispose();
        terminal = null;
        var container = document.getElementById('terminal');
        while (container.firstChild) container.removeChild(container.firstChild);
      }
      initCounts.hard += 1;
      createTerminal(message);
    } else if (message.type === 'write') {
      if (terminal && typeof message.data === 'string') {
        // First write after a scroll burst closes the input-to-repaint loop.
        if (lastScrollInputAt !== null) {
          lastScrollRoundTripMs = Date.now() - lastScrollInputAt;
          lastScrollInputAt = null;
        }
        if (lastJumpAt !== null && lastJumpFirstWriteMs === null) {
          lastJumpFirstWriteMs = Date.now() - lastJumpAt;
        }
        terminal.write(message.data, afterWriteFlushed);
        cleanFeedWrite(message.data);
      }
    } else if (message.type === 'set-font-size') {
      if (typeof message.fontSizePx === 'number') applyFontSize(message.fontSizePx);
    } else if (message.type === 'refit') {
      // Snap back to the fitted view. This must be the WHOLE refit(), not the
      // font-and-geometry half: applyFontSize cancels any in-flight height fit
      // (heightFitGeneration) but leaves terminal.options.lineHeight wherever
      // the last fit stretched it, while autoFitFontToScreen computes a font as
      // if lineHeight were 1. Only fitGridHeightToViewport reconciles the two,
      // so a refit that skipped it could not undo a zoom - the reset button
      // ran, reported success, and left the grid exactly as wrong as before.
      // clampHorizontalPan and panToCursor were missing for the same reason.
      //
      // The reset button is also the user's LAST-RESORT recovery, so it drops
      // every piece of gesture state as well: a latched pinch flag or a
      // dangling drag anchor must not survive the one control whose whole
      // promise is "put the terminal back into a working state".
      pinchActive = false;
      historyDragAnchorY = null;
      historyDragAxis = null;
      tapDirty = true;
      stopHistoryFling();
      applyVerticalOffset(0);
      refit();
    } else if (message.type === 'scroll-latest') {
      scrollToLatest();
    } else if (message.type === 'pinch') {
      if (message.active === true) pinchMessageCounts.activeTrue += 1;
      else pinchMessageCounts.activeFalse += 1;
      pinchActive = message.active === true;
      if (pinchActive) stopHistoryFling();
      // A finished pinch leaves this page's touch bookkeeping unreliable (it
      // may never have seen touchend for the second finger), so drop the drag
      // state outright. The next move re-anchors on whichever finger is still
      // down, which is what makes zoom-then-scroll work in one gesture.
      if (!pinchActive) {
        historyDragAnchorY = null;
        historyDragAxis = null;
        tapDirty = true;
      }
    } else if (message.type === 'resize') {
      // The desktop's authoritative grid (snapshot, or a desktop-side refit, or
      // the FIRST time dims arrive when they lost the race with init). Adopt it
      // and re-fit the whole frame to screen. READ-ONLY - nothing is sent back.
      //
      // The WHOLE refit(), for the same reason as the 'refit' branch above:
      // on the race path the seed already fit a GUESSED row count (init came
      // with rows null), stretching lineHeight for the wrong grid. The old
      // font-and-geometry half adopted the real cols/rows but reconciled
      // nothing, so the grid rendered at the real rows under the stale
      // stretch until the user pressed the reset button. Repeats never reach
      // here: the host only posts 'resize' when the dims actually changed
      // (terminalFeed's setTerminalDimensions has a same-dims guard).
      if (terminal && typeof message.cols === 'number' && typeof message.rows === 'number') {
        knownCols = message.cols;
        knownRows = message.rows;
        manualPanUntil = 0;
        if (cleanTerminal) cleanTerminal.resize(knownCols, knownRows);
        refit();
      }
    }
  }

  // react-native-webview delivers injected messages on 'message' events:
  // document on Android, window on iOS - listen on both.
  var handleMessageEvent = function (event) {
    if (typeof event.data === 'string') onHostMessage(event.data);
  };
  window.addEventListener('message', handleMessageEvent);
  document.addEventListener('message', handleMessageEvent);

  // The WebView viewport changes when the soft keyboard shows/hides or on
  // rotation: re-fit the whole frame to the new viewport so it stays fully
  // visible.
  window.addEventListener('resize', refit);

