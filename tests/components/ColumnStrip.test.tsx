import React from 'react';
import { render, screen, within } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { CircleCheckBig, Layers, SquareCode } from 'lucide-react-native';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { COLUMN_STRIP_HEIGHT, ColumnStrip, type ColumnStripProps } from '@/components/board/ColumnStrip';
import type { ColumnTrackStep } from '@/components/board/columnTrack';
import { boardColumnFixture } from '@/devsupport/desktopFixtures';

const STRIP_TEST_ID = 'strip';

const EXECUTING = boardColumnFixture({
  id: 'lane-executing',
  name: 'Executing',
  role: null,
  position: 2,
  color: '#58a6ff',
  icon: 'square-code',
});

const EXECUTING_TRACK: ColumnTrackStep[] = [
  { columnId: 'lane-planning', name: 'Planning', color: '#8957e5', state: 'done' },
  { columnId: 'lane-executing', name: 'Executing', color: '#58a6ff', state: 'current' },
  { columnId: 'lane-code-review', name: 'Code Review', color: '#d29922', state: 'ahead' },
];

function renderStrip(overrides: Partial<ColumnStripProps> = {}): void {
  const props: ColumnStripProps = {
    column: EXECUTING,
    track: EXECUTING_TRACK,
    projectName: 'storefront-web',
    testID: STRIP_TEST_ID,
    ...overrides,
  };
  render(
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
    it('names the project the task lives in', () => {
      renderStrip();
      expect(screen.getByTestId(`${STRIP_TEST_ID}-project`)).toHaveTextContent('storefront-web');
    });

    it('draws no project when none is known', () => {
      renderStrip({ projectName: null });
      expect(screen.queryByTestId(`${STRIP_TEST_ID}-project`)).toBeNull();
    });
  });

  /**
   * The design review chose a band that never names the column in words: the
   * icon, its color and its place in the track say which column. Drawing the
   * name back in would be a quiet reversal of that decision.
   */
  it('never draws the column name', () => {
    renderStrip();
    expect(screen.queryByText('Executing')).toBeNull();
  });

  it('gives a screen reader the column the band does not draw, with the project and the step', () => {
    renderStrip();
    expect(screen.getByTestId(STRIP_TEST_ID).props.accessibilityLabel).toBe('storefront-web, Executing, step 2 of 3');
  });

  describe('the current-step marker (icon, then role default, then a color dot)', () => {
    it('marks the current step with the icon picked on the desktop, in the column\'s color', () => {
      renderStrip();
      const glyph = within(screen.getByTestId(`${STRIP_TEST_ID}-icon`)).UNSAFE_getByType(SquareCode);
      expect(glyph.props.color).toBe('#58a6ff');
    });

    it('is an 18 dp rounded square tinted with the column\'s color', () => {
      renderStrip();
      const marker = flattenedStyle(`${STRIP_TEST_ID}-marker`);
      expect([marker.width, marker.height, marker.borderRadius]).toEqual([18, 18, 5]);
      const tint = markerTintStyle();
      expect([tint.backgroundColor, tint.opacity]).toEqual(['#58a6ff', 0.18]);
    });

    it('prefers the picked icon over the role default', () => {
      renderStrip({ column: boardColumnFixture({ id: 'lane-backlog', name: 'Backlog', role: 'todo', icon: 'square-code' }), track: [] });
      const iconWrapper = within(screen.getByTestId(`${STRIP_TEST_ID}-icon`));
      expect(iconWrapper.UNSAFE_queryByType(SquareCode)).not.toBeNull();
      expect(iconWrapper.UNSAFE_queryByType(Layers)).toBeNull();
    });

    /**
     * To Do and Done are never in the track (the desktop's track never draws
     * them), so their marker stands alone, and the desktop strip draws them
     * with no column color.
     */
    it('stands alone, uncolored, for a To Do column', () => {
      renderStrip({ column: boardColumnFixture({ id: 'lane-backlog', name: 'Backlog', role: 'todo', icon: null, color: '#58a6ff' }), track: [] });
      const glyph = within(screen.getByTestId(`${STRIP_TEST_ID}-icon`)).UNSAFE_getByType(Layers);
      expect(glyph.props.color).toBe(darkTerminalTheme.colors.textMuted);
      expect(markerTintStyle().backgroundColor).toBe(darkTerminalTheme.colors.textMuted);
      expect(screen.getByTestId(`${STRIP_TEST_ID}-track`).children).toHaveLength(1);
    });

    it('stands alone for Done, with its role default', () => {
      renderStrip({ column: boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', icon: null }), track: [] });
      expect(within(screen.getByTestId(`${STRIP_TEST_ID}-icon`)).UNSAFE_queryByType(CircleCheckBig)).not.toBeNull();
    });

    /** The same fallback as the Board's chip bar and the session header: a dot in the column's color, never the desktop's former `square`. */
    it('falls back to a dot in the column\'s color when there is no icon and no role', () => {
      renderStrip({
        column: boardColumnFixture({ id: 'lane-progress', name: 'In Progress', role: null, icon: null, color: '#d29922' }),
        track: [{ columnId: 'lane-progress', name: 'In Progress', color: '#d29922', state: 'current' }],
      });
      expect(flattenedStyle(`${STRIP_TEST_ID}-dot`).backgroundColor).toBe('#d29922');
      expect(screen.queryByTestId(`${STRIP_TEST_ID}-icon`)).toBeNull();
    });
  });

  describe('the step track', () => {
    it('draws done steps, then the marker in the current step\'s place, then the steps ahead', () => {
      renderStrip({
        track: [
          ...EXECUTING_TRACK.slice(0, 1),
          { columnId: 'lane-skipped', name: 'Skipped', color: '#ffffff', state: 'skipped' },
          ...EXECUTING_TRACK.slice(1),
        ],
      });
      const order = screen
        .getByTestId(`${STRIP_TEST_ID}-track`)
        .children.filter((child): child is ReactTestInstance => typeof child !== 'string')
        .map((child) => child.props.testID as string);
      expect(order).toEqual([`${STRIP_TEST_ID}-step-lane-planning-done`, `${STRIP_TEST_ID}-marker`, `${STRIP_TEST_ID}-step-lane-code-review-ahead`]);
    });

    it('matches the desktop segment sizes, colors and opacities', () => {
      renderStrip();
      const done = flattenedStyle(`${STRIP_TEST_ID}-step-lane-planning-done`);
      expect([done.width, done.height, done.backgroundColor, done.opacity]).toEqual([11, 4, '#8957e5', 0.55]);
      const ahead = flattenedStyle(`${STRIP_TEST_ID}-step-lane-code-review-ahead`);
      expect([ahead.width, ahead.height, ahead.backgroundColor]).toEqual([11, 4, darkTerminalTheme.colors.border]);
    });
  });

  describe('a row whose column cannot be found', () => {
    it('keeps the project but draws no marker and no track, rather than a guessed column', () => {
      renderStrip({ column: null, track: EXECUTING_TRACK });
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
    it('keeps the same fixed height as a located row, so the row never grows when the board lands', () => {
      renderStrip({ column: null, projectName: null });
      expect(flattenedStyle(STRIP_TEST_ID).height).toBe(COLUMN_STRIP_HEIGHT);
      screen.unmount();
      renderStrip();
      expect(flattenedStyle(STRIP_TEST_ID).height).toBe(COLUMN_STRIP_HEIGHT);
    });

    it('is the desktop strip\'s 29 dp', () => {
      expect(COLUMN_STRIP_HEIGHT).toBe(29);
    });
  });
});
