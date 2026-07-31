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
});
