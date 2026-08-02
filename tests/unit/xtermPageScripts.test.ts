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
    bufferType: 'normal' | 'alternate';
    applicationCursorKeys?: boolean;
    container?: { scrollTop: number; scrollHeight: number; clientHeight: number };
  }): {
    consumeHistoryDrag: (touchEvent: { touches: { clientY: number }[] }) => void;
    posts: () => { type: string; data?: string }[];
    scrolled: () => number[];
    anchorY: () => number | null;
  } {
    const source = generatedHtml.slice(
      generatedHtml.indexOf('function dragToScrollLines('),
      generatedHtml.indexOf("// Ported from the desktop renderer's"),
    );
    const scrolled: number[] = [];
    const posts: { type: string; data?: string }[] = [];
    const terminal = {
      rows: 30,
      buffer: { active: { type: options.bufferType } },
      scrollLines: (lines: number): void => {
        scrolled.push(lines);
      },
    };
    const container = options.container ?? { scrollTop: 0, scrollHeight: 600, clientHeight: 600 };
    const fakeDocument = {
      querySelector: (selector: string) =>
        selector === '.xterm-screen' ? { getBoundingClientRect: () => ({ height: 600 }) } : null,
    };
    const build = new Function(
      'terminal',
      'document',
      'postToHost',
      'scrollContainer',
      'MAX_SCROLL_LINES_PER_STEP',
      'ESCAPE',
      'lastAppCursorMode',
      `var historyDragAnchorY = 0;
       ${source}
       return {
         consumeHistoryDrag: consumeHistoryDrag,
         anchorY: function () { return historyDragAnchorY; },
       };`,
    ) as (...dependencies: unknown[]) => {
      consumeHistoryDrag: (touchEvent: { touches: { clientY: number }[] }) => void;
      anchorY: () => number | null;
    };
    const built = build(
      terminal,
      fakeDocument,
      (message: { type: string; data?: string }) => posts.push(message),
      () => container,
      12,
      String.fromCharCode(27),
      options.applicationCursorKeys ?? false,
    );
    return {
      consumeHistoryDrag: built.consumeHistoryDrag,
      posts: () => posts,
      scrolled: () => scrolled,
      anchorY: built.anchorY,
    };
  }

  /**
   * The batching decision, and the reason wheel synthesis was rejected: xterm's
   * alt-buffer handler emits ONE arrow per wheel event with no loop, so N lines
   * via wheels would be N separate data events and therefore N relay messages.
   * A phone on cellular must send ONE write per step, however many lines it
   * carries.
   */
  it('sends one batched write of N arrows for an alt-buffer drag', () => {
    const harness = buildHistoryScroll({ bufferType: 'alternate' });

    // 100px down at a 20px cell = 5 lines toward history.
    harness.consumeHistoryDrag({ touches: [{ clientY: 100 }] });

    expect(harness.posts()).toHaveLength(1);
    const escape = String.fromCharCode(27);
    expect(harness.posts()[0].data).toBe(`${escape}[A`.repeat(5));
    // The agent owns the scroll in the alt buffer; nothing moves locally.
    expect(harness.scrolled()).toEqual([]);
  });

  /** A finger moving UP walks back toward the live tail, so down-arrows. */
  it('sends down-arrows when the drag returns toward the live tail', () => {
    const harness = buildHistoryScroll({
      bufferType: 'alternate',
      // Give the container no pan left in EITHER direction.
      container: { scrollTop: 0, scrollHeight: 600, clientHeight: 600 },
    });

    harness.consumeHistoryDrag({ touches: [{ clientY: -60 }] });

    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}[B`.repeat(3));
  });

  /**
   * Application-cursor mode changes the introducer. The page already tracks it
   * for the quick-key arrows, so scrolling must read that same flag rather than
   * assume one form - a TUI in DECCKM ignores the wrong one.
   */
  it('follows application-cursor mode for the arrow introducer', () => {
    const harness = buildHistoryScroll({ bufferType: 'alternate', applicationCursorKeys: true });

    harness.consumeHistoryDrag({ touches: [{ clientY: 40 }] });

    expect(harness.posts()[0].data).toBe(`${String.fromCharCode(27)}OA`.repeat(2));
  });

  /**
   * The NORMAL buffer has real scrollback, so the same gesture must move the
   * viewport locally: no round trip, and no keystrokes the agent could misread
   * as input.
   */
  it('scrolls locally and sends nothing in the normal buffer', () => {
    const harness = buildHistoryScroll({ bufferType: 'normal' });

    harness.consumeHistoryDrag({ touches: [{ clientY: 100 }] });

    expect(harness.scrolled()).toEqual([-5]);
    expect(harness.posts()).toEqual([]);
  });

  /**
   * A hard fling must not post an arbitrarily long string: every line is one
   * arrow sequence inside the batched write.
   */
  it('caps the lines one drag step may scroll', () => {
    const harness = buildHistoryScroll({ bufferType: 'normal' });

    // 2000px at a 20px cell would be 100 lines.
    harness.consumeHistoryDrag({ touches: [{ clientY: 2000 }] });

    expect(harness.scrolled()).toEqual([-12]);
  });

  /**
   * Overscroll chaining: while the container still has pan left in the pushed
   * direction (the user zoomed in), the drag pans and must NOT reach history.
   * Without this, zooming in would make every pan fire scroll input at the
   * agent.
   */
  it('pans instead of scrolling history while the container can still move', () => {
    const harness = buildHistoryScroll({
      bufferType: 'alternate',
      container: { scrollTop: 120, scrollHeight: 1200, clientHeight: 600 },
    });

    harness.consumeHistoryDrag({ touches: [{ clientY: 100 }] });

    expect(harness.posts()).toEqual([]);
    // The anchor follows the finger so the pan cannot bank travel that fires as
    // a jump the moment the edge is reached.
    expect(harness.anchorY()).toBe(100);
  });

  /**
   * A sub-line drag must leave the anchor alone so the remainder carries into
   * the next event; resetting it would stall a slow drag forever.
   */
  it('banks a sub-line drag instead of discarding it', () => {
    const harness = buildHistoryScroll({ bufferType: 'normal' });

    harness.consumeHistoryDrag({ touches: [{ clientY: 12 }] });
    expect(harness.scrolled()).toEqual([]);
    expect(harness.anchorY()).toBe(0);

    // 12 + 12 = 24px, which clears the 20px cell.
    harness.consumeHistoryDrag({ touches: [{ clientY: 24 }] });
    expect(harness.scrolled()).toEqual([-1]);
    // Only the consumed 20px advanced the anchor; 4px remain banked.
    expect(harness.anchorY()).toBe(20);
  });

  /** A second finger is a pinch, never a scroll. */
  it('ignores a multi-touch gesture', () => {
    const harness = buildHistoryScroll({ bufferType: 'alternate' });

    harness.consumeHistoryDrag({ touches: [{ clientY: 100 }, { clientY: 200 }] });

    expect(harness.posts()).toEqual([]);
  });
});
