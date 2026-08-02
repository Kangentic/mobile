  // HISTORY SCROLLING.
  //
  // A fullscreen TUI (Claude Code under /tui fullscreen) lives in the ALTERNATE
  // buffer, which by spec has no scrollback at all - on the phone or on the
  // desktop. The desktop still scrolls because a mouse WHEEL reaches the agent,
  // which scrolls itself. A touch drag fires no wheel event, so the phone sent
  // nothing and history was simply unreachable.
  //
  // The alt buffer scrolls by PAGE KEYS, not by arrows and not by a wheel.
  // Claude Code says so itself, on screen, when it sees the wrong one:
  //
  //   "Scroll wheel is sending arrow keys - use PgUp/PgDn to scroll"
  //
  // Two earlier attempts got this wrong and are recorded so they are not
  // retried. Sending ARROWS scrolls nothing: the app reads them as input
  // history, so a drag recalled the previous message into the composer
  // (observed on a Pixel 10). Synthesizing a WHEEL lands in the same place,
  // because xterm's alt-buffer branch converts an unconsumed wheel straight
  // back into those same arrows.
  //
  // So the alt buffer moves a PAGE at a time. That is the app's own
  // granularity, not a choice available to us. The normal buffer still scrolls
  // by line, locally, because there the scrollback is real.
  //
  // The one thing we own either way is PAYLOAD SHAPE: a burst becomes ONE
  // write, never one per unit.

  /**
   * Finger travel converted to whole scroll UNITS, capped per step. Negative
   * scrolls toward history. A unit is one page in the alt buffer and one line
   * in the normal buffer, so the caller passes the matching unit height.
   * Sub-unit remainders return 0 so the caller can leave the anchor alone and
   * let a slow drag accumulate rather than stall.
   */
  function dragToScrollUnits(deltaPx, unitHeightPx) {
    if (!(unitHeightPx > 0)) return 0;
    var units = Math.trunc(deltaPx / unitHeightPx);
    return Math.max(-MAX_SCROLL_UNITS_PER_STEP, Math.min(MAX_SCROLL_UNITS_PER_STEP, units));
  }

  /**
   * Which of the three scroll mechanisms this buffer/mode combination allows.
   *
   * 'viewport' - normal buffer: real scrollback, moved locally, LINE granular.
   * 'wheel'    - alt buffer with mouse tracking on: xterm encodes a mouse
   *              report and the agent scrolls itself, LINE granular. This is
   *              exactly what a desktop wheel does, so it is the smooth one and
   *              the one to prefer.
   * 'page'     - alt buffer with no mouse tracking: PgUp/PgDn, the control the
   *              app names on screen. PAGE granular, so noticeably steppier;
   *              only a fallback.
   */
  function scrollMechanism() {
    if (!terminal) return 'page';
    // MOUSE REPORTING IS THE AUTHORITY, not the buffer type.
    //
    // This mirror's buffer type is an artifact of where the replayed seed
    // happened to start, not a fact about the remote app. The phone's feed is a
    // RING: it holds a tail (measured live at 124KB of a 626KB desktop
    // scrollback), so the alt-screen enter that the TUI emitted once at startup
    // is long evicted. Every re-init after that - a tab switch, a session swap,
    // returning from the background - replays a stream that begins mid-frame,
    // and xterm renders it into the NORMAL buffer while the desktop PTY is
    // still in the alternate one. Measured live: desktop inAltScreen true,
    // phone bufferType 'normal', mouseTrackingMode 'any' on both.
    //
    // Deriving the mechanism from the buffer then picked 'viewport', which
    // scrolls LOCALLY through a buffer that has no scrollback: nothing moved and
    // nothing was sent, so history scrolling went completely silent and stayed
    // silent. Asking whether the app wants mouse reports answers the question
    // that actually matters, and is true in either buffer.
    var mouseMode = terminal.modes ? terminal.modes.mouseTrackingMode : null;
    if (mouseMode && mouseMode !== 'none') return 'mouse';
    if (terminal.buffer.active.type !== 'alternate') return 'viewport';
    return 'page';
  }

  /**
   * Move through history by that many units (negative = toward older output).
   * Whatever a burst produces is posted as ONE write, never one per unit.
   */
  function scrollHistoryByUnits(units, mechanism) {
    if (!terminal || !units) return;
    // The phone's own contribution to the shared scroll position. Negative
    // units go toward history; overshooting back down clamps to "at the tail".
    netHistoryUnits = Math.max(0, netHistoryUnits - units);
    if (mechanism === 'viewport') {
      terminal.scrollLines(units);
      return;
    }
    if (mechanism === 'mouse') {
      // Emit the SGR wheel report OURSELVES rather than dispatching a
      // WheelEvent at xterm and hoping it forwards one.
      //
      // Routing through xterm was tried twice and is not steerable from
      // outside: its handler feeds coreMouseService, which ACCUMULATES the
      // delta against the renderer's device cell height and emits only when
      // some internal threshold trips. Measured on a Pixel 10, a CSS-pixel
      // notch produced output on roughly one event in three, and "correcting"
      // the notch to device pixels produced output on NONE. Both readings are
      // the same lesson: that accumulator is not ours to drive.
      //
      // Button 64 is wheel-up (toward history), 65 wheel-down. Coordinates are
      // 1-based cells; the grid centre is as good as anywhere, since a scroll
      // report is not position-sensitive.
      var button = units < 0 ? 64 : 65;
      var column = Math.max(1, Math.ceil(terminal.cols / 2));
      var row = Math.max(1, Math.ceil(terminal.rows / 2));
      var report = ESCAPE + '[<' + button + ';' + column + ';' + row + 'M';
      var burst = '';
      for (var reportIndex = 0; reportIndex < Math.abs(units); reportIndex += 1) burst += report;
      lastScrollInputAt = Date.now();
      postToHost({ type: 'input', data: burst });
      return;
    }
    var key = ESCAPE + (units < 0 ? '[5~' : '[6~');
    var pages = '';
    for (var pageIndex = 0; pageIndex < Math.abs(units); pageIndex += 1) pages += key;
    lastScrollInputAt = Date.now();
    postToHost({ type: 'input', data: pages });
  }

  /**
   * Convert a one-finger vertical drag into history scrolling, but only once
   * the container has no pan left to give in the direction being pushed. That
   * is standard overscroll chaining: a zoomed-in grid pans first and reaches
   * history only at the edge, so the existing pan behaviour is untouched.
   *
   * The anchor advances by exactly what was CONSUMED, never by the raw drag, so
   * the sub-line remainder carries into the next event and a slow drag scrolls
   * smoothly instead of stalling.
   */
  function consumeHistoryDrag(touchEvent) {
    // The RN gesture layer is the authority on whether a pinch is happening.
    if (pinchActive) {
      lastScrollDecision = { exit: 'pinch-active' };
      return;
    }
    // Count the fingers that actually MOVED, not the ones the page believes are
    // down. When the gesture handler above the WebView claims a pinch, the page
    // can stop receiving touchend for a finger and counts it forever - measured
    // live at 15 touchstarts against 13 touchends - so touches.length reported
    // a phantom second finger and every later one-finger drag bailed as
    // multi-touch. A phantom never moves, so it never reaches changedTouches.
    var movingTouches = touchEvent.changedTouches || touchEvent.touches;
    if (movingTouches.length !== 1) {
      lastScrollDecision = { exit: 'not-single-finger' };
      return;
    }
    touchEvent = { touches: [movingTouches[0]], changedTouches: movingTouches };
    // ADOPT THE SURVIVING FINGER.
    //
    // A second finger (a pinch) nulls the anchor, and lifting back down to one
    // finger fires TOUCHEND, not touchstart - and touchend early-returns while
    // any finger is still down. So the drag that follows a zoom used to have no
    // reference point, and since the anchor is only ever set in touchstart,
    // every move bailed until the user lifted off completely and started again.
    // Measured on device: 201 touchmoves, every one exiting 'not-single-finger'.
    // That is the "after zooming, scrolling is lost" report, and no button could
    // clear it because nothing else touches this state.
    if (historyDragAnchorY === null) {
      historyDragAnchorY = touchEvent.touches[0].clientY;
      historyDragStartX = touchEvent.touches[0].clientX;
      historyDragAxis = null;
      lastScrollDecision = { exit: 'anchor-adopted' };
      return;
    }
    var screen = document.querySelector('.xterm-screen');
    if (!screen || !terminal || terminal.rows < 1) {
      lastScrollDecision = { exit: 'no-grid' };
      return;
    }
    var currentY = touchEvent.touches[0].clientY;
    // Axis lock, decided ONCE per gesture past the slop radius: a one-finger
    // drag is EITHER a horizontal pan across a wide grid OR a vertical walk
    // through history, never both. Without it the Y jitter in a left/right pan
    // banks up and fires a scroll nobody asked for.
    //
    // Vertical is UNCONDITIONALLY history. An earlier build chained instead,
    // panning the grid until it hit the top edge and only then scrolling, which
    // is the standard nested-scroller rule and the wrong one here: zooming in
    // makes the grid taller than the screen, so history stopped responding
    // until the user had dragged all the way to the top. The cost is that the
    // bottom of a zoomed frame is no longer reachable by dragging, which is
    // the deliberate trade for keeping this to one finger and no modes.
    if (historyDragAxis === null) {
      var travelX = Math.abs(touchEvent.touches[0].clientX - historyDragStartX);
      var travelY = Math.abs(currentY - historyDragAnchorY);
      if (Math.max(travelX, travelY) < DRAG_AXIS_SLOP_PX) {
        lastScrollDecision = { exit: 'under-slop', travelX: travelX, travelY: travelY };
        return;
      }
      historyDragAxis = travelY > travelX ? 'vertical' : 'horizontal';
    }
    if (historyDragAxis !== 'vertical') {
      lastScrollDecision = { exit: 'axis-horizontal' };
      return;
    }
    // Every vertical move feeds the velocity window, including sub-unit ones -
    // a fast flick often ends before it crosses a single line boundary, and
    // the fling is exactly what makes that flick do something.
    recordDragSample(currentY);
    var dragged = currentY - historyDragAnchorY;
    if (!dragged) {
      lastScrollDecision = { exit: 'no-travel' };
      return;
    }
    var gridHeight = screen.getBoundingClientRect().height;
    var mechanism = scrollMechanism();
    // The unit follows the mechanism, so the content tracks the hand roughly
    // 1:1 either way: a line of travel per line scrolled, or a screenful of
    // travel per page when only the coarse control is available.
    var unitHeight = mechanism === 'page' ? gridHeight : gridHeight / terminal.rows;
    // A finger moving DOWN reveals OLDER content, which is negative units.
    var units = dragToScrollUnits(-dragged, unitHeight);
    if (!units) {
      lastScrollDecision = { exit: 'sub-unit', dragged: dragged, unitHeight: unitHeight, mechanism: mechanism };
      return;
    }
    historyDragAnchorY -= units * unitHeight;
    lastScrollDecision = {
      exit: 'scrolled',
      units: units,
      dragged: dragged,
      unitHeight: unitHeight,
      gridHeight: gridHeight,
      mechanism: mechanism,
    };
    scrollPostCount += 1;
    lastUserScrollAt = Date.now();
    scrollHistoryByUnits(units, mechanism);
  }

  // MOMENTUM. A drag scrolls 1:1 with the finger; releasing above the start
  // velocity keeps the content gliding with exponential decay, which is what
  // makes touch scrolling read as native rather than stepped. The glide runs
  // through the SAME dragToScrollUnits/scrollHistoryByUnits pipeline as the
  // finger, one write per frame at most, so nothing about payload shape or
  // mechanism choice is new here - only the timing source.

  function recordDragSample(clientY) {
    dragSamples.push({ t: Date.now(), y: clientY });
    if (dragSamples.length > 8) dragSamples.shift();
  }

  /** Finger velocity at release, from the samples inside the window. */
  function releaseVelocityPxPerMs() {
    if (dragSamples.length < 2) return 0;
    var newest = dragSamples[dragSamples.length - 1];
    var oldest = null;
    for (var sampleIndex = 0; sampleIndex < dragSamples.length; sampleIndex += 1) {
      if (newest.t - dragSamples[sampleIndex].t <= FLING_SAMPLE_WINDOW_MS) {
        oldest = dragSamples[sampleIndex];
        break;
      }
    }
    if (oldest === null || newest.t === oldest.t) return 0;
    return (newest.y - oldest.y) / (newest.t - oldest.t);
  }

  /** A new touch, a pinch, an init, or the reset button all catch the glide. */
  function stopHistoryFling() {
    flingGeneration += 1;
  }

  function maybeStartHistoryFling() {
    var velocity = releaseVelocityPxPerMs();
    dragSamples = [];
    if (historyDragAxis !== 'vertical') return;
    if (Math.abs(velocity) < FLING_MIN_START_VELOCITY_PX_PER_MS) return;
    // Page granularity turns momentum into several surprise page jumps after
    // the finger has left; the coarse mechanism stays strictly 1:1.
    if (scrollMechanism() === 'page') return;
    flingStats.started += 1;
    flingGeneration += 1;
    var generation = flingGeneration;
    var velocityPxPerMs = velocity;
    var bankPx = 0;
    var unitsEmitted = 0;
    var lastFrameAt = Date.now();
    function glideFrame() {
      if (generation !== flingGeneration || !terminal || terminal.rows < 1) return;
      var screen = document.querySelector('.xterm-screen');
      if (!screen) return;
      var now = Date.now();
      // Clamp a long gap (a janky frame) so the glide cannot teleport.
      var deltaMs = Math.min(64, now - lastFrameAt);
      lastFrameAt = now;
      bankPx += velocityPxPerMs * deltaMs;
      velocityPxPerMs *= Math.pow(FLING_DECAY_PER_FRAME, deltaMs / 16);
      var mechanism = scrollMechanism();
      if (mechanism === 'page') return;
      var unitHeight = screen.getBoundingClientRect().height / terminal.rows;
      var units = dragToScrollUnits(-bankPx, unitHeight);
      if (units !== 0) {
        // Consume exactly what was emitted; the fractional remainder glides on.
        bankPx += units * unitHeight;
        unitsEmitted += Math.abs(units);
        flingStats.totalUnits += Math.abs(units);
        // The glide is the user's scroll still in motion.
        lastUserScrollAt = Date.now();
        scrollHistoryByUnits(units, mechanism);
      }
      if (Math.abs(velocityPxPerMs) >= FLING_MIN_KEEP_VELOCITY_PX_PER_MS && unitsEmitted < FLING_MAX_UNITS_TOTAL) {
        requestAnimationFrame(glideFrame);
      }
    }
    requestAnimationFrame(glideFrame);
  }

  /**
   * Jump to the newest output, whatever the depth. With real scrollback the
   * jump is local; when the AGENT owns its history (the alt-screen TUI) the
   * depth is unknowable from here, so overshoot instead - scrolling past the
   * end is a no-op on every mechanism, which makes the overshoot exact.
   */
  function scrollToLatest() {
    if (!terminal) return;
    stopHistoryFling();
    var mechanism = scrollMechanism();
    if (mechanism === 'viewport') {
      netHistoryUnits = 0;
      terminal.scrollToBottom();
      return;
    }
    // Ctrl+End (CSI 1;5F), ALONE. It is the TUI's own jump-to-bottom binding
    // and depth-independent, where any overshoot burst is a bet on depth -
    // live use found the tail 500+ lines away, and worse, a 500-report burst
    // leaked mis-split fragments ("5;24M") into the composer as literal text:
    // an agent's stdin parser is not guaranteed to reassemble sequences across
    // its own buffer boundaries, so BIG BURSTS ARE HAZARDOUS, not merely
    // wasteful. Seven bytes cannot mis-split. A TUI that does not bind
    // Ctrl+End simply ignores it, and drag/fling still work there.
    lastScrollInputAt = Date.now();
    pendingJumpRepaint = true;
    lastJumpAt = Date.now();
    lastJumpFirstWriteMs = null;
    postToHost({ type: 'input', data: ESCAPE + '[1;5F' });
    netHistoryUnits = 0;
    if (mechanism === 'mouse') {
      // One wheel-down, a beat later: a QUIET Claude Code answers Ctrl+End
      // from scrollback with a BLANK frame and paints nothing further until
      // input or output arrives (proven shared-state - the desktop showed the
      // same black screen). At the bottom the report is a scroll no-op, but it
      // is INPUT, which is exactly what makes the TUI paint - the automated
      // version of the user's own "scroll 1px" cure. A single report cannot
      // mis-split.
      setTimeout(function () {
        if (!terminal || scrollMechanism() !== 'mouse') return;
        jumpNudgeCount += 1;
        var column = Math.max(1, Math.ceil(terminal.cols / 2));
        var row = Math.max(1, Math.ceil(terminal.rows / 2));
        postToHost({ type: 'input', data: ESCAPE + '[<65;' + column + ';' + row + 'M' });
      }, JUMP_RENDER_NUDGE_DELAY_MS);
    }
  }

