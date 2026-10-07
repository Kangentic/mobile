  // Re-fit the grid to the CURRENT fit height, then re-apply the geometry.
  // Called whenever the viewport settles or changes - the first-open layout
  // settle (window.innerHeight is not always final the instant the terminal is
  // created, which left the initial fit stale until a manual reload), the soft
  // keyboard, rotation, the host's fit-height report, an init - so the fit is
  // never left stale.
  //
  // DETERMINISTIC, whoever calls it: every refit lands on the reference cell
  // for this grid and pane (state.js), so it no longer matters which path ran
  // last. Cases:
  // - A pinch is in force: the user owns the size. Keep it, re-lay the grid,
  //   re-pin the pan. Only the fit button, another session or another grid
  //   clears it.
  // - The computed fit (cellFit.js, the default): the converged cell for this
  //   key, or one computed from the font's metrics, written ONCE from a task.
  //   A fit that lands on the cell already showing writes nothing, so the fit
  //   button over a fitted frame no longer resizes the canvas at all.
  // - The measured chain, as the fallback and the probe's control arm:
  //   - This grid and pane already converged (settledFit): apply that font
  //     and line height directly, and run the chain stretch-locked, so it
  //     measures once and finds nothing to do. Re-running it from line height
  //     1 instead is what made every re-init and every foreground visibly
  //     snap short and re-stretch.
  //   - Otherwise: the reference font, a clean line height of 1, and the
  //     measured height fit converges from there.
  //
  // `trigger` names what started it, for the fit report. The window 'resize'
  // listener hands this function an Event, which reads as 'window-resize'.
  function refit(trigger) {
    if (!terminal) return;
    activeFitTrigger = typeof trigger === 'string' ? trigger : 'window-resize';
    // Every refit is a RE-ORIENTATION - a keyboard opening or closing, a
    // rotation, the reset button - and the reader re-orients at the LEFT
    // edge, where every line, prompt, and tree begins. Re-pinning reuses the
    // opening-view rule wholesale: column 0 now, follow-the-cursor resumes
    // the moment the user touches or types. The previous behavior panned to
    // the CURSOR column after the relayout, which for a TUI can sit mid-line,
    // dropping the reader into the middle of text after every keyboard
    // open/close ("disorienting in resize events").
    pinnedToStart = true;
    if (pinchOverrideFontPx !== null) {
      applyGeometry();
      // Cancels a fit still converging: it would step the font under the
      // user's chosen size. Its stats go with it.
      heightFitGeneration += 1;
      fitChainStats = null;
      requestAnimationFrame(function () {
        manualPanUntil = 0;
        clampHorizontalPan();
      });
      return;
    }
    // Each refit owns a generation, so a chain still converging (or a computed
    // write still queued) cannot adjust the grid under the one that replaced it.
    heightFitGeneration += 1;
    var generation = heightFitGeneration;
    beginFitChainStats();
    if (fitStrategy === 'computed' && runComputedFit(generation)) return;
    // The measured chain: chosen by the host, or the computed fit could not
    // measure the font the way xterm does.
    fitChainStats.strategy = fitStrategy === 'computed' ? 'computed-miss' : 'measured';
    var settled = settledFitForCurrentGrid();
    if (settled !== null) {
      currentFontSizePx = settled.fontSizePx;
      setCellOption('fontSize', settled.fontSizePx);
      setCellOption('lineHeight', settled.lineHeight);
    } else {
      autoFitFontToScreen();
      setCellOption('fontSize', currentFontSizePx);
      // The fit chain below must start from the same clean slate a constructed
      // terminal does: a line-height stretch left over from the PREVIOUS
      // chain makes the new font x old stretch overflow. The chain then
      // misreads that as its own stretch overshooting, hands it back, and
      // LOCKS stretching - so once its font correction lands, nothing can
      // reclaim the slack. Caught live by the fit trace on a fresh open of a
      // parked 210x48 session: settled at line height 1 with a 530px grid in a
      // 635px viewport, stretchLocked by a giveback of the prior chain's 1.194.
      setCellOption('lineHeight', 1);
    }
    applyGeometry();
    // A converged cell runs its chain STRETCH-LOCKED: it is already known to
    // fit this key, and a cell that settled through a giveback is not a fixed
    // point of the stretch step (xterm ceils every row to device pixels), so
    // an unlocked chain re-stretched it, overflowed for a frame and handed it
    // back on every reactivate - seen on a release build as a lens switch
    // back settling at 1.054 after a first settle at 1.055.
    var stretchLocked = settled !== null;
    // Measure AFTER the font/geometry pass paints, then true up the height.
    requestAnimationFrame(function () {
      fitGridHeightToViewport(HEIGHT_FIT_PASSES, stretchLocked, generation);
      manualPanUntil = 0;
      // pinnedToStart makes this snap the pan to column 0. The VERTICAL
      // follow deliberately does NOT run here: the fit above is still
      // converging across frames, and following against mid-convergence
      // geometry locked in a stale translate (see fitGridHeightToViewport's
      // settled paths, which own it now).
      clampHorizontalPan();
    });
  }

  // A VIEWPORT change: the soft keyboard opening or closing, the WebView
  // settling, a rotation. The window 'resize' listener and the
  // ResizeObserver both land here, and one keyboard open fires all three of
  // their triggers. Each used to run a whole refit: measured on a release
  // build (2026-10-03), one keyboard open ran three complete fit chains that
  // all settled on the identical cell, and the shipped refit reset the line
  // height to 1 on each, collapsing and re-stretching the grid three times.
  //
  // The keyboard cannot change the fit (the fit height is the host-measured
  // Terminal lens, which ignores it), so only a change that moves the fit
  // key (currentFitKey) runs the chain: a new fit height, or a grid not yet
  // converged. Width is NOT in the key; a rotation reaches it as a new fit
  // height, from the host's 'fit-height' message (which refits on its own)
  // or, before the host has measured, from the per-width tracker in
  // state.js. Anything else only re-orients: column 0, and the cursor kept
  // in view above the keyboard. A pinch is the user's size, so it only
  // re-orients too.
  function onViewportChange(trigger) {
    if (!terminal) return;
    if (pinchOverrideFontPx === null && settledFitForCurrentGrid() === null) {
      refit(trigger);
      return;
    }
    pinnedToStart = true;
    requestAnimationFrame(function () {
      manualPanUntil = 0;
      clampHorizontalPan();
      followCursorVertically(true);
    });
  }

