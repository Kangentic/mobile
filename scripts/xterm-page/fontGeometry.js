  // The row count the REFERENCE CELL is fitted to (see REFERENCE_GRID_ROWS in
  // state.js): the resting grid's 48 rows for any grid that short or shorter,
  // so every such grid lands on the identical cell; the grid's own rows for a
  // taller one, which must still fit the pane without clipping a row. Unknown
  // rows (the desktop has not reported its grid yet) fit the reference: the
  // cell is the same either way, and a later 'resize' only re-lays the grid.
  function referenceRowsForFit() {
    var rows = knownRows !== null && knownRows >= 1 ? knownRows : REFERENCE_GRID_ROWS;
    return Math.max(rows, REFERENCE_GRID_ROWS);
  }

  // The reference cell's font: the reference rows fill the FULL fit height
  // (the measured height fit then corrects the guess). Capped by the GPU
  // texture limit for the reference grid's width as well as this grid's,
  // so a narrower grid lands on the same cell a capped resting grid gets
  // rather than one step bigger; a wider grid caps lower on its own, which is
  // the honest hardware ceiling (a 4096 limit binds the resting grid by a
  // step at dpr 3). AUTO-fit keeps its ceiling below pinch's, as before.
  function referenceFontPx() {
    var rowsForFit = referenceRowsForFit();
    // fitViewportHeight, NOT window.innerHeight: the soft keyboard must not
    // shrink the fit (see the tracker in state.js).
    var fitted = Math.floor(fitViewportHeight() / (rowsForFit * CELL_HEIGHT_RATIO));
    var next = Math.max(MIN_AUTO_FONT_PX, Math.min(MAX_AUTO_FIT_FONT_PX, fitted));
    return textureCappedFontPx(next, Math.max(knownCols, REFERENCE_GRID_COLS), rowsForFit);
  }

  // Everything the converged cell depends on. Two fits with the same key
  // settle on the same font and line height, so the second applies the
  // first's result (settledFit) instead of re-running the chain from line
  // height 1. Cols enter only through the texture cap, so every grid at or
  // under the reference width shares one key.
  function currentFitKey() {
    return [
      referenceRowsForFit(),
      Math.max(knownCols, REFERENCE_GRID_COLS),
      Math.round(fitViewportHeight()),
      window.devicePixelRatio,
    ].join(':');
  }

  function settledFitForCurrentGrid() {
    return settledFit !== null && settledFit.key === currentFitKey() ? settledFit : null;
  }

  // The font an init starts from: the converged cell when this grid and pane
  // already have one, the reference font otherwise.
  function fittedFontPxForGrid() {
    var settled = settledFitForCurrentGrid();
    return settled !== null ? settled.fontSizePx : referenceFontPx();
  }

  // The line height an init starts from, by the same rule: the converged
  // stretch, or the clean slate (1) the height fit starts a fresh chain from.
  function fittedLineHeightForGrid() {
    var settled = settledFitForCurrentGrid();
    return settled !== null ? settled.lineHeight : 1;
  }

  // Set the font to the reference cell's. Pick the font so the REFERENCE
  // rows fill the full phone height; a wide grid then overflows the width and
  // pans horizontally (follow-the-cursor keeps the active column in view);
  // pinch zoom adjusts from there.
  function autoFitFontToScreen() {
    if (knownCols < 1) return;
    var next = referenceFontPx();
    if (next !== currentFontSizePx) {
      currentFontSizePx = next;
      if (terminal) terminal.options.fontSize = next;
    }
  }

  // The fit report the host traces and keeps its pinch baseline on. Posted
  // when a fit chain SETTLES (source 'settled') - every settle, changed or
  // not, so a release-build trace shows every open's cell, not only the ones
  // that moved - and when the texture cap clamps a pinch ('texture-cap').
  // Primitives only: the host's connection trace never carries content.
  function reportFit(source, gridHeightPx) {
    postToHost({
      type: 'font-size',
      fontSizePx: currentFontSizePx,
      source: source,
      trigger: activeFitTrigger,
      cols: knownCols,
      rows: knownRows,
      lineHeight: terminal && terminal.options ? terminal.options.lineHeight || 1 : 1,
      fitHeightPx: Math.round(fitViewportHeight()),
      innerHeightPx: window.innerHeight,
      innerWidthPx: window.innerWidth,
      gridHeightPx: Math.round(gridHeightPx),
      devicePixelRatio: window.devicePixelRatio,
      maxTextureSize: maxGlTextureSize,
    });
  }

  // Render the desktop's EXACT grid 1:1. Legacy (no dims reported yet) falls
  // back to inferred cols + a viewport-height row estimate until real dims
  // arrive. The grid is top/left-aligned; a grid wider (or taller) than the
  // screen pans inside #scroll-container.
  function applyGeometry() {
    if (!terminal) return;
    resizePreservingBottom(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
  }

