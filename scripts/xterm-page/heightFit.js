  // Fit the grid's HEIGHT to the viewport by MEASUREMENT, correcting the
  // guess autoFitFontToScreen had to make. Two roundings work against that
  // guess: CELL_HEIGHT_RATIO is an estimate of the font's real metrics, and
  // xterm then CEILS the cell height, per row. So the painted grid lands
  // either a strip SHORT of the screen (dead band under the last row) or - the
  // damaging case - a row TALLER than it, with the bottom row clipped. Live on
  // a Pixel 10 against the desktop's 48-row grid that clipped row 48, the
  // TUI's status line ("plan mode on ..."), sliced in half at the screen edge.
  //
  // So: stretch the LINE HEIGHT into any slack, give that stretch back when
  // the ceil overshoots, and drop the font a step when even line height 1
  // overflows. One adjustment per frame (xterm has to repaint before the next
  // measure means anything) on a fixed budget - which FONT STEPS are exempt
  // from: how many the opening guess needs varies run to run (cell metrics
  // shift while fonts load), and letting them consume the budget starved the
  // stretch, settling fresh opens at line height 1 with a short centred grid
  // ("~80% of the TUI"). Steps are monotonic and floored at MIN_AUTO_FONT_PX,
  // so the exemption cannot spin. The final pass only measures, so the
  // centring below always runs against the settled grid.
  function fitGridHeightToViewport(passesLeft, stretchLocked, generation) {
    if (!terminal || generation !== heightFitGeneration) return;
    var screen = document.querySelector('.xterm-screen');
    if (!screen) {
      traceHeightFit('bail-no-screen', generation, passesLeft, 0);
      return;
    }
    var screenHeight = screen.getBoundingClientRect().height;
    if (!(screenHeight > 0) || terminal.rows < 1) {
      traceHeightFit('bail-zero-measure', generation, passesLeft, screenHeight);
      return;
    }
    var viewportHeight = window.innerHeight - HEIGHT_FIT_BOTTOM_CLEARANCE_PX;
    var currentLineHeight = terminal.options.lineHeight || 1;
    if (passesLeft <= 1) {
      // Out of passes. One correction is still safe without a re-measure: an
      // overshooting stretch only ever SHRINKS when handed back, so paying it
      // back blind cannot clip anything - while skipping it can, and did: a
      // stretch that crossed xterm's per-row ceil on the fit's last
      // adjustment pass used to be left overflowing, with the bottom row
      // sliced off by exactly that extra pixel per row.
      if (screenHeight > viewportHeight + HEIGHT_FIT_TOLERANCE_PX && currentLineHeight > 1.005) {
        terminal.options.lineHeight = Math.max(1, currentLineHeight * (viewportHeight / screenHeight));
      }
      traceHeightFit('final', generation, passesLeft, screenHeight);
      centerGridVertically(screenHeight);
      followCursorVertically(true);
      return;
    }
    var baseCellHeight = screenHeight / terminal.rows / currentLineHeight;
    if (!(baseCellHeight > 0)) return;
    var adjusted = false;
    var fontStepped = false;
    if (screenHeight > viewportHeight + HEIGHT_FIT_TOLERANCE_PX) {
      if (currentLineHeight > 1.005) {
        // The stretch overshot: hand back exactly the excess, and stop
        // stretching for the rest of this fit - a stretch that re-runs after
        // its own correction just trades the overflow back and forth.
        terminal.options.lineHeight = Math.max(1, currentLineHeight * (viewportHeight / screenHeight));
        stretchLocked = true;
        adjusted = true;
      } else if (currentFontSizePx > MIN_AUTO_FONT_PX) {
        // Overflowing at line height 1 means the FONT is a step too big for
        // this row count, not that the stretch was. Stretching stays legal
        // after this step, and is how the leftover row gets reclaimed.
        currentFontSizePx -= 1;
        terminal.options.fontSize = currentFontSizePx;
        postToHost({ type: 'font-size', fontSizePx: currentFontSizePx });
        adjusted = true;
        fontStepped = true;
      }
    } else if (!stretchLocked) {
      var desiredLineHeight = viewportHeight / (terminal.rows * baseCellHeight);
      var next = Math.max(1, Math.min(MAX_LINE_HEIGHT, desiredLineHeight));
      if (Math.abs(next - currentLineHeight) > 0.005) {
        terminal.options.lineHeight = next;
        adjusted = true;
      }
    }
    if (!adjusted) {
      traceHeightFit('settled', generation, passesLeft, screenHeight);
      centerGridVertically(screenHeight);
      // The fit has SETTLED: only now is the vertical follow computed against
      // real geometry. Forcing it from refit's first frame sampled the grid
      // MID-CONVERGENCE - on a 48-row grid the stretch transiently overflows
      // before the give-back, so the follow locked in a negative translate
      // that nothing cleared once the grid settled smaller, shifting the
      // whole frame up past the centring pad ("pushed up more"). A 30-row
      // grid never overflows mid-fit, which is why the first verification
      // pass missed it.
      followCursorVertically(true);
      return;
    }
    traceHeightFit(fontStepped ? 'adjust-font' : stretchLocked ? 'giveback' : 'adjust-stretch', generation, passesLeft, screenHeight);
    requestAnimationFrame(function () {
      fitGridHeightToViewport(fontStepped ? passesLeft : passesLeft - 1, stretchLocked, generation);
    });
  }

  // Height the fit cannot reach: a SHORT desktop grid (the desktop parks a
  // session at whatever surface last showed it, and its bottom panel is a
  // 14-row strip) cannot fill a phone at any font size the texture cap and the
  // line-height ceiling allow. Pinned to the top, the whole leftover piles up
  // underneath and reads as a terminal cut in half; split evenly it reads as a
  // margin. Same argument as the horizontal auto margins, one axis over.
  function centerGridVertically(screenHeight) {
    var gridHost = document.getElementById('terminal');
    if (!gridHost) return;
    var slack = window.innerHeight - screenHeight;
    var paddingTop = slack > 1 ? Math.floor(slack / 2) + 'px' : '0px';
    if (gridHost.style.paddingTop !== paddingTop) gridHost.style.paddingTop = paddingTop;
  }

  function centerGridFromMeasurement() {
    var screen = document.querySelector('.xterm-screen');
    if (!screen) return;
    centerGridVertically(screen.getBoundingClientRect().height);
  }

  // The GPU's max texture edge, probed once. A canvas wider (or taller) than
  // this gets silently allocated at the clamped size and stretched back over
  // the element: the right side of the grid is never drawn and the left side
  // paints magnified and blurry (observed live: a 308-col desktop grid at
  // font 20 wants a 9548-device-px canvas on a 4096-limit WebView, so the
  // phone showed ~13 giant columns). Conservative default if probing fails.
  var maxGlTextureSize = 4096;
  (function probeMaxGlTextureSize() {
    try {
      var probeCanvas = document.createElement('canvas');
      var gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
      if (gl) {
        var reported = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (typeof reported === 'number' && reported >= 1024) maxGlTextureSize = reported;
        var loseExtension = gl.getExtension('WEBGL_lose_context');
        if (loseExtension) loseExtension.loseContext();
      }
    } catch (probeError) { /* keep the conservative default */ }
  })();

  // Largest font at which the grid's canvas still fits inside the GPU texture
  // limit on BOTH axes. The 0.97 margin absorbs the cell-ratio guess erring
  // small against the renderer's true metrics.
  function textureCappedFontPx(fontPx, cols, rows) {
    var effectiveRows = rows !== null && rows >= 1 ? rows : fallbackRowCount(fontPx);
    var budget = maxGlTextureSize * 0.97;
    var widthCap = budget / (cols * CELL_WIDTH_RATIO * window.devicePixelRatio);
    var heightCap = budget / (effectiveRows * CELL_HEIGHT_RATIO * window.devicePixelRatio);
    var cap = Math.floor(Math.min(widthCap, heightCap));
    return Math.min(fontPx, Math.max(1, cap));
  }

