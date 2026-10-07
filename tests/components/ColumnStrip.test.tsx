import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { TestInstance } from 'test-renderer';
import { CircleCheckBig, Layers, SquareCode } from 'lucide-react-native';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { COLUMN_STRIP_HEIGHT, ColumnStrip, type ColumnStripProps } from '@/components/board/ColumnStrip';
import type { ColumnTrackStep } from '@/components/board/columnTrack';
import { boardColumnFixture } from '@/devsupport/desktopFixtures';
import { getLucideGlyph, lucideGlyphs } from '../helpers/lucideGlyphs';

const STRIP_TEST_ID = 'strip';
/** Deliberately NOT derived from the strip's testID: the label keeps the `<card>-wait` id a Maestro flow selects. */
const WAIT_TEST_ID = 'card-wait';

const EXECUTING = boardColumnFixture({
  id: 'lane-executing',
  name: 'Executing',
  role: null,
  position: 2,
  color: '#58a6ff',
  icon: 'square-code',
});

/** A journey as buildJourneyTrack draws it: To Do, the working columns, Done. */
const EXECUTING_TRACK: ColumnTrackStep[] = [
  { columnId: 'lane-todo', name: 'To Do', color: '#8b949e', state: 'done' },
  { columnId: 'lane-planning', name: 'Planning', color: '#8957e5', state: 'done' },
  { columnId: 'lane-executing', name: 'Executing', color: '#58a6ff', state: 'current' },
  { columnId: 'lane-code-review', name: 'Code Review', color: '#d29922', state: 'ahead' },
  { columnId: 'lane-done', name: 'Done', color: '#3fb950', state: 'ahead' },
];

const TODO_COLUMN = boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', icon: null, color: '#8b949e' });
const DONE_COLUMN = boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', icon: null, color: '#3fb950' });

/** EXECUTING_TRACK with the task moved to `columnId`: every stop before it done, it current, the rest ahead. */
function trackAt(columnId: string): ColumnTrackStep[] {
  const currentIndex = EXECUTING_TRACK.findIndex((step) => step.columnId === columnId);
  return EXECUTING_TRACK.map((step, index) => ({
    ...step,
    state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'ahead',
  }));
}

function trackOrder(): string[] {
  return screen
    .getByTestId(`${STRIP_TEST_ID}-track`)
    .children.filter((child): child is TestInstance => typeof child !== 'string')
    .map((child) => child.props.testID as string);
}

async function renderStrip(overrides: Partial<ColumnStripProps> = {}): Promise<void> {
  const props: ColumnStripProps = {
    column: EXECUTING,
    track: EXECUTING_TRACK,
    projectName: 'storefront-web',
    waitingSinceMs: null,
    waitTestID: WAIT_TEST_ID,
    testID: STRIP_TEST_ID,
    ...overrides,
  };
  await render(
    <ThemeProvider>
      <ColumnStrip {...props} />
    </ThemeProvider>,
  );
}

function flattenedStyle(testID: string): ViewStyle {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style as StyleProp<ViewStyle>) ?? {};
}

/** The tint layer is the marker's first child: a View filled with the marker color at the desktop ring's strength. */
function markerTintStyle(): ViewStyle {
  const tint = screen.getByTestId(`${STRIP_TEST_ID}-marker`).children[0];
  if (tint === undefined || typeof tint === 'string') throw new Error('the marker has no tint layer');
  return StyleSheet.flatten(tint.props.style as StyleProp<ViewStyle>) ?? {};
}

describe('ColumnStrip', () => {
  describe('the project, on the left', () => {
    it('names the project the task lives in', async () => {
      await renderStrip();
      expect(screen.getByTestId(`${STRIP_TEST_ID}-project`)).toHaveTextContent('storefront-web');
    });

    it('draws no project when none is known', async () => {
      await renderStrip({ projectName: null });
      expect(screen.queryByTestId(`${STRIP_TEST_ID}-project`)).toBeNull();
    });
  });

  /**
   * The design review chose a band that never names the column in words: the
   * icon, its color and its place in the track say which column. Drawing the
   * name back in would be a quiet reversal of that decision.
   */
  it('never draws the column name', async () => {
    await renderStrip();
    expect(screen.queryByText('Executing')).toBeNull();
  });

  it('gives a screen reader the column the band does not draw, with the project and the step', async () => {
    await renderStrip();
    expect(screen.getByTestId(STRIP_TEST_ID).props.accessibilityLabel).toBe('storefront-web, Executing, step 3 of 5');
  });

  describe('the current-step marker (icon, then role default, then a color dot)', () => {
    it('marks the current step with the icon picked on the desktop, in the column\'s color', async () => {
      await renderStrip();
      const glyph = getLucideGlyph(screen.getByTestId(`${STRIP_TEST_ID}-icon`), SquareCode);
      expect(glyph.props.stroke).toBe('#58a6ff');
    });

    it('is an 18 dp rounded square tinted with the column\'s color', async () => {
      await renderStrip();
      const marker = flattenedStyle(`${STRIP_TEST_ID}-marker`);
      expect([marker.width, marker.height, marker.borderRadius]).toEqual([18, 18, 5]);
      const tint = markerTintStyle();
      expect([tint.backgroundColor, tint.opacity]).toEqual(['#58a6ff', 0.18]);
    });

    it('prefers the picked icon over the role default', async () => {
      await renderStrip({ column: boardColumnFixture({ id: 'lane-backlog', name: 'Backlog', role: 'todo', icon: 'square-code' }), track: [] });
      const iconWrapper = screen.getByTestId(`${STRIP_TEST_ID}-icon`);
      expect(lucideGlyphs(iconWrapper, SquareCode)).toHaveLength(1);
      expect(lucideGlyphs(iconWrapper, Layers)).toHaveLength(0);
    });

    /**
     * The desktop's approved track (2026-10-07, design sign-off T2) gives To
     * Do and Done their own columns' colors and icons. The track before it
     * drew them uncolored, standing alone; that is the regression this pins.
     */
    it('wears To Do\'s own color and role default, at the start of the track', async () => {
      await renderStrip({ column: TODO_COLUMN, track: trackAt('lane-todo') });
      const glyph = getLucideGlyph(screen.getByTestId(`${STRIP_TEST_ID}-icon`), Layers);
      expect(glyph.props.stroke).toBe('#8b949e');
      expect(markerTintStyle().backgroundColor).toBe('#8b949e');
      expect(trackOrder()[0]).toBe(`${STRIP_TEST_ID}-marker`);
    });

    it('wears the board\'s Done color, not grey, with its role default, at the end of the track', async () => {
      await renderStrip({ column: DONE_COLUMN, track: trackAt('lane-done') });
      const glyph = getLucideGlyph(screen.getByTestId(`${STRIP_TEST_ID}-icon`), CircleCheckBig);
      expect(glyph.props.stroke).toBe('#3fb950');
      expect(markerTintStyle().backgroundColor).toBe('#3fb950');
      expect(trackOrder().at(-1)).toBe(`${STRIP_TEST_ID}-marker`);
    });

    /** An archived or ghost column is not a stop of the journey (buildJourneyTrack returns none), so the column's marker is all there is. */
    it('stands alone when the column is outside the journey', async () => {
      await renderStrip({ track: [] });
      expect(trackOrder()).toEqual([`${STRIP_TEST_ID}-marker`]);
      expect(screen.getByTestId(STRIP_TEST_ID).props.accessibilityLabel).toBe('storefront-web, Executing');
    });

    /** Column colors are desktop-authored data: a blank one draws the faint text color rather than an invisible, unfilled marker. */
    it('falls back to the faint text color for a column with no color of its own', async () => {
      await renderStrip({
        column: boardColumnFixture({ id: 'lane-bare', name: 'Bare', role: null, icon: 'square-code', color: '' }),
        track: [{ columnId: 'lane-bare', name: 'Bare', color: '', state: 'current' }],
      });
      expect(markerTintStyle().backgroundColor).toBe(darkTerminalTheme.colors.textMuted);
      expect(getLucideGlyph(screen.getByTestId(`${STRIP_TEST_ID}-icon`), SquareCode).props.stroke).toBe(darkTerminalTheme.colors.textMuted);
    });

    /** The same fallback as the Board's chip bar and the session header: a dot in the column's color, never the desktop's former `square`. */
    it('falls back to a dot in the column\'s color when there is no icon and no role', async () => {
      await renderStrip({
        column: boardColumnFixture({ id: 'lane-progress', name: 'In Progress', role: null, icon: null, color: '#d29922' }),
        track: [{ columnId: 'lane-progress', name: 'In Progress', color: '#d29922', state: 'current' }],
      });
      expect(flattenedStyle(`${STRIP_TEST_ID}-dot`).backgroundColor).toBe('#d29922');
      expect(screen.queryByTestId(`${STRIP_TEST_ID}-icon`)).toBeNull();
    });
  });

  describe('the step track', () => {
    it('draws the journey in order, the marker in the current step\'s place, and leaves skipped steps out', async () => {
      await renderStrip({
        track: [
          ...EXECUTING_TRACK.slice(0, 2),
          { columnId: 'lane-skipped', name: 'Skipped', color: '#ffffff', state: 'skipped' },
          ...EXECUTING_TRACK.slice(2),
        ],
      });
      expect(trackOrder()).toEqual([
        `${STRIP_TEST_ID}-step-lane-todo-done`,
        `${STRIP_TEST_ID}-step-lane-planning-done`,
        `${STRIP_TEST_ID}-marker`,
        `${STRIP_TEST_ID}-step-lane-code-review-ahead`,
        `${STRIP_TEST_ID}-step-lane-done-ahead`,
      ]);
    });

    /**
     * A route that leaves a column out (the first thing buildJourneyTrack can
     * produce a skipped step from) draws no mark for it, so the step the screen
     * reader announces counts the drawn marks only: the third of five, not the
     * fourth of six.
     */
    it('announces the step among the marks drawn, not counting a skipped step', async () => {
      await renderStrip({
        track: [
          ...EXECUTING_TRACK.slice(0, 2),
          { columnId: 'lane-skipped', name: 'Skipped', color: '#ffffff', state: 'skipped' },
          ...EXECUTING_TRACK.slice(2),
        ],
      });
      expect(screen.getByTestId(STRIP_TEST_ID).props.accessibilityLabel).toBe('storefront-web, Executing, step 3 of 5');
    });

    it('matches the desktop bar sizes and opacities', async () => {
      await renderStrip();
      const done = flattenedStyle(`${STRIP_TEST_ID}-step-lane-planning-done`);
      expect([done.width, done.height, done.borderRadius, done.opacity]).toEqual([11, 4, 2, 0.55]);
      const ahead = flattenedStyle(`${STRIP_TEST_ID}-step-lane-code-review-ahead`);
      expect([ahead.width, ahead.height, ahead.borderRadius, ahead.opacity]).toEqual([11, 4, 2, 0.45]);
    });

    /** The card's right edge carries one color per stop at most: passed stops say nothing new, so they stay grey. */
    it('draws passed steps neutral, To Do included, never in their column\'s color', async () => {
      await renderStrip();
      expect(flattenedStyle(`${STRIP_TEST_ID}-step-lane-todo-done`).backgroundColor).toBe(darkTerminalTheme.colors.textMuted);
      expect(flattenedStyle(`${STRIP_TEST_ID}-step-lane-planning-done`).backgroundColor).toBe(darkTerminalTheme.colors.textMuted);
    });

    /**
     * The approved track (2026-10-07, T2) draws each stop ahead in its own
     * column's color, faded, so a planned card already says where it will go.
     * The track before it drew them all the border grey.
     */
    it('draws steps ahead in their own column\'s color, Done included', async () => {
      await renderStrip();
      expect(flattenedStyle(`${STRIP_TEST_ID}-step-lane-code-review-ahead`).backgroundColor).toBe('#d29922');
      expect(flattenedStyle(`${STRIP_TEST_ID}-step-lane-done-ahead`).backgroundColor).toBe('#3fb950');
    });

    it('falls back to the faint text color for a step ahead whose column has no color', async () => {
      await renderStrip({
        track: [...EXECUTING_TRACK.slice(0, 3), { columnId: 'lane-bare', name: 'Bare', color: '', state: 'ahead' }],
      });
      const bare = flattenedStyle(`${STRIP_TEST_ID}-step-lane-bare-ahead`);
      expect([bare.backgroundColor, bare.opacity]).toEqual([darkTerminalTheme.colors.textMuted, 0.45]);
    });
  });

  describe('the wait time, just before the track', () => {
    const MINUTE = 60_000;

    afterEach(() => {
      jest.useRealTimers();
    });

    async function renderWaiting(waitedMs: number): Promise<void> {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-05T12:00:00Z'));
      await renderStrip({ waitingSinceMs: Date.now() - waitedMs });
    }

    it('shows how long the session has waited, at the testID it had before it moved', async () => {
      await renderWaiting(26 * MINUTE);
      expect(screen.getByTestId(WAIT_TEST_ID)).toHaveTextContent('26m');
    });

    it('sits inside the band, ahead of the track', async () => {
      await renderWaiting(26 * MINUTE);
      const renderOrder = screen.container.queryAll(() => true);
      const band = screen.getByTestId(STRIP_TEST_ID);
      const wait = screen.getByTestId(WAIT_TEST_ID);
      expect(band.queryAll(() => true)).toContain(wait);
      expect(renderOrder.indexOf(wait)).toBeLessThan(renderOrder.indexOf(screen.getByTestId(`${STRIP_TEST_ID}-track`)));
    });

    it('shows nothing for a working session, which passes null', async () => {
      await renderStrip({ waitingSinceMs: null });
      expect(screen.queryByTestId(WAIT_TEST_ID)).toBeNull();
    });

    it('still shows the wait time on a row whose column cannot be found', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-05T12:00:00Z'));
      await renderStrip({ column: null, waitingSinceMs: Date.now() - 4 * 60 * MINUTE });
      expect(screen.getByTestId(WAIT_TEST_ID)).toHaveTextContent('4h');
      expect(screen.queryByTestId(`${STRIP_TEST_ID}-marker`)).toBeNull();
    });
  });

  describe('a row whose column cannot be found', () => {
    it('keeps the project but draws no marker and no track, rather than a guessed column', async () => {
      await renderStrip({ column: null, track: EXECUTING_TRACK });
      expect(screen.getByTestId(`${STRIP_TEST_ID}-project`)).toHaveTextContent('storefront-web');
      expect(screen.queryByTestId(`${STRIP_TEST_ID}-marker`)).toBeNull();
      expect(screen.queryByTestId(`${STRIP_TEST_ID}-track`)).toBeNull();
      expect(screen.getByTestId(STRIP_TEST_ID).props.accessibilityLabel).toBe('storefront-web');
    });

    /**
     * FIXED GEOMETRY: the feed must not move when a stand-in row's board lands.
     * RNTL computes no layout, so this pins the mechanism - the same declared
     * height on every branch - rather than a measured one.
     */
    it('keeps the same fixed height as a located row, so the row never grows when the board lands', async () => {
      await renderStrip({ column: null, projectName: null });
      expect(flattenedStyle(STRIP_TEST_ID).height).toBe(COLUMN_STRIP_HEIGHT);
      await screen.unmount();
      await renderStrip();
      expect(flattenedStyle(STRIP_TEST_ID).height).toBe(COLUMN_STRIP_HEIGHT);
    });

    it('is the desktop strip\'s 29 dp', () => {
      expect(COLUMN_STRIP_HEIGHT).toBe(29);
    });
  });
});
