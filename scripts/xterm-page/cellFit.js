  // THE COMPUTED FIT. Any write that changes the terminal's font size or line
  // height makes xterm resize its renderer's canvas, and a resized canvas is
  // CLEARED: it shows nothing until xterm's next animation frame repaints it.
  // The measured chain (heightFit.js) stretches the line height one frame at a
  // time and re-measures, so a full fit resized the ~3780x1970 device-px WebGL
  // canvas 4-5 times, every time from inside an animation frame, where xterm's
  // repaint lands a frame late. Measured 2026-10-07 on the emulator
  // (kangentic_tablet_36, dev client, mock session): the canvas height setter
  // blocked 6123, 12676 and 3115 ms on the chain's three grow steps, and the
  // pane read fully black for the whole chain. On a Pixel 11 Pro release
  // build the same chain made 6 writes per fit-button press and a screen
  // recording showed the pane blank for 425-442 ms on every press; this fit
  // made 0 writes and the pane never blanked (docs/architecture.md). That
  // chain runs on the fit button, on any change to the Terminal pane's height
  // (the first-run hint, a rotation) and on a first open.
  //
  // So the cell is computed rather than converged. The renderer's arithmetic
  // (xterm's WebglRenderer and DomRenderer _updateDimensions agree) is
  //   device char height = ceil(char height x devicePixelRatio)
  //   device cell height = floor(device char height x lineHeight)
  //   grid height        = round(rows x device cell height / devicePixelRatio)
  // and the char height is what xterm's CharSizeService measures: measureText
  // of 'W' on an OffscreenCanvas, font box ascent plus descent. The fit takes
  // the largest font, from the reference guess down, whose reference rows fit
  // at line height 1, then the tallest whole device-pixel cell that still fits
  // under the line-height ceiling, and writes both ONCE, from a task rather
  // than a frame, so xterm's repaint lands before the next paint. One measure
  // afterwards confirms it, and a miss hands over to the measured chain.

  var charMeasureContext = null;

  // The char height xterm's CharSizeService reports for this font, in CSS px,
  // or null where the API it relies on is missing (xterm then measures a DOM
  // span instead, which this cannot reproduce exactly, so the measured chain
  // takes over).
  function measureCharHeightPx(fontSizePx) {
    try {
      if (charMeasureContext === null) charMeasureContext = new OffscreenCanvas(100, 100).getContext('2d');
      charMeasureContext.font = fontSizePx + 'px ' + TERMINAL_FONT_FAMILY;
      var metrics = charMeasureContext.measureText('W');
      if (!('fontBoundingBoxAscent' in metrics) || !('fontBoundingBoxDescent' in metrics)) return null;
      var height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
      return height > 0 ? height : null;
    } catch (measureError) {
      return null;
    }
  }

  // The tallest whole device-pixel cell whose `rows` rows render no taller
  // than `limitPx` CSS px, by the renderer's own rounding of the grid height.
  function tallestFittingDeviceCell(rows, devicePixelRatio, limitPx) {
    var cell = Math.floor(((limitPx + 1) * devicePixelRatio) / rows);
    while (cell > 0 && Math.round((rows * cell) / devicePixelRatio) > limitPx) cell -= 1;
    return cell;
  }

  // The cell this grid gets in this pane, or null when the char height cannot
  // be measured the way xterm measures it. Same limit as the measured chain:
  // the fit height less the bottom clearance, plus the tolerance it accepts.
  function computeFittedCell() {
    var devicePixelRatio = window.devicePixelRatio || 1;
    var referenceRows = referenceRowsForFit();
    var limitPx = fitViewportHeight() - HEIGHT_FIT_BOTTOM_CLEARANCE_PX + HEIGHT_FIT_TOLERANCE_PX;
    var maxDeviceCell = tallestFittingDeviceCell(referenceRows, devicePixelRatio, limitPx);
    for (var fontSizePx = referenceFontPx(); fontSizePx >= MIN_AUTO_FONT_PX; fontSizePx -= 1) {
      var charHeight = measureCharHeightPx(fontSizePx);
      if (charHeight === null) return null;
      var deviceCharHeight = Math.ceil(charHeight * devicePixelRatio);
      if (maxDeviceCell < deviceCharHeight) continue;
      var deviceCell = Math.min(maxDeviceCell, Math.floor(deviceCharHeight * MAX_LINE_HEIGHT));
      // Half a device pixel above the target, so the renderer's floor lands ON
      // the target cell rather than a float's width below it. Where the
      // ceiling binds, the ceiling itself floors to the same cell.
      var lineHeight = Math.max(1, Math.min(MAX_LINE_HEIGHT, (deviceCell + 0.5) / deviceCharHeight));
      return { fontSizePx: fontSizePx, lineHeight: lineHeight };
    }
    // Nothing fits even at the smallest auto font: the measured chain floors
    // at the same place.
    return { fontSizePx: MIN_AUTO_FONT_PX, lineHeight: 1 };
  }

  // Writes the terminal's font size or line height when it changes, timing
  // the write: xterm resizes (and so clears) the renderer's canvas inside it,
  // which is the cost the fit report counts.
  function setCellOption(name, value) {
    if (!terminal || terminal.options[name] === value) return;
    var startedAt = performance.now();
    terminal.options[name] = value;
    var elapsedMs = performance.now() - startedAt;
    if (fitChainStats !== null) {
      fitChainStats.cellWrites += 1;
      fitChainStats.cellWriteMs += elapsedMs;
      if (elapsedMs > fitChainStats.maxCellWriteMs) fitChainStats.maxCellWriteMs = elapsedMs;
    }
  }

  function beginFitChainStats() {
    fitChainStats = { strategy: fitStrategy, startedAt: performance.now(), cellWrites: 0, cellWriteMs: 0, maxCellWriteMs: 0 };
  }

  // The device-pixel cell the renderer draws for a font and line height, by
  // its own arithmetic (see above), or null when the font cannot be measured
  // the way xterm measures it.
  function expectedDeviceCell(cell) {
    var charHeight = measureCharHeightPx(cell.fontSizePx);
    if (charHeight === null) return null;
    return Math.floor(Math.ceil(charHeight * (window.devicePixelRatio || 1)) * cell.lineHeight);
  }

  // Run a computed fit for this generation. False when the cell cannot be
  // computed here, so the caller runs the measured chain instead.
  function runComputedFit(generation) {
    var settled = settledFitForCurrentGrid();
    var cell = settled !== null ? { fontSizePx: settled.fontSizePx, lineHeight: settled.lineHeight } : computeFittedCell();
    if (cell === null) return false;
    var deviceCell = expectedDeviceCell(cell);
    // From a TASK, never inside a frame. xterm repaints on its next animation
    // frame: a write made inside a frame callback (a ResizeObserver, a
    // requestAnimationFrame) is presented cleared for a frame first, while a
    // write from a task is repainted before the next paint.
    setTimeout(function () {
      if (!terminal || generation !== heightFitGeneration) return;
      currentFontSizePx = cell.fontSizePx;
      setCellOption('fontSize', cell.fontSizePx);
      setCellOption('lineHeight', cell.lineHeight);
      applyGeometry();
      requestAnimationFrame(function () {
        confirmComputedFit(generation, deviceCell);
      });
    }, 0);
    return true;
  }

  // The computed cell has painted: measure it once. The grid this page
  // expected settles exactly as the measured chain does. A grid of any other
  // height means the renderer measured the font differently from this page,
  // taller or shorter, and the measured chain corrects it from here.
  //
  // Compared at THIS grid's rows, never scaled to the reference rows: xterm
  // rounds the grid's css height to a whole pixel, and scaling a rounded
  // height by 48/rows amplified that half pixel past the tolerance on a
  // short grid, reading a cell that fits as an overflow (a 30-row grid at
  // dpr 2.625 in a 587px pane). The reference grid is then derived from the
  // device cell itself, by the renderer's own rounding.
  function confirmComputedFit(generation, deviceCell) {
    if (!terminal || generation !== heightFitGeneration) return;
    var screen = document.querySelector('.xterm-screen');
    var measuredHeight = screen ? screen.getBoundingClientRect().height : 0;
    if (!(measuredHeight > 0) || terminal.rows < 1) {
      traceHeightFit('bail-zero-measure', generation, 0, measuredHeight);
      return;
    }
    var devicePixelRatio = window.devicePixelRatio || 1;
    var expectedHeight = deviceCell !== null ? Math.round((terminal.rows * deviceCell) / devicePixelRatio) : null;
    var drawnAsExpected = expectedHeight === null || Math.abs(measuredHeight - expectedHeight) <= 1;
    // The cell the renderer actually drew, recovered from the drawn grid
    // (exact for any grid of four rows or more), so the overflow check below
    // tests what painted, not what this page expected. It is the only check
    // left when the font cannot be measured (only a settled cell gets here).
    var drawnCell = Math.round((measuredHeight * devicePixelRatio) / terminal.rows);
    var referenceRows = Math.max(terminal.rows, referenceRowsForFit());
    var screenHeight = Math.round((referenceRows * drawnCell) / devicePixelRatio);
    var limitPx = fitViewportHeight() - HEIGHT_FIT_BOTTOM_CLEARANCE_PX + HEIGHT_FIT_TOLERANCE_PX;
    if (!drawnAsExpected || screenHeight > limitPx) {
      if (fitChainStats !== null) fitChainStats.strategy = 'computed-miss';
      traceHeightFit('computed-miss', generation, HEIGHT_FIT_PASSES, screenHeight);
      fitGridHeightToViewport(HEIGHT_FIT_PASSES, false, generation);
      return;
    }
    traceHeightFit('computed', generation, 0, screenHeight);
    settleFit(measuredHeight);
    manualPanUntil = 0;
    clampHorizontalPan();
    followCursorVertically(true);
  }
