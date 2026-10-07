  /**
   * THE FRAME HOLD: a text copy of the viewport, raised over the terminal
   * for the span between a holdFrame re-init and the successor's first
   * non-blank paint.
   *
   * A re-init over a painted frame resets the grid (terminal.reset() is RIS)
   * and replays the successor's ring, and on a resume that ring's snapshot
   * often parses to a BLANK viewport with the redraw arriving as chunks up to
   * a second and a half later. The host's swap veil covers the pane, but at
   * its floor opacity the dimmed frame could be seen going black underneath.
   * This keeps the frame there: every viewport row's text, in the terminal's
   * own font and cell height, over the same rectangle, in the theme's
   * foreground on its background. Colours and bold are lost, which under a
   * scrim at four-fifths opacity is nothing. Removed on the first non-blank
   * paint report (modes.js), so it lifts on the same frame the successor is
   * drawn; a second re-init while it is up (two seeds land per swap) never
   * replaces it with a copy of the blank grid.
   */
  var FRAME_HOLD_ID = 'frame-hold';
  function holdFrameSnapshot() {
    if (!terminal || document.getElementById(FRAME_HOLD_ID)) return;
    var gridHost = document.getElementById('terminal');
    var screen = document.querySelector('.xterm-screen');
    if (!gridHost || !screen) return;
    var buffer = terminal.buffer.active;
    var rows = [];
    for (var row = 0; row < terminal.rows; row += 1) {
      var line = buffer.getLine(buffer.viewportY + row);
      rows.push(line ? line.translateToString(true) : '');
    }
    // A blank grid is not worth holding, and holding it would hide the
    // successor's paint behind an opaque block until the report came back.
    if (rows.join('').trim().length === 0) return;
    var hostRect = gridHost.getBoundingClientRect();
    var screenRect = screen.getBoundingClientRect();
    var theme = terminal.options.theme || {};
    var hold = document.createElement('pre');
    hold.id = FRAME_HOLD_ID;
    hold.setAttribute('aria-hidden', 'true');
    hold.style.cssText =
      'position:absolute;margin:0;overflow:hidden;pointer-events:none;z-index:3;white-space:pre;' +
      'left:' + (screenRect.left - hostRect.left) + 'px;' +
      'top:' + (screenRect.top - hostRect.top) + 'px;' +
      'width:' + screenRect.width + 'px;' +
      'height:' + screenRect.height + 'px;' +
      'font-family:' + terminal.options.fontFamily + ';' +
      'font-size:' + terminal.options.fontSize + 'px;' +
      'line-height:' + screenRect.height / terminal.rows + 'px;' +
      'color:' + (theme.foreground || '#ffffff') + ';' +
      'background:' + (theme.background || '#000000') + ';';
    hold.textContent = rows.join('\n');
    gridHost.appendChild(hold);
    frameHoldCount += 1;
  }

  function clearFrameHold() {
    var hold = document.getElementById(FRAME_HOLD_ID);
    if (hold && hold.parentNode) hold.parentNode.removeChild(hold);
  }

  /**
   * The reset both init paths share, before their halves diverge into
   * construction vs reset(): adopt the new grid and font, clear the
   * per-session view state (modes, pan, zoom-follow translate, glide,
   * scrollback ledger), repaint the page background, zero the top padding,
   * and rebuild the clean-feed parser. The grid host SURVIVES a
   * re-init (only its children are replaced), which is why the translate,
   * the padding, and the pan must be reset by hand here.
   */
  function resetSessionViewState(initMessage) {
    var previousCols = knownCols;
    var previousRows = knownRows;
    knownCols = initMessage.cols;
    knownRows = typeof initMessage.rows === 'number' ? initMessage.rows : null;
    // The host's measured fit height, when it has one (see hostFitHeightPx):
    // a fresh page's first init carries it, so the very first frame is
    // already the final cell rather than a guess corrected a beat later.
    if (typeof initMessage.fitHeightPx === 'number' && initMessage.fitHeightPx > 0) {
      hostFitHeightPx = initMessage.fitHeightPx;
    }
    // A pinch survives a re-init of the SAME session at the SAME grid (a lens
    // switch back, a re-seed - the host says which with preservePinch); a
    // different session or a different grid starts from the fit.
    if (initMessage.preservePinch !== true || previousCols !== knownCols || previousRows !== knownRows) {
      pinchOverrideFontPx = null;
    }
    // The host picks the fit strategy per init (cellFit.js). Before the font
    // below, which the computed fit already shapes.
    fitStrategy = initMessage.fitStrategy === 'measured' ? 'measured' : 'computed';
    // Only an explicit false (the retention probe's control arm) lets the
    // WebView's long-press menu through (bootstrap.js). The body class takes
    // xterm's hidden textarea out of hit testing (the page CSS): it sits on the
    // cursor cell, and a long-press landing there placed Chromium's caret and
    // insertion handle in it, one tap from the same "Autofill" menu. Nothing
    // touches it directly; focus is always terminal.focus().
    longPressMenuGuard = initMessage.longPressMenuGuard !== false;
    document.body.classList.toggle('long-press-guard', longPressMenuGuard);
    // The page owns the font: the reference cell for this grid (or the cell
    // it already converged on), or the pinch. Capped either way, which on the
    // legacy no-dims path is the only guard between a wide grid and the GPU
    // limit.
    currentFontSizePx =
      pinchOverrideFontPx !== null
        ? textureCappedFontPx(pinchOverrideFontPx, knownCols, knownRows)
        : fittedFontPxForGrid();
    lastAppCursorMode = false;
    lastReportedModes = null;
    // Every init re-arms the paint report (see reportPaintedIfAwaiting) and
    // records which init it answers for.
    activeInitSeq = typeof initMessage.seq === 'number' ? initMessage.seq : null;
    awaitingNonBlankPaint = true;
    lastInitHoldFrame = initMessage.holdFrame === true;
    manualPanUntil = 0;
    stopHistoryFling();
    dragSamples = [];
    applyVerticalOffset(0);
    netHistoryUnits = 0;
    // Every (re-)init is a fresh open - including a session swap and the
    // re-seed when the pane becomes visible again - so the frame starts at
    // column 0 rather than inheriting the previous view's pan.
    pinnedToStart = true;
    // The row-stretch fill can leave a sub-row remainder below the last row;
    // paint the page in the terminal's own background so it never reads as a
    // seam against the host screen.
    if (initMessage.theme && typeof initMessage.theme.background === 'string') {
      document.documentElement.style.background = initMessage.theme.background;
      document.body.style.background = initMessage.theme.background;
    }
    // Every grid is pinned to the top: zero vertical padding, on every init
    // (see settleFit in heightFit.js for why a short grid is no longer
    // centred).
    var gridHost = document.getElementById('terminal');
    if (gridHost) gridHost.style.paddingTop = '0px';
    setupCleanFeed(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
  }

  /** The seed both init paths share, after their halves prepared the grid. */
  function seedAndSettle(initMessage) {
    if (initMessage.scrollback) {
      // The seq this seed belongs to. xterm flushes writes asynchronously, so
      // when two inits land inside one frame the FIRST seed's callback fires
      // after the second init has already reset the grid and re-armed the
      // paint report: it would report the second init's seq against a grid
      // its own bytes never reached (seen live as a doubled blank report),
      // and re-apply a geometry the second init owns. A superseded seed's
      // flush is nobody's business any more.
      var initSeq = activeInitSeq;
      terminal.write(initMessage.scrollback, function () {
        if (initSeq !== activeInitSeq) return;
        applyGeometry();
        afterWriteFlushed(true);
      });
      cleanFeedWrite(initMessage.scrollback);
    } else {
      applyGeometry();
      // An EMPTY seed still has modes worth reporting: the host writes the
      // restore prefix into this same field, and a session whose ring has not
      // filled yet (fresh subscribe, post-reconnect, a swap before any bytes
      // land) would otherwise never report at all, leaving the host with no
      // confirmation that the terminal came up in the right state.
      reportModesIfFlipped();
      // And it is a (blank) first paint: the host's swap veil learns the
      // successor came up with nothing to show yet, and the first write that
      // draws glyphs reports again.
      reportPaintedIfAwaiting(true);
    }
    // Cell metrics AND the viewport height can settle a frame after open();
    // re-fit once they have. Deterministic (refit.js), so for a grid that
    // already converged this measures once and changes nothing.
    requestAnimationFrame(function () {
      refit('init');
    });
  }

  function createTerminal(initMessage) {
    // Set before resetSessionViewState so its setupCleanFeed sees the flag.
    cleanFeedEnabled = initMessage.cleanFeed === true;
    resetSessionViewState(initMessage);
    terminal = new window.Terminal({
      cols: knownCols,
      rows: knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx),
      fontSize: currentFontSizePx,
      // The converged stretch when this grid and pane already have one, so a
      // fresh page (a remount after a killed renderer, a clean-feed rebuild)
      // comes up at the final cell instead of re-converging from 1.
      lineHeight: pinchOverrideFontPx !== null ? 1 : fittedLineHeightForGrid(),
      fontFamily: TERMINAL_FONT_FAMILY,
      theme: initMessage.theme,
      scrollback: 2000,
      convertEol: false,
      cursorBlink: false,
    });
    resetWebglState();
    terminal.open(document.getElementById('terminal'));
    attachWebgl();
    reportRenderer();
    // Android predictive keyboards buffer composition text against xterm's
    // hidden textarea, echoing late and breaking Backspace - turn every
    // assist off so keys route straight through.
    if (terminal.textarea) {
      terminal.textarea.setAttribute('autocomplete', 'off');
      terminal.textarea.setAttribute('autocorrect', 'off');
      terminal.textarea.setAttribute('autocapitalize', 'none');
      terminal.textarea.setAttribute('spellcheck', 'false');
    }
    // Hardware/Bluetooth keyboard typing directly into the WebView flows to
    // the PTY the same way quick keys do (the host routes both through the
    // interactive-terminal verb). Typing also re-arms follow-the-cursor.
    terminal.onData(function (data) {
      manualPanUntil = 0;
      postToHost({ type: 'input', data: data });
    });
    seedAndSettle(initMessage);
  }

  /**
   * Re-seed WITHOUT tearing the terminal down. A full createTerminal disposes
   * the DOM and the WebGL context and rebuilds both, which paints as a hard
   * blank-then-redraw - and the reset button triggers a re-seed on top of its
   * own refit, so the user saw "multiple screen flashes" per press. xterm's
   * reset() is RIS: it clears both buffers and all modes with the renderer,
   * textarea attributes, and onData wiring untouched, so the same replay
   * paints in place. The hard path remains for what reset() cannot change:
   * the clean-feed flag baked in at construction.
   */
  function softReinit(initMessage) {
    initCounts.soft += 1;
    // Before the reset, while the frame worth keeping is still in the buffer.
    if (initMessage.holdFrame === true) holdFrameSnapshot();
    else clearFrameHold();
    resetSessionViewState(initMessage);
    terminal.reset();
    terminal.options.theme = initMessage.theme;
    // The font resetSessionViewState chose (the reference cell, the cell
    // already converged for this grid, or the pinch), and the line height
    // that goes with it. A pinch keeps the stretch it was made over. Unchanged
    // values write nothing, so a re-seed of a fitted frame never resizes the
    // canvas.
    setCellOption('fontSize', currentFontSizePx);
    if (pinchOverrideFontPx === null) setCellOption('lineHeight', fittedLineHeightForGrid());
    applyGeometry();
    seedAndSettle(initMessage);
  }

  function applyFontSize(fontSizePx) {
    if (!terminal) return;
    // Pinch obeys the texture cap too: past it the GPU clamps the canvas and
    // the right side of the grid becomes undrawable, so the zoom ceiling is
    // the honest limit. (On real devices the limit is 8k-16k and the ceiling
    // is far above any font size a pinch can reach; a 4096 limit is an
    // emulator trait.)
    var capped = textureCappedFontPx(fontSizePx, knownCols, knownRows !== null ? knownRows : terminal.rows);
    // The user owns the size now, until the fit button, another session or
    // another grid (see refit.js and resetSessionViewState).
    pinchOverrideFontPx = capped;
    currentFontSizePx = capped;
    setCellOption('fontSize', capped);
    // Keep the host's pinch baseline honest when the cap engaged.
    if (capped !== fontSizePx) {
      var screen = document.querySelector('.xterm-screen');
      reportFit('texture-cap', screen ? screen.getBoundingClientRect().height : 0);
    }
    // Pinch changed the cell size; the grid (cols/rows) is unchanged.
    applyGeometry();
    // Zoom deliberately does NOT re-fit (the user owns the size now), so it
    // also CANCELS a fit still converging - otherwise that fit keeps stepping
    // the font under the pinching finger. The grid stays pinned to the top,
    // so there is no padding to follow the new cell height. A cancelled
    // chain's stats go with it.
    heightFitGeneration += 1;
    fitChainStats = null;
    requestAnimationFrame(function () {
      // Forced: the pinch just changed the geometry deliberately, and the
      // manual-pan pause would otherwise leave the zoomed frame top-anchored
      // with the TUI's live rows (input line, status bar) off screen for
      // seconds. This is what makes zooming land ON the action.
      followCursorVertically(true);
    });
  }

