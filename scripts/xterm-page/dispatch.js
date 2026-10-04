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
      // And it ALWAYS lands on the fitted view: the pinch goes, and so does
      // the converged cell, so the chain re-derives it from scratch rather
      // than trusting a record the user is pressing the button to escape.
      pinchOverrideFontPx = null;
      settledFit = null;
      // The host sends the ring's grid with the press. A page that inited
      // before the desktop reported one (rows unknown) adopts it here, so the
      // fit is for the real grid rather than a guess.
      if (terminal && typeof message.cols === 'number' && typeof message.rows === 'number') {
        knownCols = message.cols;
        knownRows = message.rows;
        if (cleanTerminal) cleanTerminal.resize(knownCols, knownRows);
      }
      refit('refit-msg');
    } else if (message.type === 'fit-height') {
      // The host measured the Terminal lens's own height (see hostFitHeightPx
      // in state.js): a first measurement, or a rotation.
      if (typeof message.fitHeightPx === 'number' && message.fitHeightPx > 0 && message.fitHeightPx !== hostFitHeightPx) {
        hostFitHeightPx = message.fitHeightPx;
        refit('fit-height');
      }
    } else if (message.type === 'repaint') {
      // Back from the background: the renderer can come back with glyphs
      // missing ("110 +" drawn as "10", "progress" as "p ogress", observed on
      // a Pixel) and the frame STAYS that way. A refit used to repair it by
      // relaying the whole frame out; with the fit deterministic a refit
      // changes nothing, so the repaint is asked for directly: drop the WebGL
      // glyph atlas, which is where a corrupted glyph lives, and redraw every
      // row from the buffer.
      if (terminal) {
        if (webglAddon && typeof webglAddon.clearTextureAtlas === 'function') webglAddon.clearTextureAtlas();
        terminal.refresh(0, terminal.rows - 1);
      }
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
        // A different grid is a different picture: a pinch made over the old
        // one does not carry over.
        if (message.cols !== knownCols || message.rows !== knownRows) pinchOverrideFontPx = null;
        knownCols = message.cols;
        knownRows = message.rows;
        manualPanUntil = 0;
        if (cleanTerminal) cleanTerminal.resize(knownCols, knownRows);
        refit('resize-msg');
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
  // rotation. onViewportChange re-fits only when that moved the fit (a
  // rotation); a keyboard only re-orients the frame (see refit.js).
  window.addEventListener('resize', function () {
    onViewportChange('window-resize');
  });

