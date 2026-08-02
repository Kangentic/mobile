import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every <script> block in the generated xterm.html must PARSE: the page's
 * blocks fail independently in the WebView, so a single bad template escape
 * in buildXtermHtml.mjs (a real newline inside an emitted string literal,
 * say) silently kills the whole bridge glue and the terminal goes black
 * with no error surfaced anywhere. This caught exactly that once; keep it.
 */
describe('generated xterm.html', () => {
  const generatedHtml = readFileSync(join(__dirname, '..', '..', 'src', 'terminal', 'xterm.html'), 'utf8');

  it('contains parseable script blocks only', () => {
    const scriptPattern = /<script>([\s\S]*?)<\/script>/g;
    let scriptCount = 0;
    let match: RegExpExecArray | null;
    while ((match = scriptPattern.exec(generatedHtml)) !== null) {
      scriptCount += 1;
      const source = match[1];
      expect(
        () => new Function(source),
        `script block ${scriptCount} (starts: ${source.slice(0, 50).replace(/\s+/g, ' ')})`,
      ).not.toThrow();
    }
    // xterm + fit + webgl + headless shim + bridge glue.
    expect(scriptCount).toBe(5);
  });

  it('carries the bridge glue markers the pane depends on', () => {
    expect(generatedHtml).toContain("postToHost({ type: 'ready' })");
    expect(generatedHtml).toContain('function diffCleanLines(');
    expect(generatedHtml).toContain('HeadlessXterm.Terminal');
  });

  /**
   * A grid narrower than the pane used to pin left and pile the whole
   * leftover on the right, which reads as a terminal cut short rather than one
   * with a margin (the font is fitted to the pane's HEIGHT, so a grid taller
   * in aspect than the pane cannot fill the width at any font size, and that
   * leftover is inherent - only WHERE it goes was the bug). `margin: 0 auto`
   * centres a narrow grid and computes to zero for a wide one, so the
   * overflow-and-pan path stays untouched either way.
   *
   * Checked against BOTH the committed HTML and its generator
   * (scripts/buildXtermHtml.mjs, where the CSS is actually authored), because
   * nothing in this repo regenerates xterm.html and diffs it - see the
   * "PARSE" guard above for why importing the generator as a module is not an
   * option either. An edit to the generator alone would sit green until the
   * next regeneration without this second check.
   *
   * Matches loosely (width + margin/auto present, not the whole rule
   * byte-for-byte) so a harmless reflow of the CSS does not redden this.
   */
  it('centres a grid narrower than the screen instead of pinning it left', () => {
    const builderSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'buildXtermHtml.mjs'), 'utf8');
    for (const [label, source] of [
      ['the generated page', generatedHtml],
      ['its generator', builderSource],
    ] as const) {
      const rule = /#terminal\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
      expect(rule, `${label}: no #terminal rule found`).not.toBe('');
      expect(rule, `${label}: #terminal rule`).toContain('width: max-content');
      expect(rule, `${label}: #terminal rule`).toMatch(/margin:\s*0\s+auto/);
    }
  });

  /**
   * A refit can SHRINK the grid (the soft keyboard halves the viewport, so
   * the height-fitted font drops and the frame narrows). Live on a Pixel 10
   * this left scrollLeft at 706 against a 723-wide grid in a 411-wide
   * viewport - 2.3x past the useful maximum - and the terminal rendered
   * BLANK. refit() must reconcile the pan, not just the font/geometry.
   */
  it('reconciles the horizontal pan on refit (blank-terminal-after-keyboard guard)', () => {
    expect(generatedHtml).toContain('function clampHorizontalPan(');
    // The clamp and the cursor re-pan must both run from the refit's
    // post-paint pass, and the manual-pan pause must be cleared first (a
    // viewport change is not a user pan, and panToCursor no-ops during one).
    const refitBody = generatedHtml.slice(
      generatedHtml.indexOf('function refit('),
      generatedHtml.indexOf('function onHostMessage('),
    );
    expect(refitBody).toContain('manualPanUntil = 0');
    expect(refitBody).toContain('clampHorizontalPan()');
    expect(refitBody).toContain('panToCursor()');
  });

  /**
   * The height fit, run against a FAKE renderer that reproduces the two
   * roundings the real one applies: a cell height derived from the font's own
   * metrics (not from CELL_HEIGHT_RATIO, which is only an estimate) and CEILED
   * to whole pixels, per row. Those roundings are the whole reason the fit has
   * to measure rather than compute, so a harness that skips them would pass
   * against the very bug this covers.
   */
  function buildHeightFit(options: {
    rows: number;
    viewportHeight: number;
    fontSizePx: number;
    /** Renderer cell height per font pixel, before the line-height stretch. */
    cellHeightRatio: number;
  }): {
    fit: (passesLeft: number, stretchLocked: boolean, generation: number) => void;
    screenHeight: () => number;
    fontSizePx: () => number;
    paddingTop: () => string;
    fontSizePosts: () => number[];
  } {
    const source = generatedHtml.slice(
      generatedHtml.indexOf('function fitGridHeightToViewport('),
      generatedHtml.indexOf("// The GPU's max texture edge"),
    );
    const terminal = { rows: options.rows, options: { fontSize: options.fontSizePx, lineHeight: 1 } };
    const screenHeight = (): number =>
      terminal.rows * Math.ceil(terminal.options.fontSize * options.cellHeightRatio * terminal.options.lineHeight);
    const gridHost = { style: { paddingTop: '0px' } };
    const fakeDocument = {
      querySelector: (selector: string) =>
        selector === '.xterm-screen' ? { getBoundingClientRect: () => ({ height: screenHeight() }) } : null,
      getElementById: (id: string) => (id === 'terminal' ? gridHost : null),
    };
    const fontSizePosts: number[] = [];
    const build = new Function(
      'terminal',
      'window',
      'document',
      'requestAnimationFrame',
      'postToHost',
      'heightFitGeneration',
      'MAX_LINE_HEIGHT',
      'HEIGHT_FIT_TOLERANCE_PX',
      'MIN_AUTO_FONT_PX',
      'initialFontSizePx',
      `var currentFontSizePx = initialFontSizePx;
       ${source}
       return { fit: fitGridHeightToViewport, fontSizePx: function () { return currentFontSizePx; } };`,
    ) as (...dependencies: unknown[]) => {
      fit: (passesLeft: number, stretchLocked: boolean, generation: number) => void;
      fontSizePx: () => number;
    };
    const built = build(
      terminal,
      { innerHeight: options.viewportHeight },
      fakeDocument,
      // Frames run inline: each pass still measures the fake renderer AFTER
      // the previous pass wrote to it, which is the ordering that matters.
      (callback: () => void) => callback(),
      (message: { type: string; fontSizePx?: number }) => {
        if (message.type === 'font-size' && typeof message.fontSizePx === 'number') {
          fontSizePosts.push(message.fontSizePx);
        }
      },
      1,
      1.3,
      0.5,
      6,
      options.fontSizePx,
    );
    return {
      fit: built.fit,
      screenHeight,
      fontSizePx: built.fontSizePx,
      paddingTop: () => gridHost.style.paddingTop,
      fontSizePosts: () => fontSizePosts,
    };
  }

  /**
   * The live failure: with the desktop's terminal open the phone mirrored a
   * 48-row grid, the fit chose font 10 off CELL_HEIGHT_RATIO (1.2), the
   * renderer's real cell was 14px, and 48 x 14 = 672 overflowed a 624px pane -
   * so row 48, the TUI's status line ("plan mode on ..."), was sliced in half
   * at the bottom edge. The fit must land INSIDE the viewport, and still fill
   * it to within one row.
   */
  it('never leaves the grid taller than the pane (clipped-bottom-row guard)', () => {
    const harness = buildHeightFit({ rows: 48, viewportHeight: 624, fontSizePx: 10, cellHeightRatio: 1.33 });
    expect(harness.screenHeight(), 'precondition: the guessed font overflows').toBeGreaterThan(624);

    harness.fit(4, false, 1);

    expect(harness.screenHeight()).toBeLessThanOrEqual(624);
    // Still fills: within one row of the pane, not shrunk into a letterbox.
    expect(harness.screenHeight()).toBeGreaterThan(624 - harness.screenHeight() / 48);
    expect(harness.paddingTop()).toBe('0px');
  });

  /**
   * Overflow caused by the STRETCH (the ceil turning a 1.05 line height into a
   * whole extra pixel per row) must be paid back by the stretch, not by
   * shrinking the glyphs - the font is the readable part.
   */
  it('gives back an overshooting row stretch instead of dropping the font', () => {
    const harness = buildHeightFit({ rows: 40, viewportHeight: 610, fontSizePx: 12, cellHeightRatio: 1.21 });

    harness.fit(4, false, 1);

    expect(harness.screenHeight()).toBeLessThanOrEqual(610);
    expect(harness.fontSizePx()).toBe(12);
    expect(harness.fontSizePosts()).toEqual([]);
  });

  /**
   * The desktop parks a session at whatever surface last displayed it, and its
   * bottom panel is a 14-row strip. A 14-row grid cannot fill a phone at any
   * font the texture cap and the 1.3 line-height ceiling allow, so the
   * leftover is inherent - but pinned to the top it all piles up underneath
   * and reads as a terminal cut in half. Split it evenly, as the horizontal
   * axis already does.
   */
  it('centres a grid shorter than the pane instead of pinning it to the top', () => {
    const harness = buildHeightFit({ rows: 14, viewportHeight: 624, fontSizePx: 16, cellHeightRatio: 1.24 });

    harness.fit(4, false, 1);

    const slack = 624 - harness.screenHeight();
    expect(slack, 'precondition: a 14-row grid cannot fill the pane').toBeGreaterThan(100);
    expect(harness.paddingTop()).toBe(`${Math.floor(slack / 2)}px`);
  });

  /**
   * A keyboard opening fires several viewport changes in a row. Each refit
   * bumps the generation, and a fit still converging from the previous one
   * must abandon rather than keep stepping the font under its successor.
   */
  it('abandons a superseded height fit', () => {
    const harness = buildHeightFit({ rows: 48, viewportHeight: 624, fontSizePx: 10, cellHeightRatio: 1.33 });
    const before = harness.screenHeight();

    harness.fit(4, false, 2);

    expect(harness.screenHeight()).toBe(before);
    expect(harness.fontSizePosts()).toEqual([]);
  });

  /**
   * A pinch is the user taking the size. A fit still converging would keep
   * stepping the font under their finger and post sizes that overwrite the
   * host's pinch baseline mid-gesture, so zoom cancels it - while still
   * re-centring, since a grid that grew past the pane must not keep the
   * padding that a short one earned.
   */
  it('cancels an in-flight height fit when a pinch takes the size', () => {
    const applyFontSizeBody = generatedHtml.slice(
      generatedHtml.indexOf('function applyFontSize('),
      generatedHtml.indexOf('function fitGridHeightToViewport('),
    );
    expect(applyFontSizeBody).toContain('heightFitGeneration += 1');
    expect(applyFontSizeBody).toContain('centerGridFromMeasurement');
  });

  it('runs the height fit from the refit pass, not the geometry pass', () => {
    const refitBody = generatedHtml.slice(
      generatedHtml.indexOf('function refit('),
      generatedHtml.indexOf('function onHostMessage('),
    );
    expect(refitBody).toContain('fitGridHeightToViewport(HEIGHT_FIT_PASSES');
    // Each refit owns a generation, or two live fits step the font together.
    expect(refitBody).toContain('heightFitGeneration += 1');
  });

  /**
   * The reset button and the return-from-background repair BOTH post 'refit',
   * and that branch used to inline a strict subset of refit(): the font and the
   * geometry, but not fitGridHeightToViewport, clampHorizontalPan, or
   * panToCursor. The height fit is the only thing that reconciles a lineHeight
   * a previous fit stretched with a font autoFitFontToScreen computes as if
   * lineHeight were 1 - so after a zoom the button ran, appeared to work, and
   * left the grid exactly as wrong as it found it.
   */
  it('answers a refit message with the whole refit, not the font-and-geometry half', () => {
    const handlerBody = generatedHtml.slice(
      generatedHtml.indexOf('function onHostMessage('),
      generatedHtml.indexOf('var handleMessageEvent'),
    );
    const refitBranch = handlerBody.slice(
      handlerBody.indexOf("message.type === 'refit'"),
      handlerBody.indexOf("message.type === 'resize'"),
    );
    expect(refitBranch).toContain('refit();');
    expect(refitBranch).not.toContain('autoFitFontToScreen()');
    expect(refitBranch).not.toContain('applyGeometry()');
  });

  /**
   * The build stamp is the guardrail against measuring a stale page, so it has
   * to be the one thing that cannot quietly rot: the page and the bundle
   * constant come from a single generator run and must agree.
   */
  it('stamps the same build id into the page and the bundled constant', () => {
    const constantSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'terminal', 'xtermBuildId.ts'),
      'utf8',
    );
    const constantMatch = constantSource.match(/XTERM_BUILD_ID = '([0-9a-f]{12})'/);
    expect(constantMatch, 'xtermBuildId.ts must export a 12-hex-digit id').not.toBeNull();
    expect(generatedHtml).toContain(`buildId: '${constantMatch?.[1]}'`);
    // A surviving placeholder would report a build id that never changes, which
    // is worse than none at all: it reads as permanently fresh.
    expect(generatedHtml).not.toContain('__XTERM_BUILD_ID__');
  });

  it('clamps a stale scrollLeft to the rendered grid width, not the stale container scrollWidth', () => {
    // Extract the real function from the generated page and run it against
    // the EXACT geometry measured live on a Pixel 10 with the keyboard up:
    // the grid had shrunk to 723 CSS px, but #scroll-container still
    // reported scrollWidth 1366 from stale oversized children, so a
    // scrollLeft of 706 looked "in bounds" while rendering an empty frame.
    const clampSource = generatedHtml.slice(
      generatedHtml.indexOf('function clampHorizontalPan('),
      generatedHtml.indexOf('// Re-fit the font to the CURRENT viewport height'),
    );
    const container = { scrollLeft: 705.9, scrollWidth: 1366, clientWidth: 411 };
    const fakeDocument = {
      querySelector: (selector: string) =>
        selector === '.xterm-screen' ? { getBoundingClientRect: () => ({ width: 723 }) } : null,
    };
    const build = new Function(
      'scrollContainer',
      'document',
      'pinnedToStart',
      `${clampSource}; return clampHorizontalPan;`,
    ) as (
      scrollContainer: () => typeof container,
      documentRef: typeof fakeDocument,
      pinnedToStart: boolean,
    ) => () => void;
    build(() => container, fakeDocument, false)();

    // 723 (grid) - 411 (viewport) = 312: the furthest pan still showing content.
    expect(container.scrollLeft).toBe(312);

    // Before the user has panned, the frame holds column 0 outright so a
    // relayout cannot drift the opening view off the left edge.
    const pinnedContainer = { scrollLeft: 705.9, scrollWidth: 1366, clientWidth: 411 };
    build(() => pinnedContainer, fakeDocument, true)();
    expect(pinnedContainer.scrollLeft).toBe(0);
  });

  /**
   * History scrolling, run against the real extracted functions.
   *
   * The bug these cover: with /tui fullscreen the agent lives in the ALTERNATE
   * buffer, which has no scrollback anywhere, so the phone had no history to
   * reach by moving a viewport. The desktop only appears to scroll because
   * xterm turns a WHEEL into arrow keys the agent acts on, and a touch drag
   * fires no wheel event - so the phone sent nothing at all.
   *
   * Defaults give a 20px cell (600px screen / 30 rows) and a container with no
   * vertical pan left, which is the common case once the grid is height-fitted.
   */
  function buildHistoryScroll(options: {
    bufferType?: 'normal' | 'alternate';
    /** Mouse tracking on means xterm can mouse-report a wheel, which is the
     *  line-granular (smooth) path. Off forces the page-key fallback. */
    mouseTracking?: boolean;
    /** Bytes the fake xterm emits per wheel notch, standing in for the mouse
     *  report its real handler would encode. */
    emitPerNotch?: string;
    container?: { scrollTop: number; scrollHeight: number; clientHeight: number };
  }): {
    consumeHistoryDrag: (touchEvent: { touches: { clientX: number; clientY: number }[] }) => void;
    posts: () => { type: string; data?: string }[];
    scrolled: () => number[];
    deltas: () => number[];
    anchorY: () => number | null;
    clearAnchor: () => void;
    decision: () => { exit: string } | null;
  } {
    const source = generatedHtml.slice(
      generatedHtml.indexOf('function dragToScrollUnits('),
      generatedHtml.indexOf("// Ported from the desktop renderer's"),
    );
    const scrolled: number[] = [];
    const deltas: number[] = [];
    const posts: { type: string; data?: string }[] = [];
    let feed: ((data: string) => void) | null = null;
    const terminal = {
      rows: 30,
      cols: 80,
      buffer: { active: { type: options.bufferType ?? 'alternate' } },
      modes: { mouseTrackingMode: options.mouseTracking ? 'vt200' : 'none' },
      element: {
        dispatchEvent: (event: { deltaY: number }): void => {
          deltas.push(event.deltaY);
          if (options.emitPerNotch && feed) feed(options.emitPerNotch);
        },
      },
      scrollLines: (lines: number): void => {
        scrolled.push(lines);
      },
    };
    const container = options.container ?? { scrollTop: 0, scrollHeight: 600, clientHeight: 600 };
    const fakeDocument = {
      querySelector: (selector: string) =>
        selector === '.xterm-screen'
          ? { getBoundingClientRect: () => ({ height: 600, width: 400, left: 0, top: 0 }) }
          : null,
    };
    const build = new Function(
      'terminal',
      'document',
      'postToHost',
      'scrollContainer',
      'MAX_SCROLL_UNITS_PER_STEP',
      'ESCAPE',
      'WheelEvent',
      'window',
      `var historyDragAnchorY = 0;
       var historyDragStartX = 0;
       var historyDragAxis = null;
       var DRAG_AXIS_SLOP_PX = 12;
       var lastScrollDecision = null;
       var scrollPostCount = 0;
       ${source}
       return {
         consumeHistoryDrag: consumeHistoryDrag,
         anchorY: function () { return historyDragAnchorY; },
         clearAnchor: function () { historyDragAnchorY = null; historyDragAxis = null; },
         decision: function () { return lastScrollDecision; },
         feed: function (data) { postToHost({ type: 'input', data: data }); },
       };`,
    ) as (...dependencies: unknown[]) => {
      consumeHistoryDrag: (touchEvent: { touches: { clientX: number; clientY: number }[] }) => void;
      anchorY: () => number | null;
      clearAnchor: () => void;
      decision: () => { exit: string } | null;
      feed: (data: string) => void;
    };
    const built = build(
      terminal,
      fakeDocument,
      (message: { type: string; data?: string }) => posts.push(message),
      () => container,
      12,
      String.fromCharCode(27),
      function FakeWheelEvent(this: { deltaY: number }, _type: string, init: { deltaY: number }) {
        this.deltaY = init.deltaY;
      },
      // A non-1 ratio on purpose: xterm measures a wheel delta against its
      // DEVICE cell height, so a CSS-px delta silently under-scrolls by exactly
      // this factor. A dpr of 1 here would let that bug pass unnoticed.
      { devicePixelRatio: 2 },
    );
    feed = built.feed;
    return {
      consumeHistoryDrag: built.consumeHistoryDrag,
      posts: () => posts,
      scrolled: () => scrolled,
      deltas: () => deltas,
      anchorY: built.anchorY,
      clearAnchor: built.clearAnchor,
      decision: built.decision,
    };
  }

  /**
   * THE ZOOM-THEN-SCROLL BUG, in one test.
   *
   * A second finger nulls the drag anchor. Lifting back down to one finger
   * fires TOUCHEND, not touchstart, and touchend early-returns while any finger
   * is still down - so the drag that follows a pinch had no reference point,
   * and since the anchor is only ever set in touchstart, every single move
   * bailed. Measured live on a Pixel after a real pinch: 201 touchmoves
   * delivered to the page, every one exiting 'not-single-finger', zero scroll.
   * No button could clear it because nothing else touches this state, which is
   * why it read as scrolling being permanently lost after a zoom.
   *
   * The surviving finger is adopted instead: one move to re-anchor, then normal
   * scrolling.
   */
  it('adopts the surviving finger after a pinch instead of bailing forever', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });
    // A pinch left the anchor null while one finger is still on the glass.
    harness.clearAnchor();

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 300 }] });
    expect(harness.decision()).toEqual({ exit: 'anchor-adopted' });
    expect(harness.anchorY()).toBe(300);

    // The very next move scrolls: 100px at a 20px line is 5 lines of history.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 400 }] });
    expect(harness.decision()).toMatchObject({ exit: 'scrolled', units: -5 });
    expect(harness.posts()).toHaveLength(1);
  });

  /**
   * The batching decision, and the reason wheel synthesis was rejected: xterm's
   * alt-buffer handler emits ONE arrow per wheel event with no loop, so N lines
   * via wheels would be N separate data events and therefore N relay messages.
   * A phone on cellular must send ONE write per step, however many lines it
   * carries.
   */
  /**
   * The smooth path, and the one the desktop already proves: with mouse
   * tracking on, a wheel is LINE granular and xterm encodes the mouse report.
   * One notch per line, negative toward history.
   */
  /**
   * A drag that does nothing has several possible exits and they look identical
   * from outside the page, which is precisely what made this bug guesswork:
   * "scrolling stopped" could equally have been the axis lock, a sub-unit
   * remainder, or a grid that had not painted. Naming the exit turns the next
   * report into a reading.
   */
  it('records which exit a drag took, for the dev probe', () => {
    const underSlop = buildHistoryScroll({ mouseTracking: true });
    underSlop.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 5 }] });
    expect(underSlop.decision()).toEqual({ exit: 'under-slop', travelX: 0, travelY: 5 });

    const horizontal = buildHistoryScroll({ mouseTracking: true });
    horizontal.consumeHistoryDrag({ touches: [{ clientX: 100, clientY: 0 }] });
    expect(horizontal.decision()).toEqual({ exit: 'axis-horizontal' });

    // 600px grid over 30 rows is a 20px line, so 100px is 5 lines of history.
    const scrolled = buildHistoryScroll({ mouseTracking: true });
    scrolled.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });
    expect(scrolled.decision()).toEqual({
      exit: 'scrolled',
      units: -5,
      dragged: 100,
      unitHeight: 20,
      gridHeight: 600,
      mechanism: 'mouse',
    });
  });

  it('prefers line-granular wheel notches when mouse tracking is on', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    // A 20px cell (600px / 30 rows), so 100px is 5 lines.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });

    // One SGR wheel-up report per line, written directly rather than routed
    // through xterm's wheel handler (whose internal accumulator emitted on
    // roughly one notch in three, or none at all, depending on the units used).
    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}[<64;40;15M`.repeat(5));
    expect(harness.scrolled()).toEqual([]);
  });

  /**
   * The payload shape this design owns: xterm emits per wheel event, so five
   * notches would otherwise be five relay messages. On a phone that is the
   * wrong shape, so a burst must arrive as ONE write.
   */
  it('coalesces a wheel burst into a single write', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });

    // Five lines, ONE relay message.
    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}[<64;40;15M`.repeat(5));
  });

  /**
   * Without mouse tracking a wheel would degrade to arrow keys, which the agent
   * reads as input history. Fall back to the control it names on screen
   * instead: PgUp/PgDn, page granular.
   */
  it('falls back to page keys when mouse tracking is off', () => {
    const harness = buildHistoryScroll({ mouseTracking: false });

    // A page is the full 600px grid, so 1200px is two of them.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 1200 }] });

    expect(harness.deltas()).toEqual([]);
    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}[5~`.repeat(2));
  });

  /** A finger moving UP walks back toward the live tail: PgDn. */
  it('sends PgDn when the drag returns toward the live tail', () => {
    const harness = buildHistoryScroll({ mouseTracking: false });

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: -600 }] });

    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}[6~`);
  });

  /**
   * Arrows are the thing that does NOT work here: Claude Code reads them as
   * input-history navigation, so an early build recalled the previous message
   * into the composer instead of scrolling. The app says so on screen ("Scroll
   * wheel is sending arrow keys - use PgUp/PgDn to scroll"). Guard the bytes.
   */
  it('never sends arrow keys, which the agent reads as input history', () => {
    const escape = String.fromCharCode(27);
    for (const mouseTracking of [true, false]) {
      const harness = buildHistoryScroll({ mouseTracking, emitPerNotch: `${escape}[<64;10;10M` });
      harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 1200 }] });
      const sent = harness.posts().map((post) => post.data ?? '').join('');
      for (const arrow of [`${escape}[A`, `${escape}[B`, `${escape}OA`, `${escape}OB`]) {
        expect(sent, `mouseTracking=${mouseTracking}`).not.toContain(arrow);
      }
    }
  });

  /**
   * The NORMAL buffer has real scrollback, so the same gesture moves xterm's
   * own viewport by LINE: smooth, and costing no relay traffic at all.
   */
  /**
   * The silence bug, and why the buffer type cannot be the discriminator.
   *
   * This mirror's buffer type reports where the REPLAYED SEED happened to
   * start, not what the remote app is doing. The phone's feed is a ring holding
   * a tail (measured live at 124KB of a 626KB desktop scrollback), so the
   * alt-screen enter emitted once at TUI startup is long evicted, and every
   * re-init afterwards renders into the NORMAL buffer while the desktop PTY is
   * still in the alternate one - confirmed on device: desktop inAltScreen true,
   * phone bufferType 'normal', mouseTrackingMode 'any'.
   *
   * Choosing on the buffer then picked local viewport scrolling through a
   * buffer with no scrollback: nothing moved, nothing was sent, and history
   * scrolling went silent until something happened to re-enter the alt screen.
   */
  it('mouse-reports from the normal buffer when the remote app wants mouse reports', () => {
    const harness = buildHistoryScroll({ bufferType: 'normal', mouseTracking: true });

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });

    expect(harness.decision()).toMatchObject({ exit: 'scrolled', mechanism: 'mouse' });
    expect(harness.scrolled(), 'must not scroll a zero-scrollback buffer locally').toEqual([]);
    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}[<64;40;15M`.repeat(5));
  });

  it('scrolls locally by line and sends nothing in the normal buffer', () => {
    const harness = buildHistoryScroll({ bufferType: 'normal' });

    // A 20px cell (600 / 30 rows), so 100px is 5 lines.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });

    expect(harness.scrolled()).toEqual([-5]);
    expect(harness.posts()).toEqual([]);
  });

  /**
   * A hard fling must not post an arbitrarily long string: every line is one
   * arrow sequence inside the batched write.
   */
  it('caps the units one drag step may scroll', () => {
    const harness = buildHistoryScroll({ bufferType: 'normal' });

    // 2000px at a 20px cell would be 100 lines.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 2000 }] });

    expect(harness.scrolled()).toEqual([-12]);
  });

  /**
   * Vertical is history UNCONDITIONALLY, even when the grid is taller than the
   * screen. An earlier build chained instead (pan to the top edge first, then
   * scroll), which is the standard nested-scroller rule and wrong here: zooming
   * in made the grid taller, so history stopped responding until the user had
   * dragged all the way up. Reported from the device as "when i zoom in, im no
   * longer able to scroll".
   */
  it('scrolls history even when the grid is taller than the screen', () => {
    const harness = buildHistoryScroll({
      mouseTracking: true,
      container: { scrollTop: 120, scrollHeight: 1200, clientHeight: 600 },
    });

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });

    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}[<64;40;15M`.repeat(5));
  });

  /**
   * Axis lock: a left/right pan across a wide grid carries Y jitter, and
   * without a lock that jitter banks up and fires scrolls nobody asked for.
   * The axis is latched once per gesture, so a pan stays a pan.
   */
  it('ignores the vertical component of a horizontal pan', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    // Mostly sideways, with the kind of Y drift a real thumb produces.
    harness.consumeHistoryDrag({ touches: [{ clientX: 90, clientY: 25 }] });
    harness.consumeHistoryDrag({ touches: [{ clientX: 180, clientY: 60 }] });

    expect(harness.deltas()).toEqual([]);
  });

  /**
   * A sub-line drag must leave the anchor alone so the remainder carries into
   * the next event; resetting it would stall a slow drag forever.
   */
  it('banks a sub-line drag instead of discarding it', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 12 }] });
    expect(harness.deltas()).toEqual([]);
    expect(harness.anchorY()).toBe(0);

    // 12 + 12 = 24px, which clears the 20px cell.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 24 }] });
    expect(harness.posts()).toHaveLength(1);
    // Only the consumed 20px advanced the anchor; 4px remain banked.
    expect(harness.anchorY()).toBe(20);
  });

  /** A second finger is a pinch, never a scroll. */
  it('ignores a multi-touch gesture', () => {
    const harness = buildHistoryScroll({});

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }, { clientX: 0, clientY: 200 }] });

    expect(harness.deltas()).toEqual([]);
  });
});
