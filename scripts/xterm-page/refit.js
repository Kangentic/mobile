  // Re-fit the font to the CURRENT viewport height, then re-apply the grid.
  // Called whenever the viewport settles or changes - the first-open layout
  // settle (window.innerHeight is not always final the instant the terminal is
  // created, which left the initial fit stale until a manual reload), the soft
  // keyboard, and rotation - so the fit is never left stale.
  function refit() {
    if (!terminal) return;
    // Every refit is a RE-ORIENTATION - a keyboard opening or closing, a
    // rotation, the reset button - and the reader re-orients at the LEFT
    // edge, where every line, prompt, and tree begins. Re-pinning reuses the
    // opening-view rule wholesale: column 0 now, follow-the-cursor resumes
    // the moment the user touches or types. The previous behavior panned to
    // the CURSOR column after the relayout, which for a TUI can sit mid-line,
    // dropping the reader into the middle of text after every keyboard
    // open/close ("disorienting in resize events").
    pinnedToStart = true;
    autoFitFontToScreen();
    applyGeometry();
    heightFitGeneration += 1;
    var generation = heightFitGeneration;
    // Measure AFTER the font/geometry pass paints, then true up the height.
    requestAnimationFrame(function () {
      fitGridHeightToViewport(HEIGHT_FIT_PASSES, false, generation);
      manualPanUntil = 0;
      // pinnedToStart makes this snap the pan to column 0. The VERTICAL
      // follow deliberately does NOT run here: the fit above is still
      // converging across frames, and following against mid-convergence
      // geometry locked in a stale translate (see fitGridHeightToViewport's
      // settled paths, which own it now).
      clampHorizontalPan();
    });
  }

