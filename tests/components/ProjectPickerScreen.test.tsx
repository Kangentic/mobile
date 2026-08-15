import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@/components';
import { ProjectPickerScreen } from '@/screens/ProjectPickerScreen';
import { useBoardStore } from '@/state/boardStore';
import {
  clampSheetContentHeight,
  LIST_FLOOR_HEIGHT,
  PICKER_FILTER_EXTRA_HEIGHT,
  PICKER_SHEET_RESERVED_HEIGHT,
  SHEET_CONTENT_CEILING,
  SHEET_KEYBOARD_ALLOWANCE,
} from '@/lib/sheetContentHeights';

/**
 * Walks up from a queried host node to its nearest HOST ancestor (skipping
 * the composite wrapper layers a mocked ScrollView renders through in this
 * Jest environment), so the caller can assert that ancestor IS the
 * SheetScrollerSlot's View rather than merely that a slot exists somewhere
 * above it. Stopping at anything but the nearest host would let a slot that
 * wraps the wrong element (e.g. the whole Stack, which is exactly the
 * misplacement SheetScrollerSlot's own invariant comment warns against)
 * pass this check by accident.
 */
function nearestHostAncestor(instance: ReactTestInstance): ReactTestInstance {
  let current = instance.parent;
  while (current !== null && typeof current.type !== 'string') {
    current = current.parent;
  }
  if (current === null) {
    throw new Error('expected a host ancestor');
  }
  return current;
}

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

function renderProjectPicker(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ProjectPickerScreen />
    </ThemeProvider>,
  );
}

describe('ProjectPickerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardStore.getState().reset();
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
    });
  });

  /** With nothing chosen yet the board shows the first project, so the picker must agree. */
  it('marks the first project selected before an explicit choice', () => {
    renderProjectPicker();
    expect(screen.getByTestId('board-project-project-1').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('board-project-project-2').props.accessibilityState.selected).toBe(false);
  });

  it('writes the choice to the store and dismisses', () => {
    renderProjectPicker();

    fireEvent.press(screen.getByTestId('board-project-project-2'));

    expect(useBoardStore.getState().selectedProjectId).toBe('project-2');
    expect(mockBack).toHaveBeenCalled();
  });

  it('reflects an already-selected project', () => {
    useBoardStore.getState().selectProject('project-2');
    renderProjectPicker();

    expect(screen.getByTestId('board-project-project-2').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('board-project-project-1').props.accessibilityState.selected).toBe(false);
  });

  /**
   * The groups list and the project list are two separate desktop reads, so
   * they can legitimately arrive out of step: a project can carry a groupId
   * the phone has never seen a group for. Dropping it would make a paired
   * project unreachable from the only screen that can switch to it.
   */
  it('still shows a project whose groupId matches no known group, rather than dropping it', () => {
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha', groupId: 'real-group', position: 0 },
        { id: 'project-2', name: 'Beta', groupId: 'ghost-group', position: 1 },
      ],
      projectGroups: [{ id: 'real-group', name: 'Real Group', position: 0 }],
    });

    renderProjectPicker();

    expect(screen.getByTestId('board-project-project-1')).toBeTruthy();
    expect(screen.getByTestId('board-project-project-2')).toBeTruthy();
  });

  /**
   * The null-groupId bucket and every orphaned-group bucket are concatenated
   * and then re-sorted by position TOGETHER, not left in Map insertion
   * order. The fixture below deliberately lists the higher-position project
   * FIRST (so it is the first key the Map sees) and the lower-position
   * orphaned-group project SECOND, which is the one arrangement Map
   * insertion order and position order actually disagree on.
   */
  it('orders the ungrouped section by position across the null bucket and orphan buckets combined', () => {
    useBoardStore.setState({
      projects: [
        { id: 'project-late', name: 'Late (position 5)', groupId: null, position: 5 },
        { id: 'project-early', name: 'Early (position 1)', groupId: 'ghost-group', position: 1 },
      ],
      projectGroups: [],
    });

    renderProjectPicker();

    const rows = screen.getAllByRole('radio');
    expect(rows.map((row) => row.props.testID)).toEqual(['board-project-project-early', 'board-project-project-late']);
  });
});

/**
 * The iOS form-sheet fix (SheetScrollerSlot) works by owning the scroller's
 * layout slot (see the component's invariant comment); a future refactor
 * that unwraps the ScrollView from its slot would silently reopen the bug
 * the wrapper exists to fix, and nothing else here would notice. This locks
 * the WIRING (the slot actually sits between the Stack and the list), not
 * the slot's own structural behavior, which SheetScrollerSlot.test.tsx
 * already covers.
 */
describe('ProjectPickerScreen scroller slot wiring', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
    });
  });

  it('renders the project list inside a SheetScrollerSlot', () => {
    renderProjectPicker();

    const scroller = screen.getByTestId('board-project-list');
    const slotHost = nearestHostAncestor(scroller);

    expect(slotHost.props.collapsable).toBe(false);
    expect(StyleSheet.flatten(slotHost.props.style)).toMatchObject({ overflow: 'hidden' });
  });
});

/**
 * The project list's height cap is derived from the window, not fixed: a
 * fixed maxHeight: 420 shipped first and pushed rows below the fold on small
 * phones (the 2026-08-15 iOS tester recording). These tests pin the WIRING
 * (windowHeight + insets.bottom + the screen's own budget, plus the extra
 * reserve the filter field and its keyboard allowance add once the project
 * count crosses SEARCH_THRESHOLD) reach the rendered style, not the
 * derivation math itself, which is pinned separately in
 * tests/unit/sheetContentHeights.test.ts.
 */
describe('ProjectPickerScreen project list height cap', () => {
  // A non-zero, non-default gesture-bar-shaped inset: with the safe-area
  // mock's default of 0, a screen that forgot to add insets.bottom would
  // pass every assertion below by coincidence.
  const BOTTOM_INSET = 34;
  const HISTORICAL_FIXED_CAP = 420; // the bug this module's derivation replaced

  beforeEach(() => {
    // Deliberately independent of the sibling describe above: do not rely on
    // whatever store state its last test happened to leave behind.
    useBoardStore.getState().reset();
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockWindowHeight(height: number): void {
    jest.spyOn(Dimensions, 'get').mockImplementation(() => ({ width: 400, height, scale: 2, fontScale: 1 }));
  }

  function renderWithInsets(): ReturnType<typeof render> {
    return render(
      <ThemeProvider>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 400, height: 800 },
            insets: { top: 0, left: 0, right: 0, bottom: BOTTOM_INSET },
          }}
        >
          <ProjectPickerScreen />
        </SafeAreaProvider>
      </ThemeProvider>,
    );
  }

  /** Mirrors exactly what ProjectPickerScreen derives listMaxHeight from. */
  function expectedListMaxHeight(windowHeight: number, showSearch: boolean): number {
    return clampSheetContentHeight({
      windowHeight,
      reservedHeight:
        PICKER_SHEET_RESERVED_HEIGHT +
        BOTTOM_INSET +
        (showSearch ? PICKER_FILTER_EXTRA_HEIGHT + SHEET_KEYBOARD_ALLOWANCE : 0),
      floorHeight: LIST_FLOOR_HEIGHT,
    });
  }

  /** Below SEARCH_THRESHOLD (8): no filter field, so no filter/keyboard reserve. */
  it('reserves only the base budget when there is no filter field', () => {
    mockWindowHeight(500);
    // This describe's own beforeEach seeds 2 projects, below SEARCH_THRESHOLD.
    renderWithInsets();

    expect(screen.queryByTestId('board-project-search')).toBeNull();
    const style = StyleSheet.flatten(screen.getByTestId('board-project-list').props.style);
    const expectedMaxHeight = expectedListMaxHeight(500, false);

    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP);
    expect(style.maxHeight).toBe(expectedMaxHeight);
  });

  /** Above SEARCH_THRESHOLD (8): the filter field and its keyboard allowance join the reserve. */
  it('reserves the filter field and its keyboard allowance once past SEARCH_THRESHOLD projects', () => {
    useBoardStore.setState({
      projects: Array.from({ length: 9 }, (_, projectIndex) => ({
        id: `project-${projectIndex}`,
        name: `Project ${projectIndex}`,
      })),
    });
    mockWindowHeight(850);
    renderWithInsets();

    expect(screen.getByTestId('board-project-search')).toBeTruthy();
    const style = StyleSheet.flatten(screen.getByTestId('board-project-list').props.style);
    const expectedMaxHeight = expectedListMaxHeight(850, true);

    // Sanity: this window keeps the clamp strictly between the floor and the
    // ceiling (which also proves it is not the historical fixed 420).
    expect(expectedMaxHeight).toBeGreaterThan(LIST_FLOOR_HEIGHT);
    expect(expectedMaxHeight).toBeLessThan(SHEET_CONTENT_CEILING);
    expect(style.maxHeight).toBe(expectedMaxHeight);
  });
});
