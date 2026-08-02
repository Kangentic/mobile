import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every <script> block in the generated xterm.html must PARSE: the page's
 * blocks fail independently in the WebView, so one bad byte in the assembly
 * silently kills the whole bridge glue and the terminal goes black with no
 * error surfaced anywhere. This caught exactly that once; keep it.
 *
 * The glue is authored as plain browser fragments under scripts/xterm-page/
 * and concatenated by scripts/buildXtermHtml.mjs. The behavior tests below
 * extract their functions from THE MODULE FILES (clean per-file boundaries);
 * the assembly test then proves the generated page contains those exact
 * bytes, stamped, in manifest order - so testing the files IS testing what
 * ships. Earlier versions sliced functions out of the 1MB generated html by
 * text markers, which silently drifted: a marker that moved changed what a
 * slice captured and several slices would still parse, giving false greens.
 */
describe('generated xterm.html', () => {
  const generatedHtml = readFileSync(join(__dirname, '..', '..', 'src', 'terminal', 'xterm.html'), 'utf8');
  const pageModulesDir = join(__dirname, '..', '..', 'scripts', 'xterm-page');
  const pageModule = (name: string): string => readFileSync(join(pageModulesDir, name), 'utf8');

  /**
   * A tuning constant, read out of the page fragments themselves. Injecting
   * hand-copied values here would let a page retune (the fling decay, the fit
   * clearance - both retuned live this task) leave these tests green against
   * the OLD numbers, which is exactly the drift this file exists to prevent.
   */
  const pageVar = (name: string): number => {
    for (const fileName of readdirSync(pageModulesDir)) {
      const match = new RegExp(`var ${name} = ([^;]+);`).exec(pageModule(fileName));
      if (match) {
        const value = Number(match[1]);
        if (!Number.isFinite(value)) throw new Error(`var ${name} in ${fileName} is not a number literal`);
        return value;
      }
    }
    throw new Error(`var ${name} not found in any scripts/xterm-page module`);
  };

  /**
   * Guard for the harness preludes: every name a prelude injects must still
   * be REFERENCED by the module it stubs. The old marker-sliced harness
   * carried two injected constants for a jump mechanism the page had
   * abandoned and nothing complained - injected-but-dead vars are silent
   * drift, in the direction that makes tests lie.
   */
  const assertInjectionsAreAlive = (moduleName: string, source: string, injectedNames: string[]): void => {
    const dead = injectedNames.filter((name) => !source.includes(name));
    if (dead.length > 0) {
      throw new Error(
        `${moduleName} no longer references injected: ${dead.join(', ')} - update the harness prelude`,
      );
    }
  };

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
   * (scripts/buildXtermHtml.mjs, where the CSS is actually authored - the CSS
   * is the one part of the page that does NOT live in scripts/xterm-page/),
   * because nothing in CI regenerates xterm.html and diffs it, so an edit to
   * the generator alone would sit green until the next regeneration.
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
    // A refit is a RE-ORIENTATION: it re-pins to column 0 (readers re-orient
    // at the left edge, where every line begins - panning to the CURSOR
    // column dropped them mid-line after every keyboard open/close) and the
    // pinned clamp is what snaps the pan there. The VERTICAL follow must NOT
    // run here: the fit is still converging across frames, and following
    // mid-convergence locked in a stale translate (the settled fit owns it).
    const refitBody = pageModule('refit.js');
    expect(refitBody).toContain('manualPanUntil = 0');
    expect(refitBody).toContain('pinnedToStart = true');
    expect(refitBody).toContain('clampHorizontalPan()');
    expect(refitBody).not.toContain('panToCursor()');
    expect(refitBody).not.toContain('followCursorVertically(');
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
    followed: () => number;
    paddingTop: () => string;
    fontSizePosts: () => number[];
  } {
    // The whole module: the fit, the centring, and the texture-cap cluster.
    // Its load-time GPU probe self-guards (its own try/catch keeps the
    // conservative default when the fake document has no createElement).
    const source = pageModule('heightFit.js');
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
    assertInjectionsAreAlive('heightFit.js', source, [
      'currentFontSizePx',
      'followCursorVertically',
      'heightFitGeneration',
      'MAX_LINE_HEIGHT',
      'HEIGHT_FIT_TOLERANCE_PX',
      'HEIGHT_FIT_BOTTOM_CLEARANCE_PX',
      'MIN_AUTO_FONT_PX',
      'postToHost',
      'requestAnimationFrame',
    ]);
    const build = new Function(
      'terminal',
      'window',
      'document',
      'requestAnimationFrame',
      'postToHost',
      'heightFitGeneration',
      'MAX_LINE_HEIGHT',
      'HEIGHT_FIT_TOLERANCE_PX',
      'HEIGHT_FIT_BOTTOM_CLEARANCE_PX',
      'MIN_AUTO_FONT_PX',
      'initialFontSizePx',
      `var currentFontSizePx = initialFontSizePx;
       var followedAfterSettle = 0;
       function followCursorVertically(force) { followedAfterSettle += 1; }
       ${source}
       return { fit: fitGridHeightToViewport, fontSizePx: function () { return currentFontSizePx; },
                followed: function () { return followedAfterSettle; } };`,
    ) as (...dependencies: unknown[]) => {
      fit: (passesLeft: number, stretchLocked: boolean, generation: number) => void;
      fontSizePx: () => number;
      followed: () => number;
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
      pageVar('MAX_LINE_HEIGHT'),
      pageVar('HEIGHT_FIT_TOLERANCE_PX'),
      pageVar('HEIGHT_FIT_BOTTOM_CLEARANCE_PX'),
      pageVar('MIN_AUTO_FONT_PX'),
      options.fontSizePx,
    );
    return {
      fit: built.fit,
      screenHeight,
      fontSizePx: built.fontSizePx,
      followed: built.followed,
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
    // The vertical follow runs exactly once, from the SETTLED fit - forcing
    // it from refit's first frame sampled mid-convergence geometry (a 48-row
    // stretch transiently overflows before its give-back) and locked in a
    // stale upward translate that shifted the whole frame ("pushed up more").
    expect(harness.followed()).toBe(1);
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
    // applyFontSize is the last function in lifecycle.js; slice from its head.
    const lifecycleSource = pageModule('lifecycle.js');
    const applyFontSizeBody = lifecycleSource.slice(lifecycleSource.indexOf('function applyFontSize('));
    expect(applyFontSizeBody).toContain('function applyFontSize(');
    expect(applyFontSizeBody).toContain('heightFitGeneration += 1');
    expect(applyFontSizeBody).toContain('centerGridFromMeasurement');
  });

  it('runs the height fit from the refit pass, not the geometry pass', () => {
    const refitBody = pageModule('refit.js');
    expect(refitBody).toContain('fitGridHeightToViewport(HEIGHT_FIT_PASSES');
    // Each refit owns a generation, or two live fits step the font together.
    expect(refitBody).toContain('heightFitGeneration += 1');
  });

  /**
   * The keyboard's close animation fires several resizes in a row; each refit
   * cancels the previous fit chain, and the last chain can die mid-convergence
   * with no successor - measured live as a 530px grid in a 635 viewport with a
   * 52px top pad ("the bottom of the terminal is pushed up ~50px"). The
   * observer must therefore always arm a TRAILING refit that runs against the
   * settled viewport, where the fit chain completes uncancelled.
   */
  it('arms a trailing settle refit on every viewport resize', () => {
    const bootstrapSource = pageModule('bootstrap.js');
    const observerBody = bootstrapSource.slice(
      bootstrapSource.indexOf('new ResizeObserver('),
      bootstrapSource.indexOf('viewportObserver.observe('),
    );
    expect(observerBody).toContain('clearTimeout(settleRefitTimer)');
    expect(observerBody).toContain('VIEWPORT_SETTLE_REFIT_MS');
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
    const handlerBody = pageModule('dispatch.js');
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

  /**
   * The bridge between the module files the tests above extract from and the
   * page the phone actually loads. ONE containment assertion proves all of
   * it: the modules ship VERBATIM, in manifest order, inside a single script
   * block, with the build id stamped - so a committed page that lags an
   * edited module (or a module edited without regenerating) fails here
   * rather than shipping green.
   */
  it('assembles the page from the xterm-page modules verbatim, in manifest order', () => {
    const builderSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'buildXtermHtml.mjs'), 'utf8');
    const manifestMatch = /const PAGE_MODULE_ORDER = \[([\s\S]*?)\];/.exec(builderSource);
    expect(manifestMatch, 'builder must declare PAGE_MODULE_ORDER').not.toBeNull();
    const manifest = [...(manifestMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    expect(manifest.length).toBeGreaterThan(0);

    // Directory and manifest agree both ways. The builder throws on this at
    // generation time; catching it here means a stray or missing module file
    // fails CI without anyone running the builder.
    const onDisk = readdirSync(pageModulesDir)
      .filter((name) => name.endsWith('.js'))
      .sort();
    expect([...manifest].sort()).toEqual(onDisk);

    // Reproduce the builder's assembly: prelude + modules + postlude, hash
    // with the placeholder in place, then stamp. These framing strings are
    // deliberately duplicated from the builder - if the builder's framing
    // changes, this containment goes loudly red instead of silently testing
    // different bytes than the page carries.
    const gluePrelude = "\n(function () {\n  'use strict';\n";
    const gluePostlude = '})();\n';
    const bridgeGlue = gluePrelude + manifest.map((name) => pageModule(name)).join('') + gluePostlude;
    const buildId = createHash('sha256').update(bridgeGlue).digest('hex').slice(0, 12);
    expect(generatedHtml).toContain(bridgeGlue.replace('__XTERM_BUILD_ID__', buildId));

    const constantSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'terminal', 'xtermBuildId.ts'),
      'utf8',
    );
    expect(constantSource, 'xtermBuildId.ts must come from the same generator run').toContain(
      `XTERM_BUILD_ID = '${buildId}'`,
    );
  });

  it('clamps a stale scrollLeft to the rendered grid width, not the stale container scrollWidth', () => {
    // Extract the real function from the generated page and run it against
    // the EXACT geometry measured live on a Pixel 10 with the keyboard up:
    // the grid had shrunk to 723 CSS px, but #scroll-container still
    // reported scrollWidth 1366 from stale oversized children, so a
    // scrollLeft of 706 looked "in bounds" while rendering an empty frame.
    const clampSource = pageModule('panClamp.js');
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
    consumeHistoryDrag: (touchEvent: {
      touches: { clientX: number; clientY: number }[];
      changedTouches?: { clientX: number; clientY: number }[];
    }) => void;
    maybeStartHistoryFling: () => void;
    stopHistoryFling: () => void;
    scrollToLatest: () => void;
    netHistoryUnits: () => number;
    flingStats: () => { started: number; totalUnits: number };
    scrolledToBottom: () => number;
    runTimers: () => void;
    pendingTimers: () => number;
    advanceTime: (deltaMs: number) => void;
    drainFrames: (maxFrames?: number) => number;
    pendingFrames: () => number;
    posts: () => { type: string; data?: string }[];
    scrolled: () => number[];
    deltas: () => number[];
    anchorY: () => number | null;
    clearAnchor: () => void;
    setPinchActive: (value: boolean) => void;
    decision: () => { exit: string } | null;
  } {
    const source = pageModule('historyScroll.js');
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
      scrollToBottom: (): void => {
        bottomJumps += 1;
      },
    };
    let bottomJumps = 0;
    const container = options.container ?? { scrollTop: 0, scrollHeight: 600, clientHeight: 600 };
    const fakeDocument = {
      querySelector: (selector: string) =>
        selector === '.xterm-screen'
          ? { getBoundingClientRect: () => ({ height: 600, width: 400, left: 0, top: 0 }) }
          : null,
    };
    // State the module reads and writes but declares elsewhere (state.js and
    // gestureState.js), re-declared with harness-chosen initial values - the
    // anchor starts at 0 rather than the page's null so the first drag of a
    // test already has a reference point. Tuning constants are read from the
    // page itself via pageVar so a retune cannot leave these tests green
    // against stale numbers, and the liveness guard fails the harness the
    // moment the module stops referencing an injected name.
    const injectedState: [string, string][] = [
      ['historyDragAnchorY', '0'],
      ['historyDragStartX', '0'],
      ['historyDragAxis', 'null'],
      ['DRAG_AXIS_SLOP_PX', String(pageVar('DRAG_AXIS_SLOP_PX'))],
      ['lastScrollDecision', 'null'],
      ['scrollPostCount', '0'],
      ['pinchActive', 'false'],
      ['lastScrollInputAt', 'null'],
      ['dragSamples', '[]'],
      ['flingGeneration', '0'],
      ['flingStats', '{ started: 0, totalUnits: 0 }'],
      ['FLING_MIN_START_VELOCITY_PX_PER_MS', String(pageVar('FLING_MIN_START_VELOCITY_PX_PER_MS'))],
      ['FLING_MIN_KEEP_VELOCITY_PX_PER_MS', String(pageVar('FLING_MIN_KEEP_VELOCITY_PX_PER_MS'))],
      ['FLING_DECAY_PER_FRAME', String(pageVar('FLING_DECAY_PER_FRAME'))],
      ['FLING_MAX_UNITS_TOTAL', String(pageVar('FLING_MAX_UNITS_TOTAL'))],
      ['FLING_SAMPLE_WINDOW_MS', String(pageVar('FLING_SAMPLE_WINDOW_MS'))],
      ['netHistoryUnits', '0'],
      ['lastUserScrollAt', '0'],
      ['pendingJumpRepaint', 'false'],
      ['lastJumpAt', 'null'],
      ['lastJumpFirstWriteMs', 'null'],
      ['jumpNudgeCount', '0'],
      ['JUMP_RENDER_NUDGE_DELAY_MS', String(pageVar('JUMP_RENDER_NUDGE_DELAY_MS'))],
    ];
    assertInjectionsAreAlive(
      'historyScroll.js',
      source,
      injectedState.map(([name]) => name),
    );
    const injectedPrelude = injectedState.map(([name, value]) => `var ${name} = ${value};`).join('\n');
    const build = new Function(
      'terminal',
      'document',
      'postToHost',
      'scrollContainer',
      'MAX_SCROLL_UNITS_PER_STEP',
      'ESCAPE',
      'WheelEvent',
      'window',
      'Date',
      'requestAnimationFrame',
      'setTimeout',
      `${injectedPrelude}
       ${source}
       return {
         consumeHistoryDrag: consumeHistoryDrag,
         maybeStartHistoryFling: maybeStartHistoryFling,
         stopHistoryFling: stopHistoryFling,
         scrollToLatest: scrollToLatest,
         netHistoryUnits: function () { return netHistoryUnits; },
         flingStats: function () { return flingStats; },
         anchorY: function () { return historyDragAnchorY; },
         clearAnchor: function () { historyDragAnchorY = null; historyDragAxis = null; },
         setPinchActive: function (value) { pinchActive = value; },
         decision: function () { return lastScrollDecision; },
         feed: function (data) { postToHost({ type: 'input', data: data }); },
       };`,
    ) as (...dependencies: unknown[]) => {
      consumeHistoryDrag: (touchEvent: {
        touches: { clientX: number; clientY: number }[];
        changedTouches?: { clientX: number; clientY: number }[];
      }) => void;
      maybeStartHistoryFling: () => void;
      stopHistoryFling: () => void;
      scrollToLatest: () => void;
      netHistoryUnits: () => number;
      flingStats: () => { started: number; totalUnits: number };
      anchorY: () => number | null;
      clearAnchor: () => void;
      setPinchActive: (value: boolean) => void;
      decision: () => { exit: string } | null;
      feed: (data: string) => void;
    };
    // Deterministic time and frames: fling arithmetic runs entirely on
    // Date.now() deltas and requestAnimationFrame, so the test owns both.
    let fakeNowMs = 0;
    const animationFrameQueue: (() => void)[] = [];
    const timerQueue: { callback: () => void; delayMs: number }[] = [];
    const built = build(
      terminal,
      fakeDocument,
      (message: { type: string; data?: string }) => posts.push(message),
      () => container,
      pageVar('MAX_SCROLL_UNITS_PER_STEP'),
      String.fromCharCode(27),
      function FakeWheelEvent(this: { deltaY: number }, _type: string, init: { deltaY: number }) {
        this.deltaY = init.deltaY;
      },
      // A non-1 ratio on purpose: xterm measures a wheel delta against its
      // DEVICE cell height, so a CSS-px delta silently under-scrolls by exactly
      // this factor. A dpr of 1 here would let that bug pass unnoticed.
      { devicePixelRatio: 2 },
      { now: () => fakeNowMs },
      (callback: () => void) => animationFrameQueue.push(callback),
      (callback: () => void, delayMs: number) => timerQueue.push({ callback, delayMs }),
    );
    feed = built.feed;
    return {
      consumeHistoryDrag: built.consumeHistoryDrag,
      maybeStartHistoryFling: built.maybeStartHistoryFling,
      stopHistoryFling: built.stopHistoryFling,
      scrollToLatest: built.scrollToLatest,
      netHistoryUnits: built.netHistoryUnits,
      flingStats: built.flingStats,
      scrolledToBottom: () => bottomJumps,
      advanceTime: (deltaMs: number) => {
        fakeNowMs += deltaMs;
      },
      /** Fire queued timers in order, advancing the clock by each delay. */
      runTimers: () => {
        while (timerQueue.length > 0) {
          const timer = timerQueue.shift();
          if (timer) {
            fakeNowMs += timer.delayMs;
            timer.callback();
          }
        }
      },
      pendingTimers: () => timerQueue.length,
      /** Run queued frames, 16ms apart, until the glide stops scheduling. */
      drainFrames: (maxFrames = 400) => {
        let framesRun = 0;
        while (animationFrameQueue.length > 0 && framesRun < maxFrames) {
          fakeNowMs += 16;
          const frame = animationFrameQueue.shift();
          frame?.();
          framesRun += 1;
        }
        return framesRun;
      },
      pendingFrames: () => animationFrameQueue.length,
      posts: () => posts,
      scrolled: () => scrolled,
      deltas: () => deltas,
      anchorY: built.anchorY,
      clearAnchor: built.clearAnchor,
      setPinchActive: built.setPinchActive,
      decision: built.decision,
    };
  }

  /**
   * While the host says a pinch is live, no drag may scroll - during a real
   * pinch, a touchmove where only ONE finger moved has changedTouches of
   * length 1 and would otherwise read as a drag.
   */
  it('refuses to scroll while the host reports a live pinch', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });
    harness.setPinchActive(true);

    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });

    expect(harness.decision()).toEqual({ exit: 'pinch-active' });
    expect(harness.posts()).toEqual([]);

    harness.setPinchActive(false);
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });
    expect(harness.decision()).toMatchObject({ exit: 'scrolled' });
  });

  /**
   * The pinch report must come from FINGER COUNT, never the gesture lifecycle:
   * RNGH's PinchGestureHandler calls begin() on the FIRST touch of any kind
   * (one finger included - PinchGestureHandler.kt, STATE_UNDETERMINED branch),
   * so an onBegin-driven report marks every one-finger drag as a pinch and the
   * page refuses the very drag the report is part of. Measured live: 524
   * touchmoves, 3 scrolls (the message-latency window), everything else
   * exiting 'pinch-active'.
   */
  it('reports a pinch on two fingers down, never on gesture begin', () => {
    const paneSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'components', 'terminal', 'TerminalPane.tsx'),
      'utf8',
    );
    expect(paneSource).not.toContain('.onBegin(');
    const touchesDownBody = paneSource.slice(
      paneSource.indexOf('.onTouchesDown('),
      paneSource.indexOf('.onStart('),
    );
    expect(touchesDownBody).toContain('numberOfTouches >= 2');
    // active:false must ride onFinalize, which fires on end AND fail/cancel.
    expect(paneSource).toContain('.onFinalize(');
    // ...and ALSO on the finger count dropping below two: RNGH keeps the pinch
    // handler alive until the LAST finger lifts (PinchGestureHandler.kt ends
    // only on ACTION_UP), so onFinalize alone held the flag up through the
    // whole pinch-keep-one-finger-drag motion.
    const touchesUpBody = paneSource.slice(
      paneSource.indexOf('.onTouchesUp('),
      paneSource.indexOf('.onTouchesCancelled('),
    );
    expect(touchesUpBody).toContain('numberOfTouches <= 1');
  });

  /**
   * Self-heal and last-resort recovery for a LOST active:false: a fresh
   * one-finger touchstart cannot be a pinch, and the reset button's whole
   * promise is a working terminal, so both clear the latch. Without these a
   * single dropped bridge message would relatch scrolling dead - the exact
   * presentation this whole chain of fixes exists to end.
   */
  it('clears a latched pinch on a clean touchstart and on the reset button', () => {
    const bootstrapSource = pageModule('bootstrap.js');
    const touchStartBody = bootstrapSource.slice(
      bootstrapSource.indexOf("addEventListener('touchstart'"),
      bootstrapSource.indexOf("addEventListener('touchmove'"),
    );
    expect(touchStartBody).toContain('pinchActive = false');

    const handlerBody = pageModule('dispatch.js');
    const refitBranch = handlerBody.slice(
      handlerBody.indexOf("message.type === 'refit'"),
      handlerBody.indexOf("message.type === 'pinch'"),
    );
    expect(refitBranch).toContain('pinchActive = false');
    expect(refitBranch).toContain('historyDragAnchorY = null');
  });

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
  /**
   * The second half of the same bug: after the RN pinch gesture claims the
   * touches, this page can stop receiving touchend for a finger and counts it
   * as down forever. Measured live at 15 touchstarts against 13 touchends, with
   * every later one-finger drag exiting 'not-single-finger' - scrolling dead
   * with no way back.
   *
   * A phantom finger never MOVES, so counting the touches that changed rather
   * than the ones the page believes are down steps around it entirely.
   */
  it('scrolls past a phantom finger the page never saw lift', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });
    const phantom = { clientX: 300, clientY: 300 };
    const dragging = { clientX: 0, clientY: 100 };

    harness.consumeHistoryDrag({ touches: [dragging, phantom], changedTouches: [dragging] });

    expect(harness.decision()).toMatchObject({ exit: 'scrolled', units: -5 });
    expect(harness.posts()).toHaveLength(1);
  });

  /** A genuine two-finger pinch still must not scroll: both fingers move. */
  it('ignores a drag while two fingers are actually moving', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });
    const first = { clientX: 0, clientY: 100 };
    const second = { clientX: 300, clientY: 400 };

    harness.consumeHistoryDrag({ touches: [first, second], changedTouches: [first, second] });

    expect(harness.decision()).toEqual({ exit: 'not-single-finger' });
    expect(harness.posts()).toEqual([]);
  });

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

  /**
   * VERTICAL CURSOR-FOLLOW. Vertical drags are history by design and the
   * container never scrolls vertically, so without this offset a zoomed grid
   * simply clipped its bottom - where a fullscreen TUI keeps its input line
   * and status bar - with no way to reach it.
   */
  describe('verticalFollowOffset', () => {
    // The pure function, sliced out of followPan.js: the module's other
    // functions touch document/scrollContainer at call time only, but its
    // trailing state declaration would shadow nothing useful here.
    const followPanSource = pageModule('followPan.js');
    const followSource = followPanSource.slice(
      followPanSource.indexOf('function verticalFollowOffset('),
      followPanSource.indexOf('// Current translateY'),
    );
    const verticalFollowOffset = new Function(`${followSource} return verticalFollowOffset;`)() as (
      cursorTopPx: number,
      cursorBottomPx: number,
      gridHeightPx: number,
      viewportHeightPx: number,
      currentOffsetPx: number,
      marginPx: number,
    ) => number;

    it('is zero whenever the grid fits the viewport', () => {
      expect(verticalFollowOffset(500, 520, 600, 600, -100, 40)).toBe(0);
      expect(verticalFollowOffset(10, 30, 400, 600, -50, 40)).toBe(0);
    });

    it('pulls a below-view cursor up into the margin band', () => {
      // Grid 1400 in a 600 viewport, cursor row at the very bottom: the offset
      // must land the cursor above the bottom margin without overshooting the
      // grid's own end (clamp at viewport - grid = -800).
      const offset = verticalFollowOffset(1370, 1400, 1400, 600, 0, 60);
      expect(offset).toBe(-800);
      // A cursor higher up is brought exactly to the margin line instead.
      expect(verticalFollowOffset(900, 930, 1400, 600, 0, 60)).toBe(600 - 60 - 930);
    });

    it('drops a raised view back down when the cursor is above it', () => {
      expect(verticalFollowOffset(100, 130, 1400, 600, -400, 60)).toBe(-40);
    });

    it('leaves the offset alone while the cursor stays visible', () => {
      expect(verticalFollowOffset(500, 530, 1400, 600, -200, 60)).toBe(-200);
    });

    it('never scrolls above the top of the grid', () => {
      expect(verticalFollowOffset(0, 30, 1400, 600, -200, 60)).toBe(0);
    });
  });

  /** Drives a vertical drag at a chosen speed, then releases. */
  function dragAndRelease(
    harness: ReturnType<typeof buildHistoryScroll>,
    stepPx: number,
    stepMs: number,
    steps: number,
  ): void {
    let fingerY = 0;
    for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
      fingerY += stepPx;
      harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: fingerY }] });
      harness.advanceTime(stepMs);
    }
    harness.maybeStartHistoryFling();
  }

  /**
   * MOMENTUM. A fast release keeps scrolling with decay through the same
   * pipeline as the finger; the glide must actually stop on its own (the decay
   * is real, not a loop until the cap), and its total cost stays bounded.
   */
  it('glides after a fast release, decays, and stops', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    // 25px every 16ms is ~1.6px/ms, far above the 0.4 start threshold.
    dragAndRelease(harness, 25, 16, 5);
    const postsAtRelease = harness.posts().length;
    expect(harness.flingStats().started).toBe(1);

    const framesRun = harness.drainFrames();
    expect(harness.pendingFrames()).toBe(0);
    expect(harness.posts().length).toBeGreaterThan(postsAtRelease + 2);
    expect(harness.flingStats().totalUnits).toBeGreaterThan(10);
    // These two are what PROVE the decay is real rather than the unit cap
    // ending the glide: at ~1.6px/ms and 0.968^frame, the glide covers ~800px
    // (~40 units over ~113 frames). Without decay it runs flat into the
    // 400-unit cap over ~270 frames - a first version of this test accepted
    // exactly that shape and the no-decay mutation survived it.
    expect(harness.flingStats().totalUnits).toBeLessThan(100);
    expect(framesRun).toBeLessThan(200);
  });

  it('does not glide after a slow release', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    // 3px every 16ms is ~0.19px/ms, below the start threshold.
    dragAndRelease(harness, 3, 16, 8);

    expect(harness.flingStats().started).toBe(0);
    expect(harness.pendingFrames()).toBe(0);
  });

  /** Page granularity would turn momentum into surprise page jumps. */
  it('never glides on the page-key mechanism', () => {
    const harness = buildHistoryScroll({ mouseTracking: false, bufferType: 'alternate' });

    dragAndRelease(harness, 700, 16, 3);

    expect(harness.flingStats().started).toBe(0);
  });

  /**
   * JUMP TO LATEST. The depth of the agent's own history is unknowable from
   * the mirror, so the jump OVERSHOOTS - past-the-end scrolling is a no-op on
   * every mechanism, which makes the overshoot exact. With real scrollback it
   * stays local and free.
   */
  /**
   * The jump is Ctrl+End ALONE: the TUI's own depth-independent binding. The
   * first version rode a 500-wheel-report burst along as a fallback, and the
   * agent's stdin parser mis-split it at a buffer boundary, leaking "5;24M"
   * fragments into the composer as literal text. Seven bytes cannot mis-split,
   * so NOTHING may ride along - the no-burst assertions are the regression
   * guard for that incident.
   */
  it('jumps to the latest output with Ctrl+End and nothing else', () => {
    const viaMouse = buildHistoryScroll({ mouseTracking: true });
    viaMouse.scrollToLatest();
    expect(viaMouse.posts()).toHaveLength(1);
    expect(viaMouse.posts()[0].data).toBe(`${String.fromCharCode(27)}[1;5F`);

    const viaViewport = buildHistoryScroll({ bufferType: 'normal' });
    viaViewport.scrollToLatest();
    expect(viaViewport.scrolledToBottom()).toBe(1);
    expect(viaViewport.posts()).toEqual([]);
    expect(viaViewport.pendingTimers()).toBe(0);

    const viaPageKeys = buildHistoryScroll({ mouseTracking: false, bufferType: 'alternate' });
    viaPageKeys.scrollToLatest();
    expect(viaPageKeys.posts()).toHaveLength(1);
    expect(viaPageKeys.posts()[0].data).toBe(`${String.fromCharCode(27)}[1;5F`);
    expect(viaPageKeys.pendingTimers()).toBe(0);
  });

  /**
   * A QUIET Claude Code answers Ctrl+End from scrollback with a BLANK frame
   * and paints nothing further until input or output arrives - proven shared
   * state, the desktop showed the same black screen as the phone. The jump
   * therefore schedules ONE wheel-down a beat later: a scroll no-op at the
   * bottom, but INPUT, which is what makes the TUI paint (the automated form
   * of the user's manual "scroll 1px" cure). Exactly one report - the
   * mis-split hazard rule holds.
   */
  it('nudges the idle TUI to paint after a jump, with a single wheel report', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });
    harness.scrollToLatest();
    expect(harness.posts()).toHaveLength(1);

    harness.runTimers();

    expect(harness.posts()).toHaveLength(2);
    expect(harness.posts()[1].data).toBe(`${String.fromCharCode(27)}[<65;40;15M`);
  });

  /**
   * The probe's "how far back has THIS PHONE scrolled the shared view"
   * ledger. Follow semantics are the classic contract - at the bottom output
   * follows natively, scrolled up the view STAYS (a timed auto-return was
   * built and removed on the user's direction) - so this ledger is
   * diagnostics, not behavior: it answers "who scrolled the desktop back".
   */
  it('keeps a net ledger of phone-caused scrollback', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    // 100px at a 20px cell = 5 units into history.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 100 }] });
    expect(harness.netHistoryUnits()).toBe(5);
    // Dragging 40px back toward the tail repays 2.
    harness.consumeHistoryDrag({ touches: [{ clientX: 0, clientY: 60 }] });
    expect(harness.netHistoryUnits()).toBe(3);
    // The jump anchors the tail; the ledger clamps at zero, never negative.
    harness.scrollToLatest();
    expect(harness.netHistoryUnits()).toBe(0);
  });

  /** A finger landing mid-glide catches the scroll, native-scroller style. */
  it('stops the glide the moment it is told to', () => {
    const harness = buildHistoryScroll({ mouseTracking: true });

    dragAndRelease(harness, 25, 16, 5);
    harness.drainFrames(3);
    const postsAtStop = harness.posts().length;
    harness.stopHistoryFling();
    harness.drainFrames();

    expect(harness.posts().length).toBe(postsAtStop);
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
