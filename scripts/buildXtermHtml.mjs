#!/usr/bin/env node
/**
 * Generates src/terminal/xterm.html: a fully self-contained, offline,
 * CSP-locked page that hosts xterm.js for the raw-terminal mirror. Inlines
 * xterm's JS and CSS from the @xterm/xterm devDependency plus the RN <->
 * WebView bridge glue below, so the WebView never touches the network.
 *
 * Run manually after an @xterm/xterm upgrade, then commit the regenerated
 * asset:
 *   node scripts/buildXtermHtml.mjs
 *
 * The bridge protocol (message shapes) is defined in
 * src/terminal/terminalBridge.ts; the glue here implements the same
 * contract by hand because this page cannot import TypeScript.
 *
 * EDITING THE GLUE: it lives in a TEMPLATE LITERAL, so a backtick or a ${'$'}{...}
 * anywhere inside it - INCLUDING IN A COMMENT - terminates the string early and
 * fails as a SyntaxError pointing at a random identifier, not at the character
 * responsible. Never quote an identifier with backticks in these comments. A
 * backslash escape does not survive either; build such a character with
 * String.fromCharCode (see ESCAPE).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const xtermJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), 'utf8');
const xtermCss = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8');
const xtermFitJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), 'utf8');
const xtermWebglJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js'), 'utf8');
// @xterm/headless ships a CJS-only bundle (assigns to `exports`, no UMD); the
// wrapper below fakes `exports` and captures the module as a page global. It
// backs the clean feed: a PARSER-ONLY second terminal (no renderer at all),
// far cheaper than a hidden DOM terminal for the same job. The frame is read
// straight from the parsed buffer as PLAIN CELL TEXT (translateToString), so
// no escape sequence can ever leak into the reading view.
const xtermHeadlessJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'headless', 'lib-headless', 'xterm-headless.js'), 'utf8');
const xtermVersion = JSON.parse(readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'package.json'), 'utf8')).version;

const bridgeGlue = `
(function () {
  'use strict';
  // FAITHFUL MIRROR ONLY. This glue renders the desktop's exact grid 1:1 and
  // NEVER resizes the desktop PTY - a shared session must not be reshaped by
  // the phone. The only thing sent up is typed input. The font is sized so the
  // whole frame fits the screen; pinch zoom + pan read the detail.
  var terminal = null;
  var fitAddon = null;
  // WebGL renderer state, reset per createTerminal. See attachWebgl.
  var webglAddon = null;
  var webglRetryTimer = null;
  var webglLossCount = 0;
  // The desktop's grid. knownRows === null means the desktop has not reported
  // its grid yet (pre-0.4.0, or mid-reconnect before the snapshot): infer cols
  // from content and fit rows to the viewport until the real grid arrives as a
  // 'resize'. Fullscreen TUIs cursor-address against the exact grid, so we
  // never render at any other cols/rows; a wider-than-screen grid pans.
  var knownCols = 80;
  var knownRows = null;
  var currentFontSizePx = 12;
  var lastAppCursorMode = false;
  // Last sticky-mode set posted to the host, so a report costs a message only
  // when something actually flipped. Null after every (re-)init: the restored
  // modes must be reported afresh against the new terminal.
  var lastReportedModes = null;
  // Manual pan suppresses follow-the-cursor briefly so incoming output does
  // not fight the user's finger; auto-pan resumes after the pause.
  var MANUAL_PAN_PAUSE_MS = 4000;
  var manualPanUntil = 0;
  // A desktop grid is far wider than a phone, so where the frame OPENS
  // matters. Follow-the-cursor would immediately drag the view to wherever
  // the TUI's cursor happens to sit, dropping the user into the middle of
  // lines with the left edge (where every line, prompt and tree begins) off
  // screen. Open pinned to column 0 at the newest output instead, and hand
  // control over the moment the user actually touches or types.
  var pinnedToStart = true;
  var MIN_AUTO_FONT_PX = 6;
  // Cap the auto-fit font so a very short grid does not produce absurd glyphs;
  // pinch zoom goes higher or lower on demand, bounded by the host's own
  // MAX_TERMINAL_FONT_SIZE_PX rather than anything in this file.
  var MAX_AUTO_FIT_FONT_PX = 20;
  // Ceiling on the row-stretch (see fitGridHeightToViewport): past this the
  // rows read as double-spaced rather than as a terminal.
  var MAX_LINE_HEIGHT = 1.3;
  // Frames the measured height fit may spend converging, and the slop that
  // counts as "fits". The last pass never adjusts, so this is 3 corrections
  // plus a settling measure.
  var HEIGHT_FIT_PASSES = 4;
  var HEIGHT_FIT_TOLERANCE_PX = 0.5;
  // Bumps on every refit so a fit still converging cannot keep adjusting the
  // grid underneath the one that replaced it (a keyboard open fires several
  // viewport changes in a row, and two live loops would each step the font).
  var heightFitGeneration = 0;
  // Scroll units one drag STEP (a single touchmove) may cover. Bounds the
  // payload of a hard fling: every unit is one key sequence inside the batched
  // write, so an uncapped delta would post an arbitrarily long string.
  var MAX_SCROLL_UNITS_PER_STEP = 12;
  // Momentum scrolling. A release faster than the start threshold (finger px
  // per ms, measured over the last samples) keeps scrolling with exponential
  // decay; slower releases stay 1:1 with the finger. The decay is per 16ms
  // frame (0.94^(dt/16)), the keep threshold ends the glide, and the total
  // unit cap bounds what one fling may cost over the relay - each unit is one
  // key sequence, so an unbounded glide would be an unbounded payload.
  // Tuned live 2026-08-02: the first cut (start 0.4, decay 0.94, cap 150)
  // glided ~20 lines and often did not trigger at all, because a long fast
  // drag usually SLOWS just before the finger lifts and fell under the start
  // threshold - reported as "a big scroll doesn't continue". 0.968 per frame
  // is iOS UIScrollView's normal deceleration (0.998 per ms), the start
  // threshold now catches an ordinary flick, and the cap allows a few hundred
  // lines per fling while still bounding the relay payload.
  var FLING_MIN_START_VELOCITY_PX_PER_MS = 0.2;
  var FLING_MIN_KEEP_VELOCITY_PX_PER_MS = 0.04;
  var FLING_DECAY_PER_FRAME = 0.968;
  var FLING_MAX_UNITS_TOTAL = 400;
  var FLING_SAMPLE_WINDOW_MS = 100;
  // Jump-to-latest overshoot sizes. Past-the-end scrolling is a no-op on
  // every mechanism, so overshooting reaches the tail from any depth without
  // knowing it; the constants just bound the one-shot payload (~11 bytes per
  // wheel report, 4 per page key).
  var SCROLL_TO_LATEST_WHEEL_UNITS = 500;
  var SCROLL_TO_LATEST_PAGE_KEYS = 30;
  // Built rather than escaped: this glue lives inside a template literal in
  // scripts/buildXtermHtml.mjs, where a backslash escape would be consumed by
  // the generator instead of reaching the page.
  var ESCAPE = String.fromCharCode(27);
  // What consumeHistoryDrag last decided, and how many bursts it has posted.
  // Read only by the dev probe below. A gesture that "did nothing" has several
  // possible exits (no grid, axis locked horizontal, delta under one unit) and
  // they are indistinguishable from outside; this names which one was taken.
  var lastScrollDecision = null;
  var scrollPostCount = 0;
  // Raw touch delivery counts. The gesture handler reporting nothing is
  // ambiguous on its own: the events may never have reached the page at all
  // (the browser claimed the gesture, or something above the WebView did),
  // which is a completely different fault from a handler that ran and bailed.
  var touchCounts = { start: 0, move: 0, end: 0, cancel: 0 };
  // Set by the host while its pinch gesture is live; see the 'pinch' message.
  var pinchActive = false;
  // How many pinch reports have ARRIVED, by direction. Separates "the RN layer
  // never posted" from "the page mishandled what it got" - from outside, both
  // look like a drag that would not scroll.
  var pinchMessageCounts = { activeTrue: 0, activeFalse: 0 };
  // Input-to-repaint measurement: when a scroll burst was posted, and how long
  // until the FIRST write came back. That gap is what decides whether stepped
  // scrolling reads as responsive or sluggish, and it is the input to the
  // phone-owned-grid design (a grid request costs the same round trip).
  var lastScrollInputAt = null;
  var lastScrollRoundTripMs = null;
  // Monospace cell size relative to font size (Menlo/Consolas ~0.6 wide, ~1.2
  // tall); good enough for the fit-to-screen guess.
  var CELL_WIDTH_RATIO = 0.6;
  var CELL_HEIGHT_RATIO = 1.2;
  // CLEAN FEED (the chat reading view for agents without a structured
  // transcript): a second, HEADLESS terminal (parser + buffer, no renderer)
  // consumes the same bytes; a debounced serialize -> line diff posts
  // readable lines to the host. Off unless init says cleanFeed: true.
  var cleanFeedEnabled = false;
  var cleanTerminal = null;
  var cleanDebounceTimer = null;
  var cleanLastLines = [];
  var CLEAN_FEED_DEBOUNCE_MS = 48;
  var CLEAN_FEED_SCROLLBACK = 200;

  function postToHost(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function scrollContainer() {
    return document.getElementById('scroll-container');
  }

  function fallbackRowCount(fontSizePx) {
    // Only used before the desktop's rows are known: a rough guess so the
    // first paint is close, corrected when the real grid arrives.
    var approximateCellHeight = Math.ceil(fontSizePx * 1.35);
    return Math.max(8, Math.floor(window.innerHeight / approximateCellHeight));
  }

  function resizePreservingBottom(cols, rows) {
    if (cols === terminal.cols && rows === terminal.rows) return;
    var buffer = terminal.buffer.active;
    var wasAtBottom = buffer.viewportY >= buffer.baseY;
    terminal.resize(cols, rows);
    // Follow-tail only when the user was already at the bottom; a reader
    // scrolled up into history must never be yanked back down by a refit.
    if (wasAtBottom) terminal.scrollToBottom();
  }

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
    if (gridHost) gridHost.style.transform = nextOffsetPx === 0 ? '' : 'translateY(' + nextOffsetPx + 'px)';
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

  /**
   * Report the STICKY modes whenever any of them flips.
   *
   * DECCKM drives the quick keys' arrow encoding. The other three exist so the
   * host can REPLAY them: a TUI asserts its modes once at startup and never
   * again, the phone's feed ring evicts those bytes within a few hundred KB,
   * and every later re-init would otherwise render into a different state than
   * the desktop PTY (see src/terminal/modeRestore.ts). This reports PARSED
   * truth, which is why it lives here and not in a scan of the byte stream -
   * a DECSET can arrive split across two chunks.
   */
  function reportModesIfFlipped() {
    if (!terminal || !terminal.modes) return;
    var appCursor = terminal.modes.applicationCursorKeysMode === true;
    var next = {
      type: 'modes',
      applicationCursorKeys: appCursor,
      mouseTrackingMode: terminal.modes.mouseTrackingMode || 'none',
      mouseEncoding: coreMouseEncoding().encoding,
      alternateBuffer: terminal.buffer.active.type === 'alternate',
      // The FIRST report after a (re-)init is a baseline, not a transition: it
      // describes whatever the replayed seed happened to establish. Only a
      // later report reflects the desktop actually changing a mode. The host
      // needs the difference - a baseline that says "no mouse reporting"
      // because the seed lacked the DECSETs must not be allowed to overwrite
      // the modes it is holding in order to restore them, which would latch the
      // degraded state in permanently.
      initial: lastReportedModes === null,
    };
    if (
      lastReportedModes !== null &&
      lastReportedModes.applicationCursorKeys === next.applicationCursorKeys &&
      lastReportedModes.mouseTrackingMode === next.mouseTrackingMode &&
      lastReportedModes.mouseEncoding === next.mouseEncoding &&
      lastReportedModes.alternateBuffer === next.alternateBuffer
    ) {
      return;
    }
    lastReportedModes = next;
    lastAppCursorMode = appCursor;
    postToHost(next);
  }

  function afterWriteFlushed() {
    reportModesIfFlipped();
    panToCursor();
    followCursorVertically(false);
  }

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
      terminal.scrollToBottom();
      return;
    }
    scrollHistoryByUnits(mechanism === 'mouse' ? SCROLL_TO_LATEST_WHEEL_UNITS : SCROLL_TO_LATEST_PAGE_KEYS, mechanism);
  }

  // Ported from the desktop renderer's terminal-webgl.ts. xterm's WebGL renderer
  // is 10-50x faster than the DOM fallback for output bursts. The GPU can drop
  // the context (driver reset, memory pressure); the naive "dispose on loss"
  // permanently reverts to the DOM renderer, so every later burst becomes slow.
  // Instead, on a loss we RETRY re-init with a backoff, and only give up (DOM for
  // good) after the retries are exhausted. The desktop's per-page WebGL attach
  // budget / LRU coordinator is deliberately omitted: a phone hosts exactly one
  // xterm per WebView, so it never approaches Chromium's per-page context cap.
  var WEBGL_RETRY_DELAYS_MS = [2000, 10000];

  function attachWebgl() {
    if (!terminal) return false;
    try {
      var addon = new window.WebglAddon.WebglAddon();
      addon.onContextLoss(handleWebglContextLoss);
      terminal.loadAddon(addon);
      webglAddon = addon;
      return true;
    } catch (webglError) {
      // WebGL unavailable in this WebView (no GPU / blocklisted): DOM stays.
      webglAddon = null;
      return false;
    }
  }

  function handleWebglContextLoss() {
    if (webglAddon) {
      try { webglAddon.dispose(); } catch (disposeError) { /* may already be gone */ }
      webglAddon = null;
    }
    reportRenderer(); // now on the DOM renderer until (and unless) a retry recovers WebGL
    webglLossCount += 1;
    if (webglLossCount > WEBGL_RETRY_DELAYS_MS.length) return; // give up: DOM renderer for good
    if (webglRetryTimer !== null) clearTimeout(webglRetryTimer);
    webglRetryTimer = setTimeout(function () {
      webglRetryTimer = null;
      attachWebgl();
      reportRenderer();
    }, WEBGL_RETRY_DELAYS_MS[webglLossCount - 1]);
  }

  function resetWebglState() {
    if (webglRetryTimer !== null) {
      clearTimeout(webglRetryTimer);
      webglRetryTimer = null;
    }
    // A fresh createTerminal disposed the old terminal (and its addon) already.
    webglAddon = null;
    webglLossCount = 0;
  }

  // Report the active renderer to the host (like the desktop's renderer report),
  // so a degraded terminal is observable rather than a silent DOM fallback.
  function reportRenderer() {
    postToHost({ type: 'renderer', renderer: webglAddon ? 'webgl' : 'dom' });
  }

  // --- Clean feed ---------------------------------------------------------
  // Hand-mirrors src/terminal/cleanFeedDiff.ts (this page cannot import TS);
  // tests/unit/cleanFeedDiff extracts this copy from the generated file and
  // asserts both implementations agree, so they cannot drift silently.
  function diffCleanLines(previousLines, serialized) {
    var newLines = serialized.split('\\n').map(function (line) { return line.replace(/\\s+$/, ''); });
    while (newLines.length > 0 && newLines[newLines.length - 1] === '') {
      newLines.pop();
    }
    var commonPrefixLength = 0;
    var comparableLength = Math.min(newLines.length, previousLines.length);
    for (var index = 0; index < comparableLength; index += 1) {
      if (newLines[index] === previousLines[index]) commonPrefixLength += 1;
      else break;
    }
    if (commonPrefixLength === newLines.length && newLines.length === previousLines.length) {
      return { lines: [], reset: false, nextLines: newLines };
    }
    var reset = commonPrefixLength < previousLines.length;
    var candidateLines = reset ? newLines : newLines.slice(commonPrefixLength);
    var decorative = /^[\\u2500-\\u257F\\s\\-=_\\u00B7\\u2022]+$/;
    var emitted = candidateLines.filter(function (line) {
      return line.length > 0 && !decorative.test(line);
    });
    return { lines: emitted, reset: reset, nextLines: newLines };
  }

  function teardownCleanFeed() {
    if (cleanDebounceTimer !== null) {
      clearTimeout(cleanDebounceTimer);
      cleanDebounceTimer = null;
    }
    if (cleanTerminal) {
      try { cleanTerminal.dispose(); } catch (disposeError) { /* already gone */ }
      cleanTerminal = null;
    }
    cleanLastLines = [];
  }

  function setupCleanFeed(colsForClean, rowsForClean) {
    teardownCleanFeed();
    if (!cleanFeedEnabled) return;
    cleanTerminal = new HeadlessXterm.Terminal({
      cols: colsForClean,
      rows: rowsForClean,
      scrollback: CLEAN_FEED_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  // The parsed frame as PLAIN cell text: every buffer line (scrollback +
  // screen) via translateToString(trimRight) - escape codes never reach
  // cells, so the reading view gets pure text by construction. Fullscreen
  // TUIs live in the ALT buffer, and buffer.active follows them, which is
  // exactly what a reader wants to read.
  function cleanFeedFrameText() {
    var activeBuffer = cleanTerminal.buffer.active;
    var frameLines = [];
    for (var lineIndex = 0; lineIndex < activeBuffer.length; lineIndex += 1) {
      var bufferLine = activeBuffer.getLine(lineIndex);
      frameLines.push(bufferLine ? bufferLine.translateToString(true) : '');
    }
    return frameLines.join('\\n');
  }

  function cleanFeedWrite(data) {
    if (!cleanTerminal || typeof data !== 'string' || data.length === 0) return;
    cleanTerminal.write(data);
    if (cleanDebounceTimer !== null) clearTimeout(cleanDebounceTimer);
    cleanDebounceTimer = setTimeout(flushCleanFeed, CLEAN_FEED_DEBOUNCE_MS);
  }

  function flushCleanFeed() {
    cleanDebounceTimer = null;
    if (!cleanTerminal) return;
    // xterm parses write() asynchronously; a zero-length write's callback is
    // the flush barrier (the desktop's headless frame buffer uses the same).
    cleanTerminal.write('', function () {
      if (!cleanTerminal) return;
      var frameText;
      try {
        frameText = cleanFeedFrameText();
      } catch (frameError) {
        return;
      }
      var result = diffCleanLines(cleanLastLines, frameText);
      cleanLastLines = result.nextLines;
      if (result.lines.length === 0 && !result.reset) return;
      postToHost({ type: 'clean-lines', lines: result.lines, reset: result.reset });
    });
  }
  // --- end clean feed -----------------------------------------------------

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
  // measure means anything) on a fixed budget, and the final pass only
  // measures - so it can never spin, and the centring below always runs
  // against the settled grid.
  function fitGridHeightToViewport(passesLeft, stretchLocked, generation) {
    if (!terminal || generation !== heightFitGeneration) return;
    var screen = document.querySelector('.xterm-screen');
    if (!screen) return;
    var screenHeight = screen.getBoundingClientRect().height;
    if (!(screenHeight > 0) || terminal.rows < 1) return;
    if (passesLeft <= 1) {
      centerGridVertically(screenHeight);
      return;
    }
    var viewportHeight = window.innerHeight;
    var currentLineHeight = terminal.options.lineHeight || 1;
    var baseCellHeight = screenHeight / terminal.rows / currentLineHeight;
    if (!(baseCellHeight > 0)) return;
    var adjusted = false;
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
      centerGridVertically(screenHeight);
      return;
    }
    requestAnimationFrame(function () {
      fitGridHeightToViewport(passesLeft - 1, stretchLocked, generation);
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

  // A refit can SHRINK the grid (the soft keyboard halves the viewport
  // height, so the height-fitted font drops and the frame narrows). The
  // horizontal pan is not automatically reconciled, so a scrollLeft from the
  // wider layout can now point past the end of the content and the screen
  // renders BLANK. Clamp it to what the new content allows, then put the
  // cursor back in view.
  //
  // Live-verified failure this fixes: opening the keyboard in the terminal
  // (which the prompt cards' "More options in terminal" hatch does directly)
  // left scrollLeft at 706 against a 723-wide grid in a 411-wide viewport -
  // 2.3x past the maximum useful scroll - showing an empty frame.
  function clampHorizontalPan() {
    var container = scrollContainer();
    if (!container) return;
    // Still showing the opening view: hold column 0 so a relayout (the soft
    // keyboard, rotation) cannot drift the frame off the left edge before
    // the user has panned anywhere themselves.
    if (pinnedToStart) {
      container.scrollLeft = 0;
      return;
    }
    // Clamp against the RENDERED GRID width, never container.scrollWidth: a
    // shrinking refit leaves stale wider children inside #terminal, so
    // scrollWidth keeps authorizing scroll far past the last column.
    // Measured live on a Pixel 10 with the keyboard up: grid 723 CSS px but
    // container.scrollWidth still 1366, so a scrollLeft of 706 counted as
    // "in bounds" while showing an empty frame.
    var screen = document.querySelector('.xterm-screen') || document.querySelector('.xterm');
    var contentWidth = screen ? screen.getBoundingClientRect().width : container.scrollWidth;
    var maxScrollLeft = Math.max(0, contentWidth - container.clientWidth);
    if (container.scrollLeft > maxScrollLeft) container.scrollLeft = maxScrollLeft;
  }

  // Re-fit the font to the CURRENT viewport height, then re-apply the grid.
  // Called whenever the viewport settles or changes - the first-open layout
  // settle (window.innerHeight is not always final the instant the terminal is
  // created, which left the initial fit stale until a manual reload), the soft
  // keyboard, and rotation - so the fit is never left stale.
  function refit() {
    if (!terminal) return;
    autoFitFontToScreen();
    applyGeometry();
    heightFitGeneration += 1;
    var generation = heightFitGeneration;
    // Measure AFTER the font/geometry pass paints, then true up the height.
    requestAnimationFrame(function () {
      fitGridHeightToViewport(HEIGHT_FIT_PASSES, false, generation);
      // A viewport change is not a user pan: clear the manual-pan pause so
      // the cursor is guaranteed back on screen after the relayout.
      manualPanUntil = 0;
      clampHorizontalPan();
      panToCursor();
      // A refit sizes the grid back to the screen, so the follow offset
      // resolves to zero here - this is what clears a stale zoom translate.
      followCursorVertically(true);
    });
  }

  function onHostMessage(rawData) {
    var message;
    try {
      message = JSON.parse(rawData);
    } catch (parseError) {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'init') {
      // Prefer the in-place reset: it repaints without the dispose-blank. The
      // hard rebuild is only for the flag reset() cannot change.
      if (terminal && cleanFeedEnabled === (message.cleanFeed === true)) {
        softReinit(message);
        return;
      }
      if (terminal) {
        terminal.dispose();
        terminal = null;
        var container = document.getElementById('terminal');
        while (container.firstChild) container.removeChild(container.firstChild);
      }
      initCounts.hard += 1;
      createTerminal(message);
    } else if (message.type === 'write') {
      if (terminal && typeof message.data === 'string') {
        // First write after a scroll burst closes the input-to-repaint loop.
        if (lastScrollInputAt !== null) {
          lastScrollRoundTripMs = Date.now() - lastScrollInputAt;
          lastScrollInputAt = null;
        }
        terminal.write(message.data, afterWriteFlushed);
        cleanFeedWrite(message.data);
      }
    } else if (message.type === 'set-font-size') {
      if (typeof message.fontSizePx === 'number') applyFontSize(message.fontSizePx);
    } else if (message.type === 'refit') {
      // Snap back to the fitted view. This must be the WHOLE refit(), not the
      // font-and-geometry half: applyFontSize cancels any in-flight height fit
      // (heightFitGeneration) but leaves terminal.options.lineHeight wherever
      // the last fit stretched it, while autoFitFontToScreen computes a font as
      // if lineHeight were 1. Only fitGridHeightToViewport reconciles the two,
      // so a refit that skipped it could not undo a zoom - the reset button
      // ran, reported success, and left the grid exactly as wrong as before.
      // clampHorizontalPan and panToCursor were missing for the same reason.
      //
      // The reset button is also the user's LAST-RESORT recovery, so it drops
      // every piece of gesture state as well: a latched pinch flag or a
      // dangling drag anchor must not survive the one control whose whole
      // promise is "put the terminal back into a working state".
      pinchActive = false;
      historyDragAnchorY = null;
      historyDragAxis = null;
      tapDirty = true;
      stopHistoryFling();
      applyVerticalOffset(0);
      refit();
    } else if (message.type === 'scroll-latest') {
      scrollToLatest();
    } else if (message.type === 'pinch') {
      if (message.active === true) pinchMessageCounts.activeTrue += 1;
      else pinchMessageCounts.activeFalse += 1;
      pinchActive = message.active === true;
      if (pinchActive) stopHistoryFling();
      // A finished pinch leaves this page's touch bookkeeping unreliable (it
      // may never have seen touchend for the second finger), so drop the drag
      // state outright. The next move re-anchors on whichever finger is still
      // down, which is what makes zoom-then-scroll work in one gesture.
      if (!pinchActive) {
        historyDragAnchorY = null;
        historyDragAxis = null;
        tapDirty = true;
      }
    } else if (message.type === 'resize') {
      // The desktop's authoritative grid (snapshot, or a desktop-side refit, or
      // the FIRST time dims arrive when they lost the race with init). Adopt it
      // and re-fit the whole frame to screen. READ-ONLY - nothing is sent back.
      if (terminal && typeof message.cols === 'number' && typeof message.rows === 'number') {
        knownCols = message.cols;
        knownRows = message.rows;
        manualPanUntil = 0;
        if (cleanTerminal) cleanTerminal.resize(knownCols, knownRows);
        autoFitFontToScreen();
        applyGeometry();
      }
    }
  }

  // react-native-webview delivers injected messages on 'message' events:
  // document on Android, window on iOS - listen on both.
  var handleMessageEvent = function (event) {
    if (typeof event.data === 'string') onHostMessage(event.data);
  };
  window.addEventListener('message', handleMessageEvent);
  document.addEventListener('message', handleMessageEvent);

  // The WebView viewport changes when the soft keyboard shows/hides or on
  // rotation: re-fit the whole frame to the new viewport so it stays fully
  // visible.
  window.addEventListener('resize', refit);

  // Clean-tap detection (tap toggles the host-side keyboard; drags, pans,
  // and pinches never do): a single touch that ends within the slop radius
  // and time budget posts 'tapped' to the host. Any second finger or real
  // movement marks the gesture dirty.
  var TAP_SLOP_PX = 12;
  var TAP_MAX_MS = 350;
  var tapStartX = 0;
  var tapStartY = 0;
  var tapStartAt = 0;
  var tapDirty = true;
  // Moving reference point for history scrolling (see consumeHistoryDrag). Null
  // whenever the gesture is not a single finger, so a pinch never scrolls.
  var historyDragAnchorY = null;
  // Fixed start of the gesture, used only to decide the axis (the anchor above
  // moves as travel is consumed, so it cannot answer "how far overall").
  var historyDragStartX = 0;
  // 'vertical' | 'horizontal' | null, latched once per gesture.
  var historyDragAxis = null;
  // Travel before the axis is decided. Matches the tap slop, so the same small
  // movement that still counts as a tap also commits to no axis.
  var DRAG_AXIS_SLOP_PX = 12;
  // Momentum state: the velocity window's samples, the generation that cancels
  // an in-flight glide (same pattern as heightFitGeneration), and the stats
  // the dev probe reports.
  var dragSamples = [];
  var flingGeneration = 0;
  var flingStats = { started: 0, totalUnits: 0 };
  // How many re-seeds took the in-place reset vs a full DOM rebuild; the dev
  // probe's way to verify the reset button stopped hard-flashing.
  var initCounts = { hard: 0, soft: 0 };

  /**
   * DEV HARNESS. Everything the terminal knows about its own geometry, modes,
   * and last gesture, plus the three levers that reproduce a user's actions
   * without a user: zoom (what pinch does), refit (what the reset button does),
   * and a raw scroll burst.
   *
   * Installed unconditionally rather than behind an init flag. The code ships in
   * the generated asset either way - Metro cannot tree-shake an .html - so a
   * flag would only decide whether the handle is reachable from inside a page
   * that is already a local file under default-src 'none', with no remote
   * origin and setSupportMultipleWindows off. There is no attacker in this page.
   * The CALLER is what is gated: only TerminalPane's __DEV__ plus
   * EXPO_PUBLIC_KANGENTIC_INSPECT path ever injects against it.
   *
   * Every field is read LAZILY. An 'init' disposes and recreates the terminal,
   * so a captured reference would go stale on the first session swap and report
   * the dead grid's numbers as if they were live.
   */
  /**
   * Which mouse protocol and encoding xterm currently has active.
   *
   * Read through _core because the public API does not expose it, so it is
   * wrapped: a private field that disappears in an xterm upgrade must degrade to
   * "unknown" here rather than throw and take the whole probe with it.
   */
  function coreMouseEncoding() {
    try {
      var service = terminal._core._coreMouseService || terminal._core.coreMouseService;
      return { protocol: service._activeProtocol, encoding: service._activeEncoding };
    } catch (encodingError) {
      return { protocol: 'unknown', encoding: 'unknown' };
    }
  }

  function terminalProbeState() {
    var screen = document.querySelector('.xterm-screen');
    var screenRect = screen ? screen.getBoundingClientRect() : null;
    var gridHost = document.getElementById('terminal');
    var container = scrollContainer();
    var buffer = terminal ? terminal.buffer.active : null;
    var modes = terminal && terminal.modes ? terminal.modes : null;
    var effectiveRows = knownRows !== null ? knownRows : terminal ? terminal.rows : null;
    return {
      buildId: '__XTERM_BUILD_ID__',
      hasTerminal: terminal !== null,
      cols: terminal ? terminal.cols : null,
      rows: terminal ? terminal.rows : null,
      knownCols: knownCols,
      knownRows: knownRows,
      fontSizePx: currentFontSizePx,
      // The stale-stretch suspect: applyFontSize cancels the height fit but
      // leaves lineHeight wherever the previous fit stretched it, and
      // autoFitFontToScreen sizes as if it were 1. If a zoom looks like it did
      // nothing, compare fontSizePx against fontCeilingPx before anything else.
      lineHeight: terminal ? terminal.options.lineHeight : null,
      maxGlTextureSize: maxGlTextureSize,
      fontCeilingPx: terminal ? textureCappedFontPx(1000, knownCols, effectiveRows) : null,
      gridWidthPx: screenRect ? screenRect.width : null,
      gridHeightPx: screenRect ? screenRect.height : null,
      paddingTopPx: gridHost ? gridHost.style.paddingTop : null,
      viewportWidthPx: window.innerWidth,
      viewportHeightPx: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollLeft: container ? container.scrollLeft : null,
      scrollWidth: container ? container.scrollWidth : null,
      clientWidth: container ? container.clientWidth : null,
      bufferType: buffer ? buffer.type : null,
      bufferLength: buffer ? buffer.length : null,
      bufferBaseY: buffer ? buffer.baseY : null,
      bufferViewportY: buffer ? buffer.viewportY : null,
      // mouseTrackingMode only says reporting is ON. The ENCODING says whether
      // SGR (1006) was negotiated, and without it the ESC[<..M form we emit is
      // the wrong format no matter what else is right. xterm's public IModes
      // does not carry the encoding at all, so it comes from the core service;
      // dumped whole because guessing at its shape cost a round trip once.
      mouseTrackingMode: modes ? modes.mouseTrackingMode : null,
      mouseEncoding: coreMouseEncoding(),
      modes: modes ? JSON.parse(JSON.stringify(modes)) : null,
      applicationCursorKeys: modes ? modes.applicationCursorKeysMode : lastAppCursorMode,
      scrollMechanism: scrollMechanism(),
      pinnedToStart: pinnedToStart,
      manualPanActive: Date.now() < manualPanUntil,
      historyDragAxis: historyDragAxis,
      historyDragAnchorY: historyDragAnchorY,
      pinchActive: pinchActive,
      pinchMessageCounts: JSON.parse(JSON.stringify(pinchMessageCounts)),
      heightFitGeneration: heightFitGeneration,
      lastScrollDecision: lastScrollDecision,
      scrollPostCount: scrollPostCount,
      lastScrollRoundTripMs: lastScrollRoundTripMs,
      verticalOffsetPx: verticalOffsetPx,
      flingStats: JSON.parse(JSON.stringify(flingStats)),
      initCounts: JSON.parse(JSON.stringify(initCounts)),
      touchCounts: JSON.parse(JSON.stringify(touchCounts)),
    };
  }

  window.__kangenticTerminal = {
    probe: terminalProbeState,
    // Exactly what a pinch does (TerminalPane posts 'set-font-size'), so a
    // scripted zoom and a real one cannot diverge.
    setFontSize: function (fontSizePx) {
      applyFontSize(fontSizePx);
      return terminalProbeState();
    },
    refit: function () {
      // Through the MESSAGE branch, not refit() directly: the reset button
      // posts {type:'refit'}, and that branch now also drops gesture state, so
      // calling the inner function would test a path the button does not take.
      onHostMessage(JSON.stringify({ type: 'refit' }));
      return terminalProbeState();
    },
    scroll: function (units) {
      scrollHistoryByUnits(units, scrollMechanism());
      return terminalProbeState();
    },
    /**
     * What consumeHistoryDrag WOULD compute for a vertical delta, with no side
     * effects. Isolates the geometry half of the gesture from touch delivery:
     * if a real drag does nothing, this says whether the arithmetic or the
     * events are at fault. Deliberately mirrors the real code path rather than
     * re-deriving it, so the two cannot drift.
     */
    dragUnits: function (deltaPx) {
      var screen = document.querySelector('.xterm-screen');
      if (!screen || !terminal || terminal.rows < 1) return null;
      var gridHeight = screen.getBoundingClientRect().height;
      var mechanism = scrollMechanism();
      var unitHeight = mechanism === 'page' ? gridHeight : gridHeight / terminal.rows;
      return {
        mechanism: mechanism,
        gridHeight: gridHeight,
        unitHeight: unitHeight,
        units: dragToScrollUnits(-deltaPx, unitHeight),
      };
    },
  };

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
        var viewportObserver = new ResizeObserver(function () {
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
})();
`;

/**
 * Build stamp, written into BOTH the page and a TypeScript constant.
 *
 * xterm.html is a Metro ASSET, cached on the device by content hash and not
 * covered by Fast Refresh, so a reload can leave a stale page running against a
 * fresh JS bundle. That failure is silent and looks exactly like a fix that did
 * not work: three separate investigations here chased already-fixed bugs
 * because of it. Comparing the id the page reports against the id the bundle
 * expects turns it into a one-line verdict (see the `term` commands in
 * scripts/mobileInspect.mjs).
 *
 * The hash covers the glue with its placeholder still in place, which keeps it
 * a pure function of the authored source rather than of itself.
 */
const buildId = createHash('sha256').update(bridgeGlue).digest('hex').slice(0, 12);
const stampedGlue = bridgeGlue.replace('__XTERM_BUILD_ID__', buildId);
if (stampedGlue === bridgeGlue) {
  throw new Error('build id placeholder __XTERM_BUILD_ID__ missing from the bridge glue');
}

// Compile the glue (never run it) so a syntax error fails HERE, naming the
// line, instead of shipping a page that silently posts no 'ready' and presents
// as a terminal stuck on "Terminal loading...".
try {
  new Function(stampedGlue);
} catch (glueSyntaxError) {
  throw new Error(`bridge glue does not parse: ${glueSyntaxError.message}`);
}

const html = `<!DOCTYPE html>
<!-- GENERATED FILE - do not hand-edit. Regenerate with: node scripts/buildXtermHtml.mjs (xterm ${xtermVersion}, build ${buildId}) -->
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
${xtermCss}
html, body { margin: 0; padding: 0; background: #000000; height: 100%; overflow: hidden; }
/* The grid fills the phone HEIGHT (autoFitFontToScreen sizes the font to the row
   count) and is pinned top/left: column 0, row 0 start at the top-left corner. A
   wide grid overflows the width and pans right inside #scroll-container (follow-
   the-cursor tracks the active column); a grid taller than the viewport pans down.
   width:max-content keeps the terminal its natural grid width so the overflow is
   real and scrollable rather than wrapped. */
/* Horizontal pans, vertical deliberately does NOT. A one-finger vertical drag
   is history scrolling (consumeHistoryDrag), so the container must not consume
   it as a pan first: with overflow-y auto the browser swallowed the gesture
   whenever zoom had made the grid taller than the screen, and history stopped
   responding. The cost is that the bottom of a zoomed-in frame cannot be
   dragged to, which is the accepted trade for one finger and no modes. */
#scroll-container { width: 100%; height: 100%; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
/* Auto side margins CENTRE a grid narrower than the screen and do nothing to a
   wider one, which is exactly the split we want. The font is fitted to the
   pane's HEIGHT, so a grid whose aspect is taller than the pane's cannot fill
   the width at any font size - the leftover is inherent, not a bug. Pinned
   left it all piles up on the right and reads as a terminal cut short; split
   evenly it reads as a margin. When the grid IS wider, auto margins compute to
   zero, the overflow stays real, and the pan logic is untouched. The VERTICAL
   half of that split is padding-top, set from the measured grid by
   centerGridVertically (it needs the painted height, which no CSS rule has). */
#terminal { width: max-content; margin: 0 auto; }
</style>
</head>
<body>
<div id="scroll-container"><div id="terminal"></div></div>
<script>
${xtermJs}
</script>
<script>
${xtermFitJs}
</script>
<script>
${xtermWebglJs}
</script>
<script>
var HeadlessXterm = (function () { var exports = {}; ${xtermHeadlessJs}
return exports; })();
</script>
<script>
${stampedGlue}
</script>
</body>
</html>
`;

const outputPath = join(repoRoot, 'src', 'terminal', 'xterm.html');
writeFileSync(outputPath, html);

const buildIdPath = join(repoRoot, 'src', 'terminal', 'xtermBuildId.ts');
writeFileSync(
  buildIdPath,
  `/**
 * GENERATED FILE - do not hand-edit. Regenerate with: node scripts/buildXtermHtml.mjs
 *
 * The build id baked into src/terminal/xterm.html by the same run that wrote
 * this file. The JS bundle carries this constant; the WebView reports the one
 * in the page it actually loaded. A mismatch means the device is running a
 * STALE terminal asset (Metro caches xterm.html by content hash and Fast
 * Refresh does not cover assets), which otherwise presents as a fix that did
 * not take.
 */
export const XTERM_BUILD_ID = '${buildId}';
`,
);

process.stdout.write(
  `Wrote ${outputPath} (xterm ${xtermVersion}, ${(html.length / 1024).toFixed(0)} KiB, build ${buildId})\n`,
);
