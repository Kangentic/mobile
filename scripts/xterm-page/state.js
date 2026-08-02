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
  // The fit aims this far SHORT of the viewport floor. The tolerance band
  // accepts up to half a pixel of overflow and xterm ceils each row's height,
  // so a fit that aims at the exact floor can legally shave the bottom row's
  // descenders - live report: "auto mode on - 1 shell is just barely cut
  // off". Two pixels of clearance costs nothing visible and makes the last
  // row whole by construction.
  var HEIGHT_FIT_BOTTOM_CLEARANCE_PX = 2;
  // How long the viewport must hold still before the guaranteed settle refit
  // runs (see the ResizeObserver). Long enough to sit past the keyboard
  // animation's resize burst, short enough to be invisible.
  var VIEWPORT_SETTLE_REFIT_MS = 250;
  // Probe counter for the settle refits.
  var viewportSettleRefits = 0;
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
  // After a jump, ONE wheel-down report follows a beat later. A quiet
  // Claude Code answers Ctrl+End from scrollback by painting a BLANK frame
  // and does not paint again until the next input or output arrives - proven
  // shared-state: the desktop showed the same black screen as the phone, so
  // this is the TUI's own idle redraw, not a mobile rendering failure. The
  // nudge is exactly the user's manual cure ("scrolling just 1px renders it"):
  // a single wheel-down is a scroll no-op at the bottom but is INPUT, and
  // input makes the TUI paint. One report, so nothing can mis-split.
  var JUMP_RENDER_NUDGE_DELAY_MS = 250;
  // FOLLOW SEMANTICS are the classic terminal contract: AT the bottom, new
  // output follows (which the agent does natively - when its view is at the
  // tail, that is where it draws); scrolled UP, the view STAYS where the user
  // put it until they return - by the jump button, a downward flick, or
  // typing (the TUI snaps to the tail on input). A timed auto-return was
  // built and then removed here on the user's direction: yanking a reader
  // back mid-history is the worse failure. The screen state is SHARED
  // (scrolling the phone scrolls the desktop's view too), which is why the
  // jump button exists at all.
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

