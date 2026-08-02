  window.addEventListener('load', function () {
    var container = scrollContainer();
    if (container) {
      container.addEventListener('touchstart', function (touchEvent) {
        // The user has taken the wheel: stop holding column 0 and let
        // follow-the-cursor resume once their pan settles.
        touchCounts.start += 1;
        pinnedToStart = false;
        manualPanUntil = Date.now() + MANUAL_PAN_PAUSE_MS;
        // A finger landing catches any glide, native-scroller style.
        stopHistoryFling();
        dragSamples = [];
        // A fresh gesture starting with ONE clean finger cannot be a pinch, so
        // it clears the pinch latch even if the host's active:false was lost
        // (self-heal). It cannot misfire against a real pinch: the second
        // finger's own touchstart re-reports 2 touches before any move, and
        // the host re-posts active:true on the way to activation.
        if (touchEvent.touches.length === 1) pinchActive = false;
        if (touchEvent.touches.length === 1) {
          tapDirty = false;
          tapStartX = touchEvent.touches[0].clientX;
          tapStartY = touchEvent.touches[0].clientY;
          tapStartAt = Date.now();
          historyDragAnchorY = touchEvent.touches[0].clientY;
          historyDragStartX = touchEvent.touches[0].clientX;
          historyDragAxis = null;
        } else {
          tapDirty = true;
          historyDragAnchorY = null;
        }
      }, { passive: true });
      container.addEventListener('touchmove', function (touchEvent) {
        touchCounts.move += 1;
        // History scrolling runs BEFORE the tap bookkeeping's early return: a
        // drag is exactly the gesture that dirties the tap, so gating it behind
        // that check would mean it never ran at all.
        consumeHistoryDrag(touchEvent);
        if (tapDirty || touchEvent.touches.length !== 1) {
          tapDirty = true;
          return;
        }
        var deltaX = touchEvent.touches[0].clientX - tapStartX;
        var deltaY = touchEvent.touches[0].clientY - tapStartY;
        if (deltaX * deltaX + deltaY * deltaY > TAP_SLOP_PX * TAP_SLOP_PX) tapDirty = true;
      }, { passive: true });
      // A cancel is the browser TAKING the gesture (it decided the drag is a
      // native pan). Without a handler the anchor was left dangling, so the
      // next drag resumed from a stale reference point.
      container.addEventListener('touchcancel', function () {
        touchCounts.cancel += 1;
        historyDragAnchorY = null;
        historyDragAxis = null;
        tapDirty = true;
        // A cancelled gesture is the browser or RN taking it - never a flick.
        dragSamples = [];
      }, { passive: true });
      container.addEventListener('touchend', function (touchEvent) {
        touchCounts.end += 1;
        if (touchEvent.touches.length > 0) return;
        // Before the anchor clears: the release velocity belongs to the drag
        // that just ended, and the axis it reads is still latched.
        maybeStartHistoryFling();
        historyDragAnchorY = null;
        if (!tapDirty && Date.now() - tapStartAt <= TAP_MAX_MS) {
          postToHost({ type: 'tapped' });
        }
        tapDirty = true;
      }, { passive: true });
      container.addEventListener('click', function () {
        if (terminal) terminal.focus();
      });
      // The scroll-container is 100% of the WebView, so its box height tracks
      // window.innerHeight. Observing it re-fits the moment the viewport box
      // actually settles - which a plain 'resize' listener misses on first open
      // (the RN layout can finalize a beat after the terminal is created). This
      // is what removes the "needs a manual reload to fit" bug, and also covers
      // keyboard/rotation. Debounced to one fit per frame; refit changes only
      // the terminal's CONTENT size, never the container box, so it never loops.
      if (typeof ResizeObserver !== 'undefined') {
        var refitScheduled = false;
        var settleRefitTimer = null;
        var viewportObserver = new ResizeObserver(function () {
          // TRAILING settle refit, re-armed on every event: the keyboard's
          // close animation fires several resizes in a row, each refit CANCELS
          // the previous fit chain (heightFitGeneration), and the last chain
          // can die mid-convergence with no successor - measured live as a
          // grid stuck at its first-guess height (530px in a 635 viewport)
          // with the 105px of slack split into a 52px top pad, reported as
          // "the bottom of the terminal is pushed up ~50px" after dismissing
          // the keyboard. One refit against the SETTLED viewport always
          // completes, so this guarantees exactly that.
          if (settleRefitTimer !== null) clearTimeout(settleRefitTimer);
          settleRefitTimer = setTimeout(function () {
            settleRefitTimer = null;
            viewportSettleRefits += 1;
            refit();
          }, VIEWPORT_SETTLE_REFIT_MS);
          if (refitScheduled) return;
          refitScheduled = true;
          requestAnimationFrame(function () {
            refitScheduled = false;
            refit();
          });
        });
        viewportObserver.observe(container);
      }
    }
    postToHost({ type: 'ready' });
  });
