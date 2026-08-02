  // Keep the cursor in view while output streams once the frame is zoomed in
  // past the viewport. Skips while the user is mid-pan, and until the user
  // has taken the wheel at all (see pinnedToStart).
  function panToCursor() {
    if (!terminal || pinnedToStart || Date.now() < manualPanUntil) return;
    var container = scrollContainer();
    var screen = document.querySelector('.xterm-screen');
    if (!container || !screen) return;
    var screenWidth = screen.getBoundingClientRect().width;
    if (!(screenWidth > 0) || container.scrollWidth <= container.clientWidth) return;
    var cellWidth = screenWidth / terminal.cols;
    var cursorLeft = terminal.buffer.active.cursorX * cellWidth;
    var margin = cellWidth * 4;
    if (cursorLeft < container.scrollLeft + margin) {
      container.scrollLeft = Math.max(0, cursorLeft - margin);
    } else if (cursorLeft > container.scrollLeft + container.clientWidth - margin) {
      container.scrollLeft = cursorLeft - container.clientWidth + margin;
    }
  }

  /**
   * The vertical offset (a translateY, always <= 0) that keeps the cursor row
   * visible inside the viewport when the ZOOMED grid is taller than the
   * screen. Pure so the arithmetic is unit-testable.
   *
   * Vertical drags are history scrolling by design, and the container's
   * overflow-y is hidden - so without this, zooming in clipped the bottom of
   * the frame with NO way to reach it, and a fullscreen TUI keeps its input
   * line and status bar exactly there. Following the cursor shows the part of
   * the frame that is alive, which for a TUI is the part being typed into.
   *
   * The current offset is kept whenever the cursor is already visible, so the
   * view does not drift on every repaint - it moves only when the cursor
   * actually leaves the margin band, mirroring panToCursor's horizontal rule.
   */
  function verticalFollowOffset(cursorTopPx, cursorBottomPx, gridHeightPx, viewportHeightPx, currentOffsetPx, marginPx) {
    if (!(gridHeightPx > viewportHeightPx)) return 0;
    var minOffsetPx = viewportHeightPx - gridHeightPx;
    var next = currentOffsetPx;
    if (cursorTopPx + next < marginPx) {
      next = marginPx - cursorTopPx;
    } else if (cursorBottomPx + next > viewportHeightPx - marginPx) {
      next = viewportHeightPx - marginPx - cursorBottomPx;
    }
    return Math.max(minOffsetPx, Math.min(0, next));
  }

  // Current translateY on the grid host; 0 whenever the grid fits the screen.
  var verticalOffsetPx = 0;

  function applyVerticalOffset(nextOffsetPx) {
    if (nextOffsetPx === verticalOffsetPx) return;
    verticalOffsetPx = nextOffsetPx;
    var gridHost = document.getElementById('terminal');
    // translateZ(0) rides along ALWAYS (matching the #terminal CSS rule this
    // style attribute overrides): it keeps the grid promoted to its own
    // compositor layer, the standard defense against the Android WebView
    // stall where a repainted canvas is not recomposited - observed live as a
    // black terminal after a jump's full redraw that a 1px scroll "fixed".
    if (gridHost) {
      gridHost.style.transform =
        nextOffsetPx === 0 ? 'translateZ(0)' : 'translateY(' + nextOffsetPx + 'px) translateZ(0)';
    }
  }

  // force bypasses the manual-pan pause: a pinch just changed the geometry
  // deliberately, and waiting out the pause would leave the newly-zoomed frame
  // anchored to its top for four seconds with the live rows off screen.
  function followCursorVertically(force) {
    if (!terminal) return;
    if (!force && (pinnedToStart || Date.now() < manualPanUntil)) return;
    var screen = document.querySelector('.xterm-screen');
    if (!screen || terminal.rows < 1) return;
    var gridHeight = screen.getBoundingClientRect().height;
    if (!(gridHeight > 0)) return;
    var cellHeight = gridHeight / terminal.rows;
    var cursorTop = terminal.buffer.active.cursorY * cellHeight;
    applyVerticalOffset(
      verticalFollowOffset(cursorTop, cursorTop + cellHeight, gridHeight, window.innerHeight, verticalOffsetPx, cellHeight * 2),
    );
  }

