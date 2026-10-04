import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMINAL_FIT_TRIGGERS, decodeTerminalMessage } from '@/terminal/terminalBridge';

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
    // xterm + webgl + headless shim + bridge glue.
    expect(scriptCount).toBe(4);
  });

  it('carries the bridge glue markers the pane depends on', () => {
    expect(generatedHtml).toContain("postToHost({ type: 'ready' })");
    expect(generatedHtml).toContain("postToHost({ type: 'painted'");
    expect(generatedHtml).toContain('function diffCleanLines(');
    expect(generatedHtml).toContain('HeadlessXterm.Terminal');
  });

  /**
   * A fit report's `trigger` crosses the WebView bridge as a string, and the
   * host decodes it through the CLOSED TERMINAL_FIT_TRIGGERS set: anything not
   * in it becomes 'unknown', and the release-build trace silently loses what
   * started the fit. The page names its triggers as string literals (the
   * refit() and onViewportChange() call sites, the refit default, the initial
   * value) with no import tying them to that list, so a rename on either side
   * stays green everywhere else. This scans the page fragments for every
   * literal and checks each against the host's set.
   *
   * Mutation that reddens this: rename one trigger literal in a page script
   * (e.g. 'fit-height' to 'fit-height-x' in dispatch.js).
   */
  it('names only fit triggers the host decodes (page literals against TERMINAL_FIT_TRIGGERS)', () => {
    const hostTriggers: readonly string[] = TERMINAL_FIT_TRIGGERS;
    const namedTriggers: { where: string; trigger: string }[] = [];

    const callSitePattern = /\b(refit|onViewportChange)\(\s*(['"])([^'"]*)\2/g;
    let callSiteCount = 0;
    for (const fileName of readdirSync(pageModulesDir)) {
      for (const match of pageModule(fileName).matchAll(callSitePattern)) {
        callSiteCount += 1;
        namedTriggers.push({ where: `${fileName}: ${match[1]}('${match[3]}')`, trigger: match[3] });
      }
    }
    // refit.js's own fallback, for a refit() handed an Event (the window
    // 'resize' listener) instead of a name, and state.js's initial value.
    const fallbackMatch = /activeFitTrigger = typeof trigger === 'string' \? trigger : '([^']+)';/.exec(pageModule('refit.js'));
    expect(fallbackMatch, "refit.js: the activeFitTrigger fallback line was not found (reworded? update this scan)").not.toBeNull();
    namedTriggers.push({ where: `refit.js: activeFitTrigger fallback '${fallbackMatch?.[1]}'`, trigger: fallbackMatch?.[1] ?? '' });
    const initialMatch = /var activeFitTrigger = '([^']+)';/.exec(pageModule('state.js'));
    expect(initialMatch, 'state.js: the initial activeFitTrigger line was not found (reworded? update this scan)').not.toBeNull();
    namedTriggers.push({ where: `state.js: initial activeFitTrigger '${initialMatch?.[1]}'`, trigger: initialMatch?.[1] ?? '' });

    // So a broken pattern cannot pass by finding nothing: seven call sites
    // exist today (four refit, three onViewportChange).
    expect(callSiteCount, 'the call-site scan found fewer literals than the page has').toBeGreaterThanOrEqual(7);

    const notDecodedByHost = namedTriggers.filter(({ trigger }) => !hostTriggers.includes(trigger)).map(({ where }) => where);
    expect(notDecodedByHost).toEqual([]);
  });

  /**
   * A grid narrower than the pane is PINNED LEFT, as a shorter one is pinned
   * to the top: column 0 and row 0 sit at the identical spot on every open of
   * every task, the maintainer's rule (2026-10). Both used to be centred
   * (`margin: 0 auto`), which read as a margin but moved the grid with the
   * shape of whichever desktop surface a session was parked at.
   *
   * Checked against BOTH the committed HTML and its generator
   * (scripts/buildXtermHtml.mjs, where the CSS is actually authored - the CSS
   * is the one part of the page that does NOT live in scripts/xterm-page/),
   * because nothing in CI regenerates xterm.html and diffs it, so an edit to
   * the generator alone would sit green until the next regeneration.
   *
   * Matches loosely (width + a margin without auto) so a harmless reflow of
   * the CSS does not redden this.
   */
  it('pins a grid narrower than the screen to the left instead of centring it', () => {
    const builderSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'buildXtermHtml.mjs'), 'utf8');
    for (const [label, source] of [
      ['the generated page', generatedHtml],
      ['its generator', builderSource],
    ] as const) {
      const rule = /#terminal\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
      expect(rule, `${label}: no #terminal rule found`).not.toBe('');
      expect(rule, `${label}: #terminal rule`).toContain('width: max-content');
      expect(rule, `${label}: #terminal rule`).toMatch(/margin:\s*0\s*;/);
      expect(rule, `${label}: #terminal rule`).not.toContain('auto');
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
    // onViewportChange, in the same module, follows only on its re-orient
    // path, where nothing is converging (the cell is settled or pinched).
    const refitModule = pageModule('refit.js');
    const refitBody = refitModule.slice(refitModule.indexOf('function refit('), refitModule.indexOf('function onViewportChange('));
    expect(refitBody).toContain('function refit(');
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
    /**
     * The FIT height (state.js's fitViewportHeight), when it differs from the
     * live viewport - i.e. the soft keyboard is open. Defaults to the
     * viewport, which is the keyboard-closed case every other test models.
     */
    fitHeight?: number;
    /**
     * The reference row count the fit is made in (fontGeometry.js's
     * referenceRowsForFit). Defaults to the grid's own rows, which reproduces
     * the fit-this-grid behaviour the older cases here were written against.
     */
    referenceRows?: number;
    /** The line height the chain starts from; defaults to the clean slate, 1. */
    lineHeight?: number;
  }): {
    fit: (passesLeft: number, stretchLocked: boolean, generation: number) => void;
    /** The deferred half of a final-pass giveback: measures once and settles, for the generation it was scheduled in. */
    settleAfterFinalGiveback: (generation: number) => void;
    screenHeight: () => number;
    fontSizePx: () => number;
    lineHeight: () => number;
    followed: () => number;
    paddingTop: () => string;
    settleReports: () => { source: string; fontSizePx: number; gridHeightPx: number }[];
    settledFit: () => { key: string; fontSizePx: number; lineHeight: number } | null;
  } {
    // The whole module: the fit, the settle, and the texture-cap cluster.
    // Its load-time GPU probe self-guards (its own try/catch keeps the
    // conservative default when the fake document has no createElement).
    const source = pageModule('heightFit.js');
    const terminal = { rows: options.rows, options: { fontSize: options.fontSizePx, lineHeight: options.lineHeight ?? 1 } };
    const screenHeight = (): number =>
      terminal.rows * Math.ceil(terminal.options.fontSize * options.cellHeightRatio * terminal.options.lineHeight);
    const gridHost = { style: { paddingTop: '0px' } };
    const fakeDocument = {
      querySelector: (selector: string) =>
        selector === '.xterm-screen' ? { getBoundingClientRect: () => ({ height: screenHeight() }) } : null,
      getElementById: (id: string) => (id === 'terminal' ? gridHost : null),
    };
    const settleReports: { source: string; fontSizePx: number; gridHeightPx: number }[] = [];
    assertInjectionsAreAlive('heightFit.js', source, [
      'currentFontSizePx',
      'followCursorVertically',
      'fitViewportHeight',
      'heightFitGeneration',
      'traceHeightFit',
      'MAX_LINE_HEIGHT',
      'HEIGHT_FIT_TOLERANCE_PX',
      'HEIGHT_FIT_BOTTOM_CLEARANCE_PX',
      'MIN_AUTO_FONT_PX',
      'referenceRowsForFit',
      'currentFitKey',
      'reportFit',
      'settledFit',
      'requestAnimationFrame',
    ]);
    const build = new Function(
      'terminal',
      'window',
      'document',
      'requestAnimationFrame',
      'fitViewportHeight',
      'heightFitGeneration',
      'MAX_LINE_HEIGHT',
      'HEIGHT_FIT_TOLERANCE_PX',
      'HEIGHT_FIT_BOTTOM_CLEARANCE_PX',
      'MIN_AUTO_FONT_PX',
      'initialFontSizePx',
      'referenceRows',
      'onSettleReport',
      `var currentFontSizePx = initialFontSizePx;
       var settledFit = null;
       var followedAfterSettle = 0;
       function followCursorVertically(force) { followedAfterSettle += 1; }
       function traceHeightFit() {}
       function referenceRowsForFit() { return referenceRows; }
       function currentFitKey() { return 'fit-key'; }
       function reportFit(source, gridHeightPx) {
         onSettleReport({ source: source, fontSizePx: currentFontSizePx, gridHeightPx: gridHeightPx });
       }
       ${source}
       return { fit: fitGridHeightToViewport, settleAfterFinalGiveback: settleAfterFinalGiveback,
                fontSizePx: function () { return currentFontSizePx; },
                followed: function () { return followedAfterSettle; },
                settledFit: function () { return settledFit; } };`,
    ) as (...dependencies: unknown[]) => {
      fit: (passesLeft: number, stretchLocked: boolean, generation: number) => void;
      settleAfterFinalGiveback: (generation: number) => void;
      fontSizePx: () => number;
      followed: () => number;
      settledFit: () => { key: string; fontSizePx: number; lineHeight: number } | null;
    };
    const built = build(
      terminal,
      { innerHeight: options.viewportHeight },
      fakeDocument,
      // Frames run inline: each pass still measures the fake renderer AFTER
      // the previous pass wrote to it, which is the ordering that matters.
      (callback: () => void) => callback(),
      () => options.fitHeight ?? options.viewportHeight,
      1,
      pageVar('MAX_LINE_HEIGHT'),
      pageVar('HEIGHT_FIT_TOLERANCE_PX'),
      pageVar('HEIGHT_FIT_BOTTOM_CLEARANCE_PX'),
      pageVar('MIN_AUTO_FONT_PX'),
      options.fontSizePx,
      options.referenceRows ?? options.rows,
      (report: { source: string; fontSizePx: number; gridHeightPx: number }) => {
        settleReports.push(report);
      },
    );
    return {
      fit: built.fit,
      settleAfterFinalGiveback: built.settleAfterFinalGiveback,
      screenHeight,
      fontSizePx: built.fontSizePx,
      lineHeight: () => terminal.options.lineHeight,
      followed: built.followed,
      paddingTop: () => gridHost.style.paddingTop,
      settleReports: () => settleReports,
      settledFit: built.settledFit,
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
   * The soft keyboard. Opening it shrinks window.innerHeight, and the fit
   * used to chase that: the chain walked the font down a step per pass until
   * the whole 38-row grid fit the strip above the keyboard, so the terminal
   * collapsed to near-unreadable at exactly the moment the user was typing
   * into it (seen live on the demo pairing's Pixel walk). The fit must anchor
   * to the orientation's FULL height and let the keyboard simply cover the
   * grid's lower rows - the vertical follow pans the cursor back into view.
   */
  it('keeps the fit when the soft keyboard shrinks the window', () => {
    const fullHeight = 900;
    // 38 rows x ceil(17 x 1.33) = 874: already settled against the FULL
    // height, so any font step the fit takes here is chasing the keyboard.
    const harness = buildHeightFit({
      rows: 38,
      viewportHeight: 380,
      fitHeight: fullHeight,
      fontSizePx: 17,
      cellHeightRatio: 1.33,
    });
    expect(harness.screenHeight(), 'precondition: the grid overflows the keyboard strip').toBeGreaterThan(380);

    harness.fit(4, false, 1);

    // Fits the FULL height, not the strip: no font collapse, and the one
    // settle report says so.
    expect(harness.screenHeight()).toBeLessThanOrEqual(fullHeight);
    expect(harness.fontSizePx()).toBe(17);
    expect(harness.settleReports().map((report) => report.fontSizePx)).toEqual([17]);
    // And deliberately still taller than the keyboard-shrunken window - the
    // keyboard covers rows rather than reshaping the grid.
    expect(harness.screenHeight()).toBeGreaterThan(380);
  });

  /**
   * The pass budget must not be starved by FONT STEPS. How many steps the
   * opening guess needs varies run to run (cell metrics shift while fonts
   * load), and when several were needed they consumed every corrective pass:
   * the chain ran out before the row stretch (or even before the font
   * FITTED), settling at line height 1 with a short grid - live on a fresh
   * open of a parked 210x48 session: a 530px grid centred in a 635px
   * viewport ("mobile renders ~80% of the TUI"). Font steps are monotonic
   * and floored at MIN_AUTO_FONT_PX, so exempting them cannot spin.
   */
  it('still stretches when the opening font guess costs several steps', () => {
    const harness = buildHeightFit({ rows: 48, viewportHeight: 624, fontSizePx: 14, cellHeightRatio: 1.21 });
    expect(harness.screenHeight(), 'precondition: the guess is far too big').toBeGreaterThan(700);

    harness.fit(4, false, 1);

    // The fit must land INSIDE the pane and still fill it to within one row -
    // the same contract as the clipped-bottom-row guard, reached through five
    // font steps first. Budget starvation left it overflowing at 672px.
    expect(harness.screenHeight()).toBeLessThanOrEqual(624);
    expect(harness.screenHeight()).toBeGreaterThan(624 - harness.screenHeight() / 48);
    expect(harness.paddingTop()).toBe('0px');
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
    expect(harness.settleReports().map((report) => report.fontSizePx)).toEqual([12]);
  });

  /**
   * THE REFERENCE CELL, through the real fit chain: the maintainer's rule is
   * the same font size and the same position on every open of every task. A
   * 120x30 session (the desktop's spawn default, task #529's grid) used to
   * fill the height at ~17 px while a 210x48 one sat at ~11 px, and a short
   * grid was centred, moving its first row. Now a 30-row grid takes exactly
   * the decisions the 48-row resting grid takes and lands on the same font and
   * line height, its grid 30/48 of the reference height, pinned to the top.
   *
   * Mutation that reddens this: drop the reference scaling in
   * fitGridHeightToViewport (the 30-row grid then stretches to fill the pane).
   */
  it('settles a 30-row grid on the exact cell of the 48-row reference grid, pinned to the top', () => {
    const reference = buildHeightFit({ rows: 48, referenceRows: 48, viewportHeight: 635, fontSizePx: 11, cellHeightRatio: 1.21 });
    const shorter = buildHeightFit({ rows: 30, referenceRows: 48, viewportHeight: 635, fontSizePx: 11, cellHeightRatio: 1.21 });

    reference.fit(4, false, 1);
    shorter.fit(4, false, 1);

    expect(shorter.fontSizePx()).toBe(reference.fontSizePx());
    expect(shorter.lineHeight()).toBeCloseTo(reference.lineHeight(), 10);
    // Same per-row height, so the shorter grid is exactly 30/48 of the
    // reference grid's height - not stretched to fill the pane.
    expect(shorter.screenHeight() / 30).toBe(reference.screenHeight() / 48);
    expect(shorter.screenHeight()).toBeLessThan(635 * 0.7);
    expect(shorter.paddingTop()).toBe('0px');
  });

  /**
   * And the converged cell is recorded for reuse (settledFit), with the
   * MEASURED grid height on the report rather than the reference-scaled one.
   */
  it('records the converged cell and reports the measured grid height', () => {
    const shorter = buildHeightFit({ rows: 30, referenceRows: 48, viewportHeight: 635, fontSizePx: 11, cellHeightRatio: 1.21 });

    shorter.fit(4, false, 1);

    expect(shorter.settledFit()).toEqual({ key: 'fit-key', fontSizePx: shorter.fontSizePx(), lineHeight: shorter.lineHeight() });
    expect(shorter.settleReports()).toEqual([{ source: 'settled', fontSizePx: shorter.fontSizePx(), gridHeightPx: shorter.screenHeight() }]);
  });

  /**
   * The last pass hands an overshooting stretch back blind, and the settle
   * used to report the measurement taken BEFORE that giveback: on a release
   * build a 210x48 fit reported gridHeightPx=677 in a 670 pane while the grid
   * on screen fit. The report (and the recorded cell) must describe the grid
   * that is actually painted.
   *
   * Mutation that reddens this: settle on the pre-giveback measurement again.
   */
  it('settles on the corrected grid after a final-pass giveback, not the overflowing one', () => {
    // 48 x ceil(10 x 1.21 x 1.1) = 672 overflows a 635 pane; the giveback
    // takes the stretch to ~1.036 and the grid to 48 x 13 = 624.
    const harness = buildHeightFit({ rows: 48, viewportHeight: 635, fontSizePx: 10, cellHeightRatio: 1.21, lineHeight: 1.1 });
    expect(harness.screenHeight(), 'precondition: the stretch overflows').toBeGreaterThan(635);

    harness.fit(1, false, 1);

    expect(harness.screenHeight()).toBeLessThanOrEqual(635);
    expect(harness.settleReports()).toEqual([{ source: 'settled', fontSizePx: 10, gridHeightPx: harness.screenHeight() }]);
    expect(harness.settledFit()?.lineHeight).toBe(harness.lineHeight());
    expect(harness.followed()).toBe(1);
  });

  /**
   * The settle after a final-pass giveback waits one frame, and a refit can
   * start a new chain (a new generation) inside it. The deferred settle then
   * belongs to a dead chain: recording its measurement would overwrite the
   * live chain's cell and report a grid nobody is waiting on.
   *
   * Mutation that reddens this: drop the generation check from
   * settleAfterFinalGiveback.
   */
  it('ignores the deferred settle of a final giveback whose chain was superseded', () => {
    const harness = buildHeightFit({ rows: 48, viewportHeight: 635, fontSizePx: 10, cellHeightRatio: 1.21 });

    // The harness's live generation is 1. A settle scheduled by the chain
    // before it (generation 0) arrives after a refit started a new chain.
    harness.settleAfterFinalGiveback(0);

    expect(harness.settleReports()).toEqual([]);
    expect(harness.settledFit()).toBeNull();
    expect(harness.followed()).toBe(0);

    // Control: the live generation does settle on what it measures.
    harness.settleAfterFinalGiveback(1);

    expect(harness.settleReports()).toEqual([{ source: 'settled', fontSizePx: 10, gridHeightPx: harness.screenHeight() }]);
    expect(harness.settledFit()).not.toBeNull();
    expect(harness.followed()).toBe(1);
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
    expect(harness.settleReports()).toEqual([]);
  });

  /**
   * A pinch is the user taking the size. A fit still converging would keep
   * stepping the font under their finger, so zoom cancels it, and records the
   * pinch so every later refit (keyboard, rotation) keeps it until the fit
   * button, another session or another grid.
   */
  it('cancels an in-flight height fit when a pinch takes the size, and records the pinch', () => {
    // applyFontSize is the last function in lifecycle.js; slice from its head.
    const lifecycleSource = pageModule('lifecycle.js');
    const applyFontSizeBody = lifecycleSource.slice(lifecycleSource.indexOf('function applyFontSize('));
    expect(applyFontSizeBody).toContain('function applyFontSize(');
    expect(applyFontSizeBody).toContain('heightFitGeneration += 1');
    expect(applyFontSizeBody).toContain('pinchOverrideFontPx = capped');
  });

  /**
   * applyFontSize, sliced from lifecycle.js (the last function in the module)
   * and run against spies: the page's one entry point for a pinch. The case
   * above only reads its source text; these run it. `reportFit` is defined in
   * the prelude so it can read the page's own `currentFontSizePx` at the moment
   * it is called, which is what the host's pinch baseline is taken from.
   */
  function buildApplyFontSizeHarness(options: {
    hasTerminal?: boolean;
    knownRows: number | null;
    capFontPx: (fontPx: number) => number;
    /** The painted grid's height, or null when there is no .xterm-screen element. */
    screenHeightPx: number | null;
  }): {
    applyFontSize: (fontSizePx: number) => void;
    runFrames: () => void;
    state: () => { pinchOverrideFontPx: number | null; currentFontSizePx: number; heightFitGeneration: number };
    terminalFontSizePx: () => number;
    fitReports: () => { source: string; fontSizePx: number; gridHeightPx: number }[];
    geometryCalls: () => number;
    followCalls: () => unknown[];
    capRequests: () => { fontPx: number; cols: number; rows: number | null }[];
  } {
    const source = pageModule('lifecycle.js');
    const applyFontSizeSource = source.slice(source.indexOf('function applyFontSize('));
    expect(applyFontSizeSource).toContain('function applyFontSize(');
    assertInjectionsAreAlive('lifecycle.js (applyFontSize slice)', applyFontSizeSource, [
      'terminal',
      'textureCappedFontPx',
      'knownCols',
      'knownRows',
      'pinchOverrideFontPx',
      'currentFontSizePx',
      'reportFit',
      'applyGeometry',
      'heightFitGeneration',
      'requestAnimationFrame',
      'followCursorVertically',
    ]);
    const terminal = { rows: 40, options: { fontSize: 0 } };
    const capRequests: { fontPx: number; cols: number; rows: number | null }[] = [];
    const fitReports: { source: string; fontSizePx: number; gridHeightPx: number }[] = [];
    const frames: (() => void)[] = [];
    const followCalls: unknown[] = [];
    let geometryCalls = 0;
    const fakeDocument = {
      querySelector: (selector: string) =>
        selector === '.xterm-screen' && options.screenHeightPx !== null
          ? { getBoundingClientRect: () => ({ height: options.screenHeightPx }) }
          : null,
    };
    const build = new Function(
      'terminal',
      'textureCappedFontPx',
      'document',
      'onFitReport',
      'applyGeometry',
      'requestAnimationFrame',
      'followCursorVertically',
      'initialState',
      `var knownCols = 120;
       var knownRows = initialState.knownRows;
       var pinchOverrideFontPx = null;
       var currentFontSizePx = 11;
       var heightFitGeneration = 4;
       function reportFit(source, gridHeightPx) {
         onFitReport({ source: source, fontSizePx: currentFontSizePx, gridHeightPx: gridHeightPx });
       }
       ${applyFontSizeSource}
       return {
         applyFontSize: applyFontSize,
         state: function () {
           return { pinchOverrideFontPx: pinchOverrideFontPx, currentFontSizePx: currentFontSizePx,
                    heightFitGeneration: heightFitGeneration };
         },
       };`,
    ) as (...dependencies: unknown[]) => {
      applyFontSize: (fontSizePx: number) => void;
      state: () => { pinchOverrideFontPx: number | null; currentFontSizePx: number; heightFitGeneration: number };
    };
    const built = build(
      options.hasTerminal === false ? null : terminal,
      (fontPx: number, cols: number, rows: number | null) => {
        capRequests.push({ fontPx, cols, rows });
        return options.capFontPx(fontPx);
      },
      fakeDocument,
      (report: { source: string; fontSizePx: number; gridHeightPx: number }) => {
        fitReports.push(report);
      },
      () => {
        geometryCalls += 1;
      },
      (callback: () => void) => {
        frames.push(callback);
      },
      (force: unknown) => {
        followCalls.push(force);
      },
      { knownRows: options.knownRows },
    );
    return {
      applyFontSize: built.applyFontSize,
      runFrames: () => {
        for (const frame of frames.splice(0)) frame();
      },
      state: built.state,
      terminalFontSizePx: () => terminal.options.fontSize,
      fitReports: () => fitReports,
      geometryCalls: () => geometryCalls,
      followCalls: () => followCalls,
      capRequests: () => capRequests,
    };
  }

  describe('lifecycle.js applyFontSize', () => {
    /**
     * Mutations that redden this, each on its own: drop `pinchOverrideFontPx =
     * capped;` (the next refit would re-fit under the user's finger), or drop
     * `heightFitGeneration += 1;` (a fit still converging keeps stepping the
     * font after the pinch).
     */
    it('takes the size for the user: records the pinch, applies it, cancels an in-flight fit and follows the cursor', () => {
      const harness = buildApplyFontSizeHarness({ knownRows: 30, capFontPx: (fontPx) => fontPx, screenHeightPx: 700 });

      harness.applyFontSize(20);

      expect(harness.state()).toEqual({ pinchOverrideFontPx: 20, currentFontSizePx: 20, heightFitGeneration: 5 });
      expect(harness.terminalFontSizePx()).toBe(20);
      expect(harness.geometryCalls()).toBe(1);
      // The cap is asked about the grid the pinch is over.
      expect(harness.capRequests()).toEqual([{ fontPx: 20, cols: 120, rows: 30 }]);
      // Not capped, so the host's pinch baseline needs no correction.
      expect(harness.fitReports()).toEqual([]);
      // The follow is forced, and waits for the frame that paints the new cell.
      expect(harness.followCalls()).toEqual([]);
      harness.runFrames();
      expect(harness.followCalls()).toEqual([true]);
    });

    /**
     * The texture cap can refuse a pinch's size, and the host's baseline (the
     * next pinch starts from it) must follow the CAPPED size, not the one the
     * fingers asked for. The report carries the measured grid, and the capped
     * size is already in place when it is taken.
     *
     * Mutation that reddens this: neuter the `if (capped !== fontSizePx)` report
     * (or move it above the `currentFontSizePx = capped` assignment).
     */
    it('reports the capped size to the host when the texture limit clamps a pinch', () => {
      const harness = buildApplyFontSizeHarness({
        knownRows: 30,
        capFontPx: (fontPx) => Math.min(fontPx, 14),
        screenHeightPx: 396,
      });

      harness.applyFontSize(30);

      expect(harness.state()).toMatchObject({ pinchOverrideFontPx: 14, currentFontSizePx: 14 });
      expect(harness.terminalFontSizePx()).toBe(14);
      expect(harness.fitReports()).toEqual([{ source: 'texture-cap', fontSizePx: 14, gridHeightPx: 396 }]);
    });

    it('still reports a clamped pinch when the page has no painted grid to measure', () => {
      const harness = buildApplyFontSizeHarness({
        knownRows: null,
        capFontPx: (fontPx) => Math.min(fontPx, 14),
        screenHeightPx: null,
      });

      harness.applyFontSize(30);

      expect(harness.fitReports()).toEqual([{ source: 'texture-cap', fontSizePx: 14, gridHeightPx: 0 }]);
      // Unknown rows (the desktop has not reported its grid) ask the cap about the terminal's own.
      expect(harness.capRequests()).toEqual([{ fontPx: 30, cols: 120, rows: 40 }]);
    });

    it('does nothing before a terminal exists', () => {
      const harness = buildApplyFontSizeHarness({
        hasTerminal: false,
        knownRows: 30,
        capFontPx: (fontPx) => fontPx,
        screenHeightPx: 700,
      });

      harness.applyFontSize(20);
      harness.runFrames();

      expect(harness.state()).toEqual({ pinchOverrideFontPx: null, currentFontSizePx: 11, heightFitGeneration: 4 });
      expect(harness.geometryCalls()).toBe(0);
      expect(harness.followCalls()).toEqual([]);
    });
  });

  /**
   * The fit report crosses the WebView bridge as JSON, and the host decodes
   * every field past `fontSizePx` to a DEFAULT when it is missing (so an older
   * page still works). That tolerance makes a renamed or mistyped key on either
   * side invisible: the report still arrives, the field just decodes to null
   * and the release-build trace silently loses it. So this runs the page's real
   * reportFit with a distinct value in every field and requires the host's real
   * decoder to give every one back.
   *
   * Mutation that reddens this: rename one key in reportFit's payload (e.g.
   * `innerWidthPx` to `innerWidth`), or swap two of its values.
   */
  it('posts a fit report the host decodes with every diagnostic field intact', () => {
    const fullSource = pageModule('fontGeometry.js');
    const reportFitSource = fullSource.slice(fullSource.indexOf('function reportFit('), fullSource.indexOf('function applyGeometry('));
    expect(reportFitSource).toContain('function reportFit(');
    assertInjectionsAreAlive('fontGeometry.js (reportFit slice)', reportFitSource, [
      'postToHost',
      'currentFontSizePx',
      'activeFitTrigger',
      'knownCols',
      'knownRows',
      'terminal',
      'fitViewportHeight',
      'maxGlTextureSize',
    ]);
    const posted: unknown[] = [];
    const build = new Function(
      'window',
      'postToHost',
      `var currentFontSizePx = 11;
       var activeFitTrigger = 'fit-height';
       var knownCols = 120;
       var knownRows = 30;
       var terminal = { options: { lineHeight: 1.194 } };
       var maxGlTextureSize = 4096;
       function fitViewportHeight() { return 635.4; }
       ${reportFitSource}
       return { reportFit: reportFit };`,
    ) as (...dependencies: unknown[]) => { reportFit: (reportSource: string, gridHeightPx: number) => void };
    const built = build({ innerHeight: 640, innerWidth: 411, devicePixelRatio: 2.625 }, (message: unknown) => {
      posted.push(message);
    });

    built.reportFit('settled', 396.6);

    expect(posted).toHaveLength(1);
    expect(decodeTerminalMessage(JSON.stringify(posted[0]))).toEqual({
      type: 'font-size',
      fontSizePx: 11,
      source: 'settled',
      trigger: 'fit-height',
      cols: 120,
      rows: 30,
      lineHeight: 1.194,
      fitHeightPx: 635,
      innerHeightPx: 640,
      innerWidthPx: 411,
      gridHeightPx: 397,
      devicePixelRatio: 2.625,
      maxTextureSize: 4096,
    });
  });

  /**
   * The source literal is the same kind of string-typed seam as the trigger
   * (scanned above): the page names it at its reportFit call sites, the host
   * decodes it through a closed set, and a rename on either side degrades the
   * report to 'unknown' without anything else failing.
   *
   * Mutation that reddens this: rename one source literal in a page script
   * (e.g. 'texture-cap' to 'texture_cap' in lifecycle.js).
   */
  it('names only fit sources the host decodes (page reportFit literals against decodeTerminalMessage)', () => {
    const namedSources = new Set<string>();
    for (const fileName of readdirSync(pageModulesDir)) {
      for (const match of pageModule(fileName).matchAll(/\breportFit\(\s*'([^']+)'/g)) namedSources.add(match[1]);
    }
    for (const namedSource of namedSources) {
      const decoded = decodeTerminalMessage(JSON.stringify({ type: 'font-size', fontSizePx: 11, source: namedSource }));
      expect(decoded?.type === 'font-size' ? decoded.source : null, `source '${namedSource}'`).toBe(namedSource);
    }
    // So a broken pattern cannot pass by finding nothing: the settle and the cap.
    expect([...namedSources], "the scan should find the 'settled' and 'texture-cap' call sites (reworded? update this scan)").toEqual(
      expect.arrayContaining(['settled', 'texture-cap']),
    );
  });

  it('runs the height fit from the refit pass, not the geometry pass', () => {
    const refitBody = pageModule('refit.js');
    expect(refitBody).toContain('fitGridHeightToViewport(HEIGHT_FIT_PASSES');
    // Each refit owns a generation, or two live fits step the font together.
    expect(refitBody).toContain('heightFitGeneration += 1');
    // And a chain that is not reusing a converged cell starts from line
    // height 1: an inherited stretch from the PREVIOUS chain overflows against
    // the freshly-reset font, gets handed back as if it were this chain's own
    // overshoot, and LOCKS stretching - the fit then settles short ("~80% of
    // the TUI" on a fresh open, caught live by the fit trace).
    expect(refitBody).toContain('terminal.options.lineHeight = 1');
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
      handlerBody.indexOf("message.type === 'fit-height'"),
    );
    expect(refitBranch).toContain("refit('refit-msg');");
    expect(refitBranch).not.toContain('autoFitFontToScreen()');
    expect(refitBranch).not.toContain('applyGeometry()');
  });

  /**
   * The 'resize' branch used to run the exact font-and-geometry half the
   * 'refit' branch above was cured of. On the reconnect race (init raced
   * ahead with rows null) the seed's fit stretches lineHeight for a GUESSED
   * row count; when the real grid then arrives as 'resize', adopting the
   * cols/rows without the lineHeight reset and the measured height fit
   * rendered the real rows under the stale stretch, until the user pressed
   * the reset button.
   */
  it('answers a resize message with the whole refit, not the font-and-geometry half', () => {
    const handlerBody = pageModule('dispatch.js');
    const resizeBranch = handlerBody.slice(handlerBody.indexOf("message.type === 'resize'"));
    expect(resizeBranch).toContain("refit('resize-msg');");
    expect(resizeBranch).not.toContain('autoFitFontToScreen()');
    expect(resizeBranch).not.toContain('applyGeometry()');
  });

  /**
   * state.js's fitViewportHeight: the per-orientation maximum viewport height
   * the height fit and the font fit both anchor to, so the soft keyboard
   * (which only ever SHRINKS window.innerHeight) cannot drag the fit down
   * with it. Every other harness in this file injects a hand-written stand-in
   * for this function; these tests run the REAL one, extracted from state.js
   * the same way verticalFollowOffset is sliced from followPan.js above.
   */
  describe('state.js fitViewportHeight', () => {
    function buildFitViewportHeight(): {
      setViewport: (innerWidth: number, innerHeight: number) => void;
      setHostFitHeight: (fitHeightPx: number | null) => void;
      fit: () => number;
    } {
      const source = pageModule('state.js');
      const fitSource = source.slice(
        source.indexOf('var maxFitHeightByWidth = {};'),
        source.indexOf('var MIN_AUTO_FONT_PX'),
      );
      expect(fitSource).toContain('function fitViewportHeight(');
      expect(fitSource).toContain('var hostFitHeightPx = null;');
      assertInjectionsAreAlive('state.js (fitViewportHeight slice)', fitSource, ['window']);
      const windowStub = { innerWidth: 0, innerHeight: 0 };
      const build = new Function(
        'window',
        `${fitSource}
         return { fit: fitViewportHeight, setHost: function (value) { hostFitHeightPx = value; } };`,
      ) as (windowReference: typeof windowStub) => { fit: () => number; setHost: (value: number | null) => void };
      const built = build(windowStub);
      return {
        setViewport: (innerWidth: number, innerHeight: number) => {
          windowStub.innerWidth = innerWidth;
          windowStub.innerHeight = innerHeight;
        },
        setHostFitHeight: built.setHost,
        fit: built.fit,
      };
    }

    /**
     * The host's measured Terminal-lens height outranks the page's own tracker:
     * a fresh page's first innerHeight is provisional, and the tracker's
     * maximum learns the taller pane another lens's footer leaves. With no host
     * measurement yet, the tracker answers as before.
     *
     * Mutation that reddens this: drop the hostFitHeightPx branch.
     */
    it('answers with the host-measured fit height whenever there is one', () => {
      const harness = buildFitViewportHeight();
      // The Changes lens's taller pane, learned by the tracker.
      harness.setViewport(411, 690);
      expect(harness.fit()).toBe(690);

      harness.setHostFitHeight(635);
      expect(harness.fit()).toBe(635);

      harness.setHostFitHeight(null);
      expect(harness.fit()).toBe(690);
    });

    it('raises the tracked maximum as the height grows at a fixed width', () => {
      const harness = buildFitViewportHeight();

      harness.setViewport(400, 700);
      expect(harness.fit()).toBe(700);

      harness.setViewport(400, 900);
      expect(harness.fit()).toBe(900);
    });

    it('keeps the earlier maximum when height falls at the same width (soft keyboard opening)', () => {
      const harness = buildFitViewportHeight();
      harness.setViewport(400, 900);
      expect(harness.fit()).toBe(900);

      // The keyboard shrinks the window without changing its width.
      harness.setViewport(400, 380);

      expect(harness.fit()).toBe(900);
    });

    it('starts a fresh maximum on a width change (rotation), from the current height, not the old width', () => {
      const harness = buildFitViewportHeight();
      harness.setViewport(400, 900);
      expect(harness.fit()).toBe(900);

      // Rotate to landscape: a real width change, not a keyboard shrink.
      harness.setViewport(900, 400);

      // The new width has never been seen before, so its maximum starts from
      // THIS height (400) - not carried over from portrait's 900.
      expect(harness.fit()).toBe(400);
    });

    it("recovers the original width's own recorded maximum when rotating back", () => {
      const harness = buildFitViewportHeight();
      harness.setViewport(400, 900);
      harness.fit();
      harness.setViewport(900, 400);
      harness.fit();

      // Back to portrait, keyboard open (shorter than portrait's own max and
      // shorter than landscape's max): must recover portrait's 900, not
      // landscape's 400 and not the current shrunk 380.
      harness.setViewport(400, 380);

      expect(harness.fit()).toBe(900);
    });
  });

  /**
   * fontGeometry.js: the REFERENCE CELL's font, the fit key, and
   * autoFitFontToScreen, sliced together (everything above applyGeometry,
   * which is never called here and pulls in unrelated collaborators).
   */
  describe('fontGeometry.js reference cell', () => {
    function buildAutoFitFontToScreen(options: {
      knownRows: number | null;
      knownCols: number;
      innerHeightPx: number;
      fitHeightPx: number;
      initialFontSizePx: number;
      /** Stands in for heightFit.js's GPU texture cap; defaults to no cap. */
      textureCappedFontPx?: (fontPx: number, cols: number, rows: number | null) => number;
    }): {
      fit: () => void;
      fontSizePx: () => number;
      fitKey: () => string;
    } {
      const fullSource = pageModule('fontGeometry.js');
      const geometrySource = fullSource.slice(0, fullSource.indexOf('function applyGeometry('));
      expect(geometrySource).toContain('function autoFitFontToScreen(');
      assertInjectionsAreAlive('fontGeometry.js (reference cell slice)', geometrySource, [
        'knownRows',
        'knownCols',
        'CELL_HEIGHT_RATIO',
        'MIN_AUTO_FONT_PX',
        'MAX_AUTO_FIT_FONT_PX',
        'REFERENCE_GRID_ROWS',
        'REFERENCE_GRID_COLS',
        'textureCappedFontPx',
        'currentFontSizePx',
        'settledFit',
        'terminal',
        'fitViewportHeight',
      ]);
      const terminal = { options: { fontSize: options.initialFontSizePx } };
      const build = new Function(
        'terminal',
        'window',
        'knownRows',
        'knownCols',
        'CELL_HEIGHT_RATIO',
        'MIN_AUTO_FONT_PX',
        'MAX_AUTO_FIT_FONT_PX',
        'REFERENCE_GRID_ROWS',
        'REFERENCE_GRID_COLS',
        'textureCappedFontPx',
        'postToHost',
        'fitViewportHeight',
        'initialFontSizePx',
        `var currentFontSizePx = initialFontSizePx;
         var settledFit = null;
         var activeFitTrigger = 'init';
         var maxGlTextureSize = 4096;
         ${geometrySource}
         return { fit: autoFitFontToScreen, fontSizePx: function () { return currentFontSizePx; },
                  fitKey: currentFitKey };`,
      ) as (...dependencies: unknown[]) => { fit: () => void; fontSizePx: () => number; fitKey: () => string };
      const built = build(
        terminal,
        // Present so a regression back to window.innerHeight would resolve
        // against THIS (shrunk) value rather than throwing ReferenceError -
        // the whole point is that the correct function never reads it.
        { innerHeight: options.innerHeightPx, devicePixelRatio: 2.625 },
        options.knownRows,
        options.knownCols,
        pageVar('CELL_HEIGHT_RATIO'),
        pageVar('MIN_AUTO_FONT_PX'),
        pageVar('MAX_AUTO_FIT_FONT_PX'),
        pageVar('REFERENCE_GRID_ROWS'),
        pageVar('REFERENCE_GRID_COLS'),
        options.textureCappedFontPx ?? ((fontPx: number) => fontPx),
        () => undefined,
        () => options.fitHeightPx,
        options.initialFontSizePx,
      );
      return { fit: built.fit, fontSizePx: built.fontSizePx, fitKey: built.fitKey };
    }

    function fittedFont(knownRows: number | null, knownCols: number, fitHeightPx = 635): number {
      const harness = buildAutoFitFontToScreen({
        knownRows,
        knownCols,
        innerHeightPx: fitHeightPx,
        fitHeightPx,
        initialFontSizePx: 1,
      });
      harness.fit();
      return harness.fontSizePx();
    }

    /**
     * The maintainer's rule: the same font size on every open of every task.
     * Every grid of 48 rows or fewer gets the resting grid's font; only a
     * taller grid (which must still fit without clipping a row) goes smaller.
     * The 120x30 spawn-default grid used to fit at about 17 px.
     *
     * Mutation that reddens this: fit referenceRowsForFit to the grid's own
     * rows.
     */
    it('gives every grid of 48 rows or fewer the resting grid font, and a taller one less', () => {
      const restingGridFont = fittedFont(48, 210);

      expect(fittedFont(30, 120)).toBe(restingGridFont);
      expect(fittedFont(14, 306)).toBe(restingGridFont);
      expect(fittedFont(60, 210)).toBeLessThan(restingGridFont);
    });

    /**
     * Rows unknown (the desktop has not reported its grid) fit the reference
     * too. It used to return early, so the fit button could only stretch the
     * line height of a grid nobody had measured.
     */
    it('fits an unknown row count to the reference instead of returning early', () => {
      expect(fittedFont(null, 120)).toBe(fittedFont(48, 210));
      expect(fittedFont(null, 120)).not.toBe(1);
    });

    /**
     * The texture cap is taken for the reference grid's width AS WELL as this
     * grid's, so a narrower grid lands on the same cell a capped resting grid
     * gets (at a 4096 limit and dpr 3 the cap binds 210x48 by one step), while
     * a wider grid still caps lower on its own.
     */
    it('caps a narrow grid at the reference width, so it never lands a step bigger than the resting grid', () => {
      const capByColumns = (fontPx: number, cols: number): number => Math.min(fontPx, Math.floor(2100 / cols));
      const build = (knownRows: number, knownCols: number): number => {
        const harness = buildAutoFitFontToScreen({
          knownRows,
          knownCols,
          innerHeightPx: 635,
          fitHeightPx: 635,
          initialFontSizePx: 1,
          textureCappedFontPx: capByColumns,
        });
        harness.fit();
        return harness.fontSizePx();
      };

      expect(build(48, 210), 'precondition: the cap binds the resting grid').toBe(10);
      expect(build(30, 120)).toBe(10);
      expect(build(48, 306)).toBeLessThan(10);
    });

    it('shares one fit key across grids up to the reference size, and splits it on height, width and taller grids', () => {
      const keyFor = (knownRows: number | null, knownCols: number, fitHeightPx = 635): string =>
        buildAutoFitFontToScreen({ knownRows, knownCols, innerHeightPx: fitHeightPx, fitHeightPx, initialFontSizePx: 1 }).fitKey();

      expect(keyFor(30, 120)).toBe(keyFor(48, 210));
      expect(keyFor(null, 80)).toBe(keyFor(48, 210));
      expect(keyFor(48, 210, 700)).not.toBe(keyFor(48, 210));
      expect(keyFor(48, 306)).not.toBe(keyFor(48, 210));
      expect(keyFor(60, 210)).not.toBe(keyFor(48, 210));
    });

    /**
     * The live bug: an open soft keyboard shrinks window.innerHeight, and a
     * font sized from it collapses toward MIN_AUTO_FONT_PX at exactly the
     * moment the user is typing. The fix sizes from fitViewportHeight()
     * instead - the tracked per-orientation maximum - so the keyboard being
     * open must not change the computed font at all.
     */
    it('sizes the font from fitViewportHeight, not the keyboard-shrunk window.innerHeight', () => {
      // At the reference 48 rows and the real CELL_HEIGHT_RATIO these two
      // heights put both candidate fonts strictly inside [MIN_AUTO_FONT_PX,
      // MAX_AUTO_FIT_FONT_PX], so neither assertion below can pass merely
      // because both candidates hit the same clamp.
      const rows = 48;
      const fullHeight = 1000;
      const shrunkHeight = 600;

      // The real scenario: the fit tracker still reports the full-orientation
      // height while the live window is shrunk by the keyboard.
      const keyboardOpen = buildAutoFitFontToScreen({
        knownRows: rows,
        knownCols: 80,
        innerHeightPx: shrunkHeight,
        fitHeightPx: fullHeight,
        initialFontSizePx: 1,
      });
      keyboardOpen.fit();

      // Reference: keyboard closed, both heights agree at the full value.
      const keyboardClosedReference = buildAutoFitFontToScreen({
        knownRows: rows,
        knownCols: 80,
        innerHeightPx: fullHeight,
        fitHeightPx: fullHeight,
        initialFontSizePx: 1,
      });
      keyboardClosedReference.fit();

      // What a regression back to window.innerHeight would compute: both
      // heights pinned to the shrunk value.
      const ifItUsedInnerHeightInstead = buildAutoFitFontToScreen({
        knownRows: rows,
        knownCols: 80,
        innerHeightPx: shrunkHeight,
        fitHeightPx: shrunkHeight,
        initialFontSizePx: 1,
      });
      ifItUsedInnerHeightInstead.fit();

      // Preconditions: neither candidate font may be sitting on a clamp, or
      // the assertions below would pass merely because both hit the same
      // ceiling/floor rather than because either was actually derived from
      // its height.
      expect(
        keyboardClosedReference.fontSizePx(),
        'precondition: the full-height font must not be MAX_AUTO_FIT_FONT_PX-clamped',
      ).toBeLessThan(pageVar('MAX_AUTO_FIT_FONT_PX'));
      expect(
        ifItUsedInnerHeightInstead.fontSizePx(),
        'precondition: the shrunk-height font must not be MIN_AUTO_FONT_PX-floored',
      ).toBeGreaterThan(pageVar('MIN_AUTO_FONT_PX'));
      expect(
        keyboardClosedReference.fontSizePx(),
        'precondition: full and shrunk heights must fit different fonts',
      ).not.toBe(ifItUsedInnerHeightInstead.fontSizePx());

      expect(keyboardOpen.fontSizePx()).toBe(keyboardClosedReference.fontSizePx());
      expect(keyboardOpen.fontSizePx()).toBeGreaterThan(ifItUsedInnerHeightInstead.fontSizePx());
    });
  });

  /**
   * fontGeometry.js's settled-fit memo: the converged cell (settledFit) is read
   * back ONLY while the fit key it was recorded under is still the current
   * one. The existing refit/heightFit/lifecycle harnesses all STUB these
   * functions, so this slices fontGeometry.js itself (the same cut as the
   * reference-cell harness) with the key's inputs and the memo left mutable.
   * The fit height is a stand-in for state.js's fitViewportHeight, which
   * answers with hostFitHeightPx once the host has measured one.
   */
  function buildSettledFitMemoHarness(initial: { knownRows: number | null; knownCols: number; fitHeightPx: number }): {
    currentFitKey: () => string;
    referenceFontPx: () => number;
    settledFitForCurrentGrid: () => { key: string; fontSizePx: number; lineHeight: number } | null;
    fittedFontPxForGrid: () => number;
    fittedLineHeightForGrid: () => number;
    setSettledFit: (settledFit: { key: string; fontSizePx: number; lineHeight: number } | null) => void;
    setFitHeight: (fitHeightPx: number) => void;
    setKnownRows: (knownRows: number | null) => void;
    setKnownCols: (knownCols: number) => void;
    setDevicePixelRatio: (devicePixelRatio: number) => void;
  } {
    const fullSource = pageModule('fontGeometry.js');
    const geometrySource = fullSource.slice(0, fullSource.indexOf('function applyGeometry('));
    expect(geometrySource).toContain('function settledFitForCurrentGrid(');
    assertInjectionsAreAlive('fontGeometry.js (settled fit memo slice)', geometrySource, [
      'knownRows',
      'knownCols',
      'CELL_HEIGHT_RATIO',
      'MIN_AUTO_FONT_PX',
      'MAX_AUTO_FIT_FONT_PX',
      'REFERENCE_GRID_ROWS',
      'REFERENCE_GRID_COLS',
      'textureCappedFontPx',
      'fitViewportHeight',
      'settledFit',
    ]);
    const windowStub = { devicePixelRatio: 2.625 };
    const build = new Function(
      'window',
      'CELL_HEIGHT_RATIO',
      'MIN_AUTO_FONT_PX',
      'MAX_AUTO_FIT_FONT_PX',
      'REFERENCE_GRID_ROWS',
      'REFERENCE_GRID_COLS',
      'textureCappedFontPx',
      'initialState',
      `var knownRows = initialState.knownRows;
       var knownCols = initialState.knownCols;
       var fitHeightPx = initialState.fitHeightPx;
       var settledFit = null;
       function fitViewportHeight() { return fitHeightPx; }
       ${geometrySource}
       return {
         currentFitKey: currentFitKey,
         referenceFontPx: referenceFontPx,
         settledFitForCurrentGrid: settledFitForCurrentGrid,
         fittedFontPxForGrid: fittedFontPxForGrid,
         fittedLineHeightForGrid: fittedLineHeightForGrid,
         setSettledFit: function (next) { settledFit = next; },
         setFitHeight: function (next) { fitHeightPx = next; },
         setKnownRows: function (next) { knownRows = next; },
         setKnownCols: function (next) { knownCols = next; },
       };`,
    ) as (...dependencies: unknown[]) => ReturnType<typeof buildSettledFitMemoHarness>;
    const built = build(
      windowStub,
      pageVar('CELL_HEIGHT_RATIO'),
      pageVar('MIN_AUTO_FONT_PX'),
      pageVar('MAX_AUTO_FIT_FONT_PX'),
      pageVar('REFERENCE_GRID_ROWS'),
      pageVar('REFERENCE_GRID_COLS'),
      (fontPx: number) => fontPx,
      initial,
    );
    return {
      ...built,
      setDevicePixelRatio: (devicePixelRatio: number) => {
        windowStub.devicePixelRatio = devicePixelRatio;
      },
    };
  }

  describe('fontGeometry.js settled fit memo', () => {
    const memoFontPx = 17;
    const memoLineHeight = 1.194;

    /** The resting grid in a 635 px pane, with a cell recorded under that grid's own key. */
    function memoizedHarness(): { harness: ReturnType<typeof buildSettledFitMemoHarness>; memoKey: string } {
      const harness = buildSettledFitMemoHarness({ knownRows: 48, knownCols: 210, fitHeightPx: 635 });
      const memoKey = harness.currentFitKey();
      harness.setSettledFit({ key: memoKey, fontSizePx: memoFontPx, lineHeight: memoLineHeight });
      return { harness, memoKey };
    }

    /**
     * The positive control for the cases below: while the key matches, the
     * memo comes back (font, line height, and the record itself), and a grid
     * that shares the key (a shorter one, per the reference rows) keeps it.
     */
    it('hands the converged cell back while the fit key still matches', () => {
      const { harness } = memoizedHarness();
      expect(harness.referenceFontPx(), 'precondition: the memo is not simply the reference font').not.toBe(memoFontPx);

      expect(harness.fittedFontPxForGrid()).toBe(memoFontPx);
      expect(harness.fittedLineHeightForGrid()).toBe(memoLineHeight);
      expect(harness.settledFitForCurrentGrid()).toMatchObject({ fontSizePx: memoFontPx, lineHeight: memoLineHeight });

      harness.setKnownRows(30);
      expect(harness.fittedFontPxForGrid(), 'a shorter grid shares the key').toBe(memoFontPx);

      // And a key that moved away and came back finds it again.
      harness.setFitHeight(700);
      harness.setFitHeight(635);
      expect(harness.fittedFontPxForGrid()).toBe(memoFontPx);
    });

    /**
     * Mutation that reddens these: make settledFitForCurrentGrid return
     * settledFit whenever it is non-null (the font would stay at the stale
     * memo, and the line height at its stretch, for a pane or grid the memo
     * was never converged for).
     */
    it.each([
      ['the fit height changes (a rotation, a new measured Terminal lens)', (harness: ReturnType<typeof buildSettledFitMemoHarness>) => harness.setFitHeight(700)],
      ['the grid is taller than the reference rows', (harness: ReturnType<typeof buildSettledFitMemoHarness>) => harness.setKnownRows(60)],
      ['the grid is wider than the reference columns', (harness: ReturnType<typeof buildSettledFitMemoHarness>) => harness.setKnownCols(306)],
      ['the device pixel ratio changes', (harness: ReturnType<typeof buildSettledFitMemoHarness>) => harness.setDevicePixelRatio(3)],
    ])(
      'falls back to the reference font and a clean line height once %s',
      (_description, changeAKeyInput) => {
        const { harness, memoKey } = memoizedHarness();

        changeAKeyInput(harness);

        expect(harness.currentFitKey(), 'precondition: the key really moved').not.toBe(memoKey);
        expect(harness.referenceFontPx(), 'precondition: the fallback differs from the stale memo').not.toBe(memoFontPx);
        expect(harness.fittedFontPxForGrid()).toBe(harness.referenceFontPx());
        expect(harness.fittedLineHeightForGrid()).toBe(1);
        expect(harness.settledFitForCurrentGrid()).toBeNull();
      },
    );
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

    // The order is duplicated here ON PURPOSE, not derived from the builder:
    // concatenation order is load-time behavior (state before the statements
    // that run at load, bootstrap's listeners last), and everything else in
    // this test re-derives its expectations from the builder itself - so a
    // manifest reorder that regenerates cleanly would stay green while
    // changing what runs before what. Update both lists together,
    // deliberately.
    expect(manifest).toEqual([
      'state.js',
      'domHelpers.js',
      'fontGeometry.js',
      'followPan.js',
      'modes.js',
      'historyScroll.js',
      'webglRenderer.js',
      'cleanFeed.js',
      'lifecycle.js',
      'heightFit.js',
      'panClamp.js',
      'refit.js',
      'dispatch.js',
      'probe.js',
      'bootstrap.js',
    ]);

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
    // State the module reads and writes but declares elsewhere (state.js),
    // re-declared with harness-chosen initial values - the
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

  /**
   * The paint report: modes.js from visibleGridIsBlank to the end of the file
   * (the two report functions plus afterWriteFlushed, which drives them), run
   * against a fake buffer whose viewport rows the test fills. Frames run
   * inline. reportModesIfFlipped and the follow/jump collaborators are stubs:
   * they are afterWriteFlushed's other jobs, not what is under test.
   */
  interface PaintReport {
    type: string;
    seq: number | null;
    blank: boolean;
  }

  function buildPaintReportHarness(): {
    /** What lifecycle.js does on init: arm the report, then flush the seed with afterInit = true. */
    init: (seq: number, rows: string[]) => void;
    /** What dispatch.js does on a write: flush with no afterInit argument. */
    write: (rows: string[]) => void;
    posts: () => PaintReport[];
    counts: () => { blank: number; painted: number };
    /** How many times the frame hold (lifecycle.js) was told to lift. */
    frameHoldClears: () => number;
  } {
    const source = pageModule('modes.js');
    const paintSource = source.slice(source.indexOf('function visibleGridIsBlank('));
    expect(paintSource).toContain('function reportPaintedIfAwaiting(');
    expect(paintSource).toContain('function afterWriteFlushed(');
    assertInjectionsAreAlive('modes.js (paint report slice)', paintSource, [
      'terminal',
      'activeInitSeq',
      'awaitingNonBlankPaint',
      'paintReportCounts',
      'postToHost',
      'requestAnimationFrame',
      'reportModesIfFlipped',
      'panToCursor',
      'followCursorVertically',
      'pendingJumpRepaint',
      'jumpRepaintCount',
      'clearFrameHold',
    ]);
    const viewport = { rows: [] as string[] };
    const terminal = {
      rows: 3,
      buffer: {
        active: {
          viewportY: 0,
          getLine: (index: number) => ({ translateToString: () => viewport.rows[index] ?? '' }),
        },
      },
    };
    const posts: PaintReport[] = [];
    let frameHoldClears = 0;
    const build = new Function(
      'terminal',
      'postToHost',
      'requestAnimationFrame',
      'reportModesIfFlipped',
      'panToCursor',
      'followCursorVertically',
      'clearFrameHold',
      `var activeInitSeq = null;
       var awaitingNonBlankPaint = false;
       var paintReportCounts = { blank: 0, painted: 0 };
       var pendingJumpRepaint = false;
       var jumpRepaintCount = 0;
       ${paintSource}
       return {
         arm: function (seq) { activeInitSeq = seq; awaitingNonBlankPaint = true; },
         flush: afterWriteFlushed,
         counts: function () { return paintReportCounts; },
       };`,
    ) as (...dependencies: unknown[]) => {
      arm: (seq: number) => void;
      flush: (afterInit?: boolean) => void;
      counts: () => { blank: number; painted: number };
    };
    const built = build(
      terminal,
      (message: PaintReport) => posts.push(message),
      (callback: () => void) => callback(),
      () => undefined,
      () => undefined,
      () => undefined,
      () => {
        frameHoldClears += 1;
      },
    );
    return {
      init: (seq, rows) => {
        viewport.rows = rows;
        built.arm(seq);
        built.flush(true);
      },
      write: (rows) => {
        viewport.rows = rows;
        built.flush();
      },
      posts: () => posts,
      counts: built.counts,
      frameHoldClears: () => frameHoldClears,
    };
  }

  describe('modes.js paint report', () => {
    it('reports blank once after an init that draws nothing, again on the first write with glyphs, then stays quiet', () => {
      const harness = buildPaintReportHarness();

      harness.init(7, ['', '', '']);
      expect(harness.posts()).toEqual([{ type: 'painted', seq: 7, blank: true }]);

      // A write that leaves the grid blank (a clear, a cursor move) says nothing new.
      harness.write(['   ', '', '']);
      expect(harness.posts()).toHaveLength(1);

      harness.write(['', '$ claude', '']);
      expect(harness.posts()).toEqual([
        { type: 'painted', seq: 7, blank: true },
        { type: 'painted', seq: 7, blank: false },
      ]);

      // Quiet until the next init: later writes, even one that clears the
      // grid and one that redraws it, report nothing.
      harness.write(['', '', '']);
      harness.write(['more', '', '']);
      expect(harness.posts()).toHaveLength(2);
      expect(harness.counts()).toEqual({ blank: 1, painted: 1 });
    });

    it('reports non-blank straight from an init whose seed draws glyphs, and nothing after', () => {
      const harness = buildPaintReportHarness();

      harness.init(3, ['$ ls', '', '']);
      expect(harness.posts()).toEqual([{ type: 'painted', seq: 3, blank: false }]);

      harness.write(['$ ls', 'a.txt', '']);
      expect(harness.posts()).toHaveLength(1);
    });

    it("re-arms on every init, echoing that init's own seq", () => {
      const harness = buildPaintReportHarness();

      harness.init(1, ['x', '', '']);
      harness.init(2, ['', '', '']);
      harness.write(['y', '', '']);

      expect(harness.posts().map((report) => report.seq)).toEqual([1, 2, 2]);
    });

    /**
     * The frame hold (lifecycle.js) is the old frame's text kept over the
     * grid while the successor re-seeds. It lifts on the same frame the
     * successor is drawn, which is exactly the non-blank report, and never
     * on a blank one - a blank report is the hold's whole reason to exist.
     */
    it('lifts the frame hold on the first non-blank paint, never on a blank one', () => {
      const harness = buildPaintReportHarness();

      harness.init(4, ['', '', '']);
      expect(harness.frameHoldClears()).toBe(0);
      harness.write(['', '', '']);
      expect(harness.frameHoldClears()).toBe(0);

      harness.write(['$ claude', '', '']);
      expect(harness.frameHoldClears()).toBe(1);
    });

    /**
     * The arming half lives in lifecycle.js, outside the slice above: every
     * init records the host's seq and re-arms the report, the seed's own flush
     * says it is the init's, and an EMPTY seed reports on its own (there is no
     * write flush to ride). A plain write's flush passes nothing, so it can
     * never masquerade as an init's. Pinned by containment, the way this file
     * pins the other lifecycle shapes.
     */
    it('is armed by every init and reported by the seed flush, empty seed included', () => {
      const lifecycleSource = pageModule('lifecycle.js');
      const resetBody = lifecycleSource.slice(
        lifecycleSource.indexOf('function resetSessionViewState('),
        lifecycleSource.indexOf('function seedAndSettle('),
      );
      expect(resetBody).toContain('awaitingNonBlankPaint = true');
      expect(resetBody).toContain('activeInitSeq = ');
      const seedBody = lifecycleSource.slice(
        lifecycleSource.indexOf('function seedAndSettle('),
        lifecycleSource.indexOf('function createTerminal('),
      );
      expect(seedBody).toContain('afterWriteFlushed(true)');
      expect(seedBody).toContain('reportPaintedIfAwaiting(true)');
      expect(pageModule('dispatch.js')).toContain('terminal.write(message.data, afterWriteFlushed)');
    });
  });

  /**
   * refit.js is one function; run it whole against spies for the font fit, the
   * geometry pass and the measured height fit, with frames inline. Three
   * cases, whoever calls it: a pinch in force keeps the user's size; a grid
   * that already converged applies its cell directly (re-running the chain
   * from line height 1 is what made every re-init snap short and re-stretch);
   * anything else fits the reference font from a clean line height of 1.
   */
  function buildRefitHarness(options: {
    initialLineHeight: number;
    settledFit?: { fontSizePx: number; lineHeight: number } | null;
    pinchOverrideFontPx?: number | null;
  }): {
    refit: (trigger?: unknown) => void;
    onViewportChange: (trigger: string) => void;
    autoFitCalls: () => number;
    lineHeight: () => number;
    fontSize: () => number;
    trigger: () => string;
    heightFitCalls: () => { passes: number; stretchLocked: boolean; generation: number }[];
    /** Calls made to the forced vertical follow and the pan clamp, in order. */
    reorientCalls: () => string[];
    pinnedToStart: () => boolean;
  } {
    const source = pageModule('refit.js');
    assertInjectionsAreAlive('refit.js', source, [
      'terminal',
      'pinnedToStart',
      'pinchOverrideFontPx',
      'settledFitForCurrentGrid',
      'currentFontSizePx',
      'activeFitTrigger',
      'autoFitFontToScreen',
      'applyGeometry',
      'heightFitGeneration',
      'HEIGHT_FIT_PASSES',
      'requestAnimationFrame',
      'fitGridHeightToViewport',
      'manualPanUntil',
      'clampHorizontalPan',
      'followCursorVertically',
    ]);
    const terminal = { options: { lineHeight: options.initialLineHeight, fontSize: 9 } };
    let autoFitCalls = 0;
    const heightFitCalls: { passes: number; stretchLocked: boolean; generation: number }[] = [];
    const reorientCalls: string[] = [];
    const build = new Function(
      'terminal',
      'autoFitFontToScreen',
      'applyGeometry',
      'fitGridHeightToViewport',
      'clampHorizontalPan',
      'followCursorVertically',
      'requestAnimationFrame',
      'settledFitForCurrentGrid',
      'initialPinchOverrideFontPx',
      `var pinnedToStart = false;
       var heightFitGeneration = 0;
       var HEIGHT_FIT_PASSES = 4;
       var manualPanUntil = 0;
       var currentFontSizePx = 9;
       var activeFitTrigger = 'none';
       var pinchOverrideFontPx = initialPinchOverrideFontPx;
       ${source}
       return { refit: refit, onViewportChange: onViewportChange,
                trigger: function () { return activeFitTrigger; },
                pinnedToStart: function () { return pinnedToStart; } };`,
    ) as (...dependencies: unknown[]) => {
      refit: (trigger?: unknown) => void;
      onViewportChange: (trigger: string) => void;
      trigger: () => string;
      pinnedToStart: () => boolean;
    };
    const built = build(
      terminal,
      () => {
        autoFitCalls += 1;
      },
      () => undefined,
      (passes: number, stretchLocked: boolean, generation: number) => {
        heightFitCalls.push({ passes, stretchLocked, generation });
      },
      () => {
        reorientCalls.push('clamp');
      },
      (force: boolean) => {
        reorientCalls.push(force ? 'follow-forced' : 'follow');
      },
      (callback: () => void) => callback(),
      () => options.settledFit ?? null,
      options.pinchOverrideFontPx ?? null,
    );
    return {
      refit: built.refit,
      onViewportChange: built.onViewportChange,
      autoFitCalls: () => autoFitCalls,
      lineHeight: () => terminal.options.lineHeight,
      fontSize: () => terminal.options.fontSize,
      trigger: built.trigger,
      heightFitCalls: () => heightFitCalls,
      reorientCalls: () => reorientCalls,
      pinnedToStart: built.pinnedToStart,
    };
  }

  describe('refit.js', () => {
    it('fits the reference font from a clean line height when nothing has converged', () => {
      const harness = buildRefitHarness({ initialLineHeight: 1.19 });

      harness.refit('init');

      expect(harness.autoFitCalls()).toBe(1);
      expect(harness.lineHeight()).toBe(1);
      expect(harness.heightFitCalls()).toEqual([{ passes: 4, stretchLocked: false, generation: 1 }]);
    });

    /**
     * The flicker fix: a grid this pane already converged on gets that cell
     * back directly. The chain still runs (it measures once and settles), but
     * the stretch is never reset to 1 first, and the chain runs
     * STRETCH-LOCKED: a cell that settled through a giveback is not a fixed
     * point of the stretch step, so an unlocked chain re-stretched it and
     * handed it back on every reactivate (1.055 then 1.054 on a release
     * build, a one-frame grow and shrink each time).
     *
     * Mutations that redden this: drop the settledFit branch; run the
     * settled chain unlocked.
     */
    it('applies the converged cell directly and locks the stretch, when this grid already converged', () => {
      const harness = buildRefitHarness({ initialLineHeight: 1, settledFit: { fontSizePx: 11, lineHeight: 1.194 } });

      harness.refit('ro-settle');

      expect(harness.autoFitCalls()).toBe(0);
      expect(harness.fontSize()).toBe(11);
      expect(harness.lineHeight()).toBe(1.194);
      expect(harness.heightFitCalls()).toEqual([{ passes: 4, stretchLocked: true, generation: 1 }]);
    });

    /**
     * A pinch is the user's size until the fit button, another session or
     * another grid: a keyboard or a rotation refit must not take it away.
     */
    it('keeps a pinch in force: no font fit, no height fit, the stretch untouched', () => {
      const harness = buildRefitHarness({ initialLineHeight: 1.1, pinchOverrideFontPx: 20 });

      harness.refit('window-resize');

      expect(harness.autoFitCalls()).toBe(0);
      expect(harness.lineHeight()).toBe(1.1);
      expect(harness.heightFitCalls()).toEqual([]);
    });

    /**
     * THE KEYBOARD FLASH. One keyboard open fires three viewport triggers
     * (the window 'resize' listener, the ResizeObserver's frame and its
     * trailing settle), and each used to run a whole fit chain - measured on
     * a release build as three chains settling on the identical cell, and in
     * the shipped build each one reset the line height to 1 first, collapsing
     * and re-stretching the grid. The keyboard cannot move the fit, so a
     * converged grid only re-orients: column 0, the cursor kept in view.
     *
     * Mutation that reddens this: route onViewportChange straight to refit.
     */
    it('only re-orients on a viewport change that leaves the fit where it was', () => {
      const harness = buildRefitHarness({ initialLineHeight: 1.055, settledFit: { fontSizePx: 11, lineHeight: 1.055 } });

      harness.onViewportChange('window-resize');
      harness.onViewportChange('ro-raf');
      harness.onViewportChange('ro-settle');

      expect(harness.heightFitCalls()).toEqual([]);
      expect(harness.autoFitCalls()).toBe(0);
      expect(harness.lineHeight()).toBe(1.055);
      expect(harness.pinnedToStart()).toBe(true);
      expect(harness.reorientCalls()).toEqual([
        'clamp',
        'follow-forced',
        'clamp',
        'follow-forced',
        'clamp',
        'follow-forced',
      ]);
    });

    it('runs the fit chain for a viewport change that moved the fit inputs', () => {
      const harness = buildRefitHarness({ initialLineHeight: 1.055, settledFit: null });

      harness.onViewportChange('ro-settle');

      expect(harness.trigger()).toBe('ro-settle');
      expect(harness.heightFitCalls()).toHaveLength(1);
    });

    it('keeps a pinch through a viewport change, only re-orienting', () => {
      const harness = buildRefitHarness({ initialLineHeight: 1.1, pinchOverrideFontPx: 20 });

      harness.onViewportChange('window-resize');

      expect(harness.heightFitCalls()).toEqual([]);
      expect(harness.lineHeight()).toBe(1.1);
      expect(harness.reorientCalls()).toEqual(['clamp', 'follow-forced']);
    });

    it('routes the window resize listener and the ResizeObserver through the viewport handler', () => {
      expect(pageModule('dispatch.js')).toContain("onViewportChange('window-resize')");
      expect(pageModule('dispatch.js')).not.toContain("addEventListener('resize', refit)");
      expect(pageModule('bootstrap.js')).toContain("onViewportChange('ro-raf')");
      expect(pageModule('bootstrap.js')).toContain("onViewportChange('ro-settle')");
    });

    it("reads the window resize listener's Event argument as the window-resize trigger", () => {
      const harness = buildRefitHarness({ initialLineHeight: 1.19 });

      harness.refit({ type: 'resize' });

      expect(harness.trigger()).toBe('window-resize');
      expect(harness.autoFitCalls()).toBe(1);
    });
  });

  /**
   * resetSessionViewState, sliced from lifecycle.js: the half of every init
   * that adopts the grid and decides the font. The pinch rule lives here: a
   * pinch survives only a re-init the host marks preservePinch (the same
   * session) at the same grid; anything else starts from the reference cell.
   */
  function buildResetSessionViewStateHarness(options: {
    knownCols: number;
    knownRows: number | null;
    pinchOverrideFontPx: number | null;
  }): {
    reset: (initMessage: Record<string, unknown>) => void;
    state: () => { pinchOverrideFontPx: number | null; currentFontSizePx: number; hostFitHeightPx: number | null };
  } {
    const source = pageModule('lifecycle.js');
    const resetSource = source.slice(source.indexOf('function resetSessionViewState('), source.indexOf('function seedAndSettle('));
    expect(resetSource).toContain('function resetSessionViewState(');
    assertInjectionsAreAlive('lifecycle.js (resetSessionViewState slice)', resetSource, [
      'knownCols',
      'knownRows',
      'hostFitHeightPx',
      'pinchOverrideFontPx',
      'textureCappedFontPx',
      'fittedFontPxForGrid',
      'currentFontSizePx',
      'setupCleanFeed',
    ]);
    const build = new Function(
      'textureCappedFontPx',
      'fittedFontPxForGrid',
      'stopHistoryFling',
      'applyVerticalOffset',
      'setupCleanFeed',
      'fallbackRowCount',
      'document',
      'initialState',
      `var knownCols = initialState.knownCols;
       var knownRows = initialState.knownRows;
       var hostFitHeightPx = null;
       var pinchOverrideFontPx = initialState.pinchOverrideFontPx;
       var currentFontSizePx = 0;
       var lastAppCursorMode = false;
       var lastReportedModes = null;
       var activeInitSeq = null;
       var awaitingNonBlankPaint = false;
       var lastInitHoldFrame = false;
       var manualPanUntil = 0;
       var dragSamples = [];
       var netHistoryUnits = 0;
       var pinnedToStart = false;
       ${resetSource}
       return {
         reset: resetSessionViewState,
         state: function () {
           return { pinchOverrideFontPx: pinchOverrideFontPx, currentFontSizePx: currentFontSizePx,
                    hostFitHeightPx: hostFitHeightPx };
         },
       };`,
    ) as (...dependencies: unknown[]) => {
      reset: (initMessage: Record<string, unknown>) => void;
      state: () => { pinchOverrideFontPx: number | null; currentFontSizePx: number; hostFitHeightPx: number | null };
    };
    const fakeElement = { style: {} as Record<string, string> };
    return build(
      (fontPx: number) => fontPx,
      // The reference cell, whatever the grid.
      () => 11,
      () => undefined,
      () => undefined,
      () => undefined,
      () => 48,
      { documentElement: fakeElement, body: fakeElement, getElementById: () => fakeElement },
      options,
    );
  }

  describe('lifecycle.js resetSessionViewState', () => {
    const pinchedAtRestingGrid = { knownCols: 210, knownRows: 48, pinchOverrideFontPx: 20 };

    /**
     * Mutation that reddens these: drop the grid comparison, or the
     * preservePinch check, from the clear condition.
     */
    it('keeps a pinch across a preservePinch re-init at the same grid', () => {
      const harness = buildResetSessionViewStateHarness(pinchedAtRestingGrid);

      harness.reset({ cols: 210, rows: 48, preservePinch: true });

      expect(harness.state()).toMatchObject({ pinchOverrideFontPx: 20, currentFontSizePx: 20 });
    });

    it('drops the pinch for a different grid, even when the host asked to preserve it', () => {
      const harness = buildResetSessionViewStateHarness(pinchedAtRestingGrid);

      harness.reset({ cols: 120, rows: 30, preservePinch: true });

      expect(harness.state()).toMatchObject({ pinchOverrideFontPx: null, currentFontSizePx: 11 });
    });

    it('drops the pinch for a re-init the host did not mark (another session)', () => {
      const harness = buildResetSessionViewStateHarness(pinchedAtRestingGrid);

      harness.reset({ cols: 210, rows: 48, preservePinch: false });

      expect(harness.state()).toMatchObject({ pinchOverrideFontPx: null, currentFontSizePx: 11 });
    });

    it('adopts the host fit height an init carries, and keeps the last one when it carries none', () => {
      const harness = buildResetSessionViewStateHarness({ knownCols: 210, knownRows: 48, pinchOverrideFontPx: null });

      harness.reset({ cols: 210, rows: 48, fitHeightPx: 635 });
      expect(harness.state().hostFitHeightPx).toBe(635);

      harness.reset({ cols: 210, rows: 48, fitHeightPx: null });
      expect(harness.state().hostFitHeightPx).toBe(635);
    });
  });

  /**
   * softReinit, sliced from lifecycle.js and run against spies: the in-place
   * re-init lays the new grid out in the cell resetSessionViewState chose (the
   * reference cell, or the one this grid already converged on) with the line
   * height that goes with it, keeps a pinch's stretch, and holds the frame
   * across the reset when the host asks.
   */
  function buildSoftReinitHarness(options: {
    initialLineHeight: number;
    fittedLineHeight: number;
    pinchOverrideFontPx?: number | null;
  }): {
    softReinit: (initMessage: Record<string, unknown>) => void;
    options: () => { lineHeight: number; fontSize: number; theme: unknown };
    seedCalls: () => unknown[];
    /** The order of the calls that matter for the frame hold: 'hold', 'clear' and 'reset'. */
    holdLog: () => string[];
  } {
    const source = pageModule('lifecycle.js');
    const softReinitSource = source.slice(source.indexOf('function softReinit('), source.indexOf('function applyFontSize('));
    expect(softReinitSource).toContain('function softReinit(');
    assertInjectionsAreAlive('lifecycle.js (softReinit slice)', softReinitSource, [
      'initCounts',
      'resetSessionViewState',
      'terminal',
      'currentFontSizePx',
      'pinchOverrideFontPx',
      'fittedLineHeightForGrid',
      'applyGeometry',
      'seedAndSettle',
      'holdFrameSnapshot',
      'clearFrameHold',
    ]);
    const holdLog: string[] = [];
    const terminal = {
      options: { lineHeight: options.initialLineHeight, fontSize: 0, theme: null as unknown },
      reset: () => {
        holdLog.push('reset');
      },
    };
    const seedCalls: unknown[] = [];
    const build = new Function(
      'terminal',
      'resetSessionViewState',
      'fittedLineHeightForGrid',
      'applyGeometry',
      'seedAndSettle',
      'holdFrameSnapshot',
      'clearFrameHold',
      'initialPinchOverrideFontPx',
      `var initCounts = { hard: 0, soft: 0 };
       var currentFontSizePx = 9;
       var pinchOverrideFontPx = initialPinchOverrideFontPx;
       ${softReinitSource}
       return { softReinit: softReinit };`,
    ) as (...dependencies: unknown[]) => { softReinit: (initMessage: Record<string, unknown>) => void };
    const built = build(
      terminal,
      () => undefined,
      () => options.fittedLineHeight,
      () => undefined,
      (initMessage: unknown) => {
        seedCalls.push(initMessage);
      },
      () => {
        holdLog.push('hold');
      },
      () => {
        holdLog.push('clear');
      },
      options.pinchOverrideFontPx ?? null,
    );
    return {
      softReinit: built.softReinit,
      options: () => terminal.options,
      seedCalls: () => seedCalls,
      holdLog: () => holdLog,
    };
  }

  describe('lifecycle.js softReinit', () => {
    /**
     * Every re-init comes up in the reference cell - the swap's successor, a
     * lens switch back, a re-seed - with the converged stretch when this grid
     * already has one, so nothing visibly snaps short and re-stretches.
     */
    it('lays the re-init out in the chosen font and the line height fitted for this grid', () => {
      const harness = buildSoftReinitHarness({ initialLineHeight: 1, fittedLineHeight: 1.194 });

      harness.softReinit({ holdFrame: true, theme: { background: '#000' }, scrollback: 'x' });

      expect(harness.options().fontSize).toBe(9);
      expect(harness.options().lineHeight).toBe(1.194);
      expect(harness.seedCalls()).toHaveLength(1);
    });

    it("keeps a pinch's stretch on a re-init that kept the pinch", () => {
      const harness = buildSoftReinitHarness({ initialLineHeight: 1.1, fittedLineHeight: 1.194, pinchOverrideFontPx: 20 });

      harness.softReinit({ holdFrame: true, theme: {}, scrollback: 'x' });

      expect(harness.options().lineHeight).toBe(1.1);
    });

    /**
     * The hold has to be taken BEFORE terminal.reset(), while the frame worth
     * keeping is still in the buffer; a re-init with nothing to hold lifts any
     * hold instead.
     */
    it('holds the frame ahead of the reset on a holdFrame re-init, and lifts it on a plain one', () => {
      const harness = buildSoftReinitHarness({ initialLineHeight: 1, fittedLineHeight: 1 });

      harness.softReinit({ holdFrame: true, theme: {}, scrollback: 'x' });
      expect(harness.holdLog()).toEqual(['hold', 'reset']);

      harness.softReinit({ holdFrame: false, theme: {}, scrollback: 'y' });
      expect(harness.holdLog()).toEqual(['hold', 'reset', 'clear', 'reset']);
    });
  });

  /**
   * createTerminal, the hard-init path, sliced from lifecycle.js and run
   * against a fake `window.Terminal` that captures its constructor options.
   * resetSessionViewState is a stand-in defined in the prelude (an injected
   * function cannot write the page's own vars): it adopts the grid and sets
   * the font and pinch the real one would have chosen, so what is checked here
   * is only what createTerminal does with them.
   */
  function buildCreateTerminalHarness(chosen: {
    pinchOverrideFontPx: number | null;
    currentFontSizePx: number;
    fittedLineHeight: number;
  }): {
    createTerminal: (initMessage: Record<string, unknown>) => void;
    terminalOptions: () => Record<string, unknown>[];
    seedCalls: () => unknown[];
    autoFitCalls: () => number;
  } {
    const source = pageModule('lifecycle.js');
    const createSource = source.slice(source.indexOf('function createTerminal('), source.indexOf('function softReinit('));
    expect(createSource).toContain('function createTerminal(');
    expect(createSource).toContain('new window.Terminal(');
    assertInjectionsAreAlive('lifecycle.js (createTerminal slice)', createSource, [
      'resetSessionViewState',
      'currentFontSizePx',
      'pinchOverrideFontPx',
      'fittedLineHeightForGrid',
      'seedAndSettle',
      'knownCols',
      'knownRows',
    ]);
    const terminalOptions: Record<string, unknown>[] = [];
    class FakeTerminal {
      textarea = null;
      constructor(options: Record<string, unknown>) {
        terminalOptions.push(options);
      }
      open = (): void => undefined;
      onData = (): void => undefined;
    }
    const seedCalls: unknown[] = [];
    let autoFitCalls = 0;
    const build = new Function(
      'window',
      'document',
      'fittedLineHeightForGrid',
      'fallbackRowCount',
      'resetWebglState',
      'attachWebgl',
      'reportRenderer',
      'seedAndSettle',
      'postToHost',
      // Injected only to be counted: the hard path used to size the font with
      // it, and resetSessionViewState owns that now. A call that comes back
      // lands here instead of throwing a ReferenceError.
      'autoFitFontToScreen',
      'chosen',
      `var terminal = null;
       var cleanFeedEnabled = false;
       var manualPanUntil = 0;
       var knownCols = 0;
       var knownRows = null;
       var currentFontSizePx = 0;
       var pinchOverrideFontPx = null;
       function resetSessionViewState(initMessage) {
         knownCols = initMessage.cols;
         knownRows = typeof initMessage.rows === 'number' ? initMessage.rows : null;
         pinchOverrideFontPx = chosen.pinchOverrideFontPx;
         currentFontSizePx = chosen.currentFontSizePx;
       }
       ${createSource}
       return { createTerminal: createTerminal };`,
    ) as (...dependencies: unknown[]) => { createTerminal: (initMessage: Record<string, unknown>) => void };
    const built = build(
      { Terminal: FakeTerminal },
      { getElementById: () => ({}) },
      () => chosen.fittedLineHeight,
      () => 24,
      () => undefined,
      () => undefined,
      () => undefined,
      (initMessage: unknown) => {
        seedCalls.push(initMessage);
      },
      () => undefined,
      () => {
        autoFitCalls += 1;
      },
      chosen,
    );
    return {
      createTerminal: built.createTerminal,
      terminalOptions: () => terminalOptions,
      seedCalls: () => seedCalls,
      autoFitCalls: () => autoFitCalls,
    };
  }

  describe('lifecycle.js createTerminal', () => {
    const initMessage = { cols: 210, rows: 48, theme: { background: '#0c0a07' }, scrollback: 'x', cleanFeed: false };

    /**
     * A fresh page (a remount after a killed renderer, a clean-feed rebuild)
     * comes up at the final cell: the font resetSessionViewState chose and the
     * stretch this grid already converged on, rather than line height 1 and a
     * re-convergence from there. It no longer fits the font itself.
     *
     * Mutation that reddens this: hand the Terminal the constant line height 1.
     */
    it('constructs the terminal in the chosen font and the line height fitted for this grid', () => {
      const harness = buildCreateTerminalHarness({ pinchOverrideFontPx: null, currentFontSizePx: 11, fittedLineHeight: 1.194 });

      harness.createTerminal(initMessage);

      expect(harness.terminalOptions()).toHaveLength(1);
      expect(harness.terminalOptions()[0]).toMatchObject({ cols: 210, rows: 48, fontSize: 11, lineHeight: 1.194 });
      expect(harness.seedCalls()).toEqual([initMessage]);
    });

    /**
     * A pinch is the user's size, and the stretch the converged cell carries
     * belongs to the font the pinch replaced: the pinched terminal starts from
     * line height 1.
     *
     * Mutation that reddens this: drop the pinch condition and always use the
     * fitted line height.
     */
    it('constructs a pinched terminal at line height 1, in the pinched font', () => {
      const harness = buildCreateTerminalHarness({ pinchOverrideFontPx: 20, currentFontSizePx: 20, fittedLineHeight: 1.194 });

      harness.createTerminal(initMessage);

      expect(harness.terminalOptions()[0]).toMatchObject({ fontSize: 20, lineHeight: 1 });
    });

    /**
     * Mutation that reddens this: call autoFitFontToScreen() between the
     * reset and the construction.
     */
    it('leaves the font to resetSessionViewState instead of fitting it again', () => {
      const harness = buildCreateTerminalHarness({ pinchOverrideFontPx: null, currentFontSizePx: 11, fittedLineHeight: 1 });

      harness.createTerminal(initMessage);

      expect(harness.autoFitCalls()).toBe(0);
      expect(harness.terminalOptions()[0]).toMatchObject({ fontSize: 11 });
    });
  });

  /**
   * holdFrameSnapshot and clearFrameHold, sliced from lifecycle.js and run
   * against a fake document: the hold is the viewport's text laid over the
   * screen's rectangle in the terminal's own font and cell height, in the
   * theme's colours; a blank grid is never held (it would hide the successor
   * behind an opaque block); and a second call while one is up is a no-op, so
   * the double seed every swap lands cannot replace the good copy with a copy
   * of the blank grid.
   */
  interface FakeHoldElement {
    id: string;
    style: { cssText: string };
    textContent: string;
    attributes: Record<string, string>;
    parentNode: { removeChild: (child: FakeHoldElement) => void } | null;
    setAttribute: (name: string, value: string) => void;
  }

  function buildFrameHoldHarness(rows: string[]): {
    hold: () => void;
    clear: () => void;
    held: () => FakeHoldElement | null;
    holdCount: () => number;
  } {
    const source = pageModule('lifecycle.js');
    const holdSource = source.slice(source.indexOf('var FRAME_HOLD_ID'), source.indexOf('function resetSessionViewState('));
    expect(holdSource).toContain('function holdFrameSnapshot(');
    expect(holdSource).toContain('function clearFrameHold(');
    assertInjectionsAreAlive('lifecycle.js (frame hold slice)', holdSource, ['terminal', 'document', 'frameHoldCount']);

    let held: FakeHoldElement | null = null;
    const gridHost = {
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 300 }),
      appendChild: (child: FakeHoldElement) => {
        held = child;
        child.parentNode = {
          removeChild: () => {
            held = null;
          },
        };
      },
    };
    const screen = { getBoundingClientRect: () => ({ left: 14, top: 26, width: 480, height: 288 }) };
    const document = {
      getElementById: (id: string) => (id === 'terminal' ? gridHost : id === 'frame-hold' ? held : null),
      querySelector: (selector: string) => (selector === '.xterm-screen' ? screen : null),
      createElement: (): FakeHoldElement => {
        const element: FakeHoldElement = {
          id: '',
          style: { cssText: '' },
          textContent: '',
          attributes: {},
          parentNode: null,
          setAttribute: (name, value) => {
            element.attributes[name] = value;
          },
        };
        return element;
      },
    };
    const terminal = {
      rows: rows.length,
      options: { fontFamily: 'Menlo, monospace', fontSize: 11, theme: { foreground: '#f0e9dd', background: '#0c0a07' } },
      buffer: {
        active: {
          viewportY: 0,
          getLine: (index: number) => ({ translateToString: () => rows[index] ?? '' }),
        },
      },
    };
    const build = new Function(
      'terminal',
      'document',
      `var frameHoldCount = 0;
       ${holdSource}
       return { hold: holdFrameSnapshot, clear: clearFrameHold, count: function () { return frameHoldCount; } };`,
    ) as (...dependencies: unknown[]) => { hold: () => void; clear: () => void; count: () => number };
    const built = build(terminal, document);
    return { hold: built.hold, clear: built.clear, held: () => held, holdCount: built.count };
  }

  describe('lifecycle.js frame hold', () => {
    it('lays the viewport text over the screen rectangle in the terminal font and theme, and lifts on clear', () => {
      const harness = buildFrameHoldHarness(['$ claude', '', '● DONE', '']);

      harness.hold();

      const held = harness.held();
      expect(held).not.toBeNull();
      expect(held?.id).toBe('frame-hold');
      expect(held?.textContent).toBe('$ claude\n\n● DONE\n');
      expect(held?.attributes['aria-hidden']).toBe('true');
      const css = held?.style.cssText ?? '';
      expect(css).toContain('left:4px');
      expect(css).toContain('top:6px');
      expect(css).toContain('width:480px');
      expect(css).toContain('height:288px');
      expect(css).toContain('line-height:72px');
      expect(css).toContain('font-size:11px');
      expect(css).toContain('font-family:Menlo, monospace');
      expect(css).toContain('color:#f0e9dd');
      expect(css).toContain('background:#0c0a07');
      expect(harness.holdCount()).toBe(1);

      harness.clear();
      expect(harness.held()).toBeNull();
    });

    it('never holds a blank grid, and never stacks a second hold over the first', () => {
      const blank = buildFrameHoldHarness(['', '   ', '']);
      blank.hold();
      expect(blank.held()).toBeNull();
      expect(blank.holdCount()).toBe(0);

      const painted = buildFrameHoldHarness(['frame one', '']);
      painted.hold();
      const first = painted.held();
      painted.hold();
      expect(painted.held()).toBe(first);
      expect(painted.holdCount()).toBe(1);
    });
  });

  /**
   * seedAndSettle, sliced from lifecycle.js, with terminal.write capturing its
   * callbacks so the test can fire them in xterm's order. Two things live
   * here: every init settles with an init-triggered refit, and a seed whose init
   * was superseded before its bytes flushed does nothing - xterm flushes
   * asynchronously, so two inits inside one frame fire the FIRST seed's
   * callback after the second init has re-armed the paint report, and it used
   * to report the second init's seq against a grid its bytes never reached
   * (a doubled blank report in the live trace) and re-apply a geometry the
   * second init owned.
   */
  function buildSeedAndSettleHarness(): {
    seedAndSettle: (initMessage: Record<string, unknown>) => void;
    setActiveInitSeq: (seq: number) => void;
    writeCallbacks: () => (() => void)[];
    flushCalls: () => unknown[];
    geometryCalls: () => number;
    refitCalls: () => unknown[];
  } {
    const source = pageModule('lifecycle.js');
    const seedSource = source.slice(source.indexOf('function seedAndSettle('), source.indexOf('function createTerminal('));
    expect(seedSource).toContain('function seedAndSettle(');
    assertInjectionsAreAlive('lifecycle.js (seedAndSettle slice)', seedSource, [
      'activeInitSeq',
      'terminal',
      'applyGeometry',
      'afterWriteFlushed',
      'cleanFeedWrite',
      'reportModesIfFlipped',
      'reportPaintedIfAwaiting',
      'requestAnimationFrame',
      'refit',
    ]);
    const writeCallbacks: (() => void)[] = [];
    const flushCalls: unknown[] = [];
    const refitCalls: unknown[] = [];
    let geometryCalls = 0;
    const terminal = {
      write: (_data: string, callback: () => void) => {
        writeCallbacks.push(callback);
      },
    };
    const build = new Function(
      'terminal',
      'applyGeometry',
      'afterWriteFlushed',
      'cleanFeedWrite',
      'reportModesIfFlipped',
      'reportPaintedIfAwaiting',
      'requestAnimationFrame',
      'refit',
      `var activeInitSeq = null;
       ${seedSource}
       return {
         seedAndSettle: seedAndSettle,
         setActiveInitSeq: function (seq) { activeInitSeq = seq; },
       };`,
    ) as (...dependencies: unknown[]) => {
      seedAndSettle: (initMessage: Record<string, unknown>) => void;
      setActiveInitSeq: (seq: number) => void;
    };
    const built = build(
      terminal,
      () => {
        geometryCalls += 1;
      },
      (afterInit: unknown) => {
        flushCalls.push(afterInit);
      },
      () => undefined,
      () => undefined,
      () => undefined,
      (callback: () => void) => callback(),
      (trigger: unknown) => {
        refitCalls.push(trigger);
      },
    );
    return {
      seedAndSettle: built.seedAndSettle,
      setActiveInitSeq: built.setActiveInitSeq,
      writeCallbacks: () => writeCallbacks,
      flushCalls: () => flushCalls,
      geometryCalls: () => geometryCalls,
      refitCalls: () => refitCalls,
    };
  }

  describe('lifecycle.js seedAndSettle', () => {
    /**
     * The settle refit is the same deterministic fit every caller gets: for a
     * grid that already converged it measures once and changes nothing, so
     * an init no longer has to tell it whether to keep or fit.
     */
    it('settles every init with an init-triggered refit', () => {
      const harness = buildSeedAndSettleHarness();

      harness.setActiveInitSeq(1);
      harness.seedAndSettle({ scrollback: 'frame', holdFrame: true });
      harness.seedAndSettle({ scrollback: 'frame' });

      expect(harness.refitCalls()).toEqual(['init', 'init']);
    });

    it('ignores the flush of a seed whose init was superseded, and settles the live one', () => {
      const harness = buildSeedAndSettleHarness();

      harness.setActiveInitSeq(1);
      harness.seedAndSettle({ scrollback: 'first' });
      harness.setActiveInitSeq(2);
      harness.seedAndSettle({ scrollback: 'second' });
      expect(harness.writeCallbacks()).toHaveLength(2);

      // xterm's queue is FIFO: the superseded seed flushes first.
      harness.writeCallbacks()[0]?.();
      expect(harness.flushCalls()).toEqual([]);
      expect(harness.geometryCalls()).toBe(0);

      harness.writeCallbacks()[1]?.();
      expect(harness.flushCalls()).toEqual([true]);
      expect(harness.geometryCalls()).toBe(1);
    });
  });

  /**
   * reportModesIfFlipped, run against a fake terminal whose modes/buffer are
   * mutable so the harness can drive a baseline report and then a flip. The
   * module's OTHER functions (the paint report, afterWriteFlushed) are never
   * called here, so their own dependencies (panToCursor,
   * followCursorVertically, the jump-repaint fields, requestAnimationFrame)
   * only need to exist as harmless stubs.
   */
  interface ModesReport {
    type: string;
    applicationCursorKeys: boolean;
    mouseTrackingMode: string;
    mouseEncoding: string;
    alternateBuffer: boolean;
    initial: boolean;
  }

  function buildModesHarness(): {
    call: () => void;
    posts: () => ModesReport[];
    setModes: (partial: { applicationCursorKeysMode?: boolean; mouseTrackingMode?: string }) => void;
    setBufferType: (bufferType: string) => void;
    setMouseEncoding: (encoding: string) => void;
  } {
    const source = pageModule('modes.js');
    assertInjectionsAreAlive('modes.js', source, [
      'terminal',
      'coreMouseEncoding',
      'postToHost',
      'lastReportedModes',
      'lastAppCursorMode',
      'panToCursor',
      'followCursorVertically',
      'pendingJumpRepaint',
      'jumpRepaintCount',
      'requestAnimationFrame',
    ]);

    const terminalState = {
      modes: { applicationCursorKeysMode: false, mouseTrackingMode: 'none' },
      buffer: { active: { type: 'normal' } },
    };
    const mouseEncodingState = { encoding: 'DEFAULT' };
    // Typed at the collector boundary: the page glue posts plain objects, and
    // the assertions below are what hold their shape to ModesReport.
    const posts: ModesReport[] = [];

    const build = new Function(
      'terminal',
      'coreMouseEncoding',
      'postToHost',
      'panToCursor',
      'followCursorVertically',
      'requestAnimationFrame',
      `var lastReportedModes = null;
       var lastAppCursorMode = false;
       var pendingJumpRepaint = false;
       var jumpRepaintCount = 0;
       ${source}
       return { call: reportModesIfFlipped };`,
    ) as (...dependencies: unknown[]) => { call: () => void };

    const built = build(
      terminalState,
      () => ({ encoding: mouseEncodingState.encoding }),
      (message: ModesReport) => posts.push(message),
      () => undefined,
      () => undefined,
      (callback: () => void) => callback(),
    );

    return {
      call: built.call,
      posts: () => posts,
      setModes: (partial) => Object.assign(terminalState.modes, partial),
      setBufferType: (bufferType) => {
        terminalState.buffer.active.type = bufferType;
      },
      setMouseEncoding: (encoding) => {
        mouseEncodingState.encoding = encoding;
      },
    };
  }

  describe('modes.js reportModesIfFlipped', () => {
    it('posts an initial baseline on the first report, deriving every field from the terminal', () => {
      const harness = buildModesHarness();
      harness.setModes({ applicationCursorKeysMode: true, mouseTrackingMode: 'vt200' });
      harness.setBufferType('alternate');
      harness.setMouseEncoding('SGR');

      harness.call();

      expect(harness.posts()).toEqual([
        {
          type: 'modes',
          applicationCursorKeys: true,
          mouseTrackingMode: 'vt200',
          mouseEncoding: 'SGR',
          alternateBuffer: true,
          initial: true,
        },
      ]);
    });

    it('defaults mouseTrackingMode to none when the terminal reports a falsy value', () => {
      const harness = buildModesHarness();
      harness.setModes({ mouseTrackingMode: '' });

      harness.call();

      expect(harness.posts()[0]).toMatchObject({ mouseTrackingMode: 'none' });
    });

    it('posts nothing on a second call when nothing changed', () => {
      const harness = buildModesHarness();
      harness.setModes({ applicationCursorKeysMode: true, mouseTrackingMode: 'vt200' });
      harness.call();
      expect(harness.posts()).toHaveLength(1);

      harness.call();

      expect(harness.posts()).toHaveLength(1);
    });

    it('reports again with initial false when exactly one field flips', () => {
      const harness = buildModesHarness();
      harness.setModes({ applicationCursorKeysMode: true, mouseTrackingMode: 'vt200' });
      harness.call();

      harness.setModes({ mouseTrackingMode: 'any' });
      harness.call();

      expect(harness.posts()).toHaveLength(2);
      expect(harness.posts()[1]).toEqual({
        type: 'modes',
        applicationCursorKeys: true,
        mouseTrackingMode: 'any',
        mouseEncoding: 'DEFAULT',
        alternateBuffer: false,
        initial: false,
      });
    });
  });

  /**
   * onHostMessage, extracted from dispatch.js and run against stubbed
   * dependencies: a fake or absent terminal keeps the write/refit/resize
   * branches inert unless a test drives them, and every function dispatch.js
   * calls out to is a spy. initCounts and pinchMessageCounts are passed in as
   * mutable objects (the same shape the real module owns at module scope),
   * so the test reads them directly rather than through an accessor.
   */
  function buildDispatchHarness(
    options: {
      terminal?: Record<string, unknown> | null;
      cleanFeedEnabled?: boolean;
      pinchOverrideFontPx?: number | null;
      settledFit?: Record<string, unknown> | null;
      hostFitHeightPx?: number | null;
      webglAddon?: Record<string, unknown> | null;
    } = {},
  ): {
    onHostMessage: (rawData: string) => void;
    initCounts: { hard: number; soft: number };
    pinchMessageCounts: { activeTrue: number; activeFalse: number };
    softReinitCalls: () => unknown[];
    createTerminalCalls: () => unknown[];
    terminalDisposeCallCount: () => number;
    stopHistoryFlingCallCount: () => number;
    refitTriggers: () => unknown[];
    pinchActive: () => boolean;
    historyDragAnchorY: () => number | null;
    historyDragAxis: () => string | null;
    tapDirty: () => boolean;
    fitState: () => {
      pinchOverrideFontPx: number | null;
      settledFit: unknown;
      hostFitHeightPx: number | null;
      knownCols: number;
      knownRows: number | null;
    };
  } {
    const source = pageModule('dispatch.js');
    const onHostMessageSource = source.slice(
      source.indexOf('function onHostMessage'),
      source.indexOf('// react-native-webview delivers'),
    );
    assertInjectionsAreAlive('dispatch.js', onHostMessageSource, [
      'terminal',
      'cleanFeedEnabled',
      'softReinit',
      'createTerminal',
      'initCounts',
      'document',
      'afterWriteFlushed',
      'cleanFeedWrite',
      'applyFontSize',
      'pinchActive',
      'pinchMessageCounts',
      'historyDragAnchorY',
      'historyDragAxis',
      'tapDirty',
      'stopHistoryFling',
      'applyVerticalOffset',
      'refit',
      'scrollToLatest',
      'knownCols',
      'knownRows',
      'manualPanUntil',
      'cleanTerminal',
      'lastScrollInputAt',
      'lastScrollRoundTripMs',
      'lastJumpAt',
      'lastJumpFirstWriteMs',
      'pinchOverrideFontPx',
      'settledFit',
      'hostFitHeightPx',
      'webglAddon',
    ]);

    const initCounts = { hard: 0, soft: 0 };
    const pinchMessageCounts = { activeTrue: 0, activeFalse: 0 };
    const softReinitCalls: unknown[] = [];
    const createTerminalCalls: unknown[] = [];
    const refitTriggers: unknown[] = [];
    let terminalDisposeCallCount = 0;
    let stopHistoryFlingCallCount = 0;

    const initialTerminal =
      options.terminal === undefined
        ? null
        : {
            ...options.terminal,
            dispose: () => {
              terminalDisposeCallCount += 1;
            },
          };
    const fakeGridHost = { firstChild: null };
    const fakeDocument = { getElementById: (id: string) => (id === 'terminal' ? fakeGridHost : null) };

    const build = new Function(
      'terminalArgument',
      'cleanFeedEnabledArgument',
      'document',
      'softReinit',
      'createTerminal',
      'initCounts',
      'afterWriteFlushed',
      'cleanFeedWrite',
      'applyFontSize',
      'stopHistoryFling',
      'applyVerticalOffset',
      'refit',
      'scrollToLatest',
      'pinchMessageCounts',
      'fitStateArgument',
      `var terminal = terminalArgument;
       var cleanFeedEnabled = cleanFeedEnabledArgument;
       var pinchActive = false;
       var historyDragAnchorY = 42;
       var historyDragAxis = 'vertical';
       var tapDirty = false;
       var knownCols = 80;
       var knownRows = 24;
       var manualPanUntil = 0;
       var cleanTerminal = null;
       var lastScrollInputAt = null;
       var lastScrollRoundTripMs = null;
       var lastJumpAt = null;
       var lastJumpFirstWriteMs = null;
       var pinchOverrideFontPx = fitStateArgument.pinchOverrideFontPx;
       var settledFit = fitStateArgument.settledFit;
       var hostFitHeightPx = fitStateArgument.hostFitHeightPx;
       var webglAddon = fitStateArgument.webglAddon;
       ${onHostMessageSource}
       return {
         onHostMessage: onHostMessage,
         pinchActive: function () { return pinchActive; },
         historyDragAnchorY: function () { return historyDragAnchorY; },
         historyDragAxis: function () { return historyDragAxis; },
         tapDirty: function () { return tapDirty; },
         fitState: function () {
           return { pinchOverrideFontPx: pinchOverrideFontPx, settledFit: settledFit, hostFitHeightPx: hostFitHeightPx,
                    knownCols: knownCols, knownRows: knownRows };
         },
       };`,
    ) as (...dependencies: unknown[]) => {
      onHostMessage: (rawData: string) => void;
      pinchActive: () => boolean;
      historyDragAnchorY: () => number | null;
      historyDragAxis: () => string | null;
      tapDirty: () => boolean;
      fitState: () => {
        pinchOverrideFontPx: number | null;
        settledFit: unknown;
        hostFitHeightPx: number | null;
        knownCols: number;
        knownRows: number | null;
      };
    };

    const built = build(
      initialTerminal,
      options.cleanFeedEnabled ?? false,
      fakeDocument,
      (message: unknown) => softReinitCalls.push(message),
      (message: unknown) => createTerminalCalls.push(message),
      initCounts,
      () => undefined,
      () => undefined,
      () => undefined,
      () => {
        stopHistoryFlingCallCount += 1;
      },
      () => undefined,
      (trigger: unknown) => {
        refitTriggers.push(trigger);
      },
      () => undefined,
      pinchMessageCounts,
      {
        pinchOverrideFontPx: options.pinchOverrideFontPx ?? null,
        settledFit: options.settledFit ?? null,
        hostFitHeightPx: options.hostFitHeightPx ?? null,
        webglAddon: options.webglAddon ?? null,
      },
    );

    return {
      onHostMessage: built.onHostMessage,
      initCounts,
      pinchMessageCounts,
      softReinitCalls: () => softReinitCalls,
      createTerminalCalls: () => createTerminalCalls,
      terminalDisposeCallCount: () => terminalDisposeCallCount,
      stopHistoryFlingCallCount: () => stopHistoryFlingCallCount,
      refitTriggers: () => refitTriggers,
      pinchActive: built.pinchActive,
      historyDragAnchorY: built.historyDragAnchorY,
      historyDragAxis: built.historyDragAxis,
      tapDirty: built.tapDirty,
      fitState: built.fitState,
    };
  }

  describe('dispatch.js onHostMessage - the fit messages', () => {
    /**
     * The fit button ALWAYS lands on the fitted view: the pinch goes, the
     * converged cell is re-derived rather than trusted, and the ring's grid
     * rides along so a page that inited with rows unknown fits the real grid.
     *
     * Mutation that reddens this: leave the pinch in place on 'refit'.
     */
    it('drops the pinch and the converged cell, adopts the ring grid and refits on the fit button', () => {
      const harness = buildDispatchHarness({
        terminal: {},
        pinchOverrideFontPx: 6,
        settledFit: { key: 'fit-key', fontSizePx: 11, lineHeight: 1.194 },
      });

      harness.onHostMessage(JSON.stringify({ type: 'refit', cols: 120, rows: 30 }));

      expect(harness.fitState()).toMatchObject({ pinchOverrideFontPx: null, settledFit: null, knownCols: 120, knownRows: 30 });
      expect(harness.refitTriggers()).toEqual(['refit-msg']);
    });

    it('keeps the current grid when the fit button arrives with an unknown one', () => {
      const harness = buildDispatchHarness({ terminal: {} });

      harness.onHostMessage(JSON.stringify({ type: 'refit', cols: null, rows: null }));

      expect(harness.fitState()).toMatchObject({ knownCols: 80, knownRows: 24 });
      expect(harness.refitTriggers()).toEqual(['refit-msg']);
    });

    it('adopts a new host fit height and refits, and ignores a repeat', () => {
      const harness = buildDispatchHarness({ terminal: {}, hostFitHeightPx: 635 });

      harness.onHostMessage(JSON.stringify({ type: 'fit-height', fitHeightPx: 635 }));
      expect(harness.refitTriggers()).toEqual([]);

      harness.onHostMessage(JSON.stringify({ type: 'fit-height', fitHeightPx: 380 }));
      expect(harness.fitState().hostFitHeightPx).toBe(380);
      expect(harness.refitTriggers()).toEqual(['fit-height']);
    });

    /**
     * Back from the background: the glyph repair, WITHOUT a refit (a refit
     * on every foreground is what used to undo a pinch).
     */
    it('repaints by dropping the glyph atlas and redrawing every row, without refitting', () => {
      const atlasClears: number[] = [];
      const refreshes: [number, number][] = [];
      const harness = buildDispatchHarness({
        terminal: { rows: 48, refresh: (start: number, end: number) => refreshes.push([start, end]) },
        webglAddon: { clearTextureAtlas: () => atlasClears.push(1) },
      });

      harness.onHostMessage(JSON.stringify({ type: 'repaint' }));

      expect(atlasClears).toEqual([1]);
      expect(refreshes).toEqual([[0, 47]]);
      expect(harness.refitTriggers()).toEqual([]);
    });

    /**
     * The page falls back to the DOM renderer when WebGL is unavailable (the
     * 'renderer' report says which), and an older addon may lack
     * clearTextureAtlas. The repaint must still redraw every row on those pages
     * rather than throw out of the message handler.
     *
     * Mutation that reddens these: drop the `webglAddon &&` or the
     * `typeof webglAddon.clearTextureAtlas === 'function'` half of the guard.
     */
    it.each([
      ['no WebGL addon (the DOM renderer)', null],
      ['an addon without clearTextureAtlas', {}],
    ])('still redraws every row on a page with %s', (_description, webglAddon) => {
      const refreshes: [number, number][] = [];
      const harness = buildDispatchHarness({
        terminal: { rows: 48, refresh: (start: number, end: number) => refreshes.push([start, end]) },
        webglAddon,
      });

      expect(() => harness.onHostMessage(JSON.stringify({ type: 'repaint' }))).not.toThrow();

      expect(refreshes).toEqual([[0, 47]]);
    });

    /**
     * The host never posts a non-positive or non-numeric height, but the page
     * is the second guard: an adopted zero would make the fit chain fit a pane
     * of no height, and a numeric string would pass a bare `> 0`.
     *
     * Mutation that reddens this: drop `message.fitHeightPx > 0` (zero, negative)
     * or the `typeof ... === 'number'` check (the string) from the branch.
     */
    it.each([[0], [-20], ['635'], [null]])('ignores a fit-height of %j and keeps the one it has', (badHeight) => {
      const harness = buildDispatchHarness({ terminal: {}, hostFitHeightPx: 500 });

      harness.onHostMessage(JSON.stringify({ type: 'fit-height', fitHeightPx: badHeight }));

      expect(harness.fitState().hostFitHeightPx).toBe(500);
      expect(harness.refitTriggers()).toEqual([]);
    });

    it('drops a pinch when the desktop grid changes, and keeps it for the same grid', () => {
      const harness = buildDispatchHarness({ terminal: {}, pinchOverrideFontPx: 20 });

      harness.onHostMessage(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
      expect(harness.fitState().pinchOverrideFontPx).toBe(20);

      harness.onHostMessage(JSON.stringify({ type: 'resize', cols: 210, rows: 48 }));
      expect(harness.fitState().pinchOverrideFontPx).toBeNull();
      expect(harness.refitTriggers()).toEqual(['resize-msg', 'resize-msg']);
    });
  });

  describe('dispatch.js onHostMessage - pinch branch', () => {
    it('tracks pinch start: counts, latches pinchActive, and stops any history fling', () => {
      const harness = buildDispatchHarness();

      harness.onHostMessage(JSON.stringify({ type: 'pinch', active: true }));

      expect(harness.pinchMessageCounts.activeTrue).toBe(1);
      expect(harness.pinchMessageCounts.activeFalse).toBe(0);
      expect(harness.pinchActive()).toBe(true);
      expect(harness.stopHistoryFlingCallCount()).toBe(1);
    });

    it('tracks pinch end: counts, clears pinchActive, and drops the drag anchor/axis with tapDirty set', () => {
      const harness = buildDispatchHarness();
      harness.onHostMessage(JSON.stringify({ type: 'pinch', active: true }));

      harness.onHostMessage(JSON.stringify({ type: 'pinch', active: false }));

      expect(harness.pinchMessageCounts.activeFalse).toBe(1);
      expect(harness.pinchActive()).toBe(false);
      expect(harness.historyDragAnchorY()).toBeNull();
      expect(harness.historyDragAxis()).toBeNull();
      expect(harness.tapDirty()).toBe(true);
    });
  });

  describe('dispatch.js onHostMessage - init hard vs soft path', () => {
    it('takes the soft reinit path when the clean-feed flag matches, then the hard rebuild path when it flips', () => {
      const harness = buildDispatchHarness({ terminal: {}, cleanFeedEnabled: false });

      harness.onHostMessage(JSON.stringify({ type: 'init', cleanFeed: false, scrollback: '', cols: 80, rows: 24 }));
      expect(harness.softReinitCalls()).toHaveLength(1);
      expect(harness.createTerminalCalls()).toHaveLength(0);
      expect(harness.terminalDisposeCallCount()).toBe(0);
      expect(harness.initCounts.hard).toBe(0);

      harness.onHostMessage(JSON.stringify({ type: 'init', cleanFeed: true, scrollback: '', cols: 80, rows: 24 }));
      expect(harness.terminalDisposeCallCount()).toBe(1);
      expect(harness.initCounts.hard).toBe(1);
      expect(harness.createTerminalCalls()).toHaveLength(1);
      // Unchanged from the soft path above - the flip took the hard path only.
      expect(harness.softReinitCalls()).toHaveLength(1);
    });
  });
});
