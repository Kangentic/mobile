  function createTerminal(initMessage) {
    knownCols = initMessage.cols;
    knownRows = typeof initMessage.rows === 'number' ? initMessage.rows : null;
    // Capped even on the legacy no-dims path (autoFitFontToScreen early-returns
    // there, so this is the only guard between a wide grid and the GPU limit).
    currentFontSizePx = textureCappedFontPx(initMessage.fontSizePx, knownCols, knownRows);
    lastAppCursorMode = false;
    lastReportedModes = null;
    manualPanUntil = 0;
    // The grid host SURVIVES a re-init (only its children are replaced), so a
    // zoom-follow translate from the previous session would otherwise shift
    // the new frame. Same for a glide still in flight.
    stopHistoryFling();
    dragSamples = [];
    applyVerticalOffset(0);
    netHistoryUnits = 0;
    // Every (re-)init is a fresh open - including a session swap and the
    // re-seed when the pane becomes visible again - so the frame starts at
    // column 0 rather than inheriting the previous view's pan.
    pinnedToStart = true;
    cleanFeedEnabled = initMessage.cleanFeed === true;
    // The row-stretch fill can leave a sub-row remainder below the last row;
    // paint the page in the terminal's own background so it never reads as a
    // seam against the host screen.
    if (initMessage.theme && typeof initMessage.theme.background === 'string') {
      document.documentElement.style.background = initMessage.theme.background;
      document.body.style.background = initMessage.theme.background;
    }
    // Start every init from zero vertical padding: the centring below is
    // measured per grid, and a short session's leftover must not survive into
    // the grid that replaced it.
    var gridHost = document.getElementById('terminal');
    if (gridHost) gridHost.style.paddingTop = '0px';
    setupCleanFeed(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
    autoFitFontToScreen();
    terminal = new window.Terminal({
      cols: knownCols,
      rows: knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx),
      fontSize: currentFontSizePx,
      fontFamily: 'Menlo, Consolas, monospace',
      theme: initMessage.theme,
      scrollback: 2000,
      convertEol: false,
      cursorBlink: false,
    });
    resetWebglState();
    fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
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
    if (initMessage.scrollback) {
      terminal.write(initMessage.scrollback, function () {
        applyGeometry();
        afterWriteFlushed();
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
    }
    // Cell metrics AND the viewport height can settle a frame after open();
    // re-fit the font (not just the geometry) once they have.
    requestAnimationFrame(refit);
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
    knownCols = initMessage.cols;
    knownRows = typeof initMessage.rows === 'number' ? initMessage.rows : null;
    currentFontSizePx = textureCappedFontPx(initMessage.fontSizePx, knownCols, knownRows);
    lastAppCursorMode = false;
    lastReportedModes = null;
    manualPanUntil = 0;
    stopHistoryFling();
    dragSamples = [];
    applyVerticalOffset(0);
    netHistoryUnits = 0;
    pinnedToStart = true;
    if (initMessage.theme && typeof initMessage.theme.background === 'string') {
      document.documentElement.style.background = initMessage.theme.background;
      document.body.style.background = initMessage.theme.background;
    }
    var gridHost = document.getElementById('terminal');
    if (gridHost) gridHost.style.paddingTop = '0px';
    setupCleanFeed(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
    terminal.reset();
    terminal.options.theme = initMessage.theme;
    // A previous height fit may have stretched the line height; the fresh fit
    // below assumes the same clean slate a constructed terminal starts with.
    terminal.options.lineHeight = 1;
    terminal.options.fontSize = currentFontSizePx;
    autoFitFontToScreen();
    applyGeometry();
    if (initMessage.scrollback) {
      terminal.write(initMessage.scrollback, function () {
        applyGeometry();
        afterWriteFlushed();
      });
      cleanFeedWrite(initMessage.scrollback);
    } else {
      applyGeometry();
      reportModesIfFlipped();
    }
    requestAnimationFrame(refit);
  }

  function applyFontSize(fontSizePx) {
    if (!terminal) return;
    // Pinch obeys the texture cap too: past it the GPU clamps the canvas and
    // the right side of the grid becomes undrawable, so the zoom ceiling is
    // the honest limit. (On real devices the limit is 8k-16k and the ceiling
    // is far above any font size a pinch can reach; a 4096 limit is an
    // emulator trait.)
    var capped = textureCappedFontPx(fontSizePx, knownCols, knownRows !== null ? knownRows : terminal.rows);
    currentFontSizePx = capped;
    terminal.options.fontSize = capped;
    // Keep the host's pinch baseline honest when the cap engaged.
    if (capped !== fontSizePx) postToHost({ type: 'font-size', fontSizePx: capped });
    // Pinch changed the cell size; the grid (cols/rows) is unchanged.
    applyGeometry();
    // Zoom deliberately does NOT re-fit (the user owns the size now), so it
    // also CANCELS a fit still converging - otherwise that fit keeps stepping
    // the font under the pinching finger and posts sizes that overwrite the
    // host's pinch baseline mid-gesture. The centring is measured, though, so
    // it has to follow the new cell height: without it, zooming into a short
    // grid pushes the frame down by a stale padding.
    heightFitGeneration += 1;
    requestAnimationFrame(function () {
      centerGridFromMeasurement();
      // Forced: the pinch just changed the geometry deliberately, and the
      // manual-pan pause would otherwise leave the zoomed frame top-anchored
      // with the TUI's live rows (input line, status bar) off screen for
      // seconds. This is what makes zooming land ON the action.
      followCursorVertically(true);
    });
  }

