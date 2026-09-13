import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import * as Reanimated from 'react-native-reanimated';
import { NOW_TICK_MS, NowTickProvider, ThemeProvider, darkTerminalTheme } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import { WaitLabel } from '@/components/board/WaitLabel';

const MINUTE = 60_000;

function renderLabel(waitedMs: number, options: { enabled?: boolean; focused?: boolean } = {}): void {
  const { enabled = true, focused = true } = options;
  render(
    <ThemeProvider>
      <ScreenMotionOverride active={focused}>
        <NowTickProvider enabled={enabled}>
          <WaitLabel sinceMs={Date.now() - waitedMs} testID="wait" />
        </NowTickProvider>
      </ScreenMotionOverride>
    </ThemeProvider>,
  );
}

describe('WaitLabel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('advances on the shared clock rather than freezing at mount', () => {
    renderLabel(12 * MINUTE);
    expect(screen.getByTestId('wait')).toHaveTextContent('12m');

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS);
    });

    // 30s does not cross a minute boundary from :00, so the label holds...
    expect(screen.getByTestId('wait')).toHaveTextContent('12m');

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS);
    });

    // ...and a full minute later it has moved on, which is what proves the
    // clock is running rather than the first assertion merely being stable.
    expect(screen.getByTestId('wait')).toHaveTextContent('13m');
  });

  /**
   * `formatDuration` ROUNDS, which is right for a finished run's summary and
   * wrong for a counter still running: it would report 90 seconds of waiting as
   * '2m' and claim more delay than has passed. WaitLabel floors before
   * formatting, so this asserts the label under-states rather than over-states.
   */
  it('truncates to whole minutes rather than rounding up a partial one', () => {
    renderLabel(MINUTE + 50_000);
    expect(screen.getByTestId('wait')).toHaveTextContent('1m');
    expect(screen.queryByText('2m')).toBeNull();
  });

  it('stops ticking while the screen is blurred', () => {
    renderLabel(12 * MINUTE, { focused: false });
    expect(screen.getByTestId('wait')).toHaveTextContent('12m');

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS * 10);
    });

    expect(screen.getByTestId('wait')).toHaveTextContent('12m');
  });

  it('runs no timer when the provider is disabled', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    renderLabel(12 * MINUTE, { enabled: false });
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('clears its interval on unmount rather than leaving it running', () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    renderLabel(12 * MINUTE);
    screen.unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  /**
   * `accent` and `statusNeedsYou` are the same amber today, so a rendered-colour
   * check cannot tell them apart by value - but they are NOT the same token: a
   * per-project accent (ProjectAccentBoundary) replaces the accent family, and
   * on a green-accented project an `accent` label would render in
   * statusWorking's hue and say the opposite of what it means. Asserting the
   * exact token value is what stops that swap passing review as a no-op.
   */
  it('takes the attention hue from statusNeedsYou, which no project accent can re-point', () => {
    renderLabel(12 * MINUTE);
    const style: unknown = screen.getByTestId('wait').props.style;
    const flattened = Array.isArray(style) ? Object.assign({}, ...style) : style;
    expect((flattened as { color?: string }).color).toBe(darkTerminalTheme.colors.statusNeedsYou);
  });
});

/**
 * The idle-CPU lever, asserted at the source - the same mechanism assertion
 * AgentStatusIcon carries, for the same reason. A registered mapper costs
 * ~0.47 CPU points on every frame whether it is dirty or not, and this label
 * sits on every waiting row of a scrolling feed. Reanimated here would render
 * identically and pass every other test in this file, so nothing but a spy can
 * hold the decision in place.
 */
describe('registered mappers (the idle-CPU lever)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('registers no animated mapper, and starts no animation, for a visible label', () => {
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');

    renderLabel(4 * 60 * MINUTE + 7 * MINUTE);
    expect(screen.getByTestId('wait')).toHaveTextContent('4h 7m');

    expect(animatedStyleSpy).not.toHaveBeenCalled();
    expect(animatedPropsSpy).not.toHaveBeenCalled();
    expect(withTimingSpy).not.toHaveBeenCalled();
  });

  it('starts no animation when the value actually changes, which is when a fade would be tempting', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    renderLabel(12 * MINUTE);

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS * 2);
    });

    expect(screen.getByTestId('wait')).toHaveTextContent('13m');
    expect(withTimingSpy).not.toHaveBeenCalled();
  });
});
