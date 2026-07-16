import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, Overseer, darkTerminalTheme } from '@/components';

const overseerTimings = darkTerminalTheme.motion.overseer;

/** With Math.random pinned to 0.5, the first blink lands at min + half the window. */
const HALF_WINDOW_BLINK_DELAY_MS =
  overseerTimings.blinkIntervalMinMs +
  0.5 * (overseerTimings.blinkIntervalMaxMs - overseerTimings.blinkIntervalMinMs);

const WAVE_LEAD_MS = overseerTimings.waveDurationMs * 0.25;
const WAVE_HOLD_MS = overseerTimings.waveDurationMs * 0.5;

// The mascot subtree is deliberately hidden from accessibility (decorative
// art), which also hides it from default RNTL queries.
const HIDDEN = { includeHiddenElements: true } as const;

function renderOverseer(animate: 'blink-loop' | 'wave-once' | 'none', size = 90): void {
  render(
    <ThemeProvider>
      <Overseer size={size} animate={animate} testID="overseer" />
    </ThemeProvider>,
  );
}

describe('Overseer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders the canonical frame and swaps to blink and back on the blink loop', () => {
    renderOverseer('blink-loop');
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(HALF_WINDOW_BLINK_DELAY_MS));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(overseerTimings.blinkHoldMs));
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();

    // The loop reschedules: a second blink arrives after another interval.
    act(() => jest.advanceTimersByTime(HALF_WINDOW_BLINK_DELAY_MS));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();
  });

  it('plays the wave once (canonical, wave, canonical) and stops', () => {
    renderOverseer('wave-once');
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(WAVE_LEAD_MS));
    expect(screen.getByTestId('overseer-frame-wave', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(WAVE_HOLD_MS));
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();

    // One-shot: no further frame changes however long we wait.
    act(() => jest.advanceTimersByTime(overseerTimings.blinkIntervalMaxMs * 2));
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();
  });

  it('rests on the canonical frame under OS reduced motion', () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);

    renderOverseer('blink-loop');
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(overseerTimings.blinkIntervalMaxMs * 2));
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('overseer-frame-blink', HIDDEN)).toBeNull();
  });

  it('does not animate when animate is none', () => {
    renderOverseer('none');
    act(() => jest.advanceTimersByTime(overseerTimings.blinkIntervalMaxMs * 2));
    expect(screen.getByTestId('overseer-frame-canonical', HIDDEN)).toBeTruthy();
  });

  it('snaps the requested size down to an integer pixel scale', () => {
    // 100dp over an 18-column grid floors to a 5dp pixel: 90 wide, 60 tall.
    renderOverseer('none', 100);
    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('overseer', HIDDEN).props.style);
    expect(flattenedStyle.width).toBe(90);
    expect(flattenedStyle.height).toBe(60);
  });
});
