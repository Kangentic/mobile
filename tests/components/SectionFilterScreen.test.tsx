import React from 'react';
import { Platform } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import { SectionFilterScreen } from '@/screens/SectionFilterScreen';
import { useActivityStore } from '@/state/activityStore';
import { useSettingsStore } from '@/state/settingsStore';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

function seedSessions(): void {
  useActivityStore.getState().reset();
  useActivityStore.getState().registerSession('sess-idle-1', 'task-1', 'project-1');
  useActivityStore.getState().applySnapshot('sess-idle-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null } }));
  useActivityStore.getState().registerSession('sess-idle-2', 'task-2', 'project-1');
  useActivityStore.getState().applySnapshot('sess-idle-2', 'task-2', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null } }));
  useActivityStore.getState().registerSession('sess-working', 'task-3', 'project-1');
  useActivityStore.getState().applySnapshot('sess-working', 'task-3', 'project-1', streamSnapshotFixture({ activity: { state: 'thinking', reason: { kind: 'turn-active' } } }));
  useActivityStore.getState().registerSession('sess-paused', 'task-4', 'project-1');
  useActivityStore.getState().applySnapshot('sess-paused', 'task-4', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended' }));
}

function renderSheet(): void {
  render(
    <ThemeProvider>
      <SectionFilterScreen />
    </ThemeProvider>,
  );
}

describe('SectionFilterScreen', () => {
  beforeEach(() => {
    seedSessions();
    useSettingsStore.setState({ hiddenTriageSections: [] });
  });

  it('lists all four sections with how many sessions each holds, an empty one included', () => {
    renderSheet();
    expect(screen.getByTestId('section-filter-row-idle').props.accessibilityLabel).toBe('Idle, 2 sessions');
    expect(screen.getByTestId('section-filter-row-active').props.accessibilityLabel).toBe('Active, 1 session');
    expect(screen.getByTestId('section-filter-row-queued').props.accessibilityLabel).toBe('Queued, 0 sessions');
    expect(screen.getByTestId('section-filter-row-paused').props.accessibilityLabel).toBe('Paused, 1 session');
  });

  /**
   * The whole row is the target, at Material's 48 dp (above the 44 pt iOS
   * minimum), and a screen reader hears it as a checkbox with its state.
   */
  it('makes each whole row a 48 dp checkbox target', () => {
    useSettingsStore.setState({ hiddenTriageSections: ['Queued'] });
    renderSheet();
    const idleRow = screen.getByTestId('section-filter-row-idle');
    expect(idleRow.props.accessibilityRole).toBe('checkbox');
    expect(idleRow.props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
    expect(screen.getByTestId('section-filter-row-queued').props.accessibilityState).toEqual(expect.objectContaining({ checked: false }));
    expect(idleRow).toHaveStyle({ minHeight: 48 });
  });

  it('hides a section on tap and shows it again on a second tap, remembered in settings', async () => {
    renderSheet();
    await act(async () => {
      fireEvent.press(screen.getByTestId('section-filter-row-paused'));
    });
    expect(useSettingsStore.getState().hiddenTriageSections).toEqual(['Paused']);
    expect(screen.getByTestId('section-filter-row-paused').props.accessibilityState).toEqual(expect.objectContaining({ checked: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('section-filter-row-paused'));
    });
    expect(useSettingsStore.getState().hiddenTriageSections).toEqual([]);
  });

  it('greys out Show all while nothing is hidden, and clears every hidden section when tapped', async () => {
    renderSheet();
    expect(screen.getByTestId('section-filter-show-all').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('section-filter-row-queued'));
      fireEvent.press(screen.getByTestId('section-filter-row-paused'));
    });
    expect(screen.getByTestId('section-filter-show-all').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('section-filter-show-all'));
    });
    expect(useSettingsStore.getState().hiddenTriageSections).toEqual([]);
  });

  /**
   * The rows' glyphs are a legend, so the Active row's working mark is drawn
   * still. A spinning one cannot be told from a still arc in the render tree,
   * so this asserts the timing call, with screen motion explicitly ON so a
   * gate closed by default could not pass it vacuously.
   */
  it('draws the Active glyph still, starting no spin, even where motion is allowed', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    render(
      <ThemeProvider>
        <ScreenMotionOverride active>
          <SectionFilterScreen />
        </ScreenMotionOverride>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('agent-status-working')).toBeTruthy();
    expect(withTimingSpy).not.toHaveBeenCalled();
    withTimingSpy.mockRestore();
  });

  /**
   * Each platform's own pick-several list (design review round 5): Material's
   * leading checkbox on Android, the trailing checkmark of an iOS inclusive
   * selection list. This file runs once per jest project, so each run asserts
   * its own platform and the absence of the other's mark.
   */
  it('draws the platform\'s own selection mark', () => {
    useSettingsStore.setState({ hiddenTriageSections: ['Queued'] });
    renderSheet();
    if (Platform.OS === 'ios') {
      expect(screen.getByTestId('section-filter-row-idle-checkmark')).toBeTruthy();
      expect(screen.queryByTestId('section-filter-row-idle-checkbox')).toBeNull();
    } else {
      expect(screen.getByTestId('section-filter-row-idle-checkbox')).toBeTruthy();
      expect(screen.queryByTestId('section-filter-row-idle-checkmark')).toBeNull();
    }
  });
});
