  // Pick the font so the desktop grid's ROWS fill the FULL phone height,
  // maximizing vertical use of the screen. A wide grid then overflows the width
  // and pans horizontally (follow-the-cursor keeps the active column in view);
  // pinch zoom adjusts from there. Recomputed on rotation so it fills the height
  // in portrait AND landscape. Reported to the host so its pinch baseline
  // matches (no jump on the first pinch).
  function autoFitFontToScreen() {
    if (knownRows === null || knownRows < 1 || knownCols < 1) return;
    var forHeight = window.innerHeight / (knownRows * CELL_HEIGHT_RATIO);
    var fitted = Math.floor(forHeight);
    // AUTO-fit gets a far lower ceiling than pinch: a SHORT desktop grid
    // (a fresh session with ten rows) would otherwise blow up to poster
    // print - a giant prompt glyph filling the phone. Pinch can still go
    // higher for detail work.
    var next = Math.max(MIN_AUTO_FONT_PX, Math.min(MAX_AUTO_FIT_FONT_PX, fitted));
    // The texture cap outranks the fill floor: a very wide desktop grid (the
    // desktop's bottom terminal panel parks sessions around 300 cols) must
    // render small and CORRECT rather than large and clamped-blurry.
    next = textureCappedFontPx(next, knownCols, knownRows);
    if (next !== currentFontSizePx) {
      currentFontSizePx = next;
      if (terminal) terminal.options.fontSize = next;
      postToHost({ type: 'font-size', fontSizePx: next });
    }
  }

  // Render the desktop's EXACT grid 1:1. Legacy (no dims reported yet) falls
  // back to inferred cols + a viewport-height row estimate until real dims
  // arrive. The grid is top/left-aligned; a grid wider (or taller) than the
  // screen pans inside #scroll-container.
  function applyGeometry() {
    if (!terminal) return;
    resizePreservingBottom(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
  }

